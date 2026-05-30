#!/usr/bin/env bash
# Build the m68k-elf cross-toolchain (binutils + gcc + newlib + libgcc)
# natively, into our isolated build/m68k-toolchain/install/ prefix.
#
# This is STAGE 1 of the Genesis C tier-1 pipeline. STAGE 2 (forthcoming)
# compiles cc1, m68k-elf-as, m68k-elf-ld to WASM via emcc. STAGE 3 builds
# SGDK against this toolchain and ships the resulting libmd.a.
#
# Why a native build first: emscripten can't bootstrap gcc directly — gcc's
# build system relies on running its in-progress xgcc (newly-built native
# gcc) to build libgcc + crtbegin/crtend for the target. That binary needs
# to be executable on the host machine. So we build the toolchain natively
# here, then re-compile each component (cc1, as, ld) to WASM in STAGE 2
# while reusing the native target artifacts (libgcc.a, crt0.o, etc.).
#
# Pinned versions (current as of 2026-05-26, matches modern SGDK / marsdev
# practice):
#   binutils  2.42       (Jan 2024)
#   gcc       14.2.0     (Aug 2024)
#   newlib    4.4.0      (Dec 2023)
#
# Host deps (Debian/Ubuntu) — see BUILDING.md "Host dependencies":
#   apt-get install gawk texinfo libgmp-dev libmpfr-dev libmpc-dev libisl-dev
#
# Build is ~30-60 minutes on a modern multi-core box. ~5 GB disk used.
#
# Patches applied to newlib (in scripts/patches/):
#   - newlib-4.4.0-m68k-ldbl-eq-dbl.patch:   sets _LDBL_EQ_DBL=1 for m68k
#     so libm/complex doesn't reference missing long-double math fns.
#   - newlib-4.4.0-m68k-bare-metal-system.patch: swaps -DHAVE_SYSTEM for
#     -DNO_EXEC in the m68k-unknown-elf stanza so system.c doesn't call
#     a missing _system() syscall.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd make
require_cmd gcc
require_cmd gawk
require_cmd makeinfo

BINUTILS_VER=2.42
GCC_VER=14.2.0
NEWLIB_VER=4.4.0.20231231
TARGET=m68k-elf

ROOT="$BUILD_DIR/m68k-toolchain"
SRC_DIR="$ROOT/src"
PREFIX="$ROOT/install"
NCPU="$(nproc)"
PATCH_DIR="$(cd "$(dirname "$0")/patches" && pwd)"

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
  # Apply our patches
  cd "newlib-$NEWLIB_VER"
  patch -p1 < "$PATCH_DIR/newlib-4.4.0-m68k-ldbl-eq-dbl.patch"
  patch -p1 < "$PATCH_DIR/newlib-4.4.0-m68k-bare-metal-system.patch"
  cd ..
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
      --with-cpu=m68000
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
      --with-cpu=m68000 \
      --with-system-zlib
  fi
  make -j"$NCPU" all-gcc
  make install-gcc
fi

# ── 3. newlib — target libc built using m68k-elf-gcc ──
if [ ! -f "$PREFIX/$TARGET/lib/libc.a" ]; then
  cd "$ROOT"
  mkdir -p build-newlib
  cd build-newlib
  if [ ! -f Makefile ]; then
    # --disable-libgloss: skip the simulator syscall stubs that fail
    # without a host OS. SGDK's crt0 + sega.s replace what libgloss
    # would have provided.
    "$SRC_DIR/newlib-$NEWLIB_VER/configure" \
      --target="$TARGET" \
      --prefix="$PREFIX" \
      --disable-nls \
      --disable-multilib \
      --disable-libgloss \
      --with-cpu=m68000
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
echo "=== smoke test: m68k-elf-gcc -v ==="
"$PREFIX/bin/$TARGET-gcc" -v 2>&1 | head -5
echo ""
echo "=== Genesis-class native compile test ==="
TMPC="$(mktemp).c"
TMPBIN="$(mktemp).bin"
cat > "$TMPC" <<'EOF'
int counter = 42;
int main(void) { counter += 1; return counter; }
EOF
"$PREFIX/bin/$TARGET-gcc" -m68000 -nostdlib -Wl,--entry=main "$TMPC" -o "${TMPC%.c}.elf"
"$PREFIX/bin/$TARGET-objcopy" -O binary "${TMPC%.c}.elf" "$TMPBIN"
ls -la "$TMPBIN"
echo "first 16 bytes (m68k instructions):"
xxd "$TMPBIN" | head -1
rm -f "$TMPC" "${TMPC%.c}.elf" "$TMPBIN"
echo ""
echo "m68k-elf toolchain installed at $PREFIX"
echo "Add to PATH:  export PATH=\"$PREFIX/bin:\$PATH\""
