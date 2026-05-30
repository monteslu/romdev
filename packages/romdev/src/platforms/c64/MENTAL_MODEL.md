# Commodore 64 — mental model

One page. Read once before you write your first C64 game. The
TROUBLESHOOTING.md alongside this file is for when something's broken.

The C64 is the architectural outlier of romdev's 6502-class platforms.
It has KERNAL + BASIC ROMs always available (and your code can call
them or override them), 64 KB of contiguous RAM with bank-switching to
get under the I/O area, two CIAs for I/O, and a VIC-II that doesn't
think in "tiles" — it thinks in **character cells**.

## CPU memory map (6510 — a 6502 with a tiny I/O port)

```
$0000-$0001   6510 internal I/O — bank-switch control
$0002-$00FF   zero page
$0100-$01FF   stack
$0200-$03FF   KERNAL+BASIC scratch / vectors (rarely touch directly)
$0400-$07E7   default screen RAM (40×25 char matrix)
$07E8-$07FF   sprite pointers ($07F8-$07FF = 8 bytes, one per MOB)
$0800-$9FFF   user RAM (cc65 puts code + data here for typical .prg)
$A000-$BFFF   BASIC ROM (banked; RAM underneath)
$C000-$CFFF   RAM (no ROM overlay)
$D000-$D3FF   VIC-II registers (banked; CHAREN bit selects)
$D400-$D7FF   SID registers
$D800-$DBE7   color RAM (1 KB nibble RAM — low 4 bits hold color index)
$DC00-$DC0F   CIA1 (keyboard, joystick, timers)
$DD00-$DD0F   CIA2 (serial, VIC bank select, user port)
$E000-$FFFF   KERNAL ROM (banked; RAM underneath)
```

The 6510's I/O port at `$0001` selects which ROMs are visible:

```
bit 0 (LORAM):  1 = BASIC ROM visible at $A000
bit 1 (HIRAM):  1 = KERNAL ROM visible at $E000
bit 2 (CHAREN): 0 = char ROM at $D000, 1 = I/O regs visible
```

Default after boot = `$37` (all three set) — BASIC + KERNAL ROMs +
I/O regs. Set CHAREN=0 to read the character-set bitmaps from ROM;
set HIRAM=0 to swap KERNAL out for RAM (useful for low-memory tricks).

## VIC-II — character cells, NOT tiles

The C64's video chip displays 25 rows × 40 cols of 8×8 character
glyphs. Each cell:

- Screen RAM ($0400) holds the **character code** (0-255).
- Color RAM ($D800) holds the **color index** (0-15) for that cell.
  Color RAM is nibble RAM — only the low 4 bits are wired up.
- The character set itself is at $D000 (ROM) or wherever VIC's char
  base register points (`VIC_MEMORY` at $D018).

Two character sets in ROM:
- "Uppercase + graphics": chars $00-$3F = uppercase letters + symbols
- "Lowercase + uppercase": chars $00-$3F = lowercase + UPPERCASE shifted

You can also point VIC at custom character RAM and write your own
glyphs (this is how every published C64 game does its art).

## VIC-II screen modes

```
text         default — 40×25 cells × 8×8 chars, 16 colors per cell
multicolor   half-res horizontal (40×25 cells, but 4-color cells with shared MC1/MC2)
hires bitmap 320×200 pixels, 2 colors per 8×8 cell
multi bitmap 160×200 pixels, 4 colors per 8×8 cell
```

Most C64 games use either text mode with a custom char set (cheap +
fast) or multicolor bitmap (more detail but harder to update).

## VIC-II sprites (MOBs)

8 hardware sprites, each:
- 24×21 pixels (3 bytes/row × 21 rows = 63 bytes; allocated in 64-byte
  slots so the leftover byte is unused padding)
- Stored in the VIC's current 16 KB **bank** (default $0000-$3FFF)
- Located via the **sprite pointer** at $07F8+N: pointer value × 64 =
  byte address WITHIN the bank
- Position: `VIC_SPRITE_X(N)` / `VIC_SPRITE_Y(N)` are 8-bit; X high
  bits live in `VIC_SPRITES_X8` at $D010 (for X >= 256)
