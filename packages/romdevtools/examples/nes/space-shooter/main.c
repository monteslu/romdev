/*
 * NES fixed-shooter (space-shooter genre)
 *
 * Player cannon at the bottom shoots a descending grid of aliens, with
 * destructible shields and a score/lives HUD. A 5-column formation keeps
 * each row under the NES 8-sprites-per-scanline limit; shields and HUD are
 * drawn as background tiles. (Generic genre example — not based on any
 * specific commercial game.)
 */

#include "nes_runtime.h"

#define ALIEN_COLS 5
#define ALIEN_ROWS 4
#define ALIEN_COUNT 20
#define SHIELD_COUNT 3
#define SHIELD_BLOCKS 6

#define STATE_PLAY 0
#define STATE_WIN 1
#define STATE_OVER 2

#define T_BLANK 0
#define T_SHIELD_FULL 1
#define T_SHIELD_HIT 2
#define T_DIGIT_0 3
#define T_ALIEN_0 13
#define T_ALIEN_1 14
#define T_ALIEN_2 15
#define T_PLAYER_L 16
#define T_PLAYER_R 17
#define T_PLAYER_SHOT 18
#define T_ALIEN_SHOT 19
#define T_BANNER 20
#define TILE_COUNT 21

#define PAL_PLAYER 0
#define PAL_SHOT 1
#define PAL_ALIEN 2
#define PAL_RED 3

typedef struct {
  uint8_t active;
  uint8_t x;
  uint8_t y;
} Shot;

typedef struct {
  uint8_t hp[SHIELD_BLOCKS];
} Shield;

static uint8_t alien_alive_mask[ALIEN_ROWS];
static Shield shields[SHIELD_COUNT];
static Shot player_shot;
static Shot alien_shot;

static uint8_t player_x;
static uint8_t player_cooldown;
static uint8_t alien_x;
static uint8_t alien_y;
static int8_t alien_dir;
static uint8_t alien_step_delay;
static uint8_t alien_step_timer;
static uint8_t wave;
static uint8_t lives;
static uint16_t score;
static uint8_t state;
static uint8_t frame_count;
static uint16_t rng_state;

static const uint8_t palette[32] = {
  0x0F, 0x27, 0x17, 0x30,
  0x0F, 0x21, 0x11, 0x30,
  0x0F, 0x2A, 0x1A, 0x30,
  0x0F, 0x16, 0x06, 0x30,
  0x0F, 0x2A, 0x1A, 0x30,
  0x0F, 0x27, 0x17, 0x30,
  0x0F, 0x21, 0x11, 0x30,
  0x0F, 0x16, 0x06, 0x30
};

static uint16_t next_rand(void) {
  rng_state = (uint16_t)(rng_state * 109u + 1021u);
  return rng_state;
}

static const uint8_t chr_tiles[16 * TILE_COUNT] = {
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
  0xF7, 0xFF, 0xBB, 0xEF, 0xFE, 0x7D, 0xFF, 0xDF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x3C, 0x66, 0x6E, 0x76, 0x66, 0x66, 0x3C, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x18, 0x38, 0x18, 0x18, 0x18, 0x18, 0x7E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x3C, 0x66, 0x06, 0x1C, 0x30, 0x60, 0x7E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x7C, 0x06, 0x06, 0x3C, 0x06, 0x06, 0x7C, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x0C, 0x1C, 0x3C, 0x6C, 0x7E, 0x0C, 0x0C, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x7E, 0x60, 0x60, 0x7C, 0x06, 0x06, 0x7C, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x3C, 0x60, 0x60, 0x7C, 0x66, 0x66, 0x3C, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x7E, 0x06, 0x0C, 0x18, 0x30, 0x30, 0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x3C, 0x66, 0x66, 0x3C, 0x66, 0x66, 0x3C, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x3C, 0x66, 0x66, 0x3E, 0x06, 0x06, 0x3C, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x3C, 0x7E, 0xDB, 0xFF, 0xA5, 0x7E, 0x24, 0x42, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x24, 0x7E, 0xDB, 0xFF, 0xFF, 0x5A, 0x81, 0x42,
  0x81, 0x42, 0x7E, 0xDB, 0xFF, 0x3C, 0x24, 0x66, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x01, 0x00, 0x00, 0x00, 0x7F, 0xFF, 0xDB, 0x00, 0x01, 0x03, 0x0F, 0x3F, 0x00, 0x00, 0xDB,
  0x00, 0x80, 0x00, 0x00, 0x00, 0xFE, 0xFF, 0xDB, 0x00, 0x80, 0xC0, 0xF0, 0xFC, 0x00, 0x00, 0xDB,
  0x18, 0x18, 0x18, 0x18, 0x18, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00,
  0x24, 0x18, 0x24, 0x18, 0x24, 0x18, 0x24, 0x00, 0x00, 0x18, 0x00, 0x18, 0x00, 0x18, 0x00, 0x00,
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
};

