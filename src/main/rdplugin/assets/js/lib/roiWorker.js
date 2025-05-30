// roiWorker.js
const DEBUG = false;

// Store global app data passed from main thread
let rdBase = '';
let projectName = '';

// Configuration
const MAX_CONCURRENT_REQUESTS = 10;

function log(component, message, data = null) {
    if (!DEBUG) return;
    const timestamp = new Date().toISOString();
    const logData = {
        timestamp,
        component,
        message,
        ...(data && { data })
    };
    console.log(`[ROI Worker] ${component}:`, logData);
}

function logError(component, error, context = {}) {
    if (!DEBUG) return;
    console.error(`[ROI Worker Error] ${component}:`, {
        message: error.message,
        stack: error.stack,
        context,
        timestamp: new Date().toISOString()
    });
}

// Concurrency Pool for limiting API requests
class ConcurrencyPool {
    constructor(maxConcurrent = MAX_CONCURRENT_REQUESTS) {
        this.maxConcurrent = maxConcurrent;
        this.running = 0;
        this.queue = [];
        this.activeRequests = 0;
        this.peakConcurrency = 0;
        this.totalEnqueued = 0;
        this.totalProcessed = 0;
        this.waitTime = 0;
    }

    async add(fn) {
        this.totalEnqueued++;
        
        // If we can run it now, do so
        if (this.running < this.maxConcurrent) {
            return this._run(fn);
        }
        
        // Otherwise queue it
        return new Promise((resolve, reject) => {
            const startWait = performance.now();
            
            this.queue.push(() => {
                const waitTime = performance.now() - startWait;
                this.waitTime += waitTime;
                
                this._run(fn).then(resolve, reject);
            });
        });
    }
    
    async _run(fn) {
        this.running++;
        this.activeRequests++;
        
        // Update peak concurrency metric
        if (this.activeRequests > this.peakConcurrency) {
            this.peakConcurrency = this.activeRequests;
        }
        
        try {
            return await fn();
        } finally {
            this.running--;
            this.activeRequests--;
            this.totalProcessed++;
            
            // If there's something in the queue, run it
            if (this.queue.length > 0) {
                const next = this.queue.shift();
                next();
            }
        }
    }
    
    getMetrics() {
        return {
            maxConcurrent: this.maxConcurrent,
            currentActive: this.activeRequests,
            queueLength: this.queue.length,
            peakConcurrency: this.peakConcurrency,
            totalEnqueued: this.totalEnqueued,
            totalProcessed: this.totalProcessed,
            averageWaitTime: this.totalProcessed > 0 ? this.waitTime / this.totalProcessed : 0
        };
    }
    
}

// Create a global instance of the concurrency pool
const requestPool = new ConcurrencyPool();

// Function to fetch executions (moved from RoiDataManager)
async function fetchExecutions(jobId, dateRange) {
    const startTime = performance.now();
    log('fetchExecutions:start', { jobId, dateRange });

    if (!rdBase || !projectName) {
        throw new Error('Worker not initialized with required app data: rdBase and projectName are needed');
    }

    let allExecutions = [];
    let offset = 0;
    const MAX_PER_PAGE = 500;
    let hasMore = true;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    let timeout = 3000;
    let totalExecutions = 0;

    while (hasMore) {
        try {
            // Create the URL with parameters
            let params = new URLSearchParams({
                jobIdListFilter: jobId,
                max: MAX_PER_PAGE,
                offset: offset,
                format: 'json'
                // Removed statusFilter to fetch ALL executions
            });
            
            // Use begin/end dates if provided, otherwise fallback to recentFilter
            if (dateRange && dateRange.begin && dateRange.end) {
                // Format dates in ISO format for API
                params.append('begin', dateRange.begin + 'T00:00:00Z');
                params.append('end', dateRange.end + 'T23:59:59Z');
            } else {
                // Default to 10 days if no dateRange specified
                params.append('recentFilter', '10d');
            }
            
            // Use the new API endpoint format
            const url = `${rdBase}api/40/project/${projectName}/executions?${params.toString()}`;
            
            const response = await fetch(url, {
                credentials: 'include',
                headers: {
                    'Accept': 'application/json',
                    'x-rundeck-ajax': 'true'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const responseData = await response.json();
            timeout = 1500;

            const executions = responseData.executions || [];
            allExecutions.push(...executions);
            
            // Store the total count from paging if available
            if (responseData.paging && typeof responseData.paging.total === 'number') {
                totalExecutions = responseData.paging.total;
                log('fetchExecutions:pagingInfo', {
                    jobId,
                    totalExecutions: totalExecutions
                });
            }

            log('fetchExecutions:progress', {
                jobId,
                batchSize: executions.length,
                totalSoFar: allExecutions.length,
                offset
            });

            if (executions.length < MAX_PER_PAGE) {
                hasMore = false;
            } else {
                offset += MAX_PER_PAGE;
            }

            retryCount = 0;

        } catch (error) {
            retryCount++;
            logError('fetchExecutions', error, { jobId, offset, attempt: retryCount });

            if (retryCount >= MAX_RETRIES) {
                hasMore = false;
            } else {
                await new Promise(resolve => setTimeout(resolve, 500 * retryCount));
            }
        }
    }

    const duration = performance.now() - startTime;
    log('fetchExecutions:complete', {
        jobId,
        totalExecutions: allExecutions.length,
        totalFromPaging: totalExecutions,
        duration: `${duration.toFixed(2)}ms`
    });

    // Return both executions and total count
    return { 
        executions: allExecutions, 
        totalExecutions: totalExecutions 
    };
}

// Function to check if job has ROI data (moved from RoiDataManager)
async function checkJobRoiStatus(jobId) {
    log('checkJobRoiStatus:start', { jobId });
    const startTime = performance.now();

    try {
        if (!rdBase || !projectName) {
            throw new Error('Worker not initialized with required app data: rdBase and projectName are needed');
        }
        
        // First fetch an execution
        const params = new URLSearchParams({
            jobIdListFilter: jobId,
            max: 1,
            statusFilter: 'succeeded'  // Keep 'succeeded' here as we need a successful execution to check for ROI metrics
        });
        
        const execUrl = `${rdBase}api/40/project/${projectName}/executions?${params.toString()}`;
        
        const execResponse = await fetch(execUrl, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'x-rundeck-ajax': 'true'
            }
        });

        if (!execResponse.ok) {
            throw new Error(`HTTP error! status: ${execResponse.status}`);
        }

        const execData = await execResponse.json();

        if (!execData.executions?.[0]) {
            log('checkJobRoiStatus:noExecutions', { jobId });
            return { hasRoi: false };
        }

        const execution = execData.executions[0];
        
        // Now check ROI metrics
        const roiResponse = await fetch(`${execution.href}/roimetrics/data`, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'x-rundeck-ajax': 'true'
            }
        });

        if (roiResponse.status === 404) {
            return { hasRoi: false };
        }

        if (!roiResponse.ok) {
            throw new Error(`ROI metrics HTTP error! status: ${roiResponse.status}`);
        }

        const roiData = await roiResponse.json();
        const hasRoi = 'hours' in roiData;

        log('checkJobRoiStatus:complete', {
            jobId,
            hasRoi,
            totalTime: `${(performance.now() - startTime).toFixed(2)}ms`
        });

        return { hasRoi };
    } catch (error) {
        logError('checkJobRoiStatus', error, { jobId });
        return { hasRoi: false, error: error.message };
    }
}

// In roiWorker.js, optimized batch processing with limited concurrency
async function processBatch(batch, jobId) {
    let hasRoiEndpoint = true;
    const results = [];

    log('processBatch', `Processing batch ${batch[0]?.id}-${batch[batch.length-1]?.id}`);

    // First check for 404 with a single request to avoid unnecessary parallel requests
    if (batch.length > 0) {
        try {
            const testResponse = await fetch(`${batch[0].href}/roimetrics/data`, {
                credentials: 'include',
                headers: {
                    'Accept': 'application/json',
                    'x-rundeck-ajax': 'true'
                }
            });

            if (testResponse.status === 404) {
                log('processBatch', 'Stopping batch due to 404 response on first execution');
                hasRoiEndpoint = false;
                return { results, hasRoiEndpoint };
            }
        } catch (error) {
            log('processBatch', `Error checking first execution ${batch[0].id}`, { error: error.message });
        }
    }

    // Process executions with limited concurrency using our pool
    const fetchPromises = batch.map(execution => {
        // Wrap each fetch in a function that the pool can execute
        return requestPool.add(async () => {
            try {
                const response = await fetch(`${execution.href}/roimetrics/data`, {
                    credentials: 'include',
                    headers: {
                        'Accept': 'application/json',
                        'x-rundeck-ajax': 'true'
                    }
                });

                if (response.status === 404) {
                    log('processBatch', `Received 404 for execution ${execution.id}`);
                    hasRoiEndpoint = false;
                    return { execution, data: null, status: 404 };
                }

                if (response.ok) {
                    try {
                        const data = await response.json();
                        return { execution, data, status: 200 };
                    } catch (error) {
                        return {
                            execution, 
                            data: null, 
                            error: `JSON parse error: ${error.message}`,
                            status: 'parse_error'
                        };
                    }
                }

                return { 
                    execution, 
                    data: null, 
                    error: `HTTP error: ${response.status}`,
                    status: response.status 
                };
            } catch (error) {
                return {
                    execution, 
                    data: null, 
                    error: error.message,
                    status: 'network_error'
                };
            }
        });
    });

    // Wait for all fetches to complete - these are already limited by the concurrency pool
    const responses = await Promise.all(fetchPromises);
    
    // Update concurrency metrics
    const poolMetrics = requestPool.getMetrics();
    workerMetrics.concurrency = {
        ...poolMetrics,
        timestamp: Date.now()
    };
    
    log('processBatch:metrics', 'Concurrency pool metrics', { 
        poolMetrics,
        queueLength: requestPool.queue.length,
        activeRequests: requestPool.activeRequests
    });
    
    // Process the results
    for (const response of responses) {
        if (response.status === 404) {
            // We already set hasRoiEndpoint = false above
            // But still add the execution to results with hasRoi: false for caching
            results.push({
                ...response.execution,
                jobId,  // Include jobId in processed execution
                roiHours: 0,
                hasRoi: false
            });
            continue;
        }
        
        if (response.data && 'hours' in response.data) {
            results.push({
                ...response.execution,
                jobId,  // Include jobId in processed execution
                roiHours: parseFloat(response.data.hours),
                hasRoi: true
            });
        } else {
            // Add the execution even without ROI data for caching purposes
            results.push({
                ...response.execution,
                jobId,  // Include jobId in processed execution
                roiHours: 0,
                hasRoi: false
            });
            
            if (response.error) {
                log('processBatch', `Error processing execution ${response.execution.id}`, { error: response.error });
            }
        }
    }

    return { results, hasRoiEndpoint };
}

// Add storage for tracking metrics
const workerMetrics = {
    requestsProcessed: 0,
    executionsProcessed: 0,
    errors: 0,
    totalProcessingTime: 0,
    startTime: Date.now(),
    lastProcessingTime: 0,
    batches: 0,
    cacheHits: 0, 
    lastError: null,
    status: 'idle', // idle, processing, error
    concurrency: {
        maxConcurrent: MAX_CONCURRENT_REQUESTS,
        currentActive: 0,
        peakConcurrency: 0,
        totalEnqueued: 0,
        totalProcessed: 0,
        averageWaitTime: 0
    }
};

// In roiWorker.js
onmessage = async function(e) {
    const { type, data, id } = e.data;

    try {
        // Update startTime if not set
        if (!workerMetrics.startTime) {
            workerMetrics.startTime = Date.now();
        }
        
        switch(type) {
            case 'init':
                // Store app data if provided
                if (data) {
                    if (data.rdBase) {
                        rdBase = data.rdBase;
                    }
                    if (data.projectName) {
                        projectName = data.projectName;
                    }
                }
                
                workerMetrics.status = 'initialized';
                workerMetrics.startTime = Date.now();
                postMessage({ type: 'initialized' });
                break;
                
            case 'getMetrics':
                // New handler for metrics requests
                log('getMetrics', 'Health check received');
                
                // Get the latest concurrency pool metrics
                const poolMetrics = requestPool.getMetrics();
                workerMetrics.concurrency = {
                    ...poolMetrics,
                    timestamp: Date.now()
                };
                
                postMessage({
                    type: 'metrics',
                    requestId: id,
                    data: {
                        status: 'healthy',
                        uptime: Date.now() - workerMetrics.startTime,
                        requestsProcessed: workerMetrics.requestsProcessed,
                        executionsProcessed: workerMetrics.executionsProcessed,
                        errors: workerMetrics.errors,
                        avgProcessingTime: workerMetrics.requestsProcessed > 0 
                            ? workerMetrics.totalProcessingTime / workerMetrics.requestsProcessed
                            : 0,
                        lastProcessingTime: workerMetrics.lastProcessingTime,
                        currentStatus: workerMetrics.status,
                        timestamp: Date.now(),
                        concurrency: workerMetrics.concurrency
                    }
                });
                break;
                
            case 'fetchExecutions':
                // New handler for execution fetching
                workerMetrics.requestsProcessed++;
                const fetchStartTime = performance.now();
                workerMetrics.status = 'processing';
                
                try {
                    const result = await fetchExecutions(data.jobId, data.dateRange);
                    const executions = result.executions;
                    const totalExecutions = result.totalExecutions;
                    
                    const fetchDuration = performance.now() - fetchStartTime;
                    workerMetrics.lastProcessingTime = fetchDuration;
                    workerMetrics.totalProcessingTime += fetchDuration;
                    workerMetrics.status = 'idle';
                    
                    postMessage({
                        type: 'executionsFetched',
                        requestId: id,
                        results: executions,
                        totalExecutions: totalExecutions, // Include the total count in the response
                        summary: {
                            jobId: data.jobId,
                            count: executions.length,
                            totalExecutions: totalExecutions, // Include total in summary as well
                            duration: fetchDuration
                        }
                    });
                } catch (fetchError) {
                    workerMetrics.errors++;
                    workerMetrics.status = 'error';
                    workerMetrics.lastError = {
                        time: Date.now(),
                        message: fetchError.message
                    };
                    
                    logError('fetchExecutions', fetchError);
                    postMessage({
                        type: 'error',
                        requestId: id,
                        error: fetchError.message
                    });
                }
                break;
                
            case 'checkJobRoiStatus':
                // New handler for checking job ROI status
                workerMetrics.requestsProcessed++;
                const checkStartTime = performance.now();
                workerMetrics.status = 'processing';
                
                try {
                    const result = await checkJobRoiStatus(data.jobId);
                    
                    const checkDuration = performance.now() - checkStartTime;
                    workerMetrics.lastProcessingTime = checkDuration;
                    workerMetrics.totalProcessingTime += checkDuration;
                    workerMetrics.status = 'idle';
                    
                    postMessage({
                        type: 'jobRoiStatus',
                        requestId: id,
                        result: result
                    });
                } catch (checkError) {
                    workerMetrics.errors++;
                    workerMetrics.status = 'error';
                    workerMetrics.lastError = {
                        time: Date.now(),
                        message: checkError.message
                    };
                    
                    logError('checkJobRoiStatus', checkError);
                    postMessage({
                        type: 'error',
                        requestId: id,
                        error: checkError.message
                    });
                }
                break;
                
            case 'processExecutions':
                const startTime = performance.now();
                workerMetrics.status = 'processing';
                workerMetrics.requestsProcessed++;
                
                const { executions, jobId, dateRange } = data;

                log('processExecutions', 'Raw executions received', {
                    jobId,
                    totalExecutions: executions.length,
                    firstExecution: executions[0]?.id,
                    lastExecution: executions[executions.length-1]?.id
                });

                // First deduplicate executions
                const uniqueExecutions = Array.from(new Map(
                    executions.map(exec => [exec.id, exec])
                ).values());

                // Add this log
                log('processExecutions', `Starting processing for job ${jobId}`, {
                    executionsCount: uniqueExecutions.length,
                    firstExecution: uniqueExecutions[0]?.id,
                    lastExecution: uniqueExecutions[uniqueExecutions.length-1]?.id
                });

                const processedExecutions = [];
                const BATCH_SIZE = 50;
                let hasRoiEndpoint = true;

                // Process in batches
                for (let i = 0; i < uniqueExecutions.length && hasRoiEndpoint; i += BATCH_SIZE) {
                    const batchStart = i;
                    const batchEnd = Math.min(i + BATCH_SIZE, uniqueExecutions.length);
                    const batch = uniqueExecutions.slice(batchStart, batchEnd);
                    workerMetrics.batches++;

                    log('processExecutions', `Processing batch ${batchStart}-${batchEnd} with parallel requests`);
                    
                    // Use the optimized batch processing function that does parallel requests
                    const batchResult = await processBatch(batch, jobId);
                    
                    // Update hasRoiEndpoint based on batch result
                    hasRoiEndpoint = batchResult.hasRoiEndpoint;
                    
                    // Add batch results to processed executions
                    if (batchResult.results.length > 0) {
                        // Store all executions for proper caching in IndexedDB
                        processedExecutions.push(...batchResult.results);
                        
                        // Count only successful executions for metrics
                        const successfulExecutions = batchResult.results.filter(exec => exec.status === 'succeeded');
                        workerMetrics.executionsProcessed += successfulExecutions.length;
                    }
                    
                    // If we got a 404 response, stop processing
                    if (!hasRoiEndpoint) {
                        log('processExecutions', 'Stopping due to 404 response in batch');
                        break;
                    }

                    // Report progress
                    postMessage({
                        type: 'progress',
                        processed: i + batch.length,
                        total: uniqueExecutions.length,
                        batch: {
                            start: batchStart,
                            end: batchEnd,
                            results: processedExecutions.length,
                            jobId,  // Include jobId in progress updates
                            metrics: {
                                batchTime: performance.now() - startTime,
                                processed: i + batch.length,
                                total: uniqueExecutions.length
                            }
                        }
                    });
                }

                const duration = performance.now() - startTime;
                workerMetrics.lastProcessingTime = duration;
                workerMetrics.totalProcessingTime += duration;
                workerMetrics.status = 'idle';
                
                log('processExecutions', 'Processing complete', {
                    jobId,
                    totalTime: duration,
                    processedCount: processedExecutions.length
                });

                postMessage({
                    type: 'executionsProcessed',
                    requestId: id,
                    results: processedExecutions,
                    summary: {
                        jobId,  // Include jobId in summary
                        total: executions.length,
                        processed: processedExecutions.length,
                        withRoi: processedExecutions.length,
                        withHours: processedExecutions.filter(e => e.roiHours > 0).length,
                        duration
                    }
                });
                break;
                
            default:
                log('unknownMessage', `Received unknown message type: ${type}`);
                postMessage({
                    type: 'error',
                    requestId: id,
                    error: `Unknown message type: ${type}`,
                    metadata: {
                        requestedType: type,
                        timestamp: Date.now()
                    }
                });
        }
    } catch (error) {
        workerMetrics.errors++;
        workerMetrics.status = 'error';
        workerMetrics.lastError = {
            time: Date.now(),
            message: error.message,
            stack: error.stack
        };
        
        logError('operation', error);
        postMessage({
            type: 'error',
            requestId: id,
            error: error.message,
            metadata: {
                timestamp: Date.now()
            }
        });
    }
};