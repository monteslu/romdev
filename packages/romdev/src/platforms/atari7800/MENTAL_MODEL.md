# Atari 7800 — mental model

One page. Read once before you write your first 7800 game. The
TROUBLESHOOTING.md alongside this file is for when something's broken;
this is the "what's going on" version.

The 7800 is the **outlier** of cliemu's bundled platforms — its
architecture differs sharply from the NES / SMS / GB. If you've
worked on those, **forget tilemaps + sprite-attribute tables**.
The 7800 has neither.

## CPU memory map (6502 6502C "Sally")

```
$0000-$001F   TIA-shadow registers (audio + some 2600-compatibility)
$0020-$003F   MARIA video registers
$0040-$00FF   zero-page RAM (general use)
$0140-$01FF   stack
$0200-$021F   shadow regs (RIOT)
$0280-$02FF   RIOT (joysticks, console switches, timer)
$1800-$27FF   work RAM (4 KB — yes, only 4 KB!)
$8000-$FFFF   ROM (32 KB single-bank; bankswitching for larger carts)
```

**4 KB of RAM** is the binding constraint. Most other consoles have
8–128 KB. You CANNOT software-render a frame buffer; you must use
MARIA's display lists.

## MARIA: the unusual one

There's no PPU. There's no tile map. There's no sprite attribute
table. Instead, the **MARIA graphics processor** consumes a
**display list** describing the screen each frame.

Hierarchy:

```
DPP (Display List Pointer) — fixed CPU register
  ↓ points at
DLL (Display List List) — variable-length list of zones
  - each zone: how many scanlines tall + DL pointer + offset
  ↓ each zone references
DL  (Display List) — list of objects in that zone
  - each entry: ROM pointer + width + X position + palette
  ↓ each entry references
graphics data — pixel bytes in ROM (or RAM)
```

Each frame, MARIA walks the DLL → walks each DL → DMA-copies the
pixel data into the video output line by line. **You build the DL
and DLL; you do NOT poke pixels into a framebuffer.**

### Implications

- **A "sprite" is a DL entry.** Add a 5-byte DL header → another
  object draws.
- **Per-scanline object limit ≈ 32.** Beyond that MARIA glitches
  and (worse) burns enough cycles that the CPU stops getting time.
- **Y position = which zone the object lives in.** Each zone covers
  N scanlines. To move an object up/down, you move it between
  zones. (Or — in our scaffolds — you stamp the same sprite at
  different row offsets within ONE zone's data block, which fakes
  Y movement.)
- **Each DL header can pick a palette per object** (one of 8
  palettes, 4 colours each — including the shared background).

### Dynamic display lists — what to rebuild per frame (READ THIS)

The single biggest 7800 footgun for a moving game: **do NOT rebuild the
whole DLL + every DL from scratch every frame.** MARIA may be mid-walk
when you do, and a full teardown/rebuild races the display DMA →
flicker, corruption, or a hung screen. (This is the #1 thing that makes
a 7800 game "work for one frame then fall apart.")

The stable pattern is **build the structure ONCE, then patch in place**:

| Thing | When to build it | Why |
| --- | --- | --- |
| **DLL** (the zone list) | **Once, at init.** | Zone count + heights + DL pointers are your screen layout. It rarely changes. Point DPPH/DPPL at it once in `maria_init`. |
| **DL headers' graphics pointer / palette** | **Per frame, in place.** | To animate or show/hide an object, overwrite the bytes of its EXISTING DL entry — don't relink the list. |
| **DL header's X position** | **Per frame, in place.** | Horizontal movement = write the X byte of the object's existing DL header. Cheap and safe. |
| **Moving an object vertically** | **Per frame, but carefully.** | Y = which zone. Either keep a DL entry in each zone and toggle which is "live" (set its width/graphics to a blank tile when hidden), or stamp the sprite at different row offsets inside one tall zone's data. Prefer the latter for a few objects. |
| **Clearing stale objects** | **Per frame, targeted.** | Don't wipe the whole DL — overwrite just the entries that changed (set a hidden object's graphics pointer to a transparent/blank tile, or zero its width). |

Practical recipe for a shmup/invaders-style game:
1. `maria_init` — install the DLL once (e.g. a few fixed zones: HUD band,
   play-field band, shield band). Never touched again.
