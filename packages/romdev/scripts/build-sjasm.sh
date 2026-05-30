#!/usr/bin/env bash
# Build sjasm (Z80 assembler) + bintos (Z80-binary → m68k .s converter) → WASM.
#
# These are SGDK's own Z80 toolchain: a .s80 Z80 sound driver is assembled by
# `sjasm` into a raw Z80 binary (.o80), then `bintos` emits an m68k .s that
# embeds that blob as a byte array, which gcc compiles into the ROM. Both are
# small, dependency-free C/C++ shipped in SGDK's tools/. Building them to WASM
# lets romdev compile SGDK's sound drivers FROM SOURCE instead of linking a
# prebuilt libmd.a — no opaque blobs.
#
# Output:
#   ../romdev-toolchain-m68k-gcc/wasm/sjasm.{js,wasm}
#   ../romdev-toolchain-m68k-gcc/wasm/bintos.{js,wasm}
#
# Upstream pinned in scripts/versions.json (toolchains.sgdk — sjasm + bintos
# live in the SGDK repo under tools/).
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git

SGDK_DIR="$BUILD_DIR/sgdk/src"
# sjasm + bintos ship in the Genesis toolchain package (alongside the m68k
# compiler they pair with), not the main romdev package.
OUT="$PROJECT_DIR/../romdev-toolchain-m68k-gcc/wasm"

fetch_pinned toolchains.sgdk "$SGDK_DIR"

# ── sjasm ────────────────────────────────────────────────────────────────
# Windows-targeted source; neutralize targetver.h (pulls SDKDDKVer.h) and
# provide MAX_PATH. The actual Win32 calls are all behind #ifdef WIN32.
SJ="$SGDK_DIR/tools/sjasm/src"
echo "// neutralized for non-Windows wasm build" > "$SJ/targetver.h"

emcc \
  "$SJ"/*.cpp -I"$SJ" \
  -std=c++14 -O2 -DNDEBUG -DMAX_PATH=4096 -fpermissive -Wno-writable-strings \
  "${EM_CLI_FLAGS[@]}" \
  -s EXPORT_NAME=createSjasm \
  -o "$OUT/sjasm.js"

# ── bintos ───────────────────────────────────────────────────────────────
BT="$SGDK_DIR/tools/bintos/src"
emcc \
  "$BT"/bintos.c -I"$BT" \
  -O2 -DNDEBUG \
  "${EM_CLI_FLAGS[@]}" \
  -s EXPORT_NAME=createBintos \
  -o "$OUT/bintos.js"

mkdir -p "$OUT"
echo "sjasm.wasm + bintos.wasm staged at $OUT"
ls -la "$OUT"
