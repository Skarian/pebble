# Hubitat for Pebble

Hubitat is an Emery/Pebble Time 2 watchapp for checking a few sensors and
devices at a glance. It can also turn selected switches on or off and lock or
unlock selected locks.

- Press **Up** or **Down** to move through Overview, device, detail, and control
  pages. The list stops at both ends.
- Press **Select** on Overview to refresh.
- Press **Select** on a controllable device to open its Control page.
- Lock controls ask for a second Select press before sending the command.
- A successful command returns to that device with its new value. If a command
  fails, press **Select** to retry or **Up/Down** to return to the list.

Each screen keeps one device, value, or action in focus. Battery, temperature,
or humidity appears only when that device reports it.

The watch saves the last successful update. Reopening uses that saved data
without contacting Hubitat. If no saved data exists, the app refreshes once.
During a refresh it shows `SYNCING...`; errors never replace the saved data.
There is no scheduled refresh. `UPDATED NOW` appears only on Overview after
data is received; press **Select** there whenever you want a new reading.

## Configure Maker API

In Hubitat:

1. Open **Apps** and add the built-in **Maker API** app.
2. Authorize only the devices this watchapp should read or control.
3. Enable the local endpoint, cloud endpoint, or both as appropriate and press
   **Update**.
4. Copy the displayed endpoint root and access token. Maker API tokens are
   authorization credentials; reset the token in Hubitat if it is exposed.
5. Note the numeric IDs from Maker API's authorized-device list.

In the Pebble mobile app, open Hubitat **Settings** and enter:

- **Maker API URL**: the instance root, for example
  `http://192.168.1.20/apps/api/123` or the equivalent Hubitat cloud API root.
  Do not include `/devices`, a trailing slash, or `?access_token=...`.
- **Access token**: the token displayed by that same Maker API instance.
- **Device IDs**: up to six comma-separated numeric IDs, such as
  `17, 42, 108`. Every ID must be authorized in that Maker API instance.

Save Settings, return to the watch, and press **Select** to sync. Saving never
starts a background read.

The phone connects directly to Maker API; no companion app or production
bridge is required. The URL, token, and selected IDs live in this app's private PebbleKit JS
`localStorage` on the phone. PebbleKit JS does not expose the OS keychain. The
watch receives normalized device data and selected numeric IDs, but never the
Maker API URL or access token. Sanitized durable diagnostics retain only error
type/status/message and never retain a URL, token, device ID, or device value.

Maker API uses HTTP GET for reads and commands. This implementation reads
`/devices/all` and invokes only the four-command allowlist above at
`/devices/{id}/{command}`. A command that a driver advertises is not necessarily
permitted by Maker API; failures remain visible on the watch.

Primary references, checked 2026-08-02:

- [Hubitat Maker API documentation](https://docs2.hubitat.com/en/apps/maker-api)
- [Hubitat Device Detail documentation](https://docs2.hubitat.com/en/user-interface/devices/device-detail)

## Build, test, and visual QA

From this directory:

```sh
npm test
pebble build
npm run qa
```

`npm run qa` is the one-command pre-login review. It builds the normal
production PBW, starts the external loopback-only QA bridge on
`127.0.0.1:8896`, injects normal typed AppMessages into that production app,
and writes individual screens plus a numbered `all-states.png` beneath the
ignored `qa-results/` directory. The production C and PebbleKit JS contain no
fixtures, QA modes, scenario names, or test navigation.

The board covers setup, loading with and without cache, overview, motion,
contact, temperature, battery, switch, lock, detail, safe control, dangerous
confirmation, empty selection, missing and partial data, auth, phone/network,
timeout, service, and command pending/success/failure. It also verifies that an
old timestamp does not add a stale-data screen or change the Overview.

Fake data is always the default and performs zero Maker API requests. The QA
runner atomically waits for `/private/tmp/pebble-emulator-qa.lock` without a
startup deadline, launches only its own QEMU process, uses isolated Emery
flash, restores prior flash, and releases the lock on all exits. It never runs a
global emulator kill or resets another task's emulator.

Optional live QA is explicit:

```sh
cp .env.example .env
chmod 600 .env
# Edit .env: set HUBITAT_QA_SOURCE=live and the real Maker URL/token.
npm run qa
```

Live QA caches the response owner-only in ignored
`data/qa-live-cache.json` for 24 hours. A normal rerun uses the cache and makes
zero upstream requests. To refresh explicitly:

```sh
HUBITAT_QA_REFRESH_LIVE=1 npm run qa
```

Even a refreshed run makes at most one Maker API request. Live QA never sends a
device command and live screens should not be committed or used as marketing
artifacts.

The installable artifact is:

```text
build/hubitat.pbw
```

Install to the emulator only while holding the shared lock, or install to a
connected physical watch with the normal Pebble CLI workflow.

## Isolation identifiers

| Concern | Hubitat value |
| --- | --- |
| App UUID | `e3f31c74-63d6-4d6d-a8c7-1f8540ad2a59` |
| QA loopback port | `8896` |
| Watch cache header | persist key `7300` |
| Watch device slots | persist keys `7310`–`7315` |
| Phone settings | `hubitat.settings.v1` |
| Phone diagnostics | `hubitat.diagnostics.v1` |
| Flash backup prefix | `emery.hubitat-qa-backup-*` |
| QA output | `hubitat/qa-results/all-screens-*-*/` |
| Live cache | `hubitat/data/qa-live-cache.json` |

## Project layout

- `src/c/main.c` — bounded watch UI, last-good persistence, confirmation, and
  AppMessage protocol.
- `src/pkjs/index.js` — phone settings, direct Maker API reads, and controls.
- `src/common/` — normalization, URL/client rules, and sanitized diagnostics.
- `qa/` — external deterministic/live QA data and loopback bridge.
- `scripts/qa-screenshots.mjs` — build, isolated emulator session, injection,
  capture, board assembly, and deterministic cleanup.
- `test/` — normalization, security, request/cache, QA, and isolation contracts.
