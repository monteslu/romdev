/* ── sports.c — Game Gear single-player Pong (vs AI) scaffold ───────
 *
 * The Game Gear is a handheld — only one controller. Right paddle is
 * always AI, tracking the ball. Use UP/DOWN to move the left paddle.
 */
#include "gg_hw.h"
#include "gg_sfx.h"
#include "gg_music.h"
#include <stdint.h>

extern void    gg_vdp_init(void);
extern void    gg_vdp_display_on(void);
extern void    gg_load_palette(const uint8_t *palette);
extern void    gg_load_tiles(uint16_t vram_dest, const uint8_t *src, uint16_t byte_count);
extern void    gg_set_tilemap_cell(uint8_t row, uint8_t col, uint8_t tile_idx, uint8_t attr);
extern void    gg_vblank_wait(void);
extern uint8_t gg_joypad_read(void);
extern void    gg_sprite_init(void);
extern void    gg_sprite_set(uint8_t slot, uint8_t x, uint8_t y, uint8_t tile);
extern void    gg_sat_upload(void);

/* ── Game Gear visible viewport ──────────────────────────────────────
 * Only the centered 160x144 of the 256x192 frame shows. Keep the whole
 * court inside [VIS_X0..VIS_X1] x [VIS_Y0..VIS_Y1] or it's off-screen. */
#define VIS_X0      48
#define VIS_Y0      24
#define VIS_X1      207   /* 48 + 160 - 1 */
#define VIS_Y1      167   /* 24 + 144 - 1 */

#define COURT_TOP   VIS_Y0
#define COURT_BOT   VIS_Y1
#define PADDLE_H    24
#define BALL_SIZE   8
/* Explicit (uint8_t) casts: these fit a byte but SDCC warns (158) on the
 * implicit int->uint8_t narrowing when the computed macro is passed to the
 * uint8_t x/y args of gg_sprite_set. */
#define PADDLE_X1   ((uint8_t)(VIS_X0 + 8))    /* near the visible left edge   */
#define PADDLE_X2   ((uint8_t)(VIS_X1 - 16))   /* near the visible right edge  */

/* GG palette = 32 entries × 2 bytes (4-4-4 BGR LE): low=(g<<4)|r, high=b.
 * gg_load_palette reads 64 bytes; a 32-byte array leaves the sprite palette
 * (entries 16-31) reading garbage = invisible sprites. Sprite colour 1 = entry
 * 17 (white). */
static const uint8_t palette[64] = {
  /* BG 0-15: 0 = dark navy backdrop, 1 = court green, 2 = court line white */
  0x20,0x02, 0x60,0x00, 0xFF,0x0F, 0,0, 0,0, 0,0, 0,0, 0,0,
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
  /* SPRITE 16-31: 16=transparent, 17=white */
  0,0, 0xFF,0x0F, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
};

static const uint8_t tile_solid[32] = {
  0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00,
  0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00,
  0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00,
  0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00,
};

/* Three BG tiles for the court, loaded into the BG tile bank at $0000:
 *   tile 0 = court green (colour 1), tile 1 = court line / border
 *   (colour 2 = white), tile 2 = dashed net (colour 2 stripe on green). */
static const uint8_t bg_tiles[96] = {
  /* tile 0 = court green (colour 1 -> plane 0 set) */
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  /* tile 1 = court line / border (colour 2 -> plane 1 set) */
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  /* tile 2 = net: centre column colour 2, rest colour 1 (green) */
  0xFF,0x18,0x00,0x00, 0xFF,0x18,0x00,0x00,
  0xFF,0x18,0x00,0x00, 0xFF,0x18,0x00,0x00,
  0xFF,0x18,0x00,0x00, 0xFF,0x18,0x00,0x00,
  0xFF,0x18,0x00,0x00, 0xFF,0x18,0x00,0x00,
};

/* Paint the court inside the GG visible region (cols 6..25, rows 3..20):
 * green field, white border lines around the perimeter, dashed net down
 * the centre column. BG tile bank is $0000. */
static void draw_court(void) {
  uint8_t row, col;
  for (row = 3; row <= 20; row++) {
    for (col = 6; col <= 25; col++) {
      uint8_t t = 0;                                   /* green field        */
      if (row == 3 || row == 20 || col == 6 || col == 25) t = 1; /* border  */
      else if (col == 15 && (row & 1)) t = 2;          /* dashed centre net  */
      gg_set_tilemap_cell(row, col, t, 0);
    }
  }
}

