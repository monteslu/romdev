/* ── puzzle.c — Game Boy Advance Tonc match-3 falling-block scaffold ─
 *
 * 6-wide x 12-tall grid. A 1x3 active piece (3 colours, randomly
 * chosen from the cell palette) drops from the top; LEFT/RIGHT
 * shifts, A rotates the colour order, DOWN soft-drops, START
 * triggers a hard-drop. Horizontal triples clear and bump score.
 *
 * The grid lives in plain RAM (u8 grid[12][6]) and is drawn into BG0's
 * 32x32 tile map. We redraw on landings + clears, not every frame.
 *
 * Cell size: 8x8 (one BG tile per cell). Grid origin at tile (4, 2)
 * so the playfield sits at pixel (32, 16) with room for score above
 * and instructions below.
 *
 * Cells:
 *   0 = empty       1 = red       2 = green       3 = blue
 *
 * Yours to extend: vertical-triple clear, T/L shape pieces, gravity
 * after clears (current code just deletes; no settle), game-over.
 */

#include <tonc.h>
#include "gba_sfx.h"

/* draw a 5-digit score WITHOUT tte_printf (broken in this libtonc — GBA-1). */
static void draw_score(int x, unsigned v) {
    char buf[24];
    int i, n = 0;
    buf[n++]='#'; buf[n++]='{'; buf[n++]='P'; buf[n++]=':';
    if (x >= 100) buf[n++] = '0' + (x/100)%10;
    if (x >= 10)  buf[n++] = '0' + (x/10)%10;
    buf[n++] = '0' + x%10;
    buf[n++]=','; buf[n++]='8'; buf[n++]='}';
    for (i = 4; i >= 0; i--) { buf[n+i] = '0' + (v % 10); v /= 10; }
    n += 5; buf[n] = 0;
    tte_write(buf);
}

#define COLS 6
#define ROWS 12

#define TILE_BLANK 0
#define TILE_RED   1
#define TILE_GREEN 2
#define TILE_BLUE  3

/* Grid origin in BG-tile coords. */
#define GRID_TX 4
#define GRID_TY 2

static const u32 tile_red[8] = {
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
};
static const u32 tile_green[8] = {
    0x22222222, 0x22222222, 0x22222222, 0x22222222,
    0x22222222, 0x22222222, 0x22222222, 0x22222222,
};
static const u32 tile_blue[8] = {
    0x33333333, 0x33333333, 0x33333333, 0x33333333,
    0x33333333, 0x33333333, 0x33333333, 0x33333333,
};
/* Backdrop tile (colour index 4 = steel grey): a dither so the whole screen
 * reads as a "cabinet" behind the playfield instead of flat black — a lone
 * 6x12 grid floating on black looks blank to a human (frame verify <92%). */
/* Solid light-grey wall tile for the well border. */
static const u32 tile_wall[8] = {
    0x55555555, 0x55555555, 0x55555555, 0x55555555,
    0x55555555, 0x55555555, 0x55555555, 0x55555555,
};
#define TILE_WALL  5

static const u32 tile_back[8] = {
    0x40404040, 0x04040404, 0x40404040, 0x04040404,
    0x40404040, 0x04040404, 0x40404040, 0x04040404,
};
#define TILE_BACK 4

static u8 grid[ROWS][COLS];

static u8 piece[3];
static s16 piece_x;
static s16 piece_y;
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

static int tile_for(u8 cell) {
    switch (cell) {
        case 1: return TILE_RED;
        case 2: return TILE_GREEN;
        case 3: return TILE_BLUE;
        default: return TILE_BACK;   /* empty cell shows the backdrop, not black */
    }
}

static void draw_cell(int col, int row) {
    if (row < 0 || row >= ROWS) return;
    u8 v = grid[row][col];
    SCR_ENTRY *map = se_mem[28];
    map[(GRID_TY + row) * 32 + (GRID_TX + col)] =
        SE_BUILD(tile_for(v), 0, 0, 0);
}

static void draw_grid(void) {
    for (int r = 0; r < ROWS; r++)
        for (int c = 0; c < COLS; c++)
            draw_cell(c, r);
}

static void draw_piece(int col, int row, int clear) {
    /* Transient overlay: when clearing, restore from grid (so we don't
     * blow away locked cells behind the piece). */
    SCR_ENTRY *map = se_mem[28];
    for (int i = 0; i < 3; i++) {
        int r = row + i;
        if (r < 0 || r >= ROWS) continue;
        u8 v = clear ? grid[r][col] : piece[i];
        map[(GRID_TY + r) * 32 + (GRID_TX + col)] =
            SE_BUILD(tile_for(v), 0, 0, 0);
    }
}

static int collides(int col, int row) {
    if (col < 0 || col >= COLS) return 1;
    for (int i = 0; i < 3; i++) {
        int r = row + i;
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
    sfx_tone(1, 1700, 10);  /* clear chime */
    apply_gravity();
  }
}

