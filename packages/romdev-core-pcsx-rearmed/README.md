# romdev-core-pcsx-rearmed

The [PCSX-ReARMed](https://github.com/libretro/pcsx_rearmed) libretro core
(Sony PlayStation) bundled as WASM for [romdev](https://github.com/monteslu/romdev).

- **Software renderer + built-in HLE BIOS** — no firmware file to ship, no GL
  dependency. The clean no-dependency PS1 path (like the HLE cores for the other
  platforms).
- **Custom romdev build.** This is the upstream core plus romdev's debug exports:
  - `romdev_mips_regs_get` — live R3000 register file (`cpu({op:'read'})`)
  - the live-debug set (`romdev_watchpoint_set` / `romdev_pcbreak_set` /
    `romdev_range_set` / …) — `breakpoint` + `watch`
  - `romdev_spu_get` — the SPU register block (`getAudioState({chip:'spu'})`)
  - `romdev_pad_get` — polled controller state
  - `romdev_vram_get` — the GPU VRAM (1024×512×16bpp) for `memory({region:'video_ram'})`

Built reproducibly by `scripts/build-pcsx-rearmed.sh` in the romdev repo (which
applies the romdev instrumentation patches to the upstream source before building).

The `.wasm` is gitignored and shipped to npm via the package's `files` allowlist.

License: GPL-3.0-or-later (inherits pcsx_rearmed's license).
