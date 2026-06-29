# Nintendo 64 — mental model

The N64 is a **3D machine**: a 93.75 MHz MIPS R4300i CPU + the RCP (Reality
Co-Processor = RSP vector unit + RDP rasterizer) drawing into RDRAM, scanned out
by the VI (Video Interface). romdev runs it on **parallel_n64** (libretro) built to
WASM, rendering through the **glide64 GL HLE plugin** on the real GPU via romdev's
native-gles / WebGL2 bridge (`hwRender: true`).

## The one thing to know about rendering

The N64 core renders through **glide64** — a GL HLE plugin that interprets the game's
**RDP display lists** and translates them to OpenGL on the real GPU. So romdev N64
homebrew draws by building **RDP display lists** (the standard N64 path), the way a
real game does; glide64 rasterizes them. (parallel_n64 *defaults* to a software gfx
plugin that never presents to our GL surface — the host config forces `glide64` so
frames reach the screen.) The bundled `n64.c` helper lib builds the display lists +
VI setup; use it.

If the screen is black, the usual cause is that **no valid RDP display list was
submitted** (or the VI wasn't initialized) — see TROUBLESHOOTING. Confirm with
`frame({op:'verify'})` (nearlyBlank).

> Historical note: an earlier bring-up used the **angrylion software RDP** (`hwRender:
> false`, software-rasterize into UNCACHED RDRAM + a hand-set VI scanout). The shipping
> core is the glide64 GL path above; if you're on a custom angrylion build, the cached-
> RDRAM / VI-register gotchas in TROUBLESHOOTING still apply.

## CPU / memory map (R4300i, MIPS III, 64-bit, big-endian)

| Region | KSEG | Address (virtual) | Notes |
|--------|------|-------------------|-------|
| RDRAM (cached)   | kseg0 | `0x8000_0000`+ | main RAM, 4 MB (8 MB with Expansion Pak) |
| RDRAM (uncached) | kseg1 | `0xA000_0000`+ | same RAM, bypasses cache — use for the framebuffer |
| Cart / PIF / RCP MMIO | kseg1 | `0xA300_0000`+ | SP/DP/VI/AI/PI/SI registers |

Addresses are **big-endian**. `memory({op:'read', region:'system_ram'})` reads RDRAM.

## Booting — header + IPL3

A flat code image is not a bootable ROM. parallel_n64 HLEs the PIF boot: it copies
ROM `0x40..0xFFF` into RSP DMEM and **executes it as the IPL3**. romdev's
`build`/`cart` wrap a valid 64-byte header (magic `0x8037_1240`) + a minimal
clean-room IPL3 (PI-DMA the game cart→RDRAM, jump to entry) + the game image. You
don't write the header/IPL3 — the toolchain does (`wrapN64Rom`).

## Input

Homebrew reads controllers from **hardware** (the PIF/JoyBus), not via injection. The
host's `setInput`/`run` holdInputs drive the emulated pad; the game polls JoyBus and
sees them. The helper lib exposes a `pad_read()`.

## Sound

The AI (Audio Interface) DMAs a sample buffer from RDRAM to the DAC. `audioDebug`
decodes the AI register block (`romdev_ai_get`). The helper lib has a minimal audio
push path.

## MCP debug & inspection tooling

N64 is at **full parity** with the tile systems wherever the hardware allows:

- **`cpu({op:'read'})`** — live R4300i register file (`romdev_mips_regs_get`).
- **`breakpoint` / `watch`** — PC breakpoints + memory watchpoints, hooked into the
  interpreter step + memory R/W paths.
- **`audioDebug({op:'inspect'})`** — AI registers.
- **`memory({op:'read', region:'system_ram'})`** — RDRAM.
- **`disasm` / `decompile`** — MIPS via rizin/Ghidra (R4300 is well-supported).
- **`frame({op:'verify'})`** — render-health (nearlyBlank guard) for no-vision agents.
- **`renderingContext`** is **N/A** (false) — that decodes 2D tile/sprite VDP state,
  which a 3D framebuffer machine doesn't have. Not a missing feature.

## Build pipeline

`build({platform:'n64'})` cross-compiles with a from-scratch **mips-elf-gcc → WASM**
toolchain (cc1 → as → ld → objcopy orchestrated from JS, like the m68k path), big-
endian libs, then `wrapN64Rom` produces the bootable image. `#include` the bundled
`n64.h` for the 3D helpers (display-list build + VI setup + pad/audio).

## What's NOT bundled / hardware limits

- No custom RSP microcode path (glide64 HLEs the standard F3DEX-style display lists).
- No real-hardware Expansion Pak detection beyond the standard 4/8 MB split.
- `renderingContext` is N/A (3D, no tile VDP).