2. Pre-allocate a fixed set of DL entries per zone (player, N enemies,
   shots) in RAM-backed DL data.
3. Each frame: write only the X / graphics-pointer / palette bytes of the
   entries that moved or changed; set width/graphics to "blank" for slots
   that are inactive this frame.
4. Never call your "build the entire display list" routine inside the
   game loop — only the targeted byte writes.

If the screen tears or hangs once motion starts, you're almost certainly
rebuilding too much per frame. Pull the structural setup back into init.

## MARIA registers

```
$20  BACKGRND   background colour (Atari colour byte)
$21  P0C1       palette 0, colour 1
$22  P0C2       palette 0, colour 2
$23  P0C3       palette 0, colour 3
... (P1C1..P7C3 follow same pattern)
$24  WSYNC      write any value → CPU stalls to next scanline
$28  MSTAT      read: bit 7 = vblank
$2C  DPPH       DLL pointer high byte
$30  DPPL       DLL pointer low byte
$34  CHARBASE   indirect character mode base
$3C  CTRL       MARIA control byte (see CTRL_* in maria_registers.h)
```

`CTRL` matters: `0x40` = "DMA enabled, kangaroo off, border off,
colour-burst on". Forget `0x40` → MARIA doesn't render and the
screen stays whatever colour the TIA latched.

## Display list (DL) entry format

Each entry in a DL describes one object MARIA draws on that zone's
scanline. There are TWO entry forms — 4-byte (direct) and 5-byte
(extended) — and MARIA picks based on the LOW 5 BITS of the mode
byte at offset +1.

### Picking the form

```
mode = DL[dp + 1]
if (mode & 0x5F) == 0:       parse loop EXITS (DL terminator)
elif (mode & 0x1F) != 0:     4-byte direct form
else:                        5-byte extended form
```

The "loop continues" mask is `0x5F` (bits 0-4 + bit 6). Bit 5
(indirect flag) and bit 7 (write-mode) do NOT keep the loop going
by themselves.

### 5-byte extended form (the bundled scaffolds use this)

```
+0  pixel-data LOW byte
+1  bit 7 = write-mode (0 = 160A 2bpp, 1 = 320 1bpp)
    bit 6 = MUST be 1 (or another loop-continuing bit) so MARIA
            doesn't treat this entry as a terminator
    bit 5 = indirect flag (0 = direct, 1 = char-mode lookup)
    bits 0-4 = MUST be 0 to select 5-byte mode
+2  pixel-data HIGH byte
+3  bits 5-7 = palette index 0..7 (selects P0Cx..P7Cx)
    bits 0-4 = width encoded as (32 - width_bytes), so width 4 → 28 = $1C
+4  X position (0..159 in MARIA cell units; one cell = 2 pixels at 320 px)
```

Canonical mode byte for "5-byte direct, write-mode 0, palette 0,
width 4 bytes": `[0]=lo, [1]=$40, [2]=hi, [3]=$1C, [4]=X`.

### 4-byte direct form

```
+0  pixel-data LOW byte
+1  bits 5-7 = palette, bits 0-4 = (32 - width_bytes); must be NON-ZERO
+2  pixel-data HIGH byte
+3  X position
```

### DL terminator — critical

MARIA reads the NEXT entry's mode byte at `dp + 1` AFTER advancing
`dp` by the entry size (4 or 5 bytes). So a 5-byte entry needs the
terminator at byte **6** of your array (= byte 1 of the next "entry").
A 4-byte entry needs it at byte **5**.

If your DL array is just barely long enough to hold the entry
(6 bytes for a 5-byte entry), MARIA reads RANDOM MEMORY at offset
6 as the mode byte — almost guaranteed to be non-zero — and walks
off into garbage. **Always allocate one extra byte and zero it.**

The bundled `MK_DL` macro in `templates/default.c` does this:
`uint8_t name[7] = { 0, 0x40, 0, 0x1C, 80, 0, 0 }` — 5 entry bytes
+ a "next mode" terminator at index 6 (index 5 is unused padding).

## Display List List (DLL) entry format

```
+0  bit 7   = DLI (NMI on zone end — leave 0 unless you have a handler)
    bit 6   = H16 (holey 16K DMA — leave 0)
    bit 5   = H8  (holey 8K DMA — leave 0)
    bits 0-3 = offset (zone_height - 1; 0 = 1 scanline, 15 = 16 scanlines)
+1  DL pointer HIGH byte
+2  DL pointer LOW byte
```

