# CPAP development notes

CPAP is an Emery/Pebble Time 2 watchapp that shows the ResMed myAir score,
usage, events per hour, mask-off count, and mask leak for yesterday and the six
preceding calendar days. The footer shows how recently the seven-day snapshot
was updated.

- Open the app to show yesterday's saved score. If yesterday is missing, the
  app performs one blocking refresh first.
- Press **Up** for an older day.
- Press **Down** for a newer day. From yesterday, continue Down through the
  seven-day Score, Usage, Events, Mask Off, and Leak graphs.
- Press **Select** to force a blocking refresh.
- Open the app's **Settings** in the Pebble phone app to connect ResMed.
- Starting at 10 AM watch time, CPAP checks silently every two hours through
  10 PM for a newer available score. It opens itself only when one arrives.

The watch persists the last successful seven-day snapshot. Once yesterday's
score is present, reopening the app uses that snapshot without contacting
ResMed. A new day or a missing score triggers one launch refresh; Select always
forces one. During a refresh the app shows `SYNCING...` until the attempt either
succeeds or produces an error. Automatic checks are different: the watch arms
the next wakeup before requesting data, shows no loading or failure screen, and
exits when ResMed still has no newer score. A successful update pauses checks
until 10 AM the following day; otherwise they continue every two hours through
10 PM and resume at 10 AM. The app compares the newest available record rather
than waiting for a particular calendar date, so a missing day does not prevent
the following day's score from opening the app. No ResMed credential, API token,
email address, or device identifier is ever sent to or stored on the watch.

The phone retries the complete ResMed operation once after a one-second delay
only for connection failures, timeouts, and upstream `502`, `503`, or `504`
responses. Authentication failures, rate limits, and other client errors are
never retried. The watch and phone each allow 30 seconds for the blocking
refresh; individual upstream HTTP requests time out after 12 seconds.

### Durable diagnostics

The phone retains the latest twelve failed ResMed operations in its private
PebbleKit JS storage. Each entry contains the time, refresh or connection
context, failing protocol step, HTTP status, elapsed time, both retry attempts,
and a replay code plus redacted response structure. Only JSON keys and value
types are retained from an upstream response; passwords, OAuth tokens,
authorization codes, email addresses, response values, and sleep records are
not logged.

There are two ways to retrieve an older failure:

1. Open CPAP's settings in the Pebble mobile app and tap **Copy diagnostics**.
2. Start `pebble logs --phone PHONE_IP`, then open CPAP's settings. The phone
   re-emits every saved entry with the `CPAP_DIAGNOSTIC` prefix without making
   a ResMed request.

The `replay` field identifies the exact simulated failure to construct in the
client tests, such as `http:sleep-records:503`,
`transport:authorization:timeout`, or
`parse:sleep-records:missing-items`. Diagnostics survive app and phone runtime
restarts, but uninstalling CPAP or clearing the Pebble app's data removes them.

The day details and graphs form one bounded vertical list: the oldest day is at
the top, yesterday sits below the other day pages, and the five graphs sit below
yesterday. Graph bars run oldest-to-yesterday from left to right. Missing days
use a dash instead of a zero-height bar.

## Direct ResMed connection

ResMed does not publish a supported patient myAir API. CPAP's PebbleKit JS
component runs inside the Pebble mobile app and performs the undocumented USA
Okta OAuth/PKCE flow directly. Okta's `okta_post_message` response mode lets it
read the authorization result without a separate server. It then queries the
ResMed AppSync GraphQL endpoint and sends only normalized nightly records to
the watch.

The ResMed email and password entered in CPAP Settings are stored in this app's
private PebbleKit JS `localStorage` on the phone. PebbleKit JS does not provide
keychain or keystore access. OAuth tokens are cached until shortly before they
expire so most refreshes do not send the password to Okta again. Credentials
and tokens are never sent to or stored on the watch.

This USA-only implementation follows the `NA` path and reads `startDate`,
`sleepScore`, `totalUsage`, `ahi`, `maskPairCount`, and `leakPercentile` in one
request, following the upstream live smoke test at commit
`ebddc0e71a7ac6d80b2421fe1dbad9c95d454731`. Despite its historical API name,
`leakPercentile` is displayed in liters per minute, matching the current
integration definition.

- <https://github.com/prestomation/resmed_myair_sensors/blob/ebddc0e71a7ac6d80b2421fe1dbad9c95d454731/scripts/live_smoke_test.py>
- <https://github.com/prestomation/resmed_myair_sensors/blob/ebddc0e71a7ac6d80b2421fe1dbad9c95d454731/custom_components/resmed_myair/client/auth.py>
- <https://github.com/prestomation/resmed_myair_sensors/blob/ebddc0e71a7ac6d80b2421fe1dbad9c95d454731/custom_components/resmed_myair/client/rest_client.py>

