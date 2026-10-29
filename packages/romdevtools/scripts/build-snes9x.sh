#!/usr/bin/env bash
# Build snes9x libretro core → WASM, with romdev's custom memory
# region patch applied (exposes OAM/CGRAM/ARAM/FillRAM via
# retro_get_memory_data for the inspectSprites/inspectPalette tools).
#
# Output: src/cores/wasm/snes9x_libretro.{js,wasm}.
#
# Repro: this script self-contains everything. Clones snes9x upstream,
# applies scripts/patches/snes9x-romdev-memory-regions.patch (and the two
# patches below), builds with emscripten using the exact link flags retroemu
# uses, stages the .js/.wasm under src/cores/wasm/.
#
# The core carries no Nintendo code or chip data: the SPC700 boot ROM is
# romdev's own (scripts/spc700-ipl), and the DSP-1 / DSP-3 / ST010 data ROM
# tables are emptied and read from the user's data ROM in the system
# directory (scripts/patches/snes9x/romdev_hledata.cpp).
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
# Three patches, in order: the memory regions, the ST011 / ST018 on ares's
# chips (scripts/patches/snes9x-ares-chips.patch, written against the first),
# then the chip data ROMs from the system directory
# (scripts/patches/snes9x-romdev-hle-data.patch, against the first two).
FWCHIP_PATCH="$PROJECT_DIR/scripts/patches/snes9x-ares-chips.patch"
HLEDATA_PATCH="$PROJECT_DIR/scripts/patches/snes9x-romdev-hle-data.patch"
git checkout -- libretro/libretro.cpp getset.h cpuexec.cpp ppu.h gfx.cpp memmap.cpp memmap.h cpu.cpp seta.h seta018.cpp libretro/Makefile.common \
  dsp1.cpp dsp3.cpp seta010.cpp apu/bapu/smp/iplrom.cpp 2>/dev/null || true
for P in "$PATCH_FILE" "$FWCHIP_PATCH" "$HLEDATA_PATCH"; do
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

# ── the SPC700 boot ROM ─────────────────────────────────────────────────────
# romdev's own boot ROM (scripts/spc700-ipl/ipl.asm, MIT, a clean-room
# reimplementation of the upload protocol) replaces upstream's iplrom.cpp, so
# the built core carries no Nintendo code.
node "$SCRIPT_DIR/spc700-ipl/install-ipl.mjs" --snes9x "$SNES9X_DIR/apu/bapu/smp/iplrom.cpp"

# ── the chip data ROMs ──────────────────────────────────────────────────────
# The DSP-1, DSP-3 and ST010 data ROM tables upstream embeds are emptied, and
# romdev_hledata.cpp fills them from the user's data ROM in the system
# directory (the same fill code as a recompiled cart: romdev_hledata.h).
node "$PROJECT_DIR/scripts/recompile-gen/snes9x-chips/hle-data.mjs" "$SNES9X_DIR"
cp "$PROJECT_DIR/scripts/patches/snes9x/romdev_hledata.cpp" "$SNES9X_DIR/romdev_hledata.cpp"
cp "$PROJECT_DIR/scripts/recompile-gen/snes9x-chips/glue/romdev_hledata.h" "$SNES9X_DIR/romdev_hledata.h"

# ── the ST011 / ST018 on ares's chips ──────────────────────────────────────
# ares's uPD96050 and ARM cores (the pinned ares tree, fetched and patched by
# scripts/fetch-ares.sh) plus the drivers the recompiler's chip units compile
# (scripts/recompile-gen/ares-chips/glue), so this core and a recompiled cart
# run the same chip code. They are used only when the chip's firmware is in
# the system directory (scripts/patches/snes9x/romdev_fwchip.cpp). ares is
# ISC-licensed (permissive), so its code may sit inside snes9x.
bash "$SCRIPT_DIR/fetch-ares.sh"
ARES_DIR="$BUILD_DIR/ares/src"
FWCHIP_GLUE="$PROJECT_DIR/scripts/recompile-gen/ares-chips/glue"
# the snes9x side is built by snes9x's Makefile (the patch lists it), next to its header
cp "$PROJECT_DIR/scripts/patches/snes9x/romdev_fwchip.cpp" "$SNES9X_DIR/romdev_fwchip.cpp"
cp "$FWCHIP_GLUE/romdev_ares_chips.hpp" "$SNES9X_DIR/romdev_ares_chips.hpp"

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
# Keep build-machine paths out of the shipped module (assert/__FILE__ strings
# from snes9x and ares).
PREFIX_MAP="-ffile-prefix-map=$BUILD_DIR=/build -ffile-prefix-map=$PROJECT_DIR=/romdev"

