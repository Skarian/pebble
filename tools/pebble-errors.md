# `pebble-errors`

`tools/pebble-errors` queries the centralized error journal and can create a
local postmortem bundle from a connected Android phone and Pebble. Key
issuance, deletion, and backup remain server-side administrative commands.

```sh
tools/pebble-errors recent --since 30d
tools/pebble-errors recent --source agents/watch --limit 500 --json
tools/pebble-errors search invalid_grant --since 90d
tools/pebble-errors status
tools/pebble-errors collect --adb SERIAL --since 30d
```

`collect` merges server errors with package-scoped Android exit history,
target-only Crash/ANR DropBox entries, pending debug-companion outboxes, and
the watch's retained firmware log generations. It tunnels through Core's
Developer Connection with a temporary ADB forward and always removes that
forward. The default bundle is mode 0700 under
`~/Library/Logs/Pebble Diagnostics/collections/`; files are mode 0600. Raw
platform evidence remains local and is never uploaded.

Add `--coredump` only when firmware/kernel evidence is needed. The fetch
attempt may mark that watch coredump as read even if writing the local file
fails; any nonempty partial is preserved and labeled. The image may contain
secrets. Normal watch-app faults are found in the
non-destructive firmware log dump and do not require this option. Release Core
does not expose its private rolling file log or CPAP/Hubitat unsent PKJS
localStorage through stock ADB, so the manifest reports those platform limits
rather than claiming coverage.

The default endpoint is `https://pebble.exe.xyz`. Override it for local tests
with `PEBBLE_DIAGNOSTICS_URL`.

On macOS, the CLI reads the key from the `pebble-diagnostics-read` generic
password for the current account. Store a newly issued read key without putting
its value in the command history:

```sh
printf '%s' "$PEBBLE_DIAGNOSTICS_READ_KEY" | security add-generic-password -U \
  -a "$USER" -s pebble-diagnostics-read -w
unset PEBBLE_DIAGNOSTICS_READ_KEY
```

For a temporary non-macOS session, set `PEBBLE_DIAGNOSTICS_READ_KEY` in the
process environment. Do not commit it or place it in a shell profile.

Human output retains the complete serialized error. `--json` emits only arrays
of the four-field records (`at`, `source`, `while`, `error`); upload IDs and
credential metadata are never returned.
