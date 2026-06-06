#!/usr/bin/env bash
# Build the z80-elf GNU binutils (as / ld / objcopy / objdump) as WASM.
#
# This one binutils target serves BOTH the plain Z80 (SMS / Game Gear / MSX) AND
# the Game Boy CPU (SM83 / LR35902) — select per-call with `-m z80` / `-m gbz80`
# (objdump) or `-march=z80` / `-march=gbz80` (as). These are the native tools the
# romdev disassembly stack uses end to end (replacing the deleted hand-rolled JS
# z80dasm / sm83dasm):
#   - objdump  → DISASSEMBLE z80 + gbz80 (full INSS_GBZ80 support in z80-dis.c)
#   - as       → REASSEMBLE z80 + gbz80 (byte-exact round-trip for disassembleProject)
#   - ld       → link (z80 only; gbz80 objects are "instruction-set incompatible"
#                with ld, so the gbz80 reassembly path uses as + `.org` + objcopy)
#   - objcopy  → ELF / object → raw binary
#
# Output → romdev-toolchain-sdcc/wasm/z80-elf-{as,ld,objcopy,objdump}.{mjs,wasm}
#
# Reuses the binutils-2.42 source tree the m68k/arm toolchain builds fetch.
# Requires: EMSDK sourced (emconfigure / emmake / emcc on PATH).
set -euo pipefail

: "${EMSDK:?source emsdk_env.sh first}"
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG_OUT="$HERE/../../romdev-toolchain-sdcc/wasm"
BUILD="${BUILD_DIR:-$HERE/../../../.z80build}"
# binutils-2.42 source (shared with the m68k/arm toolchain builds). Point this at
# the unpacked binutils-2.42 dir (e.g. .../m68k-toolchain/src/binutils-2.42).
SRC="${BINUTILS_SRC:?set BINUTILS_SRC to the binutils-2.42 source dir}"

mkdir -p "$BUILD"; cd "$BUILD"

if [ ! -f Makefile ]; then
  # EXACT recipe the m68k/arm binutils builds use — just the z80-elf target.
  # Build EVERYTHING (gas + ld + binutils); the earlier --disable-gas path is
  # what triggered the liblto_plugin / "instruction set" friction. Plain make.
  emconfigure "$SRC/configure" \
    --target=z80-elf \
    --host=wasm32-unknown-emscripten \
    --build="$(gcc -dumpmachine)" \
    --disable-nls --disable-werror --disable-multilib
fi

# libiberty/strsignal.c redefines psignal, which NEWER emscripten's signal.h now
# declares → "conflicting types for 'psignal'". Mark it present so libiberty
# skips its own definition. (config.h is created by the libiberty SUBDIR
# configure during make, not the top configure — so this must run AFTER at least
# one make pass has created it. Re-running the script applies it then resumes.)
patch_psignal() {
  if [ -f libiberty/config.h ] && ! grep -q '#define HAVE_PSIGNAL 1' libiberty/config.h; then
    echo '#define HAVE_PSIGNAL 1' >> libiberty/config.h
    echo '#define HAVE_DECL_PSIGNAL 1' >> libiberty/config.h
    echo "patched libiberty psignal"
  fi
}
patch_psignal
# First make pass may stop at the psignal error before config.h was patchable;
# patch then and resume.
if ! emmake make -j"$(nproc)" 2>/dev/null; then
  patch_psignal
  emmake make -j"$(nproc)"
fi

# Re-link each tool as a MODULARIZE / EXPORT_ES6 factory and stage it. The glue
# embeds ONE literal "<tool>.wasm" reference — rename it to the package basename
# so locateFile resolves next to the staged .mjs.
NCPU="$(nproc)"
wrap_tool() {
  local subdir="$1" target="$2" out_name="$3" export_name="$4"
  echo "  wrapping $subdir/$target → $out_name.{mjs,wasm}"
  ( cd "$subdir" && rm -f "$target" "$target.wasm" && \
    emmake make -j"$NCPU" "$target" \
      LDFLAGS="-O2 -g0 -s MODULARIZE=1 -s EXPORT_NAME=$export_name -s EXPORT_ES6=1 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=134217728 -s EXIT_RUNTIME=1 -s INVOKE_RUN=0 -s ENVIRONMENT=node -s EXPORTED_RUNTIME_METHODS=[\"callMain\",\"FS\"]" )
  sed "s/${target}\.wasm/${out_name}.wasm/g" "$subdir/$target" > "$PKG_OUT/$out_name.mjs"
  cp "$subdir/$target.wasm" "$PKG_OUT/$out_name.wasm"
}

wrap_tool gas      as-new   z80-elf-as      createZ80As
wrap_tool ld       ld-new   z80-elf-ld      createZ80Ld
wrap_tool binutils objcopy  z80-elf-objcopy createZ80Objcopy
wrap_tool binutils objdump  z80-elf-objdump createZ80Objdump

echo "Staged z80-elf-{as,ld,objcopy,objdump}.{mjs,wasm} → $PKG_OUT/"
