Atari 2600 starter snippets
===========================

Hand-vetted boilerplate for the dasm assembler (the standard 2600 toolchain).
All snippets target the `processor 6502` directive and assume the cart is
4 KB anchored at `$F000` (the most common arrangement; the 2600's "cart"
mapping puts the file's last 4 KB at $F000-$FFFF and mirrors $1000-$1FFF
on the address bus).

For larger banked carts (8K F8, 16K F6, 32K F4) the same code can live in
each bank, but each bank must end with the same vector table at $FFFA-$FFFF
since only the currently-banked-in region's vectors are visible.

COPY-PASTE templates, not linkable modules
-------------------------------------------

dasm builds a single flat 4 KB ROM. These snippets are meant to be
**inlined** into your own source — copy the routines/tables you want
into your `main.asm`. They do NOT carry `org` directives (except
`kernel_skeleton.asm`, which IS the top-level ROM layout and owns
`org $F000` + `org $FFFA`). If you `include` two snippets that each
had their own `org`, dasm errors with "Origin Reverse-indexed"
because their fixed addresses overlap your main code. So: treat
each snippet's labelled routines + data tables as code you paste
into place, not files you link together.

Files
-----

- **vcs_constants.h** — TIA + RIOT register names + bit masks. `include` at top.
- **kernel_skeleton.asm** — vsync + vblank + 192 visible scanline + overscan
  template. THIS is your ROM's spine: it owns `org $F000` + `org $FFFA`.
  Drop new logic into the `; --- per-frame logic here ---` slot.
- **player_kernel.asm** — single-player ("p0") rendered against a solid
  background. Shows the minimal GRP0 / WSYNC pattern + a real
  `POS_OBJ_P0` horizontal-positioning macro (SBC-15 technique).
- **playfield_kernel.asm** — asymmetric playfield drawn from a per-line
  byte table — the foundation for level/map-style displays.
- **score_kernel.asm** — 1-2 digit score band via PF1 in SCORE mode
  (tens digit on the left half in P0 color, ones on the right in P1
  color). Ships digit shapes 0-9 + SCORE_PREP (pointer build) +
  SCORE_KERNEL_BAND (single-PF1-write composite render).
- **read_joystick.asm** — read joystick 0 from SWCHA (RIOT $280) into a
  zp byte. Top-of-file comment documents the "re-load A between bit
  checks" pattern (the classic "left works, right doesn't" bug).
- **vectors.asm** — the 6-byte tail at $FFFA. Reset goes to your `START`
  label; NMI/IRQ are usually unused on the 2600 (BRK can fire IRQ).

Toolchain
---------

Build via `buildSource({ platform: "atari2600", source: "..." })`. Server
spawns `dasm` (bundled WASM) and emits a `.bin` ready for `loadRomFromPath`.

Foot-guns
---------

1. **TIA register names overlap with RIOT.** `$00-$2C` is TIA; `$280-$297`
   is RIOT (port I/O + timer). Don't write `$80` and expect SWCHA — use
   the long form `STA SWCHA` (or `STA $280`).
2. **WSYNC is a write-only signal**, not a delay loop. `STA WSYNC` blocks
   the CPU until the next horizontal blank — exactly one scanline.
3. **No frame buffer.** The TIA renders the screen line-by-line by reading
   register state as the beam moves. Set a register late in a scanline →
   it affects that line, not the next. This is "racing the beam."
4. **Vectors mirror inside the bank.** $FFFC == $1FFC == $3FFC etc. Always
   reference the absolute address.
