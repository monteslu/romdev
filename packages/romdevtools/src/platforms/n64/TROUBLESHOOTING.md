# Nintendo 64 — troubleshooting

Read `platform({op:'doc', platform:'n64', name:'mental_model'})` first — the shipping
N64 renders through the **glide64 GL HLE plugin** (it rasterizes RDP display lists on
the real GPU), not a software framebuffer.

## "ROM builds + boots but the screen is BLACK"

The #1 N64 bug. Causes, in order of likelihood (glide64 GL path):

1. **No valid RDP display list was submitted.** glide64 only draws what it sees in the
   display list — if the game never builds + runs one (DPC start/end set, the list
   ends with a pipeline-sync + full-sync), nothing reaches GL. Use the bundled `n64.c`
   display-list helpers; confirm with `frame({op:'verify'})` (nearlyBlank).
2. **The VI / video mode wasn't initialized.** Even with a display list, the VI needs
   its control (bpp), h/v start, x/y scale and origin set so there's a scanout target.
   The helper lib's `vi_init` does this.
3. **A combine/texture/blend mode glide64 can't HLE.** Unusual RDP combiner setups can
   render nothing under HLE. Stick to the common combine modes the helper lib uses.

> If you're on a custom **angrylion software-RDP** build instead (`hwRender:false`), the
> classic gotchas apply: write the framebuffer through the **uncached kseg1 alias**
> (`0xA000_0000 | addr`) — cached kseg0 writes never reach RDRAM where the VI scans out
> — and get the VI register indices exactly right (from the core's `vi_controller.h`).

## "frame({op:'verify'}) says nearlyBlank"

No geometry reached the GPU (cause 1-2) — it's a display-list / VI-init problem, not a
toolchain problem. The build is fine; the render setup is the issue.

## "Geometry is wrong / triangles inside-out / nothing where expected"

3D pipeline math (the helper lib transforms before building the display list). Check:
16.16 fixed-point throughout, back-face winding matches your vertex order, perspective
divide before the viewport map, and the vertices land in the on-screen range. Diff
against the helper lib's draw order.

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
