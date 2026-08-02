import { PALETTES } from "./palettes.js";

export const PEBBLE_SCREEN = Object.freeze({ width: 200, height: 228 });
export const SOURCE_PALETTES = Object.freeze(["standard", "corrected"]);
export const DITHER_MODES = Object.freeze(["atkinson", "checkerboard", "off"]);
export const REFERENCE_PALETTES = Object.freeze(["standard", "sun", "room", "backlight"]);

function hexToRgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ];
}

const RGB_PALETTES = Object.freeze(
  Object.fromEntries(
    Object.entries(PALETTES).map(([name, colors]) => [
      name,
      Object.freeze(colors.map(hexToRgb))
    ])
  )
);

const EXACT_INDICES = Object.freeze(
  Object.fromEntries(
    Object.entries(RGB_PALETTES).map(([name, colors]) => [
      name,
      new Map(colors.map(([r, g, b], index) => [rgbKey(r, g, b), index]))
    ])
  )
);

function rgbKey(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

function squaredDistance(r, g, b, color) {
  const dr = r - color[0];
  const dg = g - color[1];
  const db = b - color[2];
  return dr * dr + dg * dg + db * db;
}

export function nearestPaletteIndex(r, g, b, paletteName = "standard") {
  const palette = RGB_PALETTES[paletteName];
  if (!palette) throw new TypeError(`Unknown source palette: ${paletteName}`);

  const exact = EXACT_INDICES[paletteName].get(rgbKey(r, g, b));
  if (exact !== undefined) return { index: exact, distance: 0 };

  let index = 0;
  let distance = Number.POSITIVE_INFINITY;

  for (let candidate = 0; candidate < palette.length; candidate += 1) {
    const candidateDistance = squaredDistance(r, g, b, palette[candidate]);
    if (candidateDistance < distance) {
      index = candidate;
      distance = candidateDistance;
    }
  }

  return { index, distance };
}

export function detectSourcePalette({ width, height, data }) {
  validatePixelBuffer(width, height, data);

  let bestName = SOURCE_PALETTES[0];
  let bestOffPalette = Number.POSITIVE_INFINITY;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const paletteName of SOURCE_PALETTES) {
    let offPalettePixels = 0;
    let totalDistance = 0;

    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset + 3] === 0) continue;
      const match = nearestPaletteIndex(
        data[offset],
        data[offset + 1],
        data[offset + 2],
        paletteName
      );
      if (match.distance > 0) offPalettePixels += 1;
      totalDistance += match.distance;
    }

    if (
      offPalettePixels < bestOffPalette ||
      (offPalettePixels === bestOffPalette && totalDistance < bestDistance)
    ) {
      bestName = paletteName;
      bestOffPalette = offPalettePixels;
      bestDistance = totalDistance;
    }
  }

  return bestName;
}

export function analyzeScreenshot(input, sourcePalette = "auto") {
  const { width, height, data } = input;
  validatePixelBuffer(width, height, data);
  const resolvedSource = resolveSourcePalette(input, sourcePalette);

  let opaquePixels = 0;
  let transparentPixels = 0;
  let offPalettePixels = 0;
  let largestCorrection = 0;
  const usedIndices = new Set();

  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 0) {
      transparentPixels += 1;
      continue;
    }

    opaquePixels += 1;
    const match = nearestPaletteIndex(
      data[offset],
      data[offset + 1],
      data[offset + 2],
      resolvedSource
    );
    usedIndices.add(match.index);
    if (match.distance > 0) {
      offPalettePixels += 1;
      largestCorrection = Math.max(largestCorrection, Math.sqrt(match.distance));
    }
  }

  return {
    width,
    height,
    sourcePalette: resolvedSource,
    opaquePixels,
    transparentPixels,
    offPalettePixels,
    paletteColorsUsed: usedIndices.size,
    largestCorrection,
    isNativeSize: width === PEBBLE_SCREEN.width && height === PEBBLE_SCREEN.height
  };
}

export function remapScreenshot(input, target = "standard", sourcePalette = "auto") {
  const { width, height, data } = input;
  validatePixelBuffer(width, height, data);
  const targetPalette = RGB_PALETTES[target];
  if (!targetPalette) throw new TypeError(`Unknown target palette: ${target}`);
  const resolvedSource = resolveSourcePalette(input, sourcePalette);
  const output = new Uint8ClampedArray(data.length);

  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3];
    if (alpha === 0) {
      output[offset + 3] = 0;
      continue;
    }

    const { index } = nearestPaletteIndex(
      data[offset],
      data[offset + 1],
      data[offset + 2],
      resolvedSource
    );
    const [r, g, b] = targetPalette[index];
    output[offset] = r;
    output[offset + 1] = g;
    output[offset + 2] = b;
    output[offset + 3] = alpha;
  }

  return { width, height, data: output };
}

