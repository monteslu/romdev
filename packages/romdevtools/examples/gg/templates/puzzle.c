/* ── puzzle.c — SMS match-3 falling-block scaffold ─────────────────
 *
 * Mirrors the NES/Genesis/SNES/GB puzzle scaffolds. 6-wide × 12-tall
 * grid drawn via the BG tilemap (three distinct BG tile shapes for
 * R/G/B cells). 1×3 active piece, rotate via B1, soft-drop via DOWN,
 * START hard-drops, horizontal-triple clear.
 */
#include "gg_hw.h"
#include "gg_sfx.h"
#include "gg_music.h"
#include <stdint.h>

extern void gg_vdp_init(void);
extern void gg_vdp_display_on(void);
extern void gg_vdp_set_addr(uint16_t addr, uint8_t prefix);
extern void gg_load_palette(const uint8_t *palette);
extern void gg_load_tiles(uint16_t vram_dest, const uint8_t *src, uint16_t byte_count);
extern void gg_set_tilemap_cell(uint8_t row, uint8_t col, uint8_t tile_idx, uint8_t attr);
extern void gg_vblank_wait(void);
extern uint8_t gg_joypad_read(void);

#define COLS 6
#define ROWS 12

#define T_BLANK 0
#define T_R     1
#define T_G     2
#define T_B     3
#define T_WALL  4   /* well border         */
#define T_FIELD 5   /* empty well interior */

static const uint8_t palette[32] = {
  /* BG palette: 0 backdrop navy, 1 red, 2 green, 3 blue, 4 wall grey,
   * 5 dim field blue */
  0x10,0x03,0x0C,0x30, 0x15,0x14, 0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
};

static const uint8_t bg_tiles[32 * 6] = {
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
  /* T_WALL — colour 4 fill (plane 2 set) */
  0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00,
  0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00,
  0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00,
  0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00,
  /* T_FIELD — colour 5 fill (planes 0+2 set) = dim field */
  0xFF,0x00,0xFF,0x00, 0xFF,0x00,0xFF,0x00,
  0xFF,0x00,0xFF,0x00, 0xFF,0x00,0xFF,0x00,
  0xFF,0x00,0xFF,0x00, 0xFF,0x00,0xFF,0x00,
  0xFF,0x00,0xFF,0x00, 0xFF,0x00,0xFF,0x00,
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
  return T_FIELD;   /* empty cell shows the dim well interior, not backdrop */
}

/* GG shows only the centered cols 6..25 / rows 3..20. Place the 6×12 grid
 * at tilemap cols 7..12, rows 4..15 so the whole well sits inside that
 * visible band. */
static void draw_cell(int8_t col, int8_t row, uint8_t cell) {
  if (row < 0 || row >= ROWS) return;
  gg_set_tilemap_cell((uint8_t)(row + 4), (uint8_t)(col + 7), tile_for(cell), 0);
}

/* Draw the well: a grey border frame around the 6×12 play field with a dim
 * field interior, so the playfield is clearly visible even when empty. The
 * grid maps cell (col,row) -> tilemap (row+4, col+7) = rows 4..15 cols 7..12.
 * Frame the perimeter at rows 3..16, cols 6..13 — inside the GG viewport. */
static void draw_well(void) {
  uint8_t r, c;
  for (r = 3; r <= 16; r++) {
    for (c = 6; c <= 13; c++) {
      uint8_t t = T_FIELD;
      if (r == 3 || r == 16 || c == 6 || c == 13) t = T_WALL;
      gg_set_tilemap_cell(r, c, t, 0);
    }
  }
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

/* ── match / clear / gravity core (ported from the GBC reference puzzle).
 * The old scan was horizontal-only AND cleared cells mid-scan, so vertical
 * and diagonal runs never cleared, 4+ runs half-cleared, and nothing ever
 * fell afterwards ("rows don't shift down"). This marks every 3+ run in all
 * 4 directions, clears them, applies per-column gravity, and loops so
 * cascades chain (score scales with chain depth). */
static uint8_t matched[ROWS][COLS];
static const int8_t DIRS4[4][2] = { {0,1}, {1,0}, {1,1}, {1,-1} };

static uint8_t mark_and_count(void) {
  uint8_t r, c, d, len, k, cnt;
  uint8_t col;
  int8_t dr, dc;
  int sr, sc;
  cnt = 0;
  for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) matched[r][c] = 0;
  for (r = 0; r < ROWS; r++) {
    for (c = 0; c < COLS; c++) {
      col = grid[r][c];
      if (col == 0) continue;
      for (d = 0; d < 4; d++) {
        dr = DIRS4[d][0]; dc = DIRS4[d][1];
        sr = (int)r - dr; sc = (int)c - dc;
        if (sr >= 0 && sr < ROWS && sc >= 0 && sc < COLS
            && grid[sr][sc] == col) continue;  /* not the run's start */
        len = 1;
        sr = (int)r + dr; sc = (int)c + dc;
        while (sr >= 0 && sr < ROWS && sc >= 0 && sc < COLS
               && grid[sr][sc] == col) { len++; sr += dr; sc += dc; }
        if (len >= 3) {
          sr = r; sc = c;
          for (k = 0; k < len; k++) {
            if (!matched[sr][sc]) { matched[sr][sc] = 1; cnt++; }
            sr += dr; sc += dc;
          }
        }
      }
    }
  }
  return cnt;
}

/* collapse each column so survivors rest on the floor (in place: walk
 * from the bottom, copying gems down to a write cursor, then zero above) */
static void apply_gravity(void) {
  uint8_t c;
  int r, w;
  for (c = 0; c < COLS; c++) {
    w = ROWS - 1;
    for (r = ROWS - 1; r >= 0; r--) {
      if (grid[r][c] != 0) { grid[w][c] = grid[r][c]; w--; }
    }
    for (; w >= 0; w--) grid[w][c] = 0;
  }
}

static void resolve_board(void) {
  uint8_t n, r, c, chain;
  unsigned int amt;
  chain = 0;
  while (1) {
    n = mark_and_count();
    if (n == 0) break;
    chain++;
    for (r = 0; r < ROWS; r++)
      for (c = 0; c < COLS; c++)
        if (matched[r][c]) grid[r][c] = 0;
    amt = (unsigned int)n * 10u;
    if (chain > 1) amt = amt * chain;
    if (score < 65500) score = (uint16_t)(score + amt);
    sfx_tone(0, 200, 10);  /* clear chime */
    apply_gravity();
  }
}

static void lock_piece(void) {
  uint8_t i;
  int8_t r;
  for (i = 0; i < 3; i++) {
    r = (int8_t)(piece_y + i);
    if (r >= 0 && r < ROWS) grid[r][piece_x] = piece[i];
  }
  resolve_board();
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

  gg_vdp_init();
  gg_load_palette(palette);
  gg_load_tiles(0x0000, bg_tiles, 32 * 6);

  for (r = 0; r < 24; r++) for (c = 0; c < 32; c++) gg_set_tilemap_cell(r, c, T_BLANK, 0);
  for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) grid[r][c] = 0;

  score = 0;
  fall_timer = 0;
  new_piece();
  draw_well();
  draw_grid();

  sfx_init();
  music_init();
  music_play(0);   /* continuous background music ("no sound" was the playtest verdict) */
  gg_vdp_display_on();

  do {
    uint8_t pad, fall_rate, t;
    gg_vblank_wait();
    sfx_update();
    music_update();
    draw_piece(1);

    pad = gg_joypad_read();
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
