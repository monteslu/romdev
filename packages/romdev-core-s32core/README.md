# romdev-core-s32core

The **sync32** console core for [romdev](https://github.com/monteslu/romdev),
bundled as WebAssembly.

sync32 is an open RP2350-based console: games are Cortex-M33 ARM binaries
shipped as `.s32` files. `s32core` is a pure-C interpreter for it, exposed
through the libretro API, the same shape as every other romdev core, so the
host runs it with no special cases.

It is built with **NODERAWFS**: the frontend `fopen()`s the `.s32` by its real
path and streams the game's `<romname>/` data directory from the host
filesystem rather than preloading it into memory, so a cart reads its
resources from disk the way it does on hardware.

## Debugger views

The core exposes its state through libretro's memory interface, so a frontend
can inspect a running game while you develop a cart:

| id | region | what it is |
|---|---|---|
| `SYSTEM_RAM` | `system_ram` | the 520KB SRAM at `0x20000000`: a game's globals, its stack, and in RAM mode its code |
| `0x1A0` | `sync32_cpu_regs` | r0-r15, the packed APSR, s0-s31, ITSTATE |
| `0x1A1` | `sync32_palette` | 256 entries, RGB565 |
| `0x1A2` | `sync32_canvas` | the 8-bit indexed framebuffer: 320x240, 320x180, or 128x128 in the 128x128 video mode |
| `0x1A3` | `sync32_timing` | frame timing (u32 LE): the ABI cycle budget per frame, frames presented, the last frame's work cycles, and a ring of per-frame work cycles |
| `0x1A4` | `sync32_profile` | a PC-sampling profiler (u32 LE, writable control block): enable, base address, shift and bucket count, then CPU cycles per bucket; vblank idle time is excluded |
| `0x1B0+n` | `sync32_sheet0`... | loaded sprite sheet *n*, 8-bit indices |

The video mode comes from the cart header: mode 0 is 320x240 (4:3), mode 1 is
320x180 (16:9 letterbox), and mode 2 is 128x128, shown at 3x for 128x128
fantasy-console games.

SAVE_RAM is not mapped: a frontend persists that region to disk, and sync32
saves go through the console's own save slots instead.

These regions hand out pointers to live state rather than copies, so nothing is
paid per frame. The CPU block is the exception: a snapshot refreshed on demand,
because the interpreter keeps each APSR flag in its own word and the packing
happens on the debugger's side.

## Use

```js
import { core, platform } from "romdev-core-s32core";
// core = { name: "s32core", jsPath: ".../s32core_libretro.js", wasmPath: ".../s32core_libretro.wasm" }
```

Normally you do not import this directly: romdevtools' core registry resolves
it for `loadMedia({platform:'sync32'})`. You normally install `romdevtools`
(`npx romdevtools`).

## License

MIT. This package ships built artifacts only. The core's source lives in its
own repository, and `packages/romdevtools/scripts/build-s32core.sh` in the
romdev repo compiles it from a local checkout (`S32CORE_SRC`).