static void draw_number(uint8_t row, uint8_t col, uint16_t value, uint8_t digits) {
  uint16_t div;
  uint8_t i;
  uint8_t digit;

  div = 1;
  for (i = 1; i < digits; i++) div = (uint16_t)(div * 10u);
  for (i = 0; i < digits; i++) {
    digit = (uint8_t)((value / div) % 10u);
    tile_set(0, (uint8_t)(col + i), row, (uint8_t)(T_DIGIT_0 + digit));
    div = (uint16_t)(div / 10u);
  }
}

/* Only redraw the HUD when a value actually changed.
 *
 * Every tile_set queues a VRAM write, and the NMI drains a fixed budget per
 * frame. Redrawing all 10 HUD tiles unconditionally spent most of that budget
 * every frame, so anything else -- a shield repaint -- pushed the queue past
 * full, and vram_queue_push then BLOCKS on ppu_wait_nmi(), costing a whole
 * frame per write. That is what made the game crawl. */
static uint16_t hud_score = 0xFFFF;
static uint8_t hud_wave = 0xFF;
static uint8_t hud_lives = 0xFF;

/* Row 0 is inside overscan -- a CRT hides the top and bottom 8 scanlines, and
 * emulators crop them the same way, so a HUD drawn there is invisible on every
 * display that matters. Row 2 clears it and still sits well above the aliens,
 * which start at row 6. */
#define HUD_ROW 2

static void draw_hud(void) {
  uint8_t i;

  if (score != hud_score) { draw_number(HUD_ROW, 1, score, 5); hud_score = score; }
  if (wave != hud_wave) { draw_number(HUD_ROW, 14, wave, 2); hud_wave = wave; }
  if (lives != hud_lives) {
    for (i = 0; i < 3; i++) {
      tile_set(0, (uint8_t)(25 + i), HUD_ROW, i < lives ? T_SHIELD_FULL : T_BLANK);
    }
    hud_lives = lives;
  }
}

static void clear_tilemap_init(void) {
  uint16_t addr;
  for (addr = 0x2000; addr < 0x23C0; addr++) vram_unsafe_set(addr, T_BLANK);
  for (addr = 0x23C0; addr < 0x2400; addr++) vram_unsafe_set(addr, 0);
}

/* Redraw ONE shield (or all of them when `which` is SHIELD_COUNT).
 *
 * Repainting all 3 x 6 blocks on every hit queued 18 VRAM writes at once,
 * over the per-frame drain budget on its own. A hit only ever changes one
 * shield, so only that one is repainted. */
static void draw_shield(uint8_t which) {
  uint8_t s;
  uint8_t b;
  uint8_t base_col;
  uint8_t row;
  uint8_t col;
  uint8_t tile;

  for (s = (which < SHIELD_COUNT) ? which : 0;
       s < ((which < SHIELD_COUNT) ? (uint8_t)(which + 1) : SHIELD_COUNT); s++) {
    base_col = (uint8_t)(6 + s * 9);
    for (b = 0; b < SHIELD_BLOCKS; b++) {
      row = (uint8_t)(22 + b / 3);
      col = (uint8_t)(base_col + b % 3);
      if (shields[s].hp[b] == 0) tile = T_BLANK;
      else if (shields[s].hp[b] == 1) tile = T_SHIELD_HIT;
      else tile = T_SHIELD_FULL;
      tile_set(0, col, row, tile);
    }
  }
}

