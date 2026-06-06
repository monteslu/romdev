// ── shmup.c — Commodore 64 vertical-shooter scaffold ─────────────────
//
// Cross-platform shmup shape: player + 4 bullets + 4 enemies (pool),
// wave spawner, AABB collisions, SID sound effects on fire + hit.
//
// VIC-II hardware sprites give us up to 8 MOBs — we use 1 player +
// 4 bullets + 4 enemies = 9, so we double-up: the four bullets share
// sprite slots 1-4 in time-multiplexed style — actually we keep it
// honest by allocating only 8 slots (player + 3 bullets + 4 enemies)
// to demonstrate the C64's tight sprite budget.
//
// Joystick port 2 drives the player (CIA1_PRA via the standard C64
// idiom — port 1 conflicts with the keyboard scan matrix).

#include "c64_registers.h"
#include "c64_sfx.h"
#include <stdint.h>

#define POKE(addr, val) (*(volatile uint8_t*)(addr) = (val))
#define PEEK(addr)      (*(volatile uint8_t*)(addr))

#define SPRITE_POINTERS  ((volatile uint8_t*)0x07F8)
#define SPRITE_DATA_BASE 0x0800  /* sprite N data at $0800 + N*64 */

#define JOY_UP    0x01
#define JOY_DOWN  0x02
#define JOY_LEFT  0x04
#define JOY_RIGHT 0x08
#define JOY_FIRE  0x10

#define MAX_BULLETS 3
#define MAX_ENEMIES 4

/* 8 hardware sprite slots:
 *   0       player
 *   1..3    bullets
 *   4..7    enemies */
#define SLOT_PLAYER  0
#define SLOT_BULLET0 1
#define SLOT_ENEMY0  4

static const uint8_t ship_sprite[64] = {
  0x00,0x18,0x00, 0x00,0x3C,0x00, 0x00,0x7E,0x00, 0x00,0xFF,0x00,
  0x01,0xFF,0x80, 0x03,0xFF,0xC0, 0x07,0xFF,0xE0, 0x0F,0x18,0xF0,
  0x1F,0x18,0xF8, 0x3F,0xFF,0xFC, 0x7F,0xFF,0xFE, 0x7F,0xFF,0xFE,
  0x7F,0xFF,0xFE, 0x3F,0xFF,0xFC, 0x1F,0xFF,0xF8, 0x0F,0xFF,0xF0,
  0x07,0xFF,0xE0, 0x03,0xFF,0xC0, 0x01,0xFF,0x80, 0x00,0xFF,0x00,
  0x00,0x3C,0x00, 0,
};
static const uint8_t bullet_sprite[64] = {
  0x00,0x18,0x00, 0x00,0x3C,0x00, 0x00,0x3C,0x00, 0x00,0x3C,0x00,
  0x00,0x3C,0x00, 0x00,0x3C,0x00, 0x00,0x3C,0x00, 0x00,0x3C,0x00,
  0x00,0x3C,0x00, 0x00,0x3C,0x00, 0x00,0x18,0x00,
  0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,
};
static const uint8_t enemy_sprite[64] = {
  0xFF,0x81,0xFF, 0x7E,0x42,0x7E, 0x3C,0x24,0x3C, 0x18,0x18,0x18,
  0x3C,0x3C,0x3C, 0x7E,0x66,0x7E, 0xFF,0xC3,0xFF, 0xC3,0x18,0xC3,
  0xC3,0x18,0xC3, 0xC3,0x18,0xC3, 0x18,0x18,0x18, 0x3C,0x3C,0x3C,
  0x7E,0x7E,0x7E, 0xFF,0xFF,0xFF, 0x7E,0x7E,0x7E, 0x3C,0x3C,0x3C,
  0x18,0x18,0x18, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,
};

typedef struct { uint8_t x, y, alive; } Obj;

static Obj player;
static Obj bullets[MAX_BULLETS];
static Obj enemies[MAX_ENEMIES];
static uint8_t spawn_timer;
static uint8_t prev_pad;
static uint16_t score;

static uint8_t aabb(Obj *a, Obj *b) {
  return a->x < b->x + 12 && a->x + 12 > b->x
      && a->y < b->y + 16 && a->y + 16 > b->y;
}

static void fire(void) {
  uint8_t i;
  for (i = 0; i < MAX_BULLETS; i++) {
    if (!bullets[i].alive) {
      bullets[i].x = player.x;
      bullets[i].y = player.y - 10;
      bullets[i].alive = 1;
      return;
    }
  }
}

static void spawn(void) {
  uint8_t i;
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemies[i].alive) {
      enemies[i].x = (uint8_t)(48 + ((spawn_timer * 37) & 0xFF) % 240);
      enemies[i].y = 30;
      enemies[i].alive = 1;
      return;
    }
  }
}

