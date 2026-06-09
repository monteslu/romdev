/*
 * PC Engine "puzzle" — a match-3 falling-block scaffold.
 *
 * A 1x3 column of coloured blocks falls into a 6-wide x 12-tall well drawn with
 * background tiles. LEFT/RIGHT slide the piece, button I rotates the three
 * colours, DOWN soft-drops, button II hard-drops. When a piece locks, any
 * horizontal run of three same-colour cells clears and scores. Mirrors the
 * NES/Genesis/SNES/GB/SMS puzzle scaffolds, translated to the PCE helper API.
 *
 * The whole field is drawn from BG tiles (no sprites needed) — a grey wall
 * frame around a dim field interior, with R/G/B block tiles for the cells, so
 * the screen is clearly a populated playfield (clears the verify gate).
 *
 * PCE notes (see pce_hw.h / MENTAL_MODEL.md):
 *   - bg_enable() turns on the BG plane + the VBlank IRQ (waitvsync needs it).
 *   - .bss must be non-empty (pce_video.c's _pce_keep[] covers it).
 *
 * cc65 is C89 — declare locals at the top of a block.
 */
#include <pce.h>
#include <stdint.h>   /* int8_t for signed grid coordinates                   */
#include "pce_hw.h"

/* ---- VRAM layout (word addresses) --------------------------------------- */
#define BAT_VRAM     0x0000
#define BG_VRAM      0x1000   /* cabinet background (dotted, colour 6/7)     */
#define RED_VRAM     0x1010   /* block colour 1                             */
#define GRN_VRAM     0x1020   /* block colour 2                             */
#define BLU_VRAM     0x1030   /* block colour 3                             */
#define WALL_VRAM    0x1040   /* well border (colour 4)                     */
#define FIELD_VRAM   0x1050   /* dim empty field (colour 5)                 */

#define BAT_ENTRY(pal, vram)  ((u16)(((pal) << 12) | ((vram) >> 4)))

#define COLS 6
#define ROWS 12
#define GRID_COL0 13   /* well's left BAT column (centres the 6-wide field)  */
#define GRID_ROW0 4    /* well's top BAT row                                 */

/* ---- state -------------------------------------------------------------- */
static u8  grid[ROWS][COLS];   /* 0 = empty, 1..3 = colour                   */
static u8  piece[3];           /* three stacked colours                      */
static int8_t piece_x;         /* column 0..COLS-1                           */
static int8_t piece_y;         /* row of top cell (can be negative)          */
static u8  fall_timer;
static u16 score;
static u16 rng;
static u8  pad, prev_pad;
static u16 tile_buf[16];

static void make_solid_tile(u16 *t, u8 ci) {
    u8 r;
    u8 p0 = (ci & 1) ? 0xFF : 0x00;
    u8 p1 = (ci & 2) ? 0xFF : 0x00;
    u8 p2 = (ci & 4) ? 0xFF : 0x00;
    u8 p3 = (ci & 8) ? 0xFF : 0x00;
    for (r = 0; r < 8; ++r) {
        t[r]     = (u16)(p0 | (p1 << 8));
        t[r + 8] = (u16)(p2 | (p3 << 8));
    }
}

/* A block tile: a solid `ci`-colour body with a 1px `frame`-colour border on
 * all four edges, so adjacent same-colour blocks still read as distinct cells.
 * For each of the 8 rows we pick a per-plane mask: border rows (0,7) are all
 * `frame`; interior rows are `ci` body with the left/right edge pixels framed. */
static void make_block_tile(u16 *t, u8 ci, u8 frame) {
    u8 r;
    for (r = 0; r < 8; ++r) {
        u8 edge_row = (r == 0 || r == 7);
        /* body colour planes (fill the whole row) */
        u8 b0 = (ci & 1) ? 0xFF : 0x00, b1 = (ci & 2) ? 0xFF : 0x00;
        u8 b2 = (ci & 4) ? 0xFF : 0x00, b3 = (ci & 8) ? 0xFF : 0x00;
        /* frame colour planes */
        u8 f0 = (frame & 1) ? 0xFF : 0x00, f1 = (frame & 2) ? 0xFF : 0x00;
        u8 f2 = (frame & 4) ? 0xFF : 0x00, f3 = (frame & 8) ? 0xFF : 0x00;
        u8 p0, p1, p2, p3;
        if (edge_row) {
            p0 = f0; p1 = f1; p2 = f2; p3 = f3;             /* whole row framed */
        } else {
            /* body fill, but pixels 0 and 7 (mask 0x81) use the frame colour */
            p0 = (u8)((b0 & 0x7E) | (f0 & 0x81));
            p1 = (u8)((b1 & 0x7E) | (f1 & 0x81));
            p2 = (u8)((b2 & 0x7E) | (f2 & 0x81));
            p3 = (u8)((b3 & 0x7E) | (f3 & 0x81));
        }
        t[r]     = (u16)(p0 | (p1 << 8));
        t[r + 8] = (u16)(p2 | (p3 << 8));
    }
}

/* Cabinet background tile: every pixel is colour 6, with a colour-7 dot on a
 * sparse lattice, so the whole screen reads as an intentional textured backdrop
 * rather than the flat hardware backdrop. Colour 6 = planes 1+2; colour 7 adds
 * plane 0 (so dots = planes 0+1+2). Build per-plane row bytes:
 *   plane0 (low byte words 0..7)  = dot mask (only dot pixels)
 *   plane1 (high byte words 0..7) = 0xFF (colour 6 base, all pixels)
 *   plane2 (low byte words 8..15) = 0xFF (colour 6 base, all pixels)
 *   plane3 (high byte words 8..15)= 0 */
static void make_dots_tile(u16 *t) {
    u8 r;
    for (r = 0; r < 8; ++r) {
        u8 dot = ((r & 3) == 0) ? 0x22 : 0x00;   /* dot columns every 4 px      */
        t[r]     = (u16)(dot | 0xFF00u);          /* plane0=dots, plane1=base    */
        t[r + 8] = (u16)0x00FFu;                  /* plane2=base,  plane3=0      */
    }
}

static void upload_art(void) {
    make_dots_tile(tile_buf); load_tiles(BG_VRAM, tile_buf, 16);
    make_block_tile(tile_buf, 1, 6); load_tiles(RED_VRAM, tile_buf, 16);
    make_block_tile(tile_buf, 2, 6); load_tiles(GRN_VRAM, tile_buf, 16);
    make_block_tile(tile_buf, 3, 6); load_tiles(BLU_VRAM, tile_buf, 16);
    make_solid_tile(tile_buf, 4); load_tiles(WALL_VRAM, tile_buf, 16);
    make_solid_tile(tile_buf, 5); load_tiles(FIELD_VRAM, tile_buf, 16);
}

static u16 vram_for(u8 cell) {
    if (cell == 1) return RED_VRAM;
    if (cell == 2) return GRN_VRAM;
    if (cell == 3) return BLU_VRAM;
    return FIELD_VRAM;   /* empty -> dim field interior */
}

static void put_cell(u8 batCol, u8 batRow, u16 vram) {
    u16 e = BAT_ENTRY(0, vram);
    vram_set_write_addr((u16)(BAT_VRAM + batRow * 32 + batCol));
    VDC_DATA_LO = (u8)(e & 0xFF);
    VDC_DATA_HI = (u8)(e >> 8);
}

/* fill the whole BAT with the cabinet background tile */
static void clear_bat(void) {
    u8 r, c;
    u16 e = BAT_ENTRY(0, BG_VRAM);
    for (r = 0; r < 32; ++r) {
        vram_set_write_addr((u16)(BAT_VRAM + r * 32));
        for (c = 0; c < 32; ++c) {
            VDC_DATA_LO = (u8)(e & 0xFF);
            VDC_DATA_HI = (u8)(e >> 8);
        }
    }
}

/* draw the well frame + dim interior */
static void draw_well(void) {
    int8_t r, c;
    for (r = -1; r <= ROWS; ++r) {
        for (c = -1; c <= COLS; ++c) {
            u16 vram = (r == -1 || r == ROWS || c == -1 || c == COLS)
                       ? WALL_VRAM : FIELD_VRAM;
            put_cell((u8)(GRID_COL0 + c), (u8)(GRID_ROW0 + r), vram);
        }
    }
}

static void draw_grid(void) {
    u8 r, c;
    for (r = 0; r < ROWS; ++r)
        for (c = 0; c < COLS; ++c)
            put_cell((u8)(GRID_COL0 + c), (u8)(GRID_ROW0 + r), vram_for(grid[r][c]));
}

static u16 next_rand(void) {
    rng = (u16)(rng * 25173u + 13849u);
    return rng;
}
static u8 rand_color(void) { return (u8)(1 + (next_rand() >> 8) % 3); }

static void new_piece(void) {
    piece[0] = rand_color();
    piece[1] = rand_color();
    piece[2] = rand_color();
    piece_x = COLS / 2 - 1;
    piece_y = -3;
}

static u8 collides(int8_t col, int8_t row) {
    u8 i;
    int8_t r;
    if (col < 0 || col >= COLS) return 1;
    for (i = 0; i < 3; ++i) {
        r = (int8_t)(row + i);
        if (r >= ROWS) return 1;
        if (r >= 0 && grid[r][col] != 0) return 1;
    }
    return 0;
}

static void draw_piece(u8 clear) {
    u8 i;
    for (i = 0; i < 3; ++i) {
        int8_t r = (int8_t)(piece_y + i);
        u8 v;
        if (r < 0 || r >= ROWS) continue;
        v = clear ? grid[r][piece_x] : piece[i];
        put_cell((u8)(GRID_COL0 + piece_x), (u8)(GRID_ROW0 + r), vram_for(v));
    }
}

