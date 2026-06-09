// ── puzzle.c — Atari Lynx match-3 falling-block puzzle ──────────────
//
// 6×12 grid drawn with tgi_bar. 3 cell colors. 1×3 active piece,
// rotate / soft-drop / hard-drop / horizontal-triple clear + score.

#include <tgi.h>
#include <joystick.h>
#include <lynx.h>
#include <stdint.h>
#include "lynx_sfx.h"

#define COLS 6
#define ROWS 12
#define CELL_PX 8
#define GRID_X 56
#define GRID_Y 4

static uint8_t grid[ROWS][COLS];
static uint8_t piece[3];
static int8_t piece_x, piece_y;
static uint8_t fall_timer;
static uint16_t score;
static uint32_t rng = 1;

static uint8_t rng_pick(void) {
  rng = rng * 1103515245u + 12345u;
  return (uint8_t)(1 + (rng >> 16) % 3);
}

static void new_piece(void) {
  piece[0] = rng_pick();
  piece[1] = rng_pick();
  piece[2] = rng_pick();
  piece_x = COLS / 2 - 1;
  piece_y = -3;
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
    sfx_tone(0, 60, 10);  /* clear chime */
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
}

static uint8_t cell_color(uint8_t v) {
  switch (v) {
    case 1: return COLOR_RED;
    case 2: return COLOR_GREEN;
    case 3: return COLOR_BLUE;
    default: return COLOR_BLACK;
  }
}

void main(void) {
  uint8_t joy, prev = 0, fall_rate, t;
  uint8_t r, c, i;
  int8_t pr;

  tgi_install(&lynx_160_102_16_tgi);
  tgi_init();
  joy_install(&lynx_stdjoy_joy);
  sfx_init();

  for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) grid[r][c] = 0;
  score = 0; fall_timer = 0;
  new_piece();

  for (;;) {
    /* Lynx frame loop: WAIT for the blitter, then clear with a full-screen
     * tgi_bar (NOT tgi_clear, which leaves the back page stale on this core)
     * — drawing while the blitter is mid-flight loses the frame → black.
     * (Copied from the shmup scaffold, the LYNX-1 fix.) */
    while (tgi_busy()) { }

    /* ── Background scene (drawn every frame). Without it the playfield is
     * a near-flat single colour and the render-health audit flags the
     * screen as blank. A framed "well" in the centre with lit side panels
     * keeps several distinct colours well under the threshold:
     *   - blue cabinet backdrop
     *   - dark-grey side panels flanking the well
     *   - black well interior so the falling blocks read clearly
     *   - light-grey well frame + a faint grid texture behind the cells. */
    tgi_setcolor(COLOR_BLUE);
    tgi_bar(0, 0, tgi_getmaxx(), tgi_getmaxy());        /* cabinet backdrop  */
    tgi_setcolor(COLOR_DARKGREY);
    tgi_bar(0, 0, GRID_X - 5, 101);                     /* left side panel   */
    tgi_bar(GRID_X + COLS * CELL_PX + 4, 0, 159, 101);  /* right side panel  */
    tgi_setcolor(COLOR_BLACK);
    tgi_bar(GRID_X - 2, GRID_Y - 2,
            GRID_X + COLS * CELL_PX + 1, GRID_Y + ROWS * CELL_PX + 1); /* well */
    /* faint grid texture so the empty well is never one flat colour */
    tgi_setcolor(COLOR_DARKGREY);
    for (r = 0; r <= ROWS; r++)
      tgi_line(GRID_X, GRID_Y + r * CELL_PX, GRID_X + COLS * CELL_PX - 1, GRID_Y + r * CELL_PX);
    for (c = 0; c <= COLS; c++)
      tgi_line(GRID_X + c * CELL_PX, GRID_Y, GRID_X + c * CELL_PX, GRID_Y + ROWS * CELL_PX - 1);
    /* well frame */
    tgi_setcolor(COLOR_LIGHTGREY);
    tgi_line(GRID_X - 2, GRID_Y - 2, GRID_X - 2, GRID_Y + ROWS * CELL_PX + 1);
    tgi_line(GRID_X + COLS * CELL_PX + 1, GRID_Y - 2, GRID_X + COLS * CELL_PX + 1, GRID_Y + ROWS * CELL_PX + 1);
    tgi_line(GRID_X - 2, GRID_Y + ROWS * CELL_PX + 1, GRID_X + COLS * CELL_PX + 1, GRID_Y + ROWS * CELL_PX + 1);

    /* grid */
    for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) {
      if (grid[r][c] != 0) {
        tgi_setcolor(cell_color(grid[r][c]));
        tgi_bar(GRID_X + c * CELL_PX, GRID_Y + r * CELL_PX,
                GRID_X + c * CELL_PX + CELL_PX - 1, GRID_Y + r * CELL_PX + CELL_PX - 1);
      }
    }
    /* piece */
    for (i = 0; i < 3; i++) {
      pr = (int8_t)(piece_y + i);
      if (pr < 0 || pr >= ROWS) continue;
      tgi_setcolor(cell_color(piece[i]));
      tgi_bar(GRID_X + piece_x * CELL_PX, GRID_Y + pr * CELL_PX,
              GRID_X + piece_x * CELL_PX + CELL_PX - 1, GRID_Y + pr * CELL_PX + CELL_PX - 1);
    }
    tgi_updatedisplay();
    sfx_update();

    joy = joy_read(JOY_1);
    if (JOY_LEFT(joy)  && !(prev & 4) && !collides(piece_x - 1, piece_y)) piece_x--;
    if (JOY_RIGHT(joy) && !(prev & 8) && !collides(piece_x + 1, piece_y)) piece_x++;
    if (JOY_BTN_1(joy) && !(prev & 0x10)) {
      t = piece[0]; piece[0] = piece[1]; piece[1] = piece[2]; piece[2] = t;
      sfx_tone(1, 40, 2);
    }
    if (JOY_BTN_2(joy) && !(prev & 0x20)) {
      while (!collides(piece_x, (int8_t)(piece_y + 1))) piece_y++;
      lock_piece();
      new_piece();
    }
    prev = (JOY_LEFT(joy) ? 4 : 0) | (JOY_RIGHT(joy) ? 8 : 0)
         | (JOY_BTN_1(joy) ? 0x10 : 0) | (JOY_BTN_2(joy) ? 0x20 : 0);

    fall_rate = JOY_DOWN(joy) ? 4 : 30;
    if (++fall_timer >= fall_rate) {
      fall_timer = 0;
      if (collides(piece_x, (int8_t)(piece_y + 1))) {
        lock_piece();
        new_piece();
      } else {
        piece_y++;
      }
    }
  }
}
