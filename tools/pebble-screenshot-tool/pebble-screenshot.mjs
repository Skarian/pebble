#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { analyzeScreenshot, optimizeImage } from "./processor.js";

const PROCESSING = Object.freeze({
  reference: "standard",
  dither: "off",
  brightness: 0,
  contrast: 0
});
const EMULATORS = new Set([
  "aplite",
  "basalt",
  "chalk",
  "diorite",
  "emery",
  "flint",
  "gabbro"
]);
const BUTTONS = new Set(["back", "up", "select", "down"]);
let imageMagick = null;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  const options = parseArguments(argv);

  imageMagick = detectImageMagick();
  assertCommand("pebble", ["--version"], "Pebble CLI");

  const project = readProjectForCapture(options.pbw);
  const platform = selectPlatform(options.platform, project);
  const qemu = options.qemu;
  const phone = options.phone;
  const external = qemu || phone;

  const outputPath = resolve(options.output || defaultOutputPath(platform));
  if (extname(outputPath).toLowerCase() !== ".png") {
    throw new Error("Output filename must end in .png.");
  }
  if (existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite existing file: ${outputPath}`);
  }
  const pbwPath = options.pbw ? validatePbw(options.pbw) : buildProject(project);

  mkdirSync(dirname(outputPath), { recursive: true });
  const workingDirectory = mkdtempSync(join(tmpdir(), "pebble-screenshot-"));

  try {
    const paths = {
      emulator: options.originalOnly ? outputPath : join(workingDirectory, "emulator.png"),
      standard: join(workingDirectory, "standard.png"),
      sun: join(workingDirectory, "sun.png"),
      room: join(workingDirectory, "room.png"),
      backlight: join(workingDirectory, "backlight.png"),
      contactSheet: outputPath
    };

    if (!external) {
      stopManagedEmulators();
    }

    const target = qemu ? ["--qemu", qemu]
      : phone ? ["--phone", phone]
        : ["--emulator", platform];

    console.log(`${options.running ? "Capturing running" : `Installing ${pbwPath} and capturing`} ${platform}${external ? ` at ${external}` : ""}…`);
    const pebblePath = run("which", ["pebble"]).toString().trim();
    const python = join(dirname(realpathSync(pebblePath)), "python");
    const helper = join(dirname(fileURLToPath(import.meta.url)), "capture.py");
    const captureOutput = run(
      python,
      [helper, ...target, "--platform", platform,
        "--output", paths.emulator, "--pbw", pbwPath,
        "--timeout", String(options.timeout),
        ...(options.running ? ["--running"] : []),
        ...(options.monitorPort ? ["--monitor-port", String(options.monitorPort)] : []),
        ...options.buttons.flatMap((button) => ["--button", button])],
      { timeout: (options.timeout * (7 + options.buttons.length) + 10) * 1000 }
    ).toString();
    const runningMatch = captureOutput.match(/PEBBLE_SCREENSHOT_RUNNING_UUID=(\S+)/i);
    if (!runningMatch) throw new Error("Could not determine the foreground Pebble app.");
    console.log(`Foreground app ${runningMatch[1]}`);

    const image = readRgba(paths.emulator);
    const report = analyzeScreenshot(image);
    verifyRawScreenshot(report);

    if (!options.originalOnly) {
      const optimized = optimizeImage(image, PROCESSING);
      for (const variant of ["standard", "sun", "room", "backlight"]) {
        writeRgba(paths[variant], optimized[variant]);
      }
      writeContactSheet(paths);
    }

    console.log(`Created ${outputPath}`);
  } finally {
    try {
      if (!external && !options.keepEmulator) {
        stopManagedEmulators();
      }
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  }
}

export function parseArguments(argv) {
  let platform = null;
  let qemu = null;
  let phone = null;
  let pbw = null;
  const buttons = [];
  let keepEmulator = false;
  let timeout = 15;
  let output = null;
  let running = false;
  let monitorPort = null;
  let originalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--platform") {
      platform = requiredValue(argv, ++index, "--platform");
    } else if (argument === "--qemu") {
      qemu = requiredValue(argv, ++index, "--qemu");
    } else if (argument === "--phone") {
      phone = requiredValue(argv, ++index, "--phone");
    } else if (argument === "--pbw") {
      pbw = requiredValue(argv, ++index, "--pbw");
    } else if (argument === "--button") {
      const button = requiredValue(argv, ++index, "--button");
      assertButton(button);
      buttons.push(button);
    } else if (argument === "--output") {
      output = requiredValue(argv, ++index, "--output");
    } else if (argument === "--keep-emulator") {
      keepEmulator = true;
    } else if (argument === "--running") {
      running = true;
    } else if (argument === "--monitor-port") {
      monitorPort = Number(requiredValue(argv, ++index, "--monitor-port"));
      if (!Number.isInteger(monitorPort) || monitorPort < 1 || monitorPort > 65535) {
        throw new Error("--monitor-port must be a valid TCP port.");
      }
    } else if (argument === "--original-only") {
      originalOnly = true;
    } else if (argument === "--timeout") {
      timeout = Number(requiredValue(argv, ++index, "--timeout"));
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 300) {
        throw new Error("--timeout must be greater than 0 and at most 300 seconds.");
      }
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      assertButton(argument);
      buttons.push(argument);
    }
  }

  if (platform && !EMULATORS.has(platform)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  if (qemu && phone) {
    throw new Error("--qemu and --phone are mutually exclusive.");
  }
  if ((qemu || phone) && keepEmulator) {
    throw new Error("--keep-emulator is only valid for SDK-managed emulators.");
  }
  if (running && !qemu && !phone) {
    throw new Error("--running requires --qemu or --phone because the emulator is user-owned.");
  }
  if (monitorPort && !qemu && !phone) {
    throw new Error("--monitor-port requires --qemu or --phone.");
  }
  return {
    platform, qemu, phone, pbw, buttons, keepEmulator, timeout, output,
    running, monitorPort, originalOnly
  };
}

function assertButton(button) {
  if (!BUTTONS.has(button)) throw new Error(`Unsupported button: ${button}`);
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

export function readProjectForCapture(pbw, directory = ".") {
  if (pbw) return null;
  const packagePath = resolve(directory, "package.json");
  if (!existsSync(packagePath)) {
    throw new Error("Run this command from a Pebble project, or provide --pbw PATH.");
  }
  try {
    const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
    if (!metadata.pebble) throw new Error("package.json has no pebble section");
    return metadata;
  } catch (error) {
    throw new Error(`Could not read Pebble project metadata: ${error.message}`);
  }
}

function selectPlatform(requested, project) {
  const targets = project?.pebble?.targetPlatforms || [];
  if (requested) {
    if (targets.length && !targets.includes(requested)) {
      throw new Error(`Project does not target ${requested}.`);
    }
    return requested;
  }
  if (targets.includes("emery")) return "emery";
  if (targets.length === 1 && EMULATORS.has(targets[0])) return targets[0];
  if (!project) return "emery";
  throw new Error("Could not choose a platform; provide --platform NAME.");
}

function buildProject(project) {
  console.log("Building current Pebble project…");
  run("pebble", ["build"], { inherit: true });
  const buildDirectory = resolve("build");
  const preferred = [
    `${basename(resolve("."))}.pbw`,
    project?.name ? `${project.name}.pbw` : null
  ].filter(Boolean);
  for (const name of preferred) {
    const candidate = join(buildDirectory, name);
    if (existsSync(candidate)) return candidate;
  }
  const bundles = existsSync(buildDirectory)
    ? readdirSync(buildDirectory).filter((name) => extname(name).toLowerCase() === ".pbw")
    : [];
  if (bundles.length === 1) return join(buildDirectory, bundles[0]);
  throw new Error("Build succeeded, but the tool could not identify one PBW in build/.");
}

function validatePbw(path) {
  const resolved = resolve(path);
  if (!existsSync(resolved) || extname(resolved).toLowerCase() !== ".pbw") {
    throw new Error(`--pbw must name an existing .pbw file: ${resolved}`);
  }
  return resolved;
}

export function verifyRawScreenshot(report) {
  if (report.sourcePalette !== "standard" || report.offPalettePixels !== 0) {
    throw new Error("Pebble screenshot is not an unmodified raw emulator framebuffer.");
  }
}

function defaultOutputPath(emulator) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  return join("screenshots", `${emulator}-${stamp}.png`);
}

function assertCommand(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    throw new Error(`${label} is required but '${command}' was not found on PATH.`);
  }
}

export function imageMagickCommands(hasMagick) {
  return hasMagick
    ? {
        identify: ["magick", "identify"],
        convert: ["magick"],
        montage: ["magick", "montage"]
      }
    : {
        identify: ["identify"],
        convert: ["convert"],
        montage: ["montage"]
      };
}

function detectImageMagick() {
  const probe = spawnSync("magick", ["-version"], { encoding: "utf8" });
  if (!probe.error && probe.status === 0) return imageMagickCommands(true);
  for (const command of ["identify", "convert", "montage"]) {
    assertCommand(command, ["-version"], "ImageMagick");
  }
  return imageMagickCommands(false);
}

function runImageMagick(operation, args, options) {
  const [command, ...prefix] = imageMagick[operation];
  return run(command, [...prefix, ...args], options);
}

function run(command, args, { input, inherit = false, timeout, env } = {}) {
  const result = spawnSync(command, args, {
    input,
    stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    timeout,
    env
  });
  if (result.error) {
    const detail = result.stderr?.toString().trim();
    throw new Error(`${result.error.message}${detail ? `\n${detail}` : ""}`);
  }
  if (result.status !== 0) {
    const detail = inherit ? "" : `\n${result.stderr.toString().trim()}`;
    throw new Error(`${command} exited with status ${result.status}.${detail}`);
  }
  return result.stdout;
}

function stopManagedEmulators() {
  run("pebble", ["kill"], { inherit: true });
  for (const pid of emulatorPids()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + 5000;
  let running = emulatorPids();
  while (running.length && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    running = emulatorPids();
  }
  if (running.length) {
    throw new Error(`Managed emulator processes did not exit after SIGTERM: ${running.join(", ")}`);
  }
}

function emulatorPids() {
  const output = run("ps", ["ax", "-o", "pid=,command="]).toString();
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) return [];
    const command = match[2];
    return command.includes("qemu-pebble") || /\s-m\s+pypkjs(?:\s|$)/.test(command)
      ? [Number(match[1])]
      : [];
  });
}

function readRgba(path) {
  const dimensions = runImageMagick("identify", ["-format", "%w %h", path])
    .toString()
    .trim()
    .split(/\s+/)
    .map(Number);
  const [width, height] = dimensions;
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error("Could not read the emulator screenshot dimensions.");
  }

  const data = runImageMagick("convert", [path, "-alpha", "on", "-depth", "8", "rgba:-"]);
  return { width, height, data: new Uint8ClampedArray(data) };
}

function writeRgba(path, image) {
  runImageMagick(
    "convert",
    [
      "-size",
      `${image.width}x${image.height}`,
      "-depth",
      "8",
      "rgba:-",
      path
    ],
    { input: Buffer.from(image.data) }
  );
}

function writeContactSheet(paths) {
  const labeledImages = [
    ["emulator", "EMULATOR ORIGINAL"],
    ["standard", "EXPORT STANDARD"],
    ["sun", "DIRECT SUN"],
    ["room", "ROOM LIGHT"],
    ["backlight", "BACKLIGHT"]
  ].flatMap(([variant, label]) => [
    "(",
    paths[variant],
    "-set",
    "label",
    label,
    ")"
  ]);

  runImageMagick("montage", [
    ...labeledImages,
    "-filter",
    "point",
    "-resize",
    "400x456",
    "-tile",
    "3x2",
    "-geometry",
    "400x456+28+60",
    "-background",
    "#0d100e",
    "-fill",
    "#f1f3ec",
    "-stroke",
    "none",
    "-pointsize",
    "22",
    "-depth",
    "8",
    paths.contactSheet
  ]);
}

function printHelp() {
  console.log(`Usage: pebble-screenshot [BUTTON ...] [OPTIONS]

Build the current Pebble project, exercise optional buttons, and create one
labeled variants image. Managed emulators are stopped before and after capture.

Options:
  --pbw PATH       Use an existing PBW instead of building the current project
  --platform NAME  Override the project platform (Emery is preferred)
  --qemu HOST      Use a user-owned QEMU; the tool will not stop it
  --phone HOST     Use an existing pypkjs WebSocket; the tool will not stop it
  --running        Capture the already-running app without installing or launching
  --monitor-port N QEMU monitor port used for framebuffer quiescence
  --original-only  Write only the raw emulator framebuffer
  --output PATH    Override the timestamped PNG output path
  --keep-emulator  Leave the managed emulator running after capture
  --timeout SEC    Protocol event deadline (default: 15, maximum: 300)
  --button NAME    Advanced alias for a positional button

Buttons: back, up, select, down. They are clicked in command-line order.

The default output is screenshots/NAME-TIMESTAMP.png.`);
}
