#!/usr/bin/env bash
# Build WLA-DX's wla-65816 + wlalink → WASM.
#
# Two-stage build:
#   1. NATIVE build of the WLA-DX project. We need this for its host-side
#      "instruction table generator" — a small program that consumes
#      i65816.c and emits t65816.c, which the assembler links against.
#      Under emcmake this generator builds as WASM and can't be exec'd
#      during the rest of the build.
#   2. WASM build via DIRECT emcc invocations (not CMake). We feed it the
#      WLA_SRCS list from the upstream CMakeLists.txt + the pre-generated
#      t65816.c from stage 1. Then a separate emcc pass builds wlalink.
#
# Produces: src/toolchains/wladx/wasm/{wla-65816,wlalink}.{js,wasm}
# Roughly 625 KB total. Verified byte-identical SNES ROM output vs native.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc

WLADX_SRC_DIR="$BUILD_DIR/wla-dx/wla-dx"
NATIVE_BUILD="$WLADX_SRC_DIR/build-native"
OUT="$PROJECT_DIR/src/toolchains/wladx/wasm"

mkdir -p "$BUILD_DIR/wla-dx"
cd "$BUILD_DIR/wla-dx"
# Upstream pin lives in scripts/versions.json (toolchains.wladx).
fetch_pinned toolchains.wladx "$WLADX_SRC_DIR"

# ── Stage 1: native build (for the instruction-table generator) ──────
mkdir -p "$NATIVE_BUILD"
cd "$NATIVE_BUILD"
if [ ! -f "ins_tbl_gen/t65816.c" ]; then
  cmake .. -DCMAKE_BUILD_TYPE=Release >/dev/null
  make -j"$(nproc)" wla-65816 wlalink
fi
[ -f "ins_tbl_gen/t65816.c" ] || { echo "stage-1 didn't produce t65816.c" >&2; exit 1; }

# ── Stage 2: emcc-build wla-65816 directly ────────────────────────────
cd "$WLADX_SRC_DIR"
emcc -O2 -DW65816 \
  main.c crc32.c decode.c hashmap.c parse.c include.c \
  phase_1.c phase_2.c phase_3.c phase_4.c \
  stack.c listfile.c printf.c mersenne.c i65816.c \
  "$NATIVE_BUILD/ins_tbl_gen/t65816.c" \
  "${EM_CLI_FLAGS[@]}" \
  -s EXPORT_NAME=createWla65816 \
  -o "$NATIVE_BUILD/wla-65816.js"

# ── Stage 3: emcc-build wlalink directly ──────────────────────────────
cd "$WLADX_SRC_DIR/wlalink"
emcc -O2 \
  main.c memory.c parse.c files.c check.c analyze.c write.c \
  compute.c discard.c listfile.c dbgmodel.c dbgexp.c \
  ../hashmap.c ../crc32.c ../printf.c \
  -I.. \
  "${EM_CLI_FLAGS[@]}" \
  -s EXPORT_NAME=createWlalink \
  -o "$NATIVE_BUILD/wlalink.js"

# ── Stage the artifacts ───────────────────────────────────────────────
mkdir -p "$OUT"
cp "$NATIVE_BUILD/wla-65816.js"   "$OUT/wla-65816.js"
cp "$NATIVE_BUILD/wla-65816.wasm" "$OUT/wla-65816.wasm"
cp "$NATIVE_BUILD/wlalink.js"     "$OUT/wlalink.js"
cp "$NATIVE_BUILD/wlalink.wasm"   "$OUT/wlalink.wasm"
echo "wla-dx staged at $OUT"
ls -la "$OUT"