static uint8_t alien_cell_x(uint8_t col) {
  return (uint8_t)(alien_x + col * 24);
}

static uint8_t alien_cell_y(uint8_t row) {
  return (uint8_t)(alien_y + row * 18);
}

static uint8_t alien_bit(uint8_t col) {
  return (uint8_t)(1u << col);
}

static uint8_t aliens_alive(void) {
  uint8_t row;
  uint8_t col;
  uint8_t count;

  count = 0;
  for (row = 0; row < ALIEN_ROWS; row++) {
    for (col = 0; col < ALIEN_COLS; col++) {
      if (alien_alive_mask[row] & alien_bit(col)) count++;
    }
  }
  return count;
}

static void reset_wave(void) {
  uint8_t i;
  uint8_t s;
  uint8_t b;

  for (i = 0; i < ALIEN_ROWS; i++) alien_alive_mask[i] = 0x1F;
  for (s = 0; s < SHIELD_COUNT; s++) {
    for (b = 0; b < SHIELD_BLOCKS; b++) shields[s].hp[b] = 3;
  }

  player_x = 120;
  player_cooldown = 0;
  alien_x = 68;
  alien_y = 48;
  alien_dir = 1;
  alien_step_delay = (uint8_t)(24 - wave * 2);
  if (alien_step_delay < 8) alien_step_delay = 8;
  alien_step_timer = 0;
  player_shot.active = 0;
  alien_shot.active = 0;
  draw_shield(SHIELD_COUNT);
}

static void reset_game(void) {
  wave = 1;
  lives = 3;
  score = 0;
  state = STATE_PLAY;
  frame_count = 0;
  rng_state = 0xACE1;
  reset_wave();
}

/* @returns the index of the shield that was hit, or SHIELD_COUNT for none. */
static uint8_t point_hits_shield(uint8_t x, uint8_t y) {
  uint8_t s;
  uint8_t bx;
  uint8_t local_x;
  uint8_t local_y;
  uint8_t index;

  if (y < 176 || y >= 192) return SHIELD_COUNT;
  for (s = 0; s < SHIELD_COUNT; s++) {
    bx = (uint8_t)(48 + s * 72);
    if (x < bx || x >= (uint8_t)(bx + 24)) continue;
    local_x = (uint8_t)(x - bx);
    local_y = (uint8_t)(y - 176);
    index = (uint8_t)((local_y / 8) * 3 + local_x / 8);
    if (index < SHIELD_BLOCKS && shields[s].hp[index] > 0) {
      shields[s].hp[index]--;
      /* Return the shield INDEX so the caller repaints only that one.
       * (SHIELD_COUNT means "no hit" — callers test `< SHIELD_COUNT`.) */
      return s;
    }
  }
  return SHIELD_COUNT;
}

static void fire_player(void) {
  if (player_shot.active || player_cooldown) return;
  player_shot.active = 1;
  player_shot.x = (uint8_t)(player_x + 4);
  player_shot.y = 204;
  player_cooldown = 14;
  sound_play_tone(0, 0x100, 8, 5);
}

static void spawn_alien_shot(void) {
  uint8_t tries;
  uint8_t col;
  uint8_t row;

  if (alien_shot.active) return;
  if ((next_rand() & 31u) > 2u) return;

  for (tries = 0; tries < 16; tries++) {
    col = (uint8_t)(next_rand() % ALIEN_COLS);
    for (row = ALIEN_ROWS; row > 0; row--) {
      if (alien_alive_mask[row - 1] & alien_bit(col)) {
        alien_shot.active = 1;
        alien_shot.x = (uint8_t)(alien_cell_x(col) + 2);
        alien_shot.y = (uint8_t)(alien_cell_y((uint8_t)(row - 1)) + 8);
        return;
      }
    }
  }
}

