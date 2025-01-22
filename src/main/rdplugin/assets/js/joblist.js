var DEBUG = false
function log (...args) {
  if (DEBUG) console.log(...args)
}

function filterExecutionsByDate(executions, cutoffDate) {
  // Group executions by date for logging
  var executionsByDate = {};
  executions.forEach(function(execution) {
    // Get the date from the date-started field
    var dateStarted = execution['date-started']?.date || execution.dateStarted;
    
    // Debug log the raw date value
    // console.log('Processing execution:', {
    //   id: execution.id,
    //   rawDate: dateStarted,
    //   dateObject: execution['date-started']
    // });

    if (typeof dateStarted === 'string') {
      var executionDate = moment(dateStarted).format('YYYY-MM-DD');
      if (!executionsByDate[executionDate]) {
        executionsByDate[executionDate] = [];
      }
      executionsByDate[executionDate].push(execution);
    }
  });

  //console.log('Executions grouped by actual dates:', executionsByDate);

  // Filter executions
  var filtered = executions.filter(function(execution) {
    var dateStarted = execution['date-started']?.date || execution.dateStarted;
    var executionDate = moment(dateStarted).startOf('day');
    var cutoffMoment = moment(cutoffDate).startOf('day');
    var isAfterCutoff = executionDate.isAfter(cutoffMoment) || executionDate.isSame(cutoffMoment, 'day');
    
    // console.log('Execution date check:', {
    //   id: execution.id,
    //   executionDate: executionDate.format('YYYY-MM-DD HH:mm:ss'),
    //   cutoffDate: cutoffMoment.format('YYYY-MM-DD HH:mm:ss'),
    //   isAfterCutoff: isAfterCutoff,
    //   timeFromCutoff: executionDate.diff(cutoffMoment, 'hours')
    // });
    
    return isAfterCutoff;
  });

  return filtered;
}

//= require lib/support
var jobListSupport = new JobListSupport()

