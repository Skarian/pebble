# Casio Field Face Alloy prototype

The original Casio-inspired Field Face prototype for Pebble Time 2. It uses
embedded JavaScript on the watch to present a large digital clock, compact date,
and reserved weather and battery areas.

![Casio Field Face running in QEMU](design-studies/original-qemu.png)

This prototype also preserves the visual explorations that led to the current
field-watch direction in [`design-studies/`](design-studies).

## Build and run

```sh
pebble build
pebble install --emulator emery
```

The Alloy build targets Emery and Gabbro. Its on-watch JavaScript is in
`src/embeddedjs/main.js`; `src/c/mdbl.c` provides the Moddable runtime glue.
