class RoiDataManager {
    constructor(projectName) {
        // projectName is needed for identification in logs
        this.DEBUG = false;

        // Constants
        this.EXECUTION_CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours
        this.RECENT_EXECUTION_THRESHOLD = 1; // days
        this.METRICS_INTERVAL = 1000 * 60; // 1 minute
        this.WORKER_INIT_TIMEOUT = 10000; // 10 seconds
        this.HEALTH_CHECK_INTERVAL = 1000 * 60 * 5; // 5 minutes
        this.CACHE_CLEANUP_INTERVAL = 1000 * 60 * 60 * 24 * 4; // 4 days
        this.CACHE_CLEANUP_RETRY_DELAY = 1000 * 60 * 5; // 5 minutes - when rescheduling due to pending requests
        this.CACHE_FRESHNESS_THRESHOLD = 8; // hours - how recent cache must be to skip API calls (increased from 2 to 8)
        this.USE_JOB_REGISTRY = true; // Enable tracking of processed jobs in a registry
        this.DEFAULT_QUERY_MAX_DAYS = 10; // Default days to keep in cache if no user preference exists
        
        // LocalStorage keys
        this.LS_KEY_INITIAL_CACHE_COMPLETE = 'rundeck.plugin.roisummary.initialCacheComplete';
        this.LS_KEY_CACHE_TIMESTAMP = 'rundeck.plugin.roisummary.cacheTimestamp';

        // Worker management
        this.dbWorker = null;
        this.roiWorker = null;
        this.pendingRequests = new Map();
        this.requestId = 0;
        this.workerInitialized = {
            db: false,
            roi: false
        };
        
        // Worker initialization locks to prevent concurrent initializations
        this.workerInitLocks = {
            db: false,
            roi: false
        };
        
        // Cleanup scheduling
        this.cleanupTimeoutId = null;
        
        // Navigation event handlers
        this.setupNavigationHandlers();
        
        // Job registry to track processed jobs and avoid redundant processing
        this.processedJobRegistry = new Map(); // Maps jobId -> {timestamp, hasRoi}

        // Performance metrics
        this.metrics = {
            cacheHits: 0,
            cacheMisses: 0,
            requestsQueued: 0,
            requestsProcessed: 0,
            cancellations: 0,
            errors: [],
            workerMetrics: {
                dbWorker: {
                    messagesSent: 0,
                    messagesReceived: 0,
                    errors: 0,
                    totalProcessingTime: 0,
                    lastError: null
                },
                roiWorker: {
                    messagesSent: 0,
                    messagesReceived: 0,
                    errors: 0,
                    totalProcessingTime: 0,
                    lastError: null
                }
            },
            startTime: Date.now(),
            lastCleanup: Date.now(),
            performance: {
                averageResponseTime: 0,
                responseTimes: [],
                lastBatchProcessingTime: 0
            }
        };

        // Initialize workers and monitoring
        this.initializeSystem()
            .then(() => this.startMonitoring())
            .catch(error => {
                this.logError('initialization', error);
                throw error;
            });
    }

    // Logging utilities
    log(method, msg, type = 'general') {
        if (!this.DEBUG) return;
        console.log(`%cRoiDataManager%c: ${method}`,
            'background: #f97316; color: white; padding: 2px 5px; border-radius: 3px;',
            'color: inherit',
            msg
        );
    }

    logGroup(method, details, type = 'general') {
        if (!this.DEBUG) return;
        console.groupCollapsed(`%cRoiDataManager%c: ${method}`,
            'background: #f97316; color: white; padding: 2px 5px; border-radius: 3px;',
            'color: inherit'
        );
        Object.entries(details).forEach(([key, value]) => {
            console.log(`${key}:`, value);
        });
        console.groupEnd();
    }

    logError(method, error, context = {}) {
        if (!this.DEBUG) return;
        const errorInfo = {
            message: error.message,
            stack: error.stack,
            context,
            timestamp: new Date().toISOString()
        };

        console.group(`%cRoiDataManager%c: ${method} ERROR`,
            'background: #dc2626; color: white; padding: 2px 5px; border-radius: 3px;',
            'color: inherit'
        );
        console.error(error);
        if (Object.keys(context).length > 0) {
            console.log('Context:', context);
        }
        console.groupEnd();

        // Store error for metrics
        this.metrics.errors.unshift(errorInfo);
        if (this.metrics.errors.length > 100) {
            this.metrics.errors.pop();
        }
    }

    // System initialization
    async initializeSystem() {
        this.log('initializeSystem', 'Starting system initialization');
        const startTime = performance.now();

        try {
            // Initialize workers
            await Promise.all([
                this.initializeWorker('db'),
                this.initializeWorker('roi')
            ]);
            
            // Restore job registry from IndexedDB if enabled
            if (this.USE_JOB_REGISTRY) {
                await this.restoreJobRegistry();
            }

            const duration = performance.now() - startTime;
            this.logGroup('initializeSystem', {
                status: 'success',
                duration: `${duration.toFixed(2)}ms`,
                workersInitialized: this.workerInitialized,
                registryRestored: this.USE_JOB_REGISTRY,
                registrySize: this.processedJobRegistry.size
            });

            return true;
        } catch (error) {
            this.logError('initializeSystem', error);
            throw error;
        }
    }
    
    // Restore job registry from cache
    async restoreJobRegistry() {
        try {
            this.log('restoreJobRegistry', 'Restoring job registry from IndexedDB');
            
            // Get all job cache entries
            const jobCacheEntries = await this.dbRequest('listStoreContents', {
                store: 'jobCache'
            });
            
            if (!jobCacheEntries || jobCacheEntries.length === 0) {
                this.log('restoreJobRegistry', 'No cached job entries found');
                return;
            }
            
            // Populate registry
            let validEntryCount = 0;
            let staleEntryCount = 0;
            const now = Date.now();
            
            jobCacheEntries.forEach(entry => {
                if (entry && entry.id && entry.timestamp) {
                    // Only add entries that aren't too old
                    if (now - entry.timestamp < this.EXECUTION_CACHE_TTL) {
                        this.processedJobRegistry.set(entry.id, {
                            timestamp: entry.timestamp,
                            hasRoi: !!entry.hasRoi
                        });
                        validEntryCount++;
                    } else {
                        staleEntryCount++;
                    }
                }
            });
            
            this.logGroup('restoreJobRegistry:complete', {
                totalEntriesFound: jobCacheEntries.length,
                validEntriesRestored: validEntryCount,
                staleEntriesIgnored: staleEntryCount,
                registrySize: this.processedJobRegistry.size
            });
        } catch (error) {
            this.logError('restoreJobRegistry', error);
            // Non-fatal - continue without registry
        }
    }

    async initializeWorker(type) {
        // Check if there's already an initialization in progress
        if (this.workerInitLocks[type]) {
            this.log(`${type}Worker:init`, 'Worker initialization already in progress, waiting...', 'system');
            
            // Wait for the existing initialization to complete
            return new Promise((resolve, reject) => {
                const checkInterval = setInterval(() => {
                    if (!this.workerInitLocks[type]) {
                        clearInterval(checkInterval);
                        
                        // If worker is now initialized, resolve
                        if (this.workerInitialized[type]) {
                            this.log(`${type}Worker:init`, 'Concurrent initialization succeeded, continuing', 'system');
                            resolve(true);
                        } else {
                            // If worker is still not initialized, try again once more
                            this.log(`${type}Worker:init`, 'Concurrent initialization failed, retrying once', 'system');
                            resolve(this._doInitializeWorker(type));
                        }
                    }
                }, 100); // Check every 100ms
                
                // Set a timeout to avoid infinite waiting
                setTimeout(() => {
                    clearInterval(checkInterval);
                    reject(new Error(`Timed out waiting for concurrent ${type} worker initialization`));
                }, this.WORKER_INIT_TIMEOUT);
            });
        }
        
        // Set lock before initializing
        this.workerInitLocks[type] = true;
        try {
            return await this._doInitializeWorker(type);
        } finally {
            // Always release the lock when done
            this.workerInitLocks[type] = false;
        }
    }
    
