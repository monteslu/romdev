#!/usr/bin/env bash
# Build prosystem (Atari 7800) libretro core → WASM, with romdev's
# custom memory region patch applied (exposes 6502 CPU snapshot via
# retro_get_memory_data for the getCPUState tool — MARIA/TIA/ROM are
# already reachable via system_ram, which returns the full 64KB 6502
# address-space buffer).
#
# Output: src/cores/wasm/prosystem_libretro.{js,wasm}.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git
require_cmd make

# Upstream pin lives in scripts/versions.json (cores.prosystem).
DIR="$BUILD_DIR/prosystem/src"
PATCH_FILE="$PROJECT_DIR/$(pin_get cores.prosystem patch)"
OUT="$PROJECT_DIR/src/cores/wasm"

fetch_pinned cores.prosystem "$DIR"

cd "$DIR"
git checkout -- core/libretro.c core/Memory.c core/Sally.c core/ProSystem.c 2>/dev/null || true
if ! git apply --recount --check "$PATCH_FILE" 2>/dev/null; then
  if grep -q "ROMDEV_MEMORY_A78_CPU_REGS" core/libretro.c; then
    echo "Patch already present; skipping apply."
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
  echo "FATAL: prosystem build did not produce a .a or .bc archive." >&2
  exit 1
fi
if [[ "$CORE_LIB" == *.bc ]] && head -c 7 "$CORE_LIB" | grep -q '!<arch>'; then
  mv "$CORE_LIB" "${CORE_LIB%.bc}.a"
  CORE_LIB="${CORE_LIB%.bc}.a"
fi

# libretro-common helpers (file streams, string utils).
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
  [ -n "$COMMON_OBJS" ] && emar rcs "$CORE_LIB" $COMMON_OBJS
fi

EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_romdev_watchpoint_set","_romdev_watchpoint_get","_romdev_readwatch_set","_romdev_readwatch_get","_romdev_pcbreak_set","_romdev_pcbreak_get","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS"]'

mkdir -p "$OUT"
emcc "$CORE_LIB" \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=create_prosystem \
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
  -o "$OUT/prosystem_libretro.js"

echo "prosystem_libretro staged at $OUT"
ls -lh "$OUT/prosystem_libretro."{js,wasm}

# Also stage into the carved-out binary package the registry actually resolves
# at runtime (src/cores/registry.js → romdev-core-prosystem). Without this the
# dev tree keeps loading the OLD package copy and a rebuild appears to "do nothing".
PKG_OUT="$PROJECT_DIR/../romdev-core-prosystem/wasm"
if [ -d "$PKG_OUT" ]; then
  cp "$OUT/prosystem_libretro.js"   "$PKG_OUT/prosystem_libretro.js"
  cp "$OUT/prosystem_libretro.wasm" "$PKG_OUT/prosystem_libretro.wasm"
  echo "also staged into romdev-core-prosystem package: $PKG_OUT"
fi
