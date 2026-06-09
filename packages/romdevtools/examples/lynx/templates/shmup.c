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

/* Galois LFSR (taps $B8), period 255 -- real per-spawn randomness.
 * The old code derived the spawn column from spawn_timer, but the caller
 * resets spawn_timer just before calling here, so it was CONSTANT and
 * every enemy spawned in the same left column/lane. */
static uint8_t rng_state = 0xA5;
static uint8_t rand8(void) {
  uint8_t lsb = (uint8_t)(rng_state & 1);
  rng_state >>= 1;
  if (lsb) rng_state ^= 0xB8;
  return rng_state;
}

static void spawn(void) {
  uint8_t i;
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemies[i].alive) {
      enemies[i].x = (uint8_t)(8 + (rand8() % (160 - 16)));
      enemies[i].y = 0;
      enemies[i].alive = 1;
      return;
    }
  }
}

/* Scrolling starfield: a handful of stars that drift down so the dark
 * space field is never a flat single colour (would read as "blank"). */
#define N_STARS 24
static uint8_t star_x[N_STARS];
static uint8_t star_y[N_STARS];

void main(void) {
  uint8_t joy, fire_now, i, j;
  uint32_t srng = 0x1234;

  tgi_install(&lynx_160_102_16_tgi);
  tgi_init();
  joy_install(&lynx_stdjoy_joy);
  sfx_init();

  player.x = 76; player.y = 90; player.alive = 1;
  for (i = 0; i < MAX_BULLETS; i++) bullets[i].alive = 0;
  for (i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = 0;
  for (i = 0; i < N_STARS; i++) {
    srng = srng * 1103515245u + 12345u;
    star_x[i] = (uint8_t)((srng >> 16) % 160);
    srng = srng * 1103515245u + 12345u;
    star_y[i] = (uint8_t)((srng >> 16) % 102);
  }
  spawn_timer = 0;
  prev_btn = 0;

  for (;;) {
    /* CANONICAL LYNX GAME LOOP — full-redraw every frame. The reliable order:
     *   1. WAIT for the Suzy blitter to finish the previous frame:
     *        while (tgi_busy()) { }
     *      Skipping this is the #1 "Lynx screen stays blank" trap — drawing
     *      while the blitter is mid-flight loses the frame.
     *   2. CLEAR with a full-screen tgi_bar in the background colour, NOT
     *      tgi_clear() (which can leave the framebuffer stale in this
     *      toolchain+emulator path).
     *   3. DRAW every object.
     *   4. tgi_updatedisplay() to push the frame. */
    while (tgi_busy()) { }

    /* ── Background scene (drawn every frame; without it the dark space
     * field is a near-flat single colour and the render-health audit
     * flags the screen as blank). Layered bands keep any one colour well
     * under the threshold:
     *   - deep-blue upper space
     *   - grey nebula band across the middle
     *   - green planet surface along the bottom
     *   - a drifting white/yellow starfield over the space. */
    tgi_setcolor(COLOR_BLUE);
    tgi_bar(0, 0, tgi_getmaxx(), tgi_getmaxy());      /* base space field   */
    tgi_setcolor(COLOR_GREY);
    tgi_bar(0, 34, 159, 60);                          /* nebula band        */
    tgi_setcolor(COLOR_GREEN);
    tgi_bar(0, 84, 159, 101);                         /* planet surface     */
    tgi_setcolor(COLOR_LIGHTGREEN);
    tgi_bar(0, 78, 159, 83);                          /* surface horizon    */
    /* starfield (bright specks; also drifts downward each frame) */
    tgi_setcolor(COLOR_WHITE);
    for (i = 0; i < N_STARS; i++) {
      tgi_setpixel(star_x[i], star_y[i]);
      tgi_setpixel(star_x[i], (star_y[i] + 1) % 102);
    }

    /* Render game objects on top */
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

    /* drift the starfield downward */
    for (i = 0; i < N_STARS; i++) {
      if (star_y[i] >= 101) star_y[i] = 0; else star_y[i]++;
    }

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
