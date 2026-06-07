/* ── racing.c — NES top-down racing scaffold ─────────────────────────
 *
 * A simple endless top-down racer. Player car at the bottom; the
 * "road" scrolls down as obstacles (other cars) come up from the top.
 * Left/Right or A/B switches between three lanes. Survive as long as
 * possible — score = frames survived.
 *
 * Mechanics:
 *   - 3 lanes (left / centre / right)
 *   - 4 obstacle slots (object pool) — one spawns from a random lane
 *     every ~40 frames
 *   - Obstacles slide down at constant speed
 *   - AABB collision; on hit, game-over state pauses for 60 frames then
 *     resets the run
 *   - Score = frames-survived-in-current-run, rendered with the
 *     digit tiles
 *
 * Two-player mode: port 1 (player 2) controls a second car in
 * the opposite half of the screen. When no second controller is
 * present, P2 lane runs an AI that dodges in the same pattern.
 *
 * Easy extensions: scrolling BG road stripes, scenery sprites,
 * acceleration / brake, lap timer, multi-tier obstacle types.
 */

#include "nes_runtime.h"

/* ── Tile data ────────────────────────────────────────────────────── */
static const uint8_t tile_blank[16] = { 0 };
/* Player car — 8×8 small box with a roof */
static const uint8_t tile_car_p1[16] = {
  0x3C, 0x7E, 0x42, 0x7E, 0x7E, 0x7E, 0x42, 0x66,
  0,    0,    0,    0,    0,    0,    0,    0,
};
/* Enemy car — inverted */
static const uint8_t tile_car_enemy[16] = {
  0x66, 0x42, 0x7E, 0x7E, 0x7E, 0x42, 0x7E, 0x3C,
  0,    0,    0,    0,    0,    0,    0,    0,
};
/* Digit tiles for the HUD (same 3×5-padded shape as sports.c). */
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

#define T_BLANK     0
#define T_CAR_P1    1
#define T_CAR_ENEMY 2
#define T_DIGIT0    3

/* ── Background road tiles ───────────────────────────────────────────
 * Default PPUCTRL ($90) reads BG patterns from pattern table 1 ($1000),
 * so these go to CHR $1000+ and are indexed independently of the sprite
 * tiles above. Colour 1 (white, BG palette 0) draws the markings; the
 * grey backdrop (colour 0) is the road surface.
 *
 * BG_T_EDGE: a solid 2px vertical stripe — the road shoulder line.
 * BG_T_LANE: a 2px vertical dash (on for 4 rows, off for 4) — the
 *            dashed centre lane marking when stacked down a column. */
