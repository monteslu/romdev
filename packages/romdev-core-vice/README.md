# romdev-core-vice

VICE (x64) - Commodore 64 emulator core (libretro), as WebAssembly.

A binary package for [romdev](https://github.com/monteslu/romdev). It ships the
prebuilt WebAssembly and JS glue, and the main `romdevtools` package loads it on
demand. You normally install `romdevtools` (`npx romdevtools`), not this package
directly.

## C64 ROMs: free replacements, bundled

This core is built **without** `USE_EMBEDDED`, so it carries none of Commodore's
KERNAL, BASIC or CHARGEN ROMs. Upstream vice-libretro embeds them; VICE's own
README marks them "Copyright C by Commodore Business Machines", and the GPL
covers VICE's code rather than those ROMs.

Instead this package ships **[MEGA65 Open ROMs](https://github.com/MEGA65/open-roms)**
in `roms/` - a clean-room, dual GPL-3.0/LGPL-3.0 KERNAL+BASIC+CHARGEN written so
emulators can ship a working C64. The host installs them automatically, so the
C64 boots with no setup.

The files are named after Commodore's part numbers (`kernal-901227-03.bin` and
friends) because VICE resolves ROM images by those exact names. The contents are
Open ROMs; see `roms/README.md`.

### Using your own ROMs

Open ROMs is a reimplementation, not a bit-exact clone - upstream's BASIC is
notably incomplete. If you own the originals, point `ROMDEV_C64_ROM_DIR` at a
directory containing `kernal-901227-03.bin`, `basic-901226-01.bin` and
`chargen-901225-01.bin`; that overrides the bundled set.

## Upstream and license

Bundles: **VICE** (x64), https://github.com/libretro/vice-libretro.

**License:** GPL-2.0-or-later

This package redistributes the upstream source built to WebAssembly. The
upstream version is pinned in `packages/romdevtools/scripts/versions.json` in the
romdev repo, and the repo's `NOTICE` has the full third-party inventory.

**Built by:** `packages/romdevtools/scripts/build-vice.sh` with patches
`vice-romdev-memory-regions.patch` and `vice-no-embedded-roms.patch` (undefines
`USE_EMBEDDED`, so no Commodore ROM is compiled in). See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
