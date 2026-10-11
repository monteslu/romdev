# romdev-core-gametank

The GameTank libretro core (GameTank: Clyde Shaffer's open-source 8-bit
console, a WDC 65C02 main CPU with a second 65C02 driving audio), compiled to
WebAssembly.

A binary package for [romdev](https://github.com/monteslu/romdev). It ships the
prebuilt WebAssembly and JS glue, and the main `romdevtools` package loads it on
demand for `loadMedia({platform:'gametank'})`. You normally install
`romdevtools` (`npx romdevtools`), not this package directly.

## Upstream and license

Bundles: **gametank-libretro** (https://github.com/monteslu/gametank-libretro),
a libretro wrapper around the hardware-emulation units of Clyde Shaffer's
[GameTankEmulator](https://github.com/clydeshaffer/GameTankEmulator) (CPU,
blitter, audio coprocessor, bus).

**License:** MIT (gametank-libretro and GameTankEmulator, Copyright (c) 2020
Clyde Shaffer; the vendored mos6502 CPU core is MIT, Copyright (c) 2017
Gianluca Ghettini).

romdev's build adds its shared live-debug instrumentation (write and read
watchpoints, PC breakpoints, register get/set, coverage) through a small shim
appended to the core's `libretro.cpp`. This core is built from a local checkout
of gametank-libretro; it has no pinned commit in
`packages/romdevtools/scripts/versions.json`.

**Built by:** `packages/romdevtools/scripts/build-gametank.sh` (shim:
`scripts/patches/romdev-snippets/gametank-debug.cpp`). Set `GAMETANK_SRC` to
the gametank-libretro checkout. See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
