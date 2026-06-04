# Super Nintendo / Super Famicom — mental model

One page. Read once before you write your first SNES game. The
TROUBLESHOOTING.md alongside this file is for when something's broken;
this is the "what's going on" version.

## CPU memory map (LoROM layout)

The SNES has a 24-bit address space; LoROM splits bank+offset. Most
homebrew uses LoROM unless the cart is > 2 MB.

```
$00:0000-$00:1FFF   WRAM mirror (8 KB low RAM, mirrored across banks)
$00:2100-$00:213F   PPU registers (BG, OAM, CGRAM access, INIDISP)
$00:2140-$00:217F   SPC700 sound CPU APUIO ports (4 bytes mirrored)
$00:2180-$00:2183   WMDATA / WMADDx (WRAM access port)
$00:4016-$00:4017   joypad I/O
$00:4200-$00:421F   PPU/CPU control regs (NMI enable, joypad auto-read)
$00:4300-$00:437F   DMA channel registers (8 channels × 16 bytes)
$00:8000-$00:FFFF   first 32 KB of ROM (mirrored to other banks)
$7E:0000-$7E:FFFF   work RAM (128 KB, banks $7E + $7F)
$7F:0000-$7F:FFFF   work RAM (continued — 128 KB total)
```

Direct page (the SNES equivalent of zero-page) is configurable but
defaults to $00:0000. The stack lives in bank $00, growing down from
$01FF.

## PPU memory (separate from CPU bus!)

```
VRAM    64 KB   tile patterns + tilemaps
CGRAM   512 B   palette (256 colors × 2 bytes BGR-555)
OAM     544 B   sprite-attribute table (128 sprites + high table)
```

PPU memory is reached through registers `$2115-$2119` (VMADD/VMDATA),
`$2121-$2122` (CGADD/CGDATA), `$2102-$2104` (OAMADD/OAMDATA).

For bulk uploads (tile data, palette, OAM) use **DMA** — channel 0
of `$4300-$430F` is the canonical "VRAM-fill" channel. PVSnesLib's
`dmaCopyVram` wraps this.

## Background modes

The SNES has 8 BG modes selected via PPU register $2105 (BGMODE):

```
0  4 BGs × 4 colors      — text-mode look
1  3 BGs (16+16+4 col)   — default for most games (Super Mario World)
2  2 BGs × 16 col + tilemap offset-per-tile (Yoshi's Island)
3  1 BG × 256 col + 1 BG × 16 col (Donkey Kong Country)
4  1 BG × 256 col + 1 BG × 4 col with offset-per-tile
5  2 BGs hi-res (512 px wide, half-height)
6  hi-res mosaic
7  1 BG with affine transform (Mario Kart, F-Zero)
```

PVSnesLib's default is `BG_MODE1` (`setMode(BG_MODE1, 0)`) — three
background layers, plenty of palette space.

## Sprites (OAM)

128 sprites × 4 bytes + 32 bytes of high table = 544 bytes. The high
table packs the sprite's size flag and the upper bit of X for each
sprite (4 sprites per byte).

Per sprite:

```
+0  X position (low 8 bits — upper bit is in the high table)
+1  Y position (8 bits)
+2  tile index (low 8 bits)
+3  attributes:
      bit 0   tile index high bit (so 9-bit tile range)
      bit 1-3 palette (palette = 0..7)
      bit 4-5 priority (0..3 — higher = drawn on top)
      bit 6   horizontal flip
      bit 7   vertical flip
```

Sprite sizes are configurable via OBSEL ($2101): small + large pair
(8x8 + 16x16, 8x8 + 32x32, 16x16 + 32x32, etc.). Each sprite picks
small OR large via its high-table bit.

The PPU draws **up to 32 sprites per scanline**, **up to 34 tiles
per scanline** total. Beyond that, drops happen low-OAM-index-first.

### The OBJ stable-path recipe (do this; it's the one that works)

Most "my SNES sprites are garbage/flashing/invisible" pain comes from
deviating from this. Follow it exactly until the game works, *then*
optimize:

1. **Use fixed OAM slots.** Decide slot N for each sprite up front. The
   PVSnesLib OAM table is byte-addressed: **slot N lives at byte offset
   `N << 2`** (i.e. `N*4`). Don't shuffle slots between frames — a moving
   sprite keeps its slot and just changes X/Y.
