#!/usr/bin/env bash
# Build genesis-plus-gx libretro core → WASM, with romdev's custom
# memory region patch applied. Exposes Genesis VDP CRAM/VSRAM/VDP regs,
# Z80 RAM, M68K CPU struct, YM2612 + PSG snapshot blobs via
# retro_get_memory_data — feeds inspectSprites/inspectPalette/
# getCPUState/getYm2612State/getPsgState on the JS side.
#
# Output: src/cores/wasm/genesis_plus_gx_libretro.{js,wasm}.
# Mirrors scripts/build-snes9x.sh structure.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git
require_cmd make

# Upstream pin lives in scripts/versions.json (cores.genesis_plus_gx).
GPGX_DIR="$BUILD_DIR/gpgx/src"
PATCH_FILE="$PROJECT_DIR/$(pin_get cores.genesis_plus_gx patch)"
OUT="$PROJECT_DIR/src/cores/wasm"

fetch_pinned cores.genesis_plus_gx "$GPGX_DIR"

cd "$GPGX_DIR"
git checkout -- libretro/libretro.c core/m68k/m68kcpu.c core/m68k/m68kcpu.h core/z80/z80.c core/vdp_ctrl.c 2>/dev/null || true
# --recount lets the patch survive small additions (new ROMDEV_MEMORY_*
# region IDs etc) without re-numbering hunk headers by hand.
if ! git apply --recount --check "$PATCH_FILE" 2>/dev/null; then
  if grep -q "ROMDEV_MEMORY_GENESIS_CRAM" libretro/libretro.c; then
    echo "Patch already present (sentinel ROMDEV_MEMORY_GENESIS_CRAM found); skipping apply."
  else
    echo "FATAL: patch failed to apply and sentinel not present." >&2
    exit 1
  fi
else
  git apply --recount "$PATCH_FILE"
  echo "Applied $PATCH_FILE"
fi

emmake make -f Makefile.libretro platform=emscripten clean >/dev/null 2>&1 || true
# Drop a stale .a (created by renaming the .bc; make clean doesn't remove it)
# so find -quit can't pick it over this build's fresh output.
find . -maxdepth 2 -name "*_libretro*.a" -delete 2>/dev/null || true
emmake make -f Makefile.libretro platform=emscripten -j"$(nproc)"

CORE_LIB=$(find . -maxdepth 2 \( -name "*.a" -o -name "*_libretro*.bc" \) -print -quit)
if [ -z "$CORE_LIB" ]; then
  echo "FATAL: gpgx build did not produce a .a or .bc archive." >&2
  exit 1
fi
if [[ "$CORE_LIB" == *.bc ]] && head -c 7 "$CORE_LIB" | grep -q '!<arch>'; then
  mv "$CORE_LIB" "${CORE_LIB%.bc}.a"
  CORE_LIB="${CORE_LIB%.bc}.a"
fi

# gpgx archive doesn't bundle libretro-common; compile the subset it
# references (vfs wrappers used by libchdr/yx5200) and add to the .a.
# Same approach as scripts/build-atari800.sh.
LIBRETRO_COMMON=""
for dir in "libretro-common" "libretro/libretro-common"; do
  if [ -d "$dir" ]; then LIBRETRO_COMMON="$(pwd)/$dir"; break; fi
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
  if [ -n "$COMMON_OBJS" ]; then
    emar rcs "$CORE_LIB" $COMMON_OBJS
  fi
fi

EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_romdev_watchpoint_set","_romdev_watchpoint_get","_romdev_readwatch_set","_romdev_readwatch_get","_romdev_pcbreak_set","_romdev_pcbreak_get","_romdev_watchdog_set","_romdev_setreg","_romdev_getreg","_romdev_range_set","_romdev_range_get","_romdev_cov_set","_romdev_cov_get","_romdev_dmawatch_set","_romdev_dmawatch_get","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS"]'

mkdir -p "$OUT"
emcc "$CORE_LIB" \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=create_genesis_plus_gx \
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
  -o "$OUT/genesis_plus_gx_libretro.js"

echo "genesis_plus_gx_libretro (with romdev memory regions) staged at $OUT"
ls -lh "$OUT/genesis_plus_gx_libretro."{js,wasm}

# Also stage into the carved-out binary package the registry actually resolves
# at runtime (src/cores/registry.js → romdev-core-gpgx). Without this the dev
# tree keeps loading the OLD package copy and a rebuild appears to "do nothing".
PKG_OUT="$PROJECT_DIR/../romdev-core-gpgx/wasm"
if [ -d "$PKG_OUT" ]; then
  cp "$OUT/genesis_plus_gx_libretro.js"   "$PKG_OUT/genesis_plus_gx_libretro.js"
  cp "$OUT/genesis_plus_gx_libretro.wasm" "$PKG_OUT/genesis_plus_gx_libretro.wasm"
  echo "also staged into romdev-core-gpgx package: $PKG_OUT"
fi
