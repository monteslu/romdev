#!/usr/bin/env bash
# Build mgba (Game Boy Advance) libretro core → WASM, with romdev's
# instruction-level watchpoint + execution-breakpoint patch applied:
#   - WRITE watch: GBAStore8/16/32 in src/gba/memory.c record the ARM7 PC;
#     libretro.c exports romdev_watchpoint_set/get for findWriter.
#   - READ watch: GBALoad8/16/32 record the reading instruction's PC;
#     libretro.c exports romdev_readwatch_set/get for runUntilRead.
#   - PC BREAKPOINT / single-step: ARMRunLoop / ARMRun in src/arm/arm.c stop the
#     CPU at an exact instruction (frozen PC) without hanging the libretro frame
#     loop; libretro.c exports romdev_pcbreak_set/get for runUntilPC /
#     stepInstruction.
# This core was previously vendored as a prebuilt .wasm with no build script;
# this makes it reproducible.
#
# Output: src/cores/wasm/mgba_libretro.{js,wasm} AND the registry-resolved
# romdev-platform-gba package.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git
require_cmd make

DIR="$BUILD_DIR/mgba/src"
PATCH_FILE="$PROJECT_DIR/$(pin_get cores.mgba patch)"
OUT="$PROJECT_DIR/src/cores/wasm"

fetch_pinned cores.mgba "$DIR"

cd "$DIR"
git checkout -- src/gba/memory.c src/platform/libretro/libretro.c src/arm/arm.c 2>/dev/null || true
if ! git apply --recount --check "$PATCH_FILE" 2>/dev/null; then
  if grep -q "romdev_watchpoint_set" src/platform/libretro/libretro.c; then
    echo "Patch already present (sentinel romdev_watchpoint_set found); skipping apply."
  else
    echo "FATAL: patch failed to apply and sentinel not present." >&2
    exit 1
  fi
else
  git apply --recount "$PATCH_FILE"
  echo "Applied $PATCH_FILE"
fi

emmake make -f Makefile.libretro platform=emscripten clean >/dev/null 2>&1 || true
find . -maxdepth 2 -name "*_libretro_emscripten.a" -delete 2>/dev/null || true
emmake make -f Makefile.libretro platform=emscripten -j"$(nproc)"

CORE_LIB=$(find . -maxdepth 2 \( -name "*.a" -o -name "*_libretro_emscripten.bc" \) -print -quit)
if [ -z "$CORE_LIB" ]; then
  echo "FATAL: mgba build did not produce a .a or .bc archive." >&2
  exit 1
fi
if [[ "$CORE_LIB" == *.bc ]] && head -c 7 "$CORE_LIB" | grep -q '!<arch>'; then
  mv "$CORE_LIB" "${CORE_LIB%.bc}.a"
  CORE_LIB="${CORE_LIB%.bc}.a"
fi

EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_romdev_watchpoint_set","_romdev_watchpoint_get","_romdev_readwatch_set","_romdev_readwatch_get","_romdev_pcbreak_set","_romdev_pcbreak_get","_romdev_watchdog_set","_romdev_regsnap_get","_romdev_irqblock_set","_romdev_setreg","_romdev_getreg","_romdev_range_set","_romdev_range_get","_romdev_cov_set","_romdev_cov_get","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS"]'

mkdir -p "$OUT"
emcc "$CORE_LIB" \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=create_mgba \
  -s ENVIRONMENT=node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=67108864 \
  -s MAXIMUM_MEMORY=536870912 \
  -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  -s FILESYSTEM=1 \
  -s INVOKE_RUN=0 \
  -s USE_ZLIB=1 \
  -o "$OUT/mgba_libretro.js"

echo "mgba_libretro staged at $OUT"
ls -lh "$OUT/mgba_libretro."{js,wasm}

# Also stage into the carved-out binary package the registry actually resolves
# at runtime (src/cores/registry.js → romdev-platform-gba). Without this the dev
# tree keeps loading the OLD package copy and a rebuild appears to "do nothing".
PKG_OUT="$PROJECT_DIR/../romdev-platform-gba/wasm"
if [ -d "$PKG_OUT" ]; then
  cp "$OUT/mgba_libretro.js"   "$PKG_OUT/mgba_libretro.js"
  cp "$OUT/mgba_libretro.wasm" "$PKG_OUT/mgba_libretro.wasm"
  echo "also staged into romdev-platform-gba package: $PKG_OUT"
fi
