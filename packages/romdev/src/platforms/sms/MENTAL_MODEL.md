# Sega Master System / Game Gear — mental model

One page. Read once before you write your first SMS / GG game. The
TROUBLESHOOTING.md alongside this file is for when something's broken;
this is the "what's going on" version.

## CPU memory map (Z80, 16-bit address space)

```
$0000-$BFFF   ROM (typical 48 KB; mapper extends to 4 MB)
$C000-$DFFF   work RAM (8 KB, mirrored to $E000-$FFFF)
$DFF0+        stack (grows down) — sms_crt0 sets SP here
$FFFC-$FFFF   mapper registers (Sega mapper, page select per slot)
```

Cartridge is paged in 16 KB slots ($0000, $4000, $8000) via the Sega
mapper at $FFFC-$FFFF. Slot 0 (`$0000-$3FFF`) holds the boot ROM /
fixed bank with the interrupt vectors and the first chunk of code;
slots 1 and 2 are bank-switched on demand. Our minimal templates
fit in 32 KB so we never page.

The Z80 has separate **I/O port** address space (`in`/`out`
instructions). Game logic talks to the VDP and joypads via ports,
NOT via memory-mapped registers.

## I/O ports

```
$3E   memory control (cartridge slot + RAM enable)
$3F   I/O control (joypad direction polarity)
$7E   V-counter (read)        / PSG (write — sound)
$7F   H-counter (read)
$BE   VDP data port
$BF   VDP control port
$DC   P1 joypad + P2 dpad
$DD   P2 buttons + reset / cart-detect
```

In C with SDCC's `__sfr __at` declarations:

```c
__sfr __at 0xBE PORT_VDP_DATA;
__sfr __at 0xBF PORT_VDP_CTRL;
__sfr __at 0xDC PORT_JOY_A;
```

Reading the variable compiles to `in a,(port)`, writing to
`out (port),a`. See `src/platforms/sms/lib/c/sms_hw.h` for the full
set.

## VDP (Video Display Processor)

The SMS VDP is a derivative of the TMS9918, with mode-4 (the SMS
graphics mode) doing most of the lifting. It has its own VRAM
(16 KB) and CRAM (32 bytes — palette).

```
VRAM   16 KB    tile patterns + name table + sprite attr table + sprite tile data
CRAM   32 B     32 palette entries × 1 byte (2-2-2 BGR)
```

VRAM is reached through port $BE (data) + port $BF (control). To set
the destination address X for a write:

```c
PORT_VDP_CTRL = X & 0xFF;             /* low byte */
PORT_VDP_CTRL = ((X >> 8) & 0x3F) | 0x40;  /* high byte + WRITE prefix */
```

Then subsequent writes to PORT_VDP_DATA push bytes sequentially.

The 11 VDP registers ($00-$0A) control the display. Idiomatic
baseline (set by `sms_vdp_init()`):

```
R0 = 0x36   Mode 4 + line-IRQ
R1 = 0x80   display OFF, vblank IRQ off, 192-line
R2 = 0xFF   name table at $3800
R4 = 0xFF   BG tile data at $0000
R5 = 0xFF   sprite attr table at $3F00
R6 = 0xFB   sprite tile data at $0000 (NOT $2000 — see footgun below)
R7 = 0x00   border colour
```

Then later: `R1 = 0xE0` to enable display + vblank IRQ.

## Tiles + name table

Tiles are 8×8 pixels, **4 bits per pixel** in **bitplane-interleaved
format**: 32 bytes per tile, 4 bytes per row (one byte per plane).
512 tiles max in VRAM (256 BG + 256 sprite, by default config).

The BG name table at $3800 is 32 cols × 28 rows × 2 bytes/entry.
Each entry packs:

```
byte 0: low 8 bits of tile index
byte 1: 0 0 0 priority palette vflip hflip tile_idx_bit9
```

Where `palette = 0` → BG palette ($00-$0F in CRAM), `palette = 1` →
sprite palette ($10-$1F).

