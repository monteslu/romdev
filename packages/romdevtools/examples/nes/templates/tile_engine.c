/* ── tile_engine.c — NES starter with a tile map + multiple rooms ──
 *
 * Single-screen-per-room layout (Adventure / Zelda-1 / Sokoban shape).
 *   - 32×30 BG nametable rendered from a `room[]` array
 *   - Walk a sprite around with the d-pad
 *   - Crossing the screen edge transitions to the next room
 *   - 3 hand-written rooms wired up; extend with more for a real game
 *
 * Tile data layout (8×8, 2bpp NES format):
 *   tile 0 — blank          (always reserved so OAM Y=0 doesn't glitch)
 *   tile 1 — floor          (light pattern)
 *   tile 2 — wall           (solid)
 *   tile 3 — door           (different color)
 *   tile 4 — player sprite
 *
 * NES BG fetches from $1000-$1FFF in the default PPUCTRL we use, so
 * BG tiles get uploaded there. Sprite tiles go to $0000-$0FFF.
 */

#include "nes_runtime.h"

/* ── Tile data ──────────────────────────────────────────────────
 * Layout per tile: 8 bytes plane 0 + 8 bytes plane 1 = 16 bytes.
 * For row N: byte 2N is plane-0 (low bit), byte 2N+1 (... wait no):
 * Actually NES is INTERLEAVED differently — first 8 bytes is plane 0,
 * second 8 bytes is plane 1.
 *
 *  bit value of pixel = plane0_bit + plane1_bit * 2
 */
static const uint8_t bg_tiles[4 * 16] = {
  /* tile 0: blank */
  0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,
  /* tile 1: floor — light speckle pattern (color 1) */
  0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA,
  0,    0,    0,    0,    0,    0,    0,    0,
  /* tile 2: wall — solid (color 3, both planes set) */
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
  /* tile 3: door — outline color 2 */
  0xFF, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xFF,
  0xFF, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xFF,
};

static const uint8_t spr_tiles[1 * 16] = {
  /* tile 0: blank */
  0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,
};

static const uint8_t player_tile[16] = {
  /* outline color 3, fill color 0 */
  0x3C, 0x42, 0x81, 0x81, 0x81, 0x81, 0x42, 0x3C,
  0x3C, 0x42, 0x81, 0x81, 0x81, 0x81, 0x42, 0x3C,
};

static const uint8_t palette[32] = {
  /* BG palettes — 0 used for the room */
  0x0F, 0x10, 0x06, 0x16,    /* dark grey backdrop, light grey floor, brown walls */
  0x0F, 0x21, 0x11, 0x01,
  0x0F, 0x27, 0x17, 0x07,
  0x0F, 0x2A, 0x1A, 0x0A,
  /* Sprite palettes — 0 used for player */
  0x0F, 0x2C, 0x14, 0x20,    /* transparent, cyan, magenta, white */
  0x0F, 0x21, 0x11, 0x01,
  0x0F, 0x27, 0x17, 0x07,
  0x0F, 0x2A, 0x1A, 0x0A,
};

/* ── Rooms ──────────────────────────────────────────────────────
 * 32 columns × 30 rows = 960 tiles. Tile index per cell. Edges are
 * walls (tile 2). One door per side leads to the next room.
 */
#define COLS 32
#define ROWS 30
#define ROOMS 3

/* For a real game these would be byte arrays. For brevity here we
 * fill rooms procedurally based on the room index.
 */

/* Get the tile that should appear at (x, y) in room `r`. */
static uint8_t room_tile(uint8_t r, uint8_t x, uint8_t y) {
  /* Edges = wall. */
  if (x == 0 || x == COLS - 1 || y == 0 || y == ROWS - 1) {
    /* Doors: right edge of room 0/1, left edge of room 1/2. */
    if (y >= 14 && y <= 15) {
      if (x == COLS - 1 && r < ROOMS - 1) return 3;
      if (x == 0 && r > 0) return 3;
    }
    return 2;
  }
  /* Interior decor varies per room. */
  if (r == 1) {
    /* Pillars in room 1. */
    if ((x == 6 || x == 14 || x == 22 || x == 26) && y == 14) return 2;
  }
  if (r == 2) {
    /* Cross pattern. */
    if (x == 15 && y >= 10 && y <= 20) return 2;
    if (y == 15 && x >= 10 && x <= 21) return 2;
  }
  return 1;  /* floor */
}

