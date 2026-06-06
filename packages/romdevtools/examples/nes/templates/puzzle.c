/* ── puzzle.c — NES match-3 falling-block scaffold ──────────────────
 *
 * A Columns/Tetris-ish baseline. Includes:
 *   - 6x12 grid in CHR-RAM-rendered "blocks" (sprites, not BG, so we
 *     can move pieces without an attribute-table refresh dance)
 *   - 1 active piece (a 1x3 vertical column of three colored blocks)
 *   - d-pad LEFT/RIGHT moves the piece, DOWN soft-drops, A rotates
 *     (cycles the 3 colors of the active piece)
 *   - Auto-fall every 30 frames (~0.5s)
 *   - Match-3 horizontal detection — clears horizontally aligned
 *     triples of the same color. Add vertical + diagonal as exercise.
 *
 * Scope-shaped choice: we render every block as a sprite (one OAM
 * entry per occupied cell). 6×12 = 72 sprites max — well under the 64
 * hardware sprite limit per scanline, but at the edge of NES per-frame
 * total. A real puzzle game would render the well in the BG nametable
 * and only the active piece as sprites. Keeping it all-sprites here
 * trades 8-sprites-per-scanline flicker for code simplicity. Profile
 * before optimizing.
 */

#include "nes_runtime.h"

#define GRID_W 6
#define GRID_H 12
#define ORIGIN_X 80   /* px — leftmost column anchor */
#define ORIGIN_Y 16   /* px — top row anchor */
#define CELL_PX  8    /* one tile per cell */

#define EMPTY    0
#define COL_R    1
#define COL_G    2
#define COL_B    3

#define TILE_BLOCK_R  1
#define TILE_BLOCK_G  2
#define TILE_BLOCK_B  3

/* ── Tiles: 3 colored 8x8 blocks ─────────────────────────────────── */
static const uint8_t tile_blank[16] = { 0 };
/* All three blocks use the same shape, but different palette indices.
 * We achieve that by varying the plane bits: plane0=1 → idx 1 (R),
 * plane1=1 → idx 2 (G), both planes set → idx 3 (B). */
