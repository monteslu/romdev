/* ── sports.c — SMS two-player Pong scaffold ────────────────────────
 *
 * Two-player Pong on the SMS. Both controller ports are wired:
 *   Player 1 (PORT_JOY_A low 6 bits) — UP/DOWN moves left paddle
 *   Player 2 (PORT_JOY_A high 2 bits + PORT_JOY_B low 4 bits) — UP/DOWN
 *     moves right paddle. SMS splits P2 awkwardly across two ports;
 *     sms_joypad_read_p2() reassembles into the same bit layout as P1.
 *
 * When no P2 controller is plugged in, the right paddle falls back to
 * "chase the ball" AI so the game is still playable solo.
 *
 * Designed for the romdev playtest window — plug in a second pad
 * mid-session and player 2 starts working without a restart.
 */
#include "sms_hw.h"
#include "sms_sfx.h"
#include <stdint.h>

extern void    sms_vdp_init(void);
extern void    sms_vdp_display_on(void);
extern void    sms_load_palette(const uint8_t *palette);
extern void    sms_load_tiles(uint16_t vram_dest, const uint8_t *src, uint16_t byte_count);
extern void    sms_set_tilemap_cell(uint8_t row, uint8_t col, uint8_t tile_idx, uint8_t attr);
extern void    sms_vblank_wait(void);
extern uint8_t sms_joypad_read(void);
extern uint8_t sms_joypad_read_p2(void);
extern void    sms_sprite_init(void);
extern void    sms_sprite_set(uint8_t slot, uint8_t x, uint8_t y, uint8_t tile);
extern void    sms_sat_upload(void);

#define COURT_TOP   8
#define COURT_BOT   184
#define PADDLE_H    24
#define BALL_SIZE   8
#define PADDLE_X1   16
#define PADDLE_X2   232

static const uint8_t palette[32] = {
  /* BG: 0 = backdrop, 1 = court green, 2 = court line / net white */
  0x10, 0x08, 0x3F, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  /* Sprite palette: white at idx 1 */
  0x00, 0x3F, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};

static const uint8_t tile_solid[32] = {
  0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00,
  0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00,
  0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00,
  0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00,
};

/* Three BG tiles for the court, loaded into the BG tile bank at $0000:
 *   tile 0 = court green (solid colour 1)
 *   tile 1 = court line / border (solid colour 2 = white)
 *   tile 2 = dashed net (colour 2 vertical stripe on green) */
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

/* Paint the whole 32x24 court: green field, white top/bottom border lines,
 * and a dashed net down the centre column. BG tile bank is $0000. */
static void draw_court(void) {
  uint8_t row, col;
  for (row = 0; row < 24; row++) {
    for (col = 0; col < 32; col++) {
      uint8_t t = 0;                              /* green field          */
      if (row <= 1 || row >= 22) t = 1;           /* white top/bottom lines */
      else if (col == 1 || col == 30) t = 1;      /* white sidelines        */
      else if (col == 16) t = 2;                  /* solid centre net       */
      sms_set_tilemap_cell(row, col, t, 0);
    }
  }
}

static int16_t p1y, p2y, bx, by;
static int8_t  bdx, bdy;
static uint8_t score_p1, score_p2;
static uint8_t serve_timer;

static void serve_ball(uint8_t to_left) {
  bx = 124;
  by = 90;
  bdx = to_left ? -2 : 2;
  bdy = ((score_p1 + score_p2) & 1) ? -1 : 1;
  serve_timer = 30;
}

static void reset_match(void) {
  p1y = 84; p2y = 84;
  score_p1 = 0; score_p2 = 0;
  serve_ball(0);
}

void main(void) {
  uint8_t i;
  sms_vdp_init();
  sms_load_palette(palette);
  sms_load_tiles(0x0000, bg_tiles, 96);     /* BG court tiles -> BG bank $0000 */
  sms_load_tiles(0x2000, tile_solid, 32);   /* paddle/ball sprite tile -> $2000 */
  draw_court();
  sms_sprite_init();
  sfx_init();
  sms_vdp_display_on();

  reset_match();

  do {
    uint8_t p1, p2;
    uint8_t slot;
    sms_vblank_wait();
    sfx_update();

    /* Stage SAT first — uploaded at vblank. */
    slot = 0;
    /* Left paddle = 3 stacked 8×8 sprites */
    for (i = 0; i < PADDLE_H / 8; i++)
      sms_sprite_set(slot++, PADDLE_X1, (uint8_t)(p1y + i * 8), 0);
    /* Right paddle */
    for (i = 0; i < PADDLE_H / 8; i++)
      sms_sprite_set(slot++, PADDLE_X2, (uint8_t)(p2y + i * 8), 0);
    /* Ball */
    sms_sprite_set(slot++, (uint8_t)bx, (uint8_t)by, 0);
    sms_sat_upload();

    p1 = sms_joypad_read();
    p2 = sms_joypad_read_p2();

    if ((p1 & JOY_UP)   && p1y > COURT_TOP)            p1y -= 2;
    if ((p1 & JOY_DOWN) && p1y < COURT_BOT - PADDLE_H) p1y += 2;

    /* P2 input if any, otherwise AI. */
    if (p2 != 0) {
      if ((p2 & JOY_UP)   && p2y > COURT_TOP)            p2y -= 2;
      if ((p2 & JOY_DOWN) && p2y < COURT_BOT - PADDLE_H) p2y += 2;
    } else {
      int16_t target = by - PADDLE_H / 2;
      if (p2y < target && p2y < COURT_BOT - PADDLE_H) p2y += 1;
      else if (p2y > target && p2y > COURT_TOP)       p2y -= 1;
    }

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

      if (bx < 4)   { if (score_p2 < 9) score_p2++; sfx_noise(20); serve_ball(0); }
      if (bx > 252) { if (score_p1 < 9) score_p1++; sfx_tone(0, 180, 16); serve_ball(1); }
    }
  } while (1);
}
