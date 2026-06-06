#!/usr/bin/env bash
# Build the arm-none-eabi cross-toolchain (binutils + gcc + newlib + libgcc)
# natively, into our isolated build/arm-toolchain/install/ prefix.
#
# This is STAGE 1 of the GBA C tier-1 pipeline (R24). STAGE 2 compiles
# cc1, arm-none-eabi-as, arm-none-eabi-ld, arm-none-eabi-objcopy to WASM
# via emcc. STAGE 3 builds libgba against this toolchain and ships
# libgba.a as the SDK runtime.
#
# Same pattern as build-m68k-toolchain.sh (R20). The R20 playbook
# transfers directly because we're following gcc's stage1→newlib→stage2
# pattern; only the target triple, CPU flags, and a couple of
# newlib-config knobs change.
#
# Pinned versions (matches m68k toolchain for consistency):
#   binutils  2.42       (Jan 2024)
#   gcc       14.2.0     (Aug 2024)
#   newlib    4.4.0      (Dec 2023)
#
# Target: arm-none-eabi (bare-metal ARM, no host OS).
# GBA-specific CPU flags baked into gcc defaults:
#   --with-cpu=arm7tdmi  (the GBA's ARM7TDMI CPU)
#   --with-mode=arm      (default to ARM mode, not Thumb;
#                         libgba mixes ARM + Thumb explicitly)
#   --with-arch=armv4t   (matches arm7tdmi)
#   --with-float=soft    (no FPU)
#   --with-tune=arm7tdmi
#
# Host deps (Debian/Ubuntu) — same as m68k, no extras:
#   apt-get install gawk texinfo libgmp-dev libmpfr-dev libmpc-dev libisl-dev
#
# Build is ~30-60 minutes on a modern multi-core box. ~5 GB disk used.
#
# Newlib differences from m68k:
#   - No _LDBL_EQ_DBL patch needed. ARM EABI already has
#     __LDBL_MANT_DIG__ == __DBL_MANT_DIG__, so libm/complex builds.
#   - --disable-newlib-supplied-syscalls replaces the m68k --disable-libgloss
#     pattern. Skips the Angel/Demon monitor stubs (intended for ARM dev
#     boards with a debug host) that the GBA doesn't have.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd make
require_cmd gcc
require_cmd gawk
require_cmd makeinfo

BINUTILS_VER=2.42
GCC_VER=14.2.0
NEWLIB_VER=4.4.0.20231231
TARGET=arm-none-eabi

ROOT="$BUILD_DIR/arm-toolchain"
SRC_DIR="$ROOT/src"
PREFIX="$ROOT/install"
NCPU="$(nproc)"

mkdir -p "$SRC_DIR" "$PREFIX"
cd "$SRC_DIR"

# ── Fetch + extract ─────────────────────────────────────────────────
if [ ! -d "binutils-$BINUTILS_VER" ]; then
  [ -f "binutils-$BINUTILS_VER.tar.xz" ] || \
    wget -q "https://ftp.gnu.org/gnu/binutils/binutils-$BINUTILS_VER.tar.xz"
  tar xf "binutils-$BINUTILS_VER.tar.xz"
fi
if [ ! -d "gcc-$GCC_VER" ]; then
  [ -f "gcc-$GCC_VER.tar.xz" ] || \
    wget -q "https://ftp.gnu.org/gnu/gcc/gcc-$GCC_VER/gcc-$GCC_VER.tar.xz"
  tar xf "gcc-$GCC_VER.tar.xz"
fi
if [ ! -d "newlib-$NEWLIB_VER" ]; then
  [ -f "newlib-$NEWLIB_VER.tar.gz" ] || \
    wget -q "ftp://sourceware.org/pub/newlib/newlib-$NEWLIB_VER.tar.gz"
  tar xf "newlib-$NEWLIB_VER.tar.gz"
fi

