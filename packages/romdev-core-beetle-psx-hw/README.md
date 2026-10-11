# romdev-core-beetle-psx-hw

[Beetle PSX HW](https://github.com/libretro/beetle-psx-libretro) (Sony
PlayStation, a fork of mednafen's PSX emulator) compiled to WebAssembly for
[romdev](https://github.com/monteslu/romdev), with the GLES3/WebGL2 hardware
renderer, so the PS1 GPU renders on the real GPU through native-gles. That is
the same path as the N64 (ParaLLEl-N64 with glide64) and Dreamcast (Flycast)
cores.

It ships with OpenBIOS embedded (from
[PCSX-Redux](https://github.com/grumpycoders/pcsx-redux), MIT, region-free), so
there is no Sony BIOS to ship and no BIOS file to supply.

## Use

A binary package: the main `romdevtools` package loads it on demand for
`loadMedia({platform:'ps1'})`, with `hwRender: true` and the headless GL
context `romdev-core-host` provides. You normally install `romdevtools`
(`npx romdevtools`), not this package directly.

## License

GPL-2.0-or-later (Beetle PSX and mednafen). The embedded OpenBIOS is MIT.

**Built by:** `packages/romdevtools/scripts/build-beetle-psx-hw.sh`. See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