    // Private method to handle the actual worker initialization
    async _doInitializeWorker(type) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`${type} worker initialization timeout`));
            }, this.WORKER_INIT_TIMEOUT);

            try {
                const scripts = Array.from(document.scripts);
                const pluginScript = scripts.find(script =>
                    script.src.includes('ui-roisummary/js/joblist')
                );

                if (!pluginScript) {
                    throw new Error('Could not find plugin script path');
                }

                const worker = new Worker(pluginScript.src.replace('joblist.js', `lib/${type}Worker.js`));
                if (type === 'db') {
                    this.dbWorker = worker;
                } else {
                    this.roiWorker = worker;
                }

                worker.onerror = (error) => {
                    clearTimeout(timeout);
                    this.logError(`${type}Worker`, error);
                    this.metrics.workerMetrics[`${type}Worker`].errors++;
                    this.metrics.workerMetrics[`${type}Worker`].lastError = {
                        timestamp: Date.now(),
                        error: error.message
                    };
                    reject(error);
                };

                worker.onmessage = (e) => {
                    if (e.data.type === 'initialized') {
                        clearTimeout(timeout);
                        this.workerInitialized[type] = true;
                        this.log(`${type}Worker`, 'Worker initialized successfully');
                        resolve(true);
                    }
                };

                // Pass necessary data to the worker
                const initData = { 
                    type: 'init'
                };
                
                // For the ROI worker, we need to pass appLinks and rundeck context
                if (type === 'roi') {
                    initData.data = {
                        rdBase: window._rundeck.rdBase,
                        projectName: window._rundeck.projectName
                    };
                }
                
                worker.postMessage(initData);
            } catch (error) {
                clearTimeout(timeout);
                this.logError(`${type}Worker:init`, error);
                reject(error);
            }
        });
    }

    // Sets up handlers to terminate workers on page navigation
    setupNavigationHandlers() {
        try {
            // Page unload event - when user navigates away or refreshes
            window.addEventListener('beforeunload', () => {
                this.log('setupNavigationHandlers', 'Terminating ROI worker due to page unload', 'navigation');
                this.terminateRoiWorker();
            });
            
            this.log('setupNavigationHandlers', 'Navigation handlers set up successfully');
        } catch (error) {
            this.logError('setupNavigationHandlers', error);
        }
    }
    
    // Helper to safely terminate ROI worker
    terminateRoiWorker() {
        try {
            if (this.roiWorker) {
                this.log('terminateRoiWorker', 'Terminating ROI worker', 'worker');
                this.roiWorker.terminate();
                this.roiWorker = null;
                this.workerInitialized.roi = false;
            }
        } catch (error) {
            this.logError('terminateRoiWorker', error);
        }
    }
    
    // Monitoring and health checks
    startMonitoring() {
        // Start metrics collection
        if (this.DEBUG) {
            setInterval(() => this.collectMetrics(), this.METRICS_INTERVAL);
        }

        // Start health checks
        setInterval(() => this.healthCheck(), this.HEALTH_CHECK_INTERVAL);
        
        // Start periodic cache cleanup - first run will occur after the full interval
        // to avoid cleaning data that might be needed during the current session
        setInterval(() => this.cleanup(), this.CACHE_CLEANUP_INTERVAL);
    }

    async healthCheck() {
        const startTime = performance.now();
        try {
            this.log('healthCheck', 'Starting system health check');
            
            // Make parallel requests for health checks
            const healthPromises = [
                this.dbRequest('healthCheck', {}).catch(err => ({
                    status: 'unhealthy',
                    error: err.message,
                    timestamp: Date.now()
                })),
                this.getRoiWorkerHealth()
            ];
            
            const [dbHealth, roiHealth] = await Promise.all(healthPromises);
            
            // Calculate metrics safely 
            const totalRequests = this.metrics.cacheHits + this.metrics.cacheMisses;
            const cacheHitRate = totalRequests > 0 
                ? `${(this.metrics.cacheHits / totalRequests * 100).toFixed(1)}%`
                : '0.0%';
                
            const errorRate = this.metrics.requestsProcessed > 0
                ? `${(this.metrics.errors.length / this.metrics.requestsProcessed * 100).toFixed(1)}%`
                : '0.0%';

            const health = {
                status: dbHealth?.status === 'healthy' && roiHealth?.status === 'healthy' ? 'healthy' : 'unhealthy',
                timestamp: Date.now(),
                duration: performance.now() - startTime,
                components: {
                    db: dbHealth || { status: 'unknown', error: 'No response from health check' },
                    roi: roiHealth || { status: 'unknown', error: 'No response from health check' }
                },
                metrics: {
                    cacheHitRate,
                    totalRequests,
                    cacheHits: this.metrics.cacheHits,
                    cacheMisses: this.metrics.cacheMisses,
                    averageResponseTime: this.metrics.performance.averageResponseTime,
                    errorRate,
                    workersInitialized: this.workerInitialized
                }
            };

            // Detailed logging
            this.logGroup('healthCheck:result', {
                status: health.status,
                duration: `${(performance.now() - startTime).toFixed(2)}ms`,
                dbStatus: dbHealth?.status || 'unknown',
                roiStatus: roiHealth?.status || 'unknown',
                needsRecovery: health.status !== 'healthy'
            });

            if (health.status !== 'healthy') {
                this.logError('healthCheck', new Error('Unhealthy system state'), health);
                await this.handleUnhealthyState(health);
            }

            return health;
        } catch (error) {
            this.logError('healthCheck', error);
            return {
                status: 'error',
                error: error.message,
                timestamp: Date.now()
            };
        }
    }

    async handleUnhealthyState(health) {
        this.log('handleUnhealthyState', 'Attempting system recovery');

        try {
            if (health.components.db.status !== 'healthy') {
                await this.reinitializeWorker('db');
            }
            if (health.components.roi.status !== 'healthy') {
                await this.reinitializeWorker('roi');
            }
        } catch (error) {
            this.logError('handleUnhealthyState', error);
            throw error;
        }
    }

    async reinitializeWorker(type) {
        this.log(`reinitializeWorker`, `Reinitializing ${type} worker`);
        
        // Check for concurrent reinitialization
        if (this.workerInitLocks[type]) {
            this.log(`reinitializeWorker`, `Concurrent ${type} worker reinitialization in progress, waiting...`, 'system');
            
            // Wait for the existing initialization to complete
            return new Promise((resolve, reject) => {
                const checkInterval = setInterval(() => {
                    if (!this.workerInitLocks[type]) {
                        clearInterval(checkInterval);
                        
                        // If worker is now initialized, resolve
                        if (this.workerInitialized[type]) {
                            this.log(`reinitializeWorker`, `Concurrent reinitialization succeeded for ${type} worker, continuing`, 'system');
                            resolve(true);
                        } else {
                            // If worker is still not initialized, try again once more
                            this.log(`reinitializeWorker`, `Concurrent reinitialization failed for ${type} worker, retrying once`, 'system');
                            resolve(this._doReinitializeWorker(type));
                        }
                    }
                }, 100); // Check every 100ms
                
                // Set a timeout to avoid infinite waiting
                setTimeout(() => {
                    clearInterval(checkInterval);
                    reject(new Error(`Timed out waiting for concurrent ${type} worker reinitialization`));
                }, this.WORKER_INIT_TIMEOUT);
            });
        }
        
        // Set lock before reinitializing
        this.workerInitLocks[type] = true;
        try {
            return await this._doReinitializeWorker(type);
        } finally {
            // Always release the lock when done
            this.workerInitLocks[type] = false;
        }
    }
    
    // Private method to handle the actual worker reinitialization
    async _doReinitializeWorker(type) {
        try {
            // Terminate existing worker
            if (type === 'db' && this.dbWorker) {
                this.dbWorker.terminate();
                this.dbWorker = null;
            } else if (type === 'roi' && this.roiWorker) {
                this.roiWorker.terminate();
                this.roiWorker = null;
            }
            
            // Mark as not initialized
            this.workerInitialized[type] = false;

            // Reinitialize
            await this._doInitializeWorker(type);

            this.log(`reinitializeWorker`, `Successfully reinitialized ${type} worker`);
            return true;
        } catch (error) {
            this.logError(`reinitializeWorker`, error, { type });
            throw error;
        }
    }
    // Worker communication
    // In RoiDataManager
    async dbRequest(type, data) {
        const id = ++this.requestId;
        const startTime = performance.now();

        this.metrics.workerMetrics.dbWorker.messagesSent++;

        return new Promise((resolve, reject) => {
            const timeoutDuration = type === 'get' ? 500 : 5000; // Much shorter timeout for GETs
            const timeout = setTimeout(() => {
                // Send cancellation message for GET requests
                if (type === 'get') {
                    this.dbWorker.postMessage({
                        type: 'cancel',
                        data: { requestId: id }
                    });
                }
                this.pendingRequests.delete(id);
                const error = new Error(`DB worker request timeout: ${type}`);
                this.logError('dbRequest:timeout', error, { type, data });
                reject(error);
            }, timeoutDuration);

            const handler = (e) => {
                if (e.data.requestId === id) {
                    clearTimeout(timeout);
                    this.dbWorker.removeEventListener('message', handler);
                    if (e.data.error) {
                        reject(new Error(e.data.error));
                    } else {
                        resolve(e.data.result);
                    }
                }
            };

            this.dbWorker.addEventListener('message', handler);
            this.dbWorker.postMessage({ type, id, data });
        });
    }

    async getRoiWorkerHealth() {
        return new Promise((resolve, reject) => {
            // Verify worker exists before checking health
            if (!this.roiWorker) {
                this.log('getRoiWorkerHealth', 'ROI worker not initialized - worker missing');
                
                resolve({
                    status: 'unhealthy',
                    error: 'ROI worker not initialized - worker missing',
                    timestamp: Date.now()
                });
                return;
            }
            
            if (!this.workerInitialized.roi) {
                // Try to reinitialize
                this.log('getRoiWorkerHealth', 'ROI worker not initialized - attempting initialization');
                
                // Send init message
                try {
                    this.roiWorker.postMessage({ type: 'init' });
                } catch (error) {
                    this.logError('getRoiWorkerHealth', error, { action: 'initialization attempt' });
                }
                
                resolve({
                    status: 'initializing',
                    error: 'Worker needs initialization',
                    timestamp: Date.now()
                });
                return;
            }
            
            // Create a unique request ID
            const requestId = `health-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            
            const timeout = setTimeout(() => {
                this.log('getRoiWorkerHealth', 'Health check timeout', { requestId });
                resolve({
                    status: 'unhealthy',
                    error: 'Health check timeout',
                    timestamp: Date.now(),
                    requestId
                });
            }, 3000); // Shorter timeout for health checks

            try {
                // Actually send the message to get metrics
                this.roiWorker.postMessage({ 
                    type: 'getMetrics',
                    id: requestId  
                });
                
                this.log('getRoiWorkerHealth', 'Sent metrics request to worker', { requestId });

                const handler = (e) => {
                    // Only respond to our specific request ID if present
                    if (e.data.requestId && e.data.requestId !== requestId) {
                        return; // Not our response
                    }
                    
                    clearTimeout(timeout);
                    this.roiWorker.removeEventListener('message', handler);
                    
                    this.logGroup('getRoiWorkerHealth:response', {
                        responseType: e.data.type,
                        requestId: requestId,
                        receivedRequestId: e.data.requestId,
                        hasMetrics: e.data.type === 'metrics' && !!e.data.data
                    });

                    if (e.data.type === 'metrics') {
                        resolve({
                            status: 'healthy',
                            metrics: e.data.data,
                            timestamp: Date.now(),
                            requestId
                        });
                    } else {
                        resolve({
                            status: 'unhealthy',
                            error: 'Invalid metrics response',
                            responseType: e.data.type,
                            timestamp: Date.now(),
                            requestId
                        });
                    }
                };

                this.roiWorker.addEventListener('message', handler);
            } catch (error) {
                clearTimeout(timeout);
                this.logError('getRoiWorkerHealth', error, { requestId });
                resolve({
                    status: 'unhealthy',
                    error: error.message,
                    timestamp: Date.now(),
                    requestId
                });
            }
        });
    }

    // Cache management
    async getCached(jobId, dateRange, metadataOnly = false) {
        if (!jobId) {
            this.logError('getCached', new Error('Invalid jobId'), { jobId });
            this.metrics.cacheMisses++;
            return null;
        }
        
        const key = this.getCacheKey(jobId, dateRange);
        
        try {
            // Detail log for cache operation
            this.log('getCached', `Checking cache for job ${jobId} with key ${key}`, 'cache');
            
            // Add requestId to help trace request
            const requestId = `cache-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            
            const cached = await this.dbRequest('get', {
                store: 'executionCache',
                key,
                requestId,
                metadataOnly: metadataOnly
            });
            
            // Enhanced logging for cache result
            const cacheHit = cached && 
                   cached.data && 
                   Array.isArray(cached.data) &&
                   (Date.now() - cached.timestamp) < this.EXECUTION_CACHE_TTL;
                   
            const logDetails = {
                jobId,
                key,
                requestId,
                found: !!cached,
                hasData: cached && !!cached.data,
                isDataArray: cached && Array.isArray(cached.data),
                dataLength: cached && cached.data && Array.isArray(cached.data) ? cached.data.length : 0,
                timestamp: cached ? cached.timestamp : null,
                age: cached ? `${((Date.now() - cached.timestamp) / 1000 / 60).toFixed(1)} minutes` : null,
                expired: cached ? ((Date.now() - cached.timestamp) >= this.EXECUTION_CACHE_TTL) : null,
                ttl: `${this.EXECUTION_CACHE_TTL / 1000 / 60} minutes`,
                metadataOnly
            };

            if (cacheHit) {
                this.metrics.cacheHits++;
                this.logGroup('getCached:hit', logDetails, 'cache');
                
                // If metadata only was requested, return the full cache object
                if (metadataOnly) {
                    return cached;
                }
                
                // If data is not array, convert it (for legacy data)
                if (cached.data && !Array.isArray(cached.data)) {
                    this.log('getCached', 'Converting non-array data to array', {
                        jobId,
                        key,
                        dataType: typeof cached.data
                    });
                    
                    return [cached.data];
                }
                
                // Return full cache object with metadata if we're using timestamp-based freshness checks
                return cached;
            }

            this.metrics.cacheMisses++;
            this.logGroup('getCached:miss', logDetails, 'cache');
            
            // If we have data but it's expired, log that
            if (cached && cached.data && ((Date.now() - cached.timestamp) >= this.EXECUTION_CACHE_TTL)) {
                this.log('getCached', 'Cache expired', {
                    jobId,
                    age: `${((Date.now() - cached.timestamp) / 1000 / 60).toFixed(1)} minutes`,
                    ttl: `${this.EXECUTION_CACHE_TTL / 1000 / 60} minutes`
                });
            }
            
            return null;
        } catch (error) {
            this.logError('getCached', error, { jobId, dateRange, key, metadataOnly });
            this.metrics.cacheMisses++;
            return null;
        }
    }

    getCacheKey(jobId, dateRange) {
        // Ensure consistent key format - this is crucial for cache hits
        const sanitizedJobId = jobId ? jobId.replace(/[^a-zA-Z0-9-]/g, '_') : 'unknown';

        // Create the formatted key
        const key = `${sanitizedJobId}`;
        
        // Log the key generation for debug purposes
        this.logGroup('getCacheKey', {
            rawJobId: jobId,
            sanitizedJobId,
            dateRange
        }, 'cache');
        
        // Return a consistent key format
        return key;
    }
    
    // Helper function to filter executions by date range
    filterExecutionsByDateRange(executions, dateRange) {
        if (!executions || !executions.length || !dateRange) return executions;
        
        const beginDate = moment(dateRange.begin).startOf('day');
        const endDate = moment(dateRange.end).endOf('day');
        
        this.logGroup('filterExecutionsByDateRange', {
            executionsToFilter: executions.length,
            dateRange: {
                begin: beginDate.format('YYYY-MM-DD'),
                end: endDate.format('YYYY-MM-DD')
            }
        }, 'process');
        
        const filtered = executions.filter(execution => {
            // Get the execution date (handling different date formats)
            const dateStarted = execution['date-started']?.date || execution.dateStarted;
            if (!dateStarted) return false;
            
            const executionDate = moment(dateStarted);
            
            // Check if the execution is within the date range
            return (executionDate.isSameOrAfter(beginDate) && 
                   executionDate.isSameOrBefore(endDate));
        });
        
        this.logGroup('filterExecutionsByDateRange:result', {
            totalExecutions: executions.length,
            filteredCount: filtered.length,
            beginDate: beginDate.format('YYYY-MM-DD'),
            endDate: endDate.format('YYYY-MM-DD')
        }, 'process');
        
        return filtered;
    }
    
    // Helper to check if one date range contains another
    isDateRangeContained(smallerRange, largerRange) {
        if (!smallerRange || !largerRange) return false;

        // Convert all dates to moment objects at day level precision
        const smallerBegin = moment(smallerRange.begin).startOf('day');
        const smallerEnd = moment(smallerRange.end).endOf('day');
        const largerBegin = moment(largerRange.begin).startOf('day');
        const largerEnd = moment(largerRange.end).endOf('day')

        // Check if smaller range is fully contained within larger range
        // Allow for 1 day of flexibility on either end
        return (smallerBegin.isSameOrAfter(largerBegin) ||
            smallerBegin.clone().add(1, 'day').isSameOrAfter(largerBegin)) &&
            (smallerEnd.isSameOrBefore(largerEnd) || smallerEnd.clone().subtract(1, 'day').isSameOrBefore(largerEnd));
    }

    // Main execution processing
    // In RoiDataManager, modify getExecutionsWithRoi
    async getExecutionsWithRoi(jobIds, dateRange) {
        const startTime = performance.now();
        this.logGroup('getExecutionsWithRoi:start', { jobIds, dateRange }, 'process');

        try {
            // Check if workers are initialized, try to initialize them if not
            if (!this.workerInitialized.roi || !this.workerInitialized.db) {
                this.log('getExecutionsWithRoi', 'Workers not initialized, attempting to initialize', 'process');
                
                try {
                    const initPromises = [];
                    
                    // Create promises for worker initialization based on needs
                    if (!this.workerInitialized.roi) {
                        initPromises.push(
                            (!this.roiWorker ? this.initializeWorker('roi') : this.reinitializeWorker('roi'))
                                .catch(err => {
                                    this.logError('getExecutionsWithRoi', err, { workerType: 'roi' });
                                    return false;
                                })
                        );
                    }
                    
                    if (!this.workerInitialized.db) {
                        initPromises.push(
                            (!this.dbWorker ? this.initializeWorker('db') : this.reinitializeWorker('db'))
                                .catch(err => {
                                    this.logError('getExecutionsWithRoi', err, { workerType: 'db' });
                                    return false;
                                })
                        );
                    }
                    
                    // Wait for all initialization attempts to complete
                    if (initPromises.length > 0) {
                        await Promise.all(initPromises);
                    }
                    
                    // Check if initialization was successful
                    if (!this.workerInitialized.roi || !this.workerInitialized.db) {
                        throw new Error('Failed to initialize workers');
                    }
                    
                    this.log('getExecutionsWithRoi', 'Successfully initialized workers', 'process');
                } catch (initError) {
                    // If initialization fails, try fallback
                    this.logError('getExecutionsWithRoi', initError);
                    return this.getExecutionsWithRoiFallback(jobIds, dateRange);
                }
            }

            // Check localStorage flags to see if we need to fetch today's data
            const isInitialCacheComplete = this.isInitialCacheComplete();
            const cacheTimestamp = this.getCacheTimestamp();
            const now = moment();

            this.logGroup('getExecutionsWithRoi:cacheFlags', {
                isInitialCacheComplete,
                cacheTimestamp: cacheTimestamp ? new Date(cacheTimestamp).toISOString() : 'none',
                cacheAge: cacheTimestamp ? `${((Date.now() - cacheTimestamp) / 1000 / 60 / 60).toFixed(1)} hours` : 'none'
            }, 'cache');

            // If initial cache is complete, we might need to fetch today's data
            const shouldFetchTodayData = isInitialCacheComplete;

            // If we need to fetch today's data, prepare the date range
            let todayDateRange = null;
            if (shouldFetchTodayData) {
                todayDateRange = {
                    begin: moment().startOf('day').format('YYYY-MM-DD'),
                    end: moment().endOf('day').format('YYYY-MM-DD')
                };
                
                this.logGroup('getExecutionsWithRoi:todayData', {
                    shouldFetchTodayData,
                    todayDateRange,
                    jobCount: jobIds.length
                }, 'cache');
            }

            const results = new Map();

            // First check registry to filter out jobs known to have no ROI data
            const jobsToProcess = [];
            
            if (this.USE_JOB_REGISTRY) {
                for (const jobId of jobIds) {
                    const registryInfo = this.processedJobRegistry.get(jobId);
                    
                    // If we know this job has no ROI metrics and entry is fresh enough, skip it
                    // BUT if we need to fetch today's data, don't skip
                    if (registryInfo && !registryInfo.hasRoi && 
                        (Date.now() - registryInfo.timestamp < this.EXECUTION_CACHE_TTL) &&
                        !shouldFetchTodayData) {
                        this.logGroup('getExecutionsWithRoi:registrySkip', {
                            jobId,
                            reason: 'Job known to have no ROI metrics',
                            registryAge: `${((Date.now() - registryInfo.timestamp) / 1000 / 60 / 60).toFixed(1)} hours`,
                            threshold: `${this.EXECUTION_CACHE_TTL / 1000 / 60 / 60} hours`
                        }, 'registry');
                        // Add an empty result to maintain API contract
                        results.set(jobId, []);
                    } else {
                        jobsToProcess.push(jobId);
                    }
                }
                
                this.logGroup('getExecutionsWithRoi:registryFiltered', {
                    totalJobs: jobIds.length,
                    skippedFromRegistry: jobIds.length - jobsToProcess.length,
                    remainingToProcess: jobsToProcess.length,
                    shouldFetchTodayData
                }, 'registry');
            } else {
                // No registry, process all jobs
                jobsToProcess.push(...jobIds);
            }
            
            // Process each job separately
            for (const jobId of jobsToProcess) {
                const cacheKey = this.getCacheKey(jobId, dateRange);

                // If initial cache is complete and we need to check for today's data,
                // first check if this job has ROI metrics by fetching a single execution for today
                if (shouldFetchTodayData) {
                    try {
                        this.log('getExecutionsWithRoi', `Checking for today's data for job ${jobId}`, 'process');
                        
                        // Check the job ROI status to see if it has ROI metrics
                        const hasRoi = await this.checkJobRoiStatus(jobId);
                        
                        if (hasRoi) {
                            this.logGroup('getExecutionsWithRoi:todayCheck', {
                                jobId,
                                hasRoi
                            }, 'process');
                            
                            // Job has ROI metrics, let's check executions for today
                            const result = await this.fetchExecutions(jobId, todayDateRange);
                            const todayExecutions = result.executions;
                            
                            if (todayExecutions.length > 0) {
                                // Process these executions and merge with existing cache if any
                                this.logGroup('getExecutionsWithRoi:todayExecutions', {
                                    jobId,
                                    executionsCount: todayExecutions.length,
                                    totalExecutions: result.totalExecutions
                                }, 'process');
                                
                                // We'll process these executions later, along with any cached data
                                // Add to executionsToFetch if we find any
                            }
                        }
                    } catch (error) {
                        this.logError('getExecutionsWithRoi:todayCheck', error, { jobId });
                        // Continue with regular flow even if today's check fails
                    }
                }

                // Get cached executions if available
                let cachedExecutions = [];
                let cacheResponseData = null;
                try {
                    const cached = await this.getCached(jobId, dateRange);
                    if (cached) {
                        // Check if this is a full response with metadata
                        if (cached.data && Array.isArray(cached.data)) {
                            // Handle legacy format conversion
                            this.logGroup('getExecutionsWithRoi:cacheWithMeta', {
                                jobId,
                                executionsCount: cached.data.length,
                                source: 'cache',
                                hasTimestamp: !!cached.timestamp,
                                cachedDateRange: cached.dateRange
                            }, 'process');
                            cachedExecutions = cached.data;
                            cacheResponseData = cached;
                        } else if (Array.isArray(cached)) {
                            // Regular cache data format
                            this.logGroup('getExecutionsWithRoi:cache', {
                                jobId,
                                executionsCount: cached.length,
                                source: 'cache'
                            }, 'process');
                            cachedExecutions = cached;
                        }
                    }
                } catch (cacheError) {
                    this.metrics.cacheMisses++;
                }

                // Check if we need to fetch recent data
                let executionsToFetch = [];
                const now = moment();
                
                // Special handling for today's data if the initial cache is complete
                if (shouldFetchTodayData) {
                    const todayResult = await this.fetchExecutions(jobId, todayDateRange);
                    if (todayResult.executions.length > 0) {
                        this.log('getExecutionsWithRoi:todayFetch', `Found ${todayResult.executions.length} executions for today`, 'process');
                        // Store the executions and remember the total
                        executionsToFetch.push(...todayResult.executions);
                        // Store the total count as a separate property
                        if (typeof todayResult.totalExecutions === 'number') {
                            executionsToFetch.totalExecutions = todayResult.totalExecutions;
                        }
                    }
                }
                
                // Only fetch regular data executions if cache is missing or outdated
                else if (!cachedExecutions.length) {
                    // No cache - fetch everything
                    if (executionsToFetch.length === 0) {
                        this.log('getExecutionsWithRoi:noCache', 'No cached data, fetching all executions', 'process');
                        const fetchedResult = await this.fetchExecutions(jobId, dateRange);
                        executionsToFetch.push(...fetchedResult.executions);
                        if (typeof fetchedResult.totalExecutions === 'number') {
                            executionsToFetch.totalExecutions = fetchedResult.totalExecutions;
                        }
                    }
                } else {
                    // Get the actual cache timestamp from our request
                    let cacheTimestamp = null;
                    let cachedDateRange = null;
                    
                    // If we already have the timestamp from cache data, use it
                    if (cacheResponseData && cacheResponseData.timestamp) {
                        cacheTimestamp = cacheResponseData.timestamp;
                        cachedDateRange = cacheResponseData.dateRange;
                    } else {
                        // Otherwise make a targeted request to get just metadata
                        try {
                            const cacheKey = this.getCacheKey(jobId, dateRange);
                            const cacheMetadata = await this.dbRequest('get', {
                                store: 'executionCache',
                                key: cacheKey,
                                metadataOnly: true  // Only get timestamp, not full data
                            });
                            
                            if (cacheMetadata && cacheMetadata.timestamp) {
                                cacheTimestamp = cacheMetadata.timestamp;
                                cachedDateRange = cacheMetadata.dateRange;
                            }
                        } catch (err) {
                            this.logError('getExecutionsWithRoi:cacheTimestamp', err, { jobId });
                        }
                    }
                    
                    // Use the cache storage timestamp, not the execution date
                    const cacheStorageTime = cacheTimestamp ? moment(cacheTimestamp) : moment().subtract(this.CACHE_FRESHNESS_THRESHOLD + 1, 'hours');
                    
                    // Calculate if we need to fetch additional data based on date range
                    if (cacheResponseData?.dateRange && dateRange) {
                        const cachedDateRange = cacheResponseData.dateRange;
                        const cachedBegin = moment(cachedDateRange.begin);
                        const cachedEnd = moment(cachedDateRange.end);
                        const requestedBegin = moment(dateRange.begin);
                        const requestedEnd = moment(dateRange.end);
                        
                        // Check if the requested date range is fully contained within the cached date range
                        const isRequestedRangeWithinCache = this.isDateRangeContained(dateRange, cachedDateRange);
                            
                        // Check if the requested date range extends beyond what we have cached
                        const needsOlderData = requestedBegin.isBefore(cachedBegin);
                        const needsNewerData = requestedEnd.isAfter(cachedEnd) && 
                            now.diff(cacheStorageTime, 'hours') >= this.CACHE_FRESHNESS_THRESHOLD;
                        
                        this.logGroup('getExecutionsWithRoi:dateRangeAnalysis', {
                            jobId,
                            cachedDateRange: {
                                begin: cachedDateRange.begin,
                                end: cachedDateRange.end
                            },
                            requestedDateRange: {
                                begin: dateRange.begin,
                                end: dateRange.end
                            },
                            isRequestedRangeWithinCache,
                            needsOlderData,
                            needsNewerData,
                            cacheAge: `${now.diff(cacheStorageTime, 'hours')} hours`
                        }, 'process');
                        // If the requested range is fully contained within the cached range,
                        // we don't need to fetch any data
                        if (isRequestedRangeWithinCache && !shouldFetchTodayData) {
                            this.logGroup('getExecutionsWithRoi:cachedRangeSufficient', {
                                jobId,
                                message: 'Requested date range is fully contained within cached date range, no need to fetch additional data',
                                cachedRange: `${cachedDateRange.begin} to ${cachedDateRange.end}`,
                                requestedRange: `${dateRange.begin} to ${dateRange.end}`
                            }, 'process');
                            
                            // No need to fetch any executions
                        } else {
                            // Need to fetch missing data
                            if (needsOlderData) {
                                // Need to fetch older data
                                const olderDateRange = {
                                    begin: dateRange.begin,
                                    end: moment(cachedBegin).subtract(1, 'day').format('YYYY-MM-DD')
                                };
                                
                                this.logGroup('getExecutionsWithRoi:fetchingOlderData', {
                                    jobId,
                                    fetchingRange: olderDateRange
                                }, 'process');
                                
                                const olderResult = await this.fetchExecutions(jobId, olderDateRange);
                                executionsToFetch.push(...olderResult.executions);
                                if (typeof olderResult.totalExecutions === 'number') {
                                    executionsToFetch.totalExecutions = olderResult.totalExecutions;
                                }
                            }
                            
                            // Only check for newer data if we haven't already fetched today's data
                            if (needsNewerData && !shouldFetchTodayData) {
                                // Need to fetch newer data
                                const newerDateRange = {
                                    begin: moment(cachedEnd).add(1, 'day').format('YYYY-MM-DD'),
                                    end: dateRange.end
                                };
                                
                                this.logGroup('getExecutionsWithRoi:fetchingNewerData', {
                                    jobId,
                                    fetchingRange: newerDateRange
                                }, 'process');
                                
                                const newerResult = await this.fetchExecutions(jobId, newerDateRange);
                                executionsToFetch.push(...newerResult.executions);
                                if (typeof newerResult.totalExecutions === 'number') {
                                    executionsToFetch.totalExecutions = newerResult.totalExecutions;
                                }
                            }
                        }
                    } else if (now.diff(cacheStorageTime, 'hours') >= this.CACHE_FRESHNESS_THRESHOLD && !shouldFetchTodayData) {
                        // Cache is too old, fetch recent executions, but only if we haven't already fetched today's data
                        const recentDateRange = {
                            begin: moment().subtract(1, 'days').format('YYYY-MM-DD'),
                            end: dateRange.end
                        };
                        
                        this.logGroup('getExecutionsWithRoi:outdatedCache', {
                            jobId,
                            cacheAge: `${now.diff(cacheStorageTime, 'hours')} hours`,
                            cacheStorageTime: cacheStorageTime.format('YYYY-MM-DD HH:mm:ss'),
                            now: now.format('YYYY-MM-DD HH:mm:ss'),
                            fetchingRange: recentDateRange
                        }, 'cache');
                        
                        const recentResult = await this.fetchExecutions(jobId, recentDateRange);
                        executionsToFetch.push(...recentResult.executions);
                        if (typeof recentResult.totalExecutions === 'number') {
                            executionsToFetch.totalExecutions = recentResult.totalExecutions;
                        }
                    } else {
                        this.logGroup('getExecutionsWithRoi:freshCache', {
                            jobId,
                            cacheAge: `${now.diff(cacheStorageTime, 'hours')} hours`,
                            cacheStorageTime: cacheStorageTime.format('YYYY-MM-DD HH:mm:ss'),
                            now: now.format('YYYY-MM-DD HH:mm:ss'),
                            threshold: `${this.CACHE_FRESHNESS_THRESHOLD} hours`,
                            shouldFetchTodayData
                        }, 'cache');
                    }
                }

                // Log what we're about to process
                this.logGroup('getExecutionsWithRoi:processing', {
                    jobId,
                    cachedExecutions: cachedExecutions.length,
                    newExecutions: executionsToFetch.length,
                    total: cachedExecutions.length + executionsToFetch.length
                }, 'process');

                // Smart processing of executions - only process what's needed
                let jobExecutions = [];
                
                // Check if we have any new executions that need ROI metrics
                if (executionsToFetch.length > 0) {
                    this.logGroup('getExecutionsWithRoi:processingNew', {
                        jobId,
                        newExecutionsCount: executionsToFetch.length,
                        source: 'worker'
                    }, 'process');
                    
                    // Only send new executions to worker for ROI metrics
                    jobExecutions = await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => {
                            reject(new Error('ROI processing timeout'));
                        }, 60000);

                        const handler = (e) => {
                            const response = e.data;

                            this.logGroup('getExecutionsWithRoi:responseInfo', {
                                responseType: response.type,
                            }, 'process');

                            if (response.type === 'progress') {
                                if (response.batch?.jobId === jobId) {
                                    this.logGroup('worker:progress', {
                                        jobId,
                                        processed: response.processed,
                                        total: response.batch.total,
                                        batchResults: response.batch.results,
                                        metrics: response.batch.metrics
                                    }, 'process');
                                }
                                return;
                            }

                            if (response.type === 'executionsProcessed') {
                                if (response.summary?.jobId === jobId) {
                                    clearTimeout(timeout);
                                    this.roiWorker.removeEventListener('message', handler);

                                    const processedNewExecutions = response.results;

                                    this.logGroup('getExecutionsWithRoi:processedExecutions', {
                                        jobId,
                                        executionsCount: processedNewExecutions.length,
                                        source: 'worker'
                                    }, 'process');

                                    // Deduplicate executions by id before merging
                                    const executionMap = new Map();
                                    
                                    // Add cached executions to map
                                    cachedExecutions.forEach(exec => {
                                        executionMap.set(exec.id, exec);
                                    });
                                    
                                    // Add new executions, potentially overwriting older copies
                                    processedNewExecutions.forEach(exec => {
                                        executionMap.set(exec.id, exec);
                                    });
                                    
                                    // Convert map back to array
                                    let allProcessedExecutions = Array.from(executionMap.values());
                                    
                                    // Store everything in cache for history purposes (including failed executions)
                                    // but filter for ROI calculations and registry updates
                                    
                                    // Filter for successful executions with ROI data
                                    const successfulExecutions = allProcessedExecutions.filter(exec => 
                                        exec.status === 'succeeded'
                                    );
                                    
                                    // Further filter for executions with ROI data
                                    const executionsWithRoi = successfulExecutions.filter(exec => 
                                        exec.hasRoi || exec.roiHours
                                    );
                                    
                                    // Store in registry if this job has any ROI data (based on successful executions only)
                                    const hasRoiData = executionsWithRoi.length > 0;
                                    
                                    if (this.USE_JOB_REGISTRY) {
                                        // Update our in-memory registry immediately
                                        this.processedJobRegistry.set(jobId, {
                                            timestamp: Date.now(),
                                            hasRoi: hasRoiData
                                        });
                                        
                                        // Log the registry update
                                        this.logGroup('getExecutionsWithRoi:registryUpdate', {
                                            jobId,
                                            hasRoi: hasRoiData,
                                            executionsCount: allProcessedExecutions.length,
                                            timestamp: new Date().toISOString()
                                        }, 'registry');
                                    }
                                    
                                    if (allProcessedExecutions.length > 0) {
                                        // Determine the effective date range for the cache
                                        // When we merge new data, the effective range might be wider than the requested range
                                        let effectiveDateRange = dateRange;
                                        
                                        // If we have both cached and newly fetched data, calculate the widest date range
                                        if (cacheResponseData?.dateRange && executionsToFetch.length > 0) {
                                            const cachedDateRange = cacheResponseData.dateRange;
                                            const oldestDate = moment.min([
                                                moment(dateRange.begin),
                                                moment(cachedDateRange.begin)
                                            ]).format('YYYY-MM-DD');
                                            
                                            const newestDate = moment.max([
                                                moment(dateRange.end),
                                                moment(cachedDateRange.end)
                                            ]).format('YYYY-MM-DD');
                                            
                                            effectiveDateRange = {
                                                begin: oldestDate,
                                                end: newestDate
                                            };
                                            
                                            this.logGroup('getExecutionsWithRoi:effectiveDateRange', {
                                                jobId,
                                                requestedRange: dateRange,
                                                cachedRange: cachedDateRange,
                                                effectiveRange: effectiveDateRange
                                            }, 'process');
                                        }
                                        
                                        // Cache in background
                                        // When we're fetching today's data, we need to preserve the original date range
                                        // Always prioritize the original cached date range when it exists and we're fetching today's data
                                        const cacheRangeToUse = shouldFetchTodayData && cacheResponseData?.dateRange ? 
                                            cacheResponseData.dateRange : 
                                            (effectiveDateRange || dateRange);
                                            
                                        this.logGroup('getExecutionsWithRoi:cacheUpdate', {
                                            jobId,
                                            shouldFetchTodayData,
                                            originalDateRange: cacheResponseData?.dateRange,
                                            effectiveRange: effectiveDateRange,
                                            requestedRange: dateRange,
                                            todayDateRange: todayDateRange,
                                            usingRange: cacheRangeToUse
                                        }, 'process');
                                            
                                        // Determine the paging total - look in several places:
                                        // 1. From the executionsToFetch.totalExecutions property we added
                                        // 2. From cached data if available
                                        // 3. Default to 0
                                        let totalExecutions = 0;
                                        
                                        if (executionsToFetch && typeof executionsToFetch.totalExecutions === 'number') {
                                            totalExecutions = executionsToFetch.totalExecutions;
                                        } else if (cacheResponseData && typeof cacheResponseData.totalExecutions === 'number') {
                                            totalExecutions = cacheResponseData.totalExecutions;
                                        }
                                        
                                        // Create the value object using individual property assignments
                                        const valueToStore = {};
                                        
                                        // Add core properties
                                        valueToStore.id = cacheKey;
                                        valueToStore.data = allProcessedExecutions;
                                        valueToStore.timestamp = Date.now();
                                        valueToStore.dateRange = cacheRangeToUse;
                                        valueToStore.jobId = jobId;
                                        valueToStore.hasRoi = hasRoiData;
                                        
                                        // Add the totalExecutions property
                                        valueToStore.totalExecutions = totalExecutions;
                                        
                                        this.logGroup('getExecutionsWithRoi:dbRequest', {
                                            jobId,
                                            valueKeys: Object.keys(valueToStore),
                                            totalExecutions: totalExecutions
                                        }, 'cache');
                                        
                                        // First serialize to JSON then deserialize to create a clean copy
                                        // This prevents any non-serializable or hidden properties from being included
                                        // when we pass it to the worker
                                        const valueToStoreClean = JSON.parse(JSON.stringify(valueToStore));
                                        
                                        // Create clean copy for worker
                                        
                                        this.dbRequest('set', {
                                            store: 'executionCache',
                                            value: valueToStoreClean
                                        }).catch(error => this.logError('cacheSet', error));
                                    }

                                    // Filter the executions by the requested date range before returning
                                    let filteredExecutions = this.filterExecutionsByDateRange(allProcessedExecutions, dateRange);
                                    
                                    // For returning to client/display, we only want successful executions with ROI data
                                    filteredExecutions = filteredExecutions.filter(execution => 
                                        execution.status === 'succeeded' && 
                                        (execution.hasRoi || execution.roiHours > 0)
                                    );
                                    
                                    this.logGroup('getExecutionsWithRoi:results', {
                                        jobId,
                                        allExecutionsCount: allProcessedExecutions.length,
                                        filteredExecutionsCount: filteredExecutions.length,
                                        dateRange,
                                        source: 'final'
                                    }, 'process');

                                    resolve(filteredExecutions);
                                }
                            }

                            if (response.type === 'error') {
                                clearTimeout(timeout);
                                this.roiWorker.removeEventListener('message', handler);
                                this.logError('worker', response.error, response.context);
                                reject(new Error(response.error));
                            }
                        };

                        this.roiWorker.addEventListener('message', handler);
                        this.roiWorker.postMessage({
                            type: 'processExecutions',
                            data: {
                                executions: executionsToFetch, // Only send new executions for processing
                                dateRange,
                                jobId
                            }
                        });
                    });
                } else {
                    // Use cached executions but filter them by the requested date range
                    const filteredCachedExecutions = this.filterExecutionsByDateRange(cachedExecutions, dateRange);
                    
                    this.logGroup('getExecutionsWithRoi:usingCachedDirectly', {
                        jobId,
                        cachedExecutionsCount: cachedExecutions.length,
                        filteredExecutionsCount: filteredCachedExecutions.length,
                        dateRange,
                        source: 'cache'
                    }, 'process');
                    
                    jobExecutions = filteredCachedExecutions;
                    
                    // No need to update registry or cache since we're using existing cache
                }

                results.set(jobId, jobExecutions);
            }

            const duration = performance.now() - startTime;
            this.logGroup('getExecutionsWithRoi:complete', {
                totalTime: `${duration.toFixed(2)}ms`,
                resultCounts: Array.from(results.entries()).map(([id, execs]) => ({
                    jobId: id,
                    count: execs.length
                }))
            }, 'process');

            return results;

        } catch (error) {
            this.logError('getExecutionsWithRoi', error);
            return this.getExecutionsWithRoiFallback(jobIds, dateRange);
        }
    }

    async fetchExecutions(jobId, dateRange) {
        const startTime = performance.now();
        this.logGroup('fetchExecutions:start', { jobId, dateRange }, 'network');

        // Check if the worker exists and is initialized, attempt to initialize if not
        if (!this.roiWorker || !this.workerInitialized.roi) {
            this.log('fetchExecutions', 'ROI worker not initialized, attempting to initialize', 'network');
            
            try {
                // If no worker exists at all, create one
                if (!this.roiWorker) {
                    await this.initializeWorker('roi');
                    
                    // If initialization failed, throw an error
                    if (!this.roiWorker || !this.workerInitialized.roi) {
                        throw new Error('Failed to initialize ROI worker');
                    }
                    
                    this.log('fetchExecutions', 'Successfully initialized ROI worker', 'network');
                } 
                // If worker exists but isn't initialized, try reinitializing
                else if (!this.workerInitialized.roi) {
                    await this.reinitializeWorker('roi');
                    
                    // If reinitialization failed, throw an error
                    if (!this.workerInitialized.roi) {
                        throw new Error('Failed to reinitialize ROI worker');
                    }
                    
                    this.log('fetchExecutions', 'Successfully reinitialized ROI worker', 'network');
                }
            } catch (initError) {
                this.logError('fetchExecutions', initError, { jobId, action: 'worker initialization' });
                throw new Error(`ROI worker initialization failed: ${initError.message}`);
            }
        }

        // Use the worker to fetch executions
        const id = ++this.requestId;
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Fetch executions timeout'));
            }, 30000); // 30 seconds timeout
            
            const handler = (e) => {
                if (e.data.requestId === id) {
                    clearTimeout(timeout);
                    
                    if (e.data.type === 'error') {
                        this.logError('fetchExecutions', new Error(e.data.error), { jobId });
                        reject(new Error(e.data.error));
                    } else if (e.data.type === 'executionsFetched') {
                        const executions = e.data.results;
                        const totalExecutions = e.data.totalExecutions || 0;
                        const duration = performance.now() - startTime;
                        
                        this.logGroup('fetchExecutions:complete', {
                            jobId,
                            count: executions.length,
                            totalExecutions: totalExecutions,
                            duration: `${duration.toFixed(2)}ms`,
                            averageTimePerExecution: executions.length > 0 ? `${(duration / executions.length).toFixed(2)}ms` : 'N/A',
                            source: 'worker'
                        }, 'network');
                        
                        // Return an object with executions and total count
                        resolve({
                            executions: executions,
                            totalExecutions: totalExecutions
                        });
                    }
                }
            };

            this.roiWorker.addEventListener('message', handler);
            
            this.roiWorker.postMessage({
                type: 'fetchExecutions',
                id,
                data: {
                    jobId,
                    dateRange
                }
            });
        });
    }

    async checkJobRoiStatus(jobId) {
        return this.checkJobRoiStatusViaExecution(jobId);
    }

    async checkJobRoiStatusViaExecution(jobId) {
        // First check our in-memory job registry (much faster than IndexedDB)
        const registryEntry = this.USE_JOB_REGISTRY ? this.processedJobRegistry.get(jobId) : null;
        
        this.logGroup('checkJobRoiStatusViaExecution:start', {
            jobId,
            hasCachedValue: !!registryEntry,
            registryAge: registryEntry ? `${((Date.now() - registryEntry.timestamp) / 1000 / 60).toFixed(1)} minutes` : 'n/a'
        }, 'network');

        const startTime = performance.now();
        
        // Use registry if available and fresh
        if (registryEntry && (Date.now() - registryEntry.timestamp < this.EXECUTION_CACHE_TTL)) {
            this.metrics.cacheHits++;
            this.logGroup('checkJobRoiStatusViaExecution:registryHit', {
                jobId,
                registryAge: `${((Date.now() - registryEntry.timestamp) / 1000 / 60).toFixed(1)} minutes`,
                hasRoi: registryEntry.hasRoi
            }, 'registry');
            return registryEntry.hasRoi;
        }

        try {
            // Try IndexedDB cache if registry isn't available or is stale
            try {
                // Log the raw jobId being used as key
                this.log('checkJobRoiStatusViaExecution:cacheKey', `Using raw jobId as cache key: ${jobId}`, 'cache');
                
                const cachePromise = this.dbRequest('get', {
                    store: 'jobCache',
                    key: jobId
                });

                const cached = await Promise.race([
                    cachePromise,
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Cache timeout')), 150)
                    )
                ]);

                if (cached && (Date.now() - cached.timestamp) < this.EXECUTION_CACHE_TTL) {
                    this.metrics.cacheHits++;
                    this.logGroup('checkJobRoiStatusViaExecution:cacheHit', {
                        jobId,
                        key: jobId,
                        cacheAge: `${((Date.now() - cached.timestamp) / 1000 / 60).toFixed(1)} minutes`,
                        hasRoi: cached.hasRoi
                    }, 'cache');
                    
                    // Update registry with this data
                    if (this.USE_JOB_REGISTRY) {
                        this.processedJobRegistry.set(jobId, {
                            timestamp: cached.timestamp,
                            hasRoi: !!cached.hasRoi
                        });
                    }
                    
                    return cached.hasRoi;
                }
            } catch (cacheError) {
                // If cache times out or fails, continue to API call
                this.metrics.cacheMisses++;
                this.logGroup('checkJobRoiStatusViaExecution:cacheError', {
                    jobId,
                    error: cacheError.message,
                    key: jobId
                }, 'cache');
            }

            // Cache miss or error - use worker to fetch from API
            this.log('checkJobRoiStatusViaExecution', 'Cache miss, fetching data', 'network');
            
            // Check if the worker exists and is initialized, attempt to initialize if not
            if (!this.roiWorker || !this.workerInitialized.roi) {
                this.log('checkJobRoiStatusViaExecution', 'ROI worker not initialized, attempting to initialize', 'network');
                
                try {
                    // If no worker exists at all, create one
                    if (!this.roiWorker) {
                        await this.initializeWorker('roi');
                        
                        // If initialization failed, throw an error
                        if (!this.roiWorker || !this.workerInitialized.roi) {
                            throw new Error('Failed to initialize ROI worker');
                        }
                        
                        this.log('checkJobRoiStatusViaExecution', 'Successfully initialized ROI worker', 'network');
                    } 
                    // If worker exists but isn't initialized, try reinitializing
                    else if (!this.workerInitialized.roi) {
                        await this.reinitializeWorker('roi');
                        
                        // If reinitialization failed, throw an error
                        if (!this.workerInitialized.roi) {
                            throw new Error('Failed to reinitialize ROI worker');
                        }
                        
                        this.log('checkJobRoiStatusViaExecution', 'Successfully reinitialized ROI worker', 'network');
                    }
                } catch (initError) {
                    this.logError('checkJobRoiStatusViaExecution', initError, { jobId, action: 'worker initialization' });
                    
                    // Cache a negative result to avoid repeated initialization attempts for this job
                    const cacheEntry = {
                        id: jobId,
                        hasRoi: false,
                        timestamp: Date.now()
                    };
                    
                    if (this.USE_JOB_REGISTRY) {
                        this.processedJobRegistry.set(jobId, {
                            timestamp: cacheEntry.timestamp,
                            hasRoi: false
                        });
                    }
                    
                    this.dbRequest('set', {
                        store: 'jobCache',
                        value: cacheEntry
                    }).catch((err) => {
                        this.logError('checkJobRoiStatusViaExecution:cacheStoreError', err, { jobId });
                    });
                    
                    return false;
                }
            }

            // Use the worker to check job ROI status
            const id = ++this.requestId;
            
            const result = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Check ROI status timeout'));
                }, 10000); // 10 seconds timeout
                
                const handler = (e) => {
                    if (e.data.requestId === id) {
                        clearTimeout(timeout);
                        
                        if (e.data.type === 'error') {
                            reject(new Error(e.data.error));
                        } else if (e.data.type === 'jobRoiStatus') {
                            resolve(e.data.result);
                        }
                    }
                };

                this.roiWorker.addEventListener('message', handler);
                
                this.roiWorker.postMessage({
                    type: 'checkJobRoiStatus',
                    id,
                    data: {
                        jobId
                    }
                });
            });

            const hasRoi = result.hasRoi;
            
            this.logGroup('checkJobRoiStatusViaExecution:complete', {
                jobId,
                hasRoi,
                totalTime: `${(performance.now() - startTime).toFixed(2)}ms`,
                source: 'worker'
            }, 'network');

            // Cache result in background
            const cacheEntry = {
                id: jobId,
                hasRoi: hasRoi,
                timestamp: Date.now()
            };
            
            this.logGroup('checkJobRoiStatusViaExecution:cacheStore', {
                jobId,
                key: jobId,
                entry: cacheEntry,
                hasRoi
            }, 'cache');
            
            // Update in-memory registry immediately 
            if (this.USE_JOB_REGISTRY) {
                this.processedJobRegistry.set(jobId, {
                    timestamp: cacheEntry.timestamp,
                    hasRoi: hasRoi
                });
            }
            
            this.dbRequest('set', {
                store: 'jobCache',
                value: cacheEntry
            }).catch((err) => {
                this.logError('checkJobRoiStatusViaExecution:cacheStoreError', err, { jobId });
            });

            return hasRoi;
        } catch (error) {
            this.logError('checkJobRoiStatusViaExecution', error, {
                jobId,
                requestTime: `${(performance.now() - startTime).toFixed(2)}ms`
            });
            
            // Cache negative result in background in case of errors
            const cacheEntry = {
                id: jobId,
                hasRoi: false,
                timestamp: Date.now()
            };
            
            // Update in-memory registry immediately
            if (this.USE_JOB_REGISTRY) {
                this.processedJobRegistry.set(jobId, {
                    timestamp: cacheEntry.timestamp,
                    hasRoi: false
                });
            }
            
            this.dbRequest('set', {
                store: 'jobCache',
                value: cacheEntry
            }).catch((err) => {
                this.logError('checkJobRoiStatusViaExecution:cacheStoreError', err, { jobId });
            });
            
            return false;
        }
    }

    // Fallback implementation
    async getExecutionsWithRoiFallback(jobIds, dateRange) {
        this.logGroup('getExecutionsWithRoiFallback:start', {
            jobIds,
            dateRange
        }, 'process');

        const startTime = performance.now();
        const results = new Map();
        
        // Check if ROI worker is available
        if (!this.roiWorker || !this.workerInitialized.roi) {
            this.logError('getExecutionsWithRoiFallback', new Error('ROI worker not initialized'));
            return results;
        }

        for (const jobId of jobIds) {
            try {
                // Use worker to fetch executions
                const result = await this.fetchExecutions(jobId, dateRange);
                
                if (!result || !result.executions || result.executions.length === 0) {
                    continue;
                }
                
                const executions = result.executions;
                const totalExecutions = result.totalExecutions || 0;
                
                // Process executions with ROI worker
                const id = ++this.requestId;
                const processedExecutions = await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Process executions timeout'));
                    }, 60000); // 60 seconds timeout
                    
                    const handler = (e) => {
                        if (e.data.requestId === id) {
                            clearTimeout(timeout);
                            
                            if (e.data.type === 'error') {
                                reject(new Error(e.data.error));
                            } else if (e.data.type === 'executionsProcessed') {
                                resolve(e.data.results);
                            }
                        }
                    };

                    this.roiWorker.addEventListener('message', handler);
                    
                    this.roiWorker.postMessage({
                        type: 'processExecutions',
                        id,
                        data: {
                            executions: executions,
                            jobId: jobId,
                            dateRange: dateRange
                        }
                    });
                });
                
                if (processedExecutions && processedExecutions.length > 0) {
                    // For returning to client/display, we only want successful executions with ROI data
                    const filteredExecutions = processedExecutions.filter(execution => 
                        execution.status === 'succeeded' && 
                        (execution.hasRoi || execution.roiHours > 0)
                    );
                    results.set(jobId, filteredExecutions);
                }
            } catch (error) {
                this.logError('getExecutionsWithRoiFallback', error, { jobId });
            }
        }

        this.logGroup('getExecutionsWithRoiFallback:complete', {
            totalTime: `${(performance.now() - startTime).toFixed(2)}ms`,
            results: Array.from(results.entries()).map(([id, execs]) => ({
                jobId: id,
                executionCount: execs.length
            })),
            source: 'worker'
        }, 'process');

        return results;
    }

    // LocalStorage management methods
    setInitialCacheComplete() {
        try {
            localStorage.setItem(this.LS_KEY_INITIAL_CACHE_COMPLETE, 'true');
            localStorage.setItem(this.LS_KEY_CACHE_TIMESTAMP, Date.now().toString());
            
            this.logGroup('setInitialCacheComplete', {
                initialCacheComplete: true,
                timestamp: new Date().toISOString()
            }, 'cache');
        } catch (error) {
            this.logError('setInitialCacheComplete', error);
        }
    }
    
    isInitialCacheComplete() {
        try {
            return localStorage.getItem(this.LS_KEY_INITIAL_CACHE_COMPLETE) === 'true';
        } catch (error) {
            this.logError('isInitialCacheComplete', error);
            return false;
        }
    }
    
    getCacheTimestamp() {
        try {
            const timestamp = localStorage.getItem(this.LS_KEY_CACHE_TIMESTAMP);
            return timestamp ? parseInt(timestamp) : 0;
        } catch (error) {
            this.logError('getCacheTimestamp', error);
            return 0;
        }
    }

    // Cleanup and maintenance
    async cleanup() {
        // Clear any existing scheduled cleanup attempts
        if (this.cleanupTimeoutId) {
            clearTimeout(this.cleanupTimeoutId);
            this.cleanupTimeoutId = null;
        }
        
        // If there are pending requests, reschedule cleanup for later
        if (this.pendingRequests.size > 0) {
            this.log('cleanup', `Rescheduling cleanup - ${this.pendingRequests.size} pending requests`, 'cache');
            this.cleanupTimeoutId = setTimeout(() => this.cleanup(), this.CACHE_CLEANUP_RETRY_DELAY);
            return;
        }
        
        const startTime = performance.now();
        this.log('cleanup', 'Starting cache cleanup', 'cache');

        try {
            // Get current user preference from localStorage if available
            let queryMaxDays = this.DEFAULT_QUERY_MAX_DAYS;
            try {
                const savedQueryMax = localStorage.getItem('rundeck.plugin.roisummary.queryMax');
                if (savedQueryMax) {
                    const parsedMax = parseInt(savedQueryMax);
                    if (!isNaN(parsedMax) && parsedMax > 0) {
                        queryMaxDays = parsedMax;
                    }
                }
            } catch (e) {
                // Ignore localStorage errors
            }
            
            // Calculate age threshold based on the query max days
            // We're removing data older than the user's query max
            const maxAge = 1000 * 60 * 60 * 24 * queryMaxDays;
            
            this.log('cleanup', `Using max age of ${queryMaxDays} days (${maxAge}ms)`, 'cache');
            
            // First, check execution cache contents
            try {
                const execCacheContents = await this.listCacheContents('executionCache');
                this.log('cleanup', `Found ${execCacheContents.length} execution cache entries before cleanup`, 'cache');
                
                // Log details of each entry
                execCacheContents.forEach((entry, index) => {
                    this.logGroup('cleanup:execution', {
                        index,
                        id: entry.id,
                        timestamp: entry.timestamp ? new Date(entry.timestamp).toISOString() : 'none',
                        dateRange: entry.dateRange || 'none',
                        hasData: !!entry.data,
                        dataLength: entry.data ? entry.data.length : 0
                    }, 'cache');
                });
            } catch (e) {
                // Just diagnostic - continue if this fails
                this.log('cleanup', `Error checking execution cache: ${e.message}`, 'cache');
            }
            
            // Run the cleanup operation
            await this.dbRequest('cleanup', {
                maxAge: maxAge
            });

            this.metrics.lastCleanup = Date.now();

            this.log('cleanup', `Cache cleanup completed - keeping last ${queryMaxDays} days (${(performance.now() - startTime).toFixed(2)}ms)`, 'cache');
        } catch (error) {
            this.logError('cleanup', error);
        }
    }
    
    // Diagnostic method to list cache contents
    async listCacheContents(storeName) {
        this.log('listCacheContents', `Listing contents of ${storeName} store`, 'diagnostic');
        
        try {
            const contents = await this.dbRequest('listStoreContents', { 
                store: storeName 
            });
            
            this.logGroup('listCacheContents:result', {
                storeName,
                itemCount: contents.length,
                items: contents
            }, 'diagnostic');
            
            return contents;
        } catch (error) {
            this.logError('listCacheContents', error, { storeName });
            return [];
        }
    }

    // Metrics collection
    async collectMetrics() {
        try {
            const roiMetrics = await this.getRoiWorkerHealth();
            
            // Generate cache efficiency metrics
            const cacheHitRate = this.metrics.cacheHits + this.metrics.cacheMisses > 0 ?
                (this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses) * 100).toFixed(1) : 'N/A';
            
            // Registry effectiveness
            const registrySize = this.USE_JOB_REGISTRY ? this.processedJobRegistry.size : 0;
            const jobsWithRoi = this.USE_JOB_REGISTRY ? 
                Array.from(this.processedJobRegistry.values()).filter(entry => entry.hasRoi).length : 0;
            
            this.logGroup('metrics', {
                cacheHitRate: `${cacheHitRate}%`,
                requestsProcessed: this.metrics.requestsProcessed,
                averageResponseTime: `${this.metrics.performance.averageResponseTime.toFixed(2)}ms`,
                registry: {
                    enabled: this.USE_JOB_REGISTRY,
                    size: registrySize,
                    jobsWithRoi,
                    jobsWithoutRoi: registrySize - jobsWithRoi
                },
                cacheThreshold: `${this.CACHE_FRESHNESS_THRESHOLD} hours`,
                workerStatus: {
                    db: this.workerInitialized.db,
                    roi: this.workerInitialized.roi
                },
                uptime: `${((Date.now() - this.metrics.startTime) / 1000 / 60).toFixed(1)} minutes`
            });
        } catch (error) {
            this.logError('collectMetrics', error);
        }
    }
    
}