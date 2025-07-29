// dbWorker.js
const DB_CONFIG = {
    name: 'roiCache',
    version: 1,
    stores: {
        jobCache: 'jobCache',
        executionCache: 'executionCache',
    }
};

let db = null;
const activeRequests = new Map();
const DEBUG = false;

function log(component, message, data = {}) {
    if (!DEBUG) return;
    console.log('[DB Worker]', component + ':', {
        timestamp: new Date().toISOString(),
        component,
        message,
        data
    });
}

function logError(component, error, data = {}) {
    console.error('[DB Worker]', component + ':', {
        timestamp: new Date().toISOString(),
        component,
        error: error.message || error,
        data
    });
}

// Global database connection
let dbPromise = null;

// Initialize database - only creates one connection
async function initDb() {
    // Check if DB is already initialized or being initialized
    if (dbPromise) {
        log('initDb', 'Database request already in progress, reusing promise');
        return dbPromise;
    }
    
    if (db) {
        log('initDb', 'Database already initialized, reusing existing connection');
        return Promise.resolve(db);
    }
    
    log('initDb', 'Starting database initialization');

    // Store the promise so multiple callers can await the same initialization
    dbPromise = new Promise((resolve, reject) => {
        try {
            const request = indexedDB.open(DB_CONFIG.name, DB_CONFIG.version);

            request.onerror = (event) => {
                dbPromise = null; // Clear promise on error
                logError('initDb', request.error || new Error('Unknown database error'));
                reject(request.error || new Error('Failed to open database'));
            };

            request.onsuccess = () => {
                db = request.result;
                log('initDb', 'Database initialized successfully', {
                    storeNames: Array.from(db.objectStoreNames)
                });
                dbPromise = null; // Clear promise after successful initialization
                resolve(db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                log('initDb', 'Database upgrade needed, creating stores');

                // Create stores
                if (!db.objectStoreNames.contains(DB_CONFIG.stores.jobCache)) {
                    db.createObjectStore(DB_CONFIG.stores.jobCache, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(DB_CONFIG.stores.executionCache)) {
                    db.createObjectStore(DB_CONFIG.stores.executionCache, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(DB_CONFIG.stores.metrics)) {
                    db.createObjectStore(DB_CONFIG.stores.metrics, { keyPath: 'id' });
                }
            };
        } catch (error) {
            dbPromise = null; // Clear promise on error
            logError('initDb', error);
            reject(error);
        }
    });

    return dbPromise;
}

// DB operations
const get = (store, key, requestId, options = {}) => {
    const startTime = performance.now();
    const { metadataOnly = false } = options;
    
    log('get', `Fetching from ${store}`, { key, requestId, metadataOnly });

    return new Promise((resolve, reject) => {
        try {
            const executeGet = async () => {
                // Make sure we have a DB connection
                if (!db) {
                    try {
                        db = await initDb();
                    } catch (err) {
                        throw new Error('Failed to initialize database: ' + err.message);
                    }
                }
                
                // Create transaction & perform get
                const transaction = db.transaction(store, 'readonly');
                const objectStore = transaction.objectStore(store);
                
                // Validate key first
                if (!key) {
                    throw new Error('Invalid key: ' + key);
                }
                
                const request = objectStore.get(key);
                
                // Store the request so we can abort if needed
                activeRequests.set(requestId, { request, transaction });
                
                // Handle request completion
                request.onsuccess = () => {
                    const duration = performance.now() - startTime;
                    activeRequests.delete(requestId);
                    
                    // Enhanced logging for debugging cache issues
                    const found = request.result !== undefined;
                    
                    // Complex result logging for diagnostic purposes
                    log('get', `Fetch result from ${store}`, {
                        found: found,
                        key: key,
                        store: store,
                        metadataOnly: metadataOnly,
                        valueType: typeof request.result,
                        hasData: found && request.result && typeof request.result.data !== 'undefined',
                        dataType: found && request.result ? typeof request.result.data : 'undefined',
                        isDataArray: found && request.result && request.result.data ? Array.isArray(request.result.data) : false,
                        dataLength: found && request.result && request.result.data && Array.isArray(request.result.data) ? request.result.data.length : 'not an array',
                        timestamp: found && request.result ? request.result.timestamp : undefined,
                        age: found && request.result && request.result.timestamp ? (Date.now() - request.result.timestamp) + ' ms' : 'unknown',
                        // Only log a summary of the result to avoid huge logs
                        resultSummary: found ? {
                            hasId: !!request.result.id,
                            hasTimestamp: !!request.result.timestamp,
                            hasData: !!request.result.data,
                            id: request.result.id
                        } : null
                    });
                    
                    // If metadataOnly is true, create a lightweight result with just the metadata
                    let result = request.result;
                    if (metadataOnly && result) {
                        // Create a lightweight version with just metadata
                        result = {
                            id: result.id,
                            timestamp: result.timestamp,
                            // Include length info but not full data
                            dataInfo: {
                                hasData: !!result.data,
                                length: Array.isArray(result.data) ? result.data.length : null
                            }
                        };
                    }

                    // Send back result
                    postMessage({
                        type: 'result',
                        requestId,
                        result: result,
                        metadata: {
                            duration,
                            timestamp: Date.now(),
                            store,
                            key,
                            found: !!request.result,
                            metadataOnly
                        }
                    });

                    resolve();
                };

                request.onerror = () => {
                    activeRequests.delete(requestId);
                    logError('get', request.error, { store, key, requestId });
                    reject(request.error);
                };
                
                // Handle transaction errors
                transaction.onerror = (event) => {
                    activeRequests.delete(requestId);
                    logError('get:transaction', transaction.error || new Error('Transaction error'), { 
                        store, key, requestId 
                    });
                };
                
                // Additional timeout safety - our own timeout outside of the IndexedDB
                setTimeout(() => {
                    if (activeRequests.has(requestId)) {
                        const message = `Get request timeout for ${key} in ${store}`;
                        logError('get:timeout', new Error(message), { requestId, elapsed: performance.now() - startTime });
                    }
                }, 5000);
            };
            
            // Execute the get operation, handling errors
            executeGet().catch(error => {
                activeRequests.delete(requestId);
                logError('get', error, { store, key, requestId });
                reject(error);
            });
            
        } catch (error) {
            // Immediate try/catch for synchronous errors
            activeRequests.delete(requestId);
            logError('get', error, { store, key, requestId });
            reject(error);
        }
    });
};

async function set(store, value) {
    // Make sure timestamp is included - add one if not present
    if (value && !value.timestamp) {
        value.timestamp = Date.now();
    }
    
    // Check if data is an array when it should be
    if (value && value.data && store === 'executionCache' && !Array.isArray(value.data)) {
        log('set', `Converting non-array data to array for ${store}`, {
            id: value.id,
            dataType: typeof value.data
        });
        // Convert to array if it's not
        value.data = [value.data];
    }
    
    // Detailed logging
    log('set', `Writing to ${store}`, {
        valueType: typeof value,
        dataLength: Array.isArray(value?.data) ? value.data.length : 'not an array',
        // Only log summary of value to avoid huge logs
        valueSummary: {
            hasId: !!value?.id,
            id: value?.id,
            valueType: typeof value,
            dataType: value?.data ? typeof value.data : 'undefined',
            isDataArray: Array.isArray(value?.data),
            hasTimestamp: !!value?.timestamp,
            timestamp: value?.timestamp,
            // Additional properties
            hasTotalExecutions: 'totalExecutions' in value,
            totalExecutionsType: typeof value.totalExecutions,
            totalExecutionsValue: value.totalExecutions,
            allProperties: Object.keys(value)
        }
    });

    return new Promise(async (resolve, reject) => {
        try {
            // Make sure DB is initialized
            if (!db) {
                try {
                    db = await initDb();
                } catch (initError) {
                    reject(new Error('Failed to initialize database: ' + initError.message));
                    return;
                }
            }
            
            // Ensure data is well-formed
            if (!value || !value.id) {
                reject(new Error('Invalid value: missing id'));
                return;
            }
            
            // Create a copy of the value to ensure we don't modify the original
            const valueToStore = JSON.parse(JSON.stringify(value));
            
            // Explicitly preserve the totalExecutions property if it exists
            if (typeof value.totalExecutions === 'number') {
                valueToStore.totalExecutions = value.totalExecutions;
            }
            
            // Create transaction
            const tx = db.transaction([store], 'readwrite');
            const objectStore = tx.objectStore(store);
            const request = objectStore.put(valueToStore);

            request.onsuccess = () => {
                // Enhanced success logging for debugging
                log('set', 'Completed write to ' + store, { 
                    id: valueToStore.id,
                    store: store,
                    success: true,
                    hasTotalExecutions: 'totalExecutions' in valueToStore,
                    totalExecutionsValue: valueToStore.totalExecutions,
                    allProps: Object.keys(valueToStore)
                });
                resolve(request.result);
            };

            request.onerror = () => {
                logError('set', request.error, { 
                    id: valueToStore.id, 
                    store: store,
                    error: request.error?.message || 'Unknown error'
                });
                reject(request.error);
            };
            
            // Handle transaction errors
            tx.onerror = (event) => {
                logError('set:transaction', tx.error, {
                    id: valueToStore.id,
                    store: store,
                    error: tx.error?.message || 'Unknown transaction error'
                });
            };
            
            // Additional timeout safety
            setTimeout(() => {
                if (!request.readyState || request.readyState === 'pending') {
                    logError('set:timeout', new Error(`Set operation timeout for ${valueToStore.id} in ${store}`), {
                        id: valueToStore.id,
                        store: store
                    });
                }
            }, 5000);
        } catch (error) {
            logError('set', error, { 
                store: store, 
                valueId: value?.id || 'unknown' 
            });
            reject(error);
        }
    });
}

// Add a diagnostic function to list store contents
async function listStoreContents(storeName) {
    log('listStoreContents', `Getting all items from ${storeName}`);

    try {
        if (!db) {
            db = await initDb();
        }
        
        const tx = db.transaction([storeName], 'readonly');
        const objectStore = tx.objectStore(storeName);
        const request = objectStore.getAll();
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                const items = request.result;
                log('listStoreContents', `Found ${items.length} items in ${storeName}`, {
                    count: items.length,
                    items: items.map(item => ({
                        id: item.id,
                        hasTimestamp: !!item.timestamp,
                        timestamp: item.timestamp,
                        hasData: !!item.data,
                        dataType: item.data ? (Array.isArray(item.data) ? 'array' : typeof item.data) : 'none'
                    }))
                });
                resolve(items);
            };
            
            request.onerror = () => {
                logError('listStoreContents', request.error, { storeName });
                reject(request.error);
            };
        });
    } catch (error) {
        logError('listStoreContents', error, { storeName });
        throw error;
    }
}