static void wait_vblank(void) {
  while (PEEK(VIC_RASTER) < 250) { }
  while (PEEK(VIC_RASTER) >= 250) { }
}

static void copy_sprite(uint8_t slot, const uint8_t *data) {
  uint8_t i;
  volatile uint8_t *dst = (volatile uint8_t*)(SPRITE_DATA_BASE + slot * 64);
  for (i = 0; i < 64; i++) dst[i] = data[i];
}

void main(void) {
  uint8_t i, j;

  POKE(VIC_SPR_ENA, 0);     /* sprites off while we set up */

  copy_sprite(0, ship_sprite);
  copy_sprite(1, bullet_sprite);
  copy_sprite(2, enemy_sprite);

  /* Sprite pointers: slot N points at /64 index into the VIC bank.
   * Default bank = $0000-$3FFF. $0800 / 64 = 32 = $20. */
  SPRITE_POINTERS[SLOT_PLAYER] = 0x20;
  for (i = 0; i < MAX_BULLETS; i++) SPRITE_POINTERS[SLOT_BULLET0 + i] = 0x21;
  for (i = 0; i < MAX_ENEMIES; i++) SPRITE_POINTERS[SLOT_ENEMY0 + i] = 0x22;

  POKE(VIC_SPR_COL(SLOT_PLAYER), 0x07);  /* yellow */
  for (i = 0; i < MAX_BULLETS; i++) POKE(VIC_SPR_COL(SLOT_BULLET0 + i), 0x01);  /* white */
  for (i = 0; i < MAX_ENEMIES; i++) POKE(VIC_SPR_COL(SLOT_ENEMY0  + i), 0x02);  /* red */

  POKE(VIC_BORDER, 0x00);
  POKE(VIC_BG0, 0x00);

  player.x = 152; player.y = 200; player.alive = 1;
  for (i = 0; i < MAX_BULLETS; i++) bullets[i].alive = 0;
  for (i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = 0;
  score = 0;
  spawn_timer = 0;
  prev_pad = 0;
  sfx_init();

  /* Enable all 8 sprite slots. */
  POKE(VIC_SPR_ENA, 0xFF);

  for (;;) {
    uint8_t pad = (uint8_t)(~PEEK(CIA1_PRA) & 0x1F);
    wait_vblank();
    sfx_update();

    if ((pad & JOY_LEFT)  && player.x > 24)  player.x -= 2;
    if ((pad & JOY_RIGHT) && player.x < 240) player.x += 2;
    if ((pad & JOY_UP)    && player.y > 50)  player.y -= 2;
    if ((pad & JOY_DOWN)  && player.y < 230) player.y += 2;
    if ((pad & JOY_FIRE) && !(prev_pad & JOY_FIRE)) { fire(); sfx_tone(0, 0x80, 0x20, 4); }
    prev_pad = pad;

    for (i = 0; i < MAX_BULLETS; i++) {
      if (!bullets[i].alive) continue;
      if (bullets[i].y < 50) { bullets[i].alive = 0; continue; }
      bullets[i].y -= 4;
    }
    for (i = 0; i < MAX_ENEMIES; i++) {
      if (!enemies[i].alive) continue;
      enemies[i].y += 1;
      if (enemies[i].y >= 245) enemies[i].alive = 0;
    }
    spawn_timer++;
    if (spawn_timer >= 32) { spawn_timer = 0; spawn(); }

    for (i = 0; i < MAX_BULLETS; i++) {
      if (!bullets[i].alive) continue;
      for (j = 0; j < MAX_ENEMIES; j++) {
        if (!enemies[j].alive) continue;
        if (aabb(&bullets[i], &enemies[j])) {
          bullets[i].alive = 0;
          enemies[j].alive = 0;
          if (score < 65500) score += 10;
          sfx_noise(8);
          break;
        }
      }
    }

    /* Stage VIC sprite positions. */
    POKE(VIC_SPRITE_X(SLOT_PLAYER), player.x);
    POKE(VIC_SPRITE_Y(SLOT_PLAYER), player.y);
    for (i = 0; i < MAX_BULLETS; i++) {
      uint8_t sx = bullets[i].alive ? bullets[i].x : 0;
      uint8_t sy = bullets[i].alive ? bullets[i].y : 0;
      POKE(VIC_SPRITE_X(SLOT_BULLET0 + i), sx);
      POKE(VIC_SPRITE_Y(SLOT_BULLET0 + i), sy);
    }
    for (i = 0; i < MAX_ENEMIES; i++) {
      uint8_t ex = enemies[i].alive ? enemies[i].x : 0;
      uint8_t ey = enemies[i].alive ? enemies[i].y : 0;
      POKE(VIC_SPRITE_X(SLOT_ENEMY0 + i), ex);
      POKE(VIC_SPRITE_Y(SLOT_ENEMY0 + i), ey);
    }
  }
}
