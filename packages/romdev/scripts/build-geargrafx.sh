#!/usr/bin/env bash
# Build Geargrafx (PC Engine / TurboGrafx-16) libretro core → WASM. C++ core, so
# the emcc link keeps exception support. PCE carts boot directly — no BIOS.
#
# A romdev memory-region/watchpoint patch is applied IF present (exposes the
# HuC6270 VRAM/SATB, HuC6260 palette, HuC6280 CPU + PSG state, VDC regs, and the
# findWriter watchpoint); the stock core builds fine without it.
#
# Output: src/cores/wasm/geargrafx_libretro.{js,wasm}.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git
require_cmd make

DIR="$BUILD_DIR/geargrafx"
LIBRETRO="$DIR/platforms/libretro"
PATCH_REL="$(pin_get cores.geargrafx patch || true)"
PATCH_FILE="$PROJECT_DIR/${PATCH_REL:-}"
# geargrafx ships from its own binary package (romdev-core-geargrafx), which the
# core registry resolves first. Stage the wasm there (the src/cores/wasm tree is
# a gitignored dev fallback).
OUT="$PROJECT_DIR/../romdev-core-geargrafx/wasm"

fetch_pinned cores.geargrafx "$DIR"

cd "$DIR"
if [ -n "${PATCH_REL:-}" ] && [ -f "$PATCH_FILE" ]; then
  # Reset every file the patch touches: libretro.cpp (memory regions + the
  # pcbreak/readwatch exports), src/memory.{h,_inline.h} (Read→ReadInternal +
  # read-watch hook), src/huc6280_inline.h (PC-break execute hook), and
  # src/geargrafx_core_inline.h (per-frame budget drain on hit) — so a clean
  # re-apply always works.
  git checkout -- platforms/libretro/libretro.cpp \
    src/memory.h src/memory_inline.h src/huc6280_inline.h \
    src/geargrafx_core_inline.h 2>/dev/null || true
  if git apply --recount --check "$PATCH_FILE" 2>/dev/null; then
    git apply --recount "$PATCH_FILE"; echo "Applied $PATCH_FILE"
  elif grep -rq "romdev_pcbreak_set" platforms/libretro/ 2>/dev/null; then
    echo "Patch already present (sentinel found); skipping apply."
  else
    echo "WARNING: region patch failed to apply; building STOCK core." >&2
  fi
else
  echo "No region patch yet — building stock geargrafx."
fi

cd "$LIBRETRO"
emmake make platform=emscripten clean >/dev/null 2>&1 || true
find . -maxdepth 1 -name "*_libretro_emscripten.bc" -delete 2>/dev/null || true
emmake make platform=emscripten -j"$(nproc)"

CORE_LIB=$(find . -maxdepth 1 -name "*_libretro_emscripten.bc" -print -quit)
[ -z "$CORE_LIB" ] && { echo "FATAL: geargrafx build produced no .bc archive." >&2; exit 1; }
mv "$CORE_LIB" "${CORE_LIB%.bc}.a"; CORE_LIB="${CORE_LIB%.bc}.a"

# Execution breakpoint + read watchpoint exports (this core has no WRITE watch).
# Added when the patch's pcbreak hook is present in the built tree.
BP_EXPORTS=""
# cwd here is $LIBRETRO (platforms/libretro); libretro.cpp holds the exports.
grep -rq "romdev_pcbreak_get" . 2>/dev/null && \
  BP_EXPORTS='"_romdev_readwatch_set","_romdev_readwatch_get","_romdev_pcbreak_set","_romdev_pcbreak_get",'
# RE primitives round 2 (register read/write + range-watch + PC-coverage) — added
# by the same patch as the pcbreak hook, gated on the round-2 sentinel export.
grep -rq "romdev_cov_get" . 2>/dev/null && \
  BP_EXPORTS="$BP_EXPORTS"'"_romdev_setreg","_romdev_getreg","_romdev_range_set","_romdev_range_get","_romdev_cov_set","_romdev_cov_get",'
# WRITE watchpoint (findWriter) — geargrafx gained a clean Write funnel, so this is
# now supported on PCE too (gated on the watchpoint export sentinel).
grep -rq "romdev_watchpoint_get" . 2>/dev/null && \
  BP_EXPORTS="$BP_EXPORTS"'"_romdev_watchpoint_set","_romdev_watchpoint_get",'
EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set",'"$BP_EXPORTS"'"_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS"]'

mkdir -p "$OUT"
emcc "$CORE_LIB" \
  -O3 -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=create_geargrafx \
  -s ENVIRONMENT=node -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=67108864 \
  -s MAXIMUM_MEMORY=268435456 -s ALLOW_TABLE_GROWTH=1 \
  -s DISABLE_EXCEPTION_CATCHING=0 \
  -s EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  -s FILESYSTEM=1 -s INVOKE_RUN=0 -s USE_ZLIB=1 \
  -o "$OUT/geargrafx_libretro.js"

echo "geargrafx_libretro staged at $OUT"
ls -lh "$OUT/geargrafx_libretro."{js,wasm}