The integration may stop working whenever ResMed changes those private endpoints. Do not rely on this app for diagnosis or treatment decisions.

## Test live scores in the emulator

The one-command visual QA runner builds the normal production PBW and creates a
single review board containing every watch-visible state: setup, loading, auth,
network and service failures with and without cache, partial data, all seven
day pages, all five graphs, missing graph data, and relative update-time
variants. Scenario data is supplied by the loopback development bridge; the
watch app contains no QA fixtures, flags, or alternate behavior. The QA runner
uses the screenshot tool's direct QEMU session as a lightweight test phone: it
requests controlled bridge responses, delivers normal typed AppMessages, sends
real emulator button events, and captures the production app after each display
settles. It does not launch the unstable pypkjs JavaScript runtime.

The runner automatically chooses its optional live-data behavior:

- If both ResMed credentials exist in `.env`, it adds one live-data screen.
- If `.env` is missing or still contains the example placeholders, it uses a
  deterministic state matrix and makes no ResMed request.

Run it with:

```sh
npm run qa:screenshots
```

Individual screens and `all-states.png` are written beneath the ignored
`qa-results/` directory. The runner uses isolated Emery flash; PebbleKit JS
storage is not involved. It restores the developer's previous emulator flash
and stops its QEMU process even after failures. Set
`CPAP_QA_SOURCE=fake` for a no-network run even when credentials exist.

Live records are stored owner-only in ignored `data/qa-live-cache.json` and
reused for 24 hours. A run makes at most one ResMed request, even when explicitly
refreshed with `CPAP_QA_REFRESH_LIVE=1`; routine reruns normally make zero.

For live QA, use this exact file:

```text
/Users/nskaria/projects/pebble/apps/cpap/.env
```

The file already exists in this checkout with owner-only permissions. If it is
missing in a new checkout, create it from the example, then put your ResMed email
and password in the two `MYAIR_` fields:

```sh
cp .env.example .env
chmod 600 .env
```

`.env` is gitignored and is read only by the local QA bridge; the credentials
are not bundled into the PBW or copied into the phone app. Do not run the bridge
under shell tracing, print or attach `.env`, or use real-score screenshots as
project or marketing artifacts.

Local development mode, `127.0.0.1`, and port `8787` are defaults owned by the
development command and bridge. They do not belong in `.env`. Advanced direct
bridge launches can still override `CPAP_DEV_EMULATOR`, `CPAP_BRIDGE_HOST`, or
`CPAP_BRIDGE_PORT` through the process environment.

For the normal interactive development workflow, run one command:

```sh
npm run dev
```

It stops stale emulators, builds the production PBW, starts the real loopback
bridge using `.env`, installs CPAP in Emery, and leaves the emulator open. Press
Ctrl+C when finished; the command stops its bridge and emulator. This workflow
is independent of `qa:screenshots` and contains no scenario injection.

To run only the development bridge for advanced debugging:

```sh
npm run dev:bridge
```

QEMU automatically uses the development bridge at `127.0.0.1:8787`. A real
watch never uses this route. Press **Up** and **Down** to inspect the seven days.
The settings flow described below remains available for testing the physical-watch
path.

## Connect a physical watch

Install `build/cpap.pbw`, then open CPAP's Settings in the Pebble mobile app and
enter the USA ResMed myAir email and password. Press **Save and connect**. No
bridge URL, server, setup token, or running computer is required.

For local-Wi-Fi developer installation:

```sh
pebble install --phone PHONE_IP build/cpap.pbw
```

Or use the current Pebble cloud developer connection:

```sh
pebble install --cloudpebble build/cpap.pbw
```

## Build and test

```sh
npm test
pebble build
pebble install --emulator emery
```

The resulting installable bundle is `build/cpap.pbw`.

## Project layout

- `src/c/main.c` — Emery watch UI, button navigation, cache, and AppMessage handling.
- `src/pkjs/index.js` — phone settings and watch communication.
- `src/common/resmed_client.js` — direct USA myAir OAuth/PKCE and GraphQL client.
- `src/common/sha256.js` — small ES5 SHA-256 implementation used for PKCE.
- `src/common/cpap_model.js` — seven-day date and nightly-metric normalization.
- `bridge/` — loopback-only emulator development and deterministic QA service.
