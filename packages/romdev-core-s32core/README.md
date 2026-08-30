# romdev-core-s32core

The **sync32** console core for [romdev](https://github.com/monteslu/romdev),
bundled as WASM.

sync32 is monteslu's RP2350 console: games are Cortex-M33 ARM binaries shipped
as `.s32` files. `s32core` is a first-party pure-C interpreter for it, exposed
through the libretro API — the same shape as every other romdev core, so the
host runs it with no special-casing.

Built with **NODERAWFS**: the frontend `fopen()`s the `.s32` by its real path
and streams the game's `<romname>/` data directory straight off the host
filesystem, rather than preloading it into MEMFS. A cart with resources
therefore reads them from disk exactly as it does on hardware.

## Debugger views

The core exposes its state through libretro's memory interface, so a frontend
can inspect a running game — this is aimed at **developing** a cart, since
sync32 has no commercial ROMs to reverse-engineer:

| id | region | what it is |
|---|---|---|
| `SYSTEM_RAM` | `system_ram` | the 520KB SRAM at `0x20000000` — a game's globals, its stack, and in ram mode its code |
| `0x1A0` | `sync32_cpu_regs` | r0-r15, the packed APSR, s0-s31, ITSTATE |
| `0x1A1` | `sync32_palette` | 256 entries, RGB565 |
| `0x1A2` | `sync32_canvas` | the 320x240 8-bit indexed framebuffer |
| `0x1B0+n` | `sync32_sheet0`… | loaded sprite sheet *n*, 8-bit indices |

SAVE_RAM is deliberately **not** mapped: a frontend persists that to disk, and
dumping live stack into a `.srm` would be both wrong and useless — sync32 saves
go through the console's own save slots.

These hand out pointers to live state rather than copies, so nothing is paid per
frame. The CPU block is the one exception — a snapshot refreshed on demand,
because the interpreter keeps each APSR flag as its own word (faster in the hot
loop) and packing them belongs on the debugger's side, not the emulator's.

This package ships built artifacts only. The core's source lives in its own
repository, and romdev's `scripts/build-s32core.sh` compiles it here.

## Use

```js
import { core, platform } from "romdev-core-s32core";
// → { name: "s32core", jsPath: "…/s32core_libretro.js", wasmPath: "…/…wasm" }
```

Normally you do not import this directly — romdev's core registry resolves it
by platform id (`sync32`).
