#!/usr/bin/env bash
# build-maxmod.sh — fetch maxmod source + assemble libmm.a for arm-none-eabi.
#
# Maxmod is the canonical GBA/DS music+sound library. The GBA build is
# 7 pure-assembly source files; no C compiler involvement, no
# devkitPro-specific dependencies. We use the same native arm-none-eabi
# toolchain that built libtonc + libgba.
#
# Output goes to packages/romdev-platform-gba/share/gba/lib/maxmod/:
#   libmm.a              the static library
#   include/maxmod.h     public C-callable API
#   include/mm_types.h   data types
#   include/mp_*.inc     internal includes used by maxmod-generated soundbanks
#
# To rebuild: ./scripts/build-maxmod.sh

# Shared helpers: PROJECT_DIR, BUILD_DIR, require_cmd, and fetch_pinned (reads
# scripts/versions.json — maxmod/mmutil are pinned under toolchains.*).
. "$(dirname "$0")/_lib.sh"
require_cmd gcc
require_cmd git

MAXMOD_BUILD="$BUILD_DIR/maxmod"
DEST_DIR="$PROJECT_DIR/../romdev-platform-gba/share/gba/lib/maxmod"
ARM_TOOLCHAIN="$BUILD_DIR/arm-toolchain/install"

mkdir -p "$MAXMOD_BUILD" "$DEST_DIR"

# Fetch source (pinned to exact commits in versions.json) --------------------
fetch_pinned toolchains.maxmod "$MAXMOD_BUILD/src"

# mmutil — host-side tool that converts .xm/.mod/.it/.s3m modules into the
# binary soundbank format that the runtime expects. Built as a regular
# Linux ELF for now (not WASM); future R-round could re-port if cross-
# platform-host support is needed.
if [ ! -d "$MAXMOD_BUILD/mmutil-src" ]; then
    fetch_pinned toolchains.mmutil "$MAXMOD_BUILD/mmutil-src"
    # mmutil pre-dates C99 stdbool — patch the local typedef to avoid
    # collision with modern compilers.
    sed -i 's|typedef unsigned char bool;|#include <stdbool.h>|' "$MAXMOD_BUILD/mmutil-src/source/deftypes.h"
fi
mkdir -p "$MAXMOD_BUILD/host"
if [ ! -x "$MAXMOD_BUILD/host/mmutil" ]; then
    (cd "$MAXMOD_BUILD/mmutil-src/source" && \
     gcc -O2 -DPACKAGE_VERSION='"1.10.1"' \
         -o "$MAXMOD_BUILD/host/mmutil" *.c -lm)
    echo "  HOST mmutil -> $MAXMOD_BUILD/host/mmutil"
fi

cd "$MAXMOD_BUILD/src"

# Find the toolchain binaries
AS="$ARM_TOOLCHAIN/bin/arm-none-eabi-as"
AR="$ARM_TOOLCHAIN/bin/arm-none-eabi-ar"
GCC="$ARM_TOOLCHAIN/bin/arm-none-eabi-gcc"
if [ ! -x "$GCC" ]; then
    echo "ERROR: $GCC not found. Run scripts/build-arm-toolchain.sh first." >&2
    exit 1
fi

# Assemble each .s file. Maxmod source uses C-preprocessor-style #include
# for its macro .inc files (devkitPro convention) — we have to drive
# the build through gcc-as (with -x assembler-with-cpp) so the
# preprocessor runs first.
OBJS=()
for src in source/mm_effect.s source/mm_main.s source/mm_mas.s source/mm_mas_arm.s \
           source_gba/mm_init_default.s source_gba/mm_main_gba.s source_gba/mm_mixer_gba.s; do
    obj="$MAXMOD_BUILD/$(basename "$src" .s).o"
    echo "  AS $src -> $obj"
    "$GCC" -x assembler-with-cpp -c \
           -mcpu=arm7tdmi -mthumb-interwork \
           -DSYS_GBA=1 \
           -I asm_include -I include \
           "$src" -o "$obj"
    OBJS+=("$obj")
done

# Pack into libmm.a
rm -f "$DEST_DIR/libmm.a"
"$AR" rcs "$DEST_DIR/libmm.a" "${OBJS[@]}"
echo "  AR $DEST_DIR/libmm.a"

# Copy headers + asm includes (consumers may need mp_*.inc when assembling
# their soundbank or custom mixer extension).
mkdir -p "$DEST_DIR/include"
cp include/maxmod.h include/mm_types.h "$DEST_DIR/include/"
mkdir -p "$DEST_DIR/asm_include"
cp asm_include/mp_*.inc asm_include/swi_gba.inc "$DEST_DIR/asm_include/" 2>/dev/null || true

# License
cp maxmod_license.txt "$DEST_DIR/LICENSE-MAXMOD"

# Summary
echo
echo "Built maxmod for GBA:"
ls -la "$DEST_DIR/libmm.a" "$DEST_DIR/include/" 2>&1
echo
echo "Bundle size:"
du -sh "$DEST_DIR"
