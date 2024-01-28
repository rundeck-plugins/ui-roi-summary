# Job ROI Summary View Rundeck Plugin

This is a Rundeck UI plugin that shows a table list view of Rundeck jobs with ROI data

<p align="center">
  <img src="docs/roi-summary.png" alt="ROI Summary screen shot">
</p>

## Build

Using gradle:
```
./gradlew build
```

## Install

You can install this plugin with the Rundeck Repository feature.

For older versions of Rundeck

```
cp build/libs/ui-roi-summary-${version}.zip $RDECK_BASE/libext
```
