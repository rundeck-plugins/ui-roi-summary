var DEBUG = false;
//= require ./lib/support
//= require ./lib/roiDataManagement

// Logging configuration
const LOG_COLORS = {
  general: '#0066cc',    // Blue - UI/View operations
  cache: '#6b46c1',      // Purple - Chart operations
  network: '#22c55e',    // Green - ROI calculations
  process: '#f97316',    // Orange - Data processing
  error: '#dc2626'       // Red - Error handling
};

function getLogStyles(type) {
  return [
    `background: ${LOG_COLORS[type]}; color: white; padding: 2px 5px; border-radius: 3px;`,
    'color: inherit'
  ];
}

function log(component, method, msg, type = 'general') {
  if (DEBUG) console.log(`%c${component}%c: ${method}`, ...getLogStyles(type), msg);
}

function logGroup(component, method, details, type = 'general') {
  if (DEBUG) {
    console.groupCollapsed(`%c${component}%c: ${method}`, ...getLogStyles(type));
    Object.entries(details).forEach(([key, value]) => {
      console.log(`${key}:`, value);
    });
    console.groupEnd();
  }
}

function logError(component, method, error) {
  if (DEBUG) {
    console.group(`%c${component}%c: ${method} ERROR`, ...getLogStyles('error'));
    console.error(error);
    console.groupEnd();
  }
}

// Performance tracking
const metrics = {
  jobsLoaded: 0,
  roiCalculations: 0,
  chartUpdates: 0,
  lastUpdate: Date.now()
};

const roiManager = new RoiDataManager(window._rundeck.projectName);
log('RoiSummary', 'init', `Initializing with project: ${window._rundeck.projectName}`);



function getChartThemeColors() {
  const isDarkMode = document.documentElement.getAttribute('data-color-theme') === 'dark';
  log('RoiSummary', 'getChartThemeColors', `Theme: ${isDarkMode ? 'dark' : 'light'}`, 'cache');

  return {
    textColor: isDarkMode ? '#ffffff' : '#666666',
    gridColor: isDarkMode ? 'rgba(160, 160, 160, 0.1)' : 'rgba(0, 0, 0, 0.1)',
    borderColor: isDarkMode ? 'rgba(160, 160, 160, 0.2)' : 'rgba(0, 0, 0, 0.2)'
  };
}

function initRoiSummary() {
  log('RoiSummary', 'initRoiSummary', 'Starting initialization');
  let rundeckPage = window.rundeckPage;
  if(!window.rundeckPage) {
    rundeckPage = new RundeckPage(loadJsonData('uipluginData'));
  }

  const currentUi = !!document.querySelector('.ui-type-current');
  logGroup('RoiSummary', 'initRoiSummary', {
    currentUi,
    project: window._rundeck.projectName,
    path: rundeckPage.path()
  });

  if(currentUi) {
    log('RoiSummary', 'initRoiSummary', 'Initializing ROI Metrics');
    var jobListSupport = new JobListSupport();
    jQuery(function() {
      var project = window._rundeck.projectName;
      var pagePath = rundeckPage.path();
      var joblistroiview;
      var jobRoiView;
      var pluginName = RDPRO['ui-roisummary'].name;
      var pluginBase = rundeckPage.pluginBaseUrl(pluginName);
      var _ticker = ko.observable();

      logGroup('RoiSummary', 'jQuery.ready', {
        project,
        pagePath,
        pluginName,
        pluginBase
      });

      if (typeof moment != 'undefined') {
        _ticker(moment());
        setInterval(function() {
          _ticker(moment());
        }, 1000);
      }

      function ListJobExec(data) {
        log('ListJobExec', 'constructor', `Creating execution ${data.id || data.executionId}`);
        var self = this;
        self.id = ko.observable(data.id || data.executionId);
        self.jobId = ko.observable(data.jobId);
        self.status = ko.observable(data.status);
      }

      function GraphOptions(data) {
        log('GraphOptions', 'constructor', 'Initializing graph options');
        var self = this;

        // Get saved date range from localStorage
        const savedQueryMax = localStorage.getItem('rundeck.plugin.roisummary.queryMax');
        self.queryMax = ko.observable(savedQueryMax ? parseInt(savedQueryMax) : (data.queryMax || 5));
        
        self.queryMax.subscribe(function(newValue) {
          const days = parseInt(newValue);
          if (isNaN(days) || days < 1) {
            log('GraphOptions', 'queryMax.subscribe', 'Invalid days value', 'error');
            self.queryMax(5);
            localStorage.setItem('rundeck.plugin.roisummary.queryMax', 5);
            return;
          }
          if (days !== parseFloat(newValue)) {
            log('GraphOptions', 'queryMax.subscribe', 'Rounding days value', 'process');
            self.queryMax(days);
            localStorage.setItem('rundeck.plugin.roisummary.queryMax', days);
            return;
          }
          log('GraphOptions', 'queryMax.subscribe', `Updated to ${days}`, 'process');
          localStorage.setItem('rundeck.plugin.roisummary.queryMax', days);
        });

        const savedRate = localStorage.getItem('rundeck.plugin.roisummary.hourlyCost');
        self.hourlyCost = ko.observable(savedRate ? parseFloat(savedRate) : data.hourlyCost || 100);

        self.hourlyCost.subscribe(function(newValue) {
          const rate = parseFloat(newValue);
          if (isNaN(rate) || rate < 0) {
            log('GraphOptions', 'hourlyCost.subscribe', 'Invalid rate', 'error');
            self.hourlyCost(100);
            localStorage.setItem('rundeck.plugin.roisummary.hourlyCost', 100);
          } else {
            log('GraphOptions', 'hourlyCost.subscribe', `Updated to ${rate}`, 'process');
            localStorage.setItem('rundeck.plugin.roisummary.hourlyCost', rate);
          }
        });

        self.showNoRoi = ko.observable(false);

        const savedShowNoRoi = localStorage.getItem('rundeck.plugin.roisummary.showNoRoi');
        if (savedShowNoRoi !== null) {
          self.showNoRoi(savedShowNoRoi === 'true');
        }

        self.showNoRoi.subscribe(function(newValue) {
          log('GraphOptions', 'showNoRoi.subscribe', `Updated to ${newValue}`, 'process');
          localStorage.setItem('rundeck.plugin.roisummary.showNoRoi', newValue);
        });

        logGroup('GraphOptions', 'constructor:complete', {
          queryMax: self.queryMax(),
          hourlyCost: self.hourlyCost(),
          showNoRoi: self.showNoRoi()
        });
      }
      function JobRoiListView() {
        log('JobRoiListView', 'constructor', 'Initializing view');
        var self = this;

        self.getMessage = function(key) {
          return jobListSupport.i18Message(pluginName, key);
        };

        self.project = ko.observable(window._rundeck.projectName || jQuery('#projectSelect').val());
        self.jobs = ko.observableArray([]);
        self.loading = ko.observable(false);
        self.jobmap = {};
        self.executionsShowRecent = ko.observable(true);
        self.graphShowHelpText = ko.observable(false);
        self.sortField = ko.observable('name');
        self.sortDirection = ko.observable('asc');

        logGroup('JobRoiListView', 'initialization', {
          project: self.project(),
          sortField: self.sortField(),
          sortDirection: self.sortDirection()
        });

        self.sortedJobs = ko.computed(function() {
          log('JobRoiListView', 'sortedJobs', 'Computing sorted jobs', 'process');
          var jobs = self.jobs().filter(function(job) {
            return job.hasRoiData() || self.graphOptions().showNoRoi();
          });

          var field = self.sortField();
          var direction = self.sortDirection();

          var sorted = jobs.sort(function(a, b) {
            var aValue, bValue;
            switch (field) {
              case 'name':
                aValue = a.name().toLowerCase();
                bValue = b.name().toLowerCase();
                break;
              case 'group':
                aValue = a.group().toLowerCase();
                bValue = b.group().toLowerCase();
                break;
              case 'executions':
                aValue = a.total() || 0;
                bValue = b.total() || 0;
                break;
              case 'avgHours':
                aValue = a.jobRoiPerUnitTotal() || 0;
                bValue = b.jobRoiPerUnitTotal() || 0;
                break;
              case 'totalHours':
                aValue = parseFloat(a.jobRoiTotal()) || 0;
                bValue = parseFloat(b.jobRoiTotal()) || 0;
                break;
              case 'value':
                aValue = parseFloat(a.roiCalculation().replace(/[^0-9.-]+/g, '')) || 0;
                bValue = parseFloat(b.roiCalculation().replace(/[^0-9.-]+/g, '')) || 0;
                break;
              default:
                return 0;
            }

            if (direction === 'asc') {
              return aValue > bValue ? 1 : -1;
            } else {
              return aValue < bValue ? 1 : -1;
            }
          });

          logGroup('JobRoiListView', 'sortedJobs:result', {
            totalJobs: jobs.length,
            sortedJobs: sorted.length,
            field,
            direction
          }, 'process');

          return sorted;
        });

        self.summaryMetrics = ko.computed(function() {
          log('JobRoiListView', 'summaryMetrics', 'Computing metrics', 'process');
          var jobs = self.sortedJobs();

          if (jobs.length === 0) {
            log('JobRoiListView', 'summaryMetrics', 'No jobs available');
            return null;
          }

          var metrics = {
            totalHoursSaved: jobs.reduce(
                (sum, job) => sum + parseFloat(job.jobRoiTotal() || 0),
                0
            ),
            totalValue: jobs.reduce((sum, job) => {
              const value = parseFloat(job.roiCalculation().replace(/[^0-9.-]+/g, '')) || 0;
              return sum + value;
            }, 0),
            jobsWithRoi: jobs.filter(j => j.hasRoiData()).length,
            avgRoiPerExecution: jobs.reduce((sum, job) => sum + (job.jobRoiPerUnitTotal() || 0), 0) /
                jobs.filter(j => j.hasRoiData()).length || 0
          };

          logGroup('JobRoiListView', 'summaryMetrics:result', metrics, 'process');
          return metrics;
        });
        const defaultHourlyCost = pluginName.config?.defaultHourlyCost || 100;
        self.graphOptions = ko.observable(
            new GraphOptions({
              queryMax: 5,
              hourlyCost: defaultHourlyCost
            })
        );

        self.graphOptions().queryMax.subscribe(function(newValue) {
          log('JobRoiListView', 'queryMax.changed', `New value: ${newValue}`, 'process');
          
          // Disable flag in localStorage when queryMax changes
          try {
            localStorage.setItem(roiManager.LS_KEY_INITIAL_CACHE_COMPLETE, 'false');
            log('JobRoiListView', 'queryMax.changed', 'Disabled initial cache complete flag', 'process');
          } catch (e) {
            logError('JobRoiListView', 'Failed to update localStorage', e);
          }
          
          self.refreshExecData();
        });

        self.graphOptions().hourlyCost.subscribe(function(newValue) {
          log('JobRoiListView', 'hourlyCost.changed', `New value: ${newValue}`, 'process');
          self.refreshExecData();
        });


        self.throttledUpdate = ko.computed(function() {
          return self.jobs();
        }).extend({ rateLimit: 250 });

        self.updateJobsDisplay = function() {
          // This will trigger the computed observables (sortedJobs and summaryMetrics)
          self.jobs.valueHasMutated();

          logGroup('JobRoiListView', 'updateJobsDisplay', {
            totalJobs: self.jobs().length,
            visibleJobs: self.sortedJobs().length,
            timestamp: new Date().toISOString()
          });
        };

        self.refreshExecData = async function() {
          if (self.loading()) {
            log('JobRoiListView', 'refreshExecData', 'Already refreshing, skipping...', 'process');
            return;
          }

          log('JobRoiListView', 'refreshExecData', 'Starting refresh', 'process');
          self.loading(true);
          const startTime = performance.now();
          const BATCH_SIZE = 10;
          const jobs = self.jobs();
          const jobIds = jobs.map(job => job.id);

          logGroup('JobRoiListView', 'refreshExecData:starting', {
            totalJobs: jobIds.length,
            batchSize: BATCH_SIZE,
            timestamp: new Date().toISOString()
          });

          try {
            // Process in batches
            for (let i = 0; i < jobIds.length; i += BATCH_SIZE) {
              const batchStart = performance.now();
              const batchJobIds = jobIds.slice(i, i + BATCH_SIZE);

              logGroup('JobRoiListView', 'processingBatch', {
                batchNumber: Math.floor(i / BATCH_SIZE) + 1,
                size: batchJobIds.length,
                processedSoFar: i,
                remaining: jobIds.length - i
              });

              // Process batch in parallel
              const batchPromises = batchJobIds.map(async jobId => {
                const job = jobs.find(j => j.id === jobId);
                if (!job) return null;

                try {
                  const hasRoi = await roiManager.checkJobRoiStatus(jobId);
                  if (!hasRoi) {
                    job.hasRoiData(false);
                    job.total(0);
                    
                    // Create an empty cache entry for this job even though it has no ROI metrics
                    // This ensures we track that we've processed this job in the executionsCache table
                    const dateRange = {
                      begin: moment()
                          .startOf('day')
                          .subtract(self.graphOptions().queryMax(), 'days')
                          .format('YYYY-MM-DD'),
                      end: moment().endOf('day').format('YYYY-MM-DD')
                    };
                    const cacheKey = roiManager.getCacheKey(jobId, dateRange);
                    roiManager.dbRequest('set', {
                      store: 'executionCache',
                      value: {
                        id: cacheKey,
                        data: [],
                        timestamp: Date.now(),
                        dateRange: dateRange,
                        jobId: jobId,
                        hasRoi: false
                      }
                    }).catch(error => console.error('Failed to cache empty execution data', error));
                    
                    return { jobId, hasRoi: false };
                  }

                  const dateRange = {
                    begin: moment()
                        .startOf('day')
                        .subtract(self.graphOptions().queryMax(), 'days')
                        .format('YYYY-MM-DD'),
                    end: moment().endOf('day').format('YYYY-MM-DD')
                  };

                  const executionsResult = await roiManager.getExecutionsWithRoi([jobId], dateRange);
                  let jobExecutions = [];
                  
                  // Handle both map and array formats
                  if (executionsResult instanceof Map) {
                    // Handle Map format (expected from roiDataManager.getExecutionsWithRoi)
                    jobExecutions = executionsResult.get(jobId) || [];
                  } else if (Array.isArray(executionsResult)) {
                    // Handle Array format (legacy or direct array return)
                    jobExecutions = executionsResult;
                  }

                  if (jobExecutions.length > 0) {
                    job.processExecutions(jobExecutions);
                    return {
                      jobId,
                      hasRoi: true,
                      executionsCount: jobExecutions.length
                    };
                  } else {
                    job.jobRoiPerUnitTotal(0);
                    job.hasRoiData(false);
                    job.total(0);
                    
                    // Create an empty cache entry for this job even though it has no executions or ROI metrics
                    // This ensures we track that we've processed this job in the executionsCache table
                    const cacheKey = roiManager.getCacheKey(jobId, dateRange);
                    roiManager.dbRequest('set', {
                      store: 'executionCache',
                      value: {
                        id: cacheKey,
                        data: [],
                        timestamp: Date.now(),
                        dateRange: dateRange,
                        jobId: jobId,
                        hasRoi: false
                      }
                    }).catch(error => console.error('Failed to cache empty execution data', error));
                    
                    return {
                      jobId,
                      hasRoi: false,
                      executionsCount: 0
                    };
                  }
                } catch (error) {
                  logError('JobRoiListView', 'jobProcessing', {
                    jobId,
                    error: error.message || error
                  });
                  return {
                    jobId,
                    error: true,
                    errorMessage: error.message || 'Unknown error'
                  };
                }
              });

              // Wait for all jobs in batch to complete
              const results = await Promise.all(batchPromises);

              // Update UI using our new method
              self.updateJobsDisplay();

              logGroup('JobRoiListView', 'batchComplete', {
                batchNumber: Math.floor(i / BATCH_SIZE) + 1,
                processedJobs: i + batchJobIds.length,
                totalJobs: jobIds.length,
                batchTime: `${(performance.now() - batchStart).toFixed(2)}ms`,
                successfulResults: results.filter(r => r && !r.error).length,
                failedResults: results.filter(r => r && r.error).length,
                jobsWithRoi: results.filter(r => r && r.hasRoi).length
              });

              // Small delay between batches to allow UI to breathe
              await new Promise(resolve => setTimeout(resolve, 50));
            }

          } catch (error) {
            logError('JobRoiListView', 'refreshExecData', error);
          } finally {
            self.loading(false);

            // Set the initial cache complete flag back to true after fetching data
            try {
              roiManager.setInitialCacheComplete();
              log('JobRoiListView', 'refreshComplete', 'Enabled initial cache complete flag', 'process');
            } catch (e) {
              logError('JobRoiListView', 'Failed to update localStorage', e);
            }

            logGroup('JobRoiListView', 'refreshComplete', {
              totalTime: `${(performance.now() - startTime).toFixed(2)}ms`,
              totalJobs: jobIds.length,
              timestamp: new Date().toISOString()
            });
            
            // Dispatch event so other plugins know that data loading is complete
            jQuery(document).trigger(
              jQuery.Event('rundeck:plugin:ui-roisummary:data-loaded:joblist', {
                relatedTarget: self,
                viewType: 'joblist',
                timestamp: Date.now(),
                metrics: {
                  jobsProcessed: jobIds.length,
                  processingTime: (performance.now() - startTime)
                }
              })
            );
          }
        };

        self.loadJobs = function() {
          log('JobRoiListView', 'loadJobs', 'Starting job load');
          const startTime = performance.now();

          var foundJobs = jQuery('.jobname[data-job-id]');
          log('JobRoiListView', 'loadJobs', `Found ${foundJobs.length} jobs in DOM`);

          var jobsarr = [];
          foundJobs.each(function(idx, el) {
            var jel = jQuery(el);
            var jobData = {
              id: jel.data('jobId'),
              name: jel.data('jobName'),
              group: jel.data('jobGroup'),
              project: window._rundeck.projectName,
              graphOptions: self.graphOptions,
              hasRoiData: false,
              jobRoiPerUnitTotal: ko.observable(0.0),
              roiDescription: 'Hours saved'
            };

            logGroup('JobRoiListView', 'loadJobs:processing', {
              jobId: jobData.id,
              name: jobData.name,
              group: jobData.group
            }, 'process');

            var job = new ListJob(jobData);
            jobsarr.push(job);
            self.jobmap[job.id] = job;
          });

          self.jobs(jobsarr);

          logGroup('JobRoiListView', 'loadJobs:complete', {
            jobsLoaded: jobsarr.length,
            duration: `${(performance.now() - startTime).toFixed(2)}ms`
          }, 'process');
        };
        self.loadShowPageSingleJob = function() {
          log('JobRoiListView', 'loadShowPageSingleJob', 'Loading single job');
          const startTime = performance.now();

          var jobDetail = loadJsonData('jobDetail');
          logGroup('JobRoiListView', 'loadShowPageSingleJob:detail', {
            id: jobDetail.id,
            name: jobDetail.name,
            group: jobDetail.group
          });

          var job = new ListJob({
            id: jobDetail.id,
            name: jobDetail.name,
            group: jobDetail.group,
            graphOptions: self.graphOptions,
            hasRoiData: false,
            roiDescription: 'Hours saved',
            jobRoiPerUnitTotal: ko.observable(0.0)
          });

          var jobsarr = [job];
          self.jobmap[jobDetail.id] = job;
          self.jobs(jobsarr);

          logGroup('JobRoiListView', 'loadShowPageSingleJob:complete', {
            duration: `${(performance.now() - startTime).toFixed(2)}ms`
          });

          return job;
        };

        self.loadComplete = function() {
          log('JobRoiListView', 'loadComplete', 'Loading complete');
          window.joblistroiview = self;

          // Keep the original event for backward compatibility
          jQuery(document).trigger(
              jQuery.Event('loaded.rundeck.plugin.jobRoilist', {
                relatedTarget: self
              })
          );
          
          // Dispatch new event so other plugins can know the UI has loaded
          jQuery(document).trigger(
              jQuery.Event('rundeck:plugin:ui-roisummary:ui-loaded:joblist', {
                relatedTarget: self,
                viewType: 'joblist',
                timestamp: Date.now()
              })
          );
        };

        self.setupKnockout = function() {
          log('JobRoiListView', 'setupKnockout', 'Setting up Knockout bindings');
          jobListSupport.setup_ko_loader('ui-roisummary', pluginBase, pluginName);

          ko.bindingHandlers.bootstrapTooltipTrigger = {
            update: function(
                element,
                valueAccessor,
                allBindings,
                viewModel,
                bindingContext
            ) {
              var val = valueAccessor();
              if (ko.isObservable(val)) {
                val = ko.unwrap(val);
                jQuery(element).tooltip(val ? 'show' : 'hide');
              }
            }
          };
        };

        self.loadJobsListPage = function() {
          log('JobRoiListView', 'loadJobsListPage', 'Loading jobs list page');

          const checkForJobs = () => {
            const selectors = [
              '.list-group-item[data-job-id]',
              '.list-group-item a[href*="job/show"]',
              'tr.job_list_row',
              'tr[data-job-id]'
            ];

            let foundJobs = [];
            selectors.forEach(selector => {
              const elements = jQuery(selector);
              if (elements.length > 0) {
                foundJobs = elements;
                log('JobRoiListView', 'loadJobsListPage',
                    `Found ${elements.length} jobs with selector: ${selector}`);
                return false;
              }
            });

            if (foundJobs.length > 0) {
              log('JobRoiListView', 'loadJobsListPage', 'Processing found jobs');
              self.loadJobs();
              self.setupKnockout();

              let tablink = jobListSupport.initPage(
                  '#indexMain',
                  jobListSupport.i18Message('ui-roisummary', 'Jobs'),
                  'joblistroiview',
                  'joblistroitab',
                  jobListSupport.i18Message('ui-roisummary', 'Tab'),
                  templateHtml,
                  function(elem) {
                    log('JobRoiListView', 'loadJobsListPage', 'Applying bindings');
                    ko.applyBindings({ jobroilist: self }, elem);
                  }
              );

              jQuery(tablink).on('shown.bs.tab', function() {
                log('JobRoiListView', 'tabShown', 'Refreshing execution data');
                self.refreshExecData();
              });

              self.loadComplete();
            } else {
              log('JobRoiListView', 'loadJobsListPage', 'No jobs found, retrying...');
              setTimeout(checkForJobs, 100);
            }
          };

          checkForJobs();
        };

        self.sort = function(field) {
          log('JobRoiListView', 'sort', `Sorting by ${field}`);
          if (self.sortField() === field) {
            const newDirection = self.sortDirection() === 'asc' ? 'desc' : 'asc';
            log('JobRoiListView', 'sort', `Changing direction to ${newDirection}`);
            self.sortDirection(newDirection);
          } else {
            log('JobRoiListView', 'sort', `Changing field to ${field}`);
            self.sortField(field);
            self.sortDirection('asc');
          }
        };

        self.getSortIcon = function(field) {
          if (self.sortField() !== field) {
            return 'glyphicon glyphicon-sort';
          }
          return self.sortDirection() === 'asc'
              ? 'glyphicon glyphicon-sort-by-attributes'
              : 'glyphicon glyphicon-sort-by-attributes-alt';
        };
      }
      function ListJob(data) {
        log('ListJob', 'constructor', `Creating job ${data.id}`, 'general');
        var self = this;
        self.loading = ko.observable(false);

        // In ListJob
        self.processExecutions = function(executionsWithRoi) {
          logGroup('ListJob', 'processExecutions', {
            jobId: this.id,
            executionsWithRoi: executionsWithRoi,
            actualLength: executionsWithRoi.length,
            firstExecution: executionsWithRoi[0],
            lastExecution: executionsWithRoi[executionsWithRoi.length-1]
          }, 'process');

          const startTime = performance.now();
          const totalExecutions = executionsWithRoi.length;
          let totalHours = 0;

          executionsWithRoi.forEach(execution => {
            totalHours += execution.roiHours || 0;
          });

          const averageHours = totalHours / totalExecutions;

          this.jobRoiPerUnitTotal(averageHours);
          this.hasRoiData(true);
          this.total(totalExecutions);
          this.roiDescription(
              `hours saved (avg ${averageHours.toFixed(2)} hrs/execution)`
          );

          logGroup('ListJob','processExecutions', {
            jobId: this.id,
            totalExecutions,
            totalHours,
            averageHours,
            processingTime: `${(performance.now() - startTime).toFixed(2)}ms`
          }, 'process');


          this.refreshTotalRoi();
        };

        self.graphOptions = data.graphOptions;
        self.executions = ko.observableArray([]);

        self.id = data.id;
        self.name = ko.observable(data.name);
        self.group = ko.observable(data.group);
        self.hasRoiData = ko.observable(data.hasRoiData);

        self.total = ko.observable(data.total);
        self.href = ko.observable(data.href);
        self.runhref = ko.observable(data.runhref);

        self.jobRoiPerUnitTotal = ko.observable(data.jobRoiPerUnitTotal);
        self.jobRoiTotal = ko.observable('');
        self.roiDescription = ko.observable(data.roiDescription);
        self.roiCalculation = ko.observable('');
        self.executionsWithRoi = ko.observable(0);

        self.mapping = {
          executions: {
            create: function(options) {
              return new ListJobExec(options.data);
            },
            key: function(data) {
              return ko.utils.unwrapObservable(data.id);
            }
          }
        };

        self.refreshData = async function() {
          log('ListJob', 'refreshData', `Refreshing data for job ${self.id}`, 'process');
          self.loading(true);
          const startTime = performance.now();

          try {
            var dateRange = {
              begin: moment()
                  .startOf('day')
                  .subtract(self.graphOptions().queryMax(), 'days')
                  .format('YYYY-MM-DD'),
              end: moment().endOf('day').format('YYYY-MM-DD')
            };

            logGroup('ListJob', 'refreshData:checking', {
              jobId: self.id,
              dateRange
            }, 'process');

            let hasRoi = await roiManager.checkJobRoiStatus(self.id);
            if (!hasRoi) {
              log('ListJob', 'refreshData', `Job ${self.id} has no ROI configuration`, 'process');
              self.jobRoiPerUnitTotal(0);
              self.hasRoiData(false);
              self.total(0);
              
              // Create an empty cache entry for this job even though it has no ROI configuration
              // This ensures we track that we've processed this job in the executionsCache table
              const cacheKey = roiManager.getCacheKey(self.id, dateRange);
              roiManager.dbRequest('set', {
                store: 'executionCache',
                value: {
                  id: cacheKey,
                  data: [],
                  timestamp: Date.now(),
                  dateRange: dateRange,
                  jobId: self.id,
                  hasRoi: false
                }
              }).catch(error => console.error('Failed to cache empty execution data', error));
              
              return;
            }

            let executionsWithRoi = await roiManager.getExecutionsWithRoi([self.id], dateRange);
            // Handle both map and array formats
            let jobExecutions = [];
            
            if (executionsWithRoi instanceof Map) {
              // Handle Map format (expected from roiDataManager.getExecutionsWithRoi)
              jobExecutions = executionsWithRoi.get(self.id) || [];
            } else if (Array.isArray(executionsWithRoi)) {
              // Handle Array format (legacy or direct array return)
              jobExecutions = executionsWithRoi;
            }
            
            if (jobExecutions.length > 0) {
              log('ListJob', 'refreshData',
                  `Processing ${jobExecutions.length} executions for job ${self.id}`, 'process');
              self.processExecutions(jobExecutions);
            } else {
              log('ListJob', 'refreshData', `No executions found for job ${self.id}`, 'process');
              self.jobRoiPerUnitTotal(0);
              self.hasRoiData(false);
              self.total(0);
              self.roiDescription('No executions in selected date range');
              
              // Create an empty cache entry for this job even though it has no executions
              // This ensures we track that we've processed this job in the executionsCache table
              const cacheKey = roiManager.getCacheKey(self.id, dateRange);
              roiManager.dbRequest('set', {
                store: 'executionCache',
                value: {
                  id: cacheKey,
                  data: [],
                  timestamp: Date.now(),
                  dateRange: dateRange,
                  jobId: self.id,
                  hasRoi: false
                }
              }).catch(error => console.error('Failed to cache empty execution data', error));
            }
            self.refreshTotalRoi();

            logGroup('ListJob', 'refreshData:complete', {
              duration: `${(performance.now() - startTime).toFixed(2)}ms`
            }, 'process');
          } catch (error) {
            logError('ListJob', 'refreshData', error);
          } finally {
            self.loading(false);
          }
        };

        self.refreshTotalRoi = function() {
          log('ListJob', 'refreshTotalRoi', `Calculating ROI for job ${self.id}`, 'process');
          const startTime = performance.now();

          var totalHours = (self.jobRoiPerUnitTotal() * self.total()).toFixed(2);
          self.jobRoiTotal(totalHours);

          var formatter = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD'
          });

          var hourlyRate = parseFloat(self.graphOptions().hourlyCost()) || 100;
          var totalCost = totalHours * hourlyRate;
          var formattedNumber = formatter.format(totalCost);

          self.roiCalculation(formattedNumber);

          logGroup('ListJob', 'refreshTotalRoi:complete', {
            totalHours,
            hourlyRate,
            totalCost,
            duration: `${(performance.now() - startTime).toFixed(2)}ms`
          }, 'process');
        };

        self.graphOptions().queryMax.subscribe(function(val) {
          log('ListJob', 'queryMax.changed', `Updating for new value: ${val}`, 'process');
          self.refreshData();
        });

        self.graphOptions().hourlyCost.subscribe(function(val) {
          log('ListJob', 'hourlyCost.changed', `Updating for new value: ${val}`, 'process');
          self.refreshData();
        });

        self.jobRoiPerUnitTotal.subscribe(function(val) {
          log('ListJob', 'jobRoiPerUnitTotal.changed', `Updating for new value: ${val}`, 'process');
          self.refreshTotalRoi();
        });
      }
      function JobRoiViewModel() {
        log('JobRoiViewModel', 'constructor', 'Initializing view model');
        var self = this;
        self.dataLoaded = false;
        self.chartInitialized = false;
        self.previousQueryMax = 0; // Keep track of previous queryMax to detect changes

        self.getMessage = function(key) {
          return jobListSupport.i18Message(pluginName, key);
        };

        self.loading = ko.observable(true);
        self.hasRoiData = ko.observable(false);
        self.total = ko.observable(0);
        self.executionsWithRoi = ko.observable(0);
        self.jobRoiPerUnitTotal = ko.observable(0);
        self.roiCalculation = ko.observable('');
        self.roiDescription = ko.observable('Hours saved');
        self.hasRoiConfiguration = ko.observable(false);
        
        self.hideInstructionsMessage = ko.observable(false);
        try {
            const hideInstructions = localStorage.getItem(roiManager.LS_KEY_HIDE_INSTRUCTIONS);
            self.hideInstructionsMessage(hideInstructions === 'true');
            log('JobRoiViewModel', 'constructor', `Hide instructions setting: ${self.hideInstructionsMessage()}`, 'general');
        } catch (e) {
            logError('JobRoiViewModel', 'constructor', e);
        }
        
        self.hideInstructions = function() {
            log('JobRoiViewModel', 'hideInstructions', 'Hiding instructions message', 'general');
            self.hideInstructionsMessage(true);
            try {
                localStorage.setItem(roiManager.LS_KEY_HIDE_INSTRUCTIONS, 'true');
            } catch (e) {
                logError('JobRoiViewModel', 'hideInstructions', e);
            }
        };

        logGroup('JobRoiViewModel', 'initialization', {
          loading: self.loading(),
          hasRoiData: self.hasRoiData(),
          total: self.total()
        });

        self.hasRoiDataStatus = ko.computed(function() {
          const status = self.total() > 0 && self.executionsWithRoi() > 0;
          log('JobRoiViewModel', 'hasRoiDataStatus', `Status: ${status}`, 'process');
          return status;
        });

        self.hasRoiDataStatus.subscribe(function(newValue) {
          log('JobRoiViewModel', 'hasRoiDataStatus.changed', `New value: ${newValue}`, 'process');
          self.hasRoiData(newValue);
        });

        self.currentExecutions = [];

        self.processExecutions = function(executionsWithRoi) {
          logGroup('JobRoiViewModel', 'processExecutions:start', {
            executionsCount: executionsWithRoi.length
          }, 'process');
          const startTime = performance.now();

          self.currentExecutions = executionsWithRoi;

          var totalHours = 0;
          var roiDataCount = executionsWithRoi.length;

          executionsWithRoi.forEach(function(execution) {
            totalHours += execution.roiHours;
          });

          if (roiDataCount > 0) {
            var averageHours = totalHours / roiDataCount;
            self.jobRoiPerUnitTotal(averageHours);
            self.executionsWithRoi(roiDataCount);
            self.hasRoiData(true);
            self.roiDescription(
                'hours saved (avg ' + averageHours.toFixed(2) + ' hrs/execution)'
            );
            self.calculateRoi();

            logGroup('JobRoiViewModel', 'processExecutions:metrics', {
              totalHours,
              averageHours,
              executionsCount: roiDataCount
            }, 'process');
          }

          logGroup('JobRoiViewModel', 'processExecutions:complete', {
            duration: `${(performance.now() - startTime).toFixed(2)}ms`
          }, 'process');
        };

        const defaultHourlyCost = pluginName.config?.defaultHourlyCost || 100;
        self.graphOptions = ko.observable(
            new GraphOptions({
              queryMax: 5,
              hourlyCost: defaultHourlyCost
            })
        );

        self.chartInstance = null;
        self.chartData = {
          labels: [],
          hours: [],
          values: [],
          executions: []
        };

        jQuery(window).on('unload', function() {
          if (self.chartInstance) {
            log('JobRoiViewModel', 'unload', 'Destroying chart instance', 'cache');
            self.chartInstance.destroy();
          }
        });

        self.updateChart = function(executions) {
          if (!executions || !executions.length) {
            log('JobRoiViewModel', 'updateChart', 'No executions to chart', 'cache');
            return;
          }

          log('JobRoiViewModel', 'updateChart', 'Starting chart update', 'cache');
          self.loading(true);
          const startTime = performance.now();

          const themeColors = getChartThemeColors();

          logGroup('JobRoiViewModel', 'updateChart:theme', {
            colors: themeColors
          }, 'cache');

          let dailyData = {};
          let cutoffDate = moment().subtract(self.graphOptions().queryMax(), 'days');

          executions.forEach(function(execution) {
            if (execution.roiHours) {
              let startDate = moment(execution['date-started'].date);

              if (startDate.isBefore(cutoffDate)) {
                return;
              }

              let dateKey = startDate.format('YYYY-MM-DD');

              if (!dailyData[dateKey]) {
                dailyData[dateKey] = {
                  hours: 0,
                  count: 0,
                  executions: [],
                  avgHoursPerExecution: 0
                };
              }

              dailyData[dateKey].hours += execution.roiHours;
              dailyData[dateKey].count++;
              dailyData[dateKey].executions.push(execution);
              dailyData[dateKey].avgHoursPerExecution =
                  dailyData[dateKey].hours / dailyData[dateKey].count;
            }
          });

          logGroup('JobRoiViewModel', 'updateChart:dailyData', {
            daysProcessed: Object.keys(dailyData).length,
            cutoffDate: cutoffDate.format('YYYY-MM-DD')
          }, 'process');

          let currentDate = moment(cutoffDate);
          let endDate = moment();

          while (currentDate.isSameOrBefore(endDate, 'day')) {
            let dateKey = currentDate.format('YYYY-MM-DD');
            if (!dailyData[dateKey]) {
              dailyData[dateKey] = {
                hours: 0,
                count: 0,
                executions: [],
                avgHoursPerExecution: 0
              };
            }
            currentDate.add(1, 'day');
          }

          self.chartData.labels = [];
          self.chartData.hours = [];
          self.chartData.values = [];
          self.chartData.counts = [];

          let dates = Object.keys(dailyData).sort();

          dates.forEach(date => {
            let displayDate = moment(date).format('MM/DD');
            self.chartData.labels.push(displayDate);
            self.chartData.hours.push(dailyData[date].hours);
            self.chartData.values.push(
                dailyData[date].hours * self.graphOptions().hourlyCost()
            );
            self.chartData.counts.push(dailyData[date].count);
          });

          logGroup('JobRoiViewModel', 'updateChart:chartData', {
            labels: self.chartData.labels.length,
            totalHours: self.chartData.hours.reduce((a, b) => a + b, 0),
            totalExecutions: self.chartData.counts.reduce((a, b) => a + b, 0)
          }, 'cache');

          const initChart = () => {
            log('JobRoiViewModel', 'initChart', 'Initializing chart', 'cache');
            var canvas = document.getElementById('roiTrendChart');
            if (!canvas) {
              logError('JobRoiViewModel', 'initChart', 'Chart canvas not found');
              return false;
            }

            try {
              var ctx = canvas.getContext('2d');
              if (self.chartInstance) {
                log('JobRoiViewModel', 'initChart', 'Destroying existing chart', 'cache');
                self.chartInstance.destroy();
              }

              self.chartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                  labels: self.chartData.labels,
                  datasets: [
                    {
                      label: self.getMessage('Hours.Saved'),
                      data: self.chartData.hours,
                      borderColor: 'rgb(54, 162, 235)',
                      backgroundColor: 'rgba(54, 162, 235, 0.1)',
                      yAxisID: 'y-hours',
                      fill: true
                    },
                    {
                      label: self.getMessage('Hourly.Value'),
                      data: self.chartData.values,
                      borderColor: 'rgb(75, 192, 192)',
                      backgroundColor: 'rgba(75, 192, 192, 0.1)',
                      yAxisID: 'y-value',
                      fill: true
                    },
                    {
                      label: 'Executions',
                      data: self.chartData.counts,
                      borderColor: 'rgb(153, 102, 255)',
                      backgroundColor: 'rgba(153, 102, 255, 0.1)',
                      yAxisID: 'y-count',
                      fill: true
                    }
                  ]
                },
                options: {
                  responsive: true,
                  maintainAspectRatio: false,
                  interaction: {
                    mode: 'index',
                    intersect: false
                  },
                  plugins: {
                    legend: {
                      position: 'top',
                      labels: {
                        usePointStyle: true,
                        padding: 20,
                        color: themeColors.textColor
                      }
                    },
                    tooltip: {
                      callbacks: {
                        label: function(context) {
                          const dataIndex = context.dataIndex;
                          const date = self.chartData.labels[dataIndex];
                          const dayData = dailyData[dates[dataIndex]];

                          if (context.dataset.yAxisID === 'y-hours') {
                            const avgHours = dayData.count > 0
                                ? (dayData.hours / dayData.count).toFixed(2)
                                : '0.00';
                            return [
                              `Hours: ${context.raw.toFixed(2)}`,
                              `Executions: ${dayData.count}`,
                              `Average: ${avgHours} hrs/execution`,
                              `Value: $${(dayData.hours * self.graphOptions().hourlyCost()).toFixed(2)}`
                            ];
                          } else if (context.dataset.yAxisID === 'y-value') {
                            return [
                              `Value: $${context.raw.toFixed(2)}`,
                              `Executions: ${dayData.count}`
                            ];
                          } else {
                            return [`Executions: ${dayData.count}`];
                          }
                        }
                      }
                    }
                  },
                  scales: {
                    x: {
                      title: {
                        display: true,
                        text: self.getMessage('Execution.Date'),
                        color: themeColors.textColor
                      },
                      grid: {
                        color: themeColors.gridColor,
                        borderColor: themeColors.borderColor
                      },
                      ticks: {
                        color: themeColors.textColor
                      }
                    },
                    'y-hours': {
                      type: 'linear',
                      display: true,
                      position: 'left',
                      title: {
                        display: true,
                        text: self.getMessage('Hours.Saved'),
                        color: themeColors.textColor
                      },
                      grid: {
                        color: themeColors.gridColor,
                        borderColor: themeColors.borderColor
                      },
                      ticks: {
                        color: themeColors.textColor,
                        callback: function(value) {
                          return value + ' hrs';
                        }
                      }
                    },
                    'y-count': {
                      type: 'linear',
                      display: true,
                      position: 'left',
                      title: {
                        display: true,
                        text: 'Executions',
                        color: themeColors.textColor
                      },
                      grid: {
                        drawOnChartArea: false,
                        color: themeColors.gridColor,
                        borderColor: themeColors.borderColor
                      },
                      ticks: {
                        color: themeColors.textColor,
                        beginAtZero: true,
                        stepSize: 1
                      }
                    },
                    'y-value': {
                      type: 'linear',
                      display: true,
                      position: 'right',
                      title: {
                        display: true,
                        text: self.getMessage('Hourly.Value'),
                        color: themeColors.textColor
                      },
                      grid: {
                        drawOnChartArea: false,
                        color: themeColors.gridColor,
                        borderColor: themeColors.borderColor
                      },
                      ticks: {
                        color: themeColors.textColor,
                        beginAtZero: true,
                        callback: function(value) {
                          return '$' + value;
                        }
                      }
                    }
                  }
                }
              });

              self.chartInitialized = true;
              log('JobRoiViewModel', 'initChart', 'Chart initialized successfully', 'cache');
              return true;
            } catch (error) {
              logError('JobRoiViewModel', 'initChart', error);
              return false;
            }
          };

          let attempts = 0;
          const maxAttempts = 5;
          const tryInit = () => {
            if (attempts >= maxAttempts) {
              logError('JobRoiViewModel', 'tryInit',
                  `Failed to initialize chart after ${maxAttempts} attempts`);
              self.loading(false);
              return;
            }

            if (!initChart()) {
              attempts++;
              log('JobRoiViewModel', 'tryInit',
                  `Attempt ${attempts} failed, retrying...`, 'cache');
              setTimeout(tryInit, 200);
            } else {
              log('JobRoiViewModel', 'tryInit',
                  `Chart initialized after ${attempts + 1} attempts`, 'cache');
              self.loading(false);
            }
          };

          tryInit();

          logGroup('JobRoiViewModel', 'updateChart:complete', {
            duration: `${(performance.now() - startTime).toFixed(2)}ms`,
            attempts: attempts + 1
          }, 'cache');
        };

        self.loadRoiData = async function() {
          // Check if we already loaded data and there's no change in the date range
          const currentQueryMax = self.graphOptions().queryMax();
          const previousQueryMax = self.previousQueryMax || 0;
          
          log('JobRoiViewModel', 'loadRoiData', 'Checking if data reload is needed', {
            dataLoaded: self.dataLoaded,
            currentQueryMax,
            previousQueryMax
          });
          
          if (self.dataLoaded && currentQueryMax === previousQueryMax) {
            log('JobRoiViewModel', 'loadRoiData', 'Data already loaded with same date range, updating chart only');
            if (self.currentExecutions.length > 0) {
              self.updateChart(self.currentExecutions);
            }
            return;
          }
          
          // Note: We'll store the new queryMax AFTER successfully loading data
          // to ensure that any future changes will trigger a new fetch

          log('JobRoiViewModel', 'loadRoiData', 'Starting data load', 'process');
          self.loading(true);
          const startTime = performance.now();

          try {
            var jobDetail = loadJsonData('jobDetail');
            var jobId = jobDetail.id;

            logGroup('JobRoiViewModel', 'loadRoiData:jobDetail', {
              jobId,
              hasPlugins: !!jobDetail.plugins,
              fullJobDetail: JSON.stringify(jobDetail)
            });

            var hasRoi = await roiManager.checkJobRoiStatus(jobId);

            if (hasRoi) {
              log('JobRoiViewModel', 'loadRoiData', 'ROI metrics configured', 'process');
              self.hasRoiConfiguration(true);
            } else {
              log('JobRoiViewModel', 'loadRoiData', 'No ROI metrics configuration', 'process');
              self.hasRoiConfiguration(false);
              
              // Create an empty cache entry for this job even though it has no ROI configuration
              // This ensures we track that we've processed this job in the executionsCache table
              var dateRange = {
                begin: moment()
                    .startOf('day')
                    .subtract(self.graphOptions().queryMax(), 'days')
                    .format('YYYY-MM-DD'),
                end: moment().endOf('day').format('YYYY-MM-DD')
              };
              const cacheKey = roiManager.getCacheKey(jobId, dateRange);
              roiManager.dbRequest('set', {
                store: 'executionCache',
                value: {
                  id: cacheKey,
                  data: [],
                  timestamp: Date.now(),
                  dateRange: dateRange,
                  jobId: jobId,
                  hasRoi: false
                }
              }).catch(error => console.error('Failed to cache empty execution data', error));
              
              self.loading(false);
              return;
            }

            var dateRange = {
              begin: moment()
                  .startOf('day')
                  .subtract(self.graphOptions().queryMax(), 'days')
                  .format('YYYY-MM-DD'),
              end: moment().endOf('day').format('YYYY-MM-DD')
            };

            logGroup('JobRoiViewModel', 'loadRoiData:fetching', {
              jobId,
              dateRange
            }, 'network');

            var executionsResult = await roiManager.getExecutionsWithRoi([jobId], dateRange);
            var executionsWithRoi = [];
            
            // Handle both map and array formats
            if (executionsResult instanceof Map) {
              // Handle Map format (expected from roiDataManager.getExecutionsWithRoi)
              executionsWithRoi = executionsResult.get(jobId) || [];
            } else if (Array.isArray(executionsResult)) {
              // Handle Array format (legacy or direct array return)
              executionsWithRoi = executionsResult;
            }

            if (executionsWithRoi.length > 0) {
              log('JobRoiViewModel', 'loadRoiData',
                  `Processing ${executionsWithRoi.length} executions`, 'process');
              self.total(executionsWithRoi.length);
              self.processExecutions(executionsWithRoi);

              const canvas = document.getElementById('roiTrendChart');
              if (canvas) {
                self.updateChart(executionsWithRoi);
              } else {
                logError('JobRoiViewModel', 'loadRoiData', 'Chart canvas not found');
              }
            } else {
              // No executions found, create an empty cache entry
              log('JobRoiViewModel', 'loadRoiData', 'No executions found for job', 'process');
              const cacheKey = roiManager.getCacheKey(jobId, dateRange);
              roiManager.dbRequest('set', {
                store: 'executionCache',
                value: {
                  id: cacheKey,
                  data: [],
                  timestamp: Date.now(),
                  dateRange: dateRange,
                  jobId: jobId,
                  hasRoi: false
                }
              }).catch(error => console.error('Failed to cache empty execution data', error));
            }

            self.dataLoaded = true;

            logGroup('JobRoiViewModel', 'loadRoiData:complete', {
              duration: `${(performance.now() - startTime).toFixed(2)}ms`,
              executionsProcessed: executionsWithRoi.length
            }, 'process');
            
            // Only update the previousQueryMax after successful data fetch
            self.previousQueryMax = currentQueryMax;
            
            // Set the initial cache complete flag back to true after fetching data
            try {
              roiManager.setInitialCacheComplete()
              log('JobRoiViewModel', 'loadRoiData', 'Enabled initial cache complete flag', 'process');
            } catch (e) {
              logError('JobRoiViewModel', 'Failed to update localStorage', e);
            }
            
            // Dispatch event so other plugins know that data loading is complete
            jQuery(document).trigger(
              jQuery.Event('rundeck:plugin:ui-roisummary:data-loaded:jobroi', {
                relatedTarget: self,
                viewType: 'jobroi',
                timestamp: Date.now(),
                metrics: {
                  executionsProcessed: executionsWithRoi ? executionsWithRoi.length : 0,
                  processingTime: (performance.now() - startTime)
                }
              })
            );

          } catch (error) {
            logError('JobRoiViewModel', 'loadRoiData', error);
            self.dataLoaded = false;
            self.chartInitialized = false;
          } finally {
            self.loading(false);
          }
        };

        self.calculateRoi = function() {
          log('JobRoiViewModel', 'calculateRoi', 'Calculating ROI', 'process');
          const startTime = performance.now();

          var totalHours = self.jobRoiPerUnitTotal() * self.total();
          var rate = parseFloat(self.graphOptions().hourlyCost()) || 100;
          var total = totalHours * rate;

          var formatter = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD'
          });

          self.roiCalculation(formatter.format(total));

          logGroup('JobRoiViewModel', 'calculateRoi:complete', {
            totalHours,
            rate,
            total,
            duration: `${(performance.now() - startTime).toFixed(2)}ms`
          }, 'process');
        };

        self.graphOptions().hourlyCost.subscribe(function(newValue) {
          log('JobRoiViewModel', 'hourlyCost.changed', `New value: ${newValue}`, 'process');
          localStorage.setItem('rundeck.plugin.roisummary.hourlyCost', newValue);
          if (self.dataLoaded && self.currentExecutions.length > 0) {
            self.calculateRoi();
            self.updateChart(self.currentExecutions);
          }
        });

        self.graphOptions().queryMax.subscribe(function(newValue) {
          log('JobRoiViewModel', 'queryMax.changed', `New value: ${newValue}`, 'process');
          // Don't update previousQueryMax here - we'll do that after successful data fetch
          // This ensures we'll always refresh data when queryMax changes
          
          // Disable flag in localStorage when queryMax changes
          try {
            localStorage.setItem(roiManager.LS_KEY_INITIAL_CACHE_COMPLETE, 'false');
            log('JobRoiViewModel', 'queryMax.changed', 'Disabled initial cache complete flag', 'process');
          } catch (e) {
            logError('JobRoiViewModel', 'Failed to update localStorage', e);
          }
          
          // Always reload data when date range changes
          // Set dataLoaded to false to force a new data fetch
          self.dataLoaded = false;
          self.loadRoiData();
        });

        log('JobRoiViewModel', 'initialization', 'Ready for data load');
      }

      // Helper function to sanitize HTML content to prevent XSS
      function sanitizeHTML(str) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(str, 'text/html');

        return doc.body.innerHTML;
      }

      if (pagePath === 'menu/jobs') {
        log('RoiSummary', 'pageInit', 'Initializing jobs page');
        _ticker(moment());
        let pluginId = 'ui-roisummary';
        let pluginUrl = rundeckPage.pluginBaseUrl(pluginId);
        joblistroiview = new JobRoiListView();

        jobListSupport.init_plugin(pluginId, function() {
          jQuery.get(pluginUrl + '/html/table.html', function(templateHtml) {
            log('RoiSummary', 'templateLoad', 'Processing template');
            let processedHtml = templateHtml;
            const messageKeys = [
              'ROI.Summary',
              'Configure',
              'Time.Window',
              'Last.Howmany.Days',
              'Show.No.ROI',
              'Hourly.Value',
              'Apply',
              'Days'
            ];
            messageKeys.forEach(key => {
              const message = jobListSupport.i18Message(pluginName, key);
              const sanitizedMessage = sanitizeHTML(message);
              const placeholder = new RegExp('%%' + key + '%%', 'g');
              processedHtml = processedHtml.replace(placeholder, sanitizedMessage);
            });

            log('RoiSummary', 'templateLoad', 'Creating tab');
            let tablink = jobListSupport.initPage(
                '#indexMain',
                jobListSupport.i18Message('ui-roisummary', 'Jobs'),
                'joblistroiview',
                'joblistroitab',
                jobListSupport.i18Message('ui-roisummary', 'Tab'),
                processedHtml,
                function(elem) {
                  log('RoiSummary', 'bindingsApplied', 'Initializing view');
                  joblistroiview.loadJobs();
                  ko.applyBindings({ jobroilist: joblistroiview }, elem);
                  joblistroiview.refreshExecData();
                }
            );
          }).fail(function(jqXHR, textStatus, errorThrown) {
            logError('RoiSummary', 'templateLoad', {
              status: textStatus,
              error: errorThrown
            });
          });
        });
      }

      if (pagePath === 'scheduledExecution/show') {
        log('RoiSummary', 'pageInit', 'Initializing job show page');
        _ticker(moment());

        let pluginId = 'ui-roisummary';
        let pluginUrl = rundeckPage.pluginBaseUrl(pluginId);

        jobListSupport.setup_ko_loader(pluginId, pluginUrl, pluginId);
        jobRoiView = new JobRoiViewModel();

        let container = jQuery('<div class="col-sm-12 roi-summary-section"></div>');
        let statsTab = jQuery('#stats');
        if (statsTab.length) {
          container.prependTo(statsTab);
        }

        jobListSupport.init_plugin(pluginId, function() {
          jQuery.get(pluginUrl + '/html/job-roi.html', function(templateHtml) {
            try {
              log('RoiSummary', 'templateLoad', 'Processing template');
              let processedHtml = templateHtml;
              [
                'ROI.Summary',
                'Hourly.Cost',
                'Last.Howmany.Days',
                'Days',
                'Loading',
                'Hours.Saved',
                'Hourly.Value',
                'Execution.Date',
                'Not.Configured'
              ].forEach(key => {
                let message = jobListSupport.i18Message(pluginName, key);
                let sanitizedMessage = sanitizeHTML(message);
                processedHtml = processedHtml.replace(
                    new RegExp(`%%${key}%%`, 'g'),
                    sanitizedMessage
                );
              });

              container.html(processedHtml);
              ko.applyBindings(jobRoiView, container[0]);

              // Single point of initialization
              if (document.getElementById('roiTrendChart')) {
                jobRoiView.loadRoiData();
                
                // Dispatch event so other plugins can know the UI has loaded
                jQuery(document).trigger(
                  jQuery.Event('rundeck:plugin:ui-roisummary:ui-loaded:jobroi', {
                    relatedTarget: jobRoiView,
                    viewType: 'jobroi',
                    timestamp: Date.now()
                  })
                );
              } else {
                logError('RoiSummary', 'templateLoad', 'Chart canvas not found');
              }
            } catch (e) {
              logError('RoiSummary', 'templateLoad', e);
            }
          });
        });
      }

      const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
          if (mutation.attributeName === 'data-color-theme') {
            log('RoiSummary', 'themeChange', 'Theme changed, refreshing chart');
            if (pagePath === 'menu/jobs' && joblistroiview?.refreshExecData) {
              joblistroiview.refreshExecData();
            } else if (pagePath === 'scheduledExecution/show' && jobRoiView?.dataLoaded) {
              // Only update the chart if data is already loaded
              jobRoiView.updateChart(jobRoiView.currentExecutions);
            }
          }
        });
      });

      if (joblistroiview || jobRoiView) {
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-color-theme']
        });
      }
    });
  }
}

window.addEventListener("DOMContentLoaded", initRoiSummary);

