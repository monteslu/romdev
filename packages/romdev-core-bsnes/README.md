# romdev-core-bsnes

The [bsnes](https://github.com/libretro/bsnes) SNES libretro core, compiled to
WebAssembly for [romdev](https://github.com/monteslu/romdev).

romdev's default SNES core is snes9x. bsnes is here as the accuracy reference
for the SNES coprocessors that run firmware, which snes9x only approximates:
the ST010/ST011 (a NEC uPD96050) and the ST018 (an ARM). bsnes runs their
firmware; put `st011.rom` / `st018.rom` (the program ROM followed by the data
ROM, as the chips are dumped) in the core's system directory. romdev loads it
with `loadMedia({platform:'snes', core:'bsnes'})` or as the reference of
`frame({op:'verifyRecompile', referenceCore:'bsnes'})`.

The build differs from upstream in three ways, all in romdev's patch:

- libco gets a WebAssembly backend: bsnes runs every chip as a cothread, and
  the cothreads switch with binaryen's Asyncify inside the module;
- the libretro target serves memory regions with romdev's SNES region ids
  (system_ram, video_ram, save_ram, snes_oam, snes_cgram, snes_aram,
  snes_chipstate) and finds coprocessor firmware in the system directory;
- the reference defaults are deterministic and accurate: no entropy, the
  accurate PPU and DSP, no HLE preference.

License: GPL-3.0 (bsnes; libco and nall are ISC). See NOTICE. Not intended for
standalone use; loaded by romdev's core registry. This core is a separate
reference: none of its code is compiled into romdev's snes9x core or into
recompiled carts (their firmware coprocessors come from ares, ISC).

**Built by:** `romdevtools/scripts/build-bsnes.sh` + `bsnes-romdev.patch` (and
`patches/bsnes/`). See `scripts/BUILD_MAP.md` in the romdev repo for the full
recipe to package map.
