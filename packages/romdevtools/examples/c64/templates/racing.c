// ── racing.c — Commodore 64 top-down racing scaffold ─────────────────
//
// 3-lane endless racer. Player car at the bottom; obstacles spawn from
// top and slide down. LEFT/RIGHT switches lanes. Joystick port 2.

#include "c64_registers.h"
#include "c64_sfx.h"
#include <stdint.h>

#define POKE(addr, val) (*(volatile uint8_t*)(addr) = (val))
#define PEEK(addr)      (*(volatile uint8_t*)(addr))

#define JOY_LEFT  0x04
#define JOY_RIGHT 0x08

#define SPRITE_POINTERS ((volatile uint8_t*)0x07F8)

#define MAX_OBS 4
#define LANE0_X 88
#define LANE1_X 152
#define LANE2_X 216

static const uint8_t lane_x[3] = { LANE0_X, LANE1_X, LANE2_X };

/* Filled car-shaped sprite. */
static const uint8_t car_sprite[64] = {
  0,0,0, 0x00,0x7E,0x00, 0x00,0xFF,0x00, 0x01,0xFF,0x80,
  0x01,0xFF,0x80, 0x01,0xFF,0x80, 0x03,0xFF,0xC0, 0x07,0xFF,0xE0,
  0x07,0xE7,0xE0, 0x07,0xC3,0xE0, 0x07,0xC3,0xE0, 0x07,0xFF,0xE0,
  0x07,0xFF,0xE0, 0x07,0xE7,0xE0, 0x07,0xC3,0xE0, 0x07,0xC3,0xE0,
  0x07,0xC3,0xE0, 0x07,0xC3,0xE0, 0x07,0xFF,0xE0, 0x07,0xFF,0xE0,
  0x03,0xFF,0xC0, 0,
};

typedef struct { uint8_t x, y, alive; } Car;

static Car player;
static Car obstacles[MAX_OBS];
static uint8_t spawn_timer;
static uint8_t player_lane = 1;
static uint8_t prev_pad;
static uint8_t game_over_timer;
static uint32_t rng = 1;

static void wait_vblank(void) {
  while (PEEK(VIC_RASTER) < 250) { }
  while (PEEK(VIC_RASTER) >= 250) { }
}

static void copy_sprite(uint8_t slot, const uint8_t *data) {
  uint8_t i;
  volatile uint8_t *dst = (volatile uint8_t*)(0x2000 + slot * 64);  /* $2000, not $0800 (collides w/ $0801 .prg) */
  for (i = 0; i < 64; i++) dst[i] = data[i];
}

static void spawn(void) {
  uint8_t i;
  rng = rng * 1103515245u + 12345u;
  for (i = 0; i < MAX_OBS; i++) {
    if (!obstacles[i].alive) {
      obstacles[i].x = lane_x[(rng >> 16) % 3];
      obstacles[i].y = 50;
      obstacles[i].alive = 1;
      return;
    }
  }
}

static uint8_t aabb(Car *a, Car *b) {
  return a->x < b->x + 24 && a->x + 24 > b->x
      && a->y < b->y + 24 && a->y + 24 > b->y;
}

void main(void) {
  uint8_t i, pad;
  POKE(VIC_SPR_ENA, 0);
  copy_sprite(0, car_sprite);
  SPRITE_POINTERS[0] = 0x80;  /* $2000/64 */
  for (i = 0; i < MAX_OBS; i++) SPRITE_POINTERS[1 + i] = 0x80;
  POKE(VIC_SPR_COL(0), 0x07);  /* yellow player */
  for (i = 0; i < MAX_OBS; i++) POKE(VIC_SPR_COL(1 + i), 0x02);  /* red obstacles */
  POKE(VIC_BORDER, 0x00);
  POKE(VIC_BG0,    0x09);  /* brown road */

  player.x = LANE1_X; player.y = 220; player.alive = 1;
  for (i = 0; i < MAX_OBS; i++) obstacles[i].alive = 0;
  spawn_timer = 0;
  game_over_timer = 0;
  sfx_init();
  POKE(VIC_SPR_ENA, 0x1F);

  for (;;) {
    pad = (uint8_t)(~PEEK(CIA1_PRA) & 0x1F);
    wait_vblank();
    sfx_update();

    if (game_over_timer > 0) {
      game_over_timer--;
      if (game_over_timer == 0) {
        for (i = 0; i < MAX_OBS; i++) obstacles[i].alive = 0;
        player_lane = 1;
        player.x = LANE1_X;
      }
    } else {
      if ((pad & JOY_LEFT)  && !(prev_pad & JOY_LEFT)  && player_lane > 0) {
        player_lane--; sfx_tone(1, 0x40, 0x18, 2);
      }
      if ((pad & JOY_RIGHT) && !(prev_pad & JOY_RIGHT) && player_lane < 2) {
        player_lane++; sfx_tone(1, 0x40, 0x18, 2);
      }
      player.x = lane_x[player_lane];
      prev_pad = pad;

      for (i = 0; i < MAX_OBS; i++) {
        if (!obstacles[i].alive) continue;
        obstacles[i].y += 2;
        if (obstacles[i].y >= 245) obstacles[i].alive = 0;
      }
      spawn_timer++;
      if (spawn_timer >= 40) { spawn_timer = 0; spawn(); }

      for (i = 0; i < MAX_OBS; i++) {
        if (obstacles[i].alive && aabb(&player, &obstacles[i])) {
          game_over_timer = 60;
          sfx_noise(40);
          break;
        }
      }
    }

    POKE(VIC_SPRITE_X(0), player.x);
    POKE(VIC_SPRITE_Y(0), player.y);
    for (i = 0; i < MAX_OBS; i++) {
      uint8_t ox = obstacles[i].alive ? obstacles[i].x : 0;
      uint8_t oy = obstacles[i].alive ? obstacles[i].y : 0;
      POKE(VIC_SPRITE_X(1 + i), ox);
      POKE(VIC_SPRITE_Y(1 + i), oy);
    }
  }
}
