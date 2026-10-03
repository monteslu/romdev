# romdev-platform-snes

SNES bundle: snes9x emulator core + asar / tcc816 / wla-dx assemblers, as WebAssembly.

A binary package for [romdev](https://github.com/monteslu/romdev) - it ships the
prebuilt WebAssembly + JS glue and is resolved by the main `romdev` package on
demand. You normally install `romdev`, not this package directly.

## Upstream & license

Bundles: **snes9x, asar, tcc816, wla-dx**.

**License:** snes9x: NON-COMMERCIAL (snes9x custom license) - free for non-commercial use; redistribution for profit is not permitted. asar: LGPL-3.0. tcc816: LGPL-2.1. wla-dx: GPL-2.0.

**The snes9x core also links bsnes's ST011 / ST018 chip code** (bsnes's
uPD96050 and ARM cores and romdev's driver for them, `snes9x-bsnes-chips.patch`;
used only when st011.rom / st018.rom is in the system directory). That code is
**GPL-3.0** (bsnes). GPL-3.0 code linked into a program under snes9x's
non-commercial license is a licence conflict for redistribution (the GPL does
not allow the extra non-commercial restriction); this has to be resolved
before this build is published.

This package redistributes the upstream binary built to WebAssembly; the source
is fetched from a pinned upstream commit at build time (see the romdev repo's
`scripts/versions.json` and `BUILDING.md`). See the romdev repo `NOTICE` for the
full third-party inventory.

**Built by:** `romdevtools/scripts/build-snes9x.sh + build-asar.sh + build-tcc816.sh + build-wladx.sh` + patch(es) `snes9x-romdev-memory-regions.patch`, `snes9x-bsnes-chips.patch`. See `scripts/BUILD_MAP.md` in the romdev repo for the full recipe→package map.
