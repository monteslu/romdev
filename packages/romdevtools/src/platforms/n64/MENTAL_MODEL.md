# Nintendo 64 — mental model

The N64 is a **3D machine**: a 93.75 MHz MIPS R4300i CPU + the RCP (Reality
Co-Processor = RSP vector unit + RDP rasterizer) drawing into RDRAM, scanned out
by the VI (Video Interface). romdev runs it on **parallel_n64** (libretro) built to
WASM, rendering through the **glide64 GL HLE plugin** on the real GPU via romdev's
native-gles / WebGL2 bridge (`hwRender: true`).

## The one thing to know about rendering

The N64 core renders through **glide64** — a GL HLE plugin that interprets the game's
**GBI display lists** and rasterizes them on the real GPU. So romdev N64 homebrew draws
by building a **GBI (F3DEX2) display list** each frame and kicking the RSP, the way a
real game does; glide64 HLEs it onto the GPU. A software framebuffer (poking pixels
into RDRAM) shows **black** on glide64 and would be <1fps — so don't do that.

**Use the bundled `n64.c` helper** — it does the GPU path for you: `n64_clear`/`n64_rect`
emit GPU **fill rectangles**, `n64_tri2d`/`n64_tri3d`/`n64_quad3d` scan-convert into
GPU fill-rect spans (still GPU-rasterized, not CPU pixels), and `n64_flip` ships the
display list as a GFX OSTask. `#include "n64.h"` and it just works (auto-bundled). How
it gets glide64 to accept the list without shipping Nintendo microcode: the RSP-HLE
treats an OSTask with `type==1` as graphics, and glide64 picks its command table by
CRC-summing the task's "ucode" region — so the helper embeds a 3072-byte blob that
*sums* to a real F3DEX2 CRC (the bytes are never executed under HLE).

If the screen is black, the usual cause is software-framebuffer drawing instead of the
helper's display-list path — see TROUBLESHOOTING. Confirm with `frame({op:'verify'})`.

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

## Reverse engineering and matching decompilation

`disasm({target:'decompile', platform:'n64', address, project})` resolves the
address through a registered splat project's segment map (a relocated code
segment or an overlay is NOT where the header's entry formula says), loads
that segment at its true VA and names the project's symbols; without
`project` it falls back to the boot-segment formula and says so in
`provenance.warning`. The full matching loop — the project's own IDO/GCC,
compile-and-compare with one aggregate verdict, permuter search, integrate
with full-ROM verify, live trace/coverage (real PC breaks since core 0.3.0)
— is `decomp({op})`: read `platform({op:'doc', platform:'n64', name:'decomp'})`.
