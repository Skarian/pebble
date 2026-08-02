#!/bin/sh
set -eu

pebble_bin=$(realpath "$(command -v pebble)")
exec "$(dirname "$pebble_bin")/python" "$(dirname "$0")/input_stress.py" "$@"
