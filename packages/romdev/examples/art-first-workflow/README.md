# Art-first workflow — FOSS tools → ROM

The goal: a non-coder using only open-source tools (LibreSprite, Tiled,
Pixelorama, GIMP) can author a retro game and get a working ROM
without ever editing C/asm. Zero installs beyond the editors. Zero
shelling out from the agent.

## The toolchain

| Step | Tool | License | Format |
|---|---|---|---|
| Pick a palette | [Lospec](https://lospec.com) → save `.hex` | CC0 palettes | hex/JSON |
| Draw sprites | [LibreSprite](https://libresprite.github.io/) | GPLv2 (Aseprite fork) | `.ase` |
| Design levels | [Tiled](https://www.mapeditor.org/) | BSD-2 | `.tmj` (JSON) |
| Animate | LibreSprite (export GIF) or any GIF editor | various | `.gif` |
| Build ROM | romdev `loadAsepriteSheet` / `loadTilemap` / `loadGifAnimation` | MIT | platform tiles |

Every tool runs on Linux/Mac/Windows. No native dependencies, no
build steps, no agent shell scripts.

## Step-by-step

### 1. Pick a palette

Get a CC0 palette from [lospec.com/palettes](https://lospec.com/palettes)
or generate one matching your target platform:

```js
// MCP call
getPlatformPalettePng({ platform: "nes", format: "hex", outputPath: "palette.hex" })
// → palette.hex (one #RRGGBB per line)

// Or for direct import into LibreSprite:
getPlatformPalettePng({ platform: "nes", format: "lospec", outputPath: "palette.json" })
// → palette.json with {name, author, colors:[hex_no_hash]}
```

### 2. Draw sprites in LibreSprite

1. Open LibreSprite → **File → New** → set the size to your sprite
   sheet (e.g. 64×64 for a 4×4 tile grid).
2. **Palette → Open Palette** → pick `palette.hex` (or `.json` for the
   lospec version). LibreSprite restricts you to those colors.
3. Draw your sprites. Use **Slice tool** to name regions:
   `player_idle`, `chalice`, `dragon_yorgle`, etc. Each named slice
   becomes a separately addressable tile group in your game code.
4. Use **Tags** to group frames into animations: select frames 0–3,
   name the tag `walk_down`. Same for `walk_left`, `attack`, etc.
5. **File → Save** as `sprites.ase`.

### 3. Load sprites into your game

```js
// MCP call — returns tile bytes + named groups + tags
loadAsepriteSheet({
  path: "sprites.ase",
  platform: "nes",
  outputDir: "build",
})
// → {
//     tiles: {
//       player_idle: { tile_indices: [0, 1, 2, 3], width_tiles: 2, height_tiles: 2 },
//       chalice:     { tile_indices: [4],         width_tiles: 1, height_tiles: 1 },
//       ...
//     },
//     tile_bytes_path: "build/tiles.bin",  // upload this to CHR-RAM
//     tile_count: 47,
//     tags: {
//       walk_down: { from: 0, to: 3, direction: "forward", delays_ms: [100,100,100,100] },
//       attack:    { from: 4, to: 7, direction: "forward", delays_ms: [50,50,50,200] },
//     },
//     palette: [{r,g,b,a}, ...],
//     warnings: [],
//   }
```

Your C code references `tile_indices[0]` for "the first tile of
player_idle" — no magic numbers. Animation timing comes from the
artist's frame durations in LibreSprite, not hardcoded in code.

### 4. Design a level in Tiled

1. Open Tiled → **File → New Map** → set tile size = 8×8, map size in
   tiles (e.g. 32×30 for a full NES screen).
2. **New Tileset** → image-based → point at the tileset PNG you
   exported from LibreSprite (you can also use the rendered tiles from
   `loadAsepriteSheet` after writing to disk).
3. Paint tiles on the **bg** layer.
4. Add an **Object Layer** named e.g. `spawns`. Drop named point
   objects: `player_start`, `door_north`, `chest`. Each can carry
   key/value custom properties (e.g. `loot=potion`).
5. **File → Export As** → "Tiled map files (.tmj)". (NOT `.tmx` — the
   XML variant. `.tmj` is JSON and works directly.)

### 5. Load the level into your game

```js
loadTilemap({
  path: "level1.tmj",
  platform: "nes",
  outputDir: "build",
})
// → {
//     width: 32, height: 30, tile_size: 8,
//     layers: {
//       bg: {
//         width: 32, height: 30,
//         bytes_per_cell: 1,
//         data_path: "build/bg.data.bin",   // upload to nametable
//         empty_path: "build/bg.empty.bin", // bitmask of "no tile here"
//       },
//     },
//     object_layers: {
//       spawns: [
//         { id: 1, name: "player_start", type: "spawn",
//           x: 128, y: 96, point: true,
//           properties: { facing: "south" } },
//         { id: 2, name: "door_north", type: "door",
//           x: 120, y: 0, width: 16, height: 8,
//           properties: { goes_to: "level2" } },
//       ],
//     },
//     tilesets: [{ firstgid: 1, name: "world", tilewidth: 8, ... }],
//     warnings: [],
//   }
```

### 6. Animations from any source

Got an animated GIF from anywhere (LibreSprite, GIMP, Pixelorama,
ScreenToGif)? Parse it the same way:

```js
loadGifAnimation({
  path: "explosion.gif",
  platform: "nes",
  outputDir: "build",
})
// → { frames: 8,
//     tile_bytes_path: "build/tiles.bin",
//     frame_tile_indices: [[0,1,2,3], [4,5,6,7], ...],
//     delays_ms: [50, 50, 50, 100, ...] }
```

Or a TexturePacker-style PNG+JSON sheet (what LibreSprite's
"Export Sprite Sheet" makes):

```js
loadSpriteSheet({
  pngPath: "sheet.png",
  manifestPath: "sheet.json",
  platform: "nes",
})
```

### 7. Wire it into your game

The runtime helpers (`nes_runtime.h`, `gb_runtime.h`) already know how
to upload tile data to CHR-RAM, write to nametable, configure OAM,
etc. From your `main.c`:

```c
#include "nes_runtime.h"

/* These would normally be `extern` and the bytes get `#include`d via
 * `.incbin` in a separate .s file. Shown inline here for clarity. */
extern const uint8_t tile_data[];          // from build/tiles.bin
extern const uint8_t nametable_data[];     // from build/bg.data.bin

#define PLAYER_IDLE  0
#define CHALICE      4

void main(void) {
    ppu_off();
    chr_ram_upload(0x0000, tile_data, /* tile_count * 16 */ );
    palette_load(palette);
    /* upload nametable_data straight to $2000 — vram_unsafe_set 960× */
    oam_clear();
    oam_spr(player_x, player_y, PLAYER_IDLE, 0);
    ppu_on_all();
    for (;;) {
        ppu_wait_nmi();
        /* update game state, walk frame index through `walk_down` tag */
    }
}
```

That's it. **The artist's names are the variable names.** The
animation timing is the artist's choice. The level layout is in
Tiled's GUI. No hand-converting PNGs, no manual tile lists, no
ImageMagick installs.

## Gotchas (see the loader docs for details)

- **Tiled compression**: if Tiled's "Tile Layer Format" is set to
  "zstd-compressed Base64", re-export with zlib/gzip/uncompressed —
  zstd isn't supported.
- **`.ase` tilemap-mode cels** (Aseprite 1.3+): convert to regular
  layers first (`Layer → Convert → To Layer`).
- **GIF disposal**: omggif (our parser) doesn't apply disposal. Export
  GIFs with `Disposal: Replace` for full-frame sprite animations.
- **Indexed PNG colors must match the platform palette** (±8/channel
  tolerance). If `convertImageToTiles` warns about colors outside the
  palette, the editor exported them slightly drifted by sRGB gamma —
  re-export, or re-pick the palette with `getPlatformPalettePng`.
