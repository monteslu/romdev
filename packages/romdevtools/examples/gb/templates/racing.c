/* ── racing.c — Game Boy top-down racing scaffold ──────────────────
 *
 * Endless 3-lane top-down dodge for the Game Boy. LEFT/RIGHT switches
 * lanes (edge-detected), obstacles slide down at speed = 2 + score/500
 * (capped). Collision triggers a 60-frame freeze + auto-reset.
 *
 * Game Boy screen is 160×144 — 3 lanes centred around x = {48, 80, 112}.
 */

#include "gb_hardware.h"
#include "gb_runtime.h"

#define LANE_LEFT_X    40
#define LANE_MID_X     76
#define LANE_RIGHT_X  112
#define PLAYER_Y      120
#define MAX_OBSTACLES   4

static const uint8_t tile_blank[16] = { 0 };
static const uint8_t tile_car_p1[16] = {
  0x3C,0x00, 0x7E,0x00, 0x42,0x00, 0x7E,0x00,
  0x7E,0x00, 0x42,0x00, 0x7E,0x00, 0x66,0x00,
};
static const uint8_t tile_car_en[16] = {
  0x00,0x3C, 0x00,0x7E, 0x00,0x42, 0x00,0x7E,
  0x00,0x7E, 0x00,0x42, 0x00,0x7E, 0x00,0x66,
};

static const uint16_t obj_palette[4] = { 0x7FFF, 0x7FFF, 0x001F, 0x03E0 };

typedef struct { int16_t x, y; uint8_t alive; } Car;

static Car player;
static Car obstacles[MAX_OBSTACLES];
static uint16_t score;
static uint8_t spawn_timer;
static uint8_t game_over_timer;
static uint8_t prev_pad;
static uint8_t player_lane;

static const int16_t lane_x[3] = { LANE_LEFT_X, LANE_MID_X, LANE_RIGHT_X };

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

static void upload_tile(uint8_t slot, const uint8_t *src) {
  uint8_t *dst = (uint8_t *)(0x8000 + slot * 16);
  uint8_t i;
  for (i = 0; i < 16; i++) dst[i] = src[i];
}

void main(void) {
  uint8_t pad;
  uint8_t i;
  int16_t step;

  lcd_init_default();
  LCDC = 0;

  upload_tile(0, tile_blank);
  upload_tile(1, tile_car_p1);
  upload_tile(2, tile_car_en);

  OCPS = 0x80;
  for (i = 0; i < 4; i++) {
    OCPD = (uint8_t)(obj_palette[i] & 0xFF);
    OCPD = (uint8_t)((obj_palette[i] >> 8) & 0xFF);
  }

  oam_clear();
  LCDC = LCDC_LCD_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO;
  sound_init();

  reset_run();
  prev_pad = 0;

  while (1) {
    wait_vblank();

    /* Stage OAM — player + obstacles. */
    for (i = 0; i < 40; i++) oam_set(i, 0, 0, 0, 0);
    oam_set(0, (uint8_t)(player.y + 16), (uint8_t)(player.x + 8), 1, 0);
    for (i = 0; i < MAX_OBSTACLES; i++) {
      if (obstacles[i].alive) {
        oam_set((uint8_t)(1 + i),
                (uint8_t)(obstacles[i].y + 16),
                (uint8_t)(obstacles[i].x + 8),
                2, 0);
      }
    }
    oam_dma_flush();

    pad = joypad_read();
    if (game_over_timer > 0) {
      game_over_timer--;
      if (game_over_timer == 0) reset_run();
      prev_pad = pad;
      continue;
    }

    if ((pad & PAD_LEFT)  && !(prev_pad & PAD_LEFT)  && player_lane > 0) {
      player_lane--;
      sound_play_tone(2, 1700, 3);
    }
    if ((pad & PAD_RIGHT) && !(prev_pad & PAD_RIGHT) && player_lane < 2) {
      player_lane++;
      sound_play_tone(2, 1700, 3);
    }
    player.x = lane_x[player_lane];
    prev_pad = pad;

    step = (int16_t)(2 + (score / 500));
    if (step > 4) step = 4;

    for (i = 0; i < MAX_OBSTACLES; i++) {
      if (!obstacles[i].alive) continue;
      obstacles[i].y = (int16_t)(obstacles[i].y + step);
      if (obstacles[i].y >= 144) obstacles[i].alive = 0;
    }
    spawn_timer++;
    if (spawn_timer >= 36) { spawn_timer = 0; spawn_obstacle(); }

    for (i = 0; i < MAX_OBSTACLES; i++) {
      if (obstacles[i].alive && aabb(&player, &obstacles[i])) {
        sound_play_noise(8);
        game_over_timer = 60;
        break;
      }
    }
    if (score < 65500) score++;
  }
}
