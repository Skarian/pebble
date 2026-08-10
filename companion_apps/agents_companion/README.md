# Agents Android companion

Agents is the headless-first Android mediator between the **Agents** Pebble
watchapp and the separately installed `codex-router` CLI in Termux.
The Activity is only a setup and health surface; agent definitions, task IDs,
working directories, models, and reasoning settings remain owned by
`~/.codex-router.toml`.

The matching Pebble watchapp lives in `apps/agents`. Its fixed UUID is
`bba3f38f-53e5-458b-9d5f-0bcdb68ffd47`; the listener rejects traffic from
other watchapps.

## Runtime shape

1. Core binds `AgentsPebbleListenerService` through PebbleKit2 while the
   matching watchapp is open. This wakes the companion without a persistent
   Android daemon.
2. The listener serves cached agents immediately and refreshes them by running
   `codex-router agents list --json` in Termux.
3. A confirmed watch transcript includes only a configured agent ID, text,
   request ID, and output mode.
4. The companion cold-starts the installed `codex-router` through Termux's
   supported `RUN_COMMAND` intent.
5. Final mode returns the terminal JSON object through Termux's result
   `PendingIntent`. Streaming mode additionally forwards JSONL events over an
   authenticated IPv4 `127.0.0.1` socket owned by a short-lived foreground
   service.
6. Progress and the final result are sent to the watch through PebbleKit2. The
   phone also receives a result notification.
7. The companion durably caches the newest messages per agent. The watch asks
   for a bounded history snapshot when Messages is opened, so watch restarts
   and watchapp reinstalls do not erase conversation history.

There is no persistent service in Termux, no local HTTP API, no arbitrary
command execution surface, and no configuration editor in the app.

## Termux environment

The companion launches the fixed Termux bootstrap
`/data/data/com.termux/files/usr/bin/login -lc`. The configured login shell
initializes the user's environment, then hands execution to Termux Bash. Both
`node` and the fixed command name `codex-router` resolve from the resulting
`PATH`, matching a normal login environment instead of the incomplete base
environment supplied directly to external `RUN_COMMAND` jobs.

Keep executable-path changes in login-shell startup files such as
`~/.profile`, `~/.bash_profile`, or `~/.zprofile`.

## PebbleKit2 contract

The companion uses `io.rebble.pebblekit2:client:1.2.0`. The Agents PBW lists
`com.skarian.agentscompanion` in its `pebble.companionApp.android.apps`
metadata so Core is allowed to bind this app.

AppMessage keys:

| Key | Direction | Meaning |
| --- | --- | --- |
| `0` | both | command/event kind |
| `1` | both | request ID |
| `2` | watch to phone | configured agent ID |
| `3` | both | confirmed transcript or response text |
| `4` | watch to phone | `0` final JSON, `1` streaming; defaults to streaming |
| `5` | phone to watch | agent count |
| `6` | phone to watch | stable router error code |
| `7` | phone to watch | zero-based response chunk index |
| `8` | phone to watch | total response chunk count |
| `9` | both | protocol version (`1`) |
| `10` | both | monotonic event sequence / last applied sequence |
| `11` | phone to watch | flags: truncated, ambiguous, cached, or user-authored |
| `100+` | phone to watch | paired agent ID and label fields |

Watch commands are `1` refresh agents, `2` send, `3` reconcile, and `4`
request history. Phone
events are `10` agents, `11` accepted, `12` commentary, `13` completed, `14`
failed, `15` status unknown, `16` agent refresh failed, `17` history item, and
`18` history end.
Incoming Pebble numeric values are accepted in their PebbleKit2-normalized
32-bit form. Every message carries protocol version `1`. The companion
durably stores one request-bound turn and replays or reconciles it instead of
starting a duplicate. Watch projections are UTF-8-safe, visibly truncated at
5,600 bytes, and split into at most eight 700-byte chunks with one shared
event sequence.

History is stored per agent in the companion's private app data, deduplicated
by request/event identity, and bounded to the newest 20 messages per agent.
Snapshots sent to the watch retain the newest suffix that fits the watch's
16-message and 18,000-byte limits. Uninstalling the companion or clearing its
Android app data clears this cache; reinstalling the watchapp does not.

The Termux bridge forwards live events over loopback but keeps the
`PendingIntent` result bounded to the terminal JSON event. That terminal result
remains authoritative after Android service/process loss. Ambiguous outcomes
are rendered as **STATUS UNKNOWN** and are never automatically resubmitted.

## Build and test

```sh
./gradlew testDebugUnitTest lintDebug assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The setup screen's **Copy connection diagnostics** action exports the bounded,
payload-free AppMessage trail. Exact UI, logcat, and debug-APK retrieval steps
are in [`../../docs/appmessage-diagnostics.md`](../../docs/appmessage-diagnostics.md).

## Phone setup

In Termux:

1. Install and validate `codex-router`.
2. Create `~/.codex-router.toml`.
3. Add `allow-external-apps=true` to `~/.termux/termux.properties`.
4. Run `termux-reload-settings` or restart Termux.

Then open Agents and grant **Run commands in Termux environment** and result
notifications. **Refresh agents** verifies discovery; **Run doctor** checks
the router, Codex, configured directories, app-server, and task IDs.

## Verification

Verified on a Samsung SM-S916U on 2026-08-04:

- the production health screen detected Core and the connected Pebble;
- login-shell agent discovery found `vm`, `tv`, and `dummy`;
- Router Doctor passed config, Codex CLI 0.146.0, every working directory,
  the app-server proxy, and every configured task;
- the PebbleKit2 listener is exported under the documented
  `io.rebble.pebblekit2.RECEIVE_DATA_FROM_WATCH` action;
- unit tests, Android lint, and debug APK assembly pass.

The earlier spike also validated both execution modes on this phone: final
JSON completed successfully, while streaming delivered commentary during an
active turn and reconciled with the final Termux `PendingIntent`. End-to-end
watch messaging is now ready for physical-device validation with the PBW in
`apps/agents/build/agents.pbw`.
