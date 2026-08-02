import test from "node:test";
import assert from "node:assert/strict";

import {
  imageMagickCommands,
  parseArguments,
  readProjectForCapture,
  verifyRawScreenshot
} from "../pebble-screenshot.mjs";

test("supports ImageMagick 7 and legacy ImageMagick 6 commands", () => {
  assert.deepEqual(imageMagickCommands(true), {
    identify: ["magick", "identify"],
    convert: ["magick"],
    montage: ["magick", "montage"]
  });
  assert.deepEqual(imageMagickCommands(false), {
    identify: ["identify"],
    convert: ["convert"],
    montage: ["montage"]
  });
});

test("zero-argument defaults need no workflow knowledge", () => {
  assert.deepEqual(parseArguments([]), {
    platform: null, qemu: null, phone: null, pbw: null, buttons: [], keepEmulator: false,
    timeout: 15, output: null, running: false, monitorPort: null, originalOnly: false
  });
});

test("an external PBW ignores an unrelated current project", () => {
  assert.equal(readProjectForCapture("/elsewhere/app.pbw", "."), null);
});

test("parses positional buttons in order", () => {
  assert.deepEqual(parseArguments(["up", "up", "down"]), {
    platform: null, qemu: null, phone: null, pbw: null, buttons: ["up", "up", "down"],
    keepEmulator: false, timeout: 15, output: null,
    running: false, monitorPort: null, originalOnly: false
  });
});

test("parses advanced overrides", () => {
  assert.deepEqual(parseArguments([
    "--qemu", "localhost:63000", "--platform", "emery",
    "--pbw", "app.pbw", "--output", "out.png", "--timeout", "42",
    "--button", "select", "--running", "--monitor-port", "63001", "--original-only"
  ]), {
    platform: "emery", qemu: "localhost:63000", phone: null, pbw: "app.pbw",
    buttons: ["select"], keepEmulator: false, timeout: 42, output: "out.png",
    running: true, monitorPort: 63001, originalOnly: true
  });
});

test("rejects ambiguous or unsafe overrides", () => {
  assert.throws(() => parseArguments(["--button", "sideways"]), /Unsupported button/);
  assert.throws(() => parseArguments(["sideways"]), /Unsupported button/);
  assert.throws(() => parseArguments(["--pbw"]), /requires a value/);
  assert.throws(() => parseArguments(["--timeout", "0"]), /greater than 0/);
  assert.throws(() => parseArguments(["--timeout", "301"]), /at most 300/);
  assert.throws(
    () => parseArguments(["--qemu", "localhost:63000", "--keep-emulator"]),
    /only valid for SDK-managed/
  );
  assert.throws(() => parseArguments(["--platform", "nope"]), /Unsupported platform/);
  assert.throws(() => parseArguments(["--running"]), /requires --qemu/);
  assert.throws(() => parseArguments(["--monitor-port", "nope"]), /valid TCP port/);
  assert.throws(
    () => parseArguments(["--qemu", "localhost:1", "--phone", "localhost:2"]),
    /mutually exclusive/
  );
});

test("rejects dimmed or corrected screenshot input", () => {
  verifyRawScreenshot({ sourcePalette: "standard", offPalettePixels: 0 });
  assert.throws(
    () => verifyRawScreenshot({ sourcePalette: "standard", offPalettePixels: 12 }),
    /raw emulator framebuffer/
  );
  assert.throws(
    () => verifyRawScreenshot({ sourcePalette: "corrected", offPalettePixels: 0 }),
    /raw emulator framebuffer/
  );
});