/* Returns true if tile is solid (wall). */
static uint8_t solid(uint8_t r, uint8_t x, uint8_t y) {
  return (room_tile(r, x, y) == 2);
}

/* Returns true if tile is a door. */
static uint8_t is_door(uint8_t r, uint8_t x, uint8_t y) {
  return (room_tile(r, x, y) == 3);
}

/* Render the current room into nametable 0 ($2000) and attribute
 * table. Caller must have PPU off. */
static void render_room(uint8_t r) {
  uint16_t ppu_addr = 0x2000;
  uint8_t y, x;
  uint8_t attr_byte;
  uint16_t attr_addr;
  uint8_t row, col;

  /* Walk nametable cells. PPUADDR auto-increments by 1 in our default
   * PPUCTRL, so we can stream the row at once. */
  for (y = 0; y < ROWS; y++) {
    for (x = 0; x < COLS; x++) {
      vram_unsafe_set(ppu_addr, room_tile(r, x, y));
      ++ppu_addr;
    }
  }
  /* Attribute table: 8×8 grid of bytes, each covering 4×4 tile group
   * with 4 quadrants. Use palette 0 for the entire room. */
  attr_addr = 0x23C0;
  attr_byte = 0x00;
  for (row = 0; row < 8; row++) {
    for (col = 0; col < 8; col++) {
      vram_unsafe_set(attr_addr, attr_byte);
      ++attr_addr;
    }
  }
}

void main(void) {
  uint8_t px = 128;
  uint8_t py = 120;
  uint8_t current_room = 0;
  uint8_t pad;
  uint8_t nx, ny;
  uint8_t tx, ty;

  /* ── 1. PPU off ─────────────────────────────────────────────── */
  ppu_off();

  /* ── 2. Upload tile data ──────────────────────────────────────
   * Sprite tiles at $0000, BG tiles at $1000 (default PPUCTRL has
   * bit 4 set = BG pattern table at $1000). */
  chr_ram_upload(0x0000, spr_tiles, sizeof(spr_tiles));
  chr_ram_upload(0x0010, player_tile, 16);   /* sprite slot 1 = player */
  chr_ram_upload(0x1000, bg_tiles, sizeof(bg_tiles));

  /* ── 3. Palette ─────────────────────────────────────────────── */
  palette_load(palette);

  /* ── 4. Render starting room ────────────────────────────────── */
  render_room(current_room);

  /* ── 5. Initial OAM with player sprite ──────────────────────── */
  oam_clear();
  oam_spr(px, py, /* tile */ 1, /* attr */ 0);

  /* ── 6. PPU back on ─────────────────────────────────────────── */
  ppu_on_all();

  /* ── 7. Game loop ───────────────────────────────────────────── */
  for (;;) {
    /* Stage sprite for the upcoming frame. */
    oam_clear();
    oam_spr(px, py, 1, 0);

    /* Wait for vblank — NMI handler will DMA shadow_oam to OAM. */
    ppu_wait_nmi();

    /* Read input. */
    pad = pad_poll(0);
    nx = px;
    ny = py;
    if (pad & PAD_LEFT)  --nx;
    if (pad & PAD_RIGHT) ++nx;
    if (pad & PAD_UP)    --ny;
    if (pad & PAD_DOWN)  ++ny;

    /* Tile under the player's center (player is 8×8). */
    tx = (uint8_t)(nx >> 3);
    ty = (uint8_t)(ny >> 3);

    /* Door — transition to neighbouring room. */
    if (is_door(current_room, tx, ty)) {
      if (nx >= 240 && current_room < ROOMS - 1) {
        ++current_room;
        px = 16;
        py = ny;
        ppu_off();
        render_room(current_room);
        ppu_on_all();
        continue;
      }
      if (nx <= 12 && current_room > 0) {
        --current_room;
        px = 232;
        py = ny;
        ppu_off();
        render_room(current_room);
        ppu_on_all();
        continue;
      }
    }

    /* Wall collision. */
    if (!solid(current_room, tx, ty)) {
      px = nx;
      py = ny;
    }
  }
}
