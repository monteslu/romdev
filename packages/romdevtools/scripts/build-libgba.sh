#!/usr/bin/env bash
# STAGE 3 of the GBA C tier-1 pipeline (R24): build libgba (the
# devkitPro GBA SDK runtime) against our stage-1 native
# arm-none-eabi cross-toolchain, then ship the resulting libgba.a
# + headers + crt0 + linker script as TARGET BINARY ARTIFACTS
# under packages/romdev-platform-gba/share/gba/lib/libgba/.
#
# Pattern matches R20 stage 3 (SGDK on Genesis):
#   - libgba.a is m68k-elf-equivalent ARM target object code; the
#     WASM cc1 we built in stage 2 produces .s files, our WASM as
#     turns them into .o, our WASM ld links against libgba.a (which
#     is just arm-elf object code, doesn't care that it was built
#     natively).
#   - We ship libgba.a + headers + crt0 + lnkscript INTO the user's
#     project tree per the self-containment policy.
#
# Output:
#   packages/romdev-platform-gba/share/gba/lib/libgba/libgba.a       (~200 KB target archive)
#   packages/romdev-platform-gba/share/gba/lib/libgba/include/...    (headers — gba.h, etc.)
#   packages/romdev-platform-gba/share/gba/lib/libgba/crt0.s         (cart startup code)
#   packages/romdev-platform-gba/share/gba/lib/libgba/lnkscript      (linker script)
#   packages/romdev-platform-gba/share/gba/lib/libgba/LICENSE        (zlib license)
#
# Prereq: stage 1 (build-arm-toolchain.sh) must have completed —
# we use that as the cross-toolchain for libgba's native target build.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"

NATIVE_PREFIX="$BUILD_DIR/arm-toolchain/install"
TARGET=arm-none-eabi
SRC_DIR="$BUILD_DIR/arm-toolchain/src"
OUT="$PROJECT_DIR/../romdev-platform-gba/share/gba/lib/libgba"
NCPU="$(nproc)"

if [ ! -x "$NATIVE_PREFIX/bin/$TARGET-gcc" ]; then
  echo "Stage 1 not done — run build-arm-toolchain.sh first." >&2
  exit 1
fi

export PATH="$NATIVE_PREFIX/bin:$PATH"

# Pin to a libgba release tag. As of 2026-05, devkitPro's libgba is at
# v0.5.4 (https://github.com/devkitPro/libgba/releases).
LIBGBA_VER=0.5.4
LIBGBA_URL="https://github.com/devkitPro/libgba/archive/refs/tags/v${LIBGBA_VER}.tar.gz"

mkdir -p "$SRC_DIR" "$OUT"
cd "$SRC_DIR"

if [ ! -d "libgba-$LIBGBA_VER" ]; then
  if [ ! -f "libgba-$LIBGBA_VER.tar.gz" ]; then
    wget -q "$LIBGBA_URL" -O "libgba-$LIBGBA_VER.tar.gz"
  fi
  tar xf "libgba-$LIBGBA_VER.tar.gz"
fi

cd "libgba-$LIBGBA_VER"

# libgba's Makefile expects BOTH DEVKITPRO and DEVKITARM env vars.
# DEVKITPRO is the umbrella tree (contains libgba's own sub-dir + tools);
# DEVKITARM points at the cross-toolchain root (with bin/arm-none-eabi-gcc).
# We fake both by pointing at our build/arm-toolchain/install/ — same
# bin/ layout as devkitARM expects.
export DEVKITPRO="$NATIVE_PREFIX"
export DEVKITARM="$NATIVE_PREFIX"
export PATH="$NATIVE_PREFIX/bin:$PATH"