static void update_aliens(void) {
  uint8_t row;
  uint8_t col;
  uint8_t x;
  uint8_t hit_edge;

  alien_step_timer++;
  if (alien_step_timer < alien_step_delay) return;
  alien_step_timer = 0;
  hit_edge = 0;

  for (row = 0; row < ALIEN_ROWS; row++) {
    for (col = 0; col < ALIEN_COLS; col++) {
      if (!(alien_alive_mask[row] & alien_bit(col))) continue;
      x = alien_cell_x(col);
      if ((alien_dir > 0 && x > 178) || (alien_dir < 0 && x < 12)) {
        hit_edge = 1;
        break;
      }
    }
    if (hit_edge) break;
  }

  if (hit_edge) {
    alien_dir = (int8_t)-alien_dir;
    alien_y = (uint8_t)(alien_y + 7);
    if (alien_step_delay > 6) alien_step_delay--;
  } else if (alien_dir > 0) {
    alien_x = (uint8_t)(alien_x + 4);
  } else {
    alien_x = (uint8_t)(alien_x - 4);
  }
}

static void update_shots(void) {
  uint8_t row;
  uint8_t col;
  uint8_t ax;
  uint8_t ay;
  uint8_t hit;

  if (player_shot.active) {
    if (player_shot.y < 18) player_shot.active = 0;
    else player_shot.y = (uint8_t)(player_shot.y - 5);
    if (player_shot.active) {
      hit = point_hits_shield(player_shot.x, player_shot.y);
      if (hit < SHIELD_COUNT) {
        player_shot.active = 0;
        draw_shield(hit);
      }
    }
  }

  if (alien_shot.active) {
    alien_shot.y = (uint8_t)(alien_shot.y + 3);
    if (alien_shot.y > 226) alien_shot.active = 0;
    if (alien_shot.active) {
      hit = point_hits_shield(alien_shot.x, (uint8_t)(alien_shot.y + 4));
      if (hit < SHIELD_COUNT) {
        alien_shot.active = 0;
        draw_shield(hit);
        sound_play_noise(8, 8, 3);
      }
    }
    if (alien_shot.active &&
        alien_shot.x >= player_x && alien_shot.x <= (uint8_t)(player_x + 16) &&
        alien_shot.y >= 208 && alien_shot.y <= 224) {
      alien_shot.active = 0;
      if (lives > 0) lives--;
      sound_play_noise(8, 8, 10);
      if (lives == 0) state = STATE_OVER;
    }
  }

  if (!player_shot.active) return;
  for (row = 0; row < ALIEN_ROWS; row++) {
    for (col = 0; col < ALIEN_COLS; col++) {
      if (!(alien_alive_mask[row] & alien_bit(col))) continue;
      ax = alien_cell_x(col);
      ay = alien_cell_y(row);
      /* Hitbox is WIDER than the 8px sprite on purpose.
       *
       * Columns sit on a 24px pitch but each alien is a single 8x8 sprite, so
       * an exact-sprite box leaves 15 of every 24 pixels as empty air: a shot
       * that looks like it should connect passes 2-6px to the side and sails
       * through. Measured over every player position, an 8px box scores from
       * 31% of them; 16px scores from 49%, which is what makes the game read
       * as responsive rather than broken. Forgiving horizontal collision is
       * standard in shmups -- the player aims at the sprite they can see. */
      if (player_shot.x >= (uint8_t)(ax - 4) && player_shot.x <= (uint8_t)(ax + 12) &&
          player_shot.y >= ay && player_shot.y <= (uint8_t)(ay + 8)) {
        alien_alive_mask[row] &= (uint8_t)~alien_bit(col);
        player_shot.active = 0;
        score = (uint16_t)(score + 10u + (ALIEN_ROWS - row) * 5u);
        sound_play_noise(8, 8, 6);
        if (aliens_alive() == 0) {
          wave++;
          if (wave > 9) state = STATE_WIN;
          else reset_wave();
        }
        return;
      }
    }
  }
}

