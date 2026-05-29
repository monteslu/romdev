/* ── sports.c — NES two-player Pong scaffold ─────────────────────────
 *
 * A complete two-player Pong baseline. Both ports are wired:
 *   - Port 0 (player 1, left paddle) — UP/DOWN move
 *   - Port 1 (player 2, right paddle) — UP/DOWN move
 *   - Ball bounces off paddles + top/bottom walls
 *   - Miss → ball respawns at centre, opponent scores
 *   - Per-side score in the top corners as ASCII digits via OAM
 *
 * Designed for the rom-dev-mcp playtest window: with two USB
 * controllers plugged in, both players can play live. With one
 * controller, the keyboard arrow keys drive port 0 (player 1) and
 * port 1 acts as a wall-bot AI so single-player still works.
 *
 * Frame budget (NTSC): 60 fps × paddle moves × 1 ball update +
 * 2 collision checks = negligible. Easily fits in vblank.
 *
 * Read TROUBLESHOOTING.md before editing — same NES gotchas as the
 * other scaffolds (two-vblank PPU warm-up, shadow_oam staging, palette
 * at $3F00).
 */

#include "nes_runtime.h"

/* ── Tile data ────────────────────────────────────────────────────── */
static const uint8_t tile_blank[16]  = { 0 };
/* 8×8 paddle = solid white column (4 pixels wide centered) */
static const uint8_t tile_paddle[16] = {
  0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C,
  0,    0,    0,    0,    0,    0,    0,    0,
};
/* 8×8 ball = small filled box */
static const uint8_t tile_ball[16] = {
  0x00, 0x3C, 0x7E, 0x7E, 0x7E, 0x7E, 0x3C, 0x00,
  0,    0,    0,    0,    0,    0,    0,    0,
};
/* Digits 0-9 (3 wide × 5 tall, padded to 8×8). Used for the score HUD. */
static const uint8_t tile_digits[10 * 16] = {
  /* 0 */ 0xE0,0xA0,0xA0,0xA0,0xE0,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 1 */ 0x40,0xC0,0x40,0x40,0xE0,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 2 */ 0xE0,0x20,0xE0,0x80,0xE0,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 3 */ 0xE0,0x20,0xE0,0x20,0xE0,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 4 */ 0xA0,0xA0,0xE0,0x20,0x20,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 5 */ 0xE0,0x80,0xE0,0x20,0xE0,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 6 */ 0xE0,0x80,0xE0,0xA0,0xE0,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 7 */ 0xE0,0x20,0x20,0x40,0x40,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 8 */ 0xE0,0xA0,0xE0,0xA0,0xE0,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 9 */ 0xE0,0xA0,0xE0,0x20,0xE0,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
};

/* Tile indices (after upload to CHR-RAM at slot 0..). */
#define T_BLANK   0
#define T_PADDLE  1
#define T_BALL    2
#define T_DIGIT0  3   /* digits live at slots 3..12 */

static const uint8_t palette[32] = {
  /* BG palettes — only the backdrop matters here */
  0x0F, 0x30, 0x10, 0x00,
  0x0F, 0x30, 0x10, 0x00,
  0x0F, 0x30, 0x10, 0x00,
  0x0F, 0x30, 0x10, 0x00,
  /* Sprite palettes */
  0x0F, 0x30, 0x16, 0x12,  /* sp0: white paddle */
  0x0F, 0x30, 0x16, 0x12,  /* sp1: white ball   */
  0x0F, 0x30, 0x16, 0x12,
  0x0F, 0x30, 0x16, 0x12,
};

/* Game state (fixed-point Y in 1/16-px units). */
static int16_t p1y, p2y;       /* paddle top Y in pixels */
static int16_t bx, by;         /* ball x, y in pixels */
static int8_t  bdx, bdy;       /* ball velocity */
static uint8_t score_p1, score_p2;
static uint8_t serve_timer;

#define PADDLE_H   24
#define PADDLE_X1  16
#define PADDLE_X2  232
#define COURT_TOP  16
#define COURT_BOT  216
#define BALL_W     8
#define BALL_H     8

static void serve_ball(uint8_t to_left) {
  bx = 128;
  by = 112;
  bdx = to_left ? -2 : 2;
  /* Alternate vertical direction each serve. */
  bdy = (score_p1 + score_p2) & 1 ? -1 : 1;
  serve_timer = 30;
}

static void reset_match(void) {
  p1y = 100; p2y = 100;
  score_p1 = 0; score_p2 = 0;
  serve_ball(0);
}

