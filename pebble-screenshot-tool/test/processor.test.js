import test from "node:test";
import assert from "node:assert/strict";

import { PALETTES } from "../palettes.js";
import {
  PEBBLE_SCREEN,
  analyzeScreenshot,
  detectSourcePalette,
  nearestPaletteIndex,
  optimizeImage,
  remapScreenshot
} from "../processor.js";

function pixel(hex, alpha = 255) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
    alpha
  ];
}

function patternedInput(width = 17, height = 13) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = (x * 13 + y * 7) % 256;
      data[offset + 1] = (x * 3 + y * 11) % 256;
      data[offset + 2] = (x * 17 + y * 5) % 256;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

function fnv1a(data) {
  let hash = 2166136261;
  for (const value of data) {
    hash ^= value;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

test("all canonical Pebble colors retain their standard palette index", () => {
  for (let index = 0; index < PALETTES.standard.length; index += 1) {
    const [r, g, b] = pixel(PALETTES.standard[index]);
    assert.deepEqual(nearestPaletteIndex(r, g, b, "standard"), { index, distance: 0 });
  }
});

test("all Pebble CLI corrected colors retain their palette index", () => {
  for (let index = 0; index < PALETTES.corrected.length; index += 1) {
    const [r, g, b] = pixel(PALETTES.corrected[index]);
    assert.deepEqual(nearestPaletteIndex(r, g, b, "corrected"), { index, distance: 0 });
  }
});

test("source palette auto-detection distinguishes corrected and standard pixels", () => {
  const corrected = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      ...pixel(PALETTES.corrected[17]),
      ...pixel(PALETTES.corrected[44])
    ])
  };
  const standard = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      ...pixel(PALETTES.standard[17]),
      ...pixel(PALETTES.standard[44])
    ])
  };

  assert.equal(detectSourcePalette(corrected), "corrected");
  assert.equal(detectSourcePalette(standard), "standard");
});

test("corrected colors remap to the corresponding display palette", () => {
  const input = {
    width: 1,
    height: 1,
    data: new Uint8ClampedArray(pixel(PALETTES.corrected[44]))
  };

  for (const target of ["standard", "corrected", "sun", "room", "backlight"]) {
    const output = remapScreenshot(input, target, "corrected");
    assert.deepEqual([...output.data], pixel(PALETTES[target][44]));
  }
});

test("off-palette colors snap to the nearest selected source entry", () => {
  const nearRed = { width: 1, height: 1, data: new Uint8ClampedArray([250, 3, 2, 255]) };
  const report = analyzeScreenshot(nearRed, "standard");
  const output = remapScreenshot(nearRed, "standard", "standard");

  assert.equal(report.offPalettePixels, 1);
  assert.deepEqual([...output.data], pixel("#FF0000"));
});

test("transparent pixels stay transparent", () => {
  const input = { width: 1, height: 1, data: new Uint8ClampedArray([123, 45, 67, 0]) };
  const output = remapScreenshot(input, "backlight");
  const report = analyzeScreenshot(input);

  assert.deepEqual([...output.data], [0, 0, 0, 0]);
  assert.equal(report.transparentPixels, 1);
  assert.equal(report.opaquePixels, 0);
});

test("native Emery dimensions are recognized", () => {
  const data = new Uint8ClampedArray(PEBBLE_SCREEN.width * PEBBLE_SCREEN.height * 4);
  const report = analyzeScreenshot({
    width: PEBBLE_SCREEN.width,
    height: PEBBLE_SCREEN.height,
    data
  });

  assert.equal(report.isNativeSize, true);
});

test("upstream default Atkinson pipeline stays byte-stable", () => {
  const result = optimizeImage(patternedInput());
  assert.deepEqual(
    Object.fromEntries(
      ["adjusted", "standard", "sun", "room", "backlight"].map((name) => [
        name,
        fnv1a(result[name].data)
      ])
    ),
    {
      adjusted: "196b11b8",
      standard: "1ffb3cad",
      sun: "89382b32",
      room: "7f58aa0a",
      backlight: "fa45a397"
    }
  );
});

test("checkerboard, brightness, and contrast pipeline stays byte-stable", () => {
  const result = optimizeImage(patternedInput(), {
    reference: "room",
    dither: "checkerboard",
    brightness: 7,
    contrast: -12
  });
  assert.deepEqual(
    Object.fromEntries(
      ["adjusted", "standard", "sun", "room", "backlight"].map((name) => [
        name,
        fnv1a(result[name].data)
      ])
    ),
    {
      adjusted: "47f215be",
      standard: "977f98cb",
      sun: "feab6852",
      room: "c7d36140",
      backlight: "8b790bde"
    }
  );
});

test("standard/off mode is a direct palette-index simulation", () => {
  const input = {
    width: 8,
    height: 8,
    data: new Uint8ClampedArray(PALETTES.standard.flatMap((color) => pixel(color)))
  };
  const result = optimizeImage(input, {
    reference: "standard",
    dither: "off",
    brightness: 0,
    contrast: 0
  });

  assert.deepEqual([...result.standard.data], [...input.data]);
  for (const target of ["sun", "room", "backlight"]) {
    assert.deepEqual(
      [...result[target].data],
      PALETTES[target].flatMap((color) => pixel(color))
    );
  }
});

test("invalid buffers and palettes are rejected", () => {
  assert.throws(
    () => remapScreenshot({ width: 2, height: 2, data: new Uint8ClampedArray(4) }),
    /one RGBA value per pixel/
  );
  assert.throws(
    () => remapScreenshot(
      { width: 1, height: 1, data: new Uint8ClampedArray(4) },
      "nope"
    ),
    /Unknown target palette/
  );
  assert.throws(
    () => nearestPaletteIndex(0, 0, 0, "nope"),
    /Unknown source palette/
  );
  assert.throws(
    () => optimizeImage(patternedInput(), { dither: "floyd-steinberg" }),
    /Unknown dithering mode/
  );
});
