# romdev-core-flycast

The [Flycast](https://github.com/flyinghead/flycast) libretro core (Sega Dreamcast)
compiled to WebAssembly for romdev.

A custom romdev build: single-threaded, with worker-thread creation neutered, threaded
rendering forced off, and the **reios HLE BIOS** defaulted on — so a raw homebrew `.elf`
boots directly with no GD-ROM image or firmware. The PowerVR2 renders through WebGL2;
`flycast_emulate_framebuffer` scans out a direct 2D framebuffer so simple homebrew
presents without authoring a PowerVR2 tile list.

The SH-4 runs on a **WASM recompiler** (`core/rec-wasm`): each SH-4 basic block is
emitted as a WebAssembly module at runtime and dispatched via `call_indirect`. That is
roughly a 4-5x speedup over the interpreter this package shipped through 0.2.0, which
put heavy commercial titles well under playable. The AICA sound system (ARM7 + DSP)
is still interpreted — measured at under ~12% of frame time, so it is not currently
the bottleneck.

Built reproducibly by `romdevtools/scripts/build-flycast.sh` — the recompiler is the
script's default, so a plain run reproduces this package's wasm byte-for-byte. Set
`ROMDEV_FLYCAST_INTERP=1` to build the SH-4 interpreter instead.
