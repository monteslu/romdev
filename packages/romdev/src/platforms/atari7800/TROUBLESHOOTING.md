# Atari 7800 — troubleshooting

When something's broken. Read MENTAL_MODEL.md first
(via `getPlatformDoc({platform:"atari7800", name:"mental_model"})`)
for the "what's going on" version — the 7800 is the architectural outlier
of the bundled platforms and most "wait, why?" moments come from
expecting it to behave like a NES.

## "Screen is black / wrong border colour"

Two common modes:

1. **`CTRL` doesn't have DMA enabled.** Write `CTRL = 0x40` AFTER
   you've set up DPPH/DPPL. The high bit (`0x80`) is "color burst
   off" (monochrome) — leave it off. Bit 6 (`0x40`) is "DMA enable
   AND no border" — that's what you want for a normal display.
2. **DPPL/DPPH point at a stale DLL.** If you set them before
   you've filled in DLL bytes 1+2 with the actual DL pointer, MARIA
   walks garbage and draws nothing. Order:
   ```c
   dll[1] = high_byte_of_dl;
   dll[2] = low_byte_of_dl;
   DPPL = low_byte_of_dll;
   DPPH = high_byte_of_dll;
   CTRL = 0x40;
   ```

## "Sprite is invisible"

The most common cause is the DL header's "write width" byte being
wrong. The format is:

```
header[1] = 0x80 | ((-width_bytes) & 0x1F)
```

For a 16-pixel-wide sprite at 160B mode (4 px per byte → 4 bytes
wide), `width_bytes = 4`, so `header[1] = 0x80 | ((-4) & 0x1F) =
0x9C`. If you instead wrote `header[1] = width_bytes`, the bit-7
"write form" flag isn't set and MARIA interprets the header as a
4-byte form pointing at garbage.

## "Sprite is in the wrong vertical position"

Y position is encoded by **which DLL zone** the DL entry is in,
NOT by a per-object Y. To move a sprite vertically across zones,
you have to:

1. Build a multi-zone DLL (each zone N scanlines tall).
2. Place the sprite's DL entry into the zone covering its Y range.
3. Per-frame, move the entry's bytes from old-zone DL → new-zone DL.

Our scaffolds use a single-zone DLL for simplicity. Vertical
movement is faked by stamping the sprite at different row offsets
within the canvas data — only works if the canvas is tall enough.

## "Memory overflow during link (RAM1 by N bytes)"

The 7800 has **4 KB of RAM**. The `default.c` and `hello_sprite.c`
scaffolds use very little; the `shmup.c` puzzle (and the older
canvas-buffer approach) easily blow past it.

Symptoms:
```
/share/cc65/cfg/atari7800.cfg:22: Warning: Segment 'BSS' overflows
memory area 'RAM1' by N bytes
```

Fixes:
- Drop large static arrays. Anything > ~1 KB is suspect.
- Use ROM constants (`const uint8_t` at file scope) instead of
  RAM globals.
- Replace canvas-buffer rendering with per-object DLs (see
  `shmup.c` scaffold for the canonical pattern).
- Avoid per-frame `memset(canvas, 0, ...)` — instead, only stamp
  changed cells.

## "Colours look wrong / washed out"

The 7800 uses the **Atari NTSC palette**, not RGB. Colour bytes are
`HHHL` (hue + luminance). If you pass an SMS-style 2-2-2 BGR byte
you'll get nonsense colours.

Common values:
```
0x00  black
0x0E  white
0x46  orange
0x88  blue mid
0xC4  green dim
0x1A  yellow-orange
```

Use Stella's palette reference (or any 2600/7800 palette diagram)
to look up the byte for your intended colour.

## "Game runs but plays sounds from the wrong channel"

The 7800's TIA audio uses identical registers to the 2600:
`AUDC0/AUDC1`, `AUDF0/AUDF1`, `AUDV0/AUDV1` at `$15-$1A`. Channel
ordering is consistent across systems.

