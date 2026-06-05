#!/usr/bin/env bash
# Build the z80 binutils objdump as WASM — the native DISASSEMBLER for both
# the plain Z80 (SMS / Game Gear / MSX) AND the Game Boy CPU (SM83 / LR35902).
#
# ONE binary covers both: binutils' z80 disassembler (opcodes/z80-dis.c) has
# full `INSS_GBZ80` support, selectable per-call with `objdump -m gbz80`. This
# replaces the hand-rolled JS z80dasm / sm83dasm (which had a (ix+d)/(iy+d)
# displacement-display bug and assorted edge cases).
#
# Output → romdev-toolchain-sdcc/wasm/z80-elf-objdump.{mjs,wasm}
#
# Reuses the binutils-2.42 source tree the m68k/arm builds already fetch.
# Requires: EMSDK sourced (emconfigure / emmake / emcc on PATH).
set -euo pipefail

: "${EMSDK:?source emsdk_env.sh first}"
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG_OUT="$HERE/../../romdev-toolchain-sdcc/wasm"
BUILD="${BUILD_DIR:-$HERE/../../../.z80build}"
# binutils-2.42 source (shared with the m68k/arm toolchain builds).
SRC="${BINUTILS_SRC:?set BINUTILS_SRC to the binutils-2.42 source dir}"

mkdir -p "$BUILD"; cd "$BUILD"

if [ ! -f Makefile ]; then
  # Only the binutils programs are needed (objdump); skip gas/ld/gdb/gprof.
  emconfigure "$SRC/configure" \
    --target=z80-elf \
    --host=wasm32-unknown-emscripten \
    --build="$(gcc -dumpmachine)" \
    --disable-nls --disable-werror --disable-multilib \
    --disable-gdb --disable-gprof --disable-ld --disable-gas
fi

# libiberty/strsignal.c redefines psignal, which newer emscripten's signal.h
# now declares → "conflicting types for 'psignal'". Mark it present so libiberty
# skips its own definition. (Older emscripten didn't declare it, so the m68k/arm
# builds predate this.)
if [ -f libiberty/config.h ] && ! grep -q '#define HAVE_PSIGNAL 1' libiberty/config.h; then
  echo '#define HAVE_PSIGNAL 1' >> libiberty/config.h
  echo '#define HAVE_DECL_PSIGNAL 1' >> libiberty/config.h
fi

emmake make -j"$(nproc)" all-binutils

# Re-link objdump as a MODULARIZE/ES6 factory (our standard wrap).
cd binutils
rm -f objdump objdump.wasm
emmake make objdump \
  LDFLAGS="-O2 -g0 -s MODULARIZE=1 -s EXPORT_NAME=createZ80Objdump -s EXPORT_ES6=1 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=134217728 -s EXIT_RUNTIME=1 -s INVOKE_RUN=0 -s ENVIRONMENT=node -s EXPORTED_RUNTIME_METHODS=[\"callMain\",\"FS\"]"

# Stage: rename the single embedded "objdump.wasm" reference to the pkg basename.
sed 's/objdump\.wasm/z80-elf-objdump.wasm/g' objdump > "$PKG_OUT/z80-elf-objdump.mjs"
cp objdump.wasm "$PKG_OUT/z80-elf-objdump.wasm"
echo "Staged z80-elf-objdump.{mjs,wasm} → $PKG_OUT/"
