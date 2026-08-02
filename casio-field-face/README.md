# Casio Field Face

A Pebble Time 2 watchface starter built with the current Alloy JavaScript SDK.

## What it has now

- Casio-inspired instrument layout for the Time 2 (`emery`) display
- Large 24-hour time and compact date
- Reserved weather and battery/status areas
- Desktop-emulator workflow; no watch is needed to view it

## Run it on your Mac

```sh
pebble build
pebble install --emulator emery
```

The first command produces the watchface bundle. The second opens it in the
Time 2 emulator. Quit the emulator window and run the same two commands again
after making a change.

## Next steps

1. Replace the weather placeholder with data delivered through the phone app.
2. Add a tap-to-details screen for seconds, steps, and Bluetooth status.
3. Reduce refresh frequency once the layout is settled to preserve battery.

A Pebble Alloy project — embedded JavaScript on the watch, powered by Moddable
XS, alongside C.

## Building & running

```sh
pebble build                          # build for all targetPlatforms
pebble install --emulator emery       # install on the emery emulator
pebble install --phone <ip>           # install to a paired phone
```

## Target platforms

Alloy targets the modern Pebble hardware: **emery** (Pebble Time 2) and
**gabbro** (Pebble Round 2). Other platforms are currently not supported.

## Project layout

```
src/c/mdbl.c                   C glue around the Moddable runtime
src/embeddedjs/main.js         JavaScript that runs on the watch
src/embeddedjs/manifest.json   Moddable manifest
src/pkjs/index.js              PebbleKit JS (phone-side) code
package.json                   Project metadata (UUID, platforms, resources)
wscript                        Build rules — usually no need to edit
```

## Documentation

Full SDK docs and tutorials: <https://developer.repebble.com>
