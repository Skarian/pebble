# Pebble screenshot variants

A small CLI that captures a Pebble emulator and creates one labeled
PNG containing:

- emulator original;
- standard export;
- direct sun;
- room light;
- backlight.

## Run it

From a Pebble project:

```sh
../pebble-screenshot-tool/pebble-screenshot.mjs
```

That command builds the project, prefers Emery when the project supports it,
starts a clean SDK-managed emulator, installs and verifies the PBW, captures the
raw framebuffer, creates the variants image, and stops the emulator.

The result is written to:

```text
screenshots/emery-YYYYMMDD-HHMMSS.png
```

List buttons positionally to reach a state before capture:

```sh
../pebble-screenshot-tool/pebble-screenshot.mjs up up down
```

The default output is timestamped under `screenshots/`. Advanced overrides are
available without complicating normal use:

```sh
../pebble-screenshot-tool/pebble-screenshot.mjs \
  --pbw build/cpap.pbw \
  --platform chalk \
  --output screenshots/comparison.png \
  up up
```

- `--pbw PATH` skips the automatic build.
- `--platform NAME` overrides project platform selection.
- `--output PATH` overrides the timestamped filename.
- `--keep-emulator` leaves a managed emulator running for debugging.
- `--timeout SEC` changes protocol-event deadlines, never adds a settling sleep.

Target an isolated or headless QEMU directly with:

```sh
../pebble-screenshot-tool/pebble-screenshot.mjs \
  --qemu localhost:63000 \
  --platform emery \
  --output comparison.png
```

Managed-emulator captures are self-contained: the tool stops SDK-managed
emulators before capture and again on exit, including failures. Explicit
`--qemu` targets are user-owned and are never stopped by the tool.
Managed capture starts QEMU directly and does not launch pypkjs; phone-side
JavaScript and API bridges should be tested separately.

For an app already running under a user-owned QEMU, `--running` skips install
and launch while still verifying the foreground UUID. `--monitor-port` restores
framebuffer-quiescence detection for that external emulator, and
`--original-only` emits the raw framebuffer instead of the five-variant sheet.
Use `--phone HOST:PORT` instead of `--qemu` when pypkjs already owns QEMU's
serial connection. Screenshots use the existing WebSocket; when
`--monitor-port` is also supplied, buttons use QEMU monitor key events so a
legacy pypkjs relay bug cannot drop the connection.

The tool captures the raw emulator framebuffer. For managed emulators,
installation, button input, foreground verification, and capture share one
Pebble connection, so the simulated LCD backlight cannot alter the captured
colors and a debugger cannot pause the emulator. Install confirmation,
foreground state, and screenshot completion are protocol events rather than
fixed settling delays. Button packets are sent in command-line order and the
foreground app is checked after each click, but Pebble QEMU does not provide an
app-level acknowledgement that a click handler completed. Managed captures wait
for framebuffer quiescence before final capture. Intermediate screenshots are
created in a temporary directory and removed after the labeled variants image is
assembled.

The internal streaming capture mode can keep one direct connection open for a
multi-screen QA run, accept generic typed AppMessages, inject ordered buttons,
and capture each settled framebuffer. It is used by app-owned QA scripts such as
CPAP's `npm run qa:screenshots`; no app-specific scenario logic lives in this
tool. Normal one-shot CLI use remains unchanged. The tool does not use `-fresh`
or wipe the emulator's persisted flash.

## Requirements

- Node.js
- ImageMagick 7 (`magick`) or ImageMagick 6 (`identify`, `convert`, and `montage`)
- Pebble CLI (`pebble`)

There are no npm dependencies.

## Roadmap

- [ ] Add `pebble-screenshot setup`: detect the host, install or locate
  `pebble-tool`, invoke the official SDK installer, validate ImageMagick, and
  run a smoke capture without redistributing the Pebble SDK or emulator.

## Processing

The processor is a byte-for-byte port of the upstream image algorithm. For
screenshots it uses the fixed, palette-preserving settings:

```text
reference=standard
dither=off
brightness=0
contrast=0
```

Raw emulator input preserves all 64 palette indices. Pebble CLI-corrected input
does not, so the CLI always captures with `--no-correction`.

## Test it

```sh
cd pebble-screenshot-tool
npm test
```

The tests use Node's built-in test runner and have no package dependencies.

The slower emulator integration test is separate. It builds a deterministic
watchapp, starts a clean QEMU for each trial, injects ordered button sequences,
and verifies the exact state encoded in the raw framebuffer:

```sh
npm run test:emulator-input
```

Use `npm run test:emulator-input -- --quick` for a small development smoke test.
The full run never retries button input and preserves raw evidence under
`integration/failures/` if a trial fails.

Run the deterministic platform matrix with:

```sh
npm run test:platforms -- --output-dir qa-results/platform-run
```

It checks native framebuffer dimensions, palette integrity, and successful
contact-sheet generation on Aplite, Basalt, Chalk, Diorite, Emery, Flint, and
Gabbro. Ordered button state is verified on the six C-fixture platforms; Gabbro
uses a Moddable render fixture because SDK 4.17 does not launch the C fixture.

## Attribution

Adapted from
[czmanix/pebble-color-optimizer](https://github.com/czmanix/pebble-color-optimizer)
at commit `d0609657e0a1d41241c84954855b19a7547ba9c6`.

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