## Sprites (sprite attribute table)

SAT at VRAM $3F00. 64 sprite slots × 4 bytes:

```
$3F00-$3F3F:  64 Y bytes — Y = 0xD0 hides all subsequent sprites
$3F80-$3FFF:  64 (X, tile) pairs interleaved
```

So Y bytes and X/tile pairs are split into TWO regions of the SAT.
`src/platforms/sms/lib/c/sprite_table.c` keeps a 256-byte shadow
buffer in WRAM and uploads it to the SAT each vblank.

### Two footguns the bundled scaffolds keep hitting

1. **8 sprites per scanline limit.** The VDP draws up to 8 sprites per
   scanline; the 9th+ are silently dropped. If you draw a "CATCH THE
   COIN" text using 14 sprite tiles on the same Y row, **only the
   first 8 letters appear** and the rest vanish with no warning. Fix:
   split text across multiple Y rows OR draw it via the BG name
   table (which has no per-line limit).

2. **SAT $D0 terminator.** The VDP treats Y=$D0 in any OAM Y byte as
   a HARD terminator — it stops scanning further slots immediately.
   Earlier rounds of `sms_sprite_init()` wrote $D0 to every Y byte
   to "hide" sprites at boot, which caused the classic "I populated
   slots 0..5 and slot 6 was still $D0 so the renderer halted at
   slot 5" footgun.

   **The runtime now initialises unused slots to $E0** (off-screen,
   below the 192-line area, but NOT the terminator). Slots you
   don't touch stay invisible AND don't kill the renderer. You only
   have to worry about $D0 if you write it explicitly — e.g. as an
   early-out optimisation.

   If sprites past a certain slot are missing in `sprites({op:'inspect'})`,
   check the live OAM Y bytes for $D0 in a slot before them.

`sprites({op:'inspect'})` shows the live OAM bytes + reports
`spriteTileDataBase` — trust it over comments when sprites misbehave.

### R6 sprite-tile-base default: $0000, NOT $2000

`sms_vdp_init()` sets R6 = 0xFB. R6 bit 2 is the SA13 select for
sprite tile data — and bit 2 is **CLEAR** in 0xFB. That means
sprite tiles read from `$0000-$1FFF`, **sharing the bank with BG
tiles**. Many references (including older comments in our own
`vdp_init.c` and `load_tiles.c`, since fixed) say "R6=0xFB → sprite
tiles at $2000" — that's wrong.

