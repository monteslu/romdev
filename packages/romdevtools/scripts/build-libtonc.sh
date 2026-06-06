#!/usr/bin/env bash
# R28 STAGE 3-bis of the GBA C tier-1 pipeline: build libtonc against
# our stage-1 native arm-none-eabi toolchain, then ship the resulting
# libtonc.a + headers as TARGET BINARY ARTIFACTS under
# src/platforms/gba/lib/libtonc/.
#
# libtonc is the de-facto GBA C library aligned with the Tonc tutorial
# (https://gbadev.net/tonc/), which is THE GBA C corpus the LLM has
# been trained on. Picking libtonc means agent-generated code is
# already idiomatic — `tte_write`, `tonccpy`, `REG_DISPCNT`, etc.
# match what the tutorial teaches.
#
# Compared to libgba (R24):
#   - MIT license vs LGPL-w/-static-exception (simpler)
#   - TTE (Tonc Text Engine) provides iprintf-style stdio routing
#     through the tile system WITHOUT needing devkitPro libsysbase
#     (the libgba console.c blocker — R27 deferred work).
#   - Bundles tonccpy/toncset (VRAM-safe 16/32-bit memcpy/memset),
#     a quality-of-life win every libgba project re-implements.
#
# Pinned to devkitPro/libtonc v1.4.5 (Aug 2020 last release — stable,
# feature-complete). The gbadev-org/libtonc fork has more recent
# commits (2026-04 CI tweaks) but no tagged releases; we go with the
# devkitPro tag for reproducibility. If we hit a bug only fixed in
# the gbadev-org fork we'll switch.
#
# Prereq: stage 1 (build-arm-toolchain.sh) must have completed.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"

NATIVE_PREFIX="$BUILD_DIR/arm-toolchain/install"
TARGET=arm-none-eabi
SRC_DIR="$BUILD_DIR/arm-toolchain/src"
OUT="$PROJECT_DIR/src/platforms/gba/lib/libtonc"
NCPU="$(nproc)"

if [ ! -x "$NATIVE_PREFIX/bin/$TARGET-gcc" ]; then
  echo "Stage 1 not done — run build-arm-toolchain.sh first." >&2
  exit 1
fi

export PATH="$NATIVE_PREFIX/bin:$PATH"

LIBTONC_VER=1.4.5
LIBTONC_URL="https://github.com/devkitPro/libtonc/archive/refs/tags/v${LIBTONC_VER}.tar.gz"

mkdir -p "$SRC_DIR" "$OUT"
cd "$SRC_DIR"

if [ ! -d "libtonc-$LIBTONC_VER" ]; then
  if [ ! -f "libtonc-$LIBTONC_VER.tar.gz" ]; then
    wget -q "$LIBTONC_URL" -O "libtonc-$LIBTONC_VER.tar.gz"
  fi
  tar xf "libtonc-$LIBTONC_VER.tar.gz"
fi

cd "libtonc-$LIBTONC_VER"

# ─────────────────────────────────────────────────────────────────────
# Exclude tte_iohook.c — it's the OPTIONAL libsysbase bridge that
# routes `iprintf`/`printf` through TTE. Depends on devkitPro's
# extended <sys/iosupport.h> with `_COND_T` thread-cond types that
# vanilla newlib doesn't have.
#
# The REST of TTE (tte_init_se, tte_init_chr4c, tte_write, etc.)
# does NOT depend on iohook — `tte_write("hello")` works perfectly
# without iprintf. We lose `iprintf("score: %d", x)` → tile-text
# auto-routing; we keep the canonical TTE API and the explicit
# `tte_printf` path (which doesn't go through libsysbase).
#
# Per the R27 + R28 plan: the canonical Tonc tutorial code uses
# `tte_write` and `tte_printf` directly, not iprintf — so this
# exclusion has a much smaller user impact than the libgba console.c
# exclusion did.
#
# Pragmatic note for the future: if we DO port libsysbase (R27),
# tte_iohook.c becomes trivially reinstatable.
TTE_IOHOOK=src/tte/tte_iohook.c
if [ -f "$TTE_IOHOOK" ]; then
  mkdir -p ../libtonc-excluded
  mv "$TTE_IOHOOK" ../libtonc-excluded/tte_iohook.c
  echo ""
  echo "─────────────────────────────────────────────────────────────────"
  echo "⚠️  EXCLUDING libtonc's tte_iohook.c"
  echo ""
  echo "    iprintf auto-routing to TTE will NOT WORK with this libtonc.a."
  echo "    The Tonc tutorial uses tte_write / tte_printf directly, which"
  echo "    work fine. iprintf going through libsysbase is the part missing."
  echo ""
  echo "    Workaround: use tte_write(\"...\") / tte_printf(\"score: %d\", x)"
  echo "    instead of iprintf. They produce identical results without"
  echo "    needing the libsysbase header chain."
  echo "─────────────────────────────────────────────────────────────────"
  echo ""
fi

# libtonc's Makefile expects DEVKITARM + DEVKITPRO env vars.
export DEVKITPRO="$NATIVE_PREFIX"
export DEVKITARM="$NATIVE_PREFIX"

# Same gba_rules synthesis as the libgba build. If build-libgba.sh
# already ran, the file is there; otherwise create it.
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
fi

# Build. libtonc's Makefile produces libtonc.a in lib/ alongside
# tonc.h headers in include/.
make -j"$NCPU"

# ── Stage artifacts ────────────────────────────────────────────────
echo ""
echo "Staging libtonc into $OUT"

# Archive
cp lib/libtonc.a "$OUT/libtonc.a"

# Headers
mkdir -p "$OUT/include"
cp -r include/. "$OUT/include/"

# License
if   [ -f license.txt ]; then cp license.txt "$OUT/LICENSE"
elif [ -f LICENSE.md ];  then cp LICENSE.md  "$OUT/LICENSE"
elif [ -f LICENSE ];     then cp LICENSE     "$OUT/LICENSE"
elif [ -f COPYING ];     then cp COPYING     "$OUT/LICENSE"
fi

# Reuse the libgba crt0 + linker script + crt*.o objects since
# they're devkitARM-canonical and library-agnostic — both libgba and
# libtonc plug into the same startup. If libgba isn't built yet,
# symlink would break; we duplicate-copy from libgba/'s already-staged
# files when present.
LIBGBA_DIR="$PROJECT_DIR/src/platforms/gba/lib/libgba"
for f in gba_crt0.s gba_cart.ld crti.o crtn.o crtbegin.o crtend.o; do
  if [ -f "$LIBGBA_DIR/$f" ]; then
    cp "$LIBGBA_DIR/$f" "$OUT/$f"
  fi
done

echo ""
echo "libtonc installed at $OUT"
ls -la "$OUT/"
echo ""
echo "Headers count: $(find $OUT/include -type f -name '*.h' | wc -l)"
