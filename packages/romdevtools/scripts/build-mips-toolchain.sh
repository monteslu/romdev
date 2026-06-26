#!/usr/bin/env bash
# Build the mips-elf cross-toolchain (binutils + gcc + newlib + libgcc)
# natively, into build/mips-toolchain/install/. STAGE 1 of the N64/PS1 C tier.
#
# Mirrors build-m68k-toolchain.sh exactly (same bootstrap reason: gcc must run
# its in-progress native xgcc to build libgcc, so STAGE 1 is native; STAGE 2
# re-compiles cc1/as/ld to WASM via build-mips-wasm-tools.sh).
#
# Target: mips-elf, big-endian default (N64 R4300). PS1 (R3000, little-endian)
# is reached from the SAME toolchain with -EL -mabi=32. libdragon (N64) and
# PSn00bSDK (PS1) build on top in STAGE 3.
#
# Pins (modern libdragon / PsyQ-free practice):
#   binutils 2.42   gcc 14.2.0   newlib 4.4.0
# Host deps: gawk texinfo libgmp-dev libmpfr-dev libmpc-dev libisl-dev
# ~30-60 min, ~5 GB disk.
set -euo pipefail
. "$(dirname "$0")/_lib.sh" 2>/dev/null || true
command -v make >/dev/null || { echo "make required"; exit 1; }
command -v gcc >/dev/null || { echo "gcc required"; exit 1; }
command -v makeinfo >/dev/null || { echo "makeinfo (texinfo) required"; exit 1; }

BINUTILS_VER=2.42
GCC_VER=14.2.0
NEWLIB_VER=4.4.0.20231231
TARGET=mips-elf

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="${ROMDEV_BUILD_DIR:-$PROJECT_DIR/build}/mips-toolchain"
SRC_DIR="$ROOT/src"
PREFIX="$ROOT/install"
NCPU="$(nproc)"
mkdir -p "$SRC_DIR" "$PREFIX"
cd "$SRC_DIR"

# GCC 15 defaults to C23, where `static_assert` is a keyword; binutils 2.42's
# opcodes/mips-formats.h uses `static_assert` as an identifier (typedef name).
# Force gnu11 for the HOST-compiler builds so it parses. (Doesn't affect the
# generated MIPS code — only how the toolchain itself is compiled.)
export CFLAGS="-std=gnu11 ${CFLAGS:-}"
export CXXFLAGS="-std=gnu++11 ${CXXFLAGS:-}"

# ── Fetch + extract ─────────────────────────────────────────────────
if [ ! -d "binutils-$BINUTILS_VER" ]; then
  [ -f "binutils-$BINUTILS_VER.tar.xz" ] || wget -q "https://ftp.gnu.org/gnu/binutils/binutils-$BINUTILS_VER.tar.xz"
  tar xf "binutils-$BINUTILS_VER.tar.xz"
fi
if [ ! -d "gcc-$GCC_VER" ]; then
  [ -f "gcc-$GCC_VER.tar.xz" ] || wget -q "https://ftp.gnu.org/gnu/gcc/gcc-$GCC_VER/gcc-$GCC_VER.tar.xz"
  tar xf "gcc-$GCC_VER.tar.xz"
fi
if [ ! -d "newlib-$NEWLIB_VER" ]; then
  [ -f "newlib-$NEWLIB_VER.tar.gz" ] || wget -q "ftp://sourceware.org/pub/newlib/newlib-$NEWLIB_VER.tar.gz" || \
    wget -q "https://sourceware.org/pub/newlib/newlib-$NEWLIB_VER.tar.gz"
  tar xf "newlib-$NEWLIB_VER.tar.gz"
fi

export PATH="$PREFIX/bin:$PATH"

# ── 1. binutils ─────────────────────────────────────────────────────
if [ ! -x "$PREFIX/bin/$TARGET-as" ]; then
  rm -rf build-binutils; mkdir build-binutils; cd build-binutils
  "$SRC_DIR/binutils-$BINUTILS_VER/configure" \
    --target="$TARGET" --prefix="$PREFIX" \
    --disable-nls --disable-werror --disable-multilib
  make -j"$NCPU"; make install
  cd "$SRC_DIR"
fi

# ── 2. gcc (stage 1: C compiler, no target libs yet) ────────────────
if [ ! -x "$PREFIX/bin/$TARGET-gcc" ]; then
  rm -rf build-gcc; mkdir build-gcc; cd build-gcc
  "$SRC_DIR/gcc-$GCC_VER/configure" \
    --target="$TARGET" --prefix="$PREFIX" \
    --enable-languages=c --disable-nls --disable-multilib \
    --disable-shared --disable-threads --disable-libssp \
    --disable-libstdcxx --without-headers --with-newlib --with-system-zlib
  make -j"$NCPU" all-gcc; make install-gcc
  cd "$SRC_DIR"
fi

# ── 3. newlib (target C library, built with the new gcc) ────────────
# newlib 4.4.0's libgloss/mips board-support uses pre-C23 idioms (implicit
# function decls, int↔pointer assignments) that GCC 14+/C23 treats as ERRORS.
# Demote them to warnings for the TARGET compiler so libc/libm build. (We don't
# ship libgloss's board glue — libdragon/PSn00bSDK provide their own crt0.)
NEWLIB_TARGET_CFLAGS="-Wno-implicit-function-declaration -Wno-int-conversion -Wno-return-mismatch -Wno-implicit-int"
if [ ! -f "$PREFIX/$TARGET/lib/libc.a" ]; then
  rm -rf build-newlib; mkdir build-newlib; cd build-newlib
  "$SRC_DIR/newlib-$NEWLIB_VER/configure" \
    --target="$TARGET" --prefix="$PREFIX" \
    --disable-nls --disable-multilib
  make -j"$NCPU" CFLAGS_FOR_TARGET="$NEWLIB_TARGET_CFLAGS"; make install
  cd "$SRC_DIR"
fi

# ── 4. libgcc (needs newlib headers) ────────────────────────────────
if [ ! -f "$PREFIX/lib/gcc/$TARGET/$GCC_VER/libgcc.a" ]; then
  cd build-gcc
  make -j"$NCPU" all-target-libgcc; make install-target-libgcc
  cd "$SRC_DIR"
fi

echo "STAGE 1 done: $PREFIX/bin/$TARGET-gcc"
"$PREFIX/bin/$TARGET-gcc" --version | head -1
