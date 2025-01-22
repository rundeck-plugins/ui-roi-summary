# ROI Summary Plugin for Rundeck

**Transform your automation metrics into compelling business value**

Originally created by Eric Chapman and enhanced by the Rundeck Plugins Team, the ROI Summary plugin brings your automation's financial impact to life through intuitive visualizations and real-time calculations.

<p align="center">
  <img src="docs/roi-summary.png" alt="ROI Summary screen shot">
  <img src="docs/roi-job.png" alt="ROI Job Details">
</p>


## Key Features

- **Dynamic ROI Dashboard**: Instantly see the hours and costs saved across all your automated jobs
- **Interactive Trend Analysis**: Beautiful charts showing your automation savings over time
- **Flexible Cost Modeling**: Easily adjust hourly rates to match your business context
- **Real-time Calculations**: Watch your ROI grow with each successful execution
- **Executive-ready Metrics**: Perfect for demonstrating automation value to stakeholders

## Visualizations
- **Jobs List View**: See ROI metrics for all jobs at a glance, with options to show/hide jobs without ROI data
- **Individual Job View**: Detailed ROI trends and metrics for specific jobs
- **Configurable Time Windows**: Analyze ROI data over custom time periods
- **Interactive Charts**: Hover over data points to see detailed metrics

## Business Benefits

- Quantify the true value of your automation initiatives
- Make data-driven decisions about automation investments
- Demonstrate clear ROI to leadership
- Track automation efficiency trends over time
- Identify your highest-impact automation workflows

## Requirements

This plugin requires Runbook Automation Self-Hosted as it leverages the ROI Metrics feature available in commercial versions.  (It is not available on our Cloud offering yet) 

The ROI Metrics feature must be configured for your jobs to capture time savings data that this plugin visualizes.  On each job you'd like to track ROI add a metric called `hours` and assign the value for it.  [More details about how to use ROI Metrics is here](https://docs.rundeck.com/docs/learning/howto/use-roi-metrics.html).

---

*Note: This plugin seamlessly integrates with Rundeck's UI to provide insights where you need them - both in job listings and individual job details pages. Configure once, gain insights everywhere.*

## Build

Using gradle:
```
./gradlew clean build
```

## Install

You can install this plugin with the Rundeck Repository feature or copy to your libext folder.  (No need to restart Rundeck)

```
cp build/libs/ui-roi-summary-${version}.zip $RDECK_BASE/libext
```

## Support
- Documentation: [ROI Metrics Guide](https://docs.rundeck.com/docs/learning/howto/use-roi-metrics.html)
- Issues: This is Community supported only.  Please report any issues via the GitHub repository