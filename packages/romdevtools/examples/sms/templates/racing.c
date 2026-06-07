/* ── racing.c — SMS top-down racing scaffold ────────────────────────
 *
 * Endless 3-lane top-down racer. Player car at the bottom of the
 * screen, obstacles spawn from the top and slide down. LEFT/RIGHT
 * (edge-detected) switches lanes. Speed grows with score; collision
 * triggers a 60-frame freeze then auto-resets.
 *
 * Hardware bits used:
 *   - VDP sprite SAT for player car + 4 obstacle cars
 *   - VDP_drawText (via tile fill) for the SCORE HUD
 *   - sms_joypad_read for player 1 input
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
extern void    sms_sprite_init(void);
extern void    sms_sprite_set(uint8_t slot, uint8_t x, uint8_t y, uint8_t tile);
extern void    sms_sat_upload(void);

#define LANE_LEFT_X    72
#define LANE_MID_X    124
#define LANE_RIGHT_X  176
#define PLAYER_Y      160
#define MAX_OBSTACLES   4

static const uint8_t palette[32] = {
  0x10, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  /* Sprite palette: white (1), red (2) */
  0x00, 0x3F, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};

/* Two sprite tiles — player (colour 1) + enemy (colour 2). */
static const uint8_t tiles[64] = {
  /* Tile 0 = player car (colour 1 → plane 0 set) */
  0x3C,0x00,0x00,0x00, 0x7E,0x00,0x00,0x00,
  0x42,0x00,0x00,0x00, 0x7E,0x00,0x00,0x00,
  0x7E,0x00,0x00,0x00, 0x42,0x00,0x00,0x00,
  0x7E,0x00,0x00,0x00, 0x66,0x00,0x00,0x00,
  /* Tile 1 = enemy car (colour 2 → plane 1 set) */
  0x00,0x3C,0x00,0x00, 0x00,0x7E,0x00,0x00,
  0x00,0x42,0x00,0x00, 0x00,0x7E,0x00,0x00,
  0x00,0x7E,0x00,0x00, 0x00,0x42,0x00,0x00,
  0x00,0x7E,0x00,0x00, 0x00,0x66,0x00,0x00,
};

typedef struct { uint8_t x, y, alive; } Car;

static Car player;
static Car obstacles[MAX_OBSTACLES];
static uint16_t score;
static uint8_t spawn_timer;
static uint8_t game_over_timer;
static uint8_t prev_pad;
static uint8_t player_lane;

static const uint8_t lane_x[3] = { LANE_LEFT_X, LANE_MID_X, LANE_RIGHT_X };

static uint8_t aabb(Car *a, Car *b) {
  return a->x < b->x + 8 && a->x + 8 > b->x
      && a->y < b->y + 8 && a->y + 8 > b->y;
}

static void reset_run(void) {
  uint8_t i;
  player_lane = 1;
  player.x = lane_x[1];
  player.y = PLAYER_Y;
  player.alive = 1;
  for (i = 0; i < MAX_OBSTACLES; i++) obstacles[i].alive = 0;
  score = 0;
  spawn_timer = 0;
  game_over_timer = 0;
}

static void spawn_obstacle(void) {
  uint8_t i;
  for (i = 0; i < MAX_OBSTACLES; i++) {
    if (!obstacles[i].alive) {
      obstacles[i].x = lane_x[(spawn_timer * 13) % 3];
      obstacles[i].y = 0;
      obstacles[i].alive = 1;
      return;
    }
  }
}

void main(void) {
  uint8_t i;
  sms_vdp_init();
  sms_load_palette(palette);
  sms_load_tiles(0x2000, tiles, 64);
  sms_sprite_init();
  sfx_init();
  sms_vdp_display_on();

  reset_run();
  prev_pad = 0;

  do {
    uint8_t pad;
    uint8_t slot;
    int16_t step;
    sms_vblank_wait();
    sfx_update();

    /* Stage SAT. */
    slot = 0;
    sms_sprite_set(slot++, player.x, player.y, 0 /* player tile */);
    for (i = 0; i < MAX_OBSTACLES; i++) {
      uint8_t ey = obstacles[i].alive ? obstacles[i].y : 0xE0;
      sms_sprite_set(slot++, obstacles[i].x, ey, 1 /* enemy tile */);
    }
    sms_sat_upload();

    pad = sms_joypad_read();

    if (game_over_timer > 0) {
      game_over_timer--;
      if (game_over_timer == 0) reset_run();
      prev_pad = pad;
      continue;
    }

    if ((pad & JOY_LEFT)  && !(prev_pad & JOY_LEFT)  && player_lane > 0) { player_lane--; sfx_tone(1, 330, 2); }
    if ((pad & JOY_RIGHT) && !(prev_pad & JOY_RIGHT) && player_lane < 2) { player_lane++; sfx_tone(1, 330, 2); }
    player.x = lane_x[player_lane];
    prev_pad = pad;

    /* Obstacle speed grows with score (cap at 4). */
    step = (int16_t)(2 + (score / 500));
    if (step > 4) step = 4;

    for (i = 0; i < MAX_OBSTACLES; i++) {
      if (!obstacles[i].alive) continue;
      obstacles[i].y = (uint8_t)(obstacles[i].y + step);
      if (obstacles[i].y >= 184) obstacles[i].alive = 0;
    }

    spawn_timer = (uint8_t)(spawn_timer + 1);
    if (spawn_timer >= 36) { spawn_timer = 0; spawn_obstacle(); }

    for (i = 0; i < MAX_OBSTACLES; i++) {
      if (obstacles[i].alive && aabb(&player, &obstacles[i])) {
        game_over_timer = 60;
        sfx_noise(30);  /* crash */
        break;
      }
    }

    if (score < 65500u) score = (uint16_t)(score + 1);
  } while (1);
}
