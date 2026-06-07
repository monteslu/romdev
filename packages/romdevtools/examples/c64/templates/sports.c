// ── sports.c — Commodore 64 Pong scaffold ────────────────────────────
//
// Two-paddle Pong using 3 hardware sprites (left paddle, right paddle,
// ball). Joystick port 2 = P1 left paddle. P2 (port 1) AI tracks the ball
// since port 1 conflicts with the keyboard matrix in headless mode.

#include "c64_registers.h"
#include "c64_sfx.h"
#include <stdint.h>

#define POKE(addr, val) (*(volatile uint8_t*)(addr) = (val))
#define PEEK(addr)      (*(volatile uint8_t*)(addr))

#define JOY_UP    0x01
#define JOY_DOWN  0x02

#define SPRITE_POINTERS ((volatile uint8_t*)0x07F8)

/* 8x21 tall thin paddle. */
static const uint8_t paddle_sprite[64] = {
  0xFF,0x00,0x00, 0xFF,0x00,0x00, 0xFF,0x00,0x00, 0xFF,0x00,0x00,
  0xFF,0x00,0x00, 0xFF,0x00,0x00, 0xFF,0x00,0x00, 0xFF,0x00,0x00,
  0xFF,0x00,0x00, 0xFF,0x00,0x00, 0xFF,0x00,0x00, 0xFF,0x00,0x00,
  0xFF,0x00,0x00, 0xFF,0x00,0x00, 0xFF,0x00,0x00, 0xFF,0x00,0x00,
  0xFF,0x00,0x00, 0xFF,0x00,0x00, 0xFF,0x00,0x00, 0xFF,0x00,0x00,
  0xFF,0x00,0x00, 0,
};
/* 8x8 ball. */
static const uint8_t ball_sprite[64] = {
  0x3C,0,0, 0x7E,0,0, 0xFF,0,0, 0xFF,0,0,
  0xFF,0,0, 0xFF,0,0, 0x7E,0,0, 0x3C,0,0,
  0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0,
  0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0,
  0,0,0, 0,
};

static void wait_vblank(void) {
  while (PEEK(VIC_RASTER) < 250) { }
  while (PEEK(VIC_RASTER) >= 250) { }
}

static void copy_sprite(uint8_t slot, const uint8_t *data) {
  uint8_t i;
  volatile uint8_t *dst = (volatile uint8_t*)(0x2000 + slot * 64);  /* $2000, not $0800 (collides w/ $0801 .prg) */
  for (i = 0; i < 64; i++) dst[i] = data[i];
}

void main(void) {
  uint8_t p1y = 130, p2y = 130;
  int16_t bx = 150, by = 130;
  int8_t bdx = 2, bdy = 1;
  uint8_t pad;
  uint8_t p1_score = 0, p2_score = 0;

  POKE(VIC_SPR_ENA, 0);
  copy_sprite(0, paddle_sprite);
  copy_sprite(1, paddle_sprite);
  copy_sprite(2, ball_sprite);
  SPRITE_POINTERS[0] = 0x80;  /* $2000/64 */
  SPRITE_POINTERS[1] = 0x81;
  SPRITE_POINTERS[2] = 0x82;
  POKE(VIC_SPR_COL(0), 0x01);  /* white */
  POKE(VIC_SPR_COL(1), 0x01);
  POKE(VIC_SPR_COL(2), 0x07);  /* yellow ball */

  POKE(VIC_BORDER, 0x00);
  POKE(VIC_BG0,    0x00);

  /* P1 paddle on left, P2 on right. */
  POKE(VIC_SPRITE_X(0), 30);
  POKE(VIC_SPRITE_X(1), 240);

  sfx_init();
  POKE(VIC_SPR_ENA, 0x07);

  for (;;) {
    pad = (uint8_t)(~PEEK(CIA1_PRA) & 0x1F);
    wait_vblank();
    sfx_update();

    if (pad & JOY_UP   && p1y > 60)  p1y -= 3;
    if (pad & JOY_DOWN && p1y < 220) p1y += 3;

    /* AI right paddle tracks ball. */
    if (p2y + 10 < by && p2y < 220) p2y += 2;
    else if (p2y + 10 > by && p2y > 60) p2y -= 2;

    bx += bdx;
    by += bdy;
    if (by < 55)  { by = 55;  bdy = -bdy; sfx_tone(2, 0x80, 0x18, 2); }
    if (by > 240) { by = 240; bdy = -bdy; sfx_tone(2, 0x80, 0x18, 2); }
    /* Paddle 1 collision */
    if (bdx < 0 && bx < 40 && bx > 24 && by > p1y - 8 && by < p1y + 22) {
      bdx = -bdx; sfx_tone(0, 0x40, 0x20, 3);
    }
    /* Paddle 2 collision */
    if (bdx > 0 && bx > 232 && bx < 248 && by > p2y - 8 && by < p2y + 22) {
      bdx = -bdx; sfx_tone(0, 0x40, 0x20, 3);
    }
    /* Score */
    if (bx < 5)   { p2_score++; if (p2_score > 9) p2_score = 0; sfx_noise(20); bx = 150; by = 130; bdx = 2; }
    if (bx > 250) { p1_score++; if (p1_score > 9) p1_score = 0; sfx_tone(0, 0x80, 0x10, 16); bx = 150; by = 130; bdx = -2; }

    POKE(VIC_SPRITE_Y(0), p1y);
    POKE(VIC_SPRITE_Y(1), p2y);
    POKE(VIC_SPRITE_X(2), (uint8_t)bx);
    POKE(VIC_SPRITE_Y(2), (uint8_t)by);
  }
}
