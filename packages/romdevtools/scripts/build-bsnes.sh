#!/usr/bin/env bash
# Build the bsnes libretro core -> WASM, as romdev's accuracy reference for the
# SNES coprocessors that run firmware: the ST010/ST011 (NEC uPD96050) and the
# ST018 (ARM), which snes9x only approximates (an HLE that stops after a few
# commands; a stub). bsnes runs their firmware (st011.rom / st018.rom, from the
# system directory or appended to the ROM).
#
# Output: src/cores/wasm/bsnes_libretro.{js,wasm}, also staged into
# ../romdev-core-bsnes/wasm/ (the package the registry resolves).
#
# Built with romdev's Python-free emscripten driver (scripts/wasm-emcc), never
# emsdk's emcc. bsnes runs every chip as a libco cothread; libco has no
# WebAssembly backend, so the patch adds one (scripts/patches/libco-wasm/
# libco-wasm.c, built as libco/wasm.c) that switches with binaryen's Asyncify
# inside the module, and wraps the libretro entry points in its trampoline
# (scripts/patches/bsnes/romdev_bsnes.cpp, which also serves the memory
# regions). wasm-emcc runs the Asyncify pass when the linked module imports
# the "asyncify" intrinsics.
#
# Licence: bsnes is GPL-3.0 (libco and nall ISC). The built core is GPL-3.0.
# No bsnes code is compiled into anything else: the snes9x core and
# recompiled carts run ares's chips (ISC; scripts/recompile-gen/ares-chips.mjs).
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd git
require_cmd make
require_cmd node

export PATH="$SCRIPT_DIR/wasm-emcc/bin:$PATH"
if [ "$(command -v emcc)" != "$SCRIPT_DIR/wasm-emcc/bin/emcc" ]; then
  echo "FATAL: emcc must be romdev's wasm-emcc ($SCRIPT_DIR/wasm-emcc/bin/emcc)." >&2
  exit 1
fi
if [ ! -d "$BUILD_DIR/wasm-toolchain/node_modules/@yowasp/clang" ]; then
  echo "FATAL: the wasm toolchain is missing; run: node scripts/wasm-emcc/fetch-wasm-toolchain.mjs" >&2
  exit 1
fi

SRC="$BUILD_DIR/bsnes/src"
PATCH_FILE="$PROJECT_DIR/$(pin_get cores.bsnes patch)"
OUT="$PROJECT_DIR/src/cores/wasm"
JOBS="${JOBS:-8}"

fetch_pinned cores.bsnes "$SRC"

cd "$SRC"
require_git_toplevel
# Two patches: romdev's hooks, then the firmware romdev does not ship taken
# from the system directory (bsnes-romdev-firmware.patch). Re-apply them only
# when the tree does not already carry exactly them (a reset touches every
# patched file, and ppu.hpp is in every object).
FW_PATCH="$PROJECT_DIR/scripts/patches/bsnes-romdev-firmware.patch"
if patch_already_applied "$PATCH_FILE" && patch_already_applied "$FW_PATCH"; then
  echo "Patches already present (reverse-apply cleanly); keeping the tree."
else
  git checkout -- . 2>/dev/null || true
  git apply --recount "$PATCH_FILE"
  git apply --recount "$FW_PATCH"
  echo "Applied $PATCH_FILE and $FW_PATCH"
fi
# The firmware and chip data bsnes embeds (the DSP-1 and ST010 data ROM
# tables, the Cx4 data ROM, the Super Game Boy boot ROMs) are emptied; the
# patch takes the user's files from the system directory instead.
node "$PROJECT_DIR/scripts/patches/bsnes/strip-firmware.mjs" "$SRC"
# romdev's own files, copied in only when changed; the upstream Makefile has
# no header dependencies, so the source that includes a changed file is
# touched to make it rebuild.
put() { cmp -s "$1" "$2" || { cp "$1" "$2"; touch "$3"; }; }
put "$PROJECT_DIR/scripts/patches/libco-wasm/libco-wasm.c" "$SRC/libco/wasm.c" "$SRC/libco/libco.c"
put "$PROJECT_DIR/scripts/patches/bsnes/romdev_bsnes.cpp" "$SRC/bsnes/target-libretro/romdev_bsnes.cpp" "$SRC/bsnes/target-libretro/libretro.cpp"
put "$PROJECT_DIR/scripts/patches/bsnes/romdev_bsnes_sfc.cpp" "$SRC/bsnes/sfc/interface/romdev_bsnes_sfc.cpp" "$SRC/bsnes/sfc/interface/interface.cpp"
put "$PROJECT_DIR/scripts/patches/bsnes/romdev_bsnes_chipstate.h" "$SRC/bsnes/sfc/interface/romdev_bsnes_chipstate.h" "$SRC/bsnes/sfc/interface/interface.cpp"
# romdev's own SPC700 boot ROM (scripts/spc700-ipl/ipl.asm, MIT, a clean-room
# reimplementation of the upload protocol) replaces the one bsnes embeds for
# ipl.rom (target-libretro/resources.hpp, included by program.cpp).
RES="$SRC/bsnes/target-libretro/resources.hpp"
RES_SUM="$(sha256sum "$RES")"
node "$SCRIPT_DIR/spc700-ipl/install-ipl.mjs" "$RES"
[ "$(sha256sum "$RES")" = "$RES_SUM" ] || touch "$SRC/bsnes/target-libretro/program.cpp"

# The upstream Makefile tracks no header dependencies: when the patch or any
# of romdev's files changed since the last build, every object is rebuilt.
STAMP="$(cat "$PATCH_FILE" "$FW_PATCH" "$PROJECT_DIR"/scripts/patches/bsnes/* "$PROJECT_DIR/scripts/patches/libco-wasm/libco-wasm.c" "$PROJECT_DIR/scripts/spc700-ipl/romdev_iplrom.h" | sha256sum | cut -d' ' -f1)"
if [ "$(cat .romdev-build-stamp 2>/dev/null)" != "$STAMP" ]; then
  find . -name '*.o' -delete
  echo "$STAMP" > .romdev-build-stamp
fi

# The upstream Makefile's emscripten platform links everything into a .bc; only
# its objects are wanted here (same flags), then the link below.
cat > "$SRC/romdev-objects.mk" <<'EOF'
romdev-objects: $(OBJECTS)
	@printf '%s\n' $(OBJECTS) > romdev-objects.txt
EOF
emmake make -f Makefile -f romdev-objects.mk platform=emscripten -j"$JOBS" romdev-objects

EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS"]'

mkdir -p "$OUT"
# shellcheck disable=SC2046
em++ $(cat romdev-objects.txt) \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=create_bsnes \
  -s ENVIRONMENT=node,web,worker \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=134217728 \
  -s MAXIMUM_MEMORY=1073741824 \
  -s STACK_SIZE=1048576 \
  -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  -s FILESYSTEM=1 \
  -s INVOKE_RUN=0 \
  -o "$OUT/bsnes_libretro.js"

echo "bsnes_libretro staged at $OUT"
ls -lh "$OUT/bsnes_libretro."{js,wasm}

PKG_OUT="$PROJECT_DIR/../romdev-core-bsnes/wasm"
mkdir -p "$PKG_OUT"
cp "$OUT/bsnes_libretro.js" "$OUT/bsnes_libretro.wasm" "$PKG_OUT/"
echo "also staged into romdev-core-bsnes: $PKG_OUT"
