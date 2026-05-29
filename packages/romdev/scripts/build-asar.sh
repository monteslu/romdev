#!/usr/bin/env bash
# Build asar (65816 assembler) → WASM.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git

# Upstream pin lives in scripts/versions.json (toolchains.asar).
ASAR_DIR="$BUILD_DIR/asar/src"
OUT="$PROJECT_DIR/src/toolchains/asar/wasm"

fetch_pinned toolchains.asar "$ASAR_DIR"

cd "$ASAR_DIR/src/asar"
emcc \
  addr2line.cpp arch-65816.cpp arch-spc700.cpp arch-superfx.cpp \
  asar_math.cpp assembleblock.cpp crc32.cpp errors.cpp \
  interface-cli.cpp libcon.cpp libsmw.cpp libstr.cpp \
  macro.cpp main.cpp virtualfile.cpp warnings.cpp \
  platform/file-helpers.cpp platform/linux/file-helpers-linux.cpp \
  -I. -std=c++17 -Dstricmp=strcasecmp \
  -DASAR_VERSION_MAJOR=1 -DASAR_VERSION_MINOR=91 -DASAR_VERSION_PATCH=0 \
  "${EM_CLI_FLAGS[@]}" \
  -s EXPORT_NAME=createAsar \
  -o asar.js

mkdir -p "$OUT"
cp asar.js asar.wasm "$OUT/"
echo "asar.wasm staged at $OUT"
