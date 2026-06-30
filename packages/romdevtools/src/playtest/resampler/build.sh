#!/usr/bin/env bash
# Build the WASM+SIMD audio resampler for the playtest sink.
# Mirrors simdpipe's emcc style (-O3 -msimd128, MODULARIZE ES6). Single-thread,
# small heap (audio chunks are a few KB). Output: resampler.mjs + resampler.wasm.
set -euo pipefail
cd "$(dirname "$0")"

source "$HOME/code/mine/emsdk/emsdk_env.sh" >/dev/null 2>&1 || true

emcc resampler.c \
  -O3 -msimd128 -ffast-math \
  -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 \
  -s ENVIRONMENT=node,web,worker \
  -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=4194304 \
  -s EXPORTED_RUNTIME_METHODS='["HEAP16","HEAPU8","cwrap","ccall"]' \
  -s EXPORTED_FUNCTIONS='["_rs_alloc","_rs_free","_rs_resample","_malloc","_free"]' \
  -o resampler.mjs

echo "built resampler.mjs + resampler.wasm ($(stat -c%s resampler.wasm 2>/dev/null || echo '?') bytes)"
