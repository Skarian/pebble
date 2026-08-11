# Optional error reporting

Agents, CPAP, Air Quality, and Hubitat can send source errors to Pebble Diagnostics.
Reporting is off by default. When it is off, the reporters do not open storage,
schedule uploads, or relay watch errors. A reporting or server failure never
changes an app response or watch screen.

Each stored error has four public fields: `at`, `source`, `while`, and `error`.
`error` is a bounded snapshot of the original exception, HTTP failure, Pebble
SDK result, BLE/GATT result, or C call failure. Exact configured credentials,
tokens, authorization and cookie values, transcripts, and message bodies are
replaced with `[REDACTED]`; oversized fields retain their prefix and end with
`[TRUNCATED]`.

## Enable an app

Use the app's existing settings screen:

- Agents or Air Quality: open the Android companion and choose **Configure
  error reporting**.
- CPAP or Hubitat: open the watchapp's configuration page and use **Error
  reporting**.

Create or recreate the shared **Diagnostic key** at
[pebble.exe.xyz](https://pebble.exe.xyz/diagnostics), then enter that same key in every app
you choose to enable. The service endpoint is fixed; apps do not store or ask
for it. **Send now** retries queued phone errors. Disabling reporting in one app
cancels its pending upload work and clears its local key and phone/watch queues;
it does not affect the other apps or delete records already accepted by the
server.

## Query accepted errors

The separate read key belongs in macOS Keychain, not an app or the repository.
The Diagnostic key is write-only and cannot query accepted errors. The query
tool loads the read key automatically:

```sh
tools/pebble-errors recent --since 30d
tools/pebble-errors recent --source agents/watch
tools/pebble-errors search invalid_grant
tools/pebble-errors status
```

Android keeps at most 128 queued records / 256 KiB per companion. CPAP and
Hubitat each keep at most 50 / 64 KiB in private PebbleKit JS storage. Watch
staging is 1.5 KiB for Agents, 2 KiB for CPAP and Air Quality, and 1 KiB for
Hubitat so its 32-device cache and error queue fit Pebble's guaranteed 4 KiB
persistent quota. It is drained to the phone whenever the watchapp and its
phone runtime are connected. Queue overflow is counted explicitly.

No reporter can preserve an error that occurs while reporting is disabled, an
undetectable memory corruption, or a process or device failure before the
source boundary runs. Firmware coredumps and live `App fault!` lines remain
separate platform evidence and are never inferred from a normal app exit.