#define BG_T_EDGE   1
#define BG_T_LANE   2
static const uint8_t bg_tile_edge[16] = {
  0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18,   /* plane 0 (colour bit 0) */
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t bg_tile_lane[16] = {
  0x18, 0x18, 0x18, 0x18, 0x00, 0x00, 0x00, 0x00,   /* dash: 4 on, 4 off */
  0,    0,    0,    0,    0,    0,    0,    0,
};

static const uint8_t palette[32] = {
  /* BG palettes — light grey backdrop simulates road */
  0x10, 0x30, 0x16, 0x12,
  0x10, 0x30, 0x16, 0x12,
  0x10, 0x30, 0x16, 0x12,
  0x10, 0x30, 0x16, 0x12,
  /* Sprite palettes */
  0x10, 0x21, 0x16, 0x30,   /* sp0: blue car (P1) */
  0x10, 0x16, 0x21, 0x30,   /* sp1: red enemy */
  0x10, 0x2A, 0x21, 0x30,
  0x10, 0x2A, 0x21, 0x30,
};

#define LANE_LEFT_X   88
#define LANE_MID_X    120
#define LANE_RIGHT_X  152
#define PLAYER_Y      192

#define MAX_OBSTACLES 4

typedef struct { uint8_t x, y, alive; } Car;

static Car   player;       /* y is fixed at PLAYER_Y; x switches lanes */
static Car   obstacles[MAX_OBSTACLES];
static uint16_t score;
static uint8_t spawn_timer;
static uint8_t game_over_timer;
static uint8_t prev_p1;

static const uint8_t lane_x[3] = { LANE_LEFT_X, LANE_MID_X, LANE_RIGHT_X };
static uint8_t player_lane;

static uint8_t aabb(Car *a, Car *b) {
  return a->x < b->x + 8 && a->x + 8 > b->x
      && a->y < b->y + 8 && a->y + 8 > b->y;
}

/* Draw the static road into nametable 0 ($2000): solid shoulder lines on
 * the outside of the outer lanes and dashed dividers between the three
 * lanes. PPU must be OFF — call from init (uses vram_unsafe_set). Tile
 * columns: lanes sit at 11/15/19, so dividers go at 13/17 and shoulders
 * just outside at 9/21. */
#define ROAD_TOP_ROW   2
#define ROAD_BOT_ROW   27
#define ROAD_EDGE_L    9
#define ROAD_EDGE_R    21
#define ROAD_DIV_1     13
#define ROAD_DIV_2     17
static void draw_road(void) {
  uint8_t row;
  uint16_t base;
  for (row = ROAD_TOP_ROW; row <= ROAD_BOT_ROW; row++) {
    base = (uint16_t)(0x2000 + (uint16_t)row * 32);
    vram_unsafe_set((uint16_t)(base + ROAD_EDGE_L), BG_T_EDGE);
    vram_unsafe_set((uint16_t)(base + ROAD_EDGE_R), BG_T_EDGE);
    vram_unsafe_set((uint16_t)(base + ROAD_DIV_1),  BG_T_LANE);
    vram_unsafe_set((uint16_t)(base + ROAD_DIV_2),  BG_T_LANE);
  }
}

static void reset_run(void) {
  uint8_t i;
  player_lane = 1;
  player.x = lane_x[1]; player.y = PLAYER_Y; player.alive = 1;
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

static void render_score(void) {
  /* Render a 5-digit decimal score as 5 OAM sprites in the top-right. */
  uint16_t v = score;
  uint8_t digits[5];
  int8_t i;
  for (i = 4; i >= 0; i--) { digits[i] = v % 10; v /= 10; }
  for (i = 0; i < 5; i++) {
    oam_spr((uint8_t)(192 + i * 8), 4,
            (uint8_t)(T_DIGIT0 + digits[i]), 0);
  }
}

void main(void) {
  uint8_t i;
  uint8_t p1;

  ppu_off();

  chr_ram_upload(T_BLANK     * 16, tile_blank,     16);
  chr_ram_upload(T_CAR_P1    * 16, tile_car_p1,    16);
  chr_ram_upload(T_CAR_ENEMY * 16, tile_car_enemy, 16);
  chr_ram_upload(T_DIGIT0    * 16, tile_digits,    sizeof(tile_digits));

  /* BG road tiles live in pattern table 1 ($1000) — that's where the
   * default PPUCTRL ($90) tells the PPU to read background patterns. */
  chr_ram_upload((uint16_t)(0x1000 + BG_T_EDGE * 16), bg_tile_edge, 16);
  chr_ram_upload((uint16_t)(0x1000 + BG_T_LANE * 16), bg_tile_lane, 16);

  palette_load(palette);
  draw_road();          /* paint the static road while the PPU is off */
  oam_clear();
  ppu_on_all();
  sound_init();

  reset_run();
  prev_p1 = 0;

  for (;;) {
    oam_clear();
    /* Player car */
    oam_spr(player.x, player.y, T_CAR_P1, 0);
    /* Obstacles */
    for (i = 0; i < MAX_OBSTACLES; i++) {
      if (obstacles[i].alive)
        oam_spr(obstacles[i].x, obstacles[i].y, T_CAR_ENEMY, 1);
    }
    render_score();

    ppu_wait_nmi();

    p1 = pad_poll(0);

    if (game_over_timer > 0) {
      game_over_timer--;
      if (game_over_timer == 0) reset_run();
      prev_p1 = p1;
      continue;
    }

    /* ── Input — switch lanes on left/right press (edge-detected). */
    if ((p1 & PAD_LEFT) && !(prev_p1 & PAD_LEFT) && player_lane > 0) {
      player_lane--;
      sound_play_tone(0, 0x180, 6, 3);
    }
    if ((p1 & PAD_RIGHT) && !(prev_p1 & PAD_RIGHT) && player_lane < 2) {
      player_lane++;
      sound_play_tone(0, 0x180, 6, 3);
    }
    player.x = lane_x[player_lane];
    prev_p1 = p1;

    /* ── Obstacles slide down ─────────────────────────────────── */
    for (i = 0; i < MAX_OBSTACLES; i++) {
      if (!obstacles[i].alive) continue;
      if (obstacles[i].y < 232) obstacles[i].y += 2;
      else obstacles[i].alive = 0;
    }
    if (++spawn_timer >= 36) { spawn_timer = 0; spawn_obstacle(); }

    /* Collisions */
    for (i = 0; i < MAX_OBSTACLES; i++) {
      if (!obstacles[i].alive) continue;
      if (aabb(&player, &obstacles[i])) {
        sound_play_noise(8, 8, 16);
        game_over_timer = 60;
        break;
      }
    }

    if (score < 65500u) score++;
  }
}
