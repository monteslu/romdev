#!/usr/bin/env bash
# STAGE 2 of the N64/PS1 C tier: compile the mips-elf toolchain components
# (cc1, mips-elf-as, mips-elf-ld, mips-elf-objcopy, mips-elf-objdump) to WASM
# via emcc. Mirrors build-m68k-wasm-tools.sh exactly.
#
# Requires STAGE 1 (build-mips-toolchain.sh) to have produced the native
# toolchain + the gcc/binutils source trees under build/mips-toolchain/src.
#
# Flow: 1) WASM prereq libs (GMP/MPFR/MPC/ISL via emconfigure)
#       2) configure gcc --host=wasm32-unknown-emscripten → cc1.wasm
#       3) configure binutils --host=wasm32-unknown-emscripten → as/ld/objcopy/objdump
#       4) wrap each WASM binary in our MODULARIZE/EXPORT_ES6 shell
#       5) stage to src/toolchains/mips-elf-gcc/wasm/ + the package
set -euo pipefail
. "$(dirname "$0")/_lib.sh" 2>/dev/null || true
command -v emcc >/dev/null || { echo "emcc required (source emsdk_env.sh)"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="${ROMDEV_BUILD_DIR:-$PROJECT_DIR/build}/mips-toolchain"
SRC_DIR="$ROOT/src"
WASM_PREFIX="$ROOT/wasm-deps"
NCPU="$(nproc)"
OUT="$PROJECT_DIR/src/toolchains/mips-elf-gcc/wasm"
PKG_OUT="$PROJECT_DIR/../romdev-toolchain-mips-gcc/wasm"
mkdir -p "$WASM_PREFIX" "$OUT" "$PKG_OUT"

GMP_VER=6.3.0; MPFR_VER=4.2.1; MPC_VER=1.3.1; ISL_VER=0.24
GCC_VER=14.2.0; BINUTILS_VER=2.42
TARGET=mips-elf

cd "$SRC_DIR"
for url in \
  "https://ftp.gnu.org/gnu/gmp/gmp-$GMP_VER.tar.xz" \
  "https://ftp.gnu.org/gnu/mpfr/mpfr-$MPFR_VER.tar.xz" \
  "https://gcc.gnu.org/pub/gcc/infrastructure/mpc-$MPC_VER.tar.gz" \
  "https://gcc.gnu.org/pub/gcc/infrastructure/isl-$ISL_VER.tar.bz2"; do
  f="${url##*/}"; [ -f "$f" ] || wget -q "$url"
done
[ -d "gmp-$GMP_VER" ]  || tar xf "gmp-$GMP_VER.tar.xz"
[ -d "mpfr-$MPFR_VER" ] || tar xf "mpfr-$MPFR_VER.tar.xz"
[ -d "mpc-$MPC_VER" ]  || tar xf "mpc-$MPC_VER.tar.gz"
[ -d "isl-$ISL_VER" ]  || tar xf "isl-$ISL_VER.tar.bz2"

# ── 1. WASM prereq libs ─────────────────────────────────────────────
if [ ! -f "$WASM_PREFIX/lib/libgmp.a" ]; then
  cd "$ROOT"; rm -rf build-wasm-gmp; mkdir build-wasm-gmp; cd build-wasm-gmp
  emconfigure "$SRC_DIR/gmp-$GMP_VER/configure" --prefix="$WASM_PREFIX" \
    --disable-shared --enable-static --host=none-none-none
  emmake make -j"$NCPU"; emmake make install
fi
if [ ! -f "$WASM_PREFIX/lib/libmpfr.a" ]; then
  cd "$ROOT"; rm -rf build-wasm-mpfr; mkdir build-wasm-mpfr; cd build-wasm-mpfr
  emconfigure "$SRC_DIR/mpfr-$MPFR_VER/configure" --prefix="$WASM_PREFIX" \
    --with-gmp="$WASM_PREFIX" --disable-shared --enable-static --host=none-none-none
  emmake make -j"$NCPU"; emmake make install
fi
if [ ! -f "$WASM_PREFIX/lib/libmpc.a" ]; then
  cd "$ROOT"; rm -rf build-wasm-mpc; mkdir build-wasm-mpc; cd build-wasm-mpc
  emconfigure "$SRC_DIR/mpc-$MPC_VER/configure" --prefix="$WASM_PREFIX" \
    --with-gmp="$WASM_PREFIX" --with-mpfr="$WASM_PREFIX" \
    --disable-shared --enable-static --host=none-none-none
  emmake make -j"$NCPU"; emmake make install
fi
if [ ! -f "$WASM_PREFIX/lib/libisl.a" ]; then
  cd "$ROOT"; rm -rf build-wasm-isl; mkdir build-wasm-isl; cd build-wasm-isl
  emconfigure "$SRC_DIR/isl-$ISL_VER/configure" --prefix="$WASM_PREFIX" \
    --with-gmp-prefix="$WASM_PREFIX" --disable-shared --enable-static --host=none-none-none
  emmake make -j"$NCPU"; emmake make install
fi

# emscripten's libc DECLARES psignal/sigsetmask/etc., so gcc's libiberty must NOT
# emit its own (conflicting) definitions. Pre-seed the autoconf cache so configure
# believes these exist → libiberty's #ifndef HAVE_* guards skip them.
PSIGNAL_CACHE="ac_cv_func_psignal=yes ac_cv_func_sigsetmask=yes"

# ── 2. cc1 as WASM ──────────────────────────────────────────────────
if [ ! -f "$ROOT/build-wasm-gcc/gcc/cc1.wasm" ]; then
  cd "$ROOT"; mkdir -p build-wasm-gcc; cd build-wasm-gcc
  [ -f Makefile ] || env $PSIGNAL_CACHE emconfigure "$SRC_DIR/gcc-$GCC_VER/configure" \
    --target=$TARGET --prefix="$WASM_PREFIX/gcc-wasm" \
    --host=wasm32-unknown-emscripten --build="$(gcc -dumpmachine)" \
    --enable-languages=c --disable-nls --disable-multilib \
    --disable-shared --disable-threads --disable-libssp --disable-libstdcxx \
    --disable-bootstrap --without-headers --with-newlib \
    --with-gmp="$WASM_PREFIX" --with-mpfr="$WASM_PREFIX" \
    --with-mpc="$WASM_PREFIX" --with-isl="$WASM_PREFIX" --with-system-zlib
  emmake make -j"$NCPU" all-gcc
fi

# ── 3. binutils as WASM ─────────────────────────────────────────────
if [ ! -f "$ROOT/build-wasm-binutils/gas/as-new.wasm" ]; then
  cd "$ROOT"; mkdir -p build-wasm-binutils; cd build-wasm-binutils
  [ -f Makefile ] || env $PSIGNAL_CACHE emconfigure "$SRC_DIR/binutils-$BINUTILS_VER/configure" \
    --target=$TARGET --prefix="$WASM_PREFIX/binutils-wasm" \
    --host=wasm32-unknown-emscripten --build="$(gcc -dumpmachine)" \
    --disable-nls --disable-werror --disable-multilib
  emmake make -j"$NCPU"
fi

# ── 4. Wrap + stage ─────────────────────────────────────────────────
BINUTILS_WASM="$ROOT/build-wasm-binutils/binutils"
GAS_WASM="$ROOT/build-wasm-binutils/gas"
LD_WASM="$ROOT/build-wasm-binutils/ld"
GCC_WASM="$ROOT/build-wasm-gcc/gcc"
EMCC_KNOBS='-O2 -g0 -s MODULARIZE=1 -s EXPORT_ES6=1 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=268435456 -s EXIT_RUNTIME=1 -s INVOKE_RUN=0 -s ENVIRONMENT=node -s EXPORTED_RUNTIME_METHODS=["callMain","FS"]'

stage() { # <built-wasm> <out-name> <export-name>
  local built="$1" out="$2" exp="$3"
  echo "  staging $out"
  emcc "$built" $EMCC_KNOBS -s EXPORT_NAME="$exp" -o "$OUT/$out.mjs"
  cp "$OUT/$out.mjs" "$OUT/$out.wasm" "$PKG_OUT/" 2>/dev/null || true
}
stage "$GCC_WASM/cc1"        cc1            createMipsCc1
stage "$GAS_WASM/as-new"     mips-elf-as    createMipsAs
stage "$LD_WASM/ld-new"      mips-elf-ld    createMipsLd
stage "$BINUTILS_WASM/objcopy" mips-elf-objcopy createMipsObjcopy
stage "$BINUTILS_WASM/objdump" mips-elf-objdump createMipsObjdump

echo "STAGE 2 complete. mips-elf tools staged → $OUT/"
