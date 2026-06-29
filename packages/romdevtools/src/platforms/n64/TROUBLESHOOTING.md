# Nintendo 64 — troubleshooting

Read `platform({op:'doc', platform:'n64', name:'mental_model'})` first — most N64
black-screen bugs are the rendering model (software RDP into UNCACHED RDRAM).

## "ROM builds + boots but the screen is BLACK"

The #1 N64 bug. Three causes, in order of likelihood:

1. **You wrote pixels to CACHED RDRAM.** The angrylion VI scanout reads RDRAM; cached
   (kseg0, `0x8000_0000`) writes sit in the CPU cache and never land. Write the
   framebuffer through the **uncached kseg1 alias** (`0xA000_0000 | addr`). The
   bundled `n64.c` framebuffer pointer is already uncached — use it, don't roll your
   own cached pointer.
2. **The VI registers are wrong.** angrylion blanks unless VI control (16bpp),
   h_start/v_start, x_scale/y_scale and origin are exactly right. Use the helper lib's
   `vi_init`; if hand-setting, copy the indices from the core's `vi_controller.h` (a
   wrong index — e.g. using the v_sync slot for what's actually LEAP — blanks it).
3. **You expected the HLE GL renderer to draw your framebuffer.** It won't — glide64/
   gln64/rice only translate RDP **display lists**. romdev's core is the software-RDP
   build (`hwRender:false`) precisely so raw framebuffers display. Confirm with
   `frame({op:'verify'})` (nearlyBlank) + check RDRAM has nonzero pixels via
   `memory({op:'read', region:'system_ram'})`.

## "frame({op:'verify'}) says nearlyBlank but RDRAM has pixels"

Pixels are in RAM but not scanned out → it's a VI/uncached issue (causes 1-2 above),
not a draw issue. The renderer is fine; the scanout config or cache is the problem.

## "Geometry is wrong / triangles inside-out / nothing where expected"

Software-3D pipeline math. Check: the framebuffer is 16.16 fixed-point throughout;
back-face culling winding order matches your vertex order; perspective divide before
viewport map. The helper lib's pipeline is correct — diff against its draw call order.

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