2. **Upload EVERY OBJ palette line you reference — before you show the
   sprite.** OBJ palettes are CGRAM lines 8..15 (absolute index
   `128 + line*16`, 16 colors each). If a sprite's attr names palette
   line 2 but you only uploaded line 0, line 2 is whatever was in CGRAM
   (usually zero) → garbage/transparent. Either upload all the lines you
   use, or point every sprite at line 0 until art is in. (This is the #1
   bug — `inspectSprites` now WARNS when a renderable sprite references an
   all-zero OBJ palette line.)
3. **Know your OBJ VRAM rules.** OBSEL picks the OBJ tile base (a page in
   VRAM, in 0x2000-word steps) and the small/large size pair. A 16×16 OBJ
   is a 2×2 block of 8×8 cells in the OBJ char table, laid out **+1 across,
   +0x10 down** (the OBJ name table is 16 tiles wide). Tile index in OAM is
   9-bit (attr bit 0 is the high bit / second-page select).
4. **ROM-backed tiles beat runtime-generated tiles** for getting started.
   DMA a fixed tile sheet to the OBJ VRAM page once at init; don't generate
   OBJ tiles on the fly until the static path renders correctly. The "SNES
   Invaders" stable path = static ship-angle frames + explicit asteroid
   tiles + all palettes uploaded + fixed slots + a low sprite budget.
5. **Verify with the tools, don't guess.** After a build that should show
   sprites, call `getRenderingContext({platform:'snes'})` (it now decodes
   OBSEL: OBJ size, tile base, and whether the OBJ layer is enabled on the
   main screen via TM) and `inspectSprites({platform:'snes'})` (per-sprite
   `renderable` vs hidden, resolved `tileVramAddr`, `cgramPaletteRange`, and
   uninitialized-palette warnings). If `renderableCount` is 0 but you placed
   sprites, the answer is right there: OBJ layer off in TM, all sprites
   parked at Y≥0xE0, or off the X edges.

## Palette (CGRAM)

256 colors × 2 bytes = 512 bytes, BGR-555:

```
$xy where word = 0bbbbbgggggrrrrr  → red is low, blue is high
```

(Same word order as Sega, different bit packing.)

For sprites: palettes 0..7 of the 16-color palette block from CGRAM
$80..$FF — sprite tile uses 4bpp tiles, so 16 colours per palette.

PVSnesLib helpers:

```c
setPaletteColor(idx, color);   // CGRAM by absolute index
setBGPaletteColor(slot, val);  // BG palettes 0..7
```

## Frame heartbeat

PVSnesLib gives you `WaitForVBlank()`. Game loop shape:

```c
while (1) {
    /* update game state */
    /* stage OAM via oamSet() */
    oamUpdate();           /* flushes shadow OAM via DMA */
    WaitForVBlank();       /* blocks until vblank; auto-DMA fires */
}
```

`oamUpdate()` flushes the RAM-side shadow buffer to OAM via DMA;
`WaitForVBlank()` blocks the CPU until the next vertical-blanking
interval. The NMI handler does joypad auto-read + any chained
PVSnesLib housekeeping.

## Input

`u16 pad = padsCurrent(0)` returns the bitmask for controller 0.
Bits:

```
KEY_A      BIT(7)         KEY_RIGHT  BIT(8)
KEY_B      BIT(15)        KEY_LEFT   BIT(9)
KEY_X      BIT(6)         KEY_DOWN   BIT(10)
KEY_Y      BIT(14)        KEY_UP     BIT(11)
KEY_L      BIT(5)         KEY_START  BIT(12)
KEY_R      BIT(4)         KEY_SELECT BIT(13)
```

Edge-detect by `(pad & KEY) && !(prev & KEY)`.

## Sound

The S-DSP is driven by the SPC700, a separate 8-bit CPU running its
own program. You upload an SPC binary into APU RAM at boot, then
poke the 4 APUIO ports to trigger sound events.

PVSnesLib bundles a music driver. Workflow:

```c
spcBoot();                  /* uploads driver */
spcSetSoundEntry(0, 0, 1, 0, &my_sfx_brrs);
spcPlay(0);                 /* trigger SFX channel 0 */
```

(Hand-authoring SPC drivers is hard. For SFX, PVSnesLib's PSG-style
helpers are the canonical entry point.)

