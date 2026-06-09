/* ── racing.c — Game Boy top-down racing scaffold ──────────────────
 *
 * Endless 3-lane top-down dodge for the Game Boy. LEFT/RIGHT switches
 * lanes (edge-detected), obstacles slide down at speed = 2 + score/500
 * (capped). Collision triggers a 60-frame freeze + auto-reset.
 *
 * Game Boy screen is 160×144 — 3 lanes centred around x = {40, 76, 112}.
 *
 * The road is a real background: grass shoulders down each side, dark
 * asphalt across the playfield, and dashed white lane lines between the
 * lanes (LCDC bit 0 = BG ON — drop it and the screen is a flat colour,
 * the #1 GB "why is it blank" footgun). Cars are sprites on top.
 */

#include "gb_hardware.h"
#include "gb_runtime.h"

#define LANE_LEFT_X    40
#define LANE_MID_X     76
#define LANE_RIGHT_X  112
#define PLAYER_Y      120
#define MAX_OBSTACLES   4

/* ── Sprite tiles (cars) ──────────────────────────────────────────── */
static const uint8_t tile_car_p1[16] = {
  0x3C,0x00, 0x7E,0x00, 0x42,0x00, 0x7E,0x00,
  0x7E,0x00, 0x42,0x00, 0x7E,0x00, 0x66,0x00,
};
static const uint8_t tile_car_en[16] = {
  0x00,0x3C, 0x00,0x7E, 0x00,0x42, 0x00,0x7E,
  0x00,0x7E, 0x00,0x42, 0x00,0x7E, 0x00,0x66,
};

/* ── BG tiles (road) ──────────────────────────────────────────────── */
/* 2bpp: row N = byte 2N (low plane) + byte 2N+1 (high plane).
 *   asphalt  — all colour 2 (mid-dark)
 *   grass    — all colour 1 (light, the shoulders)
 *   laneA/B  — dashed white (colour 3) lane line, two phases for the dashes */
static const uint8_t tile_asphalt[16] = {
  0x00,0xFF, 0x00,0xFF, 0x00,0xFF, 0x00,0xFF,
  0x00,0xFF, 0x00,0xFF, 0x00,0xFF, 0x00,0xFF,
};
static const uint8_t tile_grass[16] = {
  0xFF,0x00, 0xFF,0x00, 0xFF,0x00, 0xFF,0x00,
  0xFF,0x00, 0xFF,0x00, 0xFF,0x00, 0xFF,0x00,
};
/* lane line = a 2px-wide colour-3 stripe down the centre of the cell;
 * phase A draws the top half, phase B the bottom half → dashes. */
static const uint8_t tile_laneA[16] = {
  0x18,0x18, 0x18,0x18, 0x18,0x18, 0x18,0x18,
  0x00,0xFF, 0x00,0xFF, 0x00,0xFF, 0x00,0xFF,
};
static const uint8_t tile_laneB[16] = {
  0x00,0xFF, 0x00,0xFF, 0x00,0xFF, 0x00,0xFF,
  0x18,0x18, 0x18,0x18, 0x18,0x18, 0x18,0x18,
};

/* OBJ palette: 0 transparent, 1 white (player), 2 red, 3 green. */
static const uint16_t obj_palette[4] = { 0x7FFF, 0x7FFF, 0x001F, 0x03E0 };

/* Tile indices in VRAM. Sprites and BG share the $8000 table here. */
#define T_CAR_P1   1
#define T_CAR_EN   2
#define T_ASPHALT  3
#define T_GRASS    4
#define T_LANE_A   5
#define T_LANE_B   6

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

static void spawn_obstacle(void) {
  uint8_t i;
  for (i = 0; i < MAX_OBSTACLES; i++) {
    if (!obstacles[i].alive) {
      obstacles[i].x = lane_x[rand8() % 3];
      obstacles[i].y = 0;
      obstacles[i].alive = 1;
      return;
    }
  }
}

static void upload_tile(uint8_t slot, const uint8_t *src) {
  uint8_t *dst = (uint8_t *)(0x8000 + slot * 16);
  /* memcpy_vram (pointer-walk) — NOT an indexed dst[i]=src[i] loop, which
   * SDCC sm83 miscompiles when dst points into VRAM ($8000-$9FFF). */
  memcpy_vram(dst, src, 16);
}

/* Paint the road into BG map 0 ($9800). 20×18 visible cells:
 *   col 0       = grass shoulder (left)
 *   col 19      = grass shoulder (right)
 *   cols 1..18  = asphalt, with dashed lane lines at the two lane
 *                 boundaries (cols 6 and 12). Dashes alternate per row. */
static void draw_road(void) {
  uint8_t *bg = BG_MAP_0;
  uint8_t r, c, t;
  for (r = 0; r < 18; r++) {
    for (c = 0; c < 20; c++) {
      if (c == 0 || c == 19)      t = T_GRASS;
      else if (c == 6 || c == 12) t = (r & 1) ? T_LANE_A : T_LANE_B;
      else                        t = T_ASPHALT;
      bg[r * 32 + c] = t;
    }
  }
}

void main(void) {
  uint8_t pad;
  uint8_t i;
  int16_t step;

  lcd_init_default();
  LCDC = 0;

  upload_tile(T_CAR_P1,  tile_car_p1);
  upload_tile(T_CAR_EN,  tile_car_en);
  upload_tile(T_ASPHALT, tile_asphalt);
  upload_tile(T_GRASS,   tile_grass);
  upload_tile(T_LANE_A,  tile_laneA);
  upload_tile(T_LANE_B,  tile_laneB);

  /* DMG BG palette: 0 white, 1 light, 2 dark, 3 black. The road reads
   * as asphalt(dark) + grass(light) + white dashes. */
  BGP = 0xE4;
  OCPS = 0x80;
  for (i = 0; i < 4; i++) {
    OCPD = (uint8_t)(obj_palette[i] & 0xFF);
    OCPD = (uint8_t)((obj_palette[i] >> 8) & 0xFF);
  }

  draw_road();

  oam_clear();
  LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO;
  sound_init();

  reset_run();
  prev_pad = 0;

  while (1) {
    wait_vblank();

    /* Stage OAM — player + obstacles. */
    for (i = 0; i < 40; i++) oam_set(i, 0, 0, 0, 0);
    oam_set(0, (uint8_t)(player.y + 16), (uint8_t)(player.x + 8), T_CAR_P1, 0);
    for (i = 0; i < MAX_OBSTACLES; i++) {
      if (obstacles[i].alive) {
        oam_set((uint8_t)(1 + i),
                (uint8_t)(obstacles[i].y + 16),
                (uint8_t)(obstacles[i].x + 8),
                T_CAR_EN, 0);
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
    if (score < 65500u) score++;
  }
}
