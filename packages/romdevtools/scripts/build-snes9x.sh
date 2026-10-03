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
# romdev's Python-free emscripten driver (scripts/wasm-emcc), never emsdk's emcc.
export PATH="$SCRIPT_DIR/wasm-emcc/bin:$PATH"
require_cmd emcc
if [ "$(command -v emcc)" != "$SCRIPT_DIR/wasm-emcc/bin/emcc" ]; then
  echo "FATAL: emcc must be romdev's wasm-emcc ($SCRIPT_DIR/wasm-emcc/bin/emcc)." >&2
  exit 1
fi
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
require_git_toplevel
# Two patches, in order: the memory regions, then the ST011 / ST018 on bsnes's
# chips (scripts/patches/snes9x-bsnes-chips.patch, written against the first).
BCHIP_PATCH="$PROJECT_DIR/scripts/patches/snes9x-bsnes-chips.patch"
git checkout -- libretro/libretro.cpp getset.h cpuexec.cpp ppu.h gfx.cpp memmap.cpp cpu.cpp seta.h seta018.cpp libretro/Makefile.common 2>/dev/null || true
for P in "$PATCH_FILE" "$BCHIP_PATCH"; do
  if ! git apply --recount --check "$P" 2>/dev/null; then
    # Accept "already applied" only when THIS patch reverse-applies cleanly; an older
    # revision of the patch carries the same sentinel symbols.
    if patch_already_applied "$P"; then
      echo "Patch already present (reverse-applies cleanly); skipping $P."
    else
      echo "FATAL: $P failed to apply and is not already present." >&2
      exit 1
    fi
  else
    git apply --recount "$P"
    echo "Applied $P"
  fi
done

# ── the ST011 / ST018 on bsnes's chips ─────────────────────────────────────
# bsnes's uPD96050 and ARM cores (the pinned bsnes tree, with the nall
# platform line of scripts/patches/bsnes-romdev.patch) plus the drivers the
# recompiler's chip units compile (scripts/recompile-gen/bsnes-chips/glue),
# so this core and a recompiled cart run the same chip code. They are used
# only when the chip's firmware is in the system directory
# (scripts/patches/snes9x/romdev_bchip.cpp). bsnes is GPL-3.0.
BSNES_DIR="$BUILD_DIR/bsnes/src"
fetch_pinned cores.bsnes "$BSNES_DIR"
BSNES_PATCH="$PROJECT_DIR/$(pin_get cores.bsnes patch)"
if ! (cd "$BSNES_DIR" && patch_already_applied "$BSNES_PATCH"); then
  (cd "$BSNES_DIR" && require_git_toplevel && git checkout -- . && git apply --recount "$BSNES_PATCH")
  echo "Applied $BSNES_PATCH to $BSNES_DIR"
fi
BCHIP_GLUE="$PROJECT_DIR/scripts/recompile-gen/bsnes-chips/glue"
# the snes9x side is built by snes9x's Makefile (the patch lists it), next to its header
cp "$PROJECT_DIR/scripts/patches/snes9x/romdev_bchip.cpp" "$SNES9X_DIR/romdev_bchip.cpp"
cp "$BCHIP_GLUE/romdev_bsnes_chips.hpp" "$SNES9X_DIR/romdev_bsnes_chips.hpp"

# ── romdev shared debug lib (0.80.0) ────────────────────────────────────────
# The watchpoint/readwatch/range/coverage/pcbreak/watchdog machinery + exports now
# live in scripts/romdev-debug/romdev_debug.c (shared by all cores). Stage it at the
# snes9x src root (already on the Makefile's -I$(CORE_DIR) path) so cpuexec.cpp/
# getset.h/libretro.cpp's `#include "romdev_debug.h"` resolves; the per-core patch
# keeps only the 65816 hooks + setReg/getReg + the VRAM-port watch + memory regions.
RDBG_SRC="$PROJECT_DIR/scripts/romdev-debug"
cp "$RDBG_SRC/romdev_debug.h" "$RDBG_SRC/romdev_debug.c" "$SNES9X_DIR/"
# The coprocessor state serializer (snes_chipstate region): the SAME file the
# recompiler's chip units compile (scripts/recompile-gen/snes9x-chips), so the
# reference and a recompiled cart write identical bytes.
cp "$PROJECT_DIR/scripts/recompile-gen/snes9x-chips/glue/romdev_chipstate.h" "$SNES9X_DIR/libretro/"
ROMDEV_INC="-I$SNES9X_DIR"

