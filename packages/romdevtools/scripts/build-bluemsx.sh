#!/usr/bin/env bash
# Build blueMSX (MSX / MSX2) libretro core → WASM, + fetch C-BIOS (the open MSX
# BIOS) so cartridge homebrew boots with no proprietary ROM.
#
# Applies two patches:
#  1. bluemsx-emscripten-build.patch — REQUIRED. Makefile -fno-common + clang
#     warning relaxations (see the patch header; -fno-common is the non-obvious
#     fix — -fcommon makes blueMSX's tentative symbols vanish under wasm-ld).
#  2. bluemsx-romdev-memory-regions.patch — OPTIONAL during bring-up (exposes
#     VRAM/VDP regs/palette/AY8910/z80 + findWriter for the inspect tools).
#
# Output: src/cores/wasm/bluemsx_libretro.{js,wasm} and the C-BIOS roms into the
# romdev-core-bluemsx package's bios/ dir.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git
require_cmd make

DIR="$BUILD_DIR/bluemsx"
BUILD_PATCH="$PROJECT_DIR/scripts/patches/bluemsx-emscripten-build.patch"
REGION_REL="$(pin_get cores.bluemsx patch || true)"
REGION_PATCH="$PROJECT_DIR/${REGION_REL:-}"
# blueMSX ships from its own binary package (romdev-core-bluemsx), which the
# core registry resolves first. Stage the wasm + C-BIOS there (src/cores/wasm is
# a gitignored dev fallback).
OUT="$PROJECT_DIR/../romdev-core-bluemsx/wasm"
BIOS_OUT="$PROJECT_DIR/../romdev-core-bluemsx/bios"

fetch_pinned cores.bluemsx "$DIR"

cd "$DIR"
# 1) build-config patch (required).
git checkout -- Makefile.libretro 2>/dev/null || true
if git apply --recount --check "$BUILD_PATCH" 2>/dev/null; then
  git apply --recount "$BUILD_PATCH"; echo "Applied $BUILD_PATCH"
elif grep -q -- "-fno-common" Makefile.libretro; then
  echo "Build patch already present (-fno-common found); skipping."
else
  echo "FATAL: blueMSX build patch failed to apply." >&2; exit 1
fi

# 2) region patch (optional during bring-up).
if [ -n "${REGION_REL:-}" ] && [ -f "$REGION_PATCH" ]; then
  if git apply --recount --check "$REGION_PATCH" 2>/dev/null; then
    git apply --recount "$REGION_PATCH"; echo "Applied $REGION_PATCH"
  elif grep -rq "romdev_watchpoint_set" libretro.c Src/ 2>/dev/null; then
    echo "Region patch already present; skipping."
  else
    echo "WARNING: region patch failed to apply; building without it." >&2
  fi
else
  echo "No region patch yet — building stock blueMSX (+ build fix)."
fi

# ── romdev shared debug lib (0.80.0) ─ stage romdev_debug.h at the root (on the
# Makefile's -I$(CORE_DIR) path) AND in Src/Z80/ (R800.c includes it); inject via
# INCFLAGS_PLATFORM too. The per-core patch keeps the MSX VRAM watch + setReg/getReg.
RDBG_SRC="$PROJECT_DIR/scripts/romdev-debug"
cp "$RDBG_SRC/romdev_debug.h" "$DIR/romdev_debug.h"
cp "$RDBG_SRC/romdev_debug.h" "$DIR/Src/Z80/romdev_debug.h"
cp "$RDBG_SRC/romdev_debug.c" "$DIR/romdev_debug.c"

emmake make -f Makefile.libretro platform=emscripten clean >/dev/null 2>&1 || true
find . -name "*.o" -delete 2>/dev/null || true
emmake make -f Makefile.libretro platform=emscripten -j"$(nproc)" INCFLAGS_PLATFORM="-I$DIR"

# Compile the shared romdev_debug.c so it links with the rest of the objects.
emcc -c -O2 "$DIR/romdev_debug.c" -o "$DIR/romdev_debug.o"

# blueMSX must be linked from the .o files directly (an emar archive drops the
# tentative/common symbols even with -fno-common). Collect every object.
OBJS=$(find . -name "*.o" | tr '\n' ' ')
[ -z "$OBJS" ] && { echo "FATAL: blueMSX build produced no objects." >&2; exit 1; }

