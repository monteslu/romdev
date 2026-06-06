/* ── shmup_2p.c — SMS two-player competitive shooter ───────────────
 *
 * Two-player co-op-competitive shmup on SMS. Player 1 on PORT_JOY_A,
 * player 2 on PORT_JOY_B (via sms_joypad_read_p2(), the helper that
 * reassembles P2's split-across-$DC/$DD bit layout into the same
 * shape as P1).
 *
 * Each player has their own ship + bullet pool + score. Enemies are
 * shared; first hit wins the points.
 *
 * SMS hard limits (8 sprites/scanline, 64 sprites total). Slot layout:
 *   0     → P1 ship
 *   1     → P2 ship
 *   2..5  → P1 bullets
 *   6..9  → P2 bullets
 *   10..15 → enemies
 *   total 16 < 64 — plenty of headroom.
 */
#include "sms_hw.h"
#include "sms_sfx.h"
#include <stdint.h>

extern void    sms_vdp_init(void);
extern void    sms_vdp_display_on(void);
extern void    sms_load_palette(const uint8_t *palette);
extern void    sms_load_tiles(uint16_t vram_dest, const uint8_t *src, uint16_t byte_count);
extern void    sms_vblank_wait(void);
extern uint8_t sms_joypad_read(void);
extern uint8_t sms_joypad_read_p2(void);
extern void    sms_sprite_init(void);
extern void    sms_sprite_set(uint8_t slot, uint8_t x, uint8_t y, uint8_t tile);
extern void    sms_sat_upload(void);

#define MAX_BULLETS_PP 4
#define MAX_ENEMIES    6

#define T_SHIP_P1 0
#define T_SHIP_P2 1
#define T_BULLET  2
#define T_ENEMY   3

static const uint8_t palette[32] = {
  0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  /* Sprite palette: 1 white (P1), 2 yellow (bullet), 3 red (enemy + P2 highlight) */
  0x00, 0x3F, 0x0F, 0x03, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};

/* 4 sprite tiles back-to-back: P1 ship (col1), P2 ship (col3), bullet (col2), enemy (col3). */
static const uint8_t sprite_tiles[32 * 4] = {
  /* P1 ship — diamond, colour 1 (plane 0) */
  0x18,0x00,0x00,0x00, 0x3C,0x00,0x00,0x00,
  0x7E,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0x7E,0x00,0x00,0x00,
  0x3C,0x00,0x00,0x00, 0x18,0x00,0x00,0x00,
  /* P2 ship — diamond, colour 3 (planes 0+1) */
  0x18,0x18,0x00,0x00, 0x3C,0x3C,0x00,0x00,
  0x7E,0x7E,0x00,0x00, 0xFF,0xFF,0x00,0x00,
  0xFF,0xFF,0x00,0x00, 0x7E,0x7E,0x00,0x00,
  0x3C,0x3C,0x00,0x00, 0x18,0x18,0x00,0x00,
  /* Bullet — small ball, colour 2 (plane 1) */
  0x00,0x18,0x00,0x00, 0x00,0x3C,0x00,0x00,
  0x00,0x3C,0x00,0x00, 0x00,0x3C,0x00,0x00,
  0x00,0x3C,0x00,0x00, 0x00,0x3C,0x00,0x00,
  0x00,0x18,0x00,0x00, 0x00,0x00,0x00,0x00,
  /* Enemy — X, colour 3 (planes 0+1) */
  0x81,0x81,0x00,0x00, 0x42,0x42,0x00,0x00,
  0x24,0x24,0x00,0x00, 0x18,0x18,0x00,0x00,
  0x18,0x18,0x00,0x00, 0x24,0x24,0x00,0x00,
  0x42,0x42,0x00,0x00, 0x81,0x81,0x00,0x00,
};

typedef struct { uint8_t x, y, alive; } Obj;
static Obj p1, p2;
static Obj p1_bullets[MAX_BULLETS_PP];
static Obj p2_bullets[MAX_BULLETS_PP];
static Obj enemies[MAX_ENEMIES];
static uint16_t score_p1, score_p2;
static uint8_t spawn_timer;

static uint8_t aabb(Obj *a, Obj *b) {
  return a->x < b->x + 8 && a->x + 8 > b->x
      && a->y < b->y + 8 && a->y + 8 > b->y;
}

static void fire(Obj *ship, Obj *pool) {
  uint8_t i;
  for (i = 0; i < MAX_BULLETS_PP; i++) {
    if (!pool[i].alive) {
      pool[i].x = ship->x;
      pool[i].y = (uint8_t)(ship->y - 8);
      pool[i].alive = 1;
      return;
    }
  }
}

static void spawn(void) {
  uint8_t i;
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemies[i].alive) {
      enemies[i].x = (uint8_t)(((spawn_timer * 37) & 0xFF) % (256 - 16) + 8);
      enemies[i].y = 0;
      enemies[i].alive = 1;
      return;
    }
  }
}

