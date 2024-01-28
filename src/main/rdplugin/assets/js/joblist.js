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
  var _every30s = ko
    .computed(function () {
      return _ticker();
    })
    .extend({ rateLimit: { timeout: 30000 } });

  var _every60s = ko
    .computed(function () {
      return _ticker();
    })
    .extend({ rateLimit: { timeout: 60000 } });

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

    self.dateCompletedRelative = ko.computed(function () {
      var next = self.dateEnded();
      if (next) {
        return MomentUtil.formatTimeAtDate(next);
      }
      return null;
    });

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
    self.statusCss = ko.computed(function () {
      var status = self.status();
      var selected = self.selected()
        ? " sparkline-box selected"
        : " sparkline-box";

      if (status == "succeeded") {
        return "text-success" + selected;
      } else if (status == "failed") {
        return "text-danger" + selected;
      } else if (status == "aborted") {
        return "text-muted" + selected;
      } else if (status == "running") {
        return "text-info" + selected;
      } else if (status == "scheduled") {
        return "text-info" + selected;
      } else {
        return "text-warning" + selected;
      }
    });
    self.statusIcon = ko.computed(function () {
      var status = self.status();
      if (status == "succeeded") {
        return "glyphicon-ok-circle";
      } else if (status == "failed") {
        return "glyphicon-exclamation-sign";
      } else if (status == "aborted") {
        return "glyphicon-remove-circle";
      } else if (status == "running") {
        return "glyphicon-play-circle";
      } else if (status == "scheduled") {
        return "glyphicon-time";
      } else {
        return "glyphicon-asterisk";
      }
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
    self.jobFav = ko.observable();

    self.nowrunning = ko.observableArray([]);
    self.scheduled = ko.observableArray([]);
    self.id = data.id;
    self.name = ko.observable(data.name);
    self.group = ko.observable(data.group);
    self.hasRoiData = ko.observable(data.hasRoiData);

    self.total = ko.observable(data.total);
    self.href = ko.observable(data.href);
    self.runhref = ko.observable(data.runhref);

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
          // console.log("detail for " + job.id, data);
          // var executions=data.executions||[];
          ko.mapping.fromJS(data, self.mapping, self);
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
    self.normalRangeVar = ko.observable(data.normalRangeVar || 0.01);
    self.showNormal = ko.observable(data.showNormal || false);
    self.normalSuccessOnly = ko.observable(data.normalSuccessOnly || true);
    self.normalOption = ko.observable(data.normalOption || "Average");
    self.queryMax = ko.observable(data.queryMax || 10);
  }

  function JobRoiListView() {
    var self = this;
    self.jobfavorites = ko.observable();
    self.jobfavsOnly = ko.observable(false);
    self.jobs = ko.observableArray([]);
    self.jobsListed = ko.computed(function () {
      var jobfavs = self.jobfavsOnly();
      var alljobs = self.jobs();
      if (!jobfavs) {
        return alljobs;
      }
      return ko.utils.arrayFilter(self.jobs(), function (j) {
        return j.jobFav() && j.jobFav().fav();
      });
    });
    self.jobmap = {};
    self.nowrunning = ko
      .observableArray([])
      .extend({ rateLimit: { timeout: 500, method: "notifyWhenChangesStop" } });
    self.executionsShowRecent = ko.observable(true);

    self.graphOptions = ko.observable(
      new GraphOptions({
        normalRangeVar: 0.01,
        showNormal: false,
        normalSuccessOnly: true,
        normalOption: "Average",
        queryMax: 10,
      })
    );
    self.graphShowHelpText = ko.observable(false);

    self.hasJobFavorites = ko.computed(function () {
      return self.jobfavorites() != null;
    });

    self.loadJobFavorites = function (favset) {
      for (var x = 0; x < favset.length; x++) {
        var job = self.jobmap[favset[x].id()];
        if (job) {
          job.jobFav(favset[x]);
        }
      }
    };

    self.registerJobFavorites = function (jobfavorites) {
      self.loadJobFavorites(jobfavorites.favset());
      self.jobfavorites(jobfavorites);
      jobfavorites.favsonly.subscribe(self.jobfavsOnly);
      self.jobfavsOnly(jobfavorites.favsonly());
    };
    self.onLoadedJobFavoritesEvent = function (evt) {
      self.registerJobFavorites(evt.relatedTarget);
    };

    self.graphOptions().normalOption.subscribe(function (val) {
      var pct = val === "Average" ? 0.01 : 0.1;
      self.graphOptions().normalRangeVar(pct);
    });

    self.nowrunning.subscribe(function (newdata) {
      ko.utils.arrayForEach(newdata, function (exec) {
        var job = self.jobmap[exec.jobId()];
        if (job) {
          job.nowrunning.push(exec);
        }
      });
    });

    self.refreshRunningData = function () {
      jQuery.ajax({
        url: _genUrl(appLinks.menuNowrunningAjax),
        method: "GET",
        contentType: "json",
        success: function (data) {
          //console.log("nowrunning ", data);
          // ko.mapping.fromJS(data, job.mapping, job);
          //job.executions(data.executions);
          ko.mapping.fromJS(
            data,
            {
              nowrunning: {
                create: function (options) {
                  return new ListJobExec(options.data);
                },
                key: function (data) {
                  return ko.utils.unwrapObservable(data.id || data.executionId);
                },
              },
            },
            self
          );
        },
      });
    };

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
        var job = new ListJob({
          id: jobid,
          name: jobname,
          group: jobgroup,
          href: link ? link.attr("href") : null,
          runhref: runlink ? runlink.attr("href") : null,
          graphOptions: self.graphOptions, //copy same observable to jobs
          hasRoiData: false,
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
      var job = new ListJob({
        id: jobid,
        name: jobname,
        group: jobgroup,
        graphOptions: self.graphOptions, //copy same observable to jobs
      });
      var jobsarr = [job];
      self.jobmap[jobid] = job;
      self.jobs(jobsarr);
      return job;
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
    self.loadJobsShowPage = function () {
      var job = self.loadShowPageSingleJob();
      self.setupKnockout();
      self.graphShowHelpText(true);
      var myViewmodel = {
        dash: self,
        job: job,
      };
      self.refreshExecData();
      setInterval(function () {
        self.refreshExecData();
      }, 30000);

      //create new 12 column card for sparkline and config controls
      let sparklineCard = jQuery(`
<div >

</div>
`);
      if (typeof window._rundeckui !== "undefined") {
        window._rundeckui.scheduledExecution.show.addJobStatsContent({
          after: true,
          content: sparklineCard,
        });
      } else {
        var target = jQuery("#_job_stats_extra_placeholder");
        target.append(sparklineCard);
      }
      ko.applyBindings(myViewmodel, sparklineCard[0]);

      let newColumn = jQuery(`

`);
      if (typeof window._rundeckui !== "undefined") {
        window._rundeckui.scheduledExecution.show.addJobStatsItem({
          before: true,
          content: newColumn,
        });
      } else {
        var div = jQuery("div.jobstats");
        if (div) {
          //prepend a new card into the columns listing the job stats

          let tablerows = div.find(".job-stats-item");
          if (tablerows.length < 1) {
            return;
          }
          let col1 = tablerows[0];
          tablerows.removeClass("col-sm-4").addClass("col-sm-3");

          jQuery(col1).before(newColumn);
        }
      }

      ko.applyBindings(myViewmodel, newColumn[0]);
      self.loadComplete();
    };
    self.loadJobsListPage = function () {
      self.loadJobs();
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

      if (window.favjobs) {
        self.registerJobFavorites(window.favjobs);
        //force move of controls to tabbar if already loaded
        window.favjobs.addControlsToPage();
      } else {
        jQuery(document).on(
          "loaded.rundeck.plugin.jobfavorites",
          self.onLoadedJobFavoritesEvent
        );
      }

      self.loadComplete();
    };
  }

  if (pagePath === "menu/jobs") {
    _ticker(moment());
    let joblistroiview = new JobRoiListView();
    jobListSupport.init_plugin(pluginName, joblistroiview.loadJobsListPage);
  } else if (pagePath === "scheduledExecution/show") {
    let joblistroiview = new JobRoiListView();
    jobListSupport.init_plugin(pluginName, joblistroiview.loadJobsShowPage);
  }
});
