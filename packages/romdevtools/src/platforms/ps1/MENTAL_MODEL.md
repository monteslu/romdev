# PlayStation (PS1) — mental model

The PS1 is a **3D machine**: a 33.87 MHz MIPS R3000A CPU + the GPU (2D/3D
rasterizer, drawing into 1 MB VRAM) + the GTE (Geometry Transformation Engine,
a CPU coprocessor for 3D math) + the SPU (24-voice ADPCM sound). romdev runs it on
**beetle_psx_hw** (Mednafen PSX) built to WASM, presenting through the
**native-gles / WebGL2 hardware GPU**.

## The one thing to know about rendering

PS1 homebrew draws by issuing **GPU primitives** (GP0 command packets) — not by
writing a raw CPU framebuffer. The core is `beetle_psx_hw`, the **hardware** renderer
(`hwRender: true`): it rasterizes the GPU command stream on the real GPU via
GLES3/WebGL2 (through romdev's native-gles bridge), exactly like a console. So the
bundled `psx.c` helper lib is a small **software-3D front end** (16.16 fixed-point
transform + project + cull + painter sort) whose **back end emits GP0 flat-poly
primitives** to the GPU — the GPU does the actual rasterization. (This differs from
N64, which software-rasterizes into RDRAM; PS1 hands triangles to the GPU.)

GP0 gotcha that cost real time: **`GP0 0x60` is a variable-size rectangle**, encoded
as 3 words (color, top-left corner, size) — NOT a 4-vertex polygon. Feeding it
polygon vertices stretches rects to the screen edge. Use the right command for the
primitive (triangles = `0x20`/`0x24`/`0x28`/`0x2C` family; rects = `0x60`). Read the
GP0 encoding carefully.

## CPU / memory map (R3000A, MIPS I, 32-bit, little-endian)

| Region | Address (KUSEG/KSEG) | Notes |
|--------|----------------------|-------|
| Main RAM | `0x8001_0000`+ (kseg0) / `0x0001_0000`+ | 2 MB. Programs load at `0x8001_0000`. |
| Scratchpad | `0x1F80_0000` | 1 KB fast on-chip RAM |
| Hardware I/O | `0x1F80_1000`+ | GPU (`…1810`), SPU (`…1C00`), SIO (`…1040`), DMA, timers |
| BIOS | `0xBFC0_0000` | HLE'd by default — you don't ship a BIOS |

Addresses are **little-endian**. `memory({op:'read', region:'system_ram'})` reads
main RAM.

## Booting — PS-EXE (no BIOS, no disc)

PS1 boots from a **2048-byte PS-EXE header** (magic `PS-X EXE`, with `pc0` / `t_addr`
/ `t_size` at fixed offsets). The HLE BIOS loads `t_size` bytes to `t_addr` and jumps
to `pc0`. romdev's `build`/`cart` wrap a valid PS-EXE around your code (`wrapPsExe`) —
no CD image, no real BIOS needed. (We never build discs; HLE + PS-EXE is enough for
homebrew.)

## Input

Homebrew reads the pad from **hardware** — the SIO handshake at `0x1F80_1040`
(transfer `0x01`, `0x42`, read the button halfword). The host's `setInput`/`run`
holdInputs drive the emulated pad; the game polls SIO. The helper lib has a
`pad_read()`.

## Sound

The SPU (24 ADPCM voices) at `0x1F80_1C00`. Samples are SPU-ADPCM in SPU RAM, keyed on
via the voice registers. The helper lib has a minimal tone path.

## MCP debug & inspection tooling — current state

- **`memory({op:'read', region:'system_ram'})`** — main RAM. ✅
- **`disasm` / `decompile`** — MIPS via rizin/Ghidra. ✅ (R3000A `jal` targets are
  absolute VAs — the analysis buffer is base-aligned so call-following works; see
  TROUBLESHOOTING if a fixed-VA image misbehaves.)
- **`frame({op:'verify'})` / screenshot** — render-health + capture. ✅
- **`cart` extract/wrap** — PS-EXE. ✅
- **`cpu({op:'read'})`** — live R3000A register file (`romdev_mips_regs_get`: r0..r31,
  LO, HI, PC). ✅
- **`audioDebug({op:'inspect', chip:'spu'})`** — the SPU register block at `0x1F80_1C00`
  (`romdev_spu_get`, the 1 KB window). ✅
- **`breakpoint` / `watch`** — not yet (those need interpreter-step + memory-path hooks
  patched into beetle; cpuState/audioDebug are plain reads and ARE wired).
- **`renderingContext`** is **N/A** (false) — 3D GPU machine, no 2D tile VDP to decode.

## Build pipeline

`build({platform:'ps1'})` cross-compiles with the from-scratch **mips-elf-gcc → WASM**
toolchain (little-endian libs; a small `softint.c` supplies 64-bit divide helpers on
the LE side), then `wrapPsExe` produces the bootable PS-EXE. `#include` the bundled
`psx.h` for the software-3D front end + GP0 emit + SIO/SPU helpers.

## What's NOT bundled / hardware limits

- No CD-ROM/XA/streaming or MDEC video.
- `breakpoint`/`watch` not yet (need interpreter-step hooks; cpuState/audioDebug ARE wired).
- `renderingContext` is N/A (3D GPU, no tile VDP).