static const uint8_t tile_block_r[16] = {
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t tile_block_g[16] = {
  0,    0,    0,    0,    0,    0,    0,    0,
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
};
static const uint8_t tile_block_b[16] = {
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
};

static const uint8_t palette[32] = {
  0x0F, 0x10, 0x20, 0x30,
  0x0F, 0x10, 0x20, 0x30,
  0x0F, 0x10, 0x20, 0x30,
  0x0F, 0x10, 0x20, 0x30,
  /* Sprite palette 0: idx1=red, idx2=green, idx3=blue */
  0x0F, 0x16, 0x1A, 0x12,
  0x0F, 0x16, 0x1A, 0x12,
  0x0F, 0x16, 0x1A, 0x12,
  0x0F, 0x16, 0x1A, 0x12,
};

/* ── State ───────────────────────────────────────────────────────── */
static uint8_t grid[GRID_H][GRID_W];      /* 0 = empty, 1..3 = color */
static uint8_t piece_x = GRID_W / 2;       /* column 0..GRID_W-1 */
static int8_t  piece_y = -3;               /* row; piece is 3 cells tall above this y */
static uint8_t piece_col[3] = { COL_R, COL_G, COL_B };  /* top, mid, bot */
static uint8_t fall_timer = 0;
static uint16_t rng = 0xBEEF;

static uint8_t random8(void) {
  uint16_t r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (uint8_t)r;
}

static void random_piece_colors(void) {
  piece_col[0] = 1 + (random8() % 3);
  piece_col[1] = 1 + (random8() % 3);
  piece_col[2] = 1 + (random8() % 3);
}

static uint8_t tile_for_color(uint8_t col) {
  switch (col) {
    case COL_R: return TILE_BLOCK_R;
    case COL_G: return TILE_BLOCK_G;
    case COL_B: return TILE_BLOCK_B;
    default:    return 0;
  }
}

static void spawn_piece(void) {
  piece_x = GRID_W / 2;
  piece_y = -3;
  random_piece_colors();
}

/* Lock current piece into the grid + check for match-3 horizontals. */
static void lock_piece(void) {
  uint8_t r, c, run, run_col;
  int8_t i;
  /* Drop the 3 cells into the grid. */
  for (i = 0; i < 3; i++) {
    int8_t y = piece_y + i;
    if (y >= 0 && y < GRID_H) {
      grid[y][piece_x] = piece_col[i];
    }
  }
  /* Scan each row for 3-in-a-row same color → clear. */
  for (r = 0; r < GRID_H; r++) {
    run = 1;
    run_col = grid[r][0];
    for (c = 1; c < GRID_W; c++) {
      if (grid[r][c] == run_col && run_col != EMPTY) {
        ++run;
        if (run >= 3) {
          /* Found a triple ending at c — clear back. */
          grid[r][c]     = EMPTY;
          grid[r][c - 1] = EMPTY;
          grid[r][c - 2] = EMPTY;
          sound_play_tone(0, 0x100 - (c << 4), 6, 4);
        }
      } else {
        run = 1;
        run_col = grid[r][c];
      }
    }
  }
}

/* Can the piece occupy (x, y..y+2) given the current grid? */
static uint8_t can_place(int8_t x, int8_t y) {
  int8_t i;
  if (x < 0 || x >= GRID_W) return 0;
  for (i = 0; i < 3; i++) {
    int8_t cy = y + i;
    if (cy < 0) continue;          /* above the well — allowed */
    if (cy >= GRID_H) return 0;     /* below the well — blocked */
    if (grid[cy][x] != EMPTY) return 0;
  }
  return 1;
}

void main(void) {
  uint8_t pad, prev_pad = 0;
  uint8_t r, c;
  int8_t  i;

  ppu_off();
  chr_ram_upload(0x0000, tile_blank,    16);
  chr_ram_upload(0x0010, tile_block_r,  16);
  chr_ram_upload(0x0020, tile_block_g,  16);
  chr_ram_upload(0x0030, tile_block_b,  16);
  palette_load(palette);
  oam_clear();
  ppu_on_all();
  sound_init();

  for (r = 0; r < GRID_H; r++)
    for (c = 0; c < GRID_W; c++) grid[r][c] = EMPTY;
  spawn_piece();

  for (;;) {
    /* ── Stage sprites: every non-empty cell + the active piece ── */
    oam_clear();
    for (r = 0; r < GRID_H; r++) {
      for (c = 0; c < GRID_W; c++) {
        if (grid[r][c] != EMPTY) {
          oam_spr(
            ORIGIN_X + c * CELL_PX,
            ORIGIN_Y + r * CELL_PX,
            tile_for_color(grid[r][c]),
            0);
        }
      }
    }
    for (i = 0; i < 3; i++) {
      int8_t y = piece_y + i;
      if (y >= 0 && y < GRID_H) {
        oam_spr(
          ORIGIN_X + piece_x * CELL_PX,
          ORIGIN_Y + y * CELL_PX,
          tile_for_color(piece_col[i]),
          0);
      }
    }

    ppu_wait_nmi();

    /* ── Input ──────────────────────────────────────────────── */
    pad = pad_poll(0);
    if ((pad & PAD_LEFT)  && !(prev_pad & PAD_LEFT)  && can_place(piece_x - 1, piece_y)) --piece_x;
    if ((pad & PAD_RIGHT) && !(prev_pad & PAD_RIGHT) && can_place(piece_x + 1, piece_y)) ++piece_x;
    /* A: rotate (cycle the 3 colors) */
    if ((pad & PAD_A) && !(prev_pad & PAD_A)) {
      uint8_t tmp = piece_col[0];
      piece_col[0] = piece_col[1];
      piece_col[1] = piece_col[2];
      piece_col[2] = tmp;
    }
    /* DOWN: soft-drop (faster fall) */
    if (pad & PAD_DOWN) fall_timer += 4;
    prev_pad = pad;

    /* ── Auto-fall ──────────────────────────────────────────── */
    ++fall_timer;
    if (fall_timer >= 30) {
      fall_timer = 0;
      if (can_place(piece_x, piece_y + 1)) {
        ++piece_y;
      } else {
        lock_piece();
        spawn_piece();
        /* Game over: piece can't be placed at spawn. Just reset grid. */
        if (!can_place(piece_x, piece_y)) {
          for (r = 0; r < GRID_H; r++)
            for (c = 0; c < GRID_W; c++) grid[r][c] = EMPTY;
          sound_play_noise(8, 8, 12);  /* game-over buzz */
        }
      }
    }
  }
}