- Color: `VIC_SPR_COL(N)` at $D027+N (single-color sprites)
- Enable: bit N of `VIC_SPR_ENA` at $D015

Sprite Y is offset 50 px from the screen's top edge; sprite X is
offset 24 px from the left edge. So `VIC_SPRITE_Y = 50` puts the
sprite at the visible top-left.

## CIA1 — joysticks + keyboard

CIA1 at $DC00-$DC0F. The chip is dual-purpose:
- $DC00 (CIA1_PRA): joystick PORT 2 + keyboard column select
- $DC01 (CIA1_PRB): joystick PORT 1 + keyboard row read

Joystick bits (active LOW — pressed = 0, released = 1):
```
bit 0: UP    bit 1: DOWN   bit 2: LEFT
bit 3: RIGHT bit 4: FIRE
```

**Convention:** read joystick from PORT 2 (CIA1_PRA) unless you have
a specific reason not to. Reading PRB clashes with keyboard scanning,
which is what the KERNAL's IRQ uses to update key state every
1/60 sec — you'd get garbled input from your jiffy timer.

## SID — three voices of fame

Three voices at $D400-$D418. Per-voice:
- 16-bit frequency (`SID_FREQ_LO/HI`)
- 12-bit pulse-width (for the pulse waveform)
- Control byte: gate / sync / ring / test / wave-select (triangle / saw /
  pulse / noise)
- 16-bit ADSR envelope (`SID_AD`, `SID_SR`)

Global `SID_VOL_MODE` ($D418) holds master volume + filter routing
bits. SID is famous for sounding incredible with very little code — see
the `sid_play.s` starter snippet.

## Cartridge / load file format

The .prg format is dead simple:
- First 2 bytes = little-endian load address
- Rest = data, loaded sequentially into RAM starting at that address

cc65 produces .prg files with the load address set to $0801 (BASIC
start) so they can be `LOAD"*",8,1` / `RUN` from a BASIC prompt. The
KERNAL handles the load; your code runs from the cc65-generated BASIC
stub that does a `SYS` to the C entry point.

For game ROMs you typically just let the user load the .prg into the
emulator and the rest takes care of itself.

## Frame heartbeat

The C64 has no dedicated vblank interrupt by default. Two approaches:

1. **Poll VIC_RASTER** ($D012): waits for the raster to reach line 250+
   (off the bottom of the visible region) — gives you a reliable per-
   frame tick. This is what the bundled `hello_sprite` and `tile_engine`
   templates do.
2. **Raster interrupt**: program VIC_RASTER + IRQ_ENA to fire an IRQ
   at a specific line. More complex; required for tricks like
   mid-screen mode changes, multiplexed sprites, etc.

## Build pipeline

When you call `buildSource({platform:"c64", language:"c"})`:

1. cc65 compiles your `.c` → 6502 `.s`.
2. ca65 assembles each `.s` → `.o`.
3. ld65 links + the bundled c64.cfg → `.prg` with a 2-byte load-address
   header.

Loadable via vice_x64 (`loadMedia`).

## Horizontal scrolling (for side-scrollers)

The `platformer` scaffold is single-screen. C64 scrolling is the fiddliest of
the platforms because the VIC-II only does a 0-7 px *fine* scroll in hardware;
moving further is a software char-cell shift.

- **Fine scroll:** the low 3 bits of `$D016` set a 0-7 px horizontal offset.
  To hide the garbage column that the fine scroll exposes at the edge, switch
  to 38-column mode (clear `$D016` bit 3) which masks the side borders.
- **Coarse scroll:** when the fine offset wraps past 7, reset it to 0 and
  shift the whole **screen RAM** ($0400) AND **color RAM** ($D800) left by one
  char column, then fill the new rightmost column from your world map. This is
  ~1000+1000 byte moves — do it across the frame or with the screen split.
- **Smoothness:** update `$D016` early in the frame (e.g. a raster IRQ) so the
  fine offset is set before the visible area is drawn.

Track `camX` in pixels: `fine = camX & 7` → `$D016`; `coarseCol = camX >> 3`
indexes your world map for which columns are on screen.
