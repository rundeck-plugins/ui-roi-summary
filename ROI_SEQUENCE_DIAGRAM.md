# ROI Summary Plugin Flow

This document provides a sequence diagram and explanation of the data flow in the ROI Summary plugin.

## Sequence Diagram

```mermaid
sequenceDiagram
    participant UI as UI Component
    participant RDM as RoiDataManager
    participant JR as Job Registry
    participant DBW as Database Worker
    participant ROW as ROI Worker
    participant API as RunDeck API
    participant IDB as IndexedDB
    participant LS as LocalStorage

    %% System initialization
    note over RDM: System initialization
    RDM->>DBW: initializeWorker()
    RDM->>ROW: initializeWorker()
    RDM->>LS: getCacheTimestamp()
    LS-->>RDM: cacheTimestamp
    
    alt Cache timestamp > 4 days old
        RDM->>LS: removeItem(initialCacheComplete)
        RDM->>LS: removeItem(cacheTimestamp)
        RDM->>DBW: cleanup()
        DBW->>IDB: Remove stale data
        DBW-->>RDM: cleanupComplete
    end

    UI->>RDM: getJobData(jobIds, dateRange)
    activate RDM
    
    %% Check job registry first
    RDM->>JR: checkJobsInRegistry(jobIds)
    JR-->>RDM: knownJobs, unknownJobs
    
    %% Get data from cache first
    RDM->>DBW: get(jobCache, jobIds)
    activate DBW
    DBW->>IDB: Transaction: read jobCache
    IDB-->>DBW: cachedJobData
    DBW-->>RDM: cachedJobData
    deactivate DBW
    
    RDM->>RDM: filterStaleJobData()
    
    %% For jobs that need fresh data or aren't cached
    loop For each job needing data
        %% Check if job has ROI first
        RDM->>ROW: checkJobRoiStatus(jobId)
        activate ROW
        ROW->>API: GET /api/40/project/{project}/executions
        API-->>ROW: latestExecution
        ROW->>API: GET /execution/{id}/roimetrics/data
        API-->>ROW: roiMetricsStatus
        ROW-->>RDM: hasRoi (boolean)
        deactivate ROW
        
        %% Update job registry
        RDM->>JR: updateJobRegistry(jobId, hasRoi)
        
        alt Job has ROI metrics
            %% Fetch executions
            RDM->>ROW: fetchExecutions(jobId, dateRange)
            activate ROW
            ROW->>API: GET /api/40/project/{project}/executions?jobIdListFilter={jobId}
            API-->>ROW: executionsData, totalCount
            ROW-->>RDM: executionsData, totalCount
            deactivate ROW
            
            %% Process executions to get ROI data
            RDM->>ROW: processExecutions(executionsData, jobId)
            activate ROW
            
            %% Process in batches
            loop For each batch of executions
                ROW->>ROW: processBatch(batch, jobId)
                
                %% Check first execution in batch
                ROW->>API: GET /execution/{id}/roimetrics/data
                API-->>ROW: firstExecutionResult
                
                %% Process remaining executions with concurrency control
                loop For each execution in batch (limited to 10 concurrent)
                    ROW->>API: GET /execution/{id}/roimetrics/data
                    API-->>ROW: roiMetricsData
                    ROW->>ROW: processResult(execution, roiMetricsData)
                end
                
                %% Report batch progress
                ROW-->>RDM: progress(processed, total)
            end
            
            ROW-->>RDM: processedExecutions
            deactivate ROW
            
            %% Cache the processed data
            RDM->>DBW: set(executionCache, processedData)
            activate DBW
            DBW->>IDB: Transaction: write executionCache
            DBW-->>RDM: success
            deactivate DBW
            
            %% Update job data in cache
            RDM->>DBW: set(jobCache, updatedJobData)
            activate DBW
            DBW->>IDB: Transaction: write jobCache
            DBW-->>RDM: success
            deactivate DBW
        else Job has no ROI metrics
            %% Just update job registry and cache
            RDM->>DBW: set(jobCache, {jobId, hasRoi: false})
            activate DBW
            DBW->>IDB: Transaction: write jobCache
            DBW-->>RDM: success
            deactivate DBW
        end
    end
    
    %% Periodically cleanup stale cache entries
    RDM->>DBW: cleanup(maxAge)
    activate DBW
    DBW->>IDB: Transaction: clean jobCache
    DBW->>IDB: Transaction: clean executionCache
    DBW-->>RDM: cleanupResults
    deactivate DBW
    
    RDM-->>UI: compiledJobData
    deactivate RDM
```

## Explanation of Data Flow

1. **System Initialization**:
   - RoiDataManager initializes the Database Worker and ROI Worker
   - Checks localStorage for cache timestamp
   - If timestamp is older than 4 days:
     - Removes localStorage flags (initialCacheComplete, cacheTimestamp)
     - Triggers targeted cleanup of stale data in IndexedDB
   - Restores job registry from IndexedDB if enabled

2. **Initial Request**: The UI Component requests ROI data for specific jobs, optionally with a date range filter.

2. **Job Registry Check**:
   - RoiDataManager first checks the job registry to see which jobs are known to have or not have ROI data
   - This optimizes the process by skipping jobs that don't have ROI metrics

3. **Cache Check**:
   - Database Worker queries IndexedDB for cached job and execution data
   - RoiDataManager filters out stale data based on timestamp and date range

4. **For Each Job Needing Fresh Data**:

   a. **ROI Status Check**:
      - ROI Worker fetches the latest execution for the job
      - Checks if that execution has ROI metrics
      - Updates job registry with ROI status

   b. **If Job Has ROI Metrics**:
      - **Fetch Executions**: ROI Worker gets all executions for the job within the date range
      - **Process Executions**: ROI Worker retrieves ROI metrics for each execution
        - Uses a batch processing approach
        - Employs concurrency control (max 10 concurrent requests)
        - Reports progress to RoiDataManager
      - **Cache Results**: Database Worker stores processed data in IndexedDB

   c. **If Job Has No ROI Metrics**:
      - Simply cache the job status to avoid future processing

5. **Cache Maintenance**:
   - Periodically clean up stale entries from the cache
   - Remove data older than the configured TTL (default 7 days)
   - During system initialization, perform a targeted cleanup of stale data if cache timestamp exceeds 4 days

6. **Return Results**:
   - Compile processed data from cache and fresh fetches
   - Return to UI for display

## Performance Optimizations

- **Job Registry**: Tracks which jobs have ROI data to avoid unnecessary API calls
- **Caching**: Persists data in IndexedDB to minimize server requests
- **Cache Hygiene**: Enforces periodic targeted cleanup of stale data to optimize storage and maintain performance
- **Concurrency Management**: Limits parallel API requests to prevent overwhelming the server
- **Batch Processing**: Processes executions in batches for better performance
- **Web Workers**: Uses separate threads for database and API operations to keep UI responsive