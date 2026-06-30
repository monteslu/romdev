/* ── puzzle.c — CHROMA WELL: GameTank falling-jewel matcher (complete example) ──
 *
 * A COMPLETE, working game on the bundled GameTank SDK draw-queue runtime, in the
 * Columns mold: a vertical COLUMN OF 3 JEWELS falls as a unit into an 8-wide ×
 * 13-tall well. Move it left/right, CYCLE the three colors (A / B), soft-drop
 * (Down), hard-drop (Start). Line up 3+ of one color horizontally, vertically, or
 * DIAGONALLY to clear them; gravity pulls survivors down, which can CHAIN into
 * cascades for bonus points. Title → play → game-over → restart.
 *
 * FORK THIS. Markers:
 *   HARDWARE IDIOM (load-bearing) — every frame is redrawn from the grid as
 *     blitter rects via the draw QUEUE (gt_draw.h); the top scanline is re-cleaned
 *     with queue_clear_border() last (sprite/edge draws otherwise leave a seam).
 *   GAME LOGIC (clay) — well size, colors, fall speed, scoring, the cycle keys.
 *
 * CONTROLS: ←/→ move · A cycle colors up · B cycle colors down · Down soft-drop ·
 *           A/START to begin. SCREEN: 128x128. PLAYERS: 1.
 */
#include "gametank.h"
#include "draw_queue.h"
#include "input.h"
#include "gt_palette.h"
#include "gt_draw.h"
#include "gt_hud.h"
#include "gt_sound.h"

/* ── GAME LOGIC (clay) ── board geometry */
#define COLS     8
#define ROWS     13
#define CELL     8                 /* jewel pixel size (8*8 = 64-wide well) */
#define ORIGIN_X 30                /* well left edge on screen (centered) */
#define ORIGIN_Y 16                /* well top edge (below the HUD bar) */
#define N_COLORS 6

#define C_BG    GT_DKBLUE          /* backdrop */
#define C_WELL  GT_NIGHT           /* empty well interior */
#define C_FRAME GT_NAVY            /* well frame + HUD bar */
#define C_HUD   GT_WHITE

/* 6 jewel colors chosen to be clearly distinct hues — no two oranges. Bevel is a
 * lighter shade of each for the top-left highlight.
 *   red · orange · green · cyan · blue · magenta  (≈ a 6-hue rainbow) */
static const unsigned char JEWEL[N_COLORS]  = { GT_RED,  GT_ORANGE, GT_GREEN, GT_CYAN, GT_SKY, GT_MAGENTA };
static const unsigned char JLITE[N_COLORS]  = { GT_ROSE, GT_GOLD,   GT_LIME,  GT_TEAL, GT_WHITE, GT_PINK   };

/* Draw one beveled jewel (1-based color) at screen (x,y), with its 4 CORNER pixels
 * left as the well color so the gem reads as rounded — an octagon, not a flat box.
 * The body is a 7x7 with the corners cut: a tall center strip + a wide middle strip
 * cover everything except the 4 corner cells, which stay C_WELL (the backdrop).
 * (Background param so the title pile / NEXT preview round against their own bg.) */
static void draw_jewel_on(unsigned char x, unsigned char y, unsigned char c, unsigned char bg) {
  unsigned char base = JEWEL[c - 1], lite = JLITE[c - 1];
  unsigned char w = CELL - 1;                 /* 7 */
  queue_draw_box(x,     y,     w, w, bg);      /* clear the cell to bg (rounds corners) */
  queue_draw_box(x + 1, y,     w - 2, w, base);/* center vertical strip (cols 1..5) */
  queue_draw_box(x,     y + 1, w, w - 2, base);/* center horizontal strip (rows 1..5) */
  queue_draw_box(x + 1, y,     w - 2, 2, lite);/* top highlight (inside the rounding) */
  queue_draw_box(x,     y + 1, 2, w - 2, lite);/* left highlight */
}
/* in-well jewels round against the well interior */
static void draw_jewel(unsigned char x, unsigned char y, unsigned char c) {
  draw_jewel_on(x, y, c, C_WELL);
}

/* ── GAME LOGIC (clay) ── state */
static unsigned char grid[ROWS][COLS];    /* 0 = empty, 1..N_COLORS = a jewel */
static unsigned char piece[3];            /* the 3 falling colors, top→bottom */
static unsigned char nextp[3];            /* previewed next column */
static unsigned char piece_x, piece_y;    /* well coords of the column's TOP cell */
static unsigned char fall_t;
static unsigned int  score;
static unsigned char move_cool;

/* tiny xorshift PRNG comes from gt_draw.h (rnd8) — the SDK rnd() corrupts state. */
static void roll(unsigned char *p) {
  p[0] = 1 + (unsigned char)(rnd8() % N_COLORS);
  p[1] = 1 + (unsigned char)(rnd8() % N_COLORS);
  p[2] = 1 + (unsigned char)(rnd8() % N_COLORS);
}

/* is well cell (r,c) off the bottom or filled? */
static unsigned char blocked(unsigned char r, unsigned char c) {
  if (r >= ROWS) return 1;
  return grid[r][c] ? 1 : 0;
}

/* would the 3-tall column collide with its top cell at (c, topy)? */
static unsigned char collides(unsigned char c, unsigned char topy) {
  if (c >= COLS) return 1;
  if (blocked(topy, c)) return 1;
  if (blocked((unsigned char)(topy + 1), c)) return 1;
  if (blocked((unsigned char)(topy + 2), c)) return 1;
  return 0;
}

/* start a new column at top-center from the preview; roll the next preview. */
static void spawn(void) {
  piece[0] = nextp[0]; piece[1] = nextp[1]; piece[2] = nextp[2];
  roll(nextp);
  piece_x = COLS / 2 - 1;
  piece_y = 0;
  fall_t = 0;
}

/* ── match resolution: flag 3+ runs in all 4 directions, clear, gravity, chain ──
 * the 4 line directions: horizontal, vertical, both diagonals. */
static const signed char DR[4] = { 0, 1, 1, 1 };
static const signed char DC[4] = { 1, 0, 1, -1 };

static unsigned char marked[ROWS][COLS];

/* flag every cell in a 3+ same-color run; return count flagged. */
static unsigned char mark_matches(void) {
  unsigned char r, c, d, len, k, col, cnt;
  signed char sr, sc;
  for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) marked[r][c] = 0;
  for (r = 0; r < ROWS; r++) {
    for (c = 0; c < COLS; c++) {
      col = grid[r][c];
      if (!col) continue;
      for (d = 0; d < 4; d++) {
        /* only walk each run from its lowest end */
        sr = (signed char)r - DR[d];
        sc = (signed char)c - DC[d];
        if (sr >= 0 && sr < ROWS && sc >= 0 && sc < COLS && grid[sr][sc] == col) continue;
        len = 1;
        sr = (signed char)r + DR[d];
        sc = (signed char)c + DC[d];
        while (sr >= 0 && sr < ROWS && sc >= 0 && sc < COLS && grid[sr][sc] == col) {
          len++; sr += DR[d]; sc += DC[d];
        }
        if (len >= 3) {
          sr = (signed char)r; sc = (signed char)c;
          for (k = 0; k < len; k++) { marked[sr][sc] = 1; sr += DR[d]; sc += DC[d]; }
        }
      }
    }
  }
  cnt = 0;
  for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) if (marked[r][c]) cnt++;
  return cnt;
}

/* drop every column so jewels rest on the floor with no gaps. */
static void apply_gravity(void) {
  unsigned char c, r, n, w;
  unsigned char buf[ROWS];
  for (c = 0; c < COLS; c++) {
    n = 0;
    for (r = 0; r < ROWS; r++) if (grid[r][c]) { buf[n] = grid[r][c]; n++; }
    for (r = 0; r < (unsigned char)(ROWS - n); r++) grid[r][c] = 0;
    w = 0;
    for (r = (unsigned char)(ROWS - n); r < ROWS; r++) { grid[r][c] = buf[w]; w++; }
  }
}

/* settle the board: find→clear→gravity, looping so cascades chain. */
static void resolve_board(void) {
  unsigned char n, r, c, chain = 0;
  for (;;) {
    n = mark_matches();
    if (!n) break;
    chain++;
    for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) if (marked[r][c]) grid[r][c] = 0;
    score += (unsigned int)n * (chain > 1 ? (unsigned int)(10 * chain) : 10);
    gt_sfx(GT_SFX_HIT);
    apply_gravity();
  }
}

/* stamp the falling column where it rests, then resolve matches. */
static void lock_piece(void) {
  unsigned char i, r;
  for (i = 0; i < 3; i++) {
    r = (unsigned char)(piece_y + i);
    if (r < ROWS) grid[r][piece_x] = piece[i];
  }
  gt_sfx(GT_SFX_EXPLODE);
  resolve_board();
}

static void reset_game(void) {
  unsigned char r, c;
  for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) grid[r][c] = 0;
  score = 0; fall_t = 0; move_cool = 0;
  roll(nextp);
  spawn();
}