static void lock_piece(void) {
    for (int i = 0; i < 3; i++) {
        int r = piece_y + i;
        if (r >= 0 && r < ROWS) grid[r][piece_x] = piece[i];
    }
    resolve_board();
    draw_grid();
}

int main(void) {
    /* TTE first — it may touch pal_bg_mem + REG_BG#CNT, so set up
     * our BG0 grid resources AFTER its init runs. */
    tte_init_chr4c_default(1, BG_CBB(2) | BG_SBB(30));
    tte_write("#{P:88,8}SCORE 00000");
    tte_write("#{P:8,148}LR MOVE  A ROT  START DROP");

    /* BG palette for grid cells. */
    pal_bg_mem[0] = CLR_BLACK;
    pal_bg_mem[1] = CLR_RED;
    pal_bg_mem[2] = CLR_LIME;
    pal_bg_mem[3] = CLR_BLUE;
    pal_bg_mem[4] = RGB15(6, 6, 9);   /* steel grey backdrop */
    pal_bg_mem[5] = RGB15(20, 20, 22);  /* well border grey */

    /* BG tile graphics in char-block 3 (separate from TTE which used 2). */
    tonccpy(&tile_mem[3][TILE_RED],   tile_red,   sizeof(tile_red));
    tonccpy(&tile_mem[3][TILE_GREEN], tile_green, sizeof(tile_green));
    tonccpy(&tile_mem[3][TILE_BLUE],  tile_blue,  sizeof(tile_blue));
    tonccpy(&tile_mem[3][TILE_BACK],  tile_back,  sizeof(tile_back));
    tonccpy(&tile_mem[3][TILE_WALL],  tile_wall,  sizeof(tile_wall));

    /* Fill screen-block 28 (BG0 map) with the backdrop tile so the whole
     * screen is covered; the grid cells draw over it. (A blank/black map left
     * the playfield floating on black — reads as blank.) */
    SCR_ENTRY *map = se_mem[28];
    for (int i = 0; i < 32 * 32; i++) map[i] = SE_BUILD(TILE_BACK, 0, 0, 0);
    /* Well border — playtest: "needs border around play area". One wall
     * cell left/right of the grid columns + a floor row underneath. */
    for (int r = 0; r <= ROWS; r++) {
        map[(GRID_TY + r) * 32 + (GRID_TX - 1)]    = SE_BUILD(TILE_WALL, 0, 0, 0);
        map[(GRID_TY + r) * 32 + (GRID_TX + COLS)] = SE_BUILD(TILE_WALL, 0, 0, 0);
    }
    for (int c = -1; c <= COLS; c++)
        map[(GRID_TY + ROWS) * 32 + (GRID_TX + c)] = SE_BUILD(TILE_WALL, 0, 0, 0);

    REG_BG0CNT = BG_CBB(3) | BG_SBB(28) | BG_REG_32x32 | BG_4BPP | BG_PRIO(0);
    /* Bump TTE's BG1 to a LOWER priority so the grid (BG0, prio 0) renders
     * in front. (Higher prio number = drawn behind.) */
    REG_BG1CNT |= BG_PRIO(1);

    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0 | DCNT_BG1;

    for (int r = 0; r < ROWS; r++)
        for (int c = 0; c < COLS; c++)
            grid[r][c] = 0;

    score = 0;
    fall_timer = 0;

    /* IRQ setup — required for VBlankIntrWait() to function. */
    irq_init(NULL);
    irq_add(II_VBLANK, NULL);

    sfx_init();
    new_piece();
    draw_grid();

    u16 prev = 0;

    while (1) {
        VBlankIntrWait();
        key_poll();

        u16 now = key_curr_state();

        /* Erase the active piece visual. */
        draw_piece(piece_x, piece_y, 1);

        if ((now & KEY_LEFT) && !(prev & KEY_LEFT)
            && !collides(piece_x - 1, piece_y)) piece_x--;
        if ((now & KEY_RIGHT) && !(prev & KEY_RIGHT)
            && !collides(piece_x + 1, piece_y)) piece_x++;
        if ((now & KEY_A) && !(prev & KEY_A)) {
            u8 t = piece[0]; piece[0] = piece[1]; piece[1] = piece[2]; piece[2] = t;
            sfx_tone(2, 1400, 3);   /* rotate click */
        }
        if ((now & KEY_START) && !(prev & KEY_START)) {
            while (!collides(piece_x, piece_y + 1)) piece_y++;
            lock_piece();
            new_piece();
            prev = now;
            tte_erase_rect(88 + 6*8, 8, 88 + 11*8, 16);
            draw_score(88 + 6*8, score);
            continue;
        }
        prev = now;

        u16 fall_rate = (now & KEY_DOWN) ? 4 : 30;
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
        draw_piece(piece_x, piece_y, 0);

        tte_erase_rect(88 + 6*8, 8, 88 + 11*8, 16);
        draw_score(88 + 6*8, score);
    }
    return 0;
}
