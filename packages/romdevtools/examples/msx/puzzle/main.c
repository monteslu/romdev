/* ── puzzle/main.c — MSX match-3 falling-block scaffold (screen 2) ───
 *
 * Mirrors the SMS/GB/etc puzzle scaffolds, translated to the MSX VDP via
 * the romdev helper lib (msx_hw.h + msx_vdp.c).
 *
 * A 6-wide x 12-tall well drawn entirely with the BG tilemap: distinct
 * R/G/B cell tiles, a grey border frame, and a dim field interior so the
 * playfield is visible even when empty (the screen is never blank). A 1x3
 * active piece falls; clears happen on a horizontal triple of one colour.
 *
 * Controls (joystick PORT 1 + triggers):
 *   LEFT/RIGHT  shift the piece (edge-detected)
 *   trigger A   rotate the colour order of the 1x3 piece
 *   DOWN        soft-drop (fast fall)
 *   trigger B   hard-drop + lock
 *
 * Cartridge rule: INIT must never return — main() ends in for(;;).
 */
#include "msx_hw.h"

/* ── interrupt-free vblank sync (poll VDP status S#0 bit 7) ────────────── */
__sfr __at 0x99 VDPSTATUS;
static void vsync(void) {
    (void)VDPSTATUS;
    while (!(VDPSTATUS & 0x80)) {
    }
}
/* triggers use the BIOS GTTRIG wrapper (gttrig) provided by msx_hw.h. */

#define COLS 6
#define ROWS 12

#define T_BLANK 0
#define T_R     1
#define T_G     2
#define T_B     3
#define T_WALL  4   /* well border         */
#define T_FIELD 5   /* dim well interior   */

/* 8x8 tile patterns: solid fills (the colour comes from the colour table) */
static const uint8_t TILE_SOLID[8] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};
static const uint8_t TILE_BLANK[8] = {0,0,0,0,0,0,0,0};
static const uint8_t TILE_CELL[8]  = {0x7E,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0x7E};

/* colour bytes (hi nibble fg, lo nibble bg). TMS9918 palette:
 * 9=red, 12=green(light), 4=blue, 14=grey, 1=black. */
#define COL_R     0x91
#define COL_G     0xC1
#define COL_B     0x41
#define COL_WALL  0xE1
#define COL_FIELD 0x41   /* same blue as B but used for the empty field */

static uint8_t  grid[ROWS][COLS];
static uint8_t  piece[3];
static int8_t   piece_x;
static int8_t   piece_y;
static uint8_t  fall_timer;
static uint16_t score;
static uint16_t rng;
static uint8_t  blip;

static uint16_t xorshift(void) {
    rng ^= (uint16_t)(rng << 7);
    rng ^= (uint16_t)(rng >> 9);
    rng ^= (uint16_t)(rng << 8);
    return rng;
}
static uint8_t rand_color(void) { return (uint8_t)(1 + (xorshift() % 3)); }

static uint8_t tile_for(uint8_t c) {
    if (c == 1) return T_R;
    if (c == 2) return T_G;
    if (c == 3) return T_B;
    return T_FIELD;   /* empty cell shows the dim field, not the backdrop */
}

static void load_tiles(void) {
    uint8_t third;
    uint16_t pat, col;
    for (third = 0; third < 3; third++) {
        pat = (uint16_t)(VRAM_PATTERN + ((uint16_t)third << 11));
        col = (uint16_t)(VRAM_COLOR   + ((uint16_t)third << 11));
        msx_vram_write((uint16_t)(pat + T_BLANK * 8), TILE_BLANK, 8);
        msx_vram_write((uint16_t)(pat + T_R     * 8), TILE_CELL,  8);
        msx_vram_write((uint16_t)(pat + T_G     * 8), TILE_CELL,  8);
        msx_vram_write((uint16_t)(pat + T_B     * 8), TILE_CELL,  8);
        msx_vram_write((uint16_t)(pat + T_WALL  * 8), TILE_SOLID, 8);
        msx_vram_write((uint16_t)(pat + T_FIELD * 8), TILE_SOLID, 8);
        msx_fill_vram((uint16_t)(col + T_BLANK * 8), 8, 0x11);
        msx_fill_vram((uint16_t)(col + T_R     * 8), 8, COL_R);
        msx_fill_vram((uint16_t)(col + T_G     * 8), 8, COL_G);
        msx_fill_vram((uint16_t)(col + T_B     * 8), 8, COL_B);
        msx_fill_vram((uint16_t)(col + T_WALL  * 8), 8, COL_WALL);
        msx_fill_vram((uint16_t)(col + T_FIELD * 8), 8, COL_FIELD);
    }
}

