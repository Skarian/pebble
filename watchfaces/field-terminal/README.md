# Field Terminal

An original retro-futurist CRT watchface for Pebble Time 2 (Emery), inspired by
wrist-mounted field instruments.

![Field Terminal watchface](presented_emery.png)

## Features

- User-selected 12/24-hour time
- Compact and expanded date readouts
- Battery percentage, charging state, and ten-segment gauge
- Bright mint/green display hierarchy for outdoor legibility
- Pure-green Emery backlight tint while the watchface is foregrounded
- Deterministic minute-by-minute signal plot
- Brief 350 ms phosphor sweep on minute changes
- No phone companion, network access, or continuous animation

## Build and test

```sh
pebble build
pebble install --emulator emery
pebble screenshot --no-open --emulator emery screenshot_emery.png
```

The face subscribes to `MINUTE_UNIT` only. Its animation timer runs for seven
frames after a minute update and then stops.

For local emulator captures with the backlight held on:

```sh
FIELD_TERMINAL_EMULATOR_BACKLIGHT=1 pebble build
pebble install --emulator emery --force build/field-terminal.pbw
```

The flag is compile-time and intentionally omitted from normal device builds.
Both builds use Emery's color-backlight API to request a pure green LED tint;
the system backlight color is restored when the watchface exits.