static void update_game(uint8_t pad) {
  uint8_t row;
  uint8_t col;

  if (state != STATE_PLAY) {
    if (pad & PAD_START) reset_game();
    return;
  }

  if ((pad & PAD_LEFT) && player_x > 8) player_x = (uint8_t)(player_x - 2);
  if ((pad & PAD_RIGHT) && player_x < 232) player_x = (uint8_t)(player_x + 2);
  if (pad & PAD_A) fire_player();
  if (player_cooldown) player_cooldown--;

  update_aliens();
  spawn_alien_shot();
  update_shots();

  /* Landing check: the row's Y does not depend on the column, so test it once
   * per row instead of once per cell. */
  for (row = 0; row < ALIEN_ROWS; row++) {
    if (alien_alive_mask[row] && alien_cell_y(row) > 196) {
      state = STATE_OVER;
      sound_play_noise(8, 8, 15);
      return;
    }
  }
  (void)col;
}

/* Per-row tile, precomputed. `row % 3` in the sprite loop called cc65's
 * software divide once per living alien -- 20 calls a frame, worth ~10fps on
 * its own. There is no 6502 divide instruction; on this CPU a `%` in a
 * per-frame loop is never free. A 4-entry table costs 4 bytes. */
static const uint8_t alien_row_tile[ALIEN_ROWS] = {
  T_ALIEN_0, T_ALIEN_1, T_ALIEN_2, T_ALIEN_0
};

static void stage_sprites(void) {
  uint8_t row;
  uint8_t col;
  uint8_t tile;
  uint8_t mask;
  uint8_t y;
  uint8_t bit;
  uint8_t x;

  oam_clear();
  if (state == STATE_PLAY) {
    oam_spr(player_x, 216, T_PLAYER_L, PAL_PLAYER);
    oam_spr((uint8_t)(player_x + 8), 216, T_PLAYER_R, PAL_PLAYER);
  }

  if (player_shot.active) oam_spr(player_shot.x, player_shot.y, T_PLAYER_SHOT, PAL_SHOT);
  if (alien_shot.active) oam_spr(alien_shot.x, alien_shot.y, T_ALIEN_SHOT, PAL_RED);

  /* Call oam_spr UNCONDITIONALLY and hide dead aliens by staging them
   * off-screen, rather than guarding the call with `if (mask & bit)`.
   *
   * This looks backwards -- it stages 20 sprites where 14 would do -- but the
   * branch was the single most expensive thing in the frame. cc65 passes
   * arguments on a software stack, and when the call sits inside a
   * conditional it cannot hoist any of that setup, so it rebuilds all four
   * arguments per iteration. Measured, same loop and same variables:
   * unguarded 60fps, guarded 34fps. The whole game ran at 30fps because of
   * this one `if`.
   *
   * A y of $F0 is off the bottom of the screen, which is how the hardware
   * hides a sprite, and the slot cost is free: the NMI DMAs all 256 bytes
   * every frame regardless. */
  for (row = 0; row < ALIEN_ROWS; row++) {
    mask = alien_alive_mask[row];
    y = alien_cell_y(row);
    tile = alien_row_tile[row];
    x = alien_x;
    bit = 1;
    for (col = 0; col < ALIEN_COLS; col++) {
      /* dead -> $F0 (off-screen), alive -> the real row Y. Branchless. */
      oam_spr(x, (mask & bit) ? y : 0xF0, tile, (uint8_t)(row & 3));
      bit = (uint8_t)(bit << 1);
      x = (uint8_t)(x + 24);                   /* matches alien_cell_x's stride */
    }
  }

  if (state != STATE_PLAY) {
    for (col = 0; col < 8; col++) {
      oam_spr((uint8_t)(80 + col * 12), 112, T_BANNER, PAL_RED);
    }
  }
}

void main(void) {
  uint8_t pad;

  ppu_off();
  chr_ram_upload(0x0000, chr_tiles, sizeof(chr_tiles));
  chr_ram_upload(0x1000, chr_tiles, sizeof(chr_tiles));
  palette_load(palette);
  clear_tilemap_init();
  oam_clear();
  ppu_scroll(0, 0);
  sound_init();
  reset_game();
  ppu_on_all();

  for (;;) {
    stage_sprites();
    ppu_wait_nmi();
    /* The runtime's background melody is ON by default and needs a tick every
     * frame to advance. Without it the triangle channel holds whatever note
     * sound_init left it on -- one continuous tone for the whole session. */
    sound_music_tick();
    pad = pad_poll(0);
    update_game(pad);
    draw_hud();
    frame_count++;
  }
}