static void set_cell_tile(uint8_t row, uint8_t col, uint8_t tile) {
    msx_vram_write((uint16_t)(VRAM_NAME + (uint16_t)row * 32 + col), &tile, 1);
}

/* grid cell (col,row) -> name-table (row+1, col+13): centres the well */
static void draw_cell(int8_t col, int8_t row, uint8_t cell) {
    if (row < 0 || row >= ROWS) return;
    set_cell_tile((uint8_t)(row + 1), (uint8_t)(col + 13), tile_for(cell));
}

/* grey frame around the 6x12 field + dim interior so it is always visible.
 * field cells are rows 1..12, cols 13..18; frame rows 0..13, cols 12..19. */
static void draw_well(void) {
    uint8_t r, c, t;
    for (r = 0; r <= 13; r++) {
        for (c = 12; c <= 19; c++) {
            t = T_FIELD;
            if (r == 0 || r == 13 || c == 12 || c == 19) t = T_WALL;
            set_cell_tile(r, c, t);
        }
    }
}

static void draw_grid(void) {
    int8_t r, c;
    for (r = 0; r < ROWS; r++)
        for (c = 0; c < COLS; c++) draw_cell(c, r, grid[r][c]);
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
    if (score < 999) score += n;
    msx_psg_tone(0, 0x180, 13); blip = 8;  /* clear chime */
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
    int8_t r;
    uint8_t v;
    for (i = 0; i < 3; i++) {
        r = (int8_t)(piece_y + i);
        if (r < 0 || r >= ROWS) continue;
        v = clear ? grid[r][piece_x] : piece[i];
        draw_cell(piece_x, r, v);
    }
}

void main(void) {
    uint8_t r, c, dir, prev_dir, ta, tb, prev_ta, prev_tb, fall_rate, t;

    msx_set_screen2();
    msx_clear_sprites();
    load_tiles();
    msx_fill_vram(VRAM_NAME, 32 * 24, T_BLANK);

    for (r = 0; r < ROWS; r++)
        for (c = 0; c < COLS; c++) grid[r][c] = 0;

    score = 0;
    fall_timer = 0;
    rng = 0xACE1;
    blip = 0;
    prev_dir = 0; prev_ta = 0; prev_tb = 0;
    new_piece();
    draw_well();
    draw_grid();

    for (;;) {
        vsync();
        msx_music_tick();
        draw_piece(1);

        dir = msx_read_joystick(1);
        if (dir == STICK_CENTER) dir = msx_read_joystick(0);
        ta = (uint8_t)(gttrig(1) != 0);
        tb = (uint8_t)(gttrig(2) != 0);

        if ((dir == STICK_LEFT || dir == STICK_UL || dir == STICK_DL)
            && !(prev_dir == STICK_LEFT || prev_dir == STICK_UL || prev_dir == STICK_DL)
            && !collides((int8_t)(piece_x - 1), piece_y)) piece_x--;
        if ((dir == STICK_RIGHT || dir == STICK_UR || dir == STICK_DR)
            && !(prev_dir == STICK_RIGHT || prev_dir == STICK_UR || prev_dir == STICK_DR)
            && !collides((int8_t)(piece_x + 1), piece_y)) piece_x++;

        if (ta && !prev_ta) {
            t = piece[0]; piece[0] = piece[1]; piece[1] = piece[2]; piece[2] = t;
            msx_psg_tone(1, 0x280, 8); blip = 4;
        }

        if (tb && !prev_tb) {
            while (!collides(piece_x, (int8_t)(piece_y + 1))) piece_y++;
            lock_piece();
            new_piece();
            prev_dir = dir; prev_ta = ta; prev_tb = tb;
            if (blip) { blip--; if (!blip) { msx_psg_off(0); msx_psg_off(1); } }
            continue;
        }

        prev_dir = dir; prev_ta = ta; prev_tb = tb;

        fall_rate = (dir == STICK_DOWN || dir == STICK_DL || dir == STICK_DR) ? 4 : 30;
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

        if (blip) { blip--; if (!blip) { msx_psg_off(0); msx_psg_off(1); } }
    }
}