If you want sprite tiles in their own bank at $2000, set
`vdp_write_reg(6, 0xFF)` AND upload tiles to VRAM $2000. Otherwise
upload sprite tiles to $0000 alongside BG tiles (just make sure
they don't collide).

## Palette (CRAM)

32 entries × 1 byte = 32 bytes. 2-2-2 BGR encoding:

```
bit 0-1: red          0..3
bit 2-3: green        0..3
bit 4-5: blue         0..3
```

Brightest white = `0x3F`. Entry $00 is the BG backdrop; $10 is the
sprite-palette colour 0 (transparent).

**Game Gear** uses 4-4-4 BGR (2 bytes per entry, 64 total bytes).
The runtime has both `sms_load_palette` (32 bytes) and
`gg_load_palette` (64 bytes).

## Frame heartbeat

```c
sms_vblank_wait();          /* poll VDP status byte bit 7 until set */
sms_sat_upload();           /* push shadow SAT to VRAM $3F00 */
/* update game state */
```

The vblank poll is the heartbeat. There's also a vblank IRQ if you
need cycle-accurate timing, but for most games polling is fine.

## Input

`sms_joypad_read()` returns a packed byte with the buttons inverted
(active high — pressed = 1). Bits:

```
JOY_UP    0x01
JOY_DOWN  0x02
JOY_LEFT  0x04
JOY_RIGHT 0x08
JOY_B1    0x10
JOY_B2    0x20
```

Edge-detect by AND'ing `pad & !prev`.

### Driving input over MCP — the SMS button map is INVERTED ⚠

genesis_plus_gx (the SMS core) maps the two face buttons onto libretro the
*opposite* way you'd guess (verified live against the core):

| Physical button | `input({op:'set', …})`  | spatial / native |
|-----------------|-------------------|------------------|
| Button 1 (TL, main fire) | `{ b: true }` | `{ west: true }` · `input({op:'press', button:'1'})` |
| Button 2 (TR)            | `{ a: true }` | `{ east: true }` · `input({op:'press', button:'2'})` |

**The trap:** `input({op:'set', a: true})` presses **button 2**, not button 1. For
the main fire (button 1 / `JOY_B1`) use `{ b: true }` or the spatial
`{ west: true }`. The **spatial names** and `input({op:'press', button:'1'|'2'})`
resolve correctly — prefer them over raw a/b. `input({op:'layout', platform:'sms'})`
has the exact map. (Same genesis_plus_gx inversion as Genesis + Game Gear.)

## Sound

PSG (SN76489) on port $7F. 4 channels: 3 square waves + 1 noise.
Writes are byte-wise; the high bit selects "latch register" vs
"continue previous register".

A full driver is beyond the scope of these scaffolds. For
playable SFX, manually pulse $7F with the latch-register byte
followed by data bytes. Real games ship a music driver in WRAM.

**Debugging sound:** `audioDebug({op:'inspect', chip:"psg"})` decodes the live SN76489 —
3 tone + 1 noise channel state (the same gpgx PSG region serves SMS/GG/Genesis).

## Cartridge layout

```
$0000-$0037   reset + interrupt vectors (RST jumps)
$0038         interrupt handler entry (IM 1 mode)
$0066         NMI entry (pause button on SMS)
$7FF0-$7FFF   ROM header — "TMR SEGA" trademark + checksum + region/size
```

Our minimal templates don't bother with the header (real consoles
boot ROMs even without it; an emulator-side compatibility test
might flag them). `sms_crt0.s` provides the RST table + the IM 1
setup that lets vblank IRQs fire.

## Build pipeline

When you call `build({output:'rom', platform:"sms", language:"c"})`:

1. SDCC (z80 port) compiles each `.c` → `.rel` object.
2. `sms_crt0.s` is auto-injected as the startup file (assembled to
   `.rel`).
3. `sdld` links all `.rel` + the z80 standard library → `.ihx`
   Intel HEX.
4. The IHX is converted to a flat 32 KB `.sms` ROM.

Loadable via genesis_plus_gx (`loadMedia`).

## Game Gear differences

- Smaller screen: 160×144 visible (vs SMS 256×192). VDP is the
  same; cropping happens in hardware.
- 12-bit CRAM (4 bits per channel). Use `gg_load_palette` (64 bytes
  per palette).
- Start button on port $00 (separate from the SMS pause-via-NMI).
- ROM size cap is higher: GG games can go up to 1 MB.
- Game Gear-specific buttons add port $00 read (Start) and stereo
  PSG control on port $06.

## Horizontal scrolling (for side-scrollers)

The `platformer` scaffold is single-screen. To make it a side-scroller:

- **Hardware scroll:** write VDP register 8 (horizontal scroll) each frame =
  `-camX & 0xFF` (the reg scrolls the screen; the name table is 32×28 and
  wraps). This gives smooth scrolling through one name-table's worth.
- **Streaming:** for a world wider than 256 px, rewrite the name-table column
  about to enter view each time `camX` crosses an 8-px boundary — write the
  next world column's tile entries into the off-screen column. Do VDP writes
  during vblank.
- **Fixed HUD / status bar:** VDP register 0 bit 6 ("horizontal scroll lock")
  freezes the top two rows of the screen regardless of the scroll register —
  use it for a fixed HUD band while the rest scrolls.

Track `camX` in pixels; actor screen-X = `worldX - camX`. (Game Gear is the
same VDP — only the visible window differs.)
