# romdev-core-gpgx

Genesis Plus GX - Sega Genesis / Master System / Game Gear emulator core (libretro), as WebAssembly.

A binary package for [romdev](https://github.com/monteslu/romdev). It ships the
prebuilt WebAssembly and JS glue, and the main `romdevtools` package loads it on
demand. You normally install `romdevtools` (`npx romdevtools`), not this package
directly.

## Upstream and license

Bundles: **Genesis Plus GX**, https://github.com/libretro/genesis-plus-gx.

**License:** Genesis Plus GX license (non-commercial): free for non-commercial use; redistribution for profit is not permitted. See the upstream `LICENSE.txt`.

This package redistributes the upstream source built to WebAssembly. The
upstream version is pinned in `packages/romdevtools/scripts/versions.json` in the
romdev repo, and the repo's `NOTICE` has the full third-party inventory.

**Built by:** `packages/romdevtools/scripts/build-genesis-plus-gx.sh` with patch(es) `genesis-plus-gx-romdev-memory-regions.patch`. See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
