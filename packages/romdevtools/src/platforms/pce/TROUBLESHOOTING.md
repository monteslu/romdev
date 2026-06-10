# PC Engine — troubleshooting (symptom → cause → fix)

> **A build failed? Read `issues[]` FIRST.** Every build/compile call returns
> `issues: [{file, line, col, severity, message, stage}]` — the structured error
> list. It almost always names the exact line to fix. Read that before matching a
> symptom below or touching your source. Fall back to the raw `log` only if
> `issues[]` is empty but `ok:false`.

Read this when something's broken. For the "how it works" overview, read
MENTAL_MODEL.md first.

## Black screen + "Range error in module 'pce/crt0.s'" at link

**THE most common PCE trap.** cc65's crt0 clears `.bss` with a block-copy sized
`__BSS_SIZE__ - 1`. With NO globals/statics, `__BSS_SIZE__` is 0 → the `- 1`
underflows → ld65 throws the range error AND the ROM boots to a black screen
(the VDC never initializes, even if you call conio).

**Fix:** add at least one global/static variable so `.bss` is non-empty. A
1-byte `.bss` uploads only a partial conio font on some builds; use **2+ bytes**
to be safe. The `hello_pce.c` starter keeps a `static unsigned char _keep_bss[4];`
for exactly this reason — don't delete it until you have real globals.

## Black screen, no link error

The HuC6270 VDC's display is OFF. Call `background({view:'renderState'})`:
- `bgEnable:false, spEnable:false` → VDC register R5 (CR) bits 7/6 are clear.
  If you're using conio, `clrscr()` should enable it — make sure you called it
  and that the program didn't crash before reaching it (check `cpu({op:'read'}).pc`).
- Using raw VDC writes? Set R5 bit 7 (BG) and/or bit 6 (SPR) and load a BAT +
  tiles into VRAM first.

## Text/tiles show but colors are wrong

The HuC6260 VCE palette is **9-bit GRB** (`0bGGG_RRR_BBB`), NOT RGB and NOT the
Genesis BGR layout. Each channel is 3 bits (0-7). `palette({source:'live'})` decodes it
correctly — compare its `hex` values against what you wrote. Remember slot 0 of
each 16-color sub-palette is transparent.

## Sprites invisible

- `sprites({op:'inspect'})` shows `visible:false` for all → they're parked off-screen
  (Y = -64 means the SATB entry is zeroed; the VDC's Y is stored +64).
- Sprites present but not drawn → VDC R5 bit 6 (SPR enable) is clear, or the
  SATB hasn't been DMA'd from VRAM (the VDC copies it from the address in R19).
- Wrong pattern → the SATB pattern field is in **16×16 cells**; `pattern << 6`
  is the VRAM word address.

## Program builds but PC is stuck / garbage

`cpu({op:'read'})` shows the HuC6280 PC. If it's spinning in a tight range you're
probably in your intended idle loop. If it's in ROM vector territory unexpectedly,
you likely hit a BRK or an unhandled IRQ — check that you didn't enable a VDC IRQ
(R5 bits 2-3) without an ISR.

## conio prints nothing

`clrscr()` must run before `cputs()` (it inits the font + VDC). Also confirm
`.bss` is non-empty (see the first entry) — a broken crt0 means conio's font
upload never happened.


## PSG tone plays but is nearly inaudible

The 5-bit channel volume (`PSG_CHAN_CTRL` low bits, 0-31) is roughly an
ATTENUATOR: each step below 31 costs ~1.5 dB. A "middle" value like 13 is
about -27 dB — effectively silence on real hardware and most cores. Use
**29-31 for SFX/music** and treat anything under ~20 as a deliberate whisper.
(The bundled `psg_tone` scaffold helper and the music ticker default loud.)
