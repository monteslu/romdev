#!/usr/bin/env bash
# Build vasm with m68k CPU + Motorola syntax → WASM.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd curl

VASM_DIR="$BUILD_DIR/vasm/vasm"
OUT="$PROJECT_DIR/src/toolchains/vasm68k/wasm"

mkdir -p "$BUILD_DIR/vasm"
cd "$BUILD_DIR/vasm"
if [ ! -d "$VASM_DIR" ]; then
  # vasm is a rolling-release tarball (no versioned URL) — fetch_pinned_tarball
  # pulls the pinned URL and verifies sha256 (the only drift detector upstream
  # gives us). See versions.json toolchains.vasm68k.
  fetch_pinned_tarball toolchains.vasm68k vasm.tar.gz
  tar xzf vasm.tar.gz
fi

cd "$VASM_DIR"
make clean CPU=m68k SYNTAX=mot CC=emcc || true
make CPU=m68k SYNTAX=mot CC=emcc -j"$(nproc)"

emcc obj/m68k_mot_*.o -lm \
  "${EM_CLI_FLAGS[@]}" \
  -s EXPORT_NAME=createVasm68k \
  -o vasm68k.js

mkdir -p "$OUT"
cp vasm68k.js vasm68k.wasm "$OUT/"
echo "vasm68k.wasm staged at $OUT"
