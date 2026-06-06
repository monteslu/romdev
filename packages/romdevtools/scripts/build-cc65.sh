#!/usr/bin/env bash
# Build cc65 → ca65 → ld65 to WASM, plus stage lib/cfg/asminc/include/target.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git
require_cmd make

# Upstream pin lives in scripts/versions.json (toolchains.cc65).
CC65_DIR="$BUILD_DIR/cc65/src"
OUT="$PROJECT_DIR/src/toolchains/cc65/wasm"
SHARE="$PROJECT_DIR/src/toolchains/cc65/share/cc65"

fetch_pinned toolchains.cc65 "$CC65_DIR" || true
# cc65 doesn't have V2.19 as the actual release tag style; fall back to main.
# Pinning is left to whoever updates this script.

cd "$CC65_DIR"
make clean -C src || true

echo "Building host tools with emcc..."
make -C src ca65 cc65 ld65 ar65 CC=emcc AR=emar -j"$(nproc)"

echo "Relinking with MODULARIZE flags..."
for prog in ca65 cc65 ld65; do
  emcc \
    src/wrk/${prog}/*.o src/wrk/common/common.a \
    "${EM_CLI_FLAGS[@]}" \
    -lm \
    -s EXPORT_NAME="create${prog^}" \
    -o "src/bin/${prog}.js"
done

echo "Building 6502 runtime libraries (native cc65 tools)..."
make clean -C src
make -j"$(nproc)"
# Build the runtime libs for ALL targets explicitly — a bare `make` builds the
# tools but does NOT reliably produce every target's lib (that's why an earlier
# build shipped only 5 of the ~25 target libs, breaking PCE + Atari 5200/8-bit
# at link). `make lib` walks libsrc/Makefile's full TARGETS list (incl. pce,
# atari, atari5200, atarixl).
make lib -j"$(nproc)"

mkdir -p "$OUT" "$SHARE/lib" "$SHARE/asminc" "$SHARE/include" "$SHARE/cfg" "$SHARE/target"
cp src/bin/cc65.js src/bin/cc65.wasm "$OUT/"
cp src/bin/ca65.js src/bin/ca65.wasm "$OUT/"
cp src/bin/ld65.js src/bin/ld65.wasm "$OUT/"
cp -r asminc/* "$SHARE/asminc/"
cp -r include/* "$SHARE/include/"
cp -r cfg/* "$SHARE/cfg/"
cp -r target/* "$SHARE/target/"
cp lib/*.lib lib/*.o "$SHARE/lib/"

# NOTE: The dual-build (emcc host tools, then native build for runtime libs)
# trips on object files in src/wrk being from the wrong toolchain. We work
# around it with the make clean in between. Building cc65 reliably requires
# this two-pass dance because the C runtime libs (lib/*.lib) are generated
# by running cc65/ca65/ld65 on the libsrc/ directory.

echo "cc65/ca65/ld65 staged at $OUT and runtime libs at $SHARE"
