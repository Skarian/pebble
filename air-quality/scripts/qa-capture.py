#!/usr/bin/env python3
"""AirQuality QA bridge adding byte-array AppMessage support."""

import sys
from pathlib import Path

TOOL = Path(__file__).resolve().parents[2] / "pebble-screenshot-tool"
sys.path.insert(0, str(TOOL))

import capture  # noqa: E402
from libpebble2.services.appmessage import ByteArray  # noqa: E402

capture.APP_MESSAGE_TYPES["bytes"] = lambda value: ByteArray(bytes(value))

if __name__ == "__main__":
    capture.main()
