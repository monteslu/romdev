/* ── puzzle.c — Genesis SGDK match-3 falling-block scaffold ───────
 *
 * 6-wide × 12-tall grid. A 1×3 active piece (3 colours, randomly
 * chosen from the cell palette) drops from the top; LEFT/RIGHT
 * shifts, A rotates the colour order, DOWN soft-drops, START
 * triggers a hard-drop. Horizontal triples clear and bump score.
 *
 * The grid lives in plain RAM (u8 grid[12][6]) and is drawn to plane
 * B via VDP_setTileMapXY each frame the grid changes — we don't
 * redraw every frame, only on landings and clears, so the budget is
 * comfortable.
 *
 * Cells:
 *   0 = empty       1 = red       2 = green       3 = blue
 *
 * Yours to extend: vertical-triple clear, T/L shape pieces, gravity
 * after clears (current code just deletes; no settle), a score
 * display + game-over screen, music via XGM2.
 */

#include <genesis.h>
#include "genesis_sfx.h"

#define COLS    6
#define ROWS    12
#define CELL_PX 16   /* draw cells at 2×2 tiles for visibility */

#define T_BLANK (TILE_USER_INDEX + 0)
#define T_RED   (TILE_USER_INDEX + 1)
#define T_GREEN (TILE_USER_INDEX + 2)
#define T_BLUE  (TILE_USER_INDEX + 3)
#define T_BG    (TILE_USER_INDEX + 4)   /* full-screen backdrop (BG_A) */
#define T_WELL  (TILE_USER_INDEX + 5)   /* play-well backdrop (BG_A)   */

static const u32 tile_blank[8] = { 0,0,0,0,0,0,0,0 };
/* Backdrop block for the far plane: a framed cell (colour 4 border /
 * colour 5 fill) tiled across the whole screen so the playfield no
 * longer floats on a flat black backdrop. */
static const u32 tile_bg[8] = {
    0x44444444, 0x45555554, 0x45555554, 0x45555554,
    0x45555554, 0x45555554, 0x45555554, 0x44444444,
};
/* A darker, recessed cell drawn behind the play column so the well reads
 * as an inset board rather than part of the surrounding wall. */
static const u32 tile_well[8] = {
    0x44444444, 0x40000004, 0x40000004, 0x40000004,
    0x40000004, 0x40000004, 0x40000004, 0x44444444,
};
static const u32 tile_red[8]   = {
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
};
static const u32 tile_green[8] = {
    0x22222222, 0x22222222, 0x22222222, 0x22222222,
    0x22222222, 0x22222222, 0x22222222, 0x22222222,
};
static const u32 tile_blue[8]  = {
    0x33333333, 0x33333333, 0x33333333, 0x33333333,
    0x33333333, 0x33333333, 0x33333333, 0x33333333,
};

static u8 grid[ROWS][COLS];

static u8 piece[3];       /* the 3 colours in the active piece */
static s16 piece_x;       /* column 0..COLS-1 */
static s16 piece_y;       /* row, can be negative while above the grid */
static u16 fall_timer;
static u16 score;
static u32 rng_state = 1;

static u32 xorshift(void) {
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 17;
    rng_state ^= rng_state << 5;
    return rng_state;
}

static u8 random_colour(void) { return 1 + (xorshift() % 3); }

static void new_piece(void) {
    piece[0] = random_colour();
    piece[1] = random_colour();
    piece[2] = random_colour();
    piece_x = COLS / 2 - 1;
    piece_y = -3;
}

static u8 tile_for(u8 cell) {
    switch (cell) {
        case 1: return T_RED;
        case 2: return T_GREEN;
        case 3: return T_BLUE;
        default: return T_BLANK;
    }
}

static u16 pal_for(u8 cell) {
    /* All three colours share palette 1; we colour them via tile
     * index (each tile uses its own colour index). */
    return PAL1;
}

static void draw_cell(s16 col, s16 row) {
    if (row < 0 || row >= ROWS) return;
    u8 v = grid[row][col];
    /* Each grid cell is CELL_PX/8 = 2 tiles square. */
    for (u16 dy = 0; dy < 2; dy++) {
        for (u16 dx = 0; dx < 2; dx++) {
            /* Cells use the EMPTY-or-coloured tile. Empty cells stay
             * transparent so the BG_A well backdrop shows through; filled
             * cells are HIGH priority so they sit above that backdrop. */
            VDP_setTileMapXY(BG_B,
                TILE_ATTR_FULL(pal_for(v), v ? 1 : 0, 0, 0, tile_for(v)),
                col * 2 + dx + 6,
                row * 2 + dy + 1);
        }
    }
}

static void draw_grid(void) {
    for (s16 r = 0; r < ROWS; r++)
        for (s16 c = 0; c < COLS; c++)
            draw_cell(c, r);
}

static void draw_piece(s16 col, s16 row, bool clear) {
    /* Draw / un-draw the 1×3 vertical piece by writing as if the grid
     * had it. This is a *transient* overlay, so we restore from grid
     * when clearing. */
    for (u16 i = 0; i < 3; i++) {
        s16 r = row + i;
        if (r < 0 || r >= ROWS) continue;
        u8 v = clear ? grid[r][col] : piece[i];
        for (u16 dy = 0; dy < 2; dy++)
            for (u16 dx = 0; dx < 2; dx++)
                VDP_setTileMapXY(BG_B,
                    TILE_ATTR_FULL(pal_for(v), v ? 1 : 0, 0, 0, tile_for(v)),
                    col * 2 + dx + 6,
                    r   * 2 + dy + 1);
    }
}

