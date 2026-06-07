/* ── platformer.c — Game Gear SIDE-SCROLLING platformer scaffold ───
 *
 * A horizontally scrolling platformer. The world is 512 px wide (64
 * cells); the GG VDP name table is only 32 cells (256 px) and wraps, so
 * a world wider than one fetch needs COLUMN STREAMING: each time the
 * camera crosses an 8-px boundary we rewrite the name-table column that
 * is about to scroll into view with the next world column's tiles.
 *
 * The GG VDP is the same Mode-4 hardware as the SMS — only the visible
 * window differs (160×144 centered inside the 256×192 frame). So the
 * camera centers on a 160-px window while the VDP still fetches all 32
 * columns; the streaming math is identical to the SMS scaffold.
 *
 * Smooth pixel scroll comes from VDP register 8 (R8 = -camX & 0xFF).
 * Subpixel state (x/y in 1/16-pixel units); the player sprite draws in
 * SCREEN space (worldX>>4) - camX. See the SMS/GG MENTAL_MODEL.md.
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

#define T_OPEN  0
#define T_WALL  1

#define WORLD_COLS 64                 /* 64 cells = 512 px world          */
#define WORLD_W    (WORLD_COLS * 8)
#define SCREEN_W   160                /* GG visible window is 160 px wide */
#define VIS_ROWS   24

/* ── Game Gear visible viewport ──────────────────────────────────────
 * Only the centered 160x144 of the 256x192 frame shows. The BG is
 * scrolled so world column camX/8 appears at fetch pixel VIS_X0, and the
 * player sprite is drawn at (worldX - camX) + VIS_X0 so it stays aligned
 * with the BG inside the visible window. */
#define VIS_X0     48
#define VIS_Y0     24
#define VIS_X1     207   /* 48 + 160 - 1 */
#define VIS_Y1     167   /* 24 + 144 - 1 */

/* GG palette = 32 entries × 2 bytes (4-4-4 BGR LE): low=(g<<4)|r, high=b.
 * gg_load_palette reads 64 bytes; a 32-byte array leaves the sprite palette
 * (entries 16-31) reading garbage = invisible sprites. BG colour 1 = entry 1
 * (mid-grey wall); sprite colour 1 = entry 17 (white player). */
static const uint8_t palette[64] = {
  /* BG 0-15: entry 0 = dark navy backdrop, entry 1 = mid-grey wall */
  0x20,0x02, 0xAA,0x0A, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
  /* SPRITE 16-31: 16=transparent, 17=white player */
  0,0, 0xFF,0x0F, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
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
    gg_set_tilemap_cell(row, ntCol, cell_is_wall(worldCol, row) ? T_WALL : T_OPEN, 0);
}

static void paint_initial(void) {
  int16_t c;
  for (c = 0; c < 32; c++) paint_column(c);
}

void main(void) {
  /* Start above the x=32..88 platform (world y=144) so the player lands on
   * it inside the GG visible vertical band [VIS_Y0..VIS_Y1], not on the
   * floor at world y=176 which sits just below the visible window. */
  int16_t px = 48 << 4, py = 96 << 4;
  int16_t vx = 0, vy = 0;
  int16_t camX = 0, lastCamCol = 0;
  uint8_t prev = 0;
  const int16_t GRAVITY = 10;
  const int16_t MOVE    = 20;
  const int16_t JUMP    = -180;
  const int16_t MAXFALL = 280;

  gg_vdp_init();
  gg_load_palette(palette);
  gg_load_tiles(0x0000, bg_tiles, 64);
  gg_load_tiles(0x2000, player_tile, 32);
  paint_initial();

  gg_sprite_init();
  sfx_init();
  gg_sprite_set(0, (uint8_t)(px >> 4), (uint8_t)(py >> 4), 0);
  gg_sat_upload();
  gg_vdp_display_on();

  do {
    uint8_t pad, grounded;
    int16_t ipx, ipy, npy, sx;
    int16_t camCol;
    int32_t np;
    uint8_t i;
    const Rect *p;
    gg_vblank_wait();
    sfx_update();

    ipx = px >> 4;
    ipy = py >> 4;

    /* Camera follows the player, centered on the 160-px window, clamped. */
    camX = ipx - (SCREEN_W / 2 - 4);
    if (camX < 0) camX = 0;
    if (camX > WORLD_W - SCREEN_W) camX = WORLD_W - SCREEN_W;

    /* Stream columns entering from the right as the camera advances, and
     * from the left if it retreats. Note: the GG VDP fetches all 32
     * columns even though only 160 px is shown, so we still stream the
     * column at camCol + 32 (just past the fetched window's right edge). */
    camCol = camX >> 3;
    while (camCol > lastCamCol) { lastCamCol++; paint_column(lastCamCol + 31); }
    while (camCol < lastCamCol) { lastCamCol--; paint_column(lastCamCol); }

    /* Scroll so world column (camX/8) lands at fetch pixel VIS_X0 — the
     * left edge of the GG visible window. (SMS shows the whole 256-px
     * fetch and uses R8 = -camX; the GG only shows the centered 160-px
     * crop, so we bias by +VIS_X0.) */
    gg_vdp_write_reg(8, (uint8_t)((VIS_X0 - camX) & 0xFF));

    /* Player X is biased into the visible window so it stays pinned to the
     * horizontally-scrolled BG: sx = (worldX - camX) + VIS_X0. The BG is
     * NOT vertically scrolled (R9 = 0), so world rows map 1:1 to fetch rows
     * and the player Y needs no bias — world Y already lands in the visible
     * band [VIS_Y0..VIS_Y1] for the level layout below. */
    sx = (ipx - camX) + VIS_X0;
    gg_sprite_set(0, (uint8_t)sx, (uint8_t)ipy, 0);
    gg_sat_upload();

    pad = gg_joypad_read();
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
