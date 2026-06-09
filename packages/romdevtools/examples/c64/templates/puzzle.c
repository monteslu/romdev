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

/* Paint the playfield surround so the board reads as a real puzzle screen
 * instead of a tiny well floating in a black void: a dithered backdrop fills
 * the whole 40x25 matrix (two dark blues, so two colours share the screen
 * and neither dominates), then a bright frame is drawn one cell outside the
 * 6x12 well, and the well interior is cleared to black so the falling blocks
 * pop. Call ONCE before draw_grid(); draw_grid() owns the interior after. */
static void draw_field(void) {
  uint16_t i;
  uint8_t r, c;
  int8_t  fr, fc;
  for (i = 0; i < 1000; i++) {
    SCREEN[i] = 0xA0;                       /* solid block backdrop */
    COLORS[i] = ((i ^ (i >> 5)) & 1) ? 0x06 : 0x0E;  /* blue / light blue */
  }
  /* Bright frame one cell outside the well. */
  for (fc = -1; fc <= COLS; fc++) {
    r = (uint8_t)(GRID_R - 1);       SCREEN[r * 40 + GRID_C + fc] = 0xA0; COLORS[r * 40 + GRID_C + fc] = 0x01;
    r = (uint8_t)(GRID_R + ROWS);    SCREEN[r * 40 + GRID_C + fc] = 0xA0; COLORS[r * 40 + GRID_C + fc] = 0x01;
  }
  for (fr = -1; fr <= ROWS; fr++) {
    r = (uint8_t)(GRID_R + fr);
    SCREEN[r * 40 + GRID_C - 1]   = 0xA0; COLORS[r * 40 + GRID_C - 1]   = 0x01;
    SCREEN[r * 40 + GRID_C + COLS] = 0xA0; COLORS[r * 40 + GRID_C + COLS] = 0x01;
  }
  /* Clear the well interior to black so colored blocks stand out. */
  for (r = 0; r < ROWS; r++)
    for (c = 0; c < COLS; c++) SCREEN[(GRID_R + r) * 40 + GRID_C + c] = ' ';
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
    if (score < 65500u) score += amt;
    sfx_tone(0, 0x80, 0x10, 12);  /* clear chime */
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

void main(void) {
  uint8_t r, c, pad, prev = 0, fall_rate, t;
  POKE(VIC_BORDER, 0x06);   /* blue border frames the playfield */
  POKE(VIC_BG0,    0x00);   /* black well interior so blocks pop */

  for (r = 0; r < ROWS; r++)
    for (c = 0; c < COLS; c++) grid[r][c] = 0;

  score = 0; fall_timer = 0;
  sfx_init();
  draw_field();             /* paint the textured surround + well frame */
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
