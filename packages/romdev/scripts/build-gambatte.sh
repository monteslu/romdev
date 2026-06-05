#!/usr/bin/env bash
# Build gambatte libretro core → WASM, with romdev's custom memory
# region patch applied (exposes GB/GBC VRAM/OAM/IO/HRAM + GBC palette
# RAM + SM83 CPU snapshot via retro_get_memory_data for the
# inspectSprites/inspectPalette/getCPUState/getRenderingContext tools).
#
# Output: src/cores/wasm/gambatte_libretro.{js,wasm}.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git
require_cmd make

# Upstream pin lives in scripts/versions.json (cores.gambatte).
GAMBATTE_DIR="$BUILD_DIR/gambatte/src"
PATCH_FILE="$PROJECT_DIR/$(pin_get cores.gambatte patch)"
OUT="$PROJECT_DIR/src/cores/wasm"

fetch_pinned cores.gambatte "$GAMBATTE_DIR"

cd "$GAMBATTE_DIR"
# Reset the files the patch touches so re-runs are idempotent.
git checkout -- \
  libgambatte/src/cpu.h \
  libgambatte/src/cpu.cpp \
  libgambatte/src/gambatte-memory.h \
  libgambatte/src/video.h \
  libgambatte/include/gambatte.h \
  libgambatte/src/gambatte.cpp \
  libgambatte/libretro/libretro.cpp 2>/dev/null || true

# --recount lets the patch survive small additions to hunks (e.g. adding
# a new ROMDEV_MEMORY_* region) without manually re-computing the @@ counts.
if ! git apply --recount --check "$PATCH_FILE" 2>/dev/null; then
  if grep -q "ROMDEV_MEMORY_GB_VRAM" libgambatte/libretro/libretro.cpp; then
    echo "Patch already present (sentinel ROMDEV_MEMORY_GB_VRAM found); skipping apply."
  else
    echo "FATAL: patch failed to apply and sentinel not present." >&2
    exit 1
  fi
else
  git apply --recount "$PATCH_FILE"
  echo "Applied $PATCH_FILE"
fi

emmake make -f Makefile.libretro platform=emscripten clean >/dev/null 2>&1 || true
# `make clean` doesn't remove the .a we create by renaming the .bc, so a stale
# archive from a prior build can survive and shadow the fresh one (find -quit
# picks .a before .bc). Drop stale archives so only this build's output remains.
find . -maxdepth 2 -name "*_libretro_emscripten.a" -delete 2>/dev/null || true
emmake make -f Makefile.libretro platform=emscripten -j"$(nproc)"

CORE_LIB=$(find . -maxdepth 2 \( -name "*.a" -o -name "*_libretro_emscripten.bc" \) -print -quit)
if [ -z "$CORE_LIB" ]; then
  echo "FATAL: gambatte build did not produce a .a or .bc archive." >&2
  exit 1
fi
if [[ "$CORE_LIB" == *.bc ]] && head -c 7 "$CORE_LIB" | grep -q '!<arch>'; then
  mv "$CORE_LIB" "${CORE_LIB%.bc}.a"
  CORE_LIB="${CORE_LIB%.bc}.a"
fi

# gambatte's archive references libretro-common helpers (filestream,
# string_trim, etc) but doesn't bundle their .o files. Compile the
# subset we need and add to the archive — same pattern as fceumm.
LIBRETRO_COMMON=""
for dir in "libretro-common" "src/libretro-common" "libgambatte/libretro-common" "libgambatte/libretro/libretro-common"; do
  if [ -d "$GAMBATTE_DIR/$dir" ]; then LIBRETRO_COMMON="$GAMBATTE_DIR/$dir"; break; fi
done
if [ -z "$LIBRETRO_COMMON" ]; then
  LIBRETRO_COMMON=$(find "$GAMBATTE_DIR" -maxdepth 4 -type d -name "libretro-common" -print -quit)
fi
if [ -n "$LIBRETRO_COMMON" ]; then
  echo "Adding libretro-common sources from $LIBRETRO_COMMON"
  INCLUDE_FLAGS="-I$LIBRETRO_COMMON/include"
  COMMON_OBJS=""
  for src in \
    "$LIBRETRO_COMMON/encodings/encoding_utf.c" \
    "$LIBRETRO_COMMON/compat/compat_strl.c" \
    "$LIBRETRO_COMMON/compat/compat_posix_string.c" \
    "$LIBRETRO_COMMON/compat/compat_snprintf.c" \
    "$LIBRETRO_COMMON/compat/fopen_utf8.c" \
    "$LIBRETRO_COMMON/file/file_path.c" \
    "$LIBRETRO_COMMON/file/file_path_io.c" \
    "$LIBRETRO_COMMON/streams/file_stream.c" \
    "$LIBRETRO_COMMON/streams/file_stream_transforms.c" \
    "$LIBRETRO_COMMON/streams/memory_stream.c" \
    "$LIBRETRO_COMMON/streams/interface_stream.c" \
    "$LIBRETRO_COMMON/string/stdstring.c" \
    "$LIBRETRO_COMMON/time/rtime.c" \
    "$LIBRETRO_COMMON/lists/string_list.c" \
    "$LIBRETRO_COMMON/lists/dir_list.c" \
    "$LIBRETRO_COMMON/file/retro_dirent.c" \
    "$LIBRETRO_COMMON/vfs/vfs_implementation.c"; do
    if [ -f "$src" ]; then
      obj="${src%.c}.o"
      emcc -c -O2 $INCLUDE_FLAGS -D__LIBRETRO__ -o "$obj" "$src" 2>/dev/null || true
      [ -f "$obj" ] && COMMON_OBJS="$COMMON_OBJS $obj"
    fi
  done
  if [ -n "$COMMON_OBJS" ]; then
    emar rcs "$CORE_LIB" $COMMON_OBJS
  fi
fi

EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_romdev_watchpoint_set","_romdev_watchpoint_get","_romdev_readwatch_set","_romdev_readwatch_get","_romdev_pcbreak_set","_romdev_pcbreak_get","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS"]'

mkdir -p "$OUT"
emcc "$CORE_LIB" \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=create_gambatte \
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
  -o "$OUT/gambatte_libretro.js"

echo "gambatte_libretro staged at $OUT"
ls -lh "$OUT/gambatte_libretro."{js,wasm}

# Also stage into the carved-out binary package the registry actually resolves
# at runtime (src/cores/registry.js → romdev-core-gambatte). Without this the
# dev tree keeps loading the OLD package copy and a rebuild appears to "do
# nothing".
PKG_OUT="$PROJECT_DIR/../romdev-core-gambatte/wasm"
if [ -d "$PKG_OUT" ]; then
  cp "$OUT/gambatte_libretro.js"   "$PKG_OUT/gambatte_libretro.js"
  cp "$OUT/gambatte_libretro.wasm" "$PKG_OUT/gambatte_libretro.wasm"
  echo "also staged into romdev-core-gambatte package: $PKG_OUT"
fi
