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

The build differs from upstream in these ways, all in romdev's patches and
build script:

- libco gets a WebAssembly backend: bsnes runs every chip as a cothread, and
  the cothreads switch with binaryen's Asyncify inside the module;
- the libretro target serves memory regions with romdev's SNES region ids
  (system_ram, video_ram, save_ram, snes_oam, snes_cgram, snes_aram,
  snes_chipstate) and finds coprocessor firmware in the system directory;
- the reference defaults are deterministic and accurate: no entropy, the
  accurate PPU and DSP, no HLE preference;
- no Nintendo boot ROM or chip data: the SPC700 boot ROM is romdev's own
  clean-room one (MIT, `scripts/spc700-ipl/`), and the DSP-1 data ROM, the
  ST010 tables, the Cx4 data ROM and the Super Game Boy boot ROMs upstream
  embeds are emptied. A DSP-1, DSP-2, DSP-3, DSP-4, ST010 or ST011 cart needs
  the chip's firmware in the system directory (e.g. `dsp1b.rom`, `st010.rom`,
  the program ROM then the data ROM) and is refused with the file named
  without it (DSP-2 and DSP-4 fall back to bsnes's high-level emulation); a
  Cx4 cart runs bsnes's high-level emulation unless `cx4.data.rom` is there;
  the Super Game Boy needs `sgb_boot.bin` / `sgb2_boot.bin`.

License: GPL-3.0-only (bsnes; libco and nall are ISC). See NOTICE. Not intended for
standalone use; loaded by romdev's core registry. This core is a separate
reference: none of its code is compiled into romdev's snes9x core or into
recompiled carts (their firmware coprocessors come from ares, ISC).

No coprocessor firmware ships in this package: supply your own dumps, for
example with `loadMedia({platform:'snes', core:'bsnes', firmware})`, which copies the
file into the system directory before the ROM loads.

**Built by:** `packages/romdevtools/scripts/build-bsnes.sh` with
`bsnes-romdev.patch` and `bsnes-romdev-firmware.patch` (plus `patches/bsnes/` and `patches/libco-wasm/`). See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