// Message handler
onmessage = async function(e) {
    const { type, data, id } = e.data;
    const startTime = performance.now();

    try {
        switch(type) {
            case 'init':
                await initDb();
                postMessage({ type: 'initialized' });
                break;
                
            case 'listStoreContents': 
                // Handle diagnostic request to list all contents in a store
                try {
                    const items = await listStoreContents(data.store);
                    postMessage({
                        type: 'result',
                        requestId: id,
                        result: items
                    });
                } catch (error) {
                    postMessage({
                        type: 'error',
                        requestId: id,
                        error: `Failed to list store contents: ${error.message}`
                    });
                }
                break;

            case 'get':
                // Handle GET requests
                if (!data.key) {
                    postMessage({
                        type: 'error',
                        requestId: id,
                        error: 'Invalid key'
                    });
                    return;
                }
                // Pass metadataOnly option if present
                await get(data.store, data.key, id, {
                    metadataOnly: data.metadataOnly || false
                });
                break;

            case 'set':
                // Handle SET requests - these should complete regardless
                await set(data.store, data.value);
                postMessage({
                    type: 'result',
                    requestId: id,
                    result: true
                });
                break;

            case 'cancel':
                // New case to handle request cancellation
                if (activeRequests.has(data.requestId)) {
                    const { transaction } = activeRequests.get(data.requestId);
                    try {
                        transaction.abort();
                    } catch (error) {
                        // Ignore abort errors
                    }
                    activeRequests.delete(data.requestId);
                    log('cancel', `Cancelled request ${data.requestId}`);
                }
                break;
                
            case 'healthCheck':
                // Health check - verify DB connection
                try {
                    if (!db) {
                        db = await initDb();
                    }
                    
                    // Attempt a simple read operation
                    const testTx = db.transaction(['metrics'], 'readonly');
                    const objectStore = testTx.objectStore('metrics');
                    
                    // Successful response
                    postMessage({
                        type: 'result',
                        requestId: id,
                        result: {
                            status: 'healthy',
                            stores: Object.keys(DB_CONFIG.stores),
                            dbName: DB_CONFIG.name,
                            activeRequests: activeRequests.size,
                            timestamp: Date.now(),
                            responseTime: performance.now() - startTime
                        }
                    });
                } catch (healthError) {
                    // DB error
                    postMessage({
                        type: 'result',
                        requestId: id,
                        result: {
                            status: 'unhealthy',
                            error: healthError.message,
                            timestamp: Date.now()
                        }
                    });
                }
                break;
                
            case 'cleanup':
                // Implement cleanup operation
                try {
                    // Get max age limit (ms)
                    const maxAge = data.maxAge || (24 * 60 * 60 * 1000); // Default 24h
                    const cutoff = Date.now() - maxAge;
                    
                    if (!db) {
                        db = await initDb();
                    }
                    
                    // Track deletion counts
                    let deletedJobs = 0;
                    let deletedExecs = 0;
                    
                    log('cleanup', `Running cleanup with cutoff date: ${new Date(cutoff).toISOString()}`);
                    
                    // For job cache - no need to be sophisticated, just use the cutoff
                    try {
                        const jobTx = db.transaction(['jobCache'], 'readwrite');
                        const jobStore = jobTx.objectStore('jobCache');
                        
                        // Get all jobs first to analyze
                        const allJobs = await new Promise((resolve, reject) => {
                            const getAllRequest = jobStore.getAll();
                            getAllRequest.onsuccess = () => resolve(getAllRequest.result);
                            getAllRequest.onerror = reject;
                        });
                        
                        // Find obsolete job entries by looking at timestamps
                        const jobsToDelete = [];
                        for (const job of allJobs) {
                            if (job.timestamp < cutoff) {
                                jobsToDelete.push(job.id);
                            }
                        }
                        
                        // Delete the obsolete entries
                        if (jobsToDelete.length > 0) {
                            await Promise.all(jobsToDelete.map(jobId => {
                                return new Promise((resolve, reject) => {
                                    const deleteRequest = jobStore.delete(jobId);
                                    deleteRequest.onsuccess = resolve;
                                    deleteRequest.onerror = reject;
                                });
                            }));
                            
                            deletedJobs = jobsToDelete.length;
                        }
                        
                        log('cleanup', `Deleted ${deletedJobs} expired job cache entries out of ${allJobs.length} total`);
                    } catch (jobError) {
                        log('cleanup', `Error cleaning job cache: ${jobError.message}`);
                    }
                    
                    // For execution cache - we need to filter individual executions inside each cache entry
                    try {
                        const execTx = db.transaction(['executionCache'], 'readwrite');
                        const execStore = execTx.objectStore('executionCache');
                        
                        // Get all executions first to analyze
                        const allExecutions = await new Promise((resolve, reject) => {
                            const getAllRequest = execStore.getAll();
                            getAllRequest.onsuccess = () => resolve(getAllRequest.result);
                            getAllRequest.onerror = reject;
                        });
                        
                        const now = new Date();
                        const cutoffDate = new Date(now.getTime() - maxAge);
                        
                        log('cleanup', `Using cutoff date: ${cutoffDate.toISOString()} for filtering executions`);
                        
                        let totalExecutionsBefore = 0;
                        let totalExecutionsAfter = 0;
                        let entriesModified = 0;
                        let entriesDeleted = 0;
                        
                        // For each cache entry, filter the inner executions
                        for (let i = 0; i < allExecutions.length; i++) {
                            const cacheEntry = allExecutions[i];
                            
                            // Skip if no data array
                            if (!cacheEntry.data || !Array.isArray(cacheEntry.data)) {
                                continue;
                            }
                            
                            totalExecutionsBefore += cacheEntry.data.length;
                            const originalLength = cacheEntry.data.length;
                            
                            // Log sample of executions for debugging
                            if (cacheEntry.data.length > 0) {
                                const sampleExec = cacheEntry.data[0];
                                log('cleanupDebug', `Sample execution from entry ${cacheEntry.id}`, {
                                    id: sampleExec.id,
                                    dateStarted: sampleExec['date-started'],
                                    dateStartedRaw: JSON.stringify(sampleExec['date-started'])
                                });
                            }
                            
                            // Filter out executions older than our cutoff date
                            const filtered = cacheEntry.data.filter(execution => {
                                let execDate;
                                
                                // Handle different date formats
                                if (execution['date-started'] && execution['date-started'].date) {
                                    // Handle object with date property
                                    execDate = new Date(execution['date-started'].date);
                                } else if (execution.dateStarted) {
                                    // Handle direct dateStarted string
                                    execDate = new Date(execution.dateStarted);
                                } else {
                                    // No valid date, keep the execution
                                    return true;
                                }
                                
                                // Keep if execution date is >= cutoff date
                                // This mirrors the logic in roiDataManagement.js filterExecutionsByDateRange
                                const executionDate = new Date(execDate);
                                return executionDate >= cutoffDate;
                            });
                            
                            const removedCount = originalLength - filtered.length;
                            
                            // If we filtered any executions, update the cache entry
                            if (removedCount > 0) {
                                entriesModified++;
                                
                                log('cleanup', `Filtered executions in cache entry ${cacheEntry.id}`, {
                                    before: originalLength,
                                    after: filtered.length,
                                    removed: removedCount
                                });
                                
                                if (filtered.length > 0) {
                                    // Update the cache entry with filtered data
                                    cacheEntry.data = filtered;
                                    totalExecutionsAfter += filtered.length;
                                    
                                    // Find the min and max dates in the remaining data
                                    let oldestDate = null;
                                    let newestDate = null;
                                    
                                    for (const exec of filtered) {
                                        let execDate;
                                        if (exec['date-started'] && exec['date-started'].date) {
                                            execDate = new Date(exec['date-started'].date);
                                        } else if (exec.dateStarted) {
                                            execDate = new Date(exec.dateStarted);
                                        } else {
                                            continue;
                                        }
                                        
                                        if (!oldestDate || execDate < oldestDate) oldestDate = execDate;
                                        if (!newestDate || execDate > newestDate) newestDate = execDate;
                                    }
                                    
                                    // Update the date range
                                    if (oldestDate && newestDate) {
                                        cacheEntry.dateRange = {
                                            begin: oldestDate.toISOString().split('T')[0],
                                            end: newestDate.toISOString().split('T')[0]
                                        };
                                    }
                                    
                                    // Save the updated entry
                                    await new Promise((resolve, reject) => {
                                        const putRequest = execStore.put(cacheEntry);
                                        putRequest.onsuccess = resolve;
                                        putRequest.onerror = reject;
                                    });
                                    
                                    log('cleanup', `Updated cache entry ${cacheEntry.id} with filtered executions`, {
                                        newDataLength: filtered.length,
                                        newDateRange: cacheEntry.dateRange
                                    });
                                } else {
                                    // All executions were removed, delete the entry
                                    await new Promise((resolve, reject) => {
                                        const deleteRequest = execStore.delete(cacheEntry.id);
                                        deleteRequest.onsuccess = resolve;
                                        deleteRequest.onerror = reject;
                                    });
                                    
                                    entriesDeleted++;
                                    log('cleanup', `Deleted empty cache entry ${cacheEntry.id}`);
                                }
                            } else {
                                // No executions were filtered out
                                totalExecutionsAfter += cacheEntry.data.length;
                            }
                        }
                        
                        deletedExecs = entriesDeleted;
                        
                        log('cleanup', `Execution data cleanup summary:`, {
                            executionsBefore: totalExecutionsBefore,
                            executionsAfter: totalExecutionsAfter,
                            executionsRemoved: totalExecutionsBefore - totalExecutionsAfter,
                            entriesModified: entriesModified,
                            entriesDeleted: entriesDeleted
                        });
                        
                        log('cleanup', `Deleted ${deletedExecs} expired execution cache entries out of ${allExecutions.length} total`);
                    } catch (execError) {
                        log('cleanup', `Error cleaning execution cache: ${execError.message}`, execError);
                    }
                    
                    // Success response
                    postMessage({
                        type: 'result',
                        requestId: id,
                        result: {
                            status: 'success',
                            cutoffDate: new Date(cutoff).toISOString(),
                            deletedJobs,
                            deletedExecs,
                            timestamp: Date.now()
                        }
                    });
                } catch (cleanupError) {
                    postMessage({
                        type: 'error',
                        requestId: id,
                        error: `Cleanup failed: ${cleanupError.message}`
                    });
                }
                break;

            default:
                throw new Error(`Unknown operation type: ${type}`);
        }
    } catch (error) {
        postMessage({
            type: 'error',
            requestId: id,
            error: error.message
        });
    }
};

