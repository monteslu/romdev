#!/usr/bin/env bash
# Build PCSX-ReARMed (Sony PlayStation) libretro core → WASM, with:
#   - the libretro cheat interface exported (_retro_cheat_set/_retro_cheat_reset)
#   - romdev's R3000 register snapshot appended + exported (_romdev_mips_regs_get),
#     which getCPUState reads via host.getMipsRegs() for cpu({op:'read'}).
# Software renderer + built-in HLE BIOS → no firmware to ship, no GL dependency.
#
# Output: src/cores/wasm/pcsx_rearmed_libretro.{js,wasm} (gitignored dev staging).
set -euo pipefail
. "$(dirname "$0")/_lib.sh" 2>/dev/null || . "$(dirname "$0")/_versions.sh" 2>/dev/null || true
require_cmd emcc 2>/dev/null || { command -v emcc >/dev/null || { echo "emcc not found"; exit 1; }; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${ROMDEV_BUILD_DIR:-$PROJECT_DIR/build}/pcsx_rearmed"
SRC="$BUILD_DIR/src"
OUT="$PROJECT_DIR/src/cores/wasm"
REPO="https://github.com/libretro/pcsx_rearmed.git"
mkdir -p "$BUILD_DIR" "$OUT"

[ -d "$SRC" ] || git clone --depth 1 "$REPO" "$SRC"
cd "$SRC"

# Append the R3000 regsnap to libretro.c (idempotent — guarded by the sentinel).
if ! grep -q "romdev_mips_regs_get" frontend/libretro.c; then
  cat "$SCRIPT_DIR/patches/romdev-snippets/ps1-regsnap.c" >> frontend/libretro.c
  # force a recompile of libretro.o so the symbol enters the archive
  rm -f frontend/libretro.o
fi

emmake make -f Makefile.libretro platform=emscripten clean >/dev/null 2>&1 || true
emmake make -f Makefile.libretro platform=emscripten -j"$(nproc)"

CORE_LIB=$(find . -maxdepth 2 \( -name "*_libretro_emscripten.bc" -o -name "*.a" \) | head -1)
cp "$CORE_LIB" "${CORE_LIB%.bc}.a" 2>/dev/null || true
CORE_A="${CORE_LIB%.bc}.a"; [ -f "$CORE_A" ] || CORE_A="$CORE_LIB"

EXPORTED='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_romdev_mips_regs_get","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RT='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS","dynCall"]'

emcc "$CORE_A" -O3 -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 \
  -s "EXPORT_NAME=create_pcsx_rearmed" -s ENVIRONMENT=node,web -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=134217728 -s MAXIMUM_MEMORY=268435456 -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED" -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RT" \
  -s FILESYSTEM=1 -s INVOKE_RUN=0 -s USE_ZLIB=1 \
  -o "$OUT/pcsx_rearmed_libretro.js"

echo "Built: $OUT/pcsx_rearmed_libretro.{js,wasm}"
