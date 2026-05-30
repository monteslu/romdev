// ── racing.c — Atari Lynx 3-lane top-down racer ──────────────────────

#include <tgi.h>
#include <joystick.h>
#include <lynx.h>
#include <stdint.h>
#include "lynx_sfx.h"

#define MAX_OBS 4
#define LANE0 32
#define LANE1 76
#define LANE2 120

static const uint8_t lane_x[3] = { LANE0, LANE1, LANE2 };

typedef struct { int16_t x, y, alive; } Car;

void main(void) {
  uint8_t player_lane = 1;
  Car player = { LANE1, 90, 1 };
  Car obs[MAX_OBS];
  uint8_t spawn = 0, prev = 0;
  uint8_t game_over = 0;
  uint8_t joy, i;
  uint32_t rng = 1;

  tgi_install(&lynx_160_102_16_tgi);
  tgi_init();
  joy_install(&lynx_stdjoy_joy);
  sfx_init();
  for (i = 0; i < MAX_OBS; i++) obs[i].alive = 0;

  for (;;) {
    tgi_clear();
    /* lane lines */
    tgi_setcolor(COLOR_DARKGREY);
    tgi_line(28, 0, 28, 101);
    tgi_line(72, 0, 72, 101);
    tgi_line(116, 0, 116, 101);
    tgi_line(160, 0, 160, 101);

    tgi_setcolor(COLOR_YELLOW);
    tgi_bar((unsigned)player.x - 4, (unsigned)player.y - 4, (unsigned)player.x + 4, (unsigned)player.y + 4);
    tgi_setcolor(COLOR_RED);
    for (i = 0; i < MAX_OBS; i++) {
      if (obs[i].alive) tgi_bar((unsigned)obs[i].x - 4, (unsigned)obs[i].y - 4, (unsigned)obs[i].x + 4, (unsigned)obs[i].y + 4);
    }
    tgi_updatedisplay();
    sfx_update();

    if (game_over > 0) {
      game_over--;
      if (game_over == 0) {
        for (i = 0; i < MAX_OBS; i++) obs[i].alive = 0;
        player_lane = 1; player.x = LANE1;
      }
      continue;
    }

    joy = joy_read(JOY_1);
    if (JOY_LEFT(joy)  && !(prev & 4) && player_lane > 0) { player_lane--; sfx_tone(1, 70, 2); }
    if (JOY_RIGHT(joy) && !(prev & 8) && player_lane < 2) { player_lane++; sfx_tone(1, 70, 2); }
    player.x = lane_x[player_lane];
    prev = (JOY_LEFT(joy) ? 4 : 0) | (JOY_RIGHT(joy) ? 8 : 0);

    for (i = 0; i < MAX_OBS; i++) {
      if (!obs[i].alive) continue;
      obs[i].y += 2;
      if (obs[i].y >= 110) obs[i].alive = 0;
    }
    spawn++;
    if (spawn >= 30) {
      spawn = 0;
      for (i = 0; i < MAX_OBS; i++) {
        if (!obs[i].alive) {
          rng = rng * 1103515245u + 12345u;
          obs[i].x = lane_x[(rng >> 16) % 3];
          obs[i].y = 0;
          obs[i].alive = 1;
          break;
        }
      }
    }
    for (i = 0; i < MAX_OBS; i++) {
      if (obs[i].alive
          && obs[i].x > player.x - 8 && obs[i].x < player.x + 8
          && obs[i].y > player.y - 8 && obs[i].y < player.y + 8) {
        game_over = 60;
        sfx_noise(30);
        break;
      }
    }
  }
}