# libgba's Makefile does `include $(DEVKITARM)/gba_rules` to pull in
# the canonical devkitPro-shipped tool + flag definitions. We
# don't have devkitPro installed, so synthesize a minimal one. The
# important variables are CC/CXX/AS/AR/LD/OBJCOPY/RANLIB (all via
# the $(PREFIX) shim) + ARCH (-mthumb -mthumb-interwork). Anything
# else is a fallback safety net.
# ─────────────────────────────────────────────────────────────────────
# IMPORTANT — libgba feature trade-off documented here so anyone
# reading the script knows EXACTLY what's missing and why.
# ─────────────────────────────────────────────────────────────────────
#
# libgba's console.c provides the canonical devkitARM-style stdio
# routing: `iprintf("score: %d", x)` → drawn to a tile-based text
# console on the GBA screen. Many published GBA homebrew tutorials
# show this as the "hello world" pattern.
#
# console.c depends on devkitPro's libsysbase headers (sys/iosupport.h
# → devoptab_t / devoptab_list[] / FindDevice + a long transitive
# chain pulling in sys/statvfs.h, sys/dir.h, etc.). devkitPro's libgloss
# is a substantial separate codebase we'd have to fully port; not in
# scope for getting GBA C builds working at all.
#
# Trade-off: we EXCLUDE console.c from libgba.a. Everything else in
# the SDK works — sprites, backgrounds, sound, input, interrupts,
# DMA, BIOS calls, palettes, the BoyScout 2D library, the disc_io
# layer. The ONLY thing missing is `iprintf`-style debug output.
#
# Three options if you want iprintf back:
#   1. Install devkitPro natively (apt + their repo), build libgba
#      there, point your project at their libgba.a. Works fine
#      alongside our toolchain.
#   2. Use mGBA's BIOS-level debug interface: write to addresses
#      0x4FFF780 / 0x4FFF700 to get strings into the emulator's
#      log without needing console.c at all. Doesn't help on real
#      hardware but agents debugging in mGBA can use it.
#   3. Implement your own tile-based text renderer using libgba's
#      VRAM helpers. ~30 lines of C for a basic 8x8 font.
#
# We surface this trade-off in src/platforms/gba/TROUBLESHOOTING.md
# and in the project README that createProject ships.
CONSOLE_C="$SRC_DIR/libgba-$LIBGBA_VER/src/console.c"
DATA_FNT="$SRC_DIR/libgba-$LIBGBA_VER/data/amiga.fnt"
if [ -f "$CONSOLE_C" ] || [ -f "$DATA_FNT" ]; then
  echo ""
  echo "─────────────────────────────────────────────────────────────────"
  echo "⚠️  EXCLUDING libgba's console.c (and its amiga.fnt font data)"
  echo ""
  echo "    iprintf-style stdio debug output WILL NOT WORK with the"
  echo "    libgba.a this script produces. This is deliberate — see"
  echo "    the long comment above this block in build-libgba.sh."
  echo ""
  echo "    If you need iprintf, install devkitPro natively and use"
  echo "    their libgba.a, OR use the mGBA debug interface at"
  echo "    0x4FFF780 / 0x4FFF700, OR write a tiny tile-text renderer"
  echo "    on top of libgba's VRAM helpers (~30 lines of C)."
  echo "─────────────────────────────────────────────────────────────────"
  echo ""
  # Move out of the source dir entirely — libgba's Makefile globs
  # data/*.* and src/*.c so a rename suffix like .excluded still gets
  # picked up. Stash under a sibling dir we control.
  mkdir -p "$SRC_DIR/libgba-excluded"
  [ -f "$CONSOLE_C" ] && mv "$CONSOLE_C" "$SRC_DIR/libgba-excluded/console.c"
  [ -f "$DATA_FNT" ]  && mv "$DATA_FNT"  "$SRC_DIR/libgba-excluded/amiga.fnt"
fi

GBA_RULES="$NATIVE_PREFIX/gba_rules"
if [ ! -f "$GBA_RULES" ]; then
  cat > "$GBA_RULES" <<'GBAR'
PREFIX  := arm-none-eabi-
export CC   := $(PREFIX)gcc
export CXX  := $(PREFIX)g++
export AS   := $(PREFIX)as
export AR   := $(PREFIX)ar
export LD   := $(PREFIX)gcc
export OBJCOPY := $(PREFIX)objcopy
export STRIP := $(PREFIX)strip
export NM   := $(PREFIX)nm
export RANLIB := $(PREFIX)ranlib
ARCH  := -mthumb -mthumb-interwork
%.o : %.c
	$(CC) -MMD -MP -MF $(DEPSDIR)/$*.d $(CFLAGS) -c $< -o $@
%.o : %.s
	$(CC) -MMD -MP -MF $(DEPSDIR)/$*.d -x assembler-with-cpp $(ASFLAGS) -c $< -o $@
%.o : %.S
	$(CC) -MMD -MP -MF $(DEPSDIR)/$*.d -x assembler-with-cpp $(ASFLAGS) -c $< -o $@
GBAR
  echo "Synthesized minimal gba_rules at $GBA_RULES"
fi

# Build. libgba's Makefile is straightforward — it iterates source
# files and emits libgba.a in lib/.
make -j"$NCPU"

# ── Stage artifacts into $OUT ──────────────────────────────────────
echo ""
echo "Staging libgba into $OUT"

# Archive
cp lib/libgba.a "$OUT/libgba.a"

# Headers
mkdir -p "$OUT/include"
cp -r include/* "$OUT/include/"

# crt0 + linker script — these live under the source tree, NOT
# under libgba. We need the canonical devkitARM crt0.s for GBA;
# devkitPro ships it separately in the gba-tools / gba-elf-binutils
# packages. For our purposes a minimal crt0 we write ourselves is
# the right scope.
# TODO: ship a hand-written gba_crt0.s + lnkscript in this script
# or in packages/romdev-platform-gba/share/gba/lib/libgba/ that matches libgba's
# expectations (calls __libc_init_array etc.).

# License
if [ -f LICENSE.md ]; then
  cp LICENSE.md "$OUT/LICENSE"
elif [ -f LICENSE ]; then
  cp LICENSE "$OUT/LICENSE"
elif [ -f COPYING ]; then
  cp COPYING "$OUT/LICENSE"
fi

echo ""
echo "libgba installed at $OUT"
ls -la "$OUT/"
echo ""
ls -la "$OUT/include/" | head -10
