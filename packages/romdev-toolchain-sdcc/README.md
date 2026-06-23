# romdev-toolchain-sdcc

SDCC (sdcc/sdasz80/sdasgb/sdld/mcpp) — Z80/SM83 C compiler, plus its target share
tree, as WebAssembly. Also ships the native **z80-elf binutils**
(as/ld/objcopy/objdump) that power Z80 + SM83 `disassembleRom` and byte-exact
`disassembleProject` — one z80-elf serves both `-m z80` and `-m gbz80`.

A binary package for [romdev](https://github.com/monteslu/romdev) — it ships the
prebuilt WebAssembly + JS glue and is resolved by the main `romdev` package on
demand. You normally install `romdev`, not this package directly.

## Upstream & license

Bundles: **SDCC**, **GNU binutils** (z80-elf target).

**License:** SDCC: GPL-2.0-or-later (runtime libraries: GPL with linking exception — does not encumber compiled ROMs). binutils: GPL-3.0.

This package redistributes the upstream binary built to WebAssembly; the source
is fetched from a pinned upstream commit at build time (see the romdev repo's
`scripts/versions.json` and `BUILDING.md`). See the romdev repo `NOTICE` for the
full third-party inventory.

**Built by:** `romdevtools/scripts/build-sdcc.sh + build-z80-binutils-wasm.sh` (no patch — built clean). See `scripts/BUILD_MAP.md` in the romdev repo for the full recipe→package map.
