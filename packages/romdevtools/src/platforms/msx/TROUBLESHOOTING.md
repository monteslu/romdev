# MSX — troubleshooting (symptom → cause → fix)

> **A build failed? Read `issues[]` FIRST.** Every build/compile call returns
> `issues: [{file, line, col, severity, message, stage}]` — the structured error
> list. It almost always names the exact line to fix. Read that before matching a
> symptom below or touching your source. Fall back to the raw `log` only if
> `issues[]` is empty but `ok:false`.

Read this when something's broken. For the "how it works" overview, read
MENTAL_MODEL.md first.

## "No cartridge found" — but I SEE my text flash first

**THE most common MSX cart trap.** Your INIT routine returned. C-BIOS CALLs the
cart INIT to hand over the machine; if INIT `ret`s, the BIOS concludes there's no
bootable cart and prints "No cartridge found" — *after* running your code, so you
see your output for a moment, then the error replaces it.

**Fix:** a cartridge INIT must NEVER return. End `main()` in an infinite loop
(`for (;;) {}`). A real game does its input/update/draw in that loop. The
`hello_msx.c` starter does this.

## Black/border-only screen, only the C-BIOS logo

Two possibilities:
1. **You didn't step long enough.** C-BIOS shows its logo for ~2-3 s (≈150
   frames) BEFORE calling the cart INIT. Step >= 240 frames before judging.
2. **The cart wasn't recognized.** Check the first 4 bytes of your ROM are
   `41 42 xx xx` ("AB" + INIT pointer). If not, you're missing `msx_crt0.s` or
   didn't pass `crt0:'.module empty\n'`. romdev synthesizes a fallback header if
   the crt0 didn't, but the INIT must point at real code.

## Display is off (border color only) after INIT runs

The V9938 display-enable bit is clear. `background({view:'renderState'})` shows
`screenEnabled:false` → VDP R1 bit 6 is 0. Call **INITXT ($006C)** (or your
mode-set BIOS routine) which sets the screen mode AND enables display. Raw VDP
users: set R1 bit 6.

## Text prints garbage or nothing

- `INITXT` must run before `CHPUT` — it sets text mode and uploads the font.
- File-scope `__asm`/`__endasm` is a **SDCC syntax error** ("syntax error: token
  '__endasm'"). Put asm data (your message bytes + its label) INSIDE a function's
  asm block, jumped over with `jr`. See `hello_msx.c`.
- Don't rely on SDCC's stack-frame calling convention for a char-print helper;
  the robust pattern is one asm block that loads `hl` with the string address and
  loops `ld a,(hl) / call $00A2 / inc hl`.

## Colors wrong on an MSX2 bitmap screen

The V9938 palette is **9-bit GRB** packed as `red=(v>>4)&7, green=v&7,
blue=(v>>8)&7`, each ×255/7 — NOT RGB. `palette({source:'live'})` decodes it (it reports
`paletteSource: "v9938"` vs `"tms9918"`). On MSX1/TMS9918 modes the palette is
fixed hardware colors — you choose indices, not RGB.

## Sprites invisible

- `sprites({op:'inspect'})` shows the VRAM sprite-attribute table (base from R5/R11).
  A Y value of **208 ($D0)** terminates the list — sprites after it are off.
- MSX sprites have no flip bits; priority is by slot order (slot 0 = frontmost).
- Sprite size/magnify come from VDP R1 bits 0-1 (8×8 vs 16×16, ×1 vs ×2).

## Build fails intermittently on main.c

The build worker pool can transiently fail. Re-run the build. If it fails
consistently, read the `log` — SDCC's C89 parser errors are terse; common causes
are `//` comments, mid-block declarations, or file-scope inline asm (see above).


## PSG writes get eaten — sound code "runs" but the chip stays silent

The BIOS KEYINT interrupt fires every frame and reads PSG register 14 (the
joystick row) — and it CLOBBERS the PSGADDR latch. If an interrupt lands
between your `PSGADDR = n` and the matching `PSGWRITE`, your byte goes into
R14 instead of the register you selected. Symptom: the mixer looks right but
periods/volumes stay 0 — total silence even though your code clearly ran.

**Rule: wrap every PSGADDR/PSGWRITE sequence in `__asm__("di")` /
`__asm__("ei")`.** The bundled `msx_psg_tone`/`msx_psg_off` (and the music
ticker) already do this; copy the pattern for any direct PSG access you write.

## A `static x = 5;` boots as 0 (historical — fixed in the bundled crt0)

The old `msx_crt0.s` placed the SDCC `_INITIALIZER` area in RAM, so the boot
copy duplicated uninitialised RAM onto itself: every value-initialised static
read 0 and BSS was never zeroed. The bundled crt0 has been fixed (ROM-placed
`_INITIALIZER` + a BSS-zero loop). If a project scaffolded before 2026-06-09
shows ghost zeros, refresh its `msx_crt0.s` from a new scaffold.