If audio is silent: check that **VOLUME** (`AUDV0/1`) is non-zero
— it defaults to 0 on reset. Many sample drivers forget the
volume write.

## "cc65 compile warning: 'Integer constant implies signed long'"

This is harmless for 7800 code. cc65 warns when a literal exceeds
int16 range. Cast to unsigned or use `UL` suffix to silence.

## "DL works the first frame, then renders garbage"

You're modifying the DL while MARIA is reading it. MARIA scans the
DL during active rendering; safe modification windows:

- Before `CTRL = 0x40` first runs (boot)
- During vblank (`MSTAT & 0x80` true)

Build a "next-frame" DL during the game-state update phase and
swap pointers (DPPL/DPPH) at vblank — double-buffered.

Our scaffolds rebuild the DL during vblank, which works for small
DLs (< ~100 bytes). Large DLs that take ~1 ms to rebuild may
exceed vblank time and start corrupting the active frame.

## "ROM > 32 KB doesn't run"

The default linker config is single-bank 32 KB. The 7800 supports
bank-switching via the SuperGame mapper for ROMs up to 512 KB. To
use it, edit the linker config to declare additional banks and
the bank-switch entry-point at `$8000`. For most agent-driven
games, stay in 32 KB.

## "First build is slow but later ones are fast"

Expected. cc65 + ca65 + ld65 cold-load + cfg-parse takes ~1-2s.
Steady-state builds are sub-second thanks to the worker pool (R12).

## "Screen has garbage strips / random pixel patterns / pink+black bands"

Almost always one of THREE bugs in your DL/DLL setup:

1. **DLL too short.** MARIA has NO DLL terminator — it walks one
   entry per scanline for ALL 243 display lines (NTSC). If your DLL
   only covers a few zones, MARIA reads past the end into random
   RAM and renders garbage zones.
   Fix: allocate `dll[243*3]` and explicitly point every entry
   (use `dl_empty` for zones with no objects). See `default.c`.

2. **DL header in too-small array.** A 5-byte extended DL entry
   takes 5 bytes, but MARIA reads the NEXT entry's mode byte at
   `dp + 6` after advancing. If your DL is `uint8_t dl[6]`, MARIA
   reads `dl[6]` — out of bounds, almost guaranteed non-zero, loop
   keeps going into garbage.
   Fix: allocate `uint8_t dl[7]` with byte 5 unused + byte 6 = 0
   (the terminator). See the `MK_DL` macro in `default.c`.

3. **DLL zone with `offset > 15`.** The DLL byte-0 `offset` field
   is only 4 bits (bits 0-3), so max value 15 → zone height max
   16 scanlines. Writing `0x80 | 183` (intending "183 scanlines
   in this zone") sets DLI (bit 7) and offset to `183 & 15 = 7`
   — you get an 8-scanline zone AND fire NMIs you don't have a
   handler for.
   Fix: use multiple smaller zones, or the 1-scanline-per-zone
   pattern in `default.c` (offset = 0 everywhere).

## "BSS overflow / 'Segment BSS overflows memory area RAM1'"

The 7800's RAM1 is 2112 bytes ($1800-$203F). The default DLL
(243*3 = 729 B) plus a per-scanline DL pool plus game state can
exceed this fast.

Diagnostic:
```
build log shows: 'Segment BSS overflows memory area RAM1 by N bytes'
```

Fix options (in order of how much they shrink BSS):
- Reduce `PLAY_LINES` (per-scanline DL pool size scales linearly).
- Reduce `MAX_OBJS_PER_LINE` (each removes 5 bytes per scanline).
- Use the simpler per-row-DL pattern (`MK_DL(dl_row0)..dl_row7`)
  if you only need one sprite at a time — see `default.c` and
  `hello_sprite.c`. No per-scanline pool needed.

The bundled scaffolds size their pools to fit; if you scale up
(more objects, taller play area), watch the build log.
