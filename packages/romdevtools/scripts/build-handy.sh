#!/usr/bin/env bash
# Build handy (Atari Lynx) libretro core → WASM, with romdev's instruction-level
# write-watchpoint patch applied (CPU_POKE in lynx/c65c02.h records the writing
# 65C02 PC; libretro.cpp exports romdev_watchpoint_set/get for findWriter).
# This core was previously vendored as a prebuilt .wasm with no build script;
# this script makes it reproducible like every other core.
#
# Output: src/cores/wasm/handy_libretro.{js,wasm}.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git
require_cmd make

# Upstream pin lives in scripts/versions.json (cores.handy).
DIR="$BUILD_DIR/handy/src"
PATCH_FILE="$PROJECT_DIR/$(pin_get cores.handy patch)"
OUT="$PROJECT_DIR/src/cores/wasm"

fetch_pinned cores.handy "$DIR"

cd "$DIR"
git checkout -- lynx/c65c02.h libretro/libretro.cpp 2>/dev/null || true
if ! git apply --recount --check "$PATCH_FILE" 2>/dev/null; then
  if grep -q "romdev_watchpoint_set" libretro/libretro.cpp; then
    echo "Patch already present (sentinel romdev_watchpoint_set found); skipping apply."
  else
    echo "FATAL: patch failed to apply and sentinel not present." >&2
    exit 1
  fi
else
  git apply --recount "$PATCH_FILE"
  echo "Applied $PATCH_FILE"
fi

emmake make platform=emscripten clean >/dev/null 2>&1 || true
find . -maxdepth 2 -name "*_libretro_emscripten.a" -delete 2>/dev/null || true
emmake make platform=emscripten -j"$(nproc)"

CORE_LIB=$(find . -maxdepth 2 \( -name "*.a" -o -name "*_libretro_emscripten.bc" \) -print -quit)
if [ -z "$CORE_LIB" ]; then
  echo "FATAL: handy build did not produce a .a or .bc archive." >&2
  exit 1
fi
if [[ "$CORE_LIB" == *.bc ]] && head -c 7 "$CORE_LIB" | grep -q '!<arch>'; then
  mv "$CORE_LIB" "${CORE_LIB%.bc}.a"
  CORE_LIB="${CORE_LIB%.bc}.a"
fi

# libretro-common helpers (file streams, string utils) if the core needs them.
LIBRETRO_COMMON=""
for dir in "libretro-common" "src/libretro-common"; do
  if [ -d "$DIR/$dir" ]; then LIBRETRO_COMMON="$DIR/$dir"; break; fi
done
if [ -n "$LIBRETRO_COMMON" ]; then
  INCLUDE_FLAGS="-I$LIBRETRO_COMMON/include"
  COMMON_OBJS=""
  for src in \
    "$LIBRETRO_COMMON/encodings/encoding_utf.c" \
    "$LIBRETRO_COMMON/compat/compat_strl.c" \
    "$LIBRETRO_COMMON/compat/fopen_utf8.c" \
    "$LIBRETRO_COMMON/file/file_path.c" \
    "$LIBRETRO_COMMON/file/file_path_io.c" \
    "$LIBRETRO_COMMON/streams/file_stream.c" \
    "$LIBRETRO_COMMON/streams/file_stream_transforms.c" \
    "$LIBRETRO_COMMON/string/stdstring.c" \
    "$LIBRETRO_COMMON/vfs/vfs_implementation.c"; do
    if [ -f "$src" ]; then
      obj="${src%.c}.o"
      emcc -c -O2 $INCLUDE_FLAGS -D__LIBRETRO__ -o "$obj" "$src" 2>/dev/null || true
      [ -f "$obj" ] && COMMON_OBJS="$COMMON_OBJS $obj"
    fi
  done
  [ -n "$COMMON_OBJS" ] && emar rcs "$CORE_LIB" $COMMON_OBJS
fi

EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_romdev_watchpoint_set","_romdev_watchpoint_set_cond","_romdev_watchpoint_get","_romdev_pcbreak_set","_romdev_pcbreak_get","_romdev_watchdog_set","_romdev_regsnap_get","_romdev_irqblock_set","_romdev_readwatch_set","_romdev_readwatch_get","_romdev_setreg","_romdev_getreg","_romdev_range_set","_romdev_range_get","_romdev_cov_set","_romdev_cov_get","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS"]'

mkdir -p "$OUT"
emcc "$CORE_LIB" \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=create_handy \
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
  -o "$OUT/handy_libretro.js"

echo "handy_libretro staged at $OUT"
ls -lh "$OUT/handy_libretro."{js,wasm}

# Also stage into the carved-out binary package the registry actually resolves
# at runtime (src/cores/registry.js → romdev-core-handy). Without this the dev
# tree keeps loading the OLD package copy and a rebuild appears to "do nothing".
PKG_OUT="$PROJECT_DIR/../romdev-core-handy/wasm"
if [ -d "$PKG_OUT" ]; then
  cp "$OUT/handy_libretro.js"   "$PKG_OUT/handy_libretro.js"
  cp "$OUT/handy_libretro.wasm" "$PKG_OUT/handy_libretro.wasm"
  echo "also staged into romdev-core-handy package: $PKG_OUT"
fi