jQuery(function () {
  var project = rundeckPage.project()
  var pagePath = rundeckPage.path()
  //console.log('Current page path:', pagePath)
  var pluginName = RDPLUGIN['ui-roisummary']
  var pluginBase = rundeckPage.pluginBaseUrl(pluginName)
  var _ticker = ko.observable()

  if (typeof moment != 'undefined') {
    _ticker(moment())
    setInterval(function () {
      _ticker(moment())
    }, 1000)
  }

  function ListJobExec (data) {
    var self = this
    self.id = ko.observable(data.id || data.executionId)
    self.jobId = ko.observable(data.jobId)
    self.status = ko.observable(data.status)
  }

  function GraphOptions (data) {
    var self = this

    // Add validation for queryMax
    self.queryMax = ko.observable(data.queryMax || 10)
    self.queryMax.subscribe(function (newValue) {
      // Convert to integer and validate
      var days = parseInt(newValue)
      if (isNaN(days) || days < 1) {
        // Reset to previous valid value or default
        console.warn('Invalid days value. Must be a positive whole number.')
        self.queryMax(10)
        return
      }
      // Ensure it's a whole number
      if (days !== parseFloat(newValue)) {
        console.warn(
          'Days value must be a whole number. Rounding to nearest integer.'
        )
        self.queryMax(days)
        return
      }
    })

    // Initialize hourlyCost with saved value or default
    const savedRate = localStorage.getItem(
      'rundeck.plugin.roisummary.hourlyCost'
    )
    self.hourlyCost = ko.observable(
      savedRate ? parseFloat(savedRate) : data.hourlyCost || 100
    )

    // Add validation for hourlyCost
    self.hourlyCost.subscribe(function (newValue) {
      const rate = parseFloat(newValue)
      if (isNaN(rate) || rate < 0) {
        console.warn('Invalid hourly rate. Using default.')
        self.hourlyCost(100)
        localStorage.setItem('rundeck.plugin.roisummary.hourlyCost', 100)
      }
    })

    self.showNoRoi = ko.observable(false)

    // Add persistence for showNoRoi setting
    const savedShowNoRoi = localStorage.getItem(
      'rundeck.plugin.roisummary.showNoRoi'
    )
    if (savedShowNoRoi !== null) {
      self.showNoRoi(savedShowNoRoi === 'true')
    }

    // Save showNoRoi setting when changed
    self.showNoRoi.subscribe(function (newValue) {
      localStorage.setItem('rundeck.plugin.roisummary.showNoRoi', newValue)
    })
  }

  function JobRoiListView () {
    var self = this
    self.project = ko.observable(
      window.projectName || jQuery('#projectSelect').val()
    )
    self.getMessage = function (key) {
      return jobListSupport.i18Message('ui-roisummary', key)
    }

    self.jobs = ko.observableArray([])
    self.jobsListed = ko.computed(function () {
      return self.jobs()
    })
    self.jobmap = {}
    self.executionsShowRecent = ko.observable(true)
    self.loading = ko.observable(false)
    self.graphShowHelpText = ko.observable(false)

    // Get configured value from plugin config
    const defaultHourlyCost = pluginName.config?.defaultHourlyCost || 100
    self.graphOptions = ko.observable(
      new GraphOptions({
        queryMax: 10,
        hourlyCost: defaultHourlyCost
      })
    )

    self.graphOptions().queryMax.subscribe(function (newValue) {
      console.log('Timespan changed to: ' + newValue) // Debug log
      self.refreshExecData()
    })

    self.graphOptions().hourlyCost.subscribe(function (newValue) {
      console.log('Rate Value changed to: ' + newValue) //Debug log
      self.refreshExecData()
    })

    self.refreshExecData = function() {
      if (self.loading()) {
          console.log('Already refreshing, skipping...')
          return
      }
      console.log('Refreshing execution data for all jobs...')
      self.loading(true)
      var jobs = self.jobs()
  
      ko.utils.arrayForEach(jobs, function(job) {
        var execsurl = _genUrl(appLinks.scheduledExecutionJobExecutionsAjax, {
          id: job.id,
          max: 1000,
          format: 'json',
          status: 'succeeded',
          recentFilter: 'false',
          begin: moment().startOf('day').subtract(self.graphOptions().queryMax() - 1, 'days').format('YYYY-MM-DD'),
          end: moment().endOf('day').format('YYYY-MM-DD')
      });
  
          jQuery.ajax({
              url: execsurl,
              method: 'GET',
              contentType: 'json',
              success: function(data) {
                  if (data.executions && data.executions.length > 0) {
                    var cutoffDate = moment().startOf('day').subtract(self.graphOptions().queryMax() - 1, 'days');
                      
                      // Use the helper function to filter executions
                      var filteredExecutions = filterExecutionsByDate(data.executions, cutoffDate)
  
                      // console.log('Date filtering:', {
                      //     cutoffDate: cutoffDate.format('YYYY-MM-DD'),
                      //     totalExecutions: data.executions.length,
                      //     filteredCount: filteredExecutions.length,
                      //     daysRequested: self.graphOptions().queryMax()
                      // })
  
                      // Process filtered executions
                      var processedExecutions = 0
                      var executionsWithRoi = []
  
                      filteredExecutions.forEach(function(execution) {
                          jQuery.ajax({
                              url: execution.href + '/roimetrics/data',
                              method: 'GET',
                              contentType: 'json',
                              success: function(roiData) {
                                  if ('hours' in roiData) {
                                      var hours = parseFloat(roiData.hours)
                                      if (!isNaN(hours)) {
                                          execution.roiHours = hours
                                          executionsWithRoi.push(execution)
                                      }
                                  }
                              },
                              complete: function() {
                                  processedExecutions++
                                  if (processedExecutions === filteredExecutions.length) {
                                      if (executionsWithRoi.length > 0) {
                                          job.processExecutions(executionsWithRoi)
                                      } else {
                                          job.jobRoiPerUnitTotal(0)
                                          job.hasRoiData(false)
                                          job.total(0)
                                      }
                                      self.loading(false)
                                  }
                              }
                          })
                      })
                  } else {
                      job.hasRoiData(false)
                      job.total(0)
                      self.loading(false)
                  }
              },
              error: function(xhr, status, error) {
                  console.error('Error loading executions:', error)
                  self.loading(false)
              }
          })
      })
  }

    //load job list
    self.loadJobs = function () {
      //console.log('Loading jobs...');

      // Find jobs in DOM
      var foundJobs = jQuery('.jobname[data-job-id]')
      //console.log('Found jobs:', foundJobs.length);

      var jobsarr = []
      foundJobs.each(function (idx, el) {
        var jel = jQuery(el)
        // console.log('Processing job element:', {
        //     element: el,
        //     jobId: jel.data('jobId'),
        //     jobName: jel.data('jobName'),
        //     jobGroup: jel.data('jobGroup')
        // });

        var job = new ListJob({
          id: jel.data('jobId'),
          name: jel.data('jobName'),
          group: jel.data('jobGroup'),
          project: rundeckPage.project(),
          graphOptions: self.graphOptions,
          hasRoiData: false,
          jobRoiPerUnitTotal: ko.observable(0.0),
          roiDescription: 'Hours saved'
        })

        jobsarr.push(job)
        self.jobmap[job.id] = job
      })

      //console.log('Loaded jobs:', {
      //     count: jobsarr.length,
      //     jobs: jobsarr
      // });

      self.jobs(jobsarr)
    }
    self.loadShowPageSingleJob = function () {
      var jobDetail = loadJsonData('jobDetail')
      var jobid = jobDetail.id
      var jobname = jobDetail.name
      var jobgroup = jobDetail.group
      var job = new ListJob({
        id: jobid,
        name: jobname,
        group: jobgroup,
        graphOptions: self.graphOptions, //copy same observable to jobs
        hasRoiData: false, //roiData != null,
        roiDescription: 'Hours saved',
        jobRoiPerUnitTotal: ko.observable(0.0)
      })
      var jobsarr = [job]
      self.jobmap[jobid] = job
      self.jobs(jobsarr)
      return job
    }

    self.loadComplete = function () {
      window.joblistroiview = self

      jQuery(document).trigger(
        jQuery.Event('loaded.rundeck.plugin.jobRoilist', {
          relatedTarget: self
        })
      )
    }

    self.setupKnockout = function () {
      jobListSupport.setup_ko_loader('ui-roisummary', pluginBase, pluginName)

      //custom bindings
      ko.bindingHandlers.bootstrapTooltipTrigger = {
        update: function (
          element,
          valueAccessor,
          allBindings,
          viewModel,
          bindingContext
        ) {
          var val = valueAccessor()
          if (ko.isObservable(val)) {
            val = ko.unwrap(val)
            jQuery(element).tooltip(val ? 'show' : 'hide')
          }
        }
      }
    }

    self.loadJobsListPage = function () {
      console.log('Loading jobs list page')

      // Wait for jobs to be in DOM
      const checkForJobs = () => {
        // Try multiple selectors
        const selectors = [
          '.list-group-item[data-job-id]', // New UI
          '.list-group-item a[href*="job/show"]', // Alternative for new UI
          'tr.job_list_row', // Old UI
          'tr[data-job-id]' // Generic
        ]

        let foundJobs = []
        selectors.forEach(selector => {
          const elements = jQuery(selector)
          if (elements.length > 0) {
            foundJobs = elements
            //console.log('Found jobs with selector:', {
            //     selector: selector,
            //     count: elements.length,
            //     elements: elements
            // });
            return false // Break forEach
          }
        })

        if (foundJobs.length > 0) {
          //console.log('Jobs found in DOM, loading...');
          self.loadJobs()
          self.setupKnockout()

          // Create the tab with the loaded template
          let tablink = jobListSupport.initPage(
            '#indexMain',
            jobListSupport.i18Message('ui-roisummary', 'Jobs'),
            'joblistroiview',
            'joblistroitab',
            jobListSupport.i18Message('ui-roisummary', 'Dashboard'),
            templateHtml,
            function (elem) {
              ko.applyBindings({ jobroilist: self }, elem)
            }
          )

          jQuery(tablink).on('shown.bs.tab', function () {
            self.refreshExecData()
          })

          self.loadComplete()
        } else {
          console.log('Jobs not found yet, retrying...')
          setTimeout(checkForJobs, 100)
        }
      }

      checkForJobs()
    }
    // Add sorting properties
    self.sortField = ko.observable('name')
    self.sortDirection = ko.observable('asc')

    // Add sorting method
    self.sort = function (field) {
      if (self.sortField() === field) {
        self.sortDirection(self.sortDirection() === 'asc' ? 'desc' : 'asc')
      } else {
        self.sortField(field)
        self.sortDirection('asc')
      }
    }

    // Add method to get sort icon
    self.getSortIcon = function (field) {
      if (self.sortField() !== field) {
        return 'glyphicon glyphicon-sort'
      }
      return self.sortDirection() === 'asc'
        ? 'glyphicon glyphicon-sort-by-attributes'
        : 'glyphicon glyphicon-sort-by-attributes-alt'
    }

    // Add computed observable for sorted jobs
    self.sortedJobs = ko.computed(function () {
      var jobs = self.jobs().filter(function (job) {
        return job.hasRoiData() || self.graphOptions().showNoRoi()
      })

      var field = self.sortField()
      var direction = self.sortDirection()

      return jobs.sort(function (a, b) {
        var aValue, bValue

        switch (field) {
          case 'name':
            aValue = a.name().toLowerCase()
            bValue = b.name().toLowerCase()
            break
          case 'group':
            aValue = a.group().toLowerCase()
            bValue = b.group().toLowerCase()
            break
          case 'executions':
            aValue = a.total() || 0
            bValue = b.total() || 0
            break
          case 'avgHours':
            aValue = a.jobRoiPerUnitTotal() || 0
            bValue = b.jobRoiPerUnitTotal() || 0
            break
          case 'totalHours':
            aValue = parseFloat(a.jobRoiTotal()) || 0
            bValue = parseFloat(b.jobRoiTotal()) || 0
            break
          case 'value':
            aValue =
              parseFloat(a.roiCalculation().replace(/[^0-9.-]+/g, '')) || 0
            bValue =
              parseFloat(b.roiCalculation().replace(/[^0-9.-]+/g, '')) || 0
            break
          default:
            return 0
        }

        if (direction === 'asc') {
          return aValue > bValue ? 1 : -1
        } else {
          return aValue < bValue ? 1 : -1
        }
      })
    })
  }

  function ListJob (data) {
    var self = this
    self.loading = ko.observable(false)

    self.processExecutions = function (executionsWithRoi) {
      var totalHours = 0
      var roiDataCount = executionsWithRoi.length

      executionsWithRoi.forEach(function (execution) {
        totalHours += execution.roiHours
      })

      if (roiDataCount > 0) {
        var averageHours = totalHours / roiDataCount
        self.jobRoiPerUnitTotal(averageHours)
        self.hasRoiData(true)
        self.total(roiDataCount) // Use the actual count of executions with ROI
        self.roiDescription(
          'hours saved (avg ' + averageHours.toFixed(2) + ' hrs/execution)'
        )
        self.refreshTotalRoi()
      }
    }
    self.graphOptions = data.graphOptions
    self.executions = ko.observableArray([])

    self.id = data.id
    self.name = ko.observable(data.name)
    self.group = ko.observable(data.group)
    self.hasRoiData = ko.observable(data.hasRoiData)

    self.total = ko.observable(data.total)
    self.href = ko.observable(data.href)
    self.runhref = ko.observable(data.runhref)

    self.jobRoiPerUnitTotal = ko.observable(data.jobRoiPerUnitTotal)
    self.jobRoiTotal = ko.observable('')
    self.roiDescription = ko.observable(data.roiDescription)
    self.roiCalculation = ko.observable('')
    self.executionsWithRoi = ko.observable(0)

    self.mapping = {
      executions: {
        create: function (options) {
          return new ListJobExec(options.data)
        },
        key: function (data) {
          return ko.utils.unwrapObservable(data.id)
        }
      }
    }

    self.refreshData = function () {
      self.loading(true)
      var cutoffDate = moment().startOf('day').subtract(self.graphOptions().queryMax() - 1, 'days');
  
          var execsurl = _genUrl(appLinks.scheduledExecutionJobExecutionsAjax, {
            id: self.id,
            max: 1000,
            format: 'json',
            status: 'succeeded',
            recentFilter: 'false',
            begin: moment().startOf('day').subtract(self.graphOptions().queryMax() - 1, 'days').format('YYYY-MM-DD'),
            end: moment().endOf('day').format('YYYY-MM-DD')
        });
  
      jQuery.ajax({
          url: execsurl,
          method: 'GET',
          contentType: 'json',
          success: function (data) {
              if (data.executions && data.executions.length > 0) {
                  // Group executions by date first
                  var executionsByDate = {}
                  data.executions.forEach(function (execution) {
                      var dateStarted = execution.dateStarted
                      if (typeof dateStarted === 'object' && dateStarted.date) {
                          dateStarted = dateStarted.date
                      }
                      var executionDate = moment(dateStarted).format('YYYY-MM-DD')
                      if (!executionsByDate[executionDate]) {
                          executionsByDate[executionDate] = []
                      }
                      executionsByDate[executionDate].push(execution)
                  })
  
                  // console.log('Executions by date:', executionsByDate)
  
                  // Filter executions by date
                  var filteredExecutions = filterExecutionsByDate(data.executions, cutoffDate)
  
                  // console.log('Date filtering:', {
                  //     cutoffDate: cutoffDate.format('YYYY-MM-DD'),
                  //     totalExecutions: data.executions.length,
                  //     filteredCount: filteredExecutions.length,
                  //     daysRequested: self.graphOptions().queryMax()
                  // })
  
                  if (filteredExecutions.length === 0) {
                      self.jobRoiPerUnitTotal(0)
                      self.hasRoiData(false)
                      self.total(0)
                      self.roiDescription('No executions in selected date range')
                      self.refreshTotalRoi()
                      self.loading(false)
                      return
                  }
  
                  // Now get ROI data for filtered executions
                  var processedExecutions = 0
                  var executionsWithRoi = []
  
                  filteredExecutions.forEach(function (execution) {
                      jQuery.ajax({
                          url: execution.href + '/roimetrics/data',
                          method: 'GET',
                          contentType: 'json',
                          success: function (roiData) {
                              if ('hours' in roiData) {
                                  var hours = parseFloat(roiData.hours)
                                  if (!isNaN(hours)) {
                                      execution.roiHours = hours
                                      executionsWithRoi.push(execution)
                                  }
                              }
                          },
                          complete: function () {
                              processedExecutions++
                              if (processedExecutions === filteredExecutions.length) {
                                  if (executionsWithRoi.length > 0) {
                                      self.processExecutions(executionsWithRoi)
                                  } else {
                                      self.jobRoiPerUnitTotal(0)
                                      self.hasRoiData(false)
                                      self.total(0)
                                  }
                                  self.loading(false)
                              }
                          }
                      })
                  })
              } else {
                  self.jobRoiPerUnitTotal(0)
                  self.hasRoiData(false)
                  self.total(0)
                  self.loading(false)
              }
          },
          error: function () {
              self.loading(false)
          }
      })
  }

    self.refreshTotalRoi = function () {
      var totalHours = (self.jobRoiPerUnitTotal() * self.total()).toFixed(2)
      self.jobRoiTotal(totalHours)

      var formatter = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
      })

      // Get current hourly cost rate
      var hourlyRate = parseFloat(self.graphOptions().hourlyCost()) || 100
      var totalCost = totalHours * hourlyRate
      var formattedNumber = formatter.format(totalCost)

      self.roiCalculation(formattedNumber)
    }

    self.graphOptions().queryMax.subscribe(function (val) {
      self.refreshData()
    })

    self.graphOptions().hourlyCost.subscribe(function (val) {
      self.refreshData()
    })

    self.jobRoiPerUnitTotal.subscribe(function (val) {
      self.refreshTotalRoi()
    })
  }

  function JobRoiViewModel () {
    var self = this

    self.getMessage = function (key) {
      return jobListSupport.i18Message('ui-roisummary', key)
    }

    // Define observables first
    self.loading = ko.observable(true)
    self.hasRoiData = ko.observable(false)
    self.total = ko.observable(0)
    self.executionsWithRoi = ko.observable(0)
    self.jobRoiPerUnitTotal = ko.observable(0)
    self.roiCalculation = ko.observable('')
    self.roiDescription = ko.observable('Hours saved')
    self.hasRoiConfiguration = ko.observable(false)

    self.hasRoiDataStatus = ko.computed(function () {
      return self.total() > 0 && self.executionsWithRoi() > 0
    })

    self.hasRoiDataStatus.subscribe(function (newValue) {
      self.hasRoiData(newValue)
    })

    self.currentExecutions = []
    // Update the processExecutions function to store the data
    self.processExecutions = function (executionsWithRoi) {
      // Store the executions for later use
      self.currentExecutions = executionsWithRoi

      var totalHours = 0
      var roiDataCount = executionsWithRoi.length

      executionsWithRoi.forEach(function (execution) {
        totalHours += execution.roiHours
      })

      if (roiDataCount > 0) {
        var averageHours = totalHours / roiDataCount
        self.jobRoiPerUnitTotal(averageHours)
        self.executionsWithRoi(roiDataCount)
        self.hasRoiData(true)
        self.roiDescription(
          'hours saved (avg ' + averageHours.toFixed(2) + ' hrs/execution)'
        )
        self.calculateRoi()
      }
    }

    // Get configured value from plugin config
    const defaultHourlyCost = pluginName.config?.defaultHourlyCost || 100
    self.graphOptions = ko.observable(
      new GraphOptions({
        queryMax: 10,
        hourlyCost: defaultHourlyCost
      })
    )

    self.chartInstance = null
    self.chartData = {
      labels: [],
      hours: [],
      values: [],
      executions: []
    }

    jQuery(window).on('unload', function () {
      if (self.chartInstance) {
        self.chartInstance.destroy()
      }
    })

    self.updateChart = function (executions) {
      console.log('Updating chart')
      self.loading(true)

      // Group executions by date
      let dailyData = {}
      let cutoffDate = moment().subtract(self.graphOptions().queryMax(), 'days')

      executions.forEach(function (execution) {
        if (execution.roiHours) {
          let startDate = moment(execution['date-started'].date)

          // Skip executions outside our date range
          if (startDate.isBefore(cutoffDate)) {
            return
          }

          let dateKey = startDate.format('YYYY-MM-DD')

          if (!dailyData[dateKey]) {
            dailyData[dateKey] = {
              hours: 0,
              count: 0,
              executions: [],
              avgHoursPerExecution: 0
            }
          }

          dailyData[dateKey].hours += execution.roiHours
          dailyData[dateKey].count++
          dailyData[dateKey].executions.push(execution)
          dailyData[dateKey].avgHoursPerExecution =
            dailyData[dateKey].hours / dailyData[dateKey].count
        }
      })

      // Fill in missing dates with zero values
      let currentDate = moment(cutoffDate)
      let endDate = moment()

      while (currentDate.isSameOrBefore(endDate, 'day')) {
        let dateKey = currentDate.format('YYYY-MM-DD')
        if (!dailyData[dateKey]) {
          dailyData[dateKey] = {
            hours: 0,
            count: 0,
            executions: [],
            avgHoursPerExecution: 0
          }
        }
        currentDate.add(1, 'day')
      }

      // Convert grouped data to arrays
      self.chartData.labels = []
      self.chartData.hours = []
      self.chartData.values = []
      self.chartData.counts = []

      // Sort dates
      let dates = Object.keys(dailyData).sort()

      dates.forEach(date => {
        let displayDate = moment(date).format('MM/DD')
        self.chartData.labels.push(displayDate)
        self.chartData.hours.push(dailyData[date].hours)
        self.chartData.values.push(
          dailyData[date].hours * self.graphOptions().hourlyCost()
        )
        self.chartData.counts.push(dailyData[date].count)
      })

      //console.log('Daily aggregated data:', {
      //   rawData: dailyData,
      //   labels: self.chartData.labels,
      //   hours: self.chartData.hours,
      //   values: self.chartData.values,
      //   dates: dates
      // })

      const initChart = () => {
        var canvas = document.getElementById('roiTrendChart')
        if (!canvas) {
          console.error('Chart canvas not found')
          return false
        }

        try {
          var ctx = canvas.getContext('2d')
          if (self.chartInstance) {
            self.chartInstance.destroy()
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
                    padding: 20
                  }
                },
                tooltip: {
                  callbacks: {
                    label: function (context) {
                      const dataIndex = context.dataIndex
                      const date = self.chartData.labels[dataIndex]
                      const dayData = dailyData[dates[dataIndex]] // Use full date key

                      if (context.dataset.yAxisID === 'y-hours') {
                        return [
                          `Hours: ${context.raw.toFixed(2)}`,
                          `Executions: ${dayData.count}`,
                          `Average: ${(dayData.hours / dayData.count).toFixed(
                            2
                          )} hrs/execution`
                        ]
                      } else {
                        return [
                          `Value: ${context.raw.toFixed(2)}`,
                          `Executions: ${dayData.count}`
                        ]
                      }
                    }
                  }
                }
              },
              scales: {
                x: {
                  title: {
                    display: true,
                    text: self.getMessage('Execution.Date')
                  },
                  grid: {
                    display: false
                  }
                },
                'y-hours': {
                  type: 'linear',
                  display: true,
                  position: 'left',
                  title: {
                    display: true,
                    text: self.getMessage('Hours.Saved')
                  },
                  grid: {
                    color: 'rgba(54, 162, 235, 0.1)'
                  },
                  ticks: {
                    beginAtZero: true,
                    callback: function (value) {
                      return value + ' hrs'
                    }
                  }
                },
                'y-value': {
                  type: 'linear',
                  display: true,
                  position: 'right',
                  title: {
                    display: true,
                    text: self.getMessage('Hourly.Value')
                  },
                  grid: {
                    drawOnChartArea: false,
                    color: 'rgba(75, 192, 192, 0.1)'
                  },
                  ticks: {
                    beginAtZero: true,
                    callback: function (value) {
                      return '$' + value
                    }
                  }
                }
              }
            }
          })
          return true
        } catch (error) {
          console.error('Error creating chart:', error)
          return false
        }
      }

      // Try to init chart with retries
      let attempts = 0
      const maxAttempts = 5
      const tryInit = () => {
        if (attempts >= maxAttempts) {
          console.error(
            'Failed to initialize chart after',
            maxAttempts,
            'attempts'
          )
          self.loading(false)
          return
        }

        if (!initChart()) {
          attempts++
          setTimeout(tryInit, 200)
        } else {
          self.loading(false)
        }
      }

      tryInit()
    }

    self.loadRoiData = function () {
      self.loading(true)
      var jobDetail = loadJsonData('jobDetail')
      var jobId = jobDetail.id
  
      if (jobDetail.plugins && jobDetail.plugins['roi-metrics']) {
          self.hasRoiConfiguration(true)
      } else {
          self.hasRoiConfiguration(false)
      }
  
      var execsurl = _genUrl(appLinks.scheduledExecutionJobExecutionsAjax, {
          id: jobId,
          max: 1000, // Use large number instead of queryMax
          format: 'json',
          status: 'succeeded',
          recentFilter: 'false',
          begin: moment().startOf('day').subtract(self.graphOptions().queryMax() - 1, 'days').format('YYYY-MM-DD'),
          end: moment().endOf('day').format('YYYY-MM-DD')
      })
  
      jQuery.ajax({
          url: execsurl,
          method: 'GET',
          contentType: 'json',
          success: function (data) {
              if (data.executions && data.executions.length > 0) {
                  var cutoffDate = moment().startOf('day').subtract(self.graphOptions().queryMax() - 1, 'days');
                  var filteredExecutions = filterExecutionsByDate(data.executions, cutoffDate);
  
                  self.total(filteredExecutions.length)
  
                  var processedExecutions = 0
                  var executionsWithRoi = []
  
                  filteredExecutions.forEach(function (execution) {
                      jQuery.ajax({
                          url: execution.href + '/roimetrics/data',
                          method: 'GET',
                          contentType: 'json',
                          success: function (innerdata) {
                              if ('hours' in innerdata) {
                                  var hours = parseFloat(innerdata.hours)
                                  if (!isNaN(hours)) {
                                      execution.roiHours = hours
                                      executionsWithRoi.push(execution)
                                  }
                              }
                          },
                          error: function (xhr, status, error) {
                              if (xhr.status === 404) {
                                  console.warn(`ROI data not found for execution ${execution.id}. Could be a failed Execution. This is normal.`)
                              } else {
                                  console.error(`Error fetching ROI data for execution ${execution.id}:`, error)
                              }
                          },
                          complete: function () {
                              processedExecutions++
                              if (processedExecutions === filteredExecutions.length) {
                                  if (executionsWithRoi.length > 0) {
                                      self.processExecutions(executionsWithRoi)
                                      self.updateChart(executionsWithRoi)
                                  }
                                  self.loading(false)
                              }
                          }
                      })
                  })
              } else {
                  self.loading(false)
              }
          },
          error: function (xhr, status, error) {
              console.error('Error loading executions:', error)
              self.loading(false)
          }
      })
  }

    self.calculateRoi = function () {
      var totalHours = self.jobRoiPerUnitTotal() * self.total()
      var rate = parseFloat(self.graphOptions().hourlyCost()) || 100
      var total = totalHours * rate

      var formatter = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
      })

      self.roiCalculation(formatter.format(total))
    }

    // Update chart when hourly cost changes
    self.graphOptions().hourlyCost.subscribe(function (newValue) {
      self.loadRoiData()
    })

    self.graphOptions().queryMax.subscribe(function (newValue) {
      self.loadRoiData()
    })

    // Initial load
    self.loadRoiData()
  }

  //console.log('Checking page conditions...')

  if (pagePath === 'menu/jobs') {
    //console.log('Matched jobs list page');
    _ticker(moment())

    // Initialize plugin
    let pluginId = 'ui-roisummary'
    let pluginUrl = rundeckPage.pluginBaseUrl(pluginId)

    //console.log('Plugin setup:', {
    //     id: pluginId,
    //     url: pluginUrl
    // });

    // Initialize jobListSupport
    jobListSupport.setup_ko_loader(pluginId, pluginUrl, pluginId)

    let joblistroiview = new JobRoiListView()

    // Initialize plugin and wait for messages
    jobListSupport.init_plugin(pluginId, function () {
      // Load template after messages are loaded
      jQuery.get(pluginUrl + '/html/table.html', function (templateHtml) {
        //console.log('Table template loaded');

        // Process message replacements
        let processedHtml = templateHtml
        ;[
          'Time.Window',
          'Last.Howmany.Days',
          'Days',
          'Hourly.Value',
          'Time.Span',
          'Apply',
          'Configure',
          'Show.No.ROI'
        ].forEach(key => {
          let message = jobListSupport.i18Message(pluginId, key)
          //console.log('Processing modal message:', {
          //     key,
          //     message: message,
          //     fromProperties: true
          // });
          processedHtml = processedHtml.replace(
            new RegExp(`%%${key}%%`, 'g'),
            message.replace('ui-roisummary.', '')
          )
        })

        // Create tab with processed template
        let tablink = jobListSupport.initPage(
          '#indexMain',
          jobListSupport.i18Message(pluginId, 'Jobs'),
          'joblistroiview',
          'joblistroitab',
          jobListSupport.i18Message(pluginId, 'Dashboard'),
          processedHtml,
          function (elem) {
            joblistroiview.loadJobs()
            ko.applyBindings({ jobroilist: joblistroiview }, elem)
            joblistroiview.refreshExecData()
          }
        )
      })
    })
  }

  if (pagePath === 'scheduledExecution/show') {
    //console.log('Matched job show page')
    _ticker(moment())

    // Initialize with string name
    let pluginId = 'ui-roisummary'
    let pluginUrl = rundeckPage.pluginBaseUrl(pluginId)

    // console.log('Plugin initialization:', {
    //   id: pluginId,
    //   url: pluginUrl,
    //   base: rundeckPage.baseUrl()
    // })

    // Initialize jobListSupport with string values
    jobListSupport.setup_ko_loader(pluginId, pluginUrl, pluginId)

    let jobRoiView = new JobRoiViewModel()

    // Create container
    let container = jQuery('<div class="col-sm-12 roi-summary-section"></div>')
    let statsTab = jQuery('#stats')
    if (statsTab.length) {
      container.prependTo(statsTab)
    }

    // Initialize plugin and wait for messages to load
    jobListSupport.init_plugin(pluginId, function () {
      // console.log('Messages loaded:', {
      //   messages: window.Messages,
      //   summary: jobListSupport.i18Message(pluginId, 'ROI.Summary'),
      //   hours: jobListSupport.i18Message(pluginId, 'Hours.Saved')
      // })

      // Load template after messages are loaded
      jQuery.get(pluginUrl + '/html/job-roi.html', function (templateHtml) {
        console.log('Template loaded')

        try {
          // Process message replacements
          let processedHtml = templateHtml
          ;[
            'ROI.Summary',
            'Hourly.Cost',
            'Last.Howmany.Days',
            'Days',
            'Hours.Saved',
            'Hourly.Value',
            'Execution.Date'
          ].forEach(key => {
            let message = jobListSupport.i18Message(pluginId, key)
            // console.log('Replacing message:', { key, message })
            processedHtml = processedHtml.replace(
              new RegExp(`%%${key}%%`, 'g'),
              message
            )
          })

          // Set processed HTML
          container.html(processedHtml)

          // Apply bindings
          ko.applyBindings(jobRoiView, container[0])

          // Wait for DOM to be ready before loading data
          setTimeout(() => {
            // Verify canvas exists
            if (document.getElementById('roiTrendChart')) {
              console.log('Chart canvas found, loading data')
              jobRoiView.loadRoiData()
            } else {
              console.error('Chart canvas still not found after template load')
            }
          }, 250) // Increased timeout to ensure DOM is ready
        } catch (e) {
          console.error('Error processing template:', e)
        }
      })
    })
  }
  //console.log('Plugin and Support info:', {
  //   pluginName: pluginName,
  //   pluginBase: pluginBase,
  //   jobListSupport: jobListSupport,
  //   messages: jobListSupport.messages,
  //   i18n: jobListSupport.i18Message
  // })
})
