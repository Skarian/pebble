# Pebble projects

These are some of my personal Pebble projects. A few solve everyday problems;
others are experiments I built while learning the modern Rebble SDK and Pebble
Time 2 hardware. Each project has its own usage and development notes.

## Apps

### [AirQuality](apps/air-quality)

See live Aranet4 HOME air measurements, battery status, and rolling history on
your wrist. The Android companion reads the sensor directly over Bluetooth.

<img src="apps/air-quality/screenshots/air-quality.png" width="200" alt="AirQuality showing a current Aranet4 reading on Pebble">

### [CPAP](apps/cpap)

Review the last seven nights of ResMed myAir scores, details, and trends without
opening the phone app.

<img src="apps/cpap/docs/cpap.png" width="200" alt="CPAP showing a nightly myAir score on Pebble">

### [Hubitat](apps/hubitat)

Check selected Hubitat sensors and control authorized switches and locks from
Pebble.

<img src="apps/hubitat/screenshots/hubitat.png" width="200" alt="Hubitat controlling a desk lamp from Pebble">

[Browse all apps →](apps)

## Watchfaces

### [Field Terminal](watchfaces/field-terminal)

An experimental green phosphor field instrument with time, date, battery, and
a brief minute-change signal animation.

<img src="watchfaces/field-terminal/presented_emery.png" width="200" alt="Field Terminal watchface">

### [Casio Field Face](watchfaces/casio-field-face-c)

An experimental digital field-watch face with a large clock, compact date, and
high-contrast instrument styling.

<img src="watchfaces/casio-field-face-c/emulator-current.png" width="200" alt="Casio Field Face on Pebble Time 2">

[Browse all watchfaces →](watchfaces)

## Companion apps

[AirQuality Companion](companion_apps/air-quality-android) connects an Aranet4
HOME to the AirQuality Pebble app, imports sensor history, and keeps readings
flowing in the background.

<img src="companion_apps/air-quality-android/screenshots/air-quality-companion.png" width="270" alt="AirQuality Android companion setup screen">

[Browse companion apps →](companion_apps)

## Tools

- [Pebble Screenshot Tool](tools/pebble-screenshot-tool) captures deterministic
  emulator screenshots and lighting variants.
- [Pebble Watchface Toolkit](tools/pebble-watchface) provides templates,
  references, and validation helpers for new watchfaces.

[Browse all tools →](tools)

## Repository layout

```text
apps/              Pebble watchapps
watchfaces/        Pebble watchfaces and their design references
companion_apps/    Standalone phone companions
tools/             Shared development and visual QA tools
```

Generated PBWs, build directories, QA runs, caches, and private environment
files are intentionally excluded from Git.
