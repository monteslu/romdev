# Nintendo 64 — troubleshooting

Read `platform({op:'doc', platform:'n64', name:'mental_model'})` first — the shipping
N64 renders through the **glide64 GL HLE plugin** (it rasterizes GBI display lists on
the real GPU), not a software framebuffer.

## "ROM builds + boots but the screen is BLACK"

The #1 N64 bug — almost always **software-framebuffer drawing instead of the GPU path**:

1. **You poked pixels into an RDRAM framebuffer yourself.** glide64 only presents GBI
   **display lists** — it never scans out a CPU-written framebuffer. A software
   rasterizer renders black here (and would be <1fps anyway). **Use the bundled `n64.c`
   helper** (`n64_clear`/`n64_rect`/`n64_tri*`/`n64_quad3d` + `n64_flip`): it emits a
   GBI display list glide64 HLEs onto the GPU. `#include "n64.h"` (auto-bundled).
2. **You hand-built a display list with the wrong OSTask.** The RSP-HLE only routes a
   task to glide64 when the OSTask `type` (DMEM 0xFC0) == 1, and glide64 only accepts
   it if the task's ucode region CRC-matches a known ucode. The helper sets both (a
   3072-byte blob summing to an F3DEX2 CRC); if you roll your own, match that.
3. **You forgot `n64_flip()`** — the display list isn't submitted to the RSP until
   flip kicks the task. Confirm with `frame({op:'verify'})` (nearlyBlank).

## "frame({op:'verify'}) says nearlyBlank"

No GBI list reached glide64 — it's a display-list / OSTask problem (causes 1-2), not a
toolchain problem. The build is fine; the render path is the issue. The helper handles
all of this — diff your code against it.

## "Geometry is wrong / triangles inside-out / nothing where expected"

3D pipeline math (the helper transforms + projects to screen space, then scan-converts
triangles into GPU fill-rect spans). Check: 16.16 fixed-point throughout, back-face
winding matches your vertex order, perspective divide before the viewport map, and the
vertices land on-screen. Diff against the helper's draw order.

## "Build fails: 'relocation truncated to fit'"

Statics landed in `.sdata`/`.sbss` and the 16-bit GP-relative relocs overflowed. The
toolchain passes `-G0` to **both** cc1 and the assembler to force everything into
`.data`/`.bss`. If you're building outside `build()` with custom flags, add `-G0`
everywhere.

## "cpu({op:'read'}) / breakpoint / watch returns nothing"

These read core exports (`romdev_mips_regs_get`, `romdev_*break/watch`). On N64 they
ARE present (full parity). If they're missing, you're on a stale core — re-resolve via
`platform({op:'resolve', platform:'n64'})` and confirm the bundled core, don't debug
the tool.

## "disasm/decompile of a multi-function program returns junk addresses"

The MIPS RE works, but for absolute-addressed `jal` targets the analysis buffer's flat
offsets must line up with the VAs' low bits (rizin ignores `-B` on a raw buffer). N64
usually lands fine from codeStart=0x1000 post-IPL3; if a fixed-VA image misbehaves, see
the PS1 troubleshooting note on the rebase trick — same principle.

## "renderingContext returns N/A"

Correct — N64 is a 3D framebuffer machine with no 2D tile/sprite VDP for that op to
decode. Not a bug. Use `frame`/screenshot + `memory` to inspect the framebuffer.
