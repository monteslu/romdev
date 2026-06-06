#!/usr/bin/env bash
# Build tcc-65816 (TinyCC fork for the WDC 65816 / SNES) → WASM.
#
# What ships: tcc816.wasm + tcc816.js that compile C source to wla-dx
# assembly for the 65816 CPU. tcc-65816 doesn't assemble or link — that
# pipeline needs the companion wla-65816 + wlalink (build-wladx.sh,
# pending). End-to-end SNES C builds via tcc require all three.
#
# Source: github.com/alekmaul/tcc — a maintained PVSnesLib fork of
# Fabrice Bellard's TinyCC (~19k lines of C). Builds clean with emcc
# in one pass; no fork(), no GMP/MPFR, no host bootstrap.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc

TCC_SRC_DIR="$BUILD_DIR/tcc-65816/tcc"
OUT="$PROJECT_DIR/src/toolchains/tcc816/wasm"

mkdir -p "$BUILD_DIR/tcc-65816"
cd "$BUILD_DIR/tcc-65816"
# Upstream pin lives in scripts/versions.json (toolchains.tcc816).
fetch_pinned toolchains.tcc816 "$TCC_SRC_DIR"

cd "$TCC_SRC_DIR"
# Required to produce config.h + config.mak before any compile.
./configure --enable-cross > /dev/null

# tcc.c #includes the rest of CORE_FILES, so one TU is enough.
emcc \
  -O2 \
  -DTCC_TARGET_816 \
  -DCONFIG_TCC_STATIC \
  -fno-strict-aliasing \
  -Wno-pointer-sign -Wno-sign-compare \
  tcc.c \
  "${EM_CLI_FLAGS[@]}" \
  -s EXPORT_NAME=createTcc816 \
  -o tcc816.js

mkdir -p "$OUT"
cp tcc816.js tcc816.wasm "$OUT/"
echo "tcc816 staged at $OUT"
ls -la "$OUT"
