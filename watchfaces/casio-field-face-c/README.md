# Casio Field Face

A high-contrast digital watchface inspired by practical Casio field watches.
The Pebble Time 2 layout keeps the clock dominant, adds a compact date, and
reserves clear instrument rows for weather and battery status.

![Casio Field Face on Pebble Time 2](emulator-current.png)

The face follows the watch's 12/24-hour preference and updates once per minute.
It is implemented in native C and targets Emery.

## Build and run

```sh
pebble build
pebble install --emulator emery
```

For emulator QA, use the shared screenshot tool from this directory:

```sh
../../tools/pebble-screenshot-tool/pebble-screenshot.mjs
```

The Heeler watch references that informed the case and display direction are
preserved in [`heeler-references/`](heeler-references).
