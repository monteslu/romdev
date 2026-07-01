#!/usr/bin/env bash
# Build the GameTank libretro core → WASM (retroemu ES6 factory), WITH romdev's
# live-debug instrumentation: the shared romdev_debug.{h,c} + a thin GameTank shim
# (romdev_gametank.cpp) that hooks MemoryWrite / MemoryRead / the mos6502 dispatch
# (cpu_core->Run) / setReg-getReg. This makes GameTank a full Tier-1: cpuState +
# write/read watchpoints + pc-break + watchdog + coverage, on top of build/run/
# screenshot/disasm/decompile that already worked.
#
# Output: src/cores/wasm/gametank_libretro.{js,wasm} + the romdev-core-gametank pkg.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git
require_cmd make

# GameTank core lives at ~/code/cliemu/gametank-libretro (monteslu's repo). Built
# in-place (it's the canonical tree); pin via the git ref in versions.json once added.
SRC="${GAMETANK_SRC:-$HOME/code/cliemu/gametank-libretro}"
OUT="$PROJECT_DIR/src/cores/wasm"
RDBG="$PROJECT_DIR/scripts/romdev-debug"
[ -d "$SRC" ] || { echo "FATAL: gametank-libretro not found at $SRC" >&2; exit 1; }

cd "$SRC"
git checkout -- src/libretro.cpp vendor/mos6502/mos6502.cpp 2>/dev/null || true

# ── stage the shared debug lib next to the core (quote-include reach) ──
cp "$RDBG/romdev_debug.h" romdev_debug.h
cp "$RDBG/romdev_debug.h" src/romdev_debug.h   # so the Makefile's -Isrc finds it
cp "$RDBG/romdev_debug.c" romdev_debug.c
echo "romdev: staged shared romdev_debug.{h,c}"

# ── append the GameTank shim to libretro.cpp (it sees cpu_core + system_state) ──
if ! grep -q "romdev_gametank_step" src/libretro.cpp; then
  cat "$SCRIPT_DIR/patches/romdev-snippets/gametank-debug.cpp" >> src/libretro.cpp
  echo "romdev: appended romdev_gametank.cpp to src/libretro.cpp"
fi

# ── inject hook calls ──
# write-watch + range-write: at the top of MemoryWrite(address, value).
perl -0pi -e 's/(void MemoryWrite\(uint16_t address, uint8_t value\) \{)/extern "C" void romdev_gametank_write(unsigned int,unsigned int);\n$1\n    romdev_gametank_write(address, value);/ unless /romdev_gametank_write\(address, value\);/' src/libretro.cpp
# read-watch + Game Genie: replace MemoryRead's one-line body so it reads the real byte,
# runs the observe hook (read-watch), then applies the cheat SUBSTITUTION (romdev_cheat_read
# from the shared lib — hardware-faithful: address match → return the substitute byte, with
# optional compare-against-original) and returns whatever it gives back.
perl -0pi -e 's/uint8_t MemoryRead\(uint16_t address\) \{\n    return MemoryReadResolve\(address, true\);\n\}/extern "C" void romdev_gametank_read(unsigned int,unsigned int);\nextern "C" unsigned char romdev_cheat_read(unsigned int,unsigned char);\nuint8_t MemoryRead(uint16_t address) {\n    uint8_t romdev_v = MemoryReadResolve(address, true);\n    romdev_gametank_read(address, romdev_v);\n    return romdev_cheat_read(address & 0xFFFF, romdev_v);\n}/ unless /romdev_gametank_read\(address/' src/libretro.cpp

# pc-break + coverage + watchdog: in the mos6502 Run() loop, right before the
# opcode fetch (pc is the instruction about to execute). On a hit, set freeze —
# the loop's existing `if(freeze){ --pc; ... break; }` halts cleanly. The forward
# decl goes at FILE scope (extern "C" can't be a block-scope linkage spec in C++).
perl -0pi -e 's/(#include "mos6502.h"\n)/$1\nextern "C" int romdev_gametank_step(unsigned int pc);\n/ unless /romdev_gametank_step/' vendor/mos6502/mos6502.cpp
perl -0pi -e 's/(\n\t\t\/\/ fetch\n)/\n\t\tif (romdev_gametank_step(pc)) { freeze = true; }\n$1/ unless /romdev_gametank_step\(pc\)/' vendor/mos6502/mos6502.cpp

