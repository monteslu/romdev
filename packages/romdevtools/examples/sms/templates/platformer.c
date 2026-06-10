/* ── platformer.c — SMS SIDE-SCROLLING platformer scaffold ─────────
 *
 * A horizontally scrolling platformer. The world is 512 px wide (64
 * cells); the SMS name table is only 32 cells (256 px) and wraps, so a
 * world wider than one screen needs COLUMN STREAMING: each time the
 * camera crosses an 8-px boundary we rewrite the name-table column that
 * is about to scroll into view with the next world column's tiles.
 *
 * Smooth pixel scroll comes from VDP register 8 (R8 = -camX & 0xFF).
 * Subpixel state (x/y in 1/16-pixel units) for fine acceleration; the
 * player sprite draws in SCREEN space (worldX>>4) - camX.
 *
 * See the SMS MENTAL_MODEL.md "Horizontal scrolling" section.
 */
#include "sms_hw.h"
#include "sms_sfx.h"
#include "sms_music.h"
#include <stdint.h>

extern void sms_vdp_init(void);
extern void sms_vdp_display_on(void);
extern void sms_vdp_write_reg(uint8_t reg, uint8_t value);
extern void sms_vdp_set_addr(uint16_t addr, uint8_t prefix);
extern void sms_load_palette(const uint8_t *palette);
extern void sms_load_tiles(uint16_t vram_dest, const uint8_t *src, uint16_t byte_count);
extern void sms_set_tilemap_cell(uint8_t row, uint8_t col, uint8_t tile_idx, uint8_t attr);
extern void sms_vblank_wait(void);
extern uint8_t sms_joypad_read(void);
extern void sms_sprite_init(void);
extern void sms_sprite_set(uint8_t slot, uint8_t x, uint8_t y, uint8_t tile);
extern void sms_sat_upload(void);

#define T_OPEN  0
#define T_WALL  1

#define WORLD_COLS 64                 /* 64 cells = 512 px world          */
#define WORLD_W    (WORLD_COLS * 8)
#define SCREEN_W   256
#define VIS_ROWS   24                 /* 192-line display = 24 rows       */

static const uint8_t palette[32] = {
  /* BG: backdrop blue, wall mid-grey */
  0x10,0x14,0x00,0x00, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  /* Sprite: player red */
  0x00,0x03,0x00,0x00, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
};

static const uint8_t bg_tiles[32 * 2] = {
  /* T_OPEN — blank */
  0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
  0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
  /* T_WALL — solid block in colour 1 */
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
};

static const uint8_t player_tile[32] = {
  0x3C,0x00,0x00,0x00, 0x7E,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0x7E,0x00,0x00,0x00, 0x3C,0x00,0x00,0x00,
};

typedef struct { int16_t x, y, w, h; } Rect;

/* Platforms in WORLD coords, spread across the 512-px world. */
static const Rect platforms[] = {
  {   0, 176, 512,  16 }, /* floor spans the world */
  {  32, 144,  56,   8 },
  { 120, 144,  64,   8 },
  { 200, 112,  48,   8 },
  {  56,  96,  40,   8 },
  { 288, 136,  64,   8 },
  { 384, 104,  56,   8 },
  { 440, 152,  48,   8 },
  { 320,  72,  48,   8 },
};
#define N_PLATFORMS (sizeof(platforms) / sizeof(platforms[0]))

static uint8_t on_platform(int16_t px, int16_t py) {
  uint8_t i;
  const Rect *p;
  for (i = 0; i < N_PLATFORMS; i++) {
    p = &platforms[i];
    if (py + 8 == p->y && px + 8 > p->x && px < p->x + p->w) return 1;
  }
  return 0;
}

/* Is world cell (col,row) inside any platform? */
static uint8_t cell_is_wall(int16_t col, uint8_t row) {
  int16_t cx = col << 3;
  int16_t cy = (int16_t)row << 3;
  uint8_t i;
  const Rect *p;
  for (i = 0; i < N_PLATFORMS; i++) {
    p = &platforms[i];
    if (cx + 8 > p->x && cx < p->x + p->w
        && cy + 8 > p->y && cy < p->y + p->h) return 1;
  }
  return 0;
}

/* Write one world column into its wrapped name-table column. */
static void paint_column(int16_t worldCol) {
  uint8_t ntCol;
  uint8_t row;
  if (worldCol < 0 || worldCol >= WORLD_COLS) return;
  ntCol = (uint8_t)(worldCol & 31);
  for (row = 0; row < VIS_ROWS; row++)
    sms_set_tilemap_cell(row, ntCol, cell_is_wall(worldCol, row) ? T_WALL : T_OPEN, 0);
}

/* Paint the initial 32 columns the camera starts on. */
static void paint_initial(void) {
  int16_t c;
  for (c = 0; c < 32; c++) paint_column(c);
}

void main(void) {
  int16_t px = 16 << 4, py = 64 << 4;
  int16_t vx = 0, vy = 0;
  int16_t camX = 0, lastCamCol = 0;
  uint8_t prev = 0;
  const int16_t GRAVITY = 10;
  const int16_t MOVE    = 20;
  const int16_t JUMP    = -180;
  const int16_t MAXFALL = 280;

  sms_vdp_init();
  sms_load_palette(palette);
  sms_load_tiles(0x0000, bg_tiles, 64);
  sms_load_tiles(0x2000, player_tile, 32);
  paint_initial();

  sms_sprite_init();
  sfx_init();
  music_init();
  music_play(0);   /* continuous background music ("no sound" was the playtest verdict) */
  sms_sprite_set(0, (uint8_t)(px >> 4), (uint8_t)(py >> 4), 0);
  sms_sat_upload();
  sms_vdp_display_on();

  do {
    uint8_t pad, grounded;
    int16_t ipx, ipy, npy, sx;
    int16_t camCol;
    int32_t np;
    uint8_t i;
    const Rect *p;
    sms_vblank_wait();
    sfx_update();
    music_update();

    ipx = px >> 4;
    ipy = py >> 4;

    /* Camera follows the player, centered, clamped to the world. */
    camX = ipx - (SCREEN_W / 2 - 4);
    if (camX < 0) camX = 0;
    if (camX > WORLD_W - SCREEN_W) camX = WORLD_W - SCREEN_W;

    /* Stream new columns entering from the right as the camera advances,
     * and from the left if it retreats. The column just past the right
     * edge of the visible 32-col window is camCol + 32. */
    camCol = camX >> 3;
    while (camCol > lastCamCol) { lastCamCol++; paint_column(lastCamCol + 31); }
    while (camCol < lastCamCol) { lastCamCol--; paint_column(lastCamCol); }

    /* Smooth pixel scroll: R8 shifts the display; -camX wraps correctly. */
    sms_vdp_write_reg(8, (uint8_t)(-camX & 0xFF));

    /* Player drawn in SCREEN space. */
    sx = ipx - camX;
    sms_sprite_set(0, (uint8_t)sx, (uint8_t)ipy, 0);
    sms_sat_upload();

    pad = sms_joypad_read();
    vx = 0;
    if (pad & JOY_LEFT)  vx = (int16_t)(-MOVE);
    if (pad & JOY_RIGHT) vx = MOVE;

    grounded = on_platform(ipx, ipy);
    if ((pad & JOY_B1) && !(prev & JOY_B1) && grounded) { vy = JUMP; sfx_tone(0, 300, 6); }
    prev = pad;

    vy = (int16_t)(vy + GRAVITY);
    if (vy > MAXFALL) vy = MAXFALL;
    if (grounded && vy > 0) vy = 0;

    px = (int16_t)(px + vx);
    if (px < 0) px = 0;
    if (px > ((WORLD_W - 8) << 4)) px = (int16_t)((WORLD_W - 8) << 4);

    np = (int32_t)py + (int32_t)vy;
    npy = (int16_t)(np >> 4);
    if (vy > 0) {
      uint8_t landed = 0;
      for (i = 0; i < N_PLATFORMS; i++) {
        p = &platforms[i];
        if (ipy + 8 <= p->y && npy + 8 >= p->y
            && ipx + 8 > p->x && ipx < p->x + p->w) {
          py = (int16_t)((p->y - 8) << 4);
          vy = 0;
          landed = 1;
          break;
        }
      }
      if (!landed) py = (int16_t)np;
    } else {
      py = (int16_t)np;
    }
    if (py > (192 << 4)) { py = 0; vy = 0; }
  } while (1);
}
