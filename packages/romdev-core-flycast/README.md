# romdev-core-flycast

The [Flycast](https://github.com/flyinghead/flycast) libretro core (Sega
Dreamcast) compiled to WebAssembly for [romdev](https://github.com/monteslu/romdev).

A custom romdev build: single-threaded, with worker-thread creation disabled,
threaded rendering forced off, and the reios HLE BIOS on by default, so a raw
homebrew `.elf` boots directly with no GD-ROM image or firmware. The PowerVR2
renders through WebGL2; `flycast_emulate_framebuffer` scans out a direct 2D
framebuffer so simple homebrew can present without building a PowerVR2 tile
list.

The SH-4 runs on a WebAssembly recompiler (`core/rec-wasm`): each SH-4 basic
block is emitted as a WebAssembly module at run time and dispatched through
`call_indirect`, roughly 4 to 5 times faster than the interpreter earlier
versions shipped. The AICA sound system (ARM7 and DSP) is still interpreted.

## Use

A binary package: the main `romdevtools` package loads it on demand for
`loadMedia({platform:'dreamcast'})`, with `hwRender: true` and the headless GL
context `romdev-core-host` provides. The core is built with NODERAWFS, so disc
images are read from disk as needed rather than loaded into memory. You
normally install `romdevtools` (`npx romdevtools`), not this package directly.

## License

GPL-2.0-or-later (Flycast).

**Built by:** `packages/romdevtools/scripts/build-flycast.sh`, which adds the
recompiler sources from `scripts/patches/flycast-wasm-jit/`. The recompiler is
the script's default, so a plain run reproduces this package's wasm; set
`ROMDEV_FLYCAST_INTERP=1` to build the SH-4 interpreter instead. See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