void main(void) {
  uint8_t i;
  uint8_t p1, p2;

  ppu_off();

  /* Upload tiles. */
  chr_ram_upload(T_BLANK   * 16, tile_blank,  16);
  chr_ram_upload(T_PADDLE  * 16, tile_paddle, 16);
  chr_ram_upload(T_BALL    * 16, tile_ball,   16);
  chr_ram_upload(T_DIGIT0  * 16, tile_digits, sizeof(tile_digits));

  palette_load(palette);
  oam_clear();
  ppu_on_all();
  sound_init();

  reset_match();

  for (;;) {
    /* Stage OAM. Paddles are 3 sprites stacked (24px tall = 3×8).
     * Ball is one sprite. Score digits use 1 sprite each. */
    oam_clear();
    /* Paddle 1 — left side */
    for (i = 0; i < PADDLE_H / 8; i++)
      oam_spr(PADDLE_X1, (uint8_t)(p1y + i * 8), T_PADDLE, 0);
    /* Paddle 2 — right side */
    for (i = 0; i < PADDLE_H / 8; i++)
      oam_spr(PADDLE_X2, (uint8_t)(p2y + i * 8), T_PADDLE, 1);
    /* Ball */
    oam_spr((uint8_t)bx, (uint8_t)by, T_BALL, 0);
    /* Scores — single digit each (0..9 only; extend if you want
     * multi-digit). */
    oam_spr(48,  4, (uint8_t)(T_DIGIT0 + score_p1), 0);
    oam_spr(200, 4, (uint8_t)(T_DIGIT0 + score_p2), 1);

    ppu_wait_nmi();

    /* ── Input ────────────────────────────────────────────────── */
    p1 = pad_poll(0);
    p2 = pad_poll(1);

    if (p1 & PAD_UP    && p1y > COURT_TOP) p1y -= 2;
    if (p1 & PAD_DOWN  && p1y < COURT_BOT - PADDLE_H) p1y += 2;

    /* Wall-bot AI on port 1 when no second controller — pad_poll(1)
     * returns 0 when no controller is connected. Detect by sampling
     * a few frames; here we simply fall back to AI when no buttons
     * are ever pressed. Simpler: always run AI as a *fallback*
     * — if p2 pressed anything this frame, use the human input. */
    if (p2 != 0) {
      if (p2 & PAD_UP    && p2y > COURT_TOP) p2y -= 2;
      if (p2 & PAD_DOWN  && p2y < COURT_BOT - PADDLE_H) p2y += 2;
    } else {
      /* AI: chase the ball Y, biased toward ball-direction. */
      int16_t target = by - PADDLE_H / 2;
      if (p2y < target && p2y < COURT_BOT - PADDLE_H) p2y += 1;
      else if (p2y > target && p2y > COURT_TOP)       p2y -= 1;
    }

    /* ── Ball update ──────────────────────────────────────────── */
    if (serve_timer > 0) {
      serve_timer--;
    } else {
      bx += bdx;
      by += bdy;

      /* Top/bottom wall bounce. */
      if (by < COURT_TOP) { by = COURT_TOP; bdy = -bdy; sound_play_tone(1, 0x100, 8, 4); }
      if (by + BALL_H > COURT_BOT) { by = COURT_BOT - BALL_H; bdy = -bdy; sound_play_tone(1, 0x100, 8, 4); }

      /* Paddle 1 collision (left). */
      if (bdx < 0
          && bx <= PADDLE_X1 + 8
          && bx + BALL_W >= PADDLE_X1
          && by + BALL_H > p1y
          && by < p1y + PADDLE_H) {
        bdx = -bdx;
        bx = PADDLE_X1 + 8;
        sound_play_tone(0, 0x150, 8, 4);
      }
      /* Paddle 2 collision (right). */
      if (bdx > 0
          && bx + BALL_W >= PADDLE_X2
          && bx <= PADDLE_X2 + 8
          && by + BALL_H > p2y
          && by < p2y + PADDLE_H) {
        bdx = -bdx;
        bx = PADDLE_X2 - BALL_W;
        sound_play_tone(0, 0x150, 8, 4);
      }

      /* Score: ball off either side. */
      if (bx < 4) {
        if (score_p2 < 9) score_p2++;
        sound_play_noise(5, 8, 8);
        serve_ball(0);
      }
      if (bx > 252) {
        if (score_p1 < 9) score_p1++;
        sound_play_noise(5, 8, 8);
        serve_ball(1);
      }
    }
  }
}
