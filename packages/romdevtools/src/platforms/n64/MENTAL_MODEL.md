# Nintendo 64 — mental model

The N64 is a **3D machine**: a 93.75 MHz MIPS R4300i CPU + the RCP (Reality
Co-Processor = RSP vector unit + RDP rasterizer) drawing into RDRAM, scanned out
by the VI (Video Interface). romdev runs it on **parallel_n64** (libretro) built to
WASM, and homebrew renders with a bundled **software-3D engine** (not the RDP) —
see "Rendering" for why.

## The one thing to know about rendering

The N64 core runs the **angrylion software RDP** with GL compiled OUT, loaded
`hwRender: false`. angrylion does a faithful **VI scanout** — it presents whatever
the CPU wrote into the RDRAM framebuffer. So rombdev N64 homebrew **software-
rasterizes** triangles straight into an RDRAM framebuffer; it does NOT issue RDP
display lists. (The HLE GL renderers — glide64/gln64/rice — only translate a game's
RDP display lists to OpenGL; they show a BLACK screen for raw-framebuffer homebrew,
which is why we don't use them.) The bundled `n64.c` helper lib is the software
engine; use it.

Two render gotchas that cause a black screen:
- **The framebuffer must be UNCACHED.** Write pixels via the kseg1 alias
  (`0xA0000000 | addr`), not cached kseg0 — cached writes sit in the CPU cache and
  never reach RDRAM where the VI reads them.
- **The VI registers must be EXACTLY right** (control = 16bpp, h/v start, x/y scale,
  origin). One wrong register index blanks the screen. The helper lib sets them; if
  you set them by hand, get the map from the core's `vi_controller.h`.

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
`n64.h` for the software-3D engine + framebuffer/VI/pad/audio helpers.

## What's NOT bundled / hardware limits

- No RDP/RSP microcode display-list path (we software-render — see top).
- No real-hardware Expansion Pak detection beyond the standard 4/8 MB split.
- `renderingContext` is N/A (3D framebuffer, no tile VDP).
