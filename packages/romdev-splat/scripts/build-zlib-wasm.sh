#!/usr/bin/env bash
# Build src/wasm/zlib-stream.wasm: vanilla zlib (emscripten's zlib port,
# emsdk 4.0.18 = zlib 1.3.1) with a small deflate-stream API
# (packages/romdevtools/scripts/src/zlib-stream.c). romdev-splat writes PNG
# IDAT data through it so the bytes match CPython's zlib module; Node's zlib
# is Chromium's fork and writes different streams.
#
# Standalone WASM (no JS glue): src/zlib.js instantiates it directly.
# Host deps (build time only): emcc (emsdk 4.0.18).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
SRC="$PKG/../romdevtools/scripts/src/zlib-stream.c"
OUT="$PKG/src/wasm/zlib-stream.wasm"
if [ -n "${EMSDK:-}" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
  # shellcheck source=/dev/null
  source "$EMSDK/emsdk_env.sh" > /dev/null 2>&1
fi
command -v emcc >/dev/null || { echo "emcc is required" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
emcc -O2 -sUSE_ZLIB=1 -sSTANDALONE_WASM=1 --no-entry -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=16777216 -sSTACK_SIZE=65536 -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS=_zs_malloc,_zs_mfree,_zs_new,_zs_compress,_zs_out_ptr,_zs_out_len,_zs_free,_zs_crc32 \
  "$SRC" -o "$OUT"
echo "zlib-stream -> $OUT ($(wc -c < "$OUT") bytes)"
