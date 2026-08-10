# AppMessage connection diagnostics

Agents, CPAP, and Air Quality keep a small payload-free ring of phone/watch
fault incidents. It retains failed delivery attempts (even when a later retry
works), terminal delivery failures, request conflicts, and domain failures.
Routine lifecycle, READY, request, replay, cached-data, and success events are
available in live logs but are not persisted.

Incident records include timestamps, operation, bounded or hashed request
references, delivery attempt and batch part, transport result, and the final
domain category. Android retains the newest 64 incidents per app; CPAP retains
the newest 32. There is no time-based expiry, so an incident remains until
newer incidents fill the ring or the app's data is cleared.

The trail never contains credentials, OAuth tokens, dictation transcripts,
agent replies, ResMed bodies, sensor addresses or measurements, AppMessage
dictionaries, or raw exception messages.

## Before collecting

For an Android companion, connect the phone over USB or Android wireless
debugging, authorize this computer, and select its exact adb serial:

```sh
adb devices -l
PHONE_SERIAL='serial-from-the-first-column'
adb -s "$PHONE_SERIAL" get-state
```

For watch or PebbleKit JS logs, enable **Developer connection** in the Pebble or
Core phone app, note the displayed phone IP, and keep the computer able to reach
that address:

```sh
PHONE_IP='phone-ip-from-developer-connection'
```

## Watch logs

With the affected watchapp open, stream its current AppMessage state:

```sh
pebble logs --phone "$PHONE_IP" | rg 'appmessage event='
```

Watch logs are live only. The phone-side incident rings below persist across process
restarts so they can be collected after reconnecting the phone.

## Android companions

Opening either companion replays its bounded incident ring to
`PebbleAppMessage` in logcat. Each companion also has **Copy connection
diagnostics**, which exports the same incidents as readable JSON.

```sh
adb -s "$PHONE_SERIAL" shell am start -W -n com.skarian.agentscompanion/.MainActivity
adb -s "$PHONE_SERIAL" logcat -d -v epoch PebbleAppMessage:I '*:S'

adb -s "$PHONE_SERIAL" shell am start -W -n com.skarian.airquality/.MainActivity
adb -s "$PHONE_SERIAL" logcat -d -v epoch PebbleAppMessage:I '*:S'
```

For a debug APK, the compact underlying ring can also be preserved verbatim:

```sh
adb -s "$PHONE_SERIAL" exec-out run-as com.skarian.agentscompanion \
  cat shared_prefs/pebble_appmessage_log.xml \
  > agents-appmessage-log.xml

adb -s "$PHONE_SERIAL" exec-out run-as com.skarian.airquality \
  cat shared_prefs/pebble_appmessage_log.xml \
  > airquality-appmessage-log.xml
```

Prefer the UI export or logcat replay for diagnosis. Clearing app data or
uninstalling a companion removes its ring.

## CPAP / PebbleKit JS

CPAP stores the newest 32 sanitized fault incidents in PebbleKit JS storage. After the
phone is reachable, use either retrieval path:

1. In the Pebble or Core phone app, open Apps, select CPAP's settings control,
   and tap **Copy diagnostics** under **Connection diagnostics**.
2. Start the stream below, then open CPAP **Settings**. Saved records are
   replayed with the `CPAP_APPMESSAGE` prefix without contacting ResMed.

```sh
pebble logs --phone "$PHONE_IP"
```

CPAP distinguishes AppMessage delivery failures from `unconfigured`, `auth`,
`resmed_network`, and `resmed_service` outcomes. Its safe HTTP fields contain
only the step, numeric status, elapsed time, replay class, and response shape.
Removing CPAP or clearing Pebble phone-app data removes this ring.

## Capturing a useful failure

Reproduce the problem once, note the approximate wall-clock time and action,
then retrieve the phone ring before repeated failures rotate it out. Preserve
whether the watch showed a phone delivery/response timeout or a domain-specific
failure; that distinction is represented in the records.