// A direct port of upstream processImage(), after the browser has decoded and
// drawn the source into its 200×228 canvas. Screenshot inputs already have the
// required dimensions, so the browser's cover-crop step is intentionally absent.
export function optimizeImage(
  input,
  {
    reference = "sun",
    dither = "atkinson",
    brightness = 0,
    contrast = 0
  } = {}
) {
  const { width, height, data } = input;
  validatePixelBuffer(width, height, data);

  if (!REFERENCE_PALETTES.includes(reference)) {
    throw new TypeError(`Unknown reference palette: ${reference}`);
  }
  if (!DITHER_MODES.includes(dither)) {
    throw new TypeError(`Unknown dithering mode: ${dither}`);
  }
  if (!Number.isInteger(brightness) || brightness < -100 || brightness > 100) {
    throw new TypeError("Brightness must be an integer from -100 to 100.");
  }
  if (!Number.isInteger(contrast) || contrast < -100 || contrast > 100) {
    throw new TypeError("Contrast must be an integer from -100 to 100.");
  }

  const referencePalette = RGB_PALETTES[reference];
  const adjusted = new Uint8ClampedArray(data);
  const floatData = new Float32Array(width * height * 3);
  const factor =
    (259 * (contrast + 255)) /
    (255 * (259 - contrast));

  for (let sourceOffset = 0, floatOffset = 0; sourceOffset < data.length; sourceOffset += 4, floatOffset += 3) {
    let r = data[sourceOffset] + brightness;
    let g = data[sourceOffset + 1] + brightness;
    let b = data[sourceOffset + 2] + brightness;

    r = factor * (r - 128) + 128;
    g = factor * (g - 128) + 128;
    b = factor * (b - 128) + 128;

    r = Math.min(255, Math.max(0, r));
    g = Math.min(255, Math.max(0, g));
    b = Math.min(255, Math.max(0, b));

    floatData[floatOffset] = r;
    floatData[floatOffset + 1] = g;
    floatData[floatOffset + 2] = b;

    adjusted[sourceOffset] = r;
    adjusted[sourceOffset + 1] = g;
    adjusted[sourceOffset + 2] = b;
  }

  const outputs = Object.fromEntries(
    ["standard", "sun", "room", "backlight"].map((name) => [
      name,
      new Uint8ClampedArray(data.length)
    ])
  );

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const floatOffset = (y * width + x) * 3;
      const targetR = floatData[floatOffset];
      const targetG = floatData[floatOffset + 1];
      const targetB = floatData[floatOffset + 2];

      const closestIndex = nearestIndexInRgbPalette(
        targetR,
        targetG,
        targetB,
        referencePalette
      );
      let finalIndex = closestIndex;

      if (dither === "checkerboard") {
        const first = referencePalette[closestIndex];
        const remainderR = targetR * 2 - first[0];
        const remainderG = targetG * 2 - first[1];
        const remainderB = targetB * 2 - first[2];
        const secondIndex = nearestIndexInRgbPalette(
          remainderR,
          remainderG,
          remainderB,
          referencePalette
        );
        if ((x + y) % 2 !== 0) finalIndex = secondIndex;
      }

      const outputOffset = (y * width + x) * 4;
      for (const name of ["standard", "sun", "room", "backlight"]) {
        const [r, g, b] = RGB_PALETTES[name][finalIndex];
        outputs[name][outputOffset] = r;
        outputs[name][outputOffset + 1] = g;
        outputs[name][outputOffset + 2] = b;
        outputs[name][outputOffset + 3] = 255;
      }

      if (dither === "atkinson") {
        const selected = referencePalette[finalIndex];
        const errorR = floatData[floatOffset] - selected[0];
        const errorG = floatData[floatOffset + 1] - selected[1];
        const errorB = floatData[floatOffset + 2] - selected[2];

        for (const [targetX, targetY] of [
          [x + 1, y],
          [x + 2, y],
          [x - 1, y + 1],
          [x, y + 1],
          [x + 1, y + 1],
          [x, y + 2]
        ]) {
          if (targetX < 0 || targetX >= width || targetY < 0 || targetY >= height) continue;
          const targetOffset = (targetY * width + targetX) * 3;
          floatData[targetOffset] += errorR * 0.125;
          floatData[targetOffset + 1] += errorG * 0.125;
          floatData[targetOffset + 2] += errorB * 0.125;
        }
      }
    }
  }

  return {
    adjusted: { width, height, data: adjusted },
    ...Object.fromEntries(
      Object.entries(outputs).map(([name, output]) => [
        name,
        { width, height, data: output }
      ])
    )
  };
}

function nearestIndexInRgbPalette(r, g, b, palette) {
  let index = 0;
  let distance = Number.POSITIVE_INFINITY;

  for (let candidate = 0; candidate < palette.length; candidate += 1) {
    const candidateDistance = squaredDistance(r, g, b, palette[candidate]);
    if (candidateDistance < distance) {
      index = candidate;
      distance = candidateDistance;
    }
  }

  return index;
}

function resolveSourcePalette(input, sourcePalette) {
  if (sourcePalette === "auto") return detectSourcePalette(input);
  if (!SOURCE_PALETTES.includes(sourcePalette)) {
    throw new TypeError(`Unknown source palette: ${sourcePalette}`);
  }
  return sourcePalette;
}

function validatePixelBuffer(width, height, data) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new TypeError("Screenshot dimensions must be positive integers.");
  }
  if (!data || data.length !== width * height * 4) {
    throw new TypeError("Screenshot data must contain one RGBA value per pixel.");
  }
}
