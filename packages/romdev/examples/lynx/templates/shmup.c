// ── shmup.c — Atari Lynx vertical-shooter scaffold ───────────────────
//
// Cross-platform shmup: player + 4 bullets + 4 enemies (pools), wave
// spawner, AABB collisions, MIKEY sound effects. cc65's tgi handles
// Suzy's blitter for us.

#include <tgi.h>
#include <joystick.h>
#include <lynx.h>
#include <stdint.h>
#include "lynx_sfx.h"

#define MAX_BULLETS 4
#define MAX_ENEMIES 4

typedef struct { uint8_t x, y, alive; } Obj;

static Obj player;
static Obj bullets[MAX_BULLETS];
static Obj enemies[MAX_ENEMIES];
static uint8_t spawn_timer;
static uint8_t prev_btn;

static uint8_t aabb(Obj *a, Obj *b) {
  return a->x < b->x + 6 && a->x + 6 > b->x
      && a->y < b->y + 6 && a->y + 6 > b->y;
}

static void fire(void) {
  uint8_t i;
  for (i = 0; i < MAX_BULLETS; i++) {
    if (!bullets[i].alive) {
      bullets[i].x = player.x;
      bullets[i].y = player.y - 4;
      bullets[i].alive = 1;
      return;
    }
  }
}

static void spawn(void) {
  uint8_t i;
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemies[i].alive) {
      enemies[i].x = (uint8_t)(8 + ((spawn_timer * 37) & 0x7F));
      enemies[i].y = 0;
      enemies[i].alive = 1;
      return;
    }
  }
}

void main(void) {
  uint8_t joy, fire_now, i, j;

  tgi_install(&lynx_160_102_16_tgi);
  tgi_init();
  joy_install(&lynx_stdjoy_joy);
  sfx_init();

  player.x = 76; player.y = 90; player.alive = 1;
  for (i = 0; i < MAX_BULLETS; i++) bullets[i].alive = 0;
  for (i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = 0;
  spawn_timer = 0;
  prev_btn = 0;

  for (;;) {
    tgi_clear();

    /* Render */
    tgi_setcolor(COLOR_YELLOW);
    tgi_bar(player.x, player.y, player.x + 6, player.y + 6);
    tgi_setcolor(COLOR_WHITE);
    for (i = 0; i < MAX_BULLETS; i++) {
      if (bullets[i].alive) tgi_bar(bullets[i].x, bullets[i].y, bullets[i].x + 2, bullets[i].y + 4);
    }
    tgi_setcolor(COLOR_RED);
    for (i = 0; i < MAX_ENEMIES; i++) {
      if (enemies[i].alive) tgi_bar(enemies[i].x, enemies[i].y, enemies[i].x + 6, enemies[i].y + 6);
    }
    tgi_updatedisplay();
    sfx_update();

    /* Input + state */
    joy = joy_read(JOY_1);
    fire_now = JOY_BTN_1(joy) ? 1 : 0;
    if (JOY_LEFT(joy)  && player.x > 0)   player.x--;
    if (JOY_RIGHT(joy) && player.x < 154) player.x++;
    if (JOY_UP(joy)    && player.y > 8)   player.y--;
    if (JOY_DOWN(joy)  && player.y < 96)  player.y++;
    if (fire_now && !prev_btn) { fire(); sfx_tone(0, 80, 4); }
    prev_btn = fire_now;

    for (i = 0; i < MAX_BULLETS; i++) {
      if (!bullets[i].alive) continue;
      if (bullets[i].y < 2) { bullets[i].alive = 0; continue; }
      bullets[i].y -= 3;
    }
    for (i = 0; i < MAX_ENEMIES; i++) {
      if (!enemies[i].alive) continue;
      enemies[i].y++;
      if (enemies[i].y >= 102) enemies[i].alive = 0;
    }
    spawn_timer++;
    if (spawn_timer >= 28) { spawn_timer = 0; spawn(); }

    for (i = 0; i < MAX_BULLETS; i++) {
      if (!bullets[i].alive) continue;
      for (j = 0; j < MAX_ENEMIES; j++) {
        if (!enemies[j].alive) continue;
        if (aabb(&bullets[i], &enemies[j])) {
          bullets[i].alive = 0;
          enemies[j].alive = 0;
          sfx_noise(8);
          break;
        }
      }
    }
  }
}