# Build the libretro static archive (.a) using snes9x's own emscripten
# Makefile platform.
cd "$SNES9X_DIR/libretro"
emmake make platform=emscripten clean >/dev/null 2>&1 || true
# Drop a stale renamed .a so find -quit can't pick it over the fresh build.
find . -maxdepth 1 -name "*_libretro*.a" -delete 2>/dev/null || true
emmake make platform=emscripten -j"${JOBS:-$(nproc)}" INCFLAGS_PLATFORM="$ROMDEV_INC"

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

# The bsnes chips (see above): bsnes's sources with bsnes's language level
# and the glue (the snes9x side, romdev_bchip.cpp, is in the archive already).
BCHIP_OBJ_DIR="$SNES9X_DIR/romdev-bchip-obj"
rm -rf "$BCHIP_OBJ_DIR"; mkdir -p "$BCHIP_OBJ_DIR"
BCHIP_FLAGS=(-O2 -std=c++17 -Wno-invalid-specialization -Wno-everything -I"$BSNES_DIR" -I"$BSNES_DIR/bsnes" -I"$BCHIP_GLUE")
em++ -c "${BCHIP_FLAGS[@]}" "$BSNES_DIR/bsnes/processor/upd96050/upd96050.cpp" -o "$BCHIP_OBJ_DIR/upd96050.o"
em++ -c "${BCHIP_FLAGS[@]}" "$BSNES_DIR/bsnes/processor/arm7tdmi/arm7tdmi.cpp" -o "$BCHIP_OBJ_DIR/arm7tdmi.o"
em++ -c "${BCHIP_FLAGS[@]}" "$BCHIP_GLUE/glue_necdsp.cpp" -o "$BCHIP_OBJ_DIR/glue_necdsp.o"
em++ -c "${BCHIP_FLAGS[@]}" "$BCHIP_GLUE/glue_armdsp.cpp" -o "$BCHIP_OBJ_DIR/glue_armdsp.o"
# the ARM is a cothread, as in bsnes: romdev's libco backend (Asyncify inside the module)
emcc -c -O2 -I"$BSNES_DIR/libco" "$PROJECT_DIR/scripts/patches/bsnes/libco-wasm.c" -o "$BCHIP_OBJ_DIR/libco-wasm.o"
emar rcs "$CORE_LIB" "$BCHIP_OBJ_DIR"/*.o

# Final emcc link → WASM module. Flags mirror retroemu's snes9x.sh so the
# core stays interchangeable with the rest of our bundled libretro cores.
EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_romdev_watchpoint_set","_romdev_watchpoint_set_cond","_romdev_watchpoint_get","_romdev_readwatch_set","_romdev_readwatch_get","_romdev_pcbreak_set","_romdev_pcbreak_get","_romdev_watchdog_set","_romdev_setreg","_romdev_getreg","_romdev_range_set","_romdev_range_get","_romdev_cov_set","_romdev_cov_get","_romdev_covbits_set","_romdev_covbits_get","_romdev_trace_set","_romdev_trace_info","_romdev_trace_regs","_romdev_regsnap_get","_romdev_irqblock_set","_romdev_vramwatch_set","_romdev_vramwatch_get","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS"]'

mkdir -p "$OUT"
# wasm-emcc runs the Asyncify pass for the ARM's cothread (the module imports
# the intrinsics); only the functions that can be on a cothread's stack are
# instrumented (bsnes's chip code, nall, the glue, co_switch and its leaf
# co_suspend), so snes9x's own code is untouched.
export ROMDEV_ASYNCIFY_ONLY="co_switch,co_suspend,romdev_bchip::*,SuperFamicom::*,Processor::*,nall::*"
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
