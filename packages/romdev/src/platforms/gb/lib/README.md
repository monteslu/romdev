# Game Boy / Game Boy Color — quickstart

The compressed version of "everything I had to learn the hard way
building a GB ROM with rom-dev-mcp."

## Language: RGBDS assembly

Game Boy uses RGBDS (rgbasm + rgblink + rgbfix) — the canonical
toolchain for GB homebrew. `buildSource({platform:"gb", source: <asm>})`
builds + links + runs `rgbfix` to fix the cart header. GBC builds the
same way; pass `platform:"gbc"` to enable the CGB-only opcodes (KEY1,
BCPS, etc.) — gambatte detects mode from the cart header byte at $0143.

C is theoretically supported via GBDK (sdcc-gbz80 backend) but is NOT
bundled today; the SM83 backend in sdcc 4.4.0 has been less tested for
us than the z80 backend.

## Snippets shipped in this directory

| File | Purpose |
|---|---|
| `header.asm` | $0100-$014F cartridge header. rgbfix fills in the Nintendo logo, title, checksums; you can ship as-is for a working cart. |
| `lcd_init.asm` | LCD off / on helpers. Turning the LCD off lets you bulk-upload VRAM safely; turn back on once tiles/palette/map are in place. |
| `vblank_wait.asm` | Polling vblank wait (LY $\geq$ 144). The IRQ-driven variant uses halt to save battery on a real DMG. |
| `joypad_read.asm` | Reads the joypad via the two-pass $FF00 protocol. Returns one byte: D-pad in low nybble, buttons in high nybble. |
| `load_palette.asm` | DMG palette setup (BGP/OBP0/OBP1). Standard $E4 = white→gray→darkgray→black. |
| `load_tiles.asm` | Bulk VRAM upload. Assumes LCD is OFF — pause renders for big uploads. |
| `dma_oam.asm` | The canonical HRAM-resident OAM DMA routine. Copies shadow OAM at $C000 to actual OAM at $FE00 in 160 µs. |

Fetch any with `getStarterSnippet({platform:"gb", name:"<file>"})`.

## The five gotchas that cost the most time

### 1. VRAM is only safely writable when the PPU isn't reading it

The PPU has the VRAM bus locked during scanlines (PPU modes 2 + 3).
Writes during those modes are silently dropped. Safe write windows:

- **LCD off** (LCDC bit 7 = 0): unrestricted. Use this for big uploads
  at startup. Turn LCD off, upload everything, turn back on.
- **Vblank** (LY ≥ 144): about 1140 cycles per frame — enough for a
  large but not huge upload (~150 tiles).
- **Hblank** (PPU mode 0): ~50 cycles each, but you'd be reading STAT
  bit 1-0 = 0 to detect it. Used for HDMA-style streaming on GBC.

The "screen flashes white when uploading mid-frame" bug is almost
always missing this. `inspectPatternTiles` shows you exactly what
landed in VRAM — if it's empty after your upload, the LCD was on.

### 2. OAM DMA must run from HRAM

The OAM DMA pauses the main CPU bus for 160 µs; instructions can only
fetch from HRAM ($FF80-$FFFE) during that time. The conventional pattern
is to copy a tiny stub (10 bytes) into HRAM at startup, then call it
once per vblank. See `dma_oam.asm` for the shipped version — it includes
both the setup routine (run once) and the HRAM-resident copy stub.

### 3. The cart header MUST have the Nintendo logo + a valid checksum

The boot ROM verifies bytes $0104-$0133 against the Nintendo logo and
the header checksum at $014D against the sum of $0134-$014C. If either
fails, the boot ROM halts the console at the logo screen. `rgbfix -v -p 0`
auto-fixes both:

```bash
rgbfix -v -p 0 -m MBC1 -t "MYGAME" out.gb
```

Most emulators (gambatte included) skip the verification when running
in "headless" mode, so you'll see your game run in rom-dev-mcp's
gambatte even with an invalid header. Real hardware won't.

### 4. DMG colors are 4 SHADES, not 4 colors

Tile pixel value 0-3 doesn't directly pick an RGB color — it indexes
into the BGP register, which itself picks a shade from a hardware-
fixed 4-shade ramp. So "tile pixel = 0" is whatever shade BGP's low
2 bits select; you can remap shades at runtime by changing BGP.

This is why the same tile data looks completely different in different
games — they all use 4 shades, but the BGP mapping varies. To preview
art, use `previewTileArt({platform:"gb", ...})` with an explicit
palette, or `paletteFromEmulator:true` after loading.

### 5. GBC adds banked VRAM + KEY1 double-speed + 32-color palette

CGB extends DMG in three orthogonal ways:

- **VRAM bank 1**: $FF4F bit 0 swaps which 8 KB of VRAM is mapped to
  $8000-$9FFF. Bank 1 holds BG tile attribute bytes (palette index,
  VRAM bank for the tile data, h/v flip, priority).
- **Palette RAM**: $FF68-$FF6B for BG, $FF6A-$FF6B for sprites. Each
  palette is 4 × 15-bit BGR. Write the index to $FF68, then read/write
  data to $FF69 (auto-increment via bit 7 of $FF68).
- **KEY1** at $FF4D: bit 0 = pending speed switch, bit 7 = double-speed
  active. Trigger with `stop` instruction. Doubles CPU clock; everything
  else (PPU, audio) stays at single speed.

`getRenderingContext({platform:"gbc"})` decodes all three.

## A real GB working loop

After init (LCD off → tiles + palette + map → LCD on), the inner loop is:

```
vblank_wait_poll      ; or halt with vblank IRQ
call oam_dma          ; DMA shadow OAM to $FE00
call joypad_read      ; update JoypadState in HRAM
call game_update      ; your logic — moves shadow OAM around
jr   main_loop
```

The shadow-OAM-in-WRAM + DMA-in-vblank pattern is the foundation of
every commercial GB game. Memory addresses + register names follow the
RGBDS convention (`hl/de/bc` registers, `ldh` for $FF00-$FFFF I/O).
