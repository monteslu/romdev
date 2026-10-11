# romdev-toolchain-sdcc

SDCC (`sdcc`, `sdasgb`, `sdasz80`, `sdld`, `mcpp`), the Z80 and SM83 C compiler,
plus its target share tree, as WebAssembly. The package also ships z80-elf GNU
binutils (`as`, `ld`, `objcopy`, `objdump`), which serve Z80 and SM83
disassembly for `disasm({target:'rom'})` and byte-exact
`disasm({target:'project'})`. One z80-elf build covers both `-m z80` and
`-m gbz80`.

A binary package for [romdev](https://github.com/monteslu/romdev). It ships the
prebuilt WebAssembly and JS glue, and the main `romdevtools` package loads it on
demand. You normally install `romdevtools` (`npx romdevtools`), not this package
directly.

## Upstream and license

Bundles: **SDCC 4.4.0** (https://sdcc.sourceforge.net) and **GNU binutils
2.42** (z80-elf target).

**License:** SDCC: GPL-2.0-or-later; its runtime libraries are GPL with a
linking exception, so linking them does not place conditions on a compiled
ROM. binutils: GPL-3.0-or-later.

This package redistributes the upstream source built to WebAssembly. The
upstream versions are pinned in `packages/romdevtools/scripts/versions.json` in
the romdev repo, and the repo's `NOTICE` has the full third-party inventory.

**Built by:** `packages/romdevtools/scripts/build-sdcc.sh` and
`build-z80-binutils-wasm.sh` (no patches). See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
