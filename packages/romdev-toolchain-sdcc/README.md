# romdev-toolchain-sdcc

SDCC (sdcc/sdasz80/sdasgb/sdld/mcpp) — Z80/SM83 C compiler, plus its target share tree, as WebAssembly.

A binary package for [romdev](https://github.com/monteslu/romdev) — it ships the
prebuilt WebAssembly + JS glue and is resolved by the main `romdev` package on
demand. You normally install `romdev`, not this package directly.

## Upstream & license

Bundles: **SDCC**.

**License:** GPL-2.0-or-later (runtime libraries: GPL with linking exception — does not encumber compiled ROMs).

This package redistributes the upstream binary built to WebAssembly; the source
is fetched from a pinned upstream commit at build time (see the romdev repo's
`scripts/versions.json` and `BUILDING.md`). See the romdev repo `NOTICE` for the
full third-party inventory.