/* ── draw the whole frame: well + locked jewels + falling column + preview + HUD ── */
static void draw_frame(void) {
  unsigned char r, c, i;
  gt_clear(C_BG);
  /* well frame + interior */
  gt_rect(ORIGIN_X - 2, ORIGIN_Y - 2, COLS * CELL + 4, ROWS * CELL + 4, C_FRAME);
  gt_rect(ORIGIN_X,     ORIGIN_Y,     COLS * CELL,     ROWS * CELL,     C_WELL);
  /* locked jewels */
  for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) if (grid[r][c])
    draw_jewel((unsigned char)(ORIGIN_X + c * CELL), (unsigned char)(ORIGIN_Y + r * CELL), grid[r][c]);
  /* the falling 3-jewel column */
  for (i = 0; i < 3; i++) {
    unsigned char rr = (unsigned char)(piece_y + i);
    if (rr < ROWS)
      draw_jewel((unsigned char)(ORIGIN_X + piece_x * CELL),
                 (unsigned char)(ORIGIN_Y + rr * CELL), piece[i]);
  }
  /* NEXT preview, to the right of the well (rounds against the C_BG backdrop) */
  for (i = 0; i < 3; i++)
    draw_jewel_on((unsigned char)(ORIGIN_X + COLS * CELL + 6),
                  (unsigned char)(ORIGIN_Y + 4 + i * CELL), nextp[i], C_BG);
  /* re-clean the top border FIRST (it covers rows 0-6), THEN draw the score on top
   * at y=3 so the border-clean doesn't erase it. hud_number anchors the RIGHTMOST
   * digit at x and grows LEFT, so x=52 fits a 6-digit score. */
  queue_clear_border(C_BG);
  hud_number(score, 52, 3, 2, C_HUD);
  gt_present();
  gt_music_tick();
}

static unsigned char title_or_over(unsigned char over) {
  unsigned char i;
  gt_start_reset();
  while (1) {
    gt_clear(C_BG);
    if (!over) {
      hud_text("JEWELS", 28, 28, 3, C_HUD);       /* title */
      /* a little pile of colored jewels as the title art (rounds against C_BG) */
      for (i = 0; i < N_COLORS; i++)
        draw_jewel_on((unsigned char)(30 + i * 11), 64, (unsigned char)(i + 1), C_BG);
      hud_text("PRESS A", 34, 96, 2, C_HUD);       /* prompt */
    } else {
      hud_text("GAME", 40, 36, 3, C_HUD);
      hud_text("OVER", 40, 54, 3, C_HUD);
      hud_number(score, 80, 78, 2, C_HUD);
    }
    queue_clear_border(C_BG);
    gt_present();
    gt_music_tick();
    update_inputs();
    if (gt_start_pressed()) return 1;
  }
}

void main(void) {
  unsigned char t;
  for (;;) {
    title_or_over(0);
    reset_game();

    for (;;) {
      update_inputs();
      if (move_cool) move_cool--;

      /* move left/right */
      if (!move_cool) {
        if ((player1_buttons & INPUT_MASK_LEFT)  && piece_x > 0
            && !collides((unsigned char)(piece_x - 1), piece_y)) { piece_x--; move_cool = 5; gt_sfx(GT_SFX_SHOOT); }
        if ((player1_buttons & INPUT_MASK_RIGHT) && piece_x < COLS - 1
            && !collides((unsigned char)(piece_x + 1), piece_y)) { piece_x++; move_cool = 5; gt_sfx(GT_SFX_SHOOT); }
      }
      /* A = cycle colors up, B = cycle colors down (edge-triggered) */
      if (player1_new_buttons & INPUT_MASK_A) {
        t = piece[0]; piece[0] = piece[1]; piece[1] = piece[2]; piece[2] = t; gt_sfx(GT_SFX_COIN);
      }
      if (player1_new_buttons & INPUT_MASK_B) {
        t = piece[2]; piece[2] = piece[1]; piece[1] = piece[0]; piece[0] = t; gt_sfx(GT_SFX_COIN);
      }
      /* hard drop on START */
      if (player1_new_buttons & INPUT_MASK_START) {
        while (!collides(piece_x, (unsigned char)(piece_y + 1))) piece_y++;
        lock_piece();
        spawn();
        if (collides(piece_x, piece_y)) goto over;   /* well full → game over */
        fall_t = 0;
      }

      /* gravity: a row every ~14 frames; Down soft-drops every 3. */
      fall_t++;
      if (((player1_buttons & INPUT_MASK_DOWN) && fall_t >= 3) || fall_t >= 14) {
        fall_t = 0;
        if (collides(piece_x, (unsigned char)(piece_y + 1))) {
          lock_piece();
          spawn();
          if (collides(piece_x, piece_y)) goto over;
        } else {
          piece_y++;
        }
      }

      draw_frame();
    }
  over:
    title_or_over(1);
  }
}
