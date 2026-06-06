// ── puzzle.c — Commodore 64 match-3 falling-block puzzle ─────────────
//
// 6×12 grid rendered in the C64 screen-RAM character matrix (40×25).
// 3 colors (R/G/B) via the COLOR_RAM at $D800. Active piece is 1×3
// vertical. Joystick port 2: LEFT/RIGHT shift, FIRE rotates colors,
// DOWN soft-drop, B2 hard-drop. Horizontal triples clear + score.

#include "c64_registers.h"
#include "c64_sfx.h"
#include <stdint.h>

#define POKE(addr, val) (*(volatile uint8_t*)(addr) = (val))
#define PEEK(addr)      (*(volatile uint8_t*)(addr))

#define SCREEN ((volatile uint8_t*)0x0400)
#define COLORS ((volatile uint8_t*)0xD800)

#define JOY_UP    0x01
#define JOY_DOWN  0x02
#define JOY_LEFT  0x04
#define JOY_RIGHT 0x08
#define JOY_FIRE  0x10

#define COLS 6
#define ROWS 12
#define GRID_C 17        /* center grid in the 40-col matrix */
#define GRID_R 6

#define CELL_CHAR  0xA0  /* solid block */

static uint8_t grid[ROWS][COLS];
static uint8_t piece[3];
static int8_t  piece_x, piece_y;
static uint8_t fall_timer;
static uint16_t score;
static uint32_t rng = 1;

static void wait_vblank(void) {
  while (PEEK(VIC_RASTER) < 250) { }
  while (PEEK(VIC_RASTER) >= 250) { }
}

static uint8_t rng_pick(void) {
  rng = rng * 1103515245u + 12345u;
  return (uint8_t)(1 + (rng >> 16) % 3);
}

static void draw_cell(int8_t r, int8_t c) {
  uint16_t sx, sy;
  uint8_t col_chr;
  if (r < 0 || r >= ROWS) return;
  sx = GRID_C + c;
  sy = GRID_R + r;
  col_chr = grid[r][c];
  if (col_chr == 0) {
    SCREEN[sy * 40 + sx] = ' ';
  } else {
    SCREEN[sy * 40 + sx] = CELL_CHAR;
    COLORS[sy * 40 + sx] = col_chr;  /* col is the C64 colour id */
  }
}

static void draw_grid(void) {
  uint8_t r, c;
  for (r = 0; r < ROWS; r++)
    for (c = 0; c < COLS; c++) draw_cell((int8_t)r, (int8_t)c);
}

static void draw_piece(uint8_t clear) {
  uint8_t i;
  int8_t r;
  for (i = 0; i < 3; i++) {
    r = (int8_t)(piece_y + i);
    if (r < 0 || r >= ROWS) continue;
    if (clear) {
      grid[r][piece_x] = 0;
      draw_cell(r, (int8_t)piece_x);
    } else {
      uint8_t saved = grid[r][piece_x];
      grid[r][piece_x] = piece[i];
      draw_cell(r, (int8_t)piece_x);
      grid[r][piece_x] = saved;
    }
  }
}

static uint8_t collides(int8_t x, int8_t y) {
  uint8_t i;
  int8_t r;
  if (x < 0 || x >= COLS) return 1;
  for (i = 0; i < 3; i++) {
    r = (int8_t)(y + i);
    if (r >= ROWS) return 1;
    if (r >= 0 && grid[r][x] != 0) return 1;
  }
  return 0;
}

static void new_piece(void) {
  piece[0] = (uint8_t)(2 + rng_pick());  /* C64 colors 3,4,5: red, mauve, green */
  piece[1] = (uint8_t)(2 + rng_pick());
  piece[2] = (uint8_t)(2 + rng_pick());
  piece_x = COLS / 2 - 1;
  piece_y = -3;
}

static void lock_piece(void) {
  uint8_t i, c;
  int8_t r;
  uint8_t a, b, d;
  for (i = 0; i < 3; i++) {
    r = (int8_t)(piece_y + i);
    if (r >= 0 && r < ROWS) grid[r][piece_x] = piece[i];
  }
  for (i = 0; i < 3; i++) {
    r = (int8_t)(piece_y + i);
    if (r < 0 || r >= ROWS) continue;
    for (c = 0; c <= COLS - 3; c++) {
      a = grid[r][c]; b = grid[r][c+1]; d = grid[r][c+2];
      if (a != 0 && a == b && b == d) {
        grid[r][c] = 0;
        grid[r][c+1] = 0;
        grid[r][c+2] = 0;
        if (score < 65500) score += 30;
        sfx_tone(0, 0x80, 0x10, 12);
      }
    }
  }
  draw_grid();
}

void main(void) {
  uint8_t r, c, pad, prev = 0, fall_rate, t;
  POKE(VIC_BORDER, 0x00);
  POKE(VIC_BG0,    0x00);

  for (r = 0; r < ROWS; r++)
    for (c = 0; c < COLS; c++) grid[r][c] = 0;

  score = 0; fall_timer = 0;
  sfx_init();
  new_piece();
  draw_grid();

  for (;;) {
    pad = (uint8_t)(~PEEK(CIA1_PRA) & 0x1F);
    wait_vblank();
    sfx_update();
    draw_piece(1);

    if ((pad & JOY_LEFT)  && !(prev & JOY_LEFT)  && !collides(piece_x - 1, piece_y)) piece_x--;
    if ((pad & JOY_RIGHT) && !(prev & JOY_RIGHT) && !collides(piece_x + 1, piece_y)) piece_x++;
    if ((pad & JOY_FIRE)  && !(prev & JOY_FIRE)) {
      t = piece[0]; piece[0] = piece[1]; piece[1] = piece[2]; piece[2] = t;
      sfx_tone(1, 0x20, 0x14, 2);
    }
    if ((pad & JOY_UP)    && !(prev & JOY_UP)) {
      while (!collides(piece_x, (int8_t)(piece_y + 1))) piece_y++;
      lock_piece();
      new_piece();
      prev = pad;
      continue;
    }
    prev = pad;

    fall_rate = (pad & JOY_DOWN) ? 4 : 30;
    if (++fall_timer >= fall_rate) {
      fall_timer = 0;
      if (collides(piece_x, (int8_t)(piece_y + 1))) {
        lock_piece();
        new_piece();
      } else {
        piece_y++;
      }
    }
    draw_piece(0);
  }
}
