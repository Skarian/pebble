#!/usr/bin/env python3

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import png

from input_stress import CAPTURE, FIXTURE, PBW, expected_rgb, expected_state, run, stop_emulators


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "pebble-screenshot.mjs"
DISPLAY_FIXTURE = ROOT / "integration" / "display-state"
DISPLAY_PBW = DISPLAY_FIXTURE / "build" / "display-state.pbw"
PLATFORMS = {
    "aplite": (144, 168, False),
    "basalt": (144, 168, True),
    "chalk": (180, 180, True),
    "diorite": (144, 168, False),
    "emery": (200, 228, True),
    # SDK 4.17's Flint emulator exposes a monochrome framebuffer.
    "flint": (144, 168, False),
    "gabbro": (260, 260, True),
}
BUTTONS = ["up", "select", "down"]


def read_rgb(path):
    width, height, rows, _ = png.Reader(filename=str(path)).asRGB8()
    return width, height, list(rows)


def pixel(rows, x, y):
    row = rows[y]
    return tuple(row[x * 3:x * 3 + 3])


def decode_bits(width, rows):
    cell, gap = 10, 2
    start_x = (width - (6 * cell + 5 * gap)) // 2
    value = 0
    for bit in range(6):
        value = (value << 1) | (pixel(rows, start_x + bit * (cell + gap) + 5, 13) == (0, 0, 0))
    return value


def capture_raw(platform, output, pbw, buttons):
    command = [
        sys.executable, str(CAPTURE), "--emulator", platform, "--platform", platform,
        "--output", str(output), "--pbw", str(pbw), "--timeout", "25",
    ]
    for button in buttons:
        command.extend(["--button", button])
    result = run(command, cwd=ROOT, timeout=240)
    if result.returncode:
        raise RuntimeError("{} raw capture failed:\n{}".format(platform, result.stderr))


def capture_contact(platform, output, pbw, buttons):
    command = [
        "node", str(CLI), "--pbw", str(pbw), "--platform", platform,
        "--output", str(output), *buttons,
    ]
    result = run(command, cwd=FIXTURE, timeout=300)
    if result.returncode:
        raise RuntimeError("{} contact sheet failed:\n{}".format(platform, result.stderr))


def identify(path):
    command = ["magick", "identify"] if shutil.which("magick") else ["identify"]
    result = subprocess.run(
        [*command, "-format", "%w %h", str(path)],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return tuple(map(int, result.stdout.split()))


def verify(platform, directory):
    width, height, color = PLATFORMS[platform]
    raw = directory / "{}-raw.png".format(platform)
    contact = directory / "{}-contact.png".format(platform)
    is_display_fixture = platform == "gabbro"
    fixture = DISPLAY_FIXTURE if is_display_fixture else FIXTURE
    pbw = DISPLAY_PBW if is_display_fixture else PBW
    buttons = [] if is_display_fixture else BUTTONS
    stop_emulators()
    capture_raw(platform, raw, pbw, buttons)
    actual_width, actual_height, rows = read_rgb(raw)
    if (actual_width, actual_height) != (width, height):
        raise RuntimeError("{} expected {}x{}, got {}x{}".format(
            platform, width, height, actual_width, actual_height))

    allowed = {0, 85, 170, 255} if color else {0, 255}
    if any(channel not in allowed for row in rows for channel in row):
        raise RuntimeError("{} raw framebuffer contains off-palette channels".format(platform))

    decoded = None
    if is_display_fixture:
        if len({tuple(row[index:index + 3]) for row in rows for index in range(0, len(row), 3)}) < 2:
            raise RuntimeError("{} display fixture rendered a uniform framebuffer".format(platform))
    else:
        expected = expected_state(BUTTONS)
        decoded = decode_bits(width, rows)
        if decoded != expected:
            raise RuntimeError("{} expected state {}, decoded {}".format(platform, expected, decoded))
        if color and pixel(rows, width // 2, height // 2) != expected_rgb(expected):
            raise RuntimeError("{} center pixel does not encode state {}".format(platform, expected))

    stop_emulators()
    capture_contact(platform, contact, pbw, buttons)
    contact_size = identify(contact)
    stop_emulators()
    return {
        "platform": platform,
        "color": color,
        "rawSize": [width, height],
        "contactSize": list(contact_size),
        "buttonState": decoded,
        "fixture": fixture.name,
        "raw": raw.name,
        "contact": contact.name,
    }


def main():
    parser = argparse.ArgumentParser(description="Cross-platform Pebble screenshot matrix")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("platform", nargs="*", choices=PLATFORMS)
    args = parser.parse_args()
    platforms = args.platform or list(PLATFORMS)
    output = Path(args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=False)

    build = run(["pebble", "build"], cwd=FIXTURE, timeout=180)
    if build.returncode or not PBW.exists():
        raise RuntimeError("Fixture build failed:\n{}".format(build.stderr))
    display_build = run(["pebble", "build"], cwd=DISPLAY_FIXTURE, timeout=180)
    if display_build.returncode or not DISPLAY_PBW.exists():
        raise RuntimeError("Display fixture build failed:\n{}".format(display_build.stderr))

    results = []
    try:
        for platform in platforms:
            result = verify(platform, output)
            results.append(result)
            print("PASS {} {}x{} fixture={} state={}".format(
                platform, *result["rawSize"], result["fixture"], result["buttonState"]), flush=True)
    finally:
        stop_emulators()
    (output / "results.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print("PASS {} platforms; results: {}".format(len(results), output), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FAIL {}".format(error), file=sys.stderr, flush=True)
        sys.exit(1)
