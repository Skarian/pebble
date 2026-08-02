# Emulator Smoke Face

A deliberately minimal digital watchface used to verify the modern Pebble
emulator pipeline. It renders a centered seconds clock on both rectangular
Emery and round Gabbro displays.

<img src="screenshots/qa-local-gabbro-20260801.png" width="640" alt="Emulator Smoke Face on Gabbro">

## Build and run

```sh
pebble build
pebble install --emulator emery
```

This is an Alloy project: `src/embeddedjs/main.js` renders on the watch through
Moddable XS, while `src/c/mdbl.c` supplies the runtime glue.
