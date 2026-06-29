#!/usr/bin/env bash
# Build snes9x libretro core → WASM, with romdev's custom memory
# region patch applied (exposes OAM/CGRAM/ARAM/FillRAM via
# retro_get_memory_data for the inspectSprites/inspectPalette tools).
#
# Output: src/cores/wasm/snes9x_libretro.{js,wasm}.
#
# Repro: this script self-contains everything. Clones snes9x upstream,
# applies scripts/patches/snes9x-romdev-memory-regions.patch, builds
# with emscripten using the exact link flags retroemu uses, stages the
# .js/.wasm under src/cores/wasm/.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git
require_cmd make

# Upstream pin lives in scripts/versions.json (cores.snes9x).
SNES9X_DIR="$BUILD_DIR/snes9x/src"
PATCH_FILE="$PROJECT_DIR/$(pin_get cores.snes9x patch)"
OUT="$PROJECT_DIR/src/cores/wasm"

fetch_pinned cores.snes9x "$SNES9X_DIR"

cd "$SNES9X_DIR"
# Reset to clean state and reapply the patch idempotently. `git stash`
# discards any prior partial apply attempts.
git checkout -- libretro/libretro.cpp getset.h cpuexec.cpp ppu.h 2>/dev/null || true
if ! git apply --recount --check "$PATCH_FILE" 2>/dev/null; then
  # Patch may already be applied; check by looking for the sentinel symbol.
  if grep -q "ROMDEV_MEMORY_SNES_OAM" libretro/libretro.cpp; then
    echo "Patch already present (sentinel ROMDEV_MEMORY_SNES_OAM found); skipping."
  else
    echo "FATAL: patch failed to apply and sentinel not present." >&2
    exit 1
  fi
else
  git apply --recount "$PATCH_FILE"
  echo "Applied $PATCH_FILE"
fi

# ── romdev shared debug lib (0.80.0) ────────────────────────────────────────
# The watchpoint/readwatch/range/coverage/pcbreak/watchdog machinery + exports now
# live in scripts/romdev-debug/romdev_debug.c (shared by all cores). Stage it at the
# snes9x src root (already on the Makefile's -I$(CORE_DIR) path) so cpuexec.cpp/
# getset.h/libretro.cpp's `#include "romdev_debug.h"` resolves; the per-core patch
# keeps only the 65816 hooks + setReg/getReg + the VRAM-port watch + memory regions.
RDBG_SRC="$PROJECT_DIR/scripts/romdev-debug"
cp "$RDBG_SRC/romdev_debug.h" "$RDBG_SRC/romdev_debug.c" "$SNES9X_DIR/"
ROMDEV_INC="-I$SNES9X_DIR"

# Build the libretro static archive (.a) using snes9x's own emscripten
# Makefile platform.
cd "$SNES9X_DIR/libretro"
emmake make platform=emscripten clean >/dev/null 2>&1 || true
# Drop a stale renamed .a so find -quit can't pick it over the fresh build.
find . -maxdepth 1 -name "*_libretro*.a" -delete 2>/dev/null || true
emmake make platform=emscripten -j"$(nproc)" INCFLAGS_PLATFORM="$ROMDEV_INC"

# Locate the produced archive. snes9x may emit `.a` or `.bc` depending
# on the upstream Makefile version; both are LLVM IR archives that emcc
# can link.
CORE_LIB=$(find . -maxdepth 1 \( -name "*.a" -o -name "*_libretro*.bc" \) -print -quit)
if [ -z "$CORE_LIB" ]; then
  echo "FATAL: snes9x emscripten build did not produce a .a or .bc archive." >&2
  exit 1
fi
if [[ "$CORE_LIB" == *.bc ]] && head -c 7 "$CORE_LIB" | grep -q '!<arch>'; then
  mv "$CORE_LIB" "${CORE_LIB%.bc}.a"
  CORE_LIB="${CORE_LIB%.bc}.a"
fi

# Compile the shared romdev_debug.c + add it to the archive so its exports link in.
RDBG_OBJ="$SNES9X_DIR/romdev_debug.o"
emcc -c -O2 "$SNES9X_DIR/romdev_debug.c" -o "$RDBG_OBJ"
emar rcs "$CORE_LIB" "$RDBG_OBJ"

# Final emcc link → WASM module. Flags mirror retroemu's snes9x.sh so the
# core stays interchangeable with the rest of our bundled libretro cores.
EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_romdev_watchpoint_set","_romdev_watchpoint_set_cond","_romdev_watchpoint_get","_romdev_readwatch_set","_romdev_readwatch_get","_romdev_pcbreak_set","_romdev_pcbreak_get","_romdev_watchdog_set","_romdev_setreg","_romdev_getreg","_romdev_range_set","_romdev_range_get","_romdev_cov_set","_romdev_cov_get","_romdev_regsnap_get","_romdev_irqblock_set","_romdev_vramwatch_set","_romdev_vramwatch_get","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS"]'

mkdir -p "$OUT"
emcc "$CORE_LIB" \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=create_snes9x \
  -s ENVIRONMENT=node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=33554432 \
  -s MAXIMUM_MEMORY=268435456 \
  -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  -s FILESYSTEM=1 \
  -s INVOKE_RUN=0 \
  -s USE_ZLIB=1 \
  -o "$OUT/snes9x_libretro.js"

echo "snes9x_libretro staged at $OUT"
ls -lh "$OUT/snes9x_libretro."{js,wasm}

# Also stage into the carved-out binary package the registry actually resolves
# at runtime (src/cores/registry.js → romdev-platform-snes). Without this the
# dev tree keeps loading the OLD package copy and a rebuild appears to "do
# nothing".
PKG_OUT="$PROJECT_DIR/../romdev-platform-snes/wasm"
if [ -d "$PKG_OUT" ]; then
  cp "$OUT/snes9x_libretro.js"   "$PKG_OUT/snes9x_libretro.js"
  cp "$OUT/snes9x_libretro.wasm" "$PKG_OUT/snes9x_libretro.wasm"
  echo "also staged into romdev-platform-snes package: $PKG_OUT"
fi
