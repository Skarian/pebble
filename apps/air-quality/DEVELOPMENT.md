# AirQuality development notes

AirQuality puts an Aranet4 HOME reading on Pebble. It shows CO2 first, with
temperature in Fahrenheit, humidity, pressure, battery, and a chart for each
air measurement.

- Open the watch app to refresh automatically.
- Press **Select** on the current screen to refresh again.
- Press **Up** or **Down** to move through the current reading and four charts.
  The list stops at either end.
- Press **Select** on a chart to cycle through **1 hour**, **1 day**, and
  **1 week**.

The watch keeps the last good reading. Missing values appear as `--`, and the
update line always says how old the visible reading is. AirQuality is for
awareness only and does not give medical advice.

## What you need

- An Aranet4 HOME with **Smart Home integrations** enabled in the Aranet Home
  app.
- An Android phone running the Pebble app.
- The AirQuality Android companion and Pebble PBW from this project.

You do **not** need an Aranet base station, cloud account, API key, or location
permission on modern Android. The companion reads the sensor's Bluetooth
advertisements directly. Bluetooth stays on the phone; readings sent to the
watch contain no credentials.

## Install and connect

Build both apps:

```sh
cd apps/air-quality
npm test
npm run android:test
npm run android:build
pebble build
```

Install the Android companion:

```sh
adb install -r ../../companion_apps/air-quality-android/app/build/outputs/apk/debug/app-debug.apk
```

Then:

1. Open **AirQuality Companion** on the phone.
2. Allow **Nearby devices** and notifications.
3. Tap **Choose sensor** and select your Aranet4.
4. Set the short name shown on the watch, such as `HOME` or `OFFICE`.
5. Keep the monitoring notification running.
6. Install `build/air-quality.pbw`, then open **AirQuality** on Pebble.

If the sensor appears without a reading, open Aranet Home and enable
**Smart Home integrations**, then return and tap **Refresh now**.

## How history works

After you choose a sensor, the companion imports up to eight days of readings
already stored in the Aranet4. It then saves each new reading it sees. The
database retains eight days.

All three chart scales use the same rolling time-series view. The graph has 56
time columns, which is the useful horizontal resolution at Pebble size. Every
stored reading in the selected hour, day, or week contributes to its column.
Each column is the average of its readings, and a plain line joins every
available average continuously, including across empty time columns. The
average below the chart is calculated from all readings in the
window. Each window ends at the newest available reading, so the sensor's
normal reporting delay does not leave a misleading blank section before
`LAST`; the update line still shows the reading's real age. An isolated average
is shown as a short line. The chart has no point or range markers.

The first import can take a few seconds. If the sensor does not offer saved
history, new readings still build the charts normally. Tap **Refresh now** in
the companion to retry the import.

No data is uploaded and no bridge server is used. Removing the Android app
removes its saved readings and selected sensor.

## Review every Pebble screen

```sh
cd apps/air-quality
npm run qa:screenshots
```

This fake-data command tests the contracts, builds the production PBW, and
creates a numbered `qa-results/.../all-states.png` board. It covers setup,
loading, companion and Bluetooth problems, permission, missing sensor, timeout,
service failure, all three device CO2 states, missing metrics and history,
old data, the current screen, and every chart at every scale.

The fake states are injected from the repository QA runner. The production PBW
contains no fixtures, QA navigation, local server, or test mode. The runner
waits for `/private/tmp/pebble-emulator-qa.lock`, uses isolated emulator state,
and releases both the emulator and lock on every exit.

## Design and behavior

The screen hierarchy, short labels, monochrome spacing, large system fonts,
blocking full-screen sync and error states, bounded list, last-good cache,
request IDs, stale-response rejection, and numbered QA board follow the
working `apps/cpap/` app. The updated line is promoted to a more readable system
font after native-device review. The Aranet adaptation removes cloud setup,
AQI, polling modes, technical status prose, and extra metadata. There is one
primary value or action per screen.

The device's own CO2 state drives the face instead of hard-coded thresholds,
because Aranet lets users customize its CO2 limits. The standard defaults are
Good below 1000 ppm, Average from 1000 through 1400 ppm, and Unhealthy above
1400 ppm.

## Architecture

- `src/c/main.c`: production Pebble UI, persistent cache, request ordering.
- `../../companion_apps/air-quality-android/`: direct Aranet4 BLE reader, local
  history, and PebbleKit transport.
- `src/common/air_quality_model.js`: repository QA state model only.
- `scripts/qa.mjs`: deterministic screenshots and contact sheet.

PebbleKit JS is intentionally absent: Pebble does not support combining it with
PebbleKit Android for the same watchapp. The Android companion uses
`io.rebble.pebblekit2:client:1.2.0` and the watch communicates through
AppMessage.

The advertisement payload parser is a read-only adaptation of the
MIT-licensed Aranet4-Python project. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Useful primary references:

- [Aranet4 measurements](https://help.aranet.com/aranet4/aranet4-home/general/what-does-the-aranet4-do)
- [Aranet4 service UUID change](https://forum.aranet.com/aranet-home-devices-aranet4-aranet2-aranet-radiation-aranet-radon/aranet4-with-firmware-v.1.2.0-or-greater-integration-notes/)
- [Pebble communication choices](https://developer.repebble.com/guides/communication/)
- [PebbleKit Android 2](https://github.com/pebble-dev/PebbleKitAndroid2)
- [Aranet4-Python](https://github.com/Anrijs/Aranet4-Python)

## Namespaces

- Watchapp UUID: `496e29b5-9542-430b-b75a-14dbb399b884`
- Android package: `com.skarian.airquality`
- Watch cache: key `4102`, version `5`
- Android database: `airquality-readings.db`
- Notification ID/channel: `4102` / `airquality-monitor`
- QA scratch: `/private/tmp/airquality-qa-*`
- Emulator lock: `/private/tmp/pebble-emulator-qa.lock`
- Production and QA use no network port
