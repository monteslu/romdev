#!/usr/bin/env bash
# Build s32core (the sync32 console emulator, monteslu's repo) as a libretro
# WASM core for romdev. Pure C, no upstream fetch: the canonical tree lives
# beside the other cliemu repos, override with S32CORE_SRC.
# NODERAWFS: the frontend fopens the .s32 by real path and streams the
# "<romname>/" data dir straight from disk (same pattern as flycast).
# Output: src/cores/wasm/s32core_libretro.{js,wasm}
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$(dirname "$0")/_lib.sh"
require_cmd emcc

SRC="${S32CORE_SRC:-$HOME/code/cliemu/s32core}"
OUT="$PROJECT_DIR/src/cores/wasm"
[ -d "$SRC" ] || { echo "FATAL: s32core not found at $SRC" >&2; exit 1; }

RETRO_EXPORTS='"_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_retro_load_game_special","_retro_cheat_reset","_retro_cheat_set"'
EXP="[${RETRO_EXPORTS},\"_malloc\",\"_free\"]"
RT='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue"]'

cd "$SRC"
emcc -O2 -ffp-contract=off -Iinclude \
  src/core.c src/cpu.c src/console.c src/interp.c src/vfp.c \
  frontends/libretro/libretro.c \
  -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=create_s32core \
  -s ENVIRONMENT=node -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=50331648 \
  -s ALLOW_TABLE_GROWTH=1 -s INVOKE_RUN=0 -s NODERAWFS=1 \
  -s EXPORTED_FUNCTIONS="$EXP" -s EXPORTED_RUNTIME_METHODS="$RT" \
  -o s32core_libretro.js

mkdir -p "$OUT"
cp s32core_libretro.js "$OUT/s32core_libretro.js"
cp s32core_libretro.wasm "$OUT/s32core_libretro.wasm"
echo "s32core_libretro staged at $OUT"

# ALSO stage into the binary package — that is what actually SHIPS.
# `src/cores/wasm/` is gitignored build-staging: a core that lands only there
# works on the build machine and nowhere else. Every other core resolves
# through its romdev-core-* package (see registry.js resolveCore), so miss this
# step and `sync32` silently drops off listPlatforms for every installed user.
PKG_OUT="$PROJECT_DIR/../romdev-core-s32core/wasm"
if [ -d "$PKG_OUT" ]; then
  cp s32core_libretro.js   "$PKG_OUT/s32core_libretro.js"
  cp s32core_libretro.wasm "$PKG_OUT/s32core_libretro.wasm"
  echo "also staged into romdev-core-s32core package: $PKG_OUT"
fi
rm -f s32core_libretro.js s32core_libretro.wasm