**DLL has NO terminator.** MARIA walks one entry per `offset+1`
scanlines for the ENTIRE display area (243 scanlines on NTSC,
including 10 lines of top overscan before the visible area).

If your DLL is shorter than 243 entries, MARIA reads past the end
into random memory and renders garbage zones. The bundled scaffold
allocates 243 entries × 3 bytes = 729 bytes (fits easily in 4 KB
internal RAM) and points every zone with no objects at a shared
`dl_empty[2] = {0, 0}` terminator.

## The per-scanline offset addressing quirk

Within a multi-scanline zone (offset > 0), MARIA reads sprite data
from `ADDR + (zone_height - 1 - line_in_zone) * 256`. So for an
8-row sprite in an 8-line zone, row 0 (top) reads from `ADDR + $700`,
row 1 from `ADDR + $600`, ..., row 7 from `ADDR + $0`.

This forces page-aligned sprite layouts (8 separate 256-byte pages
for an 8-row sprite) unless you pack many sprites per page.

**Easy work-around:** make every zone 1 scanline tall (offset=0)
and use one DL entry per sprite ROW. Then `offset` is always 0, the
address quirk goes away, and you can store sprite rows back-to-back.
The bundled scaffold uses this pattern.

The cost is more DLL entries (one per scanline), but at 3 bytes each
across 243 lines = 729 bytes total — trivial RAM cost. Worth it for
the simpler mental model on a starter scaffold.

## Colour bytes (Atari NTSC palette)

The 7800 uses the **Atari NTSC palette** — same as the 2600. A
colour byte is `HHHL` where:

- `HHH` = hue (0..F, 0=grey)
- `L`   = luminance (0..7, but 7800 doubles → 0..F)

E.g. `0x46` = orange mid-brightness, `0x88` = blue dim, `0x0E` =
white.

## Input

Joystick port A via `SWCHA` at `$280`. Active **low** — invert the
read:

```c
uint8_t pad = ~SWCHA;
if (pad & JOY_UP)    /* P1 up */
if (pad & JOY_DOWN)  /* P1 down */
if (pad & JOY_LEFT)  /* P1 left */
if (pad & JOY_RIGHT) /* P1 right */
```

Fire button on `INPT4` at `$0C`, also active low.

Console switches (reset, select, pause, B/W, difficulty) on
`SWCHB` at `$282`.

## Audio

The 7800 still has the TIA audio chip from the 2600 — 2 channels,
4-bit volume, 5-bit frequency, 4-bit tone shape. Registers at
`$15-$1A`:

```
$15 AUDC0   channel 0 tone (0..15)
$16 AUDC1   channel 1 tone
$17 AUDF0   channel 0 frequency (0..31)
$18 AUDF1   channel 1 frequency
$19 AUDV0   channel 0 volume (0..15)
$1A AUDV1   channel 1 volume
```

There's also a POKEY chip option in some 7800 cartridges (Ballblazer,
Commando) for richer audio, but it's not standard — assume TIA-only
for portable code.

## Frame heartbeat

```c
for (;;) {
    while (MSTAT & 0x80) { }      // wait for vblank to END
    while (!(MSTAT & 0x80)) { }   // wait for it to START
    /* update game state */
    /* rebuild DL with new positions */
}
```

`MSTAT` bit 7 = 1 during vblank. The double-while is a standard
edge-detect: wait for the "currently in vblank" status to flip
*off* (now in active rendering), then wait for it to come *back on*
(vblank started fresh).

## Cartridge layout

```
$0080-$00FF   "A78" header (32 bytes title + 32 bytes machine config)
$0100-$7FFF   ROM (32 KB)
$FFFC-$FFFD   reset vector
$FFFE-$FFFF   IRQ vector (rarely used — most games poll MSTAT)
```

cc65's bundled atari7800.cfg handles the header + layout. You
don't write the header yourself.

## Build pipeline

When you call `buildSource({platform:"atari7800", language:"c"})`:

1. cc65 compiles your `.c` to 6502 `.s`.
2. ca65 assembles each `.s` to `.o`.
3. ld65 links + atari7800.cfg → flat `.a78` ROM.

Loadable via prosystem (`loadMedia`).