WP_EXPORTS=""
grep -rq "romdev_watchpoint_get" libretro.c Src/ "$DIR/romdev_debug.c" 2>/dev/null && WP_EXPORTS='"_romdev_watchpoint_set","_romdev_watchpoint_set_cond","_romdev_watchpoint_get",'
# PC breakpoint + read watchpoint (Z80 execute/read hooks in Src/Z80/R800.c,
# exports in libretro.c) — drive runUntilPC / runUntilRead / stepInstruction.
BP_EXPORTS=""
grep -rq "romdev_pcbreak_get" libretro.c Src/ "$DIR/romdev_debug.c" 2>/dev/null && BP_EXPORTS='"_romdev_pcbreak_set","_romdev_pcbreak_get","_romdev_readwatch_set","_romdev_readwatch_get",'
# Instruction WATCHDOG (force-stop a runaway callSubroutine so it can't hang the
# WASM). State + run-loop hook in Src/Z80/R800.c; romdev_watchdog_set in libretro.c.
WD_EXPORTS=""
grep -rq "romdev_watchdog_set" libretro.c Src/ "$DIR/romdev_debug.c" 2>/dev/null && WD_EXPORTS='"_romdev_watchdog_set","_romdev_regsnap_get","_romdev_irqblock_set","_romdev_vramwatch_set","_romdev_vramwatch_get",'
# RE primitives round 2: register read/write (callSubroutine/setRegister) +
# range-watch (watchRange) + PC-coverage (logPCRange). Z80/R800 hooks in
# Src/Z80/R800.c, exports in libretro.c. Same reg-id convention as the other Z80
# cores (0=A 1=F 2=B 3=C 4=D 5=E 6=H 7=L 8=IX 9=IY 16=PC 18=SP).
RE2_EXPORTS=""
grep -rq "romdev_setreg" libretro.c Src/ 2>/dev/null && RE2_EXPORTS='"_romdev_setreg","_romdev_getreg","_romdev_range_set","_romdev_range_get","_romdev_cov_set","_romdev_cov_get",'
EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set",'"$WP_EXPORTS"''"$BP_EXPORTS"''"$WD_EXPORTS"''"$RE2_EXPORTS"'"_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS"]'

mkdir -p "$OUT"
emcc $OBJS \
  -O3 -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=create_bluemsx \
  -s ENVIRONMENT=node -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=134217728 \
  -s MAXIMUM_MEMORY=536870912 -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  -s FILESYSTEM=1 -s INVOKE_RUN=0 -s USE_ZLIB=1 \
  -o "$OUT/bluemsx_libretro.js"

echo "bluemsx_libretro staged at $OUT"
ls -lh "$OUT/bluemsx_libretro."{js,wasm}

# ---- C-BIOS (open MSX BIOS, 2-clause BSD) ----
# blueMSX-libretro already SHIPS the C-BIOS machine tree under its
# system/bluemsx/Machines/<name>/ (cbios_*.rom + a config.ini per machine). The
# host points blueMSX's system dir at our bios/ and mirrors it into the wasm FS,
# so we need the full `Machines/<machine> - C-BIOS/` tree (NOT loose roms) — the
# core fopen()s `<systemDir>/Machines/<machineName>/cbios_*.rom` + config.ini.
# The Machines tree (~260KB) boots plain cartridges. The Databases tree is
# ALSO required: blueMSX picks a cartridge's MAPPER by looking the ROM up in
# these XMLs, so without them any megaROM/mapper cart loads, reports success,
# and sits on a blank screen. Databases are staged here from the fetched
# upstream and published from disk -- they are gitignored (upstream content,
# fetched not vendored, same as the core wasm).
mkdir -p "$BIOS_OUT"
SRC_SYS="$DIR/system/bluemsx"
if [ -d "$SRC_SYS/Machines" ]; then
  # Copy only the C-BIOS machines (open BSD BIOS); skip proprietary machine dirs.
  for m in "$SRC_SYS/Machines/"*"C-BIOS"*; do
    [ -d "$m" ] || continue
    cp -r "$m" "$BIOS_OUT/Machines/" 2>/dev/null || { mkdir -p "$BIOS_OUT/Machines"; cp -r "$m" "$BIOS_OUT/Machines/"; }
  done
  echo "C-BIOS machine tree staged into $BIOS_OUT/Machines."
  if [ -d "$SRC_SYS/Databases" ]; then
    rm -rf "$BIOS_OUT/Databases"
    cp -r "$SRC_SYS/Databases" "$BIOS_OUT/Databases"
    echo "Mapper databases staged into $BIOS_OUT/Databases ($(du -sh "$BIOS_OUT/Databases" | cut -f1))."
  else
    echo "WARNING: blueMSX source has no system/bluemsx/Databases tree; mapper" >&2
    echo "         carts will not boot. Re-fetch the pinned blueMSX checkout." >&2
  fi
else
  echo "WARNING: blueMSX source has no system/bluemsx/Machines tree at $SRC_SYS." >&2
  echo "         The bundled C-BIOS machines ship with the blueMSX-libretro repo; if absent," >&2
  echo "         fetch C-BIOS (cbios.sourceforge.net, 2-clause BSD) and lay out as" >&2
  echo "         $BIOS_OUT/Machines/'MSX2+ - C-BIOS'/{cbios_*.rom,config.ini}." >&2
fi
find "$BIOS_OUT" -maxdepth 2 -type d 2>/dev/null | head
