Commodore 64 starter snippets
=============================

Hand-vetted boilerplate for cc65-targeted C64 development. cc65 ships C
as the default language; assembly via ca65 is also supported. The snippets
here mix C (for the most common workflows) and asm (for where you need
cycle-level control or are touching VIC-II / SID registers directly).

Files
-----

- **c64_registers.h** — symbolic names for VIC-II ($D000-$D02E), SID
  ($D400-$D41C), CIA1/2 ($DC00/$DD00) registers. `#include` from C; ca65
  imports it as well.
- **vic_init.s** — boot-time setup: black-out the screen, set border + bg
  colors, switch char-ROM/RAM banking.
- **sprite_table.s** — load 8 sprite pixel-data blocks + position + enable
  + color. The classic "render moving sprites" recipe.
- **read_joystick.s** — read joystick port 2 (the usual game port) from
  CIA1 $DC00 into a zp byte. Includes the "fire is bit 4" trap.
- **sid_play.s** — start a SID voice (waveform + ADSR + gate). Pair with
  setting frequency from main loop for arpeggios / sound effects.
- **basic_stub.s** — the canonical 12-byte BASIC stub at $0801 that just
  does `SYS 2061` (jumps to your machine code at $080D). Lets your program
  start with `LOAD"NAME",8,1` then `RUN`.

Toolchain
---------

Build via `buildSource({ platform: "c64", source: <C or asm> })`. cc65
auto-sniffs C vs asm; for explicit control pass `language: "c"` or `"asm"`.

Foot-guns
---------

1. **The 6510's I/O port at $00/$01 controls ROM banking.** Writing the
   wrong value can hide the KERNAL or character ROM. Default is $37
   (LORAM=1, HIRAM=1, CHAREN=1) which means BASIC + KERNAL + I/O are all
   visible. Most games don't change this.
2. **VIC bank select is in CIA2 $DD00 bits 0-1** (inverted). VIC sees
   one of 4 × 16 KB banks of main RAM. Default = bank 0 ($0000-$3FFF),
   which puts screen RAM at $0400 and char ROM at $1000 (via mirror).
3. **Color RAM is 4-bit only.** $D800-$DBE7 stores the foreground color
   nibble for each text cell — only the low 4 bits are used; high bits
   read back as garbage.
4. **The IRQ vector at $FFFE points through $0314/$0315 by default**
   (KERNAL interrupt thunk). To install your own raster IRQ, write your
   handler addr to $0314/$0315.
5. **Sprite pixel data lives in RAM, not VIC.** $D000-$D02E only stores
   X/Y/color/enable. The actual 64-byte pixel block per sprite is at
   `screen_ram[$3F8 + sprite_index] × 64` — write that address to point
   at your sprite data.
