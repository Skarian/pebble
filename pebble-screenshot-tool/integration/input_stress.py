#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import png
from pebble_tool.sdk import sdk_manager
from pebble_tool.sdk.emulator import ManagedEmulatorTransport


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "integration" / "button-state"
PBW = FIXTURE / "build" / "button-state.pbw"
CAPTURE = ROOT / "capture.py"
FAILURES = ROOT / "integration" / "failures"
BUTTONS = {"up": 1, "select": 2, "down": 3}
MIXED = ("up select down up up select down select up down up select "
         "select down up down select up up down select down up select").split()


def run(command, cwd=None, timeout=None):
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def emulator_pids():
    result = run(["ps", "ax", "-o", "pid=,command="])
    if result.returncode:
        raise RuntimeError("Could not inspect emulator processes: {}".format(result.stderr.strip()))
    found = []
    for line in result.stdout.splitlines():
        match = re.match(r"\s*(\d+)\s+(.+)", line)
        if match and ("qemu-pebble" in match.group(2) or
                      re.search(r"\s-m\s+pypkjs(?:\s|$)", match.group(2))):
            found.append(int(match.group(1)))
    return found


def stop_emulators():
    run(["pebble", "kill"], timeout=15)
    for pid in emulator_pids():
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 5
    running = emulator_pids()
    while running and time.monotonic() < deadline:
        time.sleep(0.05)
        running = emulator_pids()
    if running:
        raise RuntimeError("Emulator processes ignored SIGTERM: {}".format(running))


def expected_state(buttons):
    state = 0
    for button in buttons:
        code = BUTTONS[button]
        if not (state == 0 and code == 3):
            state = (state * 13 + code) & 63
    return state


def expected_rgb(state):
    return tuple(((state >> shift) & 3) * 85 for shift in (4, 2, 0))


