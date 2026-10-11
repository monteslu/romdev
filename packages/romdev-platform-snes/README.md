# romdev-platform-snes

SNES bundle, as WebAssembly: the snes9x emulator core, the asar assembler, the
tcc816 C compiler and the wla-dx assembler and linker (wla-65816, wlalink).

A binary package for [romdev](https://github.com/monteslu/romdev). It ships the
prebuilt WebAssembly and JS glue, and the main `romdevtools` package loads it on
demand. You normally install `romdevtools` (`npx romdevtools`), not this package
directly.

## Upstream and license

Bundles: **snes9x** (https://github.com/libretro/snes9x), **asar**
(https://github.com/RPGHacker/asar), **tcc816** (https://github.com/alekmaul/tcc)
and **wla-dx** (https://github.com/vhelin/wla-dx).

**License:** snes9x: the snes9x license (non-commercial): free for
non-commercial use; redistribution for profit is not permitted. asar: LGPL-3.0.
tcc816: LGPL-2.1. wla-dx: GPL-2.0.

The snes9x core also links ares's ST011 / ST018 chip code (ares's
uPD96050 and ARM cores and romdev's driver for them, `snes9x-ares-chips.patch`;
used only when st011.rom / st018.rom is in the system directory). That code is
ISC (ares: Copyright (c) 2004-2025 ares team, Near et al), a permissive
license that only asks for its notice to be kept; the notice is in the romdev
repo `NOTICE`. It adds no condition to snes9x's own license.

**The snes9x core carries no Nintendo boot ROM or chip data.** Its SPC700 boot
ROM (the 64-byte IPL) is romdev's own, a clean-room reimplementation of the
upload protocol (MIT, `scripts/spc700-ipl/` in romdevtools), in place of the
one upstream embeds. The DSP-1, DSP-3 and ST010 data ROM tables upstream
embeds are emptied at build time; a cart with one of those chips needs the
user's copy of the chip's data ROM in the system directory (`dsp1b.data.rom`,
2048 bytes, the DSP-1B's, which snes9x uses for every DSP-1 cart, or
`dsp1b.rom`, 8192; `dsp3.data.rom` or `dsp3.rom`; `st010.data.rom`, 4096
bytes, or `st010.rom`) and is refused with the file named without it
(`loadMedia({firmware})` copies a file there).

This package redistributes the upstream source built to WebAssembly. The
upstream versions are pinned in `packages/romdevtools/scripts/versions.json` in the
romdev repo, and the repo's `NOTICE` has the full third-party inventory.

**Built by:** `packages/romdevtools/scripts/build-snes9x.sh`, `build-asar.sh`, `build-tcc816.sh` and `build-wladx.sh`,
with patches `snes9x-romdev-memory-regions.patch` and `snes9x-ares-chips.patch`,
`snes9x-romdev-hle-data.patch` (ares is fetched by `fetch-ares.sh` and patched with `ares-romdev.patch`). See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
