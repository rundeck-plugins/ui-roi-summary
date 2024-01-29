//= require lib/support
var jobListSupport = new JobListSupport();
jQuery(function () {
  var project = rundeckPage.project();
  var pagePath = rundeckPage.path();
  var pluginName = RDPLUGIN["ui-roisummary"];
  var pluginBase = rundeckPage.pluginBaseUrl(pluginName);
  var _ticker = ko.observable();
  if (typeof moment != "undefined") {
    _ticker(moment());
    setInterval(function () {
      _ticker(moment());
    }, 1000);
  }

  function ListJobExec(data) {
    var self = this;
    self.id = ko.observable(data.id || data.executionId);
    self.jobId = ko.observable(data.jobId);
    self.status = ko.observable(data.status);
    self.customStatus = ko.observable(data.customStatus);
    self.permalink = ko.observable(data.permalink || data.executionHref);
    self.dateEnded = ko.observable(
      data.dateEnded || data["date-ended"] ? data["date-ended"]["date"] : null
    );
    self.dateEndedUnixtime = ko.observable(
      data.dateEndedUnixtime || data["date-ended"]
        ? data["date-ended"]["unixtime"]
        : null
    );
    self.dateStarted = ko.observable(
      data.dateStarted || data["date-started"]
        ? data["date-started"]["date"]
        : null
    );
    self.dateStartedUnixtime = ko.observable(
      data.dateStarted || data["date-started"]
        ? data["date-started"]["unixtime"]
        : null
    );
    self.selected = ko.observable(false);
    self.duration = ko.computed(function () {
      var de = self.dateEndedUnixtime();
      var ds = self.dateStartedUnixtime();
      if (de && ds) {
        return de > ds ? de - ds : 0;
      }
      return null;
    });
    self.user = ko.observable(data.user);

    self.durationHumanized = ko.computed(function () {
      var ms = self.duration();
      if (ms != null) {
        if (ms < 1000) {
          return ms + "ms";
        }
        return MomentUtil.formatDurationHumanize(ms);
      }
      return null;
    });
    self.title = ko.computed(function () {
      var status = self.status();
      var customStatus = self.customStatus();
      if (status === "other" && customStatus) {
        status = '"' + customStatus + '"';
      }
      return (
        "#" +
        self.id() +
        " " +
        status +
        " (" +
        self.durationHumanized() +
        ") by " +
        self.user()
      );
    });
  }

  function ListJob(data) {
    var self = this;
    self.graphOptions = data.graphOptions;
    self.executions = ko.observableArray([]);

    self.nowrunning = ko.observableArray([]);
    self.scheduled = ko.observableArray([]);
    self.id = data.id;
    self.name = ko.observable(data.name);
    self.group = ko.observable(data.group);
    self.hasRoiData = ko.observable(data.hasRoiData);

    self.total = ko.observable(data.total);
    self.href = ko.observable(data.href);
    self.runhref = ko.observable(data.runhref);

    self.roiDictionary = ko.observable({});

    self.mapping = {
      executions: {
        create: function (options) {
          return new ListJobExec(options.data);
        },
        key: function (data) {
          return ko.utils.unwrapObservable(data.id);
        },
      },
      nowrunning: {
        create: function (options) {
          return new ListJobExec(options.data);
        },
        key: function (data) {
          return (
            ko.utils.unwrapObservable(data.id) ||
            ko.utils.unwrapObservable(data.executionId)
          );
        },
      },
      scheduled: {
        create: function (options) {
          return new ListJobExec(options.data);
        },
        key: function (data) {
          return (
            ko.utils.unwrapObservable(data.id) ||
            ko.utils.unwrapObservable(data.executionId)
          );
        },
      },
    };

    self.refreshData = function () {
      //load exec info
      var url = appLinks.scheduledExecutionJobExecutionsAjax;
      var execsurl = _genUrl(url, {
        id: self.id,
        max: self.graphOptions().queryMax(),
        format: "json",
      });
      var runningurl = _genUrl(url, {
        id: self.id,
        max: self.graphOptions().queryMax(),
        format: "json",
        status: "running",
      });
      var schedurl = _genUrl(url, {
        id: self.id,
        max: self.graphOptions().queryMax(),
        format: "json",
        status: "scheduled",
      });
      var detailurl = _genUrl(appLinks.scheduledExecutionDetailFragmentAjax, {
        id: self.id,
      });

      jQuery.ajax({
        url: detailurl,
        method: "GET",
        contentType: "json",
        success: function (data) {
          ko.mapping.fromJS(data, self.mapping, self);

          var executions = data.executions || [];
          var executionDetailUrl = executions[0].href;
          var response = JSON.parse(data);
          var key = response.job.id;
          if (!roiDictionary.hasOwnProperty(key)) {
            jQuery.ajax({
              url: executionDetailUrl + "/roimetrics/data",
              method: "GET",
              contentType: "json",
              success: function (data) {
                var metricsData = JSON.parse(data);
                if ("hours" in metricsData) {
                  if (parseInt(metricsData.hours) != NaN) {
                    roiDictionary[key] = metricsData;
                  }
                }
              },
            });
          }
        },
      });

      jQuery.ajax({
        url: execsurl,
        method: "GET",
        contentType: "json",
        success: function (data) {
          // console.log("execs for " + self.id, data);
          // var executions=data.executions||[];
          var completed = ko.utils.arrayFilter(data.executions, function (e) {
            return e.status != "running" && e.status != "scheduled";
          });

          ko.mapping.fromJS(
            { executions: completed, total: data.paging.total },
            self.mapping,
            self
          );
          jQuery.ajax({
            url: runningurl,
            method: "GET",
            contentType: "json",
            success: function (data2) {
              // console.log("running for " + self.id, data2);
              var running = ko.utils.arrayFilter(
                data2.executions,
                function (e) {
                  return e.status == "running";
                }
              );
              ko.mapping.fromJS({ nowrunning: running }, self.mapping, self);

              jQuery.ajax({
                url: schedurl,
                method: "GET",
                contentType: "json",
                success: function (data3) {
                  // console.log("scheduled for " + self.id, data3);
                  var scheduled = ko.utils.arrayFilter(
                    data3.executions,
                    function (e) {
                      return e.status != "running";
                    }
                  );
                  ko.mapping.fromJS(
                    { scheduled: scheduled },
                    self.mapping,
                    self
                  );
                },
              });
            },
          });
        },
      });
    };
    self.graphOptions().queryMax.subscribe(function (val) {
      self.refreshData();
    });
  }

  function GraphOptions(data) {
    var self = this;
    self.queryMax = ko.observable(data.queryMax || 10);
  }

  function JobRoiListView() {
    var self = this;
    self.jobs = ko.observableArray([]);
    self.jobsListed = ko.computed(function () {
      return self.jobs();
    });
    self.jobmap = {};
    self.nowrunning = ko
      .observableArray([])
      .extend({ rateLimit: { timeout: 500, method: "notifyWhenChangesStop" } });
    self.executionsShowRecent = ko.observable(true);

    self.graphOptions = ko.observable(
      new GraphOptions({
        queryMax: 10,
      })
    );
    self.graphShowHelpText = ko.observable(false);

    self.refreshExecData = function () {
      // self.refreshRunningData();
      ko.utils.arrayForEach(self.jobs(), function (job) {
        job.refreshData();
      });
    };

    //load job list

    self.loadJobs = function () {
      var foundJobs = jQuery(".jobname[data-job-id]");
      var jobsarr = [];
      foundJobs.each(function (n, el) {
        var jel = jQuery(el);
        var jobid = jel.data("jobId");
        var jobname = jel.data("jobName");
        var jobgroup = jel.data("jobGroup");
        var link = jel.find("a.hover_show_job_info");
        var runlink = jel.find("a.act_execute_job");
        // var roiData = self.roiDictionary.hasOwnProperty(jobid)
        //   ? self.roiDictionary[jobid]
        //   : null;
        var job = new ListJob({
          id: jobid,
          name: jobname,
          group: jobgroup,
          href: link ? link.attr("href") : null,
          runhref: runlink ? runlink.attr("href") : null,
          graphOptions: self.graphOptions, //copy same observable to jobs
          hasRoiData: false,
          roiDescription: "Hours saved",
        });
        jobsarr.push(job);
        self.jobmap[jobid] = job;
      });
      self.jobs(jobsarr);
    };
    self.loadShowPageSingleJob = function () {
      var jobDetail = loadJsonData("jobDetail");
      var jobid = jobDetail.id;
      var jobname = jobDetail.name;
      var jobgroup = jobDetail.group;
      var roiData = self.roiDictionary.hasOwnProperty(jobid);
      var job = new ListJob({
        id: jobid,
        name: jobname,
        group: jobgroup,
        graphOptions: self.graphOptions, //copy same observable to jobs
        hasRoiData: roiData != null,
        roiDescription: "Hours saved",
        jobRoiTotal: roiData != null ? roiData.hours : 0,
      });
      var jobsarr = [job];
      self.jobmap[jobid] = job;
      self.jobs(jobsarr);
      return job;
    };

    self.loadROI = function () {
      ko.utils.arrayForEach(self.jobs(), function (job) {
        var detailurl = _genUrl(appLinks.scheduledExecutionDetailFragmentAjax, {
          id: job.id,
        });

        jQuery.ajax({
          url: detailurl,
          method: "GET",
          contentType: "json",
          success: function (data) {
            ko.mapping.fromJS(data, self.mapping, self);

            if (data.job) {
              var response = JSON.parse(data);
              var executionDetailUrl = response.job.href;

              var key = response.job.id;
              if (!roiDictionary.hasOwnProperty(key)) {
                jQuery.ajax({
                  url: executionDetailUrl + "/roimetrics/data",
                  method: "GET",
                  contentType: "json",
                  success: function (data) {
                    var metricsData = JSON.parse(data);
                    if ("hours" in metricsData) {
                      if (parseInt(metricsData.hours) != NaN) {
                        roiDictionary[key] = metricsData;
                      }
                    }
                  },
                });
              }
            }
          },
        });
      });
    };

    self.loadComplete = function () {
      window.joblistroiview = self;

      jQuery(document).trigger(
        jQuery.Event("loaded.rundeck.plugin.joblist", {
          relatedTarget: self,
        })
      );
    };

    self.setupKnockout = function () {
      jobListSupport.setup_ko_loader("ui-roisummary", pluginBase, pluginName);

      //custom bindings
      ko.bindingHandlers.bootstrapTooltipTrigger = {
        update: function (
          element,
          valueAccessor,
          allBindings,
          viewModel,
          bindingContext
        ) {
          var val = valueAccessor();
          if (ko.isObservable(val)) {
            val = ko.unwrap(val);
            jQuery(element).tooltip(val ? "show" : "hide");
          }
        },
      };
    };

    self.loadJobsListPage = function () {
      self.loadJobs();
      //load ROI data from jobs
      self.loadROI();
      self.setupKnockout();
      let tablink = jobListSupport.initPage(
        "#indexMain",
        jobListSupport.i18Message(pluginName, "Jobs"),
        "joblistroiview",
        "joblisttab",
        jobListSupport.i18Message(pluginName, "Dashboard"),
        '<ui-roisummary-table params="joblist: $data"></ui-roisummary-table>',
        function (elem) {
          // console.log("tab: " + elem, elem);
          ko.applyBindings(self, elem);
        }
      );

      jQuery(tablink).on("shown.bs.tab", function () {
        self.refreshExecData();
      });

      self.loadComplete();
    };
  }

  if (pagePath === "menu/jobs") {
    _ticker(moment());
    let joblistroiview = new JobRoiListView();
    jobListSupport.init_plugin(pluginName, joblistroiview.loadJobsListPage);
  }
});
