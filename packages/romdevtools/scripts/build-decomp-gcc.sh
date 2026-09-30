#!/usr/bin/env bash
# Build the old gcc toolchains N64 decomp projects compile with to WASM:
#   kmc   the N64 SDK's (KMC) gcc 2.7.2 (driver, cccp, cc1) + binutils 2.6 as
#         -> packages/romdev-toolchain-decomp-gcc/wasm/kmc-2.7.2/
#   egcs  EGCS 1.1.2 (gcc 2.91.66: driver, cccp, cc1) + binutils 2.9.5 as, the
#         iQue (China) builds' compiler
#         -> packages/romdev-toolchain-decomp-gcc/wasm/egcs-1.1.2/
#   psx   gcc 2.6.3 for the PlayStation (decompals/old-gcc gcc-2.6.3-psx):
#         cc1 and cpp (cccp), which PS1 decomp projects run directly, and the
#         driver (gcc), whose as step is the mips-linux-gnu binutils as
#         (psx-gcc-2.6.3-wasm.patch)
#         -> packages/romdev-toolchain-decomp-gcc/wasm/psx-gcc-2.6.3/
# The N64 directories hold gcc (the driver), cpp (cccp), cc1, as.
#   build-decomp-gcc.sh [kmc|egcs|psx|all]   (default all)
# romdev runs `gcc` in its WASM worker; the driver's subprograms run as
# sibling modules through a JS spawn hook (kmc-gcc-2.7.2-wasm.patch,
# egcs-1.1.2-wasm.patch, psx-gcc-2.6.3-wasm.patch).
#
# These 1996 sources cannot be configured for an emscripten host (the build
# runs generators it just compiled; libiberty probes libc by linking), so
# each is configured and built NATIVELY first - a build-time step only, which
# produces every generated source - and emcc-replay.mjs then replays the
# logged compile/archive/link commands with emcc. Nothing native ships.
#
# Pins: versions.json toolchains.kmc_gcc / kmc_binutils / egcs_gcc / egcs_binutils /
# old_gcc / psx_gcc_263.
# Host deps (build time only): gcc, make, emcc (emsdk 4.0.18).
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd gcc
require_cmd make

ROOT="$BUILD_DIR/decomp-gcc"
WHICH="${1:-all}"
case "$WHICH" in kmc|egcs|psx|all) ;; *) echo "usage: $0 [kmc|egcs|psx|all]" >&2; exit 2 ;; esac
PKG_BASE="$PROJECT_DIR/../romdev-toolchain-decomp-gcc/wasm"
mkdir -p "$ROOT"

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
  mkdir -p "$PKG_OUT"
  cp "$1" "$PKG_OUT/$2.mjs"
  cp "${1%.js}.wasm" "$PKG_OUT/$2.wasm"
  sync_glue "$PKG_OUT/$2.mjs"
}

build_kmc() {
PKG_OUT="$PKG_BASE/kmc-2.7.2"
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
}

