/* ── sports.c — Game Boy Pong scaffold (player-vs-AI) ─────────────────
 *
 * The Game Boy hardware has ONE controller port — no native two-player
 * support without the Link Cable + custom serial code. So "sports" on
 * GB is single-controller player-vs-AI Pong: left paddle is the human
 * (UP/DOWN on port 0), right paddle chases the ball.
 *
 * Same gameplay shape as the NES / SMS / Genesis 2P versions — just
 * with the AI permanently driving port 1.
 *
 * Game Boy screen is 160×144. Court spans the full visible area.
 */

#include "gb_hardware.h"
#include "gb_runtime.h"

#define COURT_TOP   8
#define COURT_BOT   136
#define PADDLE_H    16
#define BALL_SIZE   8
#define PADDLE_X1   16
#define PADDLE_X2   136

static const uint8_t tile_blank[16] = { 0 };
/* Solid 8×8 block (white on DMG, colour 1 on CGB). */
static const uint8_t tile_solid[16] = {
  0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
  0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
};

/* ── BG tiles (the court) ──────────────────────────────────────────────
 * A real playfield behind the paddles so the screen is never one flat
 * colour (LCDC_BG_ON below — drop it and it reads as blank, the #1 GB
 * "why is it blank" footgun).
 *   tile_court  — a 50/50 dither of colour 0 + colour 1 (the turf), so even
 *                 an empty patch mixes two shades and never dominates.
 *   tile_net    — a dashed vertical centre-net stripe (colour 2).
 *   tile_wall   — a solid colour-2 border for the top / bottom rails. */
static const uint8_t tile_court[16] = {
  0x55,0x55, 0xAA,0xAA, 0x55,0x55, 0xAA,0xAA,
  0x55,0x55, 0xAA,0xAA, 0x55,0x55, 0xAA,0xAA,
};
static const uint8_t tile_net[16] = {
  0x18,0x18, 0x18,0x18, 0x00,0x00, 0x00,0x00,
  0x18,0x18, 0x18,0x18, 0x00,0x00, 0x00,0x00,
};
static const uint8_t tile_wall[16] = {
  0x00,0x00, 0xFF,0xFF, 0xFF,0xFF, 0x00,0x00,
  0x00,0x00, 0xFF,0xFF, 0xFF,0xFF, 0x00,0x00,
};
#define T_COURT 2
#define T_NET   3
#define T_WALL  4

static const uint16_t obj_palette[4] = { 0x7FFF, 0x001F, 0x03E0, 0x7C00 };

static int16_t p1y, p2y, bx, by;
static int8_t  bdx, bdy;
static uint8_t score_p1, score_p2;
static uint8_t serve_timer;

static void serve_ball(uint8_t to_left) {
  bx = 76;
  by = 68;
  bdx = to_left ? -2 : 2;
  bdy = ((score_p1 + score_p2) & 1) ? -1 : 1;
  serve_timer = 30;
}

static void reset_match(void) {
  p1y = 64;
  p2y = 64;
  score_p1 = 0;
  score_p2 = 0;
  serve_ball(0);
}

static void upload_tile(uint8_t slot, const uint8_t *src) {
  uint8_t *dst = (uint8_t *)(0x8000 + slot * 16);
  /* memcpy_vram (pointer-walk) — NOT an indexed dst[i]=src[i] loop, which
   * SDCC sm83 miscompiles when dst points into VRAM ($8000-$9FFF). */
  memcpy_vram(dst, src, 16);
}

/* Paint the Pong court into BG map 0 ($9800): dithered turf everywhere,
 * solid top/bottom rails, and a dashed net down the centre column. */
static void draw_court(void) {
  uint8_t *bg = BG_MAP_0;
  uint8_t r, c, t;
  for (r = 0; r < 18; r++) {
    for (c = 0; c < 20; c++) {
      if (r == 0 || r == 17)      t = T_WALL;          /* top / bottom rail */
      else if (c == 9 || c == 10) t = (r & 1) ? T_NET : T_COURT; /* net dashes */
      else                        t = T_COURT;
      bg[r * 32 + c] = t;
    }
  }
}