# ── 1. binutils ─────────────────────────────────────────────────────
if [ ! -x "$PREFIX/bin/$TARGET-as" ]; then
  cd "$ROOT"
  mkdir -p build-binutils
  cd build-binutils
  if [ ! -f Makefile ]; then
    "$SRC_DIR/binutils-$BINUTILS_VER/configure" \
      --target="$TARGET" \
      --prefix="$PREFIX" \
      --disable-nls \
      --disable-werror \
      --disable-multilib \
      --with-cpu=arm7tdmi
  fi
  make -j"$NCPU"
  make install
fi
export PATH="$PREFIX/bin:$PATH"

# ── 2. gcc stage 1 — C-only, no libc yet (newlib not built yet) ──
if [ ! -x "$PREFIX/bin/$TARGET-gcc" ]; then
  cd "$ROOT"
  mkdir -p build-gcc
  cd build-gcc
  if [ ! -f Makefile ]; then
    "$SRC_DIR/gcc-$GCC_VER/configure" \
      --target="$TARGET" \
      --prefix="$PREFIX" \
      --enable-languages=c \
      --disable-nls \
      --disable-multilib \
      --disable-shared \
      --disable-threads \
      --disable-libssp \
      --disable-libstdcxx \
      --without-headers \
      --with-newlib \
      --with-cpu=arm7tdmi \
      --with-mode=arm \
      --with-float=soft \
      --with-system-zlib
  fi
  make -j"$NCPU" all-gcc
  make install-gcc
fi

# ── 3. newlib — target libc built using arm-none-eabi-gcc ──
if [ ! -f "$PREFIX/$TARGET/lib/libc.a" ]; then
  cd "$ROOT"
  mkdir -p build-newlib
  cd build-newlib
  if [ ! -f Makefile ]; then
    # --disable-newlib-supplied-syscalls: skip the Angel/Demon monitor
    # stubs. GBA has no host OS; libgba's crt0 provides what would have
    # come from libgloss.
    # --enable-newlib-io-long-long: GBA games often want %lld for big
    # counters; small enough to bundle.
    # --disable-newlib-supplied-syscalls is the ARM equivalent of
    # m68k's --disable-libgloss.
    "$SRC_DIR/newlib-$NEWLIB_VER/configure" \
      --target="$TARGET" \
      --prefix="$PREFIX" \
      --disable-nls \
      --disable-multilib \
      --disable-newlib-supplied-syscalls \
      --enable-newlib-io-long-long \
      --with-cpu=arm7tdmi
  fi
  make -j"$NCPU"
  make install
fi

# ── 4. gcc stage 2 — libgcc + crtbegin/crtend against newlib ──
if [ ! -f "$PREFIX/lib/gcc/$TARGET/$GCC_VER/libgcc.a" ]; then
  cd "$ROOT/build-gcc"
  make -j"$NCPU" all-target-libgcc
  make install-target-libgcc
fi

# ── Smoke test ──────────────────────────────────────────────────────
echo ""
echo "=== smoke test: arm-none-eabi-gcc -v ==="
"$PREFIX/bin/$TARGET-gcc" -v 2>&1 | head -5
echo ""
echo "=== GBA-class native compile test ==="
TMPC="$(mktemp).c"
TMPBIN="$(mktemp).bin"
cat > "$TMPC" <<'EOF'
int counter = 42;
int main(void) { counter += 1; return counter; }
EOF
"$PREFIX/bin/$TARGET-gcc" -mcpu=arm7tdmi -marm -nostdlib -Wl,--entry=main "$TMPC" -o "${TMPC%.c}.elf"
"$PREFIX/bin/$TARGET-objcopy" -O binary "${TMPC%.c}.elf" "$TMPBIN"
ls -la "$TMPBIN"
echo "first 16 bytes (ARM instructions):"
xxd "$TMPBIN" | head -1
rm -f "$TMPC" "${TMPC%.c}.elf" "$TMPBIN"
echo ""
echo "arm-none-eabi toolchain installed at $PREFIX"
echo "Add to PATH:  export PATH=\"$PREFIX/bin:\$PATH\""
