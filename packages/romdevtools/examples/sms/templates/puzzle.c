/* ── puzzle.c — SMS match-3 falling-block scaffold ─────────────────
 *
 * Mirrors the NES/Genesis/SNES/GB puzzle scaffolds. 6-wide × 12-tall
 * grid drawn via the BG tilemap (three distinct BG tile shapes for
 * R/G/B cells). 1×3 active piece, rotate via B1, soft-drop via DOWN,
 * START hard-drops, horizontal-triple clear.
 */
#include "sms_hw.h"
#include "sms_sfx.h"
#include <stdint.h>

extern void sms_vdp_init(void);
extern void sms_vdp_display_on(void);
extern void sms_vdp_set_addr(uint16_t addr, uint8_t prefix);
extern void sms_load_palette(const uint8_t *palette);
extern void sms_load_tiles(uint16_t vram_dest, const uint8_t *src, uint16_t byte_count);
extern void sms_set_tilemap_cell(uint8_t row, uint8_t col, uint8_t tile_idx, uint8_t attr);
extern void sms_vblank_wait(void);
extern uint8_t sms_joypad_read(void);

#define COLS 6
#define ROWS 12

#define T_BLANK 0
#define T_R     1
#define T_G     2
#define T_B     3

static const uint8_t palette[32] = {
  /* BG palette: backdrop black, red, green, blue */
  0x00,0x03,0x0C,0x30, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
};

static const uint8_t bg_tiles[32 * 4] = {
  /* T_BLANK */
  0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
  0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
  /* T_R — colour 1 fill */
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  /* T_G — colour 2 fill */
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  /* T_B — colour 3 fill (planes 0+1) */
  0xFF,0xFF,0x00,0x00, 0xFF,0xFF,0x00,0x00,
  0xFF,0xFF,0x00,0x00, 0xFF,0xFF,0x00,0x00,
  0xFF,0xFF,0x00,0x00, 0xFF,0xFF,0x00,0x00,
  0xFF,0xFF,0x00,0x00, 0xFF,0xFF,0x00,0x00,
};

static uint8_t grid[ROWS][COLS];
static uint8_t piece[3];
static int8_t piece_x;
static int8_t piece_y;
static uint8_t fall_timer;
static uint16_t score;
static uint32_t rng = 1;

static uint32_t xorshift(void) {
  rng ^= rng << 13;
  rng ^= rng >> 17;
  rng ^= rng << 5;
  return rng;
}

static uint8_t rand_color(void) { return (uint8_t)(1 + (xorshift() % 3)); }

static uint8_t tile_for(uint8_t c) {
  if (c == 1) return T_R;
  if (c == 2) return T_G;
  if (c == 3) return T_B;
  return T_BLANK;
}

static void draw_cell(int8_t col, int8_t row, uint8_t cell) {
  if (row < 0 || row >= ROWS) return;
  /* Centre the 6-col grid; +7 columns left margin, +1 row top margin. */
  sms_set_tilemap_cell((uint8_t)(row + 1), (uint8_t)(col + 7), tile_for(cell), 0);
}

static void draw_grid(void) {
  int8_t r, c;
  for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) draw_cell(c, r, grid[r][c]);
}

static void new_piece(void) {
  piece[0] = rand_color();
  piece[1] = rand_color();
  piece[2] = rand_color();
  piece_x = COLS / 2 - 1;
  piece_y = -3;
}

static uint8_t collides(int8_t col, int8_t row) {
  uint8_t i;
  int8_t r;
  if (col < 0 || col >= COLS) return 1;
  for (i = 0; i < 3; i++) {
    r = (int8_t)(row + i);
    if (r >= ROWS) return 1;
    if (r >= 0 && grid[r][col] != 0) return 1;
  }
  return 0;
}

static void lock_piece(void) {
  uint8_t i;
  int8_t r;
  int8_t c;
  uint8_t a, b, d;
  for (i = 0; i < 3; i++) {
    r = (int8_t)(piece_y + i);
    if (r >= 0 && r < ROWS) grid[r][piece_x] = piece[i];
  }
  for (i = 0; i < 3; i++) {
    r = (int8_t)(piece_y + i);
    if (r < 0 || r >= ROWS) continue;
    for (c = 0; c <= COLS - 3; c++) {
      a = grid[r][c]; b = grid[r][c + 1]; d = grid[r][c + 2];
      if (a != 0 && a == b && b == d) {
        grid[r][c] = 0; grid[r][c + 1] = 0; grid[r][c + 2] = 0;
        if (score < 65500u) score = (uint16_t)(score + 30);
        sfx_tone(0, 200, 10);  /* triple-clear chime */
      }
    }
  }
  draw_grid();
}

static void draw_piece(uint8_t clear) {
  uint8_t i;
  for (i = 0; i < 3; i++) {
    int8_t r = (int8_t)(piece_y + i);
    uint8_t v;
    if (r < 0 || r >= ROWS) continue;
    v = clear ? grid[r][piece_x] : piece[i];
    draw_cell(piece_x, r, v);
  }
}

void main(void) {
  uint8_t prev = 0;
  uint8_t r, c;

  sms_vdp_init();
  sms_load_palette(palette);
  sms_load_tiles(0x0000, bg_tiles, 32 * 4);

  for (r = 0; r < 24; r++) for (c = 0; c < 32; c++) sms_set_tilemap_cell(r, c, T_BLANK, 0);
  for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) grid[r][c] = 0;

  score = 0;
  fall_timer = 0;
  new_piece();
  draw_grid();

  sfx_init();
  sms_vdp_display_on();

  do {
    uint8_t pad, fall_rate, t;
    sms_vblank_wait();
    sfx_update();
    draw_piece(1);

    pad = sms_joypad_read();
    if ((pad & JOY_LEFT)  && !(prev & JOY_LEFT)
        && !collides((int8_t)(piece_x - 1), piece_y)) piece_x--;
    if ((pad & JOY_RIGHT) && !(prev & JOY_RIGHT)
        && !collides((int8_t)(piece_x + 1), piece_y)) piece_x++;
    if ((pad & JOY_B1) && !(prev & JOY_B1)) {
      t = piece[0]; piece[0] = piece[1]; piece[1] = piece[2]; piece[2] = t;
      sfx_tone(1, 350, 2);
    }
    if ((pad & JOY_B2) && !(prev & JOY_B2)) {
      while (!collides(piece_x, (int8_t)(piece_y + 1))) piece_y++;
      lock_piece();
      new_piece();
      prev = pad;
      continue;
    }
    prev = pad;

    fall_rate = (pad & JOY_DOWN) ? 4 : 30;
    fall_timer = (uint8_t)(fall_timer + 1);
    if (fall_timer >= fall_rate) {
      fall_timer = 0;
      if (collides(piece_x, (int8_t)(piece_y + 1))) {
        lock_piece();
        new_piece();
      } else {
        piece_y++;
      }
    }
    draw_piece(0);
  } while (1);
}
