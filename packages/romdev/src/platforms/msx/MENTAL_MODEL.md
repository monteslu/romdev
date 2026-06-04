# MSX / MSX2 — mental model

One page. Read once before you write your first MSX game. The TROUBLESHOOTING.md
alongside this file is for when something's broken; this is the "what's going on"
version.

## CPU — Z80 (16-bit address space, paged in 16 KB slots)

```
$0000-$3FFF   slot 0 — BIOS ROM (C-BIOS): BDOS-ish entry points, the font, INITXT etc.
$4000-$BFFF   slot 1 — YOUR CARTRIDGE (32 KB) maps here
$C000-$FFFF   slot 3 — work RAM
```

The MSX uses a slot/subslot memory system; a 32 KB cartridge maps at
**$4000-$BFFF**. You don't manage slots for a simple ROM — the BIOS pages your
cart in and CALLs it.

The Z80 has a separate **I/O port** space (`in`/`out`). The VDP, PSG, and PPI
(keyboard/joystick) are reached via ports, but for most things you call **BIOS
routines** in slot 0 instead of touching ports directly.

## The cartridge boot handshake (critical)

A cart ROM begins with a 16-byte header at $4000:
```
$4000  "AB"           cartridge magic (0x41 0x42)
$4002  INIT  pointer  the BIOS CALLs this to start your program
$4004  STATEMENT      BASIC hook (0 = none)
$4006  DEVICE         (0 = none)
$4008  TEXT           (0 = none)
$400A..$400F          reserved (0)
```
On boot the BIOS scans slots, finds "AB", and **CALLs INIT**. Two rules:
1. **INIT must NOT return.** If it `ret`s, the BIOS decides no bootable cart is
   present and prints "No cartridge found" (after running your code, so you'll
   *see* your output flash, then the error). End `main()` in an infinite loop.
2. **C-BIOS shows its logo for ~2-3 s (≈150 frames) BEFORE calling INIT.** Step
   at least 240 frames before expecting output on screen.

romdev's `msx_crt0.s` starter emits this header and handles the handoff; build
your `main.c` together with it (`crt0:'.module empty\n'`).

## Video — V9938 VDP (TMS9918 superset on MSX2)

VRAM up to 128 KB. The VDP has 64 registers (`msx_vdp_regs`) + 16 status
registers (`msx_vdp_status`):
- **R1 bit 6** is the master display enable. If clear, you see only the border
  color. `getRenderingContext()` reads this.
- Screen mode is selected by M1-M5 bits across R0/R1. Text (screen 0/1), tiled
  (screen 2), and MSX2 bitmap (screen 4+) modes have different VRAM table layouts;
  `getRenderingContext()` decodes the mode and the pattern/color/sprite table base
  addresses for you.
- **Palette:** on MSX2 bitmap modes, 16 programmable entries (`msx_palette`),
  each a **9-bit GRB** value. On MSX1/TMS9918 modes the palette is a fixed
  16-color hardware set. `inspectPalette()` picks the right source automatically.
- **Sprites:** up to 32, defined in a VRAM sprite-attribute table (base from R5/
  R11). Y=208 ($D0) terminates the list. `inspectSprites()` reads it.

## Frame heartbeat

The VDP raises a VBlank interrupt (~60 Hz NTSC / 50 Hz PAL). Status register 0
bit 7 is the VBlank flag. The BIOS's interrupt handler runs each frame; your code
can hook it or just poll.

## Build pipeline

`buildSource({ platform: "msx" })` → SDCC (z80, C89) → sdasz80 → sdld with your
`msx_crt0.s` → a 32 KB `$4000`-based cartridge image. The fastest visible output
is BIOS calls: **INITXT ($006C)** (40-col text mode + clear + enable display),
**CHPUT ($00A2)** (print the char in register A). The `hello_msx.c` starter does
exactly this.

## Art + input

- `convertImageToTiles({ platform: "msx" })` — PNG → MSX screen-2 tiles. Returns
  TWO streams: `pattern.bin` (1bpp) + `color.bin` (per-row fg/bg nibbles into the
  fixed 16-color TMS9918 palette). Each 8-pixel row is limited to 2 colors —
  that's the classic MSX constraint. DMA pattern.bin to the pattern-generator
  base and color.bin to the color-table base (getRenderingContext shows both).
- `getInputLayout({ platform: "msx" })` — the joystick path via BIOS GTSTCK
  ($00D5) + GTTRIG ($00D8); trigger 1 = 'a' (east), trigger 2 = 'b' (west).

## Debugging tools

- `getCPUState()` — Z80 PC/SP/AF/BC/DE/HL/IX/IY + shadow regs + flags + IFF/IM.
- `getRenderingContext()` — VDP R1 display-enable, screen mode, VRAM table bases.
- `inspectPalette()` — V9938 9-bit GRB (or TMS9918 fixed) 16 entries.
- `inspectSprites()` — VRAM sprite-attribute table, up to 32 sprites.
- `getMemoryMap({ map })` — pass the sdld `.map` (the `symbols` field from
  buildSourceWithDebug) to see where SDCC placed your variables/code, grouped by
  region (bios / cart_rom / work_ram).
- `getAudioState({ chip: "ay8910" })` — the AY-3-8910 PSG: 3 square-wave
  channels (tone period→Hz, amplitude, tone/noise enable) + a shared noise
  generator + the envelope (period + shape bits).
- `readMemory()` regions: `msx_vram`, `msx_vdp_regs`, `msx_vdp_status`,
  `msx_palette`, `msx_cpu_regs`, `msx_psg_regs`, plus `system_ram` (work RAM).
