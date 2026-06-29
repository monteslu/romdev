# PlayStation (PS1) — troubleshooting

Read `platform({op:'doc', platform:'ps1', name:'mental_model'})` first — PS1 renders
by issuing **GPU primitives (GP0)** on the hardware renderer, not by writing a CPU
framebuffer.

## "ROM builds + boots but the screen is BLACK"

1. **You're trying to write a raw framebuffer.** PS1's renderer is the hardware GPU
   (`beetle_psx_hw`, `hwRender:true`) — it rasterizes the **GP0 command stream**, not
   a CPU-written framebuffer. Draw with GPU primitives (the bundled `psx.c` emits
   them); a CPU memset of "VRAM" won't show.
2. **You never set the display area / drawing environment.** GP1 sets the display
   mode + display start; GP0 `0xE1..0xE6` set the drawing area/offset. Without a valid
   draw env + display env the GPU has nowhere to put pixels. The helper lib's
   `gpu_init` does this — call it before drawing.
3. **Nothing was actually submitted to GP0.** Confirm with `frame({op:'verify'})`
   (nearlyBlank) + check you're writing the GP0 port (`0x1F80_1810`) / running a DMA
   to it, not just touching VRAM.

## "Rectangles stretch to the edge of the screen / primitives are garbage"

`GP0 0x60` (and the rect family) is a **variable-size rectangle**: 3 words = color,
top-left corner, size. If you feed it 4 polygon vertices it reads corner+size+garbage
and stretches. Use the **triangle** family (`0x20`/`0x24`/`0x28`/`0x2C`) for polys and
the **rect** family (`0x60`/`0x64`/`0x68`/`0x6C`) for rects. Match the command to the
primitive and word count.

## "Geometry is wrong / inside-out / clipped"

Software-3D front-end math (the helper lib transforms before emitting GP0): check
16.16 fixed-point throughout, back-face winding matches your vertex order, perspective
divide before the GP0 vertex coords, and coords fit the 11-bit signed GPU range.

## "disasm/decompile of a multi-function program returns junk (fcn.00000000)"

Known rizin trap: for **absolute-addressed `jal`** (PS1 `jal 0x80010518`), rizin
ignores `-B` on a raw `malloc://` buffer and addresses flat from 0, so cross-function
discovery dangles outside the image. romdev fixes this by left-padding `.text` so the
flat offset == the VA's low 20 bits, seeding analysis there, and rebasing the high bits
back — so reported addresses are real VAs. If you see a lone `fcn.00000000`, you're on
a path that bypassed the rebase; build a **multi-function** program to exercise it (a
single-instruction smoke test hides this).

## "breakpoint / watch return N/A"

`cpu({op:'read'})` and `audioDebug({op:'inspect', chip:'spu'})` ARE wired on PS1 (the
core exports `romdev_mips_regs_get` + `romdev_spu_get`). `breakpoint`/`watch` are not
yet — those need interpreter-step + memory-path hooks patched into beetle (cpuState/
audioDebug are plain reads). Use `cpu`/`audioDebug` + `memory` + `disasm`/`decompile`
meanwhile.

## "renderingContext returns N/A"

Correct — PS1 is a 3D GPU machine with no 2D tile/sprite VDP for that op. Not a bug.
