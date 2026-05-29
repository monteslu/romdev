# romdev-platform-atari2600

Atari 2600 bundle: stella2014 emulator core + dasm assembler, as WebAssembly.

A binary package for [romdev](https://github.com/monteslu/romdev) — it ships the
prebuilt WebAssembly + JS glue and is resolved by the main `romdev` package on
demand. You normally install `romdev`, not this package directly.

## Upstream & license

Bundles: **stella2014, dasm**.

**License:** GPL-2.0-or-later (stella2014 GPL-2.0, dasm GPL-2.0).

This package redistributes the upstream binary built to WebAssembly; the source
is fetched from a pinned upstream commit at build time (see the romdev repo's
`scripts/versions.json` and `BUILDING.md`). See the romdev repo `NOTICE` for the
full third-party inventory.
