# @romdev/platform-snes

SNES bundle: snes9x emulator core + asar / tcc816 / wla-dx assemblers, as WebAssembly.

A binary package for [romdev](https://github.com/monteslu/romdev) — it ships the
prebuilt WebAssembly + JS glue and is resolved by the main `romdev` package on
demand. You normally install `romdev`, not this package directly.

## Upstream & license

Bundles: **snes9x, asar, tcc816, wla-dx**.

**License:** snes9x: NON-COMMERCIAL (snes9x custom license) — free for non-commercial use; redistribution for profit is not permitted. asar: LGPL-3.0. tcc816: LGPL-2.1. wla-dx: GPL-2.0.

This package redistributes the upstream binary built to WebAssembly; the source
is fetched from a pinned upstream commit at build time (see the romdev repo's
`scripts/versions.json` and `BUILDING.md`). See the romdev repo `NOTICE` for the
full third-party inventory.
