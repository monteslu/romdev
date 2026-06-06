#!/usr/bin/env bash
# Rebuild every bundled WASM toolchain from upstream source.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v bison >/dev/null 2>&1; then "$SCRIPT_DIR/build-bison.sh"; fi
if ! command -v flex >/dev/null 2>&1; then "$SCRIPT_DIR/build-flex.sh"; fi

"$SCRIPT_DIR/build-dasm.sh"
"$SCRIPT_DIR/build-cc65.sh"
"$SCRIPT_DIR/build-asar.sh"
"$SCRIPT_DIR/build-vasm68k.sh"
"$SCRIPT_DIR/build-rgbds.sh"
"$SCRIPT_DIR/build-vice.sh"

echo
echo "=== All toolchains + cores built ==="
echo "Run: npm test"