# per-frame UNFREEZE: mos6502::Run() begins with `if(freeze) return;` — that's how
# the dispatch breakpoint halts cleanly. But cpu->freeze is a STICKY CPU field that
# nothing resets, so a single dispatch hit (or a stale pc_hit carried across a
# loadMedia in the same WASM instance) wedges the CPU FOREVER: the NMI + page-flip
# keep running, so the screen shows two frozen pages while game logic never advances
# (the GameTank "logic runs, screen frozen on 2 stale pages" bug). Before each
# frame's Run(), clear freeze UNLESS the debug layer is genuinely holding a
# breakpoint (romdev_is_frozen() == pc_hit). Keeps breakpoints/single-step working;
# guarantees normal playback always resumes.
perl -0pi -e 's/(\n[ \t]*cpu_core->Run\(\(int32_t\)intended_cycles, timekeeper\.totalCyclesCount\);)/\n    if (!romdev_is_frozen()) cpu_core->freeze = false;$1/ unless /if \(!romdev_is_frozen\(\)\) cpu_core->freeze/' src/libretro.cpp
# romdev_is_frozen() lives in romdev_debug.{h,c} (included lower in the file); add a
# file-scope forward decl next to the other romdev forward decl so retro_run sees it.
perl -0pi -e 's/(extern "C" void romdev_gametank_write\(unsigned int,unsigned int\);)/extern "C" int romdev_is_frozen(void);\n$1/ unless /romdev_is_frozen\(void\);/' src/libretro.cpp

echo "romdev: instrumented MemoryWrite / MemoryRead / mos6502 dispatch + per-frame unfreeze"

# ── build with the romdev EXPORTS appended ──
source "$HOME/code/mine/emsdk/emsdk_env.sh" >/dev/null 2>&1 || true

# the romdev_* exports the host feature-detects (shared lib surface + per-core snap/setreg)
ROMDEV_EXPORTS='"_romdev_watchpoint_set","_romdev_watchpoint_set_cond","_romdev_watchpoint_get","_romdev_readwatch_set","_romdev_readwatch_get","_romdev_pcbreak_set","_romdev_pcbreak_get","_romdev_watchdog_set","_romdev_regsnap_get","_romdev_irqblock_set","_romdev_range_set","_romdev_range_get","_romdev_cov_set","_romdev_cov_get","_romdev_setreg","_romdev_getreg","_romdev_acp_get","_romdev_cheat_set","_romdev_cheat_get","_romdev_cheat_read"'

# Step 1: compile the core objects via the Makefile's retroemu target (with
# romdev_debug.c added to SOURCES). The Makefile's EM_EXPORTS only lists the
# retro_* fns, so its link drops the romdev_* symbols — we re-link in step 2.
emmake make platform=retroemu clean >/dev/null 2>&1 || true
emmake make platform=retroemu -j"$(nproc)" \
  SOURCES="src/libretro.cpp src/palette_libretro.cpp vendor/blitter.cpp vendor/audio_coprocessor.cpp vendor/emulator_config.cpp vendor/timekeeper.cpp vendor/mos6502/mos6502.cpp romdev_debug.c" \
  >/dev/null 2>&1 || true

# Step 2: explicit re-link with the FULL export set (retro_* + romdev_*). Uses the
# .em.o objects the Makefile just built + romdev_debug.c compiled in. -I. so the
# romdev_debug.c finds its own header.
RETRO_EXPORTS='"_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device"'
EXP="[${RETRO_EXPORTS},${ROMDEV_EXPORTS},\"_malloc\",\"_free\"]"
RT='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue"]'
emcc -O2 \
  src/libretro.em.o src/palette_libretro.em.o vendor/blitter.em.o \
  vendor/audio_coprocessor.em.o vendor/emulator_config.em.o vendor/timekeeper.em.o \
  vendor/mos6502/mos6502.em.o romdev_debug.c -I. \
  -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=create_gametank \
  -s ENVIRONMENT=node -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=33554432 \
  -s MAXIMUM_MEMORY=268435456 -s ALLOW_TABLE_GROWTH=1 -s INVOKE_RUN=0 \
  -s EXPORTED_FUNCTIONS="$EXP" -s EXPORTED_RUNTIME_METHODS="$RT" \
  -o gametank_libretro.js
grep -q "romdev_watchpoint_set" gametank_libretro.js || { echo "FATAL: romdev exports missing after relink" >&2; exit 1; }
echo "romdev: linked with full export set (retro_* + 16 romdev_*)"

mkdir -p "$OUT"
cp gametank_libretro.js   "$OUT/gametank_libretro.js"
cp gametank_libretro.wasm "$OUT/gametank_libretro.wasm"
echo "gametank_libretro staged at $OUT"

PKG_OUT="$PROJECT_DIR/../romdev-core-gametank/wasm"
if [ -d "$PKG_OUT" ]; then
  cp gametank_libretro.js   "$PKG_OUT/gametank_libretro.js"
  cp gametank_libretro.wasm "$PKG_OUT/gametank_libretro.wasm"
  echo "also staged into romdev-core-gametank package: $PKG_OUT"
fi
