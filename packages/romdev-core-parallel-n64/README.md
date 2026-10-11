# romdev-core-parallel-n64

The [ParaLLEl-N64](https://github.com/libretro/parallel-n64) libretro core
(Nintendo 64), compiled to WebAssembly for
[romdev](https://github.com/monteslu/romdev).

The RDP is rendered on the GPU by **glide64**, ParaLLEl-N64's GL renderer: it
translates the game's RDP display lists to GLES/WebGL2 calls, and the host
reads each frame back. The core is loaded with `hwRender: true` and needs the
headless GL context that `romdev-core-host` provides through `native-gles`, the
same path as the PS1 (Beetle PSX HW) and Dreamcast (Flycast) cores. romdev
selects glide64 through a core option.

A binary package: the main `romdevtools` package loads it on demand for
`loadMedia({platform:'n64'})`. You normally install `romdevtools`
(`npx romdevtools`), not this package directly.

## Custom romdev build

Upstream core (pinned at commit `1da824e13e725a7144f3245324f43d59623974f8`)
plus these exports:

- `romdev_mips_regs_get`: the live R4300 register file (`cpu({op:'read'})`).
- romdev's shared live-debug set (`romdev_watchpoint_set`, `romdev_pcbreak_set`,
  `romdev_range_set`, the PC coverage log and bitmap, and the rest), hooked
  into the cached interpreter's instruction loop: `breakpoint`, `watch` and
  `frame({op:'stepInstructions'})` stop with the CPU at the hit PC.
- `romdev_ai_get`: the Audio Interface registers
  (`audioDebug({op:'inspect', chip:'ai'})`).

## Upstream and license

**License:** GPL-2.0-or-later (inherits ParaLLEl-N64's license).

**Built by:** `packages/romdevtools/scripts/build-parallel-n64.sh` (it appends
`scripts/patches/romdev-snippets/n64-regsnap.c` to the core and adds
`n64-debug.c` plus romdev's shared debug library to the R4300 sources). See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map. The `.wasm` is not in git; it ships to npm
through the package's `files` list.
