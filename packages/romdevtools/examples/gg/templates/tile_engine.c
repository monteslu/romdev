/* ── tile_engine.c — SMS tile-map starter ───────────────────────────
 *
 * 32×24 tile world drawn on the SMS BG plane with a walking player
 * sprite + AABB collision against solid tile indices.
 *
 * SMS BG name table is at VRAM $3800 — 32 cells wide × 28 rows × 2
 * bytes per cell. Only 24 rows are visible in mode 4. Each name-table
 * entry packs: tile_index (10 bits across two bytes) + h/v flip +
 * palette + priority.
 */
#include "gg_hw.h"
#include "gg_sfx.h"
#include <stdint.h>

extern void gg_vdp_init(void);
extern void gg_vdp_display_on(void);
extern void gg_vdp_write_reg(uint8_t reg, uint8_t value);
extern void gg_vdp_set_addr(uint16_t addr, uint8_t prefix);
extern void gg_load_palette(const uint8_t *palette);
extern void gg_load_tiles(uint16_t vram_dest, const uint8_t *src, uint16_t byte_count);
extern void gg_set_tilemap_cell(uint8_t row, uint8_t col, uint8_t tile_idx, uint8_t attr);
extern void gg_vblank_wait(void);
extern uint8_t gg_joypad_read(void);
extern void gg_sprite_init(void);
extern void gg_sprite_set(uint8_t slot, uint8_t x, uint8_t y, uint8_t tile);
extern void gg_sat_upload(void);

#define WORLD_W 32
#define WORLD_H 24

#define T_OPEN  0
#define T_WALL  1
#define T_SPR   0   /* sprite tile uses sprite-tile-bank (R6=0xFF → $2000) */

/* ── Game Gear visible viewport ──────────────────────────────────────
 * The 32x24 name table fills the whole 256x192 frame, but only the
 * centered 160x144 SHOWS: fetch pixels [VIS_X0..VIS_X1] x [VIS_Y0..VIS_Y1]
 * (tile columns 6..25, rows 3..20). Place the player sprite inside it. */
#define VIS_X0  48
#define VIS_Y0  24
#define VIS_X1  207   /* 48 + 160 - 1 */
#define VIS_Y1  167   /* 24 + 144 - 1 */

/* GG palette = 32 entries × 2 bytes (4-4-4 BGR LE): low=(g<<4)|r, high=b.
 * gg_load_palette reads 64 bytes; a 32-byte array leaves the sprite palette
 * (entries 16-31) reading garbage = invisible sprites. BG colour 1 = entry 1
 * (dark grey wall); sprite colour 1 = entry 17 (white player). */
static const uint8_t palette[64] = {
  /* BG 0-15: 0 = dark navy backdrop, 1 = grey wall, 2 = teal floor,
   * 3 = blue floor (the two floor-dither tones). */
  0x20,0x02, 0x66,0x06, 0xC8,0x08, 0x80,0x0C, 0,0, 0,0, 0,0, 0,0,
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
  /* SPRITE 16-31: 16=transparent, 17=white player */
  0,0, 0xFF,0x0F, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
};

static const uint8_t bg_tiles[32 * 2] = {
  /* T_OPEN — dithered floor: plane1=0xFF (colour-2 bit always on), plane0
   * alternates 0xAA/0x55 so pixels flip between colour 2 (teal) and colour 3
   * (blue). The open floor now fills with TWO tones instead of the backdrop,
   * so the screen never reads as a single flat colour. */
  0xAA,0xFF,0x00,0x00, 0x55,0xFF,0x00,0x00,
  0xAA,0xFF,0x00,0x00, 0x55,0xFF,0x00,0x00,
  0xAA,0xFF,0x00,0x00, 0x55,0xFF,0x00,0x00,
  0xAA,0xFF,0x00,0x00, 0x55,0xFF,0x00,0x00,
  /* T_WALL — bordered block (colour 1, grey) */
  0xFF,0x00,0x00,0x00, 0x81,0x00,0x00,0x00,
  0x81,0x00,0x00,0x00, 0x81,0x00,0x00,0x00,
  0x81,0x00,0x00,0x00, 0x81,0x00,0x00,0x00,
  0x81,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
};

static const uint8_t sprite_tile[32] = {
  0x3C,0x00,0x00,0x00, 0x7E,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0x7E,0x00,0x00,0x00, 0x3C,0x00,0x00,0x00,
};

static uint8_t world[WORLD_H][WORLD_W];

static void world_build(void) {
  uint8_t y, x;
  for (y = 0; y < WORLD_H; y++) {
    for (x = 0; x < WORLD_W; x++) {
      world[y][x] = (x == 0 || x == WORLD_W - 1
                     || y == 0 || y == WORLD_H - 1) ? T_WALL : T_OPEN;
    }
  }
  /* A few interior platforms. */
  for (x = 4; x < 12; x++) world[10][x] = T_WALL;
  for (x = 16; x < 24; x++) world[14][x] = T_WALL;
  for (x = 6; x < 10; x++)  world[6][x]  = T_WALL;
}

static void world_draw(void) {
  uint8_t y, x;
  for (y = 0; y < WORLD_H; y++) {
    for (x = 0; x < WORLD_W; x++) {
      gg_set_tilemap_cell(y, x, world[y][x], 0);
    }
  }
}

static uint8_t solid_at(int16_t px, int16_t py) {
  int16_t tx = px >> 3;
  int16_t ty = py >> 3;
  if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) return 1;
  return world[ty][tx] != T_OPEN;
}

void main(void) {
  /* Start the player inside the visible window (tile ~10,10 = pixel 80,80). */
  int16_t px = 80, py = 80;

  gg_vdp_init();
  gg_load_palette(palette);
  /* BG tiles at VRAM $0000 (R4 = 0xFF). Two tiles = 64 bytes. */
  gg_load_tiles(0x0000, bg_tiles, 64);
  /* Sprite tile at VRAM $2000. */
  gg_load_tiles(0x2000, sprite_tile, 32);

  world_build();
  world_draw();

  gg_sprite_init();
  sfx_init();
  sfx_tone(0, 220, 12);
  gg_sprite_set(0, (uint8_t)px, (uint8_t)py, 0);
  gg_sat_upload();

  gg_vdp_display_on();

  do {
    uint8_t pad;
    int16_t nx, ny;
    gg_vblank_wait();
    sfx_update();
    gg_sprite_set(0, (uint8_t)px, (uint8_t)py, 0);
    gg_sat_upload();

    pad = gg_joypad_read();
    nx = px; ny = py;
    if (pad & JOY_LEFT)  nx = (int16_t)(px - 1);
    if (pad & JOY_RIGHT) nx = (int16_t)(px + 1);
    if (pad & JOY_UP)    ny = (int16_t)(py - 1);
    if (pad & JOY_DOWN)  ny = (int16_t)(py + 1);

    if (!solid_at(nx, py) && !solid_at(nx + 7, py)
        && !solid_at(nx, py + 7) && !solid_at(nx + 7, py + 7))
      px = nx;
    if (!solid_at(px, ny) && !solid_at(px + 7, ny)
        && !solid_at(px, ny + 7) && !solid_at(px + 7, ny + 7))
      py = ny;
  } while (1);
}
