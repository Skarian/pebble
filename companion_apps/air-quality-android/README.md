# AirQuality Companion for Android

AirQuality Companion connects an Aranet4 HOME sensor directly to the
[AirQuality Pebble app](../../apps/air-quality). It reads Bluetooth
advertisements, imports up to eight days of sensor history, stores readings
locally, and sends the current view to Pebble.

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

Open the app, allow Nearby devices and notifications, choose the Aranet4, and
set the short name that should appear on the watch.
