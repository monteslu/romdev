# romdev-core-parallel-n64

The [ParaLLEl-N64](https://github.com/libretro/parallel-n64) libretro core
(Nintendo 64) bundled as WASM for [romdev](https://github.com/monteslu/romdev),
built **headless-angrylion** (software).

## Why headless-angrylion

The default ParaLLEl-N64 build renders through glide64/GL, which only presents the
**RDP display-lists** a game issues — it does NOT scan out a raw CPU-written VI
framebuffer. romdev's N64 homebrew (the bundled software-3D lib) draws directly into
an RDRAM framebuffer, so it needs a renderer that honors the **Video Interface
scanout**. This build compiles GL **out**, stubs the inactive video-plugin tables,
and forces the **angrylion** software RDP — which presents the VI framebuffer via
`video_cb` (no GL). Loaded with `hwRender: false`.

## Custom romdev build

Upstream core plus:
- `romdev_mips_regs_get` — live R4300 register file (`cpu({op:'read'})`)
- the live-debug set (`romdev_watchpoint_set` / `romdev_pcbreak_set` /
  `romdev_range_set` / …) — `breakpoint` + `watch`
- `romdev_ai_get` — the Audio Interface registers (`getAudioState({chip:'ai'})`)
- a minimal clean-room **IPL3** wrapper so `build({platform:'n64'})` produces a
  self-booting `.z64` (PI-DMAs the game to RDRAM and jumps in).

Built reproducibly by `scripts/build-parallel-n64.sh` in the romdev repo.

The `.wasm` is gitignored and shipped to npm via the package's `files` allowlist.

License: GPL-2.0-or-later (inherits ParaLLEl-N64's license).
