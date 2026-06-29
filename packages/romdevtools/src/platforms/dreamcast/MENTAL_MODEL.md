# Sega Dreamcast — mental model

The Dreamcast is a **3D machine**: a 200 MHz Hitachi SH-4 CPU (with an on-die FPU/
vector unit) + the PowerVR2 (CLX2) **tile-based deferred renderer** drawing into
8 MB VRAM, plus the AICA sound system (an ARM7 CPU + DSP). romdev runs it on
**Flycast** built to WASM, presenting through the **native-gles / WebGL2 hardware
GPU**, with the **reios HLE BIOS** so you don't ship a real `dc_boot.bin`.

## The one thing to know about rendering

Flycast is **GPU-first**: the PowerVR2 is a Tile Accelerator (TA) — homebrew normally
submits TA display lists (polygon/vertex lists) that the GPU rasterizes. romdev runs
Flycast `hwRender: true` (the real GPU via WebGL2). **BUT** the core is configured
with `flycast_emulate_framebuffer: enabled`, which gives a working **direct-framebuffer
scanout** path — a program that writes the DC framebuffer displays (verified: a
framebuffer-writing program captured ~727k pixels). So both routes work:

- **Direct framebuffer** (simplest for 2D / first pixels): write VRAM and let the
  emulated-framebuffer path scan it out. The starting point for "just show something."
- **TA / GPU** (the real path for 3D): submit PowerVR2 TA lists. The native SDK,
  **KallistiOS (KOS)**, wraps the TA and ships an OpenGL port — lean on KOS rather than
  hand-rolling the TA command encoding.

Decide which your homebrew uses; the bundled helper lib targets the framebuffer path
first (like a software front end) and grows toward TA.

## CPU / memory map (SH-4, 32-bit, little-endian)

| Region | Address | Notes |
|--------|---------|-------|
| System RAM | `0x8C00_0000`+ | 16 MB main RAM (KOS links code here) |
| VRAM | `0xA500_0000`+ | 8 MB texture/framebuffer RAM |
| Hardware regs | `0xA05F_xxxx` | PowerVR2 (TA/CORE), Holly, GD-ROM, AICA, Maple |
| AICA RAM | `0x00800000` (AICA bus) | ARM7 sound RAM |

Addresses are **little-endian**. SH-4 uses **PC-relative loads** for constants/
addresses (`mov.l @(disp,PC)`) heavily — relevant for RE base-address alignment.
`memory({op:'read', region:'system_ram'})` reads main RAM.

## Booting — KOS ELF + reios HLE (no disc needed for the dev loop)

A real Dreamcast boots from a GD-ROM with an `IP.BIN` bootstrap (a CDI/CHD disc image).
For homebrew, that's heavy. romdev uses Flycast's **reios HLE BIOS** (`flycast_hle_bios:
enabled`), and KallistiOS produces a ready-to-boot **ELF** — Flycast loads the raw KOS
ELF directly, so you skip the disc-image dance. (Build a disc image only if a specific
title demands it.) `build({platform:'dreamcast'})` produces the loadable image.

## Input

Homebrew reads controllers over the **Maple bus** (`0xA05F_6C00`+) — the DC's
peripheral protocol. KOS abstracts this (`maple_enum_*`, controller state). The host's
`setInput`/`run` holdInputs drive the emulated controller; the game polls Maple.

## Sound

The **AICA** = an ARM7 CPU + DSP with its own RAM. The SH-4 uploads a sound program +
samples to AICA RAM and triggers channels. KOS ships an AICA sound driver
(`snd_stream`). `audioChips` lists `aica`.

## MCP debug & inspection tooling — current state

- **`run` / `screenshot` / `frame({op:'verify'})`** — boots + presents + render-health.
  ✅ (reios HLE; the framebuffer path captures pixels.)
- **`memory({op:'read', region:'system_ram'})`** — SH-4 main RAM. ✅
- **`disasm` / `decompile`** — SH-4 via rizin (`sh`) + Ghidra (SuperH4 SLEIGH). ✅
  (Good decompile quality; SH-4 is a clean 32-bit RISC.)
- **`build`** — sh-elf-gcc → WASM toolchain. ✅
- **`cpu({op:'read'})` / `breakpoint` / `watch` / `audioDebug`** — these read core
  exports Flycast doesn't yet carry (need SH-4 register-struct + memory-path + AICA
  reads patched in). Currently **N/A** in the capability map — honest, not broken.
  (Tracked for a core rebuild.)
- **`renderingContext`** is **N/A** — 3D TA machine, no 2D tile VDP to decode.

## Build pipeline

`build({platform:'dreamcast'})` cross-compiles with an **sh-elf-gcc → WASM** toolchain
(adapted from KOS's `dc-chain`; SH-4 is single-endian little, so no be/el split). Link
against KallistiOS for libc + the TA/AICA/Maple drivers. `#include` the bundled
`dc.h` helper for the framebuffer front end + input/audio helpers.

## What's NOT bundled / hardware limits

- No GD-ROM/CDDA streaming or VMU save emulation in the dev loop.
- `cpuState`/`audioDebug` not yet exported by the core (see above).
- `renderingContext` is N/A (3D TA, no tile VDP).
