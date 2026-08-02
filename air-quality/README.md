# AirQuality for Pebble

AirQuality is an Emery/Pebble Time 2 watchapp for one Aranet Cloud sensor. It
shows the current US AQI, PM2.5, CO2, temperature, and humidity, followed by a
seven-day graph for each value.

The current page uses progressively less-happy faces for Aranet PM Sensor's six
official US AQI bands: Good (0–50), Moderate (51–100), Unhealthy for Sensitive
Groups (101–150), Unhealthy (151–200), Very Unhealthy (201–300), and Hazardous
(301+). The numeric AQI remains the primary value; the face is only a quick
visual summary.

- Open the app to show the last saved reading and refresh it.
- Press **Down** or **Up** to move through the current page and five graphs.
  The list stops at each end.
- Press **Select** to refresh.
- Open AirQuality's **Settings** in the Pebble phone app to connect Aranet.

The watch keeps the last good reading. While refreshing it shows `SYNCING...`.
If a refresh fails, saved data stays visible with a short error footer. Missing
values use a dash instead of zero. AirQuality describes readings but does not
give medical advice.

## Connect Aranet

In AirQuality Settings, enter:

1. **Aranet sensor ID**
2. **Aranet API key**
3. **Name on watch** — choose a short location name, such as Home or Office

Press **Save and refresh**. The API key stays in this app on your phone and is
never sent to the watch.

Create the key in Aranet Cloud under **Settings → API → Create New**. Your
account needs **Integrations Write** permission. The sensor must be connected to
Aranet Cloud through an Aranet PRO/PRO+ base or gateway; Aranet4 Home/MINI by
itself does not provide the Cloud API used here.

The phone makes one direct seven-day Aranet request per refresh. There is no
companion app or production bridge. Aranet does not publish a numeric rate
limit, so the app does not poll automatically and handles a rate-limit response
as a normal error. US AQI is calculated from PM2.5 with the current EPA
breakpoints.

Official references:

- [Aranet Cloud API help](https://help.aranet.com/aranet-cloud-page/aranet-cloud-landing-page/integrations-and-extensions/cloud-api)
- [Aranet Cloud OpenAPI](https://aranet.cloud/openapi/)
- [Aranet Cloud API terms](https://aranet.cloud/public-api-terms-and-conditions)
- [Aranet PM Sensor AQI bands](https://assets.aranet.com/documents/Aranet_Datasheet_TDSPPM02_PM_sensor.pdf)
- [EPA AQI breakpoints](https://aqs.epa.gov/aqsweb/documents/codetables/aqi_breakpoints.html)
- [PebbleKit JS XMLHttpRequest](https://developer.rebble.io/guides/communication/using-pebblekit-js/)

## Build and test

```sh
cd air-quality
npm test
pebble build
```

The PBW is `build/air-quality.pbw`.

## Review every screen with fake data

```sh
cd air-quality
AIRQUALITY_QA_SOURCE=fake npm run qa
```

This one command tests and builds the production PBW, then creates a numbered
`qa-results/.../all-states.png` board. It covers setup, syncing,
healthy/elevated/hazardous readings, missing and stale data, every graph, and
all refresh failures. Fake data comes from the QA script; the production app
contains no fixtures, hidden navigation, localhost route, or QA mode.

The left side of each header shows this user-chosen name; the right side shows
the current statistic. `HOME` on the fake QA board is only an example and is
not read from Aranet automatically.

If Aranet omits one current reading, that row shows `--` while the other values
remain visible. If its seven-day response omits readings, the matching graph
shows gaps or `NO HISTORY`. The update line always describes the age of the
usable data on screen; the watch does not use an unexplained "partial" label.

The watch UI follows CPAP's proven type hierarchy: a 42-point primary value,
24-point bold metric rows and chart statistics, 28-point state titles, and
18-point bold state copy and button instructions. Labels are shortened instead
of shrinking their text.

The runner waits for `/private/tmp/pebble-emulator-qa.lock`, uses isolated Emery
flash, stops only the QEMU process it started, restores the previous flash, and
releases the lock on every exit.

## Optional live QA later

When Aranet developer access is ready, create ignored owner-only
`air-quality/.env` with:

```text
ARANET_API_KEY=...
ARANET_SENSOR_ID=...
ARANET_LOCATION=Office
```

Run `AIRQUALITY_QA_SOURCE=live npm run qa`. Live results are cached for 24 hours
in ignored `data/qa-live-cache.json`. A normal rerun makes no Aranet request;
`AIRQUALITY_QA_REFRESH_LIVE=1` makes at most one request in that run.

## Diagnostics and namespaces

The phone keeps the latest 12 failures as timestamp, error type, HTTP status,
step, and replay code. Opening Settings reprints them with the
`AIRQUALITY_DIAGNOSTIC` prefix. API keys, sensor IDs, locations, response bodies,
and readings are never logged.

- UUID: `496e29b5-9542-430b-b75a-14dbb399b884`
- Watch cache: key `4101`, version `1`
- QA scratch: `/private/tmp/airquality-qa-*`
- Flash backup: `.airquality-qa-backup-*`
- Production and QA use no loopback port
