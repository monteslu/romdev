#!/usr/bin/env bash
# Build VICE x64 (Commodore 64) → WASM.
#
# More involved than the other cores: VICE has its own Makefile (not
# Makefile.libretro) and the libretro archive ships without libretro-common
# or 7zip objects, so we have to compile and add them to the archive
# before linking.

set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd emar
require_cmd git

# Upstream pin lives in scripts/versions.json (cores.vice_x64).
VICE_DIR="$BUILD_DIR/vice_x64/src"
OUT="$PROJECT_DIR/src/cores/wasm"

fetch_pinned cores.vice_x64 "$VICE_DIR"

cd "$VICE_DIR"

# Apply romdev memory-region patch. vice-libretro ships some files
# with CRLF line endings, so normalize first; --recount lets the hunk line
# numbers float a bit.
PATCH_FILE="$PROJECT_DIR/scripts/patches/vice-romdev-memory-regions.patch"
if [ -f "$PATCH_FILE" ]; then
  # Normalize CRLF → LF on the file(s) we patch.
  sed -i 's/\r$//' libretro/libretro-core.c vice/src/maincpu.c vice/src/6510core.c || true
  if grep -q 'ROMDEV_MEMORY_C64' libretro/libretro-core.c; then
    echo "romdev patch already applied — skipping."
  else
    echo "Applying romdev memory-region patch..."
    git apply --recount "$PATCH_FILE"
  fi
fi

echo "Building VICE x64 archive..."
emmake make platform=emscripten EMUTYPE=x64 clean 2>/dev/null || true
find . -maxdepth 3 -name "*_libretro*.a" -delete 2>/dev/null || true
emmake make platform=emscripten EMUTYPE=x64 -j"$(nproc)"

CORE_LIB=$(find . -maxdepth 2 \( -name "vice_x64*.a" -o -name "vice_x64*_libretro_emscripten.bc" \) | head -1)
if [ -z "$CORE_LIB" ]; then
  echo "Error: VICE archive not found after make" >&2
  exit 1
fi
if [[ "$CORE_LIB" == *.bc ]]; then
  mv "$CORE_LIB" "${CORE_LIB%.bc}.a"
  CORE_LIB="${CORE_LIB%.bc}.a"
fi

echo "Compiling libretro-common objects..."
for src in \
  libretro-common/string/stdstring.c \
  libretro-common/streams/file_stream.c \
  libretro-common/streams/file_stream_transforms.c \
  libretro-common/streams/memory_stream.c \
  libretro-common/streams/interface_stream.c \
  libretro-common/compat/compat_strl.c \
  libretro-common/compat/compat_strcasestr.c \
  libretro-common/compat/compat_posix_string.c \
  libretro-common/compat/compat_snprintf.c \
  libretro-common/compat/fopen_utf8.c \
  libretro-common/encodings/encoding_utf.c \
  libretro-common/file/file_path.c \
  libretro-common/file/file_path_io.c \
  libretro-common/file/retro_dirent.c \
  libretro-common/vfs/vfs_implementation.c \
  libretro-common/time/rtime.c \
  libretro-common/lists/string_list.c \
  libretro-common/lists/dir_list.c
do
  [ -f "$src" ] || continue
  obj="${src%.c}.o"
  emcc -c -O2 -I libretro-common/include -D__LIBRETRO__ -o "$obj" "$src"
done

echo "Compiling 7zip (LZMA SDK) objects..."
for src in deps/7zip/*.c; do
  [ -f "$src" ] || continue
  obj="${src%.c}.o"
  emcc -c -O2 -I deps/7zip -D_7ZIP_ST -o "$obj" "$src"
done

echo "Augmenting VICE archive with libretro-common + 7zip..."
emar rcs "$CORE_LIB" \
  libretro-common/string/*.o \
  libretro-common/streams/*.o \
  libretro-common/compat/*.o \
  libretro-common/encodings/*.o \
  libretro-common/file/*.o \
  libretro-common/vfs/*.o \
  libretro-common/time/*.o \
  libretro-common/lists/*.o \
  deps/7zip/*.o

echo "Linking final VICE WASM module..."
emcc "$CORE_LIB" \
  -O3 \
  -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 \
  -s 'EXPORT_NAME=create_vice_x64' \
  -s ENVIRONMENT=node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=67108864 -s MAXIMUM_MEMORY=536870912 \
  -s ALLOW_TABLE_GROWTH=1 \
  -s 'EXPORTED_FUNCTIONS=["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_romdev_watchpoint_set","_romdev_watchpoint_get","_romdev_pcbreak_set","_romdev_pcbreak_get","_romdev_watchdog_set","_romdev_readwatch_set","_romdev_readwatch_get","_romdev_setreg","_romdev_getreg","_romdev_range_set","_romdev_range_get","_romdev_cov_set","_romdev_cov_get","_romdev_disk_export","_romdev_disk_ptr","_romdev_disk_import","_romdev_disk_putfile","_romdev_key_matrix","_romdev_kbdbuf_feed","_romdev_joyport_get","_romdev_joyport_set","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]' \
  -s 'EXPORTED_RUNTIME_METHODS=["FS","ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue"]' \
  -s FORCE_FILESYSTEM=1 \
  -s INVOKE_RUN=0 \
  -s USE_ZLIB=1 \
  -o vice_x64_libretro.js

mkdir -p "$OUT"
cp vice_x64_libretro.js vice_x64_libretro.wasm "$OUT/"

echo "VICE x64 staged at $OUT"

# Also stage into the carved-out binary package the registry actually resolves
# at runtime (src/cores/registry.js → romdev-core-vice). Without this the dev
# tree keeps loading the OLD package copy and a rebuild appears to "do nothing".
PKG_OUT="$PROJECT_DIR/../romdev-core-vice/wasm"
if [ -d "$PKG_OUT" ]; then
  cp "$OUT/vice_x64_libretro.js"   "$PKG_OUT/vice_x64_libretro.js"
  cp "$OUT/vice_x64_libretro.wasm" "$PKG_OUT/vice_x64_libretro.wasm"
  echo "also staged into romdev-core-vice package: $PKG_OUT"
fi
