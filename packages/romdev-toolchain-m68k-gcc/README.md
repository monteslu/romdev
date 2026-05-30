# romdev-toolchain-m68k-gcc

m68k-elf-gcc toolchain (cc1/as/ld/objcopy) for Sega Genesis C, as WebAssembly.

A binary package for [romdev](https://github.com/monteslu/romdev) — it ships the
prebuilt WebAssembly + JS glue and is resolved by the main `romdev` package on
demand. You normally install `romdev`, not this package directly.

## Upstream & license

Bundles: **m68k-elf-gcc, binutils**.

**License:** GPL-3.0-or-later with GCC Runtime Library Exception (does not encumber compiled ROMs).

This package redistributes the upstream binary built to WebAssembly; the source
is fetched from a pinned upstream commit at build time (see the romdev repo's
`scripts/versions.json` and `BUILDING.md`). See the romdev repo `NOTICE` for the
full third-party inventory.
