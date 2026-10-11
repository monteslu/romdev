# romdev-platform-atari2600

Atari 2600 bundle: stella2014 emulator core + dasm assembler, as WebAssembly.

A binary package for [romdev](https://github.com/monteslu/romdev). It ships the
prebuilt WebAssembly and JS glue, and the main `romdevtools` package loads it on
demand. You normally install `romdevtools` (`npx romdevtools`), not this package
directly.

## Upstream and license

Bundles: **stella2014** (https://github.com/libretro/stella2014-libretro) and **dasm** (https://github.com/dasm-assembler/dasm).

**License:** GPL-2.0-or-later (stella2014 GPL-2.0, dasm GPL-2.0).

This package redistributes the upstream source built to WebAssembly. The
upstream version is pinned in `packages/romdevtools/scripts/versions.json` in the
romdev repo, and the repo's `NOTICE` has the full third-party inventory.

**Built by:** `packages/romdevtools/scripts/build-stella2014.sh` and `build-dasm.sh` with patch(es) `stella2014-romdev-memory-regions.patch`. See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
