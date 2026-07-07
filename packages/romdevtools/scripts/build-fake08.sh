#!/usr/bin/env bash
# Build the FAKE-08 libretro core → WASM (retroemu ES6 factory). FAKE-08 is an
# open-source (MIT) PICO-8 *player* by jtothebell — a clean-room reimplementation,
# NOT Lexaloffle's PICO-8, and it needs NO BIOS. It runs .p8 (Lua source carts) and
# .p8.png (carts embedded in a label PNG). PICO-8 is a Lua VM (128×128, 16-color,
# 6 buttons) — no real CPU — so this core ships run/see/drive only; NO romdev_debug
# hooks (nothing to watchpoint), and the .p8 Lua source IS the "disassembly".
#
# Output: src/cores/wasm/fake08_libretro.{js,wasm} + the romdev-core-fake08 package.
#
# THE ONE GOTCHA (see internal-romdev/FAKE08_FEASIBILITY.md): z8lua uses
# setjmp/longjmp for Lua error handling. Without Emscripten longjmp support the core
# aborts inside loadMedia throwing a raw WASM pointer number. Fix = build every object
# with EMCC_CFLAGS="-sSUPPORT_LONGJMP=emscripten -fexceptions" (via the env var so it
# APPENDS and never clobbers the Makefile's -I includes) and link the same. The
# Makefile's own emscripten link uses --no-undefined/--version-script (invalid for
# wasm-ld), so we ignore it: archive the .o's ourselves + do our own emcc ES6 link.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git
require_cmd make

# Upstream pin lives in scripts/versions.json (cores.fake08), incl. the z8lua submodule.
FAKE08_DIR="$BUILD_DIR/fake08"
OUT="$PROJECT_DIR/src/cores/wasm"

fetch_pinned cores.fake08 "$FAKE08_DIR"

# ── pin the submodules (z8lua etc.) — fetch_pinned() doesn't recurse ──
# Read each submodule path→commit from versions.json and check it out exactly.
cd "$FAKE08_DIR"
git submodule update --init --recursive --depth 1 2>/dev/null || git submodule update --init --recursive
while read -r subpath subcommit; do
  [ -z "$subpath" ] && continue
  if [ -n "$subcommit" ] && [ "$subcommit" != "null" ]; then
    git -C "$subpath" fetch -q --depth 1 origin "$subcommit" 2>/dev/null \
      && git -C "$subpath" checkout -q "$subcommit" \
      && echo "  submodule $subpath @ $subcommit" || true
  fi
done < <(python3 -c "
import json,sys
d=json.load(open('$PROJECT_DIR/scripts/versions.json'))
subs=d['cores']['fake08'].get('submodules',{})
for k,v in subs.items(): print(k, v)
")

# ── apply romdev's memory-region patch (exposes PICO-8's 64KB RAM as SYSTEM_RAM) ──
PATCH_FILE="$PROJECT_DIR/scripts/patches/fake08-romdev-memory-regions.patch"
cd "$FAKE08_DIR"
git checkout -- platform/libretro/libretro.cpp 2>/dev/null || true
if git apply --check "$PATCH_FILE" 2>/dev/null; then
  git apply "$PATCH_FILE"
  echo "romdev: applied $PATCH_FILE"
elif grep -q "RETRO_MEMORY_SYSTEM_RAM && _memory" platform/libretro/libretro.cpp; then
  echo "romdev: memory patch already present; skipping."
else
  echo "FATAL: fake08 memory patch failed to apply and sentinel not present." >&2
  exit 1
fi

# ── apply romdev's input-resume fix (the first button press after a cart load was
# eaten by the _clearInputOnResume guard, so btnp never fired → games never left
# their title screen). See scripts/patches/fake08-romdev-input-resume-fix.patch. ──
INPUT_PATCH="$PROJECT_DIR/scripts/patches/fake08-romdev-input-resume-fix.patch"
git checkout -- source/vm.cpp 2>/dev/null || true
if git apply --check "$INPUT_PATCH" 2>/dev/null; then
  git apply "$INPUT_PATCH"
  echo "romdev: applied $INPUT_PATCH"
elif grep -q "fall through — deliver real input this frame" source/vm.cpp; then
  echo "romdev: input-resume fix already present; skipping."
else
  echo "FATAL: fake08 input-resume patch failed to apply and sentinel not present." >&2
  exit 1
fi

cd "$FAKE08_DIR/platform/libretro"

# ── build the objects with longjmp + exceptions support (the gotcha) ──
# EMCC_CFLAGS is appended by emcc/em++ to EVERY compile → the Makefile's own
# INCFLAGS (-Isource -Ilibs/z8lua …) stay intact (unlike a bare CFLAGS= override).
export EMCC_CFLAGS="-sSUPPORT_LONGJMP=emscripten -fexceptions"
emmake make platform=emscripten clean >/dev/null 2>&1 || true
# The Makefile's final .bc link fails on --no-undefined (wasm-ld rejects it); we only
# need the compiled objects, so let that link error be non-fatal and archive ourselves.
emmake make platform=emscripten -j"$(nproc)" 2>&1 | grep -viE "no-undefined|version-script|returned 1|Error 1|linking a library with|ignoring unsupported" || true
unset EMCC_CFLAGS

# ── archive every compiled object (ignore the Makefile's broken shared link) ──
# Resolve symlinks in the build dir path so `find` matches the real object locations
# (fetch_pinned may hand back a symlinked checkout in some setups).
FAKE08_REAL="$(cd "$FAKE08_DIR" && pwd -P)"
OBJS=$(find "$FAKE08_REAL" -name "*.o" 2>/dev/null)
OBJ_COUNT=$(printf '%s\n' "$OBJS" | grep -c . || true)
if [ "$OBJ_COUNT" -lt 40 ]; then
  echo "FATAL: only $OBJ_COUNT objects compiled (expected ~56). Build failed." >&2
  echo "  (searched: $FAKE08_REAL)" >&2
  exit 1
fi
CORE_LIB="$FAKE08_DIR/platform/libretro/fake08_libretro.a"
rm -f "$CORE_LIB"
# shellcheck disable=SC2086
emar rcs "$CORE_LIB" $OBJS
echo "romdev: archived $OBJ_COUNT objects into fake08_libretro.a"

# ── emcc final link → ES6 factory (create_fake08), longjmp + exceptions on ──
EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS"]'

mkdir -p "$OUT"
emcc "$CORE_LIB" \
  -O2 \
  -fexceptions \
  -sSUPPORT_LONGJMP=emscripten \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=create_fake08 \
  -s ENVIRONMENT=node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=33554432 \
  -s MAXIMUM_MEMORY=268435456 \
  -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  -s FILESYSTEM=1 \
  -s INVOKE_RUN=0 \
  -o "$OUT/fake08_libretro.js"

echo "fake08_libretro staged at $OUT"
ls -lh "$OUT/fake08_libretro."{js,wasm}

# ── also stage into the binary package the registry resolves at runtime ──
PKG_OUT="$PROJECT_DIR/../romdev-core-fake08/wasm"
if [ -d "$PKG_OUT" ]; then
  cp "$OUT/fake08_libretro.js"   "$PKG_OUT/fake08_libretro.js"
  cp "$OUT/fake08_libretro.wasm" "$PKG_OUT/fake08_libretro.wasm"
  echo "also staged into romdev-core-fake08 package: $PKG_OUT"
fi
