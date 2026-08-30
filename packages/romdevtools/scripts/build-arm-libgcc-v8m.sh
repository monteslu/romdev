#!/usr/bin/env bash
# Build libgcc for ARMv8-M main + hard float (fpv5-sp-d16) — the multilib a
# sync32 cart links against.
#
# WHY THIS EXISTS SEPARATELY from build-arm-toolchain.sh: that script builds a
# SINGLE-ARCH toolchain (`--disable-multilib --with-cpu=arm7tdmi`) for the GBA,
# so the libgcc it installs is ARMv4T and link-incompatible with a Cortex-M33
# object. The compiler itself is fine for both — only the runtime library is
# per-architecture.
#
# A sync32 cart is freestanding and needs NO libc, but it does need libgcc's
# compiler helpers: any 64-bit divide emits __aeabi_uldivmod, doubles emit the
# __aeabi_d* soft-float routines, and so on. Those live only in libgcc.
#
# Output: the built libgcc.a is staged into romdev-platform-sync32/share.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd make
require_cmd gcc
require_cmd gawk
require_cmd makeinfo
require_cmd wget

BINUTILS_VER=2.42
GCC_VER=14.2.0
TARGET=arm-none-eabi
# The exact multilib the SDK's CFLAGS select: -mcpu=cortex-m33 -mthumb
# -mfloat-abi=hard -mfpu=fpv5-sp-d16 resolves to thumb/v8-m.main+fp/hard.
ARCH_FLAGS="-mthumb -march=armv8-m.main+fp -mfloat-abi=hard"

ROOT="$BUILD_DIR/arm-libgcc-v8m"
SRC_DIR="$ROOT/src"
PREFIX="$ROOT/install"
NCPU="$(nproc)"
mkdir -p "$SRC_DIR" "$PREFIX"

cd "$SRC_DIR"
# Same upstreams and versions as build-arm-toolchain.sh — the compiler that
# builds this libgcc must match the one that compiles carts.
[ -d "binutils-$BINUTILS_VER" ] || {
  [ -f "binutils-$BINUTILS_VER.tar.xz" ] || wget -q "https://ftp.gnu.org/gnu/binutils/binutils-$BINUTILS_VER.tar.xz"
  tar xf "binutils-$BINUTILS_VER.tar.xz"
}
[ -d "gcc-$GCC_VER" ] || {
  [ -f "gcc-$GCC_VER.tar.xz" ] || wget -q "https://ftp.gnu.org/gnu/gcc/gcc-$GCC_VER/gcc-$GCC_VER.tar.xz"
  tar xf "gcc-$GCC_VER.tar.xz"
  (cd "gcc-$GCC_VER" && ./contrib/download_prerequisites)
}

# ── binutils (as/ld the gcc build needs) ──
if [ ! -x "$PREFIX/bin/$TARGET-as" ]; then
  mkdir -p "$ROOT/build-binutils"; cd "$ROOT/build-binutils"
  [ -f Makefile ] || "$SRC_DIR/binutils-$BINUTILS_VER/configure" \
    --target="$TARGET" --prefix="$PREFIX" --disable-nls --disable-werror --with-sysroot
  make -j"$NCPU"; make install
fi
export PATH="$PREFIX/bin:$PATH"

# ── gcc stage 1, configured for the v8-m multilib ──
# --without-headers + --with-newlib: libgcc builds in its "no libc yet" mode,
# which is exactly right — a cart links no libc at all.
if [ ! -x "$PREFIX/bin/$TARGET-gcc" ]; then
  mkdir -p "$ROOT/build-gcc"; cd "$ROOT/build-gcc"
  [ -f Makefile ] || "$SRC_DIR/gcc-$GCC_VER/configure" \
    --target="$TARGET" --prefix="$PREFIX" \
    --enable-languages=c --disable-nls --disable-shared --disable-threads \
    --disable-libssp --disable-libstdcxx --without-headers --with-newlib \
    --disable-multilib \
    --with-arch=armv8-m.main+fp --with-mode=thumb --with-float=hard \
    --with-system-zlib
  make -j"$NCPU" all-gcc
  make install-gcc
fi

# ── libgcc for that multilib ──
cd "$ROOT/build-gcc"
make -j"$NCPU" all-target-libgcc
make install-target-libgcc

LIB="$(find "$PREFIX" -name libgcc.a | head -1)"
[ -n "$LIB" ] || { echo "FATAL: no libgcc.a produced" >&2; exit 1; }

# Sanity: it must BE ARMv8-M, not v4T. A silently-wrong multilib links but
# faults on hardware, so check the attribute rather than trusting the path.
TMP="$(mktemp -d)"
"$PREFIX/bin/$TARGET-ar" p "$LIB" "$("$PREFIX/bin/$TARGET-ar" t "$LIB" | head -1)" > "$TMP/probe.o"
if ! "$PREFIX/bin/$TARGET-readelf" -A "$TMP/probe.o" | grep -q "v8-M\|v8M"; then
  echo "FATAL: built libgcc is not ARMv8-M:" >&2
  "$PREFIX/bin/$TARGET-readelf" -A "$TMP/probe.o" | grep Tag_CPU >&2
  exit 1
fi
rm -rf "$TMP"

OUT="$PROJECT_DIR/../romdev-platform-sync32/share/sync32/lib"
mkdir -p "$OUT"
cp "$LIB" "$OUT/libgcc.a"
# Strip debug info: this archive is SHIPPED, and nobody debugs into libgcc from
# a cart. 9.8MB -> 1.2MB, which puts it below the GBA package's own libgcc.
"$PREFIX/bin/$TARGET-strip" --strip-debug "$OUT/libgcc.a"
echo "libgcc.a (armv8-m.main+fp/hard) staged at $OUT"
"$PREFIX/bin/$TARGET-nm" "$OUT/libgcc.a" 2>/dev/null | grep -c "T __aeabi" | xargs echo "  __aeabi helpers:"
