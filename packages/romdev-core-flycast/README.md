# romdev-core-flycast

The [Flycast](https://github.com/flyinghead/flycast) libretro core (Sega Dreamcast)
compiled to WebAssembly for romdev.

A custom romdev build: single-threaded (the SH-4/ARM/DSP interpreters, no JIT), with
worker-thread creation neutered, threaded rendering forced off, and the **reios HLE
BIOS** defaulted on — so a raw homebrew `.elf` boots directly with no GD-ROM image or
firmware. The PowerVR2 renders through WebGL2; `flycast_emulate_framebuffer` scans out a
direct 2D framebuffer so simple homebrew presents without authoring a PowerVR2 tile list.

Built reproducibly by `romdevtools/scripts/build-flycast.sh`.