void main(void) {
  uint8_t pad;
  uint8_t i;
  int16_t target;

  lcd_init_default();
  LCDC = 0;

  upload_tile(0, tile_blank);
  upload_tile(1, tile_solid);
  upload_tile(T_COURT, tile_court);
  upload_tile(T_NET,   tile_net);
  upload_tile(T_WALL,  tile_wall);

  /* DMG BG palette: 0 dark, 1 mid, 2 light, 3 white — the dithered turf
   * mixes shades 0+1, rails/net use shade 2. */
  BGP = 0xE4;

  OCPS = 0x80;
  for (i = 0; i < 4; i++) {
    OCPD = (uint8_t)(obj_palette[i] & 0xFF);
    OCPD = (uint8_t)((obj_palette[i] >> 8) & 0xFF);
  }

  draw_court();
  oam_clear();
  LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO;
  sound_init();

  reset_match();

  while (1) {
    wait_vblank();

    /* Stage OAM: left paddle (2 stacked), right paddle (2 stacked), ball. */
    for (i = 0; i < 40; i++) oam_set(i, 0, 0, 0, 0);
    oam_set(0, (uint8_t)(p1y + 16),         (uint8_t)(PADDLE_X1 + 8), 1, 0);
    oam_set(1, (uint8_t)(p1y + 16 + 8),     (uint8_t)(PADDLE_X1 + 8), 1, 0);
    oam_set(2, (uint8_t)(p2y + 16),         (uint8_t)(PADDLE_X2 + 8), 1, 0);
    oam_set(3, (uint8_t)(p2y + 16 + 8),     (uint8_t)(PADDLE_X2 + 8), 1, 0);
    oam_set(4, (uint8_t)(by + 16),          (uint8_t)(bx + 8),        1, 0);
    oam_dma_flush();

    pad = joypad_read();
    if (pad & PAD_UP    && p1y > COURT_TOP)            p1y -= 2;
    if (pad & PAD_DOWN  && p1y < COURT_BOT - PADDLE_H) p1y += 2;

    /* Right-paddle AI — chase ball Y. */
    target = by - PADDLE_H / 2;
    if (p2y < target && p2y < COURT_BOT - PADDLE_H) p2y += 1;
    else if (p2y > target && p2y > COURT_TOP)       p2y -= 1;

    if (serve_timer > 0) {
      serve_timer--;
    } else {
      bx = (int16_t)(bx + bdx);
      by = (int16_t)(by + bdy);

      if (by < COURT_TOP)             { by = COURT_TOP; bdy = (int8_t)(-bdy); }
      if (by + BALL_SIZE > COURT_BOT) { by = COURT_BOT - BALL_SIZE; bdy = (int8_t)(-bdy); }

      if (bdx < 0
          && bx <= PADDLE_X1 + 8
          && bx + BALL_SIZE >= PADDLE_X1
          && by + BALL_SIZE > p1y
          && by < p1y + PADDLE_H) {
        bdx = (int8_t)(-bdx);
        bx = PADDLE_X1 + 8;
        sound_play_tone(2, 1900, 4);
      }
      if (bdx > 0
          && bx + BALL_SIZE >= PADDLE_X2
          && bx <= PADDLE_X2 + 8
          && by + BALL_SIZE > p2y
          && by < p2y + PADDLE_H) {
        bdx = (int8_t)(-bdx);
        bx = PADDLE_X2 - BALL_SIZE;
        sound_play_tone(2, 1900, 4);
      }

      if (bx < 4)   { if (score_p2 < 9) score_p2++; sound_play_noise(8); serve_ball(0); }
      if (bx > 156) { if (score_p1 < 9) score_p1++; sound_play_noise(8); serve_ball(1); }
    }
  }
}