static int16_t p1y, p2y, bx, by;
static int8_t  bdx, bdy;
static uint8_t score_p1, score_p2;
static uint8_t serve_timer;

static void serve_ball(uint8_t to_left) {
  bx = (VIS_X0 + VIS_X1) / 2;
  by = (VIS_Y0 + VIS_Y1) / 2;
  bdx = to_left ? -2 : 2;
  bdy = ((score_p1 + score_p2) & 1) ? -1 : 1;
  serve_timer = 30;
}

static void reset_match(void) {
  p1y = (VIS_Y0 + VIS_Y1) / 2 - PADDLE_H / 2;
  p2y = p1y;
  score_p1 = 0; score_p2 = 0;
  serve_ball(0);
}

void main(void) {
  uint8_t i;
  gg_vdp_init();
  gg_load_palette(palette);
  gg_load_tiles(0x0000, bg_tiles, 96);      /* BG court tiles -> BG bank $0000 */
  gg_load_tiles(0x2000, tile_solid, 32);    /* paddle/ball sprite tile -> $2000 */
  {
    uint8_t r, c;
    for (r = 0; r < 28; r++) for (c = 0; c < 32; c++) gg_set_tilemap_cell(r, c, 0, 0);
  }
  draw_court();
  gg_sprite_init();
  sfx_init();
  music_init();
  music_play(0);   /* continuous background music ("no sound" was the playtest verdict) */
  gg_vdp_display_on();

  reset_match();

  do {
    uint8_t p1;
    uint8_t slot;
    int16_t target;
    gg_vblank_wait();
    sfx_update();
    music_update();

    /* Stage SAT first — uploaded at vblank. */
    slot = 0;
    /* Left paddle = 3 stacked 8×8 sprites */
    for (i = 0; i < PADDLE_H / 8; i++)
      gg_sprite_set(slot++, PADDLE_X1, (uint8_t)(p1y + i * 8), 0);
    /* Right paddle */
    for (i = 0; i < PADDLE_H / 8; i++)
      gg_sprite_set(slot++, PADDLE_X2, (uint8_t)(p2y + i * 8), 0);
    /* Ball */
    gg_sprite_set(slot++, (uint8_t)bx, (uint8_t)by, 0);
    gg_sat_upload();

    p1 = gg_joypad_read();

    if ((p1 & JOY_UP)   && p1y > COURT_TOP)            p1y -= 2;
    if ((p1 & JOY_DOWN) && p1y < COURT_BOT - PADDLE_H) p1y += 2;

    /* GG has only one controller — the right paddle is always AI. */
    target = by - PADDLE_H / 2;
    if (p2y < target && p2y < COURT_BOT - PADDLE_H) p2y += 1;
    else if (p2y > target && p2y > COURT_TOP)       p2y -= 1;

    if (serve_timer > 0) {
      serve_timer--;
    } else {
      bx = (int16_t)(bx + bdx);
      by = (int16_t)(by + bdy);
      if (by < COURT_TOP) { by = COURT_TOP; bdy = (int8_t)(-bdy); sfx_tone(1, 300, 2); }
      if (by + BALL_SIZE > COURT_BOT) { by = COURT_BOT - BALL_SIZE; bdy = (int8_t)(-bdy); sfx_tone(1, 300, 2); }

      if (bdx < 0
          && bx <= PADDLE_X1 + 8
          && bx + BALL_SIZE >= PADDLE_X1
          && by + BALL_SIZE > p1y
          && by < p1y + PADDLE_H) {
        bdx = (int8_t)(-bdx);
        bx = PADDLE_X1 + 8;
        sfx_tone(0, 250, 3);
      }
      if (bdx > 0
          && bx + BALL_SIZE >= PADDLE_X2
          && bx <= PADDLE_X2 + 8
          && by + BALL_SIZE > p2y
          && by < p2y + PADDLE_H) {
        bdx = (int8_t)(-bdx);
        bx = PADDLE_X2 - BALL_SIZE;
        sfx_tone(0, 250, 3);
      }

      if (bx < VIS_X0)        { if (score_p2 < 9) score_p2++; sfx_noise(20); serve_ball(0); }
      if (bx > VIS_X1 - BALL_SIZE) { if (score_p1 < 9) score_p1++; sfx_tone(0, 180, 16); serve_ball(1); }
    }
  } while (1);
}