# Build the libretro static archive (.a) using snes9x's own emscripten
# Makefile platform.
cd "$SNES9X_DIR/libretro"
emmake make platform=emscripten clean >/dev/null 2>&1 || true
# Drop a stale renamed .a so find -quit can't pick it over the fresh build.
find . -maxdepth 1 -name "*_libretro*.a" -delete 2>/dev/null || true
emmake make platform=emscripten -j"${JOBS:-$(nproc)}" INCFLAGS_PLATFORM="$ROMDEV_INC $PREFIX_MAP"

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
emcc -c -O2 $PREFIX_MAP "$SNES9X_DIR/romdev_debug.c" -o "$RDBG_OBJ"
emar rcs "$CORE_LIB" "$RDBG_OBJ"

# The ares chips (see above): ares's sources with ares's language level
# (C++20) against romdev's stand-in for ares/ares.hpp (glue/romdev_ares.hpp,
# staged as include/ares/ares.hpp ahead of the ares tree), and the glue (the
# snes9x side, romdev_fwchip.cpp, is in the archive already).
FWCHIP_OBJ_DIR="$SNES9X_DIR/romdev-fwchip-obj"
rm -rf "$FWCHIP_OBJ_DIR"; mkdir -p "$FWCHIP_OBJ_DIR/include/ares"
cp "$FWCHIP_GLUE/romdev_ares.hpp" "$FWCHIP_OBJ_DIR/include/ares/ares.hpp"
FWCHIP_FLAGS=(-O2 $PREFIX_MAP -std=c++20 -Wno-everything -I"$FWCHIP_OBJ_DIR/include" -I"$FWCHIP_GLUE" -I"$ARES_DIR/nall" -I"$ARES_DIR" -I"$ARES_DIR/ares" -I"$ARES_DIR/libco")
em++ -c "${FWCHIP_FLAGS[@]}" "$ARES_DIR/ares/component/processor/upd96050/upd96050.cpp" -o "$FWCHIP_OBJ_DIR/upd96050.o"
em++ -c "${FWCHIP_FLAGS[@]}" "$ARES_DIR/ares/component/processor/arm7tdmi/arm7tdmi.cpp" -o "$FWCHIP_OBJ_DIR/arm7tdmi.o"
em++ -c "${FWCHIP_FLAGS[@]}" "$FWCHIP_GLUE/glue_necdsp.cpp" -o "$FWCHIP_OBJ_DIR/glue_necdsp.o"
em++ -c "${FWCHIP_FLAGS[@]}" "$FWCHIP_GLUE/glue_armdsp.cpp" -o "$FWCHIP_OBJ_DIR/glue_armdsp.o"
# the ARM is a cothread, as in ares: romdev's libco backend (Asyncify inside the module)
emcc -c -O2 $PREFIX_MAP -I"$ARES_DIR/libco" "$PROJECT_DIR/scripts/patches/libco-wasm/libco-wasm.c" -o "$FWCHIP_OBJ_DIR/libco-wasm.o"
emar rcs "$CORE_LIB" "$FWCHIP_OBJ_DIR"/*.o

# Final emcc link → WASM module. Flags mirror retroemu's snes9x.sh so the
# core stays interchangeable with the rest of our bundled libretro cores.
EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_romdev_watchpoint_set","_romdev_watchpoint_set_cond","_romdev_watchpoint_get","_romdev_readwatch_set","_romdev_readwatch_get","_romdev_pcbreak_set","_romdev_pcbreak_get","_romdev_watchdog_set","_romdev_setreg","_romdev_getreg","_romdev_range_set","_romdev_range_get","_romdev_cov_set","_romdev_cov_get","_romdev_covbits_set","_romdev_covbits_get","_romdev_trace_set","_romdev_trace_info","_romdev_trace_regs","_romdev_regsnap_get","_romdev_irqblock_set","_romdev_vramwatch_set","_romdev_vramwatch_get","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS"]'

mkdir -p "$OUT"
# wasm-emcc runs the Asyncify pass for the ARM's cothread (the module imports
# the intrinsics); only the functions that can be on a cothread's stack are
# instrumented (ares's chip code and the glue in namespace ares, nall, the
# std::function machinery ARM7TDMI dispatches its instructions through,
# co_switch and its leaf co_suspend), so snes9x's own code is untouched.
export ROMDEV_ASYNCIFY_ONLY="co_switch,co_suspend,*ares::*,*nall::*,*std::__2::__function::*,*std::__2::function*,*std::__2::__invoke*"
emcc "$CORE_LIB" \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=create_snes9x \
  -s ENVIRONMENT=node,web,worker \
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
