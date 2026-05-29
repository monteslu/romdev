#!/usr/bin/env bash
# Build RGBDS (rgbasm + rgblink + rgbfix) → WASM.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd emcmake
require_cmd cmake
require_cmd git
require_cmd bison

# Upstream pin lives in scripts/versions.json (toolchains.rgbds).
RGBDS_DIR="$BUILD_DIR/rgbds/src"
OUT="$PROJECT_DIR/src/toolchains/rgbds/wasm"

fetch_pinned toolchains.rgbds "$RGBDS_DIR"

cd "$RGBDS_DIR"
rm -rf emscripten-build
emcmake cmake -B emscripten-build -DCMAKE_BUILD_TYPE=Release
cmake --build emscripten-build -j"$(nproc)"

# RGBDS' CMake outputs are bare CommonJS Emscripten. Relink with our flags.
for prog in rgbasm rgblink rgbfix; do
  OBJS=$(cat "emscripten-build/src/CMakeFiles/${prog}.dir/objects1.rsp")
  (
    cd "emscripten-build/src"
    em++ ${OBJS} \
      "${EM_CLI_FLAGS[@]}" \
      -s EXPORT_NAME="create${prog^}" \
      -o "${prog}.mod.js"
  )
done

mkdir -p "$OUT"
for prog in rgbasm rgblink rgbfix; do
  cp "emscripten-build/src/${prog}.mod.js" "$OUT/${prog}.js"
  cp "emscripten-build/src/${prog}.mod.wasm" "$OUT/${prog}.wasm"
done
echo "RGBDS staged at $OUT"
