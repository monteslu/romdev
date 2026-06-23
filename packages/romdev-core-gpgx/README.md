# romdev-core-gpgx

Genesis Plus GX — Sega Genesis / Master System / Game Gear emulator core (libretro), as WebAssembly.

A binary package for [romdev](https://github.com/monteslu/romdev) — it ships the
prebuilt WebAssembly + JS glue and is resolved by the main `romdev` package on
demand. You normally install `romdev`, not this package directly.

## Upstream & license

Bundles: **Genesis Plus GX**.

**License:** NON-COMMERCIAL (Genesis Plus GX custom license) — free for non-commercial use; redistribution for profit is not permitted.

This package redistributes the upstream binary built to WebAssembly; the source
is fetched from a pinned upstream commit at build time (see the romdev repo's
`scripts/versions.json` and `BUILDING.md`). See the romdev repo `NOTICE` for the
full third-party inventory.

**Built by:** `romdevtools/scripts/build-genesis-plus-gx.sh` + patch(es) `genesis-plus-gx-romdev-memory-regions.patch`. See `scripts/BUILD_MAP.md` in the romdev repo for the full recipe→package map.
