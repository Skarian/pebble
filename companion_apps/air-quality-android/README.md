# AirQuality Companion for Android

AirQuality Companion connects an Aranet4 HOME sensor directly to the
[AirQuality Pebble app](../../apps/air-quality). It reads Bluetooth
advertisements, imports up to eight days of sensor history, stores readings
locally, and sends the current view to Pebble. Reads happen when requested by
the watch or Android app, plus one battery-optimized sync about once per day.
There is no continuous Bluetooth scan or persistent notification.
The watch receives the latest stored snapshot first, then one live reading. A
retry with the same request ID shares or replays that work instead of starting a
parallel Bluetooth scan. Missing chart history is repaired only after the
interactive response, or by the daily sync.

The setup screen shows the age of the last successful automatic sync. Optional
error reporting retains bounded snapshots of source exceptions and platform
result codes, including failed attempts that later recover. It records no
routine lifecycle, request, or success events; configured credentials, tokens,
transcripts, and message contents are redacted.

<img src="screenshots/air-quality-companion.png" width="270" alt="AirQuality Companion setup screen">

No Aranet cloud account, API key, base station, or location permission is
required on modern Android. Measurements stay on the phone and watch.

## Build and test

```sh
./gradlew testDebugUnitTest
./gradlew assembleDebug
```

Install the debug build with:

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Open the app, allow Nearby devices, choose the Aranet4, and set the short name
that should appear on the watch.

## Optional error reporting

Air Quality can opt in to source-error reporting for both the Android
companion and watch using the shared Diagnostic key. See
[`../../docs/error-reporting.md`](../../docs/error-reporting.md).