build_egcs() {
PKG_OUT="$PKG_BASE/egcs-1.1.2"
# -- EGCS 1.1.2 (gcc 2.91.66) ---------------------------------------------
# Configured as decompals' release workflow does (target mips-linux).
GSRC="$ROOT/mips-gcc-egcs-2.91.66"
fetch_pinned toolchains.egcs_gcc "$GSRC"
cd "$GSRC"
require_git_toplevel
git clean -qfdx
apply_patch egcs_gcc
CC="$NATIVE_CC" ./configure --target=mips-linux --prefix=/opt/cross --with-gnu-as --disable-gprof \
  --disable-gdb --disable-werror --host=i386-pc-linux --build=i386-pc-linux > "$ROOT/egcs-configure.log"
# Generated sources are committed; keep make from regenerating them (and
# gcc/configure from being rebuilt by a newer autoconf).
touch gcc/configure gcc/c-gperf.h gcc/c-parse.c gcc/cp/parse.c gcc/cexp.c
make -C gcc CC="$NATIVE_CC" xgcc cc1 cccp > "$ROOT/egcs-native.log" 2>&1
# The native configure found glibc's <stab.h>; emscripten has none. gcc's own
# gstab.h defines the same N_* codes (both come from GNU's stab.def).
# -fwrapv: EGCS folds constants with signed arithmetic that relies on
# two's-complement wraparound (clang otherwise folds `a - -c` differently).
mkdir -p "$ROOT/egcs-compat"
printf '#include "gstab.h"\n' > "$ROOT/egcs-compat/stab.h"
node "$SCRIPT_DIR/emcc-replay.mjs" --log "$ROOT/egcs-native.log" \
  --native-cc "$NATIVE_CC" --emcc "$EMCC -fwrapv -I$ROOT/egcs-compat" \
  --skip-source '^gen(?!rtl\.c)[a-z]*\.c$' \
  --emcc-link "$EMLINK_BASE -sEXPORT_NAME=egcsGcc" \
  --link "cc1=wasm-out/cc1.js" --link "cccp=wasm-out/cccp.js" --link "xgcc=wasm-out/xgcc.js"
stage gcc/wasm-out/xgcc.js gcc
stage gcc/wasm-out/cccp.js cpp
stage gcc/wasm-out/cc1.js cc1

# -- binutils 2.9.5 (as) ------------------------------------------------
BSRC="$ROOT/mips-binutils-egcs-2.9.5"
fetch_pinned toolchains.egcs_binutils "$BSRC"
cd "$BSRC"
require_git_toplevel
git clean -qfdx
apply_patch egcs_binutils
CC="$NATIVE_CC" ./configure --target=mips-linux --prefix=/opt/cross --disable-gprof --disable-gdb \
  --disable-werror --host=i386-pc-linux --build=i386-pc-linux > "$ROOT/egcs-binutils-configure.log"
: > "$ROOT/egcs-binutils-native.log"
for d in libiberty bfd opcodes intl gas; do
  make -C "$d" CC="$NATIVE_CC" >> "$ROOT/egcs-binutils-native.log" 2>&1
done
node "$SCRIPT_DIR/emcc-replay.mjs" --log "$ROOT/egcs-binutils-native.log" \
  --native-cc "$NATIVE_CC" --emcc "$EMCC -fwrapv" --skip-source '^dummy\.c$' \
  --emcc-link "$EMLINK_BASE -sEXPORT_NAME=egcsAs" \
  --link "as-new=wasm-out/as.js"
stage gas/wasm-out/as.js as

git -C "$GSRC" checkout -q -- . && git -C "$GSRC" clean -qfdx
git -C "$BSRC" clean -qfdx
echo "EGCS 1.1.2 + binutils 2.9.5 as -> $PKG_OUT"
}