def actual_rgb(path):
    width, height, rows, _ = png.Reader(filename=str(path)).asRGB8()
    rows = list(rows)
    samples = []
    for x, y in ((width // 2, height // 2), (90, 104), (110, 104), (90, 124), (110, 124)):
        row = rows[y]
        samples.append(tuple(row[x * 3:x * 3 + 3]))
    if len(set(samples)) != 1:
        raise RuntimeError("Center framebuffer samples disagree: {}".format(samples))
    return samples[0]


def preserve(directory, case, trial, buttons, expected, result, actual=None, error=None):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    target = FAILURES / "{}-{}-{}".format(stamp, case, trial)
    target.parent.mkdir(parents=True, exist_ok=True)
    metadata = {
        "case": case,
        "trial": trial,
        "buttons": buttons,
        "expectedState": expected,
        "expectedRgb": expected_rgb(expected),
        "actualRgb": actual,
        "error": error,
        "pbwSha256": hashlib.sha256(PBW.read_bytes()).hexdigest(),
        "returnCode": result.returncode if result else None,
    }
    (directory / "stdout.txt").write_text(result.stdout if result else "", encoding="utf-8")
    (directory / "stderr.txt").write_text(result.stderr if result else "", encoding="utf-8")
    (directory / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    shutil.move(str(directory), target)
    return target


def capture_command(output, buttons, qemu=None):
    target = ["--qemu", qemu] if qemu else ["--emulator", "emery"]
    return [sys.executable, str(CAPTURE), *target, "--platform", "emery",
            "--output", str(output), "--pbw", str(PBW), "--timeout", "20",
            *sum((["--button", button] for button in buttons), [])]


def verify_result(directory, case, trial, buttons, result, expect_back=False):
    output = directory / "raw.png"
    expected = expected_state(buttons) if not expect_back else 0
    if expect_back:
        if result.returncode != 0 and "not in the foreground" in result.stderr and not output.exists():
            return None
        raise RuntimeError("Back did not produce the expected foreground failure")
    if result.returncode:
        raise RuntimeError("capture.py exited {}".format(result.returncode))
    actual = actual_rgb(output)
    if actual != expected_rgb(expected):
        raise RuntimeError("expected RGB {}, got {}".format(expected_rgb(expected), actual))
    return actual


def managed_trial(case, trial, buttons, expect_back=False):
    directory = Path(tempfile.mkdtemp(prefix="pebble-input-"))
    result = None
    actual = None
    try:
        stop_emulators()
        result = run(capture_command(directory / "raw.png", buttons), cwd=ROOT, timeout=180)
        actual = verify_result(directory, case, trial, buttons, result, expect_back)
        stop_emulators()
        shutil.rmtree(directory)
    except Exception as error:
        if actual is None and (directory / "raw.png").exists():
            try:
                actual = actual_rgb(directory / "raw.png")
            except Exception:
                pass
        try:
            stop_emulators()
        finally:
            target = preserve(directory, case, trial, buttons,
                              expected_state(buttons) if not expect_back else 0,
                              result, actual=actual, error=str(error))
        raise RuntimeError("{}; evidence: {}".format(error, target))


def start_qemu():
    version = sdk_manager.get_current_sdk()
    if "PEBBLE_QEMU_PATH" not in os.environ:
        qemu = Path(sdk_manager.root_path_for_sdk(version)) / "toolchain" / "bin" / "qemu-pebble"
        if qemu.is_file():
            os.environ["PEBBLE_QEMU_PATH"] = str(qemu)
    launcher = ManagedEmulatorTransport("emery", version, vnc_enabled=False)
    launcher._wait_for_qemu = lambda: None
    launcher._spawn_qemu()
    return "localhost:{}".format(launcher.qemu_port)


def explicit_trial(trial, buttons):
    directory = Path(tempfile.mkdtemp(prefix="pebble-input-explicit-"))
    result = None
    try:
        stop_emulators()
        qemu = start_qemu()
        result = run(capture_command(directory / "raw.png", buttons, qemu=qemu), cwd=ROOT, timeout=180)
        verify_result(directory, "explicit", trial, buttons, result)
        stop_emulators()
        shutil.rmtree(directory)
    except Exception as error:
        try:
            stop_emulators()
        finally:
            target = preserve(directory, "explicit", trial, buttons,
                              expected_state(buttons), result, error=str(error))
        raise RuntimeError("{}; evidence: {}".format(error, target))


def exercise(label, count, function):
    for trial in range(1, count + 1):
        started = time.monotonic()
        function(trial)
        print("PASS {} {}/{} ({:.2f}s)".format(label, trial, count, time.monotonic() - started), flush=True)


def main():
    parser = argparse.ArgumentParser(description="Stress Pebble emulator button delivery")
    parser.add_argument("--quick", action="store_true", help="run one trial of each case")
    args = parser.parse_args()
    counts = {"first": 50, "mixed": 20, "boundary": 10, "back": 5, "explicit": 10}
    if args.quick:
        counts = {name: 1 for name in counts}

    stop_emulators()
    try:
        build = run(["pebble", "build"], cwd=FIXTURE, timeout=120)
        if build.returncode or not PBW.exists():
            raise RuntimeError("Fixture build failed:\n{}".format(build.stderr))

        exercise("first-up", counts["first"], lambda trial: managed_trial("first-up", trial, ["up"]))
        exercise("mixed-order", counts["mixed"], lambda trial: managed_trial("mixed-order", trial, MIXED))
        exercise("boundary-noop", counts["boundary"], lambda trial: managed_trial("boundary-noop", trial, ["down"]))
        exercise("back-exit", counts["back"], lambda trial: managed_trial("back-exit", trial, ["back"], True))
        exercise("explicit-qemu", counts["explicit"], lambda trial: explicit_trial(trial, MIXED))
    finally:
        stop_emulators()
    print("PASS all emulator input cases: {} trials".format(sum(counts.values())), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FAIL {}".format(error), file=sys.stderr, flush=True)
        sys.exit(1)
