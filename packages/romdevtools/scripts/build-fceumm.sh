#!/usr/bin/env bash
# Build fceumm libretro core → WASM, with romdev's custom memory
# region patch applied (exposes NES OAM/PALETTE/NAMETABLES/CHR via
# retro_get_memory_data for the inspectSprites/inspectPalette tools).
#
# Output: src/cores/wasm/fceumm_libretro.{js,wasm}.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git
require_cmd make

# Upstream pin lives in scripts/versions.json (cores.fceumm).
FCEUMM_DIR="$BUILD_DIR/fceumm/src"
PATCH_FILE="$PROJECT_DIR/$(pin_get cores.fceumm patch)"
OUT="$PROJECT_DIR/src/cores/wasm"

fetch_pinned cores.fceumm "$FCEUMM_DIR"

cd "$FCEUMM_DIR"
# Reset the files the patch touches — libretro.c (memory regions + watchpoint
# exports), sound.c (drop `static` on the APU register holders), and x6502.c
# (the write-watchpoint hook + state) — so a clean re-apply always works.
git checkout -- src/drivers/libretro/libretro.c src/sound.c src/x6502.c src/ppu.c 2>/dev/null || true
# Use --recount so the patch survives small additions to hunks (e.g. adding
# a new ROMDEV_MEMORY_* region) without manually re-computing the @@ counts.
if ! git apply --recount --check "$PATCH_FILE" 2>/dev/null; then
  if grep -q "ROMDEV_MEMORY_NES_APU_REGS" src/drivers/libretro/libretro.c; then
    echo "Patch already present (sentinel ROMDEV_MEMORY_NES_APU_REGS found); skipping."
  else
    echo "FATAL: patch failed to apply and sentinel not present." >&2
    exit 1
  fi
else
  git apply --recount "$PATCH_FILE"
  echo "Applied $PATCH_FILE"
fi

# fceumm's Makefile.libretro is at the repo root.
cd "$FCEUMM_DIR"

# ── romdev shared debug lib (0.80.0) ────────────────────────────────────────
# Stage romdev_debug.{h,c} into the tree so x6502.c/libretro.c's #include resolves,
# inject the include via INCFLAGS_PLATFORM (the Makefile's append-safe hook — a bare
# CFLAGS= clobbers fceumm's own -I dirs), and compile+archive the .c into the link.
RDBG_SRC="$PROJECT_DIR/scripts/romdev-debug"
cp "$RDBG_SRC/romdev_debug.h" "$RDBG_SRC/romdev_debug.c" "$FCEUMM_DIR/src/"
ROMDEV_INC="-I$FCEUMM_DIR/src"

# fceumm's `make clean` doesn't remove the libretro_*.a / .bc archive at
# the repo root, so a stale archive can survive even after a fresh .o is
# compiled. Force-remove the archive AND the libretro.o before rebuild
# so we always get a fresh link.
emmake make -f Makefile.libretro platform=emscripten clean >/dev/null 2>&1 || true
rm -f fceumm_libretro_emscripten.a fceumm_libretro_emscripten.bc \
      src/drivers/libretro/libretro.o
emmake make -f Makefile.libretro platform=emscripten -j"$(nproc)" \
  INCFLAGS_PLATFORM="$ROMDEV_INC"

CORE_LIB=$(find . -maxdepth 1 \( -name "*.a" -o -name "*_libretro*.bc" \) -print -quit)
if [ -z "$CORE_LIB" ]; then
  echo "FATAL: fceumm emscripten build did not produce a .a or .bc archive." >&2
  exit 1
fi
if [[ "$CORE_LIB" == *.bc ]] && head -c 7 "$CORE_LIB" | grep -q '!<arch>'; then
  mv "$CORE_LIB" "${CORE_LIB%.bc}.a"
  CORE_LIB="${CORE_LIB%.bc}.a"
fi

# fceumm archive references libretro-common's vfs / strlcpy / pathname
# helpers (used by palette.c, file.c, etc.) but doesn't bundle their
# .o files. Compile the subset we need and add to the archive — same
# pattern used in build-genesis-plus-gx.sh.
LIBRETRO_COMMON=""
for dir in "libretro-common" "src/libretro-common" "src/drivers/libretro/libretro-common"; do
  if [ -d "$FCEUMM_DIR/$dir" ]; then LIBRETRO_COMMON="$FCEUMM_DIR/$dir"; break; fi
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

# Compile the shared romdev_debug.c + add it to the archive so its exports link in.
RDBG_OBJ="$FCEUMM_DIR/src/romdev_debug.o"
emcc -c -O2 "$FCEUMM_DIR/src/romdev_debug.c" -o "$RDBG_OBJ"
emar rcs "$CORE_LIB" "$RDBG_OBJ"

EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_romdev_watchpoint_set","_romdev_watchpoint_set_cond","_romdev_watchpoint_get","_romdev_readwatch_set","_romdev_readwatch_get","_romdev_pcbreak_set","_romdev_pcbreak_get","_romdev_watchdog_set","_romdev_regsnap_get","_romdev_irqblock_set","_romdev_vramwatch_set","_romdev_vramwatch_get","_romdev_setreg","_romdev_getreg","_romdev_range_set","_romdev_range_get","_romdev_cov_set","_romdev_cov_get","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS"]'

mkdir -p "$OUT"
emcc "$CORE_LIB" \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=create_fceumm \
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
  -o "$OUT/fceumm_libretro.js"

echo "fceumm_libretro staged at $OUT"
ls -lh "$OUT/fceumm_libretro."{js,wasm}

# Also stage into the carved-out binary package the registry actually resolves
# at runtime (src/cores/registry.js → romdev-core-fceumm). Without this the dev
# tree keeps loading the OLD package copy and a rebuild appears to "do nothing".
PKG_OUT="$PROJECT_DIR/../romdev-core-fceumm/wasm"
if [ -d "$PKG_OUT" ]; then
  cp "$OUT/fceumm_libretro.js"   "$PKG_OUT/fceumm_libretro.js"
  cp "$OUT/fceumm_libretro.wasm" "$PKG_OUT/fceumm_libretro.wasm"
  echo "also staged into romdev-core-fceumm package: $PKG_OUT"
fi