build_psx() {
PKG_OUT="$PKG_BASE/psx-gcc-2.6.3"
# -- gcc 2.6.3 for the PlayStation (decompals/old-gcc gcc-2.6.3-psx) -------
# The same source and patch steps as old-gcc's gcc-2.6.3-psx.Dockerfile. Its
# reference build is a 32-bit (-m32) i386 binary; this build machine has no
# 32-bit libc, and the generators (genflags, genattr, ...) crash as 64-bit
# programs, so here EVERYTHING is compiled with emcc - wasm32 is the same ILP32
# model - and the generators run under node during the build (emcc-exe gives
# each linked program a node shebang). Then cc1 and cccp are relinked as
# romdev modules.
local P="$ROOT/psx"
mkdir -p "$P"
local OG="$P/old-gcc"
fetch_pinned toolchains.old_gcc "$OG"
fetch_pinned_tarball toolchains.psx_gcc_263 "$P/gcc-2.6.3.tar.gz"
rm -rf "$P/gcc-2.6.3"
tar -C "$P" -xzf "$P/gcc-2.6.3.tar.gz"
chmod -R u+w "$P/gcc-2.6.3"
cd "$P/gcc-2.6.3"
sed -i -- 's/include <varargs.h>/include <stdarg.h>/g' ./*.c
patch -s -u -p1 obstack.h -i "$OG/patches/obstack-2.7.2.h.patch"
patch -s -u -p1 sdbout.c -i "$OG/patches/sdbout-2.6.3.c.patch"
patch -s -u -p1 cp/g++.c -i "$OG/patches/g++-2.6.3.c.patch"
patch -s -u -p1 < "$OG/patches/psx-2.5.7.patch"
# romdev: the driver's spawn hook and a sys_errlist built from strerror (musl
# has none), and -EL for the (big-endian by default) mips-linux-gnu as.
patch -s -u -p1 < "$PROJECT_DIR/$(pin_get toolchains.psx_gcc_263 patch)"
touch -c cp/parse.y cp/parse.h cp/parse.c
touch insn-config.h
./configure --target=mips-sony-psx --prefix=/opt/cross --with-endian-little --with-gnu-as \
  --host=i386-pc-linux --build=i386-pc-linux > "$P/configure.log"

# A linked program becomes a node script, runnable in place by make.
cat > "$P/emcc-exe" <<'SH'
#!/bin/sh
out=""; link=1; prev=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  case "$a" in -c|-E|-S|-M) link=0 ;; esac
  prev="$a"
done
emcc "$@" || exit $?
if [ "$link" = 1 ] && [ -n "$out" ] && [ -f "$out" ] && [ "$(head -c 2 "$out")" != "#!" ]; then
  { printf '#!/usr/bin/env node\n'; cat "$out"; } > "$out.tmp" && mv "$out.tmp" "$out" && chmod +x "$out"
fi
SH
chmod +x "$P/emcc-exe"
# romdevtools is "type": "module"; the generator scripts are CommonJS.
printf '{"type":"commonjs"}\n' > "$P/package.json"
# old-gcc's CFLAGS (-Dbsd4_4 -Dmips -DHAVE_STRERROR), plus what the i386 glibc
# headers supplied: HZ, and __linux__ (sdbout.c then uses gcc's own gsyms.h).
local DEFS="-Dbsd4_4 -Dmips -DHAVE_STRERROR -DHZ=100 -D__linux__=1"
local PSXCC="-O2 -flto -fno-strict-aliasing -fwrapv -std=gnu89 -w -Wno-error -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types -Wno-implicit-int $DEFS"
make cccp cc1 xgcc CC="$P/emcc-exe $PSXCC" CFLAGS="" \
  LDFLAGS="-sNODERAWFS=1 -sALLOW_MEMORY_GROWTH=1 -sEMULATE_FUNCTION_POINTER_CASTS=1 -Wl,--allow-multiple-definition -sSTACK_SIZE=8388608 -sEXIT_RUNTIME=1" \
  > "$P/build.log" 2>&1
rm -f cc1 cc1.wasm cccp cccp.wasm xgcc xgcc.wasm
make cccp cc1 xgcc CC="emcc $PSXCC" CFLAGS="" LDFLAGS="${EMLINK_BASE#"$EMCC"} -sEXPORT_NAME=psxGcc" >> "$P/build.log" 2>&1
mkdir -p "$PKG_OUT"
for t in cc1:cc1 cccp:cpp xgcc:gcc; do
  cp "${t%%:*}" "$PKG_OUT/${t#*:}.mjs"
  cp "${t%%:*}.wasm" "$PKG_OUT/${t#*:}.wasm"
  sync_glue "$PKG_OUT/${t#*:}.mjs"
done
cd "$P"
rm -rf "$P/gcc-2.6.3" "$P/emcc-exe" "$P/package.json"
echo "gcc 2.6.3-psx (gcc, cc1, cpp) -> $PKG_OUT"
}

case "$WHICH" in
  kmc) build_kmc ;;
  egcs) build_egcs ;;
  psx) build_psx ;;
  all) build_kmc; build_egcs; build_psx ;;
esac
echo "Refresh the binary manifest: node scripts/binary-manifest.mjs --write"