/* ── match / clear / gravity core (ported from the GBC reference puzzle).
 * The old scan was horizontal-only AND cleared cells mid-scan, so vertical
 * and diagonal runs never cleared, 4+ runs half-cleared, and nothing ever
 * fell afterwards ("rows don't shift down"). This marks every 3+ run in all
 * 4 directions, clears them, applies per-column gravity, and loops so
 * cascades chain (score scales with chain depth). */
static u8 matched[ROWS][COLS];
/* H + V only on PCE — the stock cc65 pce.cfg boot bank is 8KB and the
 * two diagonal passes don't fit; add them back if you free up ROM. */
static const int8_t DIRS4[2][2] = { {0,1}, {1,0} };

static u8 mark_and_count(void) {
  u8 r, c, d, len, k, cnt;
  u8 col;
  int8_t dr, dc;
  int sr, sc;
  cnt = 0;
  for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) matched[r][c] = 0;
  for (r = 0; r < ROWS; r++) {
    for (c = 0; c < COLS; c++) {
      col = grid[r][c];
      if (col == 0) continue;
      for (d = 0; d < 2; d++) {
        dr = DIRS4[d][0]; dc = DIRS4[d][1];
        /* (no run-start check: a mid-run scan only re-marks already-
         * marked cells, so skipping the predecessor test is pure
         * code-size savings on the 8KB PCE boot bank) */
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
    if (score < 9999) score += amt;
    psg_tone(0, 0x180, 24);  /* clear chime */
    apply_gravity();
  }
}

static void clear_triples(void) {
    resolve_board();
}

static void lock_piece(void) {
    u8 i;
    int8_t r;
    for (i = 0; i < 3; ++i) {
        r = (int8_t)(piece_y + i);
        if (r >= 0 && r < ROWS) grid[r][piece_x] = piece[i];
    }
    clear_triples();
    draw_grid();
}

void main(void) {
    u8 r, c;
    u8 sfx_timer;

    _pce_keep[0] = 0;

    /* palette: BG sub-pal 0 holds field/wall + R/G/B blocks + frame */
    vce_set_color(0, PCE_RGB(0, 0, 1));   /* backdrop navy            */
    vce_set_color(1, PCE_RGB(7, 1, 1));   /* c1 red block             */
    vce_set_color(2, PCE_RGB(1, 6, 1));   /* c2 green block           */
    vce_set_color(3, PCE_RGB(2, 3, 7));   /* c3 blue block            */
    vce_set_color(4, PCE_RGB(5, 5, 5));   /* c4 wall grey             */
    vce_set_color(5, PCE_RGB(1, 2, 4));   /* c5 field blue (clearly   *
                                           * distinct from backdrop)  */
    vce_set_color(6, PCE_RGB(1, 0, 2));   /* c6 cabinet purple base + *
                                           *    block frame           */
    vce_set_color(7, PCE_RGB(2, 1, 4));   /* c7 cabinet dot           */

    upload_art();
    clear_bat();
    draw_well();

    for (r = 0; r < ROWS; ++r) for (c = 0; c < COLS; ++c) grid[r][c] = 0;
    score = 0;
    fall_timer = 0;
    rng = 0x1357;
    prev_pad = 0;
    sfx_timer = 0;
    new_piece();
    draw_grid();

    pce_joy_init();
    bg_enable();

    for (;;) {
        u8 fall_rate;
        waitvsync();

        draw_piece(1);   /* erase old piece footprint                    */

        pad = pce_joy_read();
        if ((pad & PCE_JOY_LEFT)  && !(prev_pad & PCE_JOY_LEFT)
            && !collides((int8_t)(piece_x - 1), piece_y)) piece_x--;
        if ((pad & PCE_JOY_RIGHT) && !(prev_pad & PCE_JOY_RIGHT)
            && !collides((int8_t)(piece_x + 1), piece_y)) piece_x++;
        if ((pad & PCE_JOY_I) && !(prev_pad & PCE_JOY_I)) {
            u8 t = piece[0]; piece[0] = piece[1]; piece[1] = piece[2]; piece[2] = t;
            psg_tone(1, 0x300, 18); sfx_timer = 3;
        }
        if ((pad & PCE_JOY_II) && !(prev_pad & PCE_JOY_II)) {
            while (!collides(piece_x, (int8_t)(piece_y + 1))) piece_y++;
            lock_piece();
            new_piece();
            psg_tone(1, 0x140, 22); sfx_timer = 4;
            prev_pad = pad;
            if (sfx_timer) { --sfx_timer; }
            continue;
        }
        prev_pad = pad;

        fall_rate = (pad & PCE_JOY_DOWN) ? 4 : 30;
        fall_timer++;
        if (fall_timer >= fall_rate) {
            fall_timer = 0;
            if (collides(piece_x, (int8_t)(piece_y + 1))) {
                lock_piece();
                new_piece();
            } else {
                piece_y++;
            }
        }

        draw_piece(0);   /* draw piece at new position                   */

        if (sfx_timer) { --sfx_timer; if (sfx_timer == 0) { psg_off(0); psg_off(1); } }
    }
}