/* ── match / clear / gravity core (ported from the GBC reference puzzle).
 * The old scan was horizontal-only AND cleared cells mid-scan, so vertical
 * and diagonal runs never cleared, 4+ runs half-cleared, and nothing ever
 * fell afterwards ("rows don't shift down"). This marks every 3+ run in all
 * 4 directions, clears them, applies per-column gravity, and loops so
 * cascades chain (score scales with chain depth). */
static u8 matched[ROWS][COLS];
static const s8 DIRS4[4][2] = { {0,1}, {1,0}, {1,1}, {1,-1} };

static u8 mark_and_count(void) {
  u8 r, c, d, len, k, cnt;
  u8 col;
  s8 dr, dc;
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
  u8 c;
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
  u8 n, r, c, chain;
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
    sfx_tone(0, 250, 12);  /* clear chime */
    apply_gravity();
  }
}

static void lock_piece(void) {
    for (u16 i = 0; i < 3; i++) {
        s16 r = piece_y + i;
        if (r >= 0 && r < ROWS) grid[r][piece_x] = piece[i];
    }
    resolve_board();
    draw_grid();
}

static bool collides(s16 col, s16 row) {
    if (col < 0 || col >= COLS) return TRUE;
    for (u16 i = 0; i < 3; i++) {
        s16 r = row + i;
        if (r >= ROWS) return TRUE;
        if (r >= 0 && grid[r][col] != 0) return TRUE;
    }
    return FALSE;
}

static void render_score(void) {
    char buf[6];
    u16 v = score;
    for (s16 i = 4; i >= 0; i--) { buf[i] = '0' + (v % 10); v /= 10; }
    buf[5] = 0;
    VDP_drawText(buf, 24, 1);
}

int main(bool hard) {
    (void)hard;

    /* Palette 1: tile colours for red/green/blue cells + the backdrop. */
    PAL_setColor(16 + 1, 0x000E); /* red */
    PAL_setColor(16 + 2, 0x00E0); /* green */
    PAL_setColor(16 + 3, 0x0E00); /* blue */
    PAL_setColor(16 + 4, 0x0420); /* backdrop wall border */
    PAL_setColor(16 + 5, 0x0610); /* backdrop wall fill   */

    VDP_loadTileData(tile_blank, T_BLANK, 1, DMA);
    VDP_loadTileData(tile_red,   T_RED,   1, DMA);
    VDP_loadTileData(tile_green, T_GREEN, 1, DMA);
    VDP_loadTileData(tile_blue,  T_BLUE,  1, DMA);
    VDP_loadTileData(tile_bg,    T_BG,    1, DMA);
    VDP_loadTileData(tile_well,  T_WELL,  1, DMA);

    /* Far plane (BG_A): tile the whole 40x28 screen with the wall block,
     * then recess the 12x24-cell play column so the grid sits in an inset
     * well. The grid (BG_B) draws over this with HIGH priority. */
    for (u16 cy = 0; cy < 28; cy++)
        for (u16 cx = 0; cx < 40; cx++)
            VDP_setTileMapXY(BG_A,
                TILE_ATTR_FULL(PAL1, 0, 0, 0, T_BG), cx, cy);
    for (u16 cy = 1; cy <= 24; cy++)
        for (u16 cx = 6; cx <= 17; cx++)
            VDP_setTileMapXY(BG_A,
                TILE_ATTR_FULL(PAL1, 0, 0, 0, T_WELL), cx, cy);

    for (s16 r = 0; r < ROWS; r++)
        for (s16 c = 0; c < COLS; c++)
            grid[r][c] = 0;

    score = 0;
    fall_timer = 0;
    sfx_init();
    new_piece();
    draw_grid();

    VDP_drawText("SCORE", 18, 1);
    VDP_drawText("LR MOVE A ROT START DROP", 7, 26);

    u16 prev = 0;

    while (TRUE) {
        u16 pad = JOY_readJoypad(JOY_1);

        /* Erase current piece visual. */
        draw_piece(piece_x, piece_y, TRUE);

        if ((pad & BUTTON_LEFT)  && !(prev & BUTTON_LEFT)
            && !collides(piece_x - 1, piece_y)) piece_x--;
        if ((pad & BUTTON_RIGHT) && !(prev & BUTTON_RIGHT)
            && !collides(piece_x + 1, piece_y)) piece_x++;
        if ((pad & BUTTON_A) && !(prev & BUTTON_A)) {
            u8 t = piece[0]; piece[0] = piece[1]; piece[1] = piece[2]; piece[2] = t;
            sfx_tone(2, 450, 2);   /* rotate click */
        }
        if ((pad & BUTTON_START) && !(prev & BUTTON_START)) {
            /* Hard-drop. */
            while (!collides(piece_x, piece_y + 1)) piece_y++;
            lock_piece();
            new_piece();
            prev = pad;
            render_score();
            sfx_update();
            SYS_doVBlankProcess();
            continue;
        }
        prev = pad;

        u16 fall_rate = (pad & BUTTON_DOWN) ? 4 : 30;
        if (++fall_timer >= fall_rate) {
            fall_timer = 0;
            if (collides(piece_x, piece_y + 1)) {
                lock_piece();
                new_piece();
            } else {
                piece_y++;
            }
        }

        /* Re-draw piece in its new position. */
        draw_piece(piece_x, piece_y, FALSE);

        render_score();
        sfx_update();
        SYS_doVBlankProcess();
    }
    return 0;
}