void main(void) {
  uint8_t prev1 = 0, prev2 = 0;
  sms_vdp_init();
  sms_load_palette(palette);
  sms_load_tiles(0x2000, sprite_tiles, 32 * 4);

  p1.x = 80;  p1.y = 160; p1.alive = 1;
  p2.x = 168; p2.y = 160; p2.alive = 1;
  {
    uint8_t i;
    for (i = 0; i < MAX_BULLETS_PP; i++) p1_bullets[i].alive = 0;
    for (i = 0; i < MAX_BULLETS_PP; i++) p2_bullets[i].alive = 0;
    for (i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = 0;
  }
  score_p1 = 0; score_p2 = 0; spawn_timer = 0;

  sms_sprite_init();
  sfx_init();
  sms_vdp_display_on();

  do {
    uint8_t pad1, pad2;
    uint8_t i, j;
    sms_vblank_wait();
    sfx_update();

    /* Stage SAT first. */
    sms_sprite_set(0, p1.x, p1.y, T_SHIP_P1);
    sms_sprite_set(1, p2.x, p2.y, T_SHIP_P2);
    for (i = 0; i < MAX_BULLETS_PP; i++) {
      uint8_t by = p1_bullets[i].alive ? p1_bullets[i].y : 0xE0;
      sms_sprite_set((uint8_t)(2 + i), p1_bullets[i].x, by, T_BULLET);
    }
    for (i = 0; i < MAX_BULLETS_PP; i++) {
      uint8_t by = p2_bullets[i].alive ? p2_bullets[i].y : 0xE0;
      sms_sprite_set((uint8_t)(6 + i), p2_bullets[i].x, by, T_BULLET);
    }
    for (i = 0; i < MAX_ENEMIES; i++) {
      uint8_t ey = enemies[i].alive ? enemies[i].y : 0xE0;
      sms_sprite_set((uint8_t)(10 + i), enemies[i].x, ey, T_ENEMY);
    }
    sms_sat_upload();

    pad1 = sms_joypad_read();
    pad2 = sms_joypad_read_p2();

    /* P1. */
    if (pad1 & JOY_LEFT  && p1.x > 4)        p1.x = (uint8_t)(p1.x - 2);
    if (pad1 & JOY_RIGHT && p1.x < 256 - 16) p1.x = (uint8_t)(p1.x + 2);
    if (pad1 & JOY_UP    && p1.y > 8)        p1.y = (uint8_t)(p1.y - 2);
    if (pad1 & JOY_DOWN  && p1.y < 192 - 16) p1.y = (uint8_t)(p1.y + 2);
    if ((pad1 & JOY_B1) && !(prev1 & JOY_B1)) { fire(&p1, p1_bullets); sfx_tone(0, 200, 4); }
    prev1 = pad1;

    /* P2. */
    if (pad2 & JOY_LEFT  && p2.x > 4)        p2.x = (uint8_t)(p2.x - 2);
    if (pad2 & JOY_RIGHT && p2.x < 256 - 16) p2.x = (uint8_t)(p2.x + 2);
    if (pad2 & JOY_UP    && p2.y > 8)        p2.y = (uint8_t)(p2.y - 2);
    if (pad2 & JOY_DOWN  && p2.y < 192 - 16) p2.y = (uint8_t)(p2.y + 2);
    if ((pad2 & JOY_B1) && !(prev2 & JOY_B1)) { fire(&p2, p2_bullets); sfx_tone(1, 250, 4); }
    prev2 = pad2;

    /* Update bullets. */
    for (i = 0; i < MAX_BULLETS_PP; i++) {
      if (p1_bullets[i].alive) {
        if (p1_bullets[i].y < 4) p1_bullets[i].alive = 0;
        else p1_bullets[i].y = (uint8_t)(p1_bullets[i].y - 4);
      }
      if (p2_bullets[i].alive) {
        if (p2_bullets[i].y < 4) p2_bullets[i].alive = 0;
        else p2_bullets[i].y = (uint8_t)(p2_bullets[i].y - 4);
      }
    }

    /* Update enemies. */
    for (i = 0; i < MAX_ENEMIES; i++) {
      if (!enemies[i].alive) continue;
      enemies[i].y = (uint8_t)(enemies[i].y + 1);
      if (enemies[i].y >= 192) enemies[i].alive = 0;
    }
    spawn_timer = (uint8_t)(spawn_timer + 1);
    if (spawn_timer >= 28) { spawn_timer = 0; spawn(); }

    /* Collisions — P1 bullets first, then P2 (gameplay-symmetric tie-break
     * by player order; for true symmetry, alternate the order each frame). */
    for (j = 0; j < MAX_ENEMIES; j++) {
      if (!enemies[j].alive) continue;
      for (i = 0; i < MAX_BULLETS_PP; i++) {
        if (p1_bullets[i].alive && aabb(&p1_bullets[i], &enemies[j])) {
          p1_bullets[i].alive = 0;
          enemies[j].alive = 0;
          if (score_p1 < 65500) score_p1 = (uint16_t)(score_p1 + 10);
          sfx_noise(8);
          break;
        }
      }
      if (!enemies[j].alive) continue;
      for (i = 0; i < MAX_BULLETS_PP; i++) {
        if (p2_bullets[i].alive && aabb(&p2_bullets[i], &enemies[j])) {
          p2_bullets[i].alive = 0;
          enemies[j].alive = 0;
          if (score_p2 < 65500) score_p2 = (uint16_t)(score_p2 + 10);
          sfx_noise(8);
          break;
        }
      }
    }
  } while (1);
}