**Debugging sound:** `getAudioState({chip:"dsp"})` decodes the live S-DSP —
per-voice vol/pitch/ADSR + `env` (0 = silent regardless of vol) + `bufLastSamples`
(nonzero proves the voice is producing audio) + `flg`; it distinguishes "never
produced output" from "muted by mixer." GOTCHA: S-DSP FLG is $6C, KOFF is $5C
(many refs swap them); power-on FLG=$E0 means your driver MUST clear bit 6.

## ROM layout (LoROM)

```
$00:0000-$00:7FFF   first 32 KB of ROM (low half of bank 0)
$00:8000-$00:FFFF   first 32 KB of ROM (mirrored at high half of bank 0)
$01:0000-$01:7FFF   next 32 KB (low half bank 1)
...
$00:FFC0-$00:FFDF   ROM title (21 chars)
$00:FFD5            map mode (LoROM=$20, HiROM=$21)
$00:FFD6            cart type (RAM, battery, etc.)
$00:FFD7            ROM size code
$00:FFFC-$00:FFFD   RESET vector (where the SNES starts execution)
$00:FFEA-$00:FFEB   NMI vector
```

PVSnesLib's `hdr.asm` fills these in.

## Where the SDK lives (and how to read it)

`createProject({platform:"snes"})` ships the FULL PVSnesLib source +
header tree into the new project at `vendor/pvsneslib/`. So when
your code does `#include <snes.h>`, those headers come from
`vendor/pvsneslib/include/`:

```
vendor/pvsneslib/include/snes.h           ← top-level umbrella
vendor/pvsneslib/include/snes/
  background.h   bgSet*, BG_MODE0..7
  console.h      consoleInitText, consoleDrawText, consoleSetText*
  dma.h          dmaCopyVram, dmaFill*
  input.h        padsCurrent, KEY_A..KEY_SELECT, padsClear
  interrupt.h    WaitForVBlank, setNMIHandler
  object.h       (legacy alias — use sprite.h)
  pixel.h        setPaletteColor, setBGPaletteColor, RGB5
  scores.h
  snestypes.h    u8/u16/s8/s16 typedefs
  sound.h        spcBoot, spcSetSoundEntry, spcPlay
  sprite.h       oamInit, oamSet, oamSetEx, oamSetXY, oamUpdate
  video.h        setMode, setScreenOn, setScreenOff
```

To find what an SDK function does, GREP the vendor tree — the C
source for every helper ships at `vendor/pvsneslib/source/`. This is
the same pattern as the Lynx cc65 vendor dir: the agent reads the
library it's calling instead of inferring from header comments.

## Build pipeline

When you call `buildSource({platform:"snes", language:"c"})`:

1. `tcc-65816` (TinyCC fork → WASM) compiles each `.c` → `.asm`
   (wla-65816 syntax).
2. `wla-65816` (WLA-DX → WASM) assembles each `.asm` → `.o` object.
3. `wla-65816` also assembles the `hdr.asm` + `crt0_snes.obj`.
4. `wlalink` (WLA-DX → WASM) links all `.o` + PVSnesLib runtime
   archives (`crt0_snes.obj`, `libm.obj`, `libtcc.obj`, `libc.obj`)
   per a linkfile → raw `.sfc` SNES ROM.

Loadable via snes9x (`loadMedia`).

## Horizontal scrolling (for side-scrollers)

The `platformer` scaffold is single-screen. SNES scrolling is the easiest of
the tile platforms because each BG layer has its own hardware scroll register
and parallax is nearly free.

- **Hardware scroll:** write the BG1 horizontal offset register (`BG1HOFS`,
  `$210D`, write twice — low byte then high byte/13-bit) each frame to camera
  X. PVSnesLib: `bgSetScroll(0, camX, camY);`.
- **Parallax:** scroll BG2 at a fraction of camX (e.g. `camX>>1`) for a
  background layer that lags — instant depth, no extra CPU.
- **Streaming:** the BG tilemap is 32×32 (or 64×32) cells. For a world wider
  than the map, rewrite the column entering view as the camera crosses each
  8-px boundary (DMA the new column into VRAM during vblank).
- **Fixed HUD:** put the HUD on a separate BG layer and exclude it from the
  scroll write, or use a mid-frame HDMA/IRQ to reset the scroll for the HUD
  scanlines.

Track `camX` in pixels; actor screen-X = `worldX - camX`.
