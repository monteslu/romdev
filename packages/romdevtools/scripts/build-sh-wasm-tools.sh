#!/usr/bin/env bash
# STAGE 2 of the N64/PS1 C tier: compile the sh-elf toolchain components
# (cc1, sh-elf-as, sh-elf-ld, sh-elf-objcopy, sh-elf-objdump) to WASM
# via emcc. Mirrors build-m68k-wasm-tools.sh exactly.
#
# Requires STAGE 1 (build-sh-toolchain.sh) to have produced the native
# toolchain + the gcc/binutils source trees under build/sh-toolchain/src.
#
# Flow: 1) WASM prereq libs (GMP/MPFR/MPC/ISL via emconfigure)
#       2) configure gcc --host=wasm32-unknown-emscripten → cc1.wasm
#       3) configure binutils --host=wasm32-unknown-emscripten → as/ld/objcopy/objdump
#       4) wrap each WASM binary in our MODULARIZE/EXPORT_ES6 shell
#       5) stage to src/toolchains/sh-elf-gcc/wasm/ + the package
set -euo pipefail
. "$(dirname "$0")/_lib.sh" 2>/dev/null || true
command -v emcc >/dev/null || { echo "emcc required (source emsdk_env.sh)"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="${ROMDEV_BUILD_DIR:-$PROJECT_DIR/build}/sh-toolchain"
SRC_DIR="$ROOT/src"
WASM_PREFIX="$ROOT/wasm-deps"
NCPU="$(nproc)"
OUT="$PROJECT_DIR/src/toolchains/sh-elf-gcc/wasm"
PKG_OUT="$PROJECT_DIR/../romdev-toolchain-sh-gcc/wasm"
mkdir -p "$WASM_PREFIX" "$OUT" "$PKG_OUT"

GMP_VER=6.3.0; MPFR_VER=4.2.1; MPC_VER=1.3.1; ISL_VER=0.24
GCC_VER=14.2.0; BINUTILS_VER=2.42
TARGET=sh-elf

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

# emscripten's libc DECLARES psignal (const char*), but gcc's libiberty defines it
# (char*) under #ifndef HAVE_PSIGNAL → "conflicting types" building strsignal.o.
# The autoconf-cache route didn't stick (libiberty re-probes), so patch the source:
# disable libiberty's psignal outright (emscripten provides it). Idempotent.
if ! grep -q "romdev: emscripten libc provides psignal" "$SRC_DIR/gcc-$GCC_VER/libiberty/strsignal.c"; then
  sed -i 's/#ifndef HAVE_PSIGNAL/#if 0 \/* romdev: emscripten libc provides psignal *\//' \
    "$SRC_DIR/gcc-$GCC_VER/libiberty/strsignal.c"
fi
PSIGNAL_CACHE=""

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
  # Build JUST cc1 (the C frontend we need), NOT all-gcc — the aux tools
  # (gcov-tool, lto-plugin) reference ftw/liblto_plugin.so that emscripten lacks
  # and abort the whole all-gcc target. cc1 is self-contained. configure-gcc
  # creates the gcc/ subdir + Makefile first (lazy with --host=wasm32). gcc's cc1
  # needs the BUILD-side (native) genmodes/gen* tools, which need the build-side
  # libiberty — build that first, then configure-gcc, then cc1.
  emmake make -j"$NCPU" all-build
  emmake make -j"$NCPU" configure-gcc
  ( cd gcc && emmake make -j"$NCPU" cc1 )
fi

# ── 3. binutils as WASM ─────────────────────────────────────────────
# binutils has its OWN libiberty/strsignal.c — patch it too (same psignal fix).
if ! grep -q "romdev: emscripten libc provides psignal" "$SRC_DIR/binutils-$BINUTILS_VER/libiberty/strsignal.c"; then
  sed -i 's/#ifndef HAVE_PSIGNAL/#if 0 \/* romdev: emscripten libc provides psignal *\//' \
    "$SRC_DIR/binutils-$BINUTILS_VER/libiberty/strsignal.c"
fi
if [ ! -f "$ROOT/build-wasm-binutils/gas/as-new.wasm" ]; then
  cd "$ROOT"; mkdir -p build-wasm-binutils; cd build-wasm-binutils
  [ -f Makefile ] || emconfigure "$SRC_DIR/binutils-$BINUTILS_VER/configure" \
    --target=$TARGET --prefix="$WASM_PREFIX/binutils-wasm" \
    --host=wasm32-unknown-emscripten --build="$(gcc -dumpmachine)" \
    --disable-nls --disable-werror --disable-multilib
  # Build the support libs then the tool subdirs via the TOP makefile (all-gas /
  # all-ld / all-binutils configure + build their subdirs; a bare `all` would also
  # pull in gprofng/aux tools that reference ftw etc. and abort).
  emmake make -j"$NCPU" all-libiberty all-bfd all-opcodes all-libsframe all-libctf
  emmake make -j"$NCPU" all-gas all-ld all-binutils
fi

# ── 4. Wrap + stage ─────────────────────────────────────────────────
# Each tool is RE-LINKED through its own Makefile with the MODULARIZE/EXPORT_ES6
# knobs injected via LDFLAGS — NOT `emcc <built>` directly, because the tool's
# object list (libbackend.a + the per-language objects for cc1, etc.) is known
# only to the Makefile. Output goes straight to the staging dir.
KNOBS_BASE="-O2 -g0 -s MODULARIZE=1 -s EXPORT_ES6=1 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=268435456 -s EXIT_RUNTIME=1 -s INVOKE_RUN=0 -s ENVIRONMENT=node -s EXPORTED_RUNTIME_METHODS=callMain,FS"

relink() { # <build-subdir> <make-target> <out-name> <export-name>
  local sub="$1" tgt="$2" out="$3" exp="$4"
  echo "  re-linking + staging $out"
  ( cd "$sub" && rm -f "$tgt" "$tgt.wasm" && \
    emmake make "$tgt" LDFLAGS="$KNOBS_BASE -s EXPORT_NAME=$exp" )
  cp "$sub/$tgt"      "$OUT/$out.mjs"
  cp "$sub/$tgt.wasm" "$OUT/$out.wasm"
  cp "$OUT/$out.mjs" "$OUT/$out.wasm" "$PKG_OUT/" 2>/dev/null || true
}
relink "$ROOT/build-wasm-gcc/gcc"        cc1     cc1              createMipsCc1
relink "$ROOT/build-wasm-binutils/gas"   as-new  sh-elf-as      createMipsAs
relink "$ROOT/build-wasm-binutils/ld"    ld-new  sh-elf-ld      createMipsLd
relink "$ROOT/build-wasm-binutils/binutils" objcopy sh-elf-objcopy createMipsObjcopy
relink "$ROOT/build-wasm-binutils/binutils" objdump sh-elf-objdump createMipsObjdump

echo "STAGE 2 complete. sh-elf tools staged → $OUT/"
