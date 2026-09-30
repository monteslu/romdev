#!/usr/bin/env bash
# Build the gcc toolchain N64 SDK (KMC) decomp projects compile with - gcc
# 2.7.2 (driver, cccp, cc1) and its binutils 2.6 assembler - to WASM.
# Ships in packages/romdev-toolchain-decomp-gcc/wasm/kmc-2.7.2/:
#   gcc (the driver), cpp (cccp), cc1, as
# romdev runs `gcc` in its WASM worker; the driver's subprograms run as
# sibling modules through a JS spawn hook (kmc-gcc-2.7.2-wasm.patch).
#
# These 1996 sources cannot be configured for an emscripten host (the build
# runs generators it just compiled; libiberty probes libc by linking), so
# each is configured and built NATIVELY first - a build-time step only, which
# produces every generated source - and emcc-replay.mjs then replays the
# logged compile/archive/link commands with emcc. Nothing native ships.
#
# Pins: versions.json toolchains.kmc_gcc / toolchains.kmc_binutils.
# Host deps (build time only): gcc, make, emcc (emsdk 4.0.18).
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd gcc
require_cmd make

ROOT="$BUILD_DIR/decomp-gcc"
PKG_OUT="$PROJECT_DIR/../romdev-toolchain-decomp-gcc/wasm/kmc-2.7.2"
mkdir -p "$ROOT" "$PKG_OUT"

# Host flags that let 1990s K&R C build with a modern gcc (native phase only).
NATIVE_CC="gcc -std=gnu89 -w -fcommon -Wno-error -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types -Wno-implicit-int -Wno-return-mismatch"
# The same C dialect under emcc, as a 32-bit (ILP32) target like the i386
# hosts these programs were written for. -flto is load-bearing: K&R callers
# see implicit `int f()` for functions defined `void f(a, b, c)`, and only at
# LTO can the wasm backend adapt such mismatched direct calls
# (FixFunctionBitcasts); a non-LTO link turns each into a trap.
EMCC="emcc -O2 -flto -fno-strict-aliasing -std=gnu89 -w -Wno-error -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types -Wno-implicit-int"
# EMULATE_FUNCTION_POINTER_CASTS: the same K&R looseness through function
# pointers (cc1 calls hooks with more or fewer arguments than they declare).
EMLINK_BASE="$EMCC -g0 -Wl,--allow-multiple-definition -sEMULATE_FUNCTION_POINTER_CASTS=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node -sNODERAWFS=1 -sWASM_ASYNC_COMPILATION=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=8388608 -sEXIT_RUNTIME=1 -sINVOKE_RUN=0 -sEXPORTED_RUNTIME_METHODS=callMain,FS,ENV"

apply_patch() { # <key>
  local p; p="$(pin_get "toolchains.$1" patch)"
  [ -n "$p" ] || return 0
  if patch_already_applied "$PROJECT_DIR/$p"; then echo "$1: romdev patch already applied"
  else git checkout -- . && git apply "$PROJECT_DIR/$p"; fi
}

sync_glue() {
  local f="$1"
  sed -i 's/const{createRequire}=await import("module");var require=createRequire(import.meta.url)/var require=process.getBuiltinModule("module").createRequire(import.meta.url)/' "$f"
  if grep -q 'await import("module")' "$f" || ! grep -q 'process.getBuiltinModule("module")' "$f"; then
    echo "FATAL: $f: emscripten glue prologue changed; sync_glue did not apply" >&2
    exit 1
  fi
}

stage() { # <built .js> <name>
  cp "$1" "$PKG_OUT/$2.mjs"
  cp "${1%.js}.wasm" "$PKG_OUT/$2.wasm"
  sync_glue "$PKG_OUT/$2.mjs"
}

# -- gcc 2.7.2 ----------------------------------------------------------
GSRC="$ROOT/gcc-2.7.2"
fetch_pinned toolchains.kmc_gcc "$GSRC"
cd "$GSRC"
require_git_toplevel
apply_patch kmc_gcc
git clean -qfdx
./configure --target=mips-mips-gnu --prefix=/opt/cross --with-gnu-as \
  --host=i386-pc-linux --build=i386-pc-linux > "$ROOT/gcc-configure.log"
# Generated parser/keyword sources are committed; keep make from regenerating them.
touch c-gperf.h c-parse.c c-parse.h cexp.c bi-parser.c bi-parser.h objc-parse.c
make CC="$NATIVE_CC" cc1 cccp xgcc > "$ROOT/gcc-native.log" 2>&1
node "$SCRIPT_DIR/emcc-replay.mjs" --log "$ROOT/gcc-native.log" --dir "$GSRC" \
  --native-cc "$NATIVE_CC" --emcc "$EMCC" \
  --skip-source '^gen[a-z]*\.c$' \
  --emcc-link "$EMLINK_BASE -sEXPORT_NAME=kmcGcc" \
  --link "cc1=wasm-out/cc1.js" --link "cccp=wasm-out/cccp.js" --link "xgcc=wasm-out/xgcc.js"
stage wasm-out/xgcc.js gcc
stage wasm-out/cccp.js cpp
stage wasm-out/cc1.js cc1

# -- binutils 2.6 (as) --------------------------------------------------
BSRC="$ROOT/binutils-2.6"
fetch_pinned toolchains.kmc_binutils "$BSRC"
cd "$BSRC"
require_git_toplevel
apply_patch kmc_binutils
git clean -qfdx
./configure --target=mips-kmc-elf --prefix=/opt/cross \
  --host=i386-pc-linux --build=i386-pc-linux > "$ROOT/binutils-configure.log"
: > "$ROOT/binutils-native.log"
for d in libiberty bfd opcodes gas; do
  make -C "$d" CC="$NATIVE_CC" >> "$ROOT/binutils-native.log" 2>&1
done
# dummy.c is libiberty's probe of the host libc, not part of the library.
node "$SCRIPT_DIR/emcc-replay.mjs" --log "$ROOT/binutils-native.log" \
  --native-cc "$NATIVE_CC" --emcc "$EMCC" --skip-source '^dummy\.c$' \
  --emcc-link "$EMLINK_BASE -sEXPORT_NAME=kmcAs" \
  --link "as.new=wasm-out/as.js"
stage gas/wasm-out/as.js as

# Drop the build trees' products; keep the checkouts for re-runs.
git -C "$GSRC" clean -qfdx
git -C "$BSRC" clean -qfdx
echo "KMC gcc 2.7.2 + binutils 2.6 as -> $PKG_OUT"
echo "Refresh the binary manifest: node scripts/binary-manifest.mjs --write"
