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
/* BG scenery tiles — painted into the nametable so the playfield reads as a
 * real machine on boot (without them the screen is just sprites on flat
 * black). All live in the BACKGROUND pattern table ($1000); the block tiles
 * above are sprites ($0000).
 *
 *   BG_WALL  — solid bordered block (idx 1, steel blue): the well frame.
 *   BG_BRICK — a brick/dither pattern (idx 2) tiling the cabinet wall that
 *              surrounds the well, so the whole screen is covered.
 *   BG_INNER — a faint grid speck (idx 3) lining the inside of the well so
 *              empty cells read as a recessed playfield, not a black hole. */
static const uint8_t tile_wall[16] = {
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t tile_brick[16] = {
  0,    0,    0,    0,    0,    0,    0,    0,        /* plane 0 clear */
  0xFF, 0x80, 0x80, 0x80, 0xFF, 0x08, 0x08, 0x08,   /* plane 1 → colour 2 brick */
};
static const uint8_t tile_inner[16] = {
  0x88, 0x00, 0x00, 0x00, 0x88, 0x00, 0x00, 0x00,   /* plane 0 specks */
  0x88, 0x00, 0x00, 0x00, 0x88, 0x00, 0x00, 0x00,   /* plane 1 too → colour 3 */
};
#define BG_WALL  1   /* BG tile index 1 → uploaded to $1010 */
#define BG_BRICK 2   /* BG tile index 2 → uploaded to $1020 */
#define BG_INNER 3   /* BG tile index 3 → uploaded to $1030 */

static const uint8_t palette[32] = {
  /* BG0: backdrop near-black, wall = steel blue (idx1), brick = brown
   * (idx2), inner grid = dark grey (idx3). */
  0x0F, 0x11, 0x17, 0x00,
  0x0F, 0x11, 0x17, 0x00,
  0x0F, 0x11, 0x17, 0x00,
  0x0F, 0x11, 0x17, 0x00,
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
/* ── match / clear / gravity core (ported from the GBC reference puzzle).
 * The old scan was horizontal-only AND cleared cells mid-scan, so vertical
 * and diagonal runs never cleared, 4+ runs half-cleared, and nothing ever
 * fell afterwards ("rows don't shift down"). This marks every 3+ run in all
 * 4 directions, clears them, applies per-column gravity, and loops so
 * cascades chain (score scales with chain depth). */
/* matched[] lives at $0500 — OUTSIDE the linker's RAM area ($0300-$04FF,
 * which grid+runtime statics nearly fill; 72 more BSS bytes overflow it).
 * $0500-$07FF is real, unused NES work RAM (hw stack is $0100, shadow OAM
 * $0200), so an absolute pointer there is free. */
#define matched ((uint8_t (*)[GRID_W])0x0500)
static const int8_t DIRS4[4][2] = { {0,1}, {1,0}, {1,1}, {1,-1} };

static uint8_t mark_and_count(void) {
  uint8_t r, c, d, len, k, cnt;
  uint8_t col;
  int8_t dr, dc;
  int sr, sc;
  cnt = 0;
  for (r = 0; r < GRID_H; r++) for (c = 0; c < GRID_W; c++) matched[r][c] = 0;
  for (r = 0; r < GRID_H; r++) {
    for (c = 0; c < GRID_W; c++) {
      col = grid[r][c];
      if (col == EMPTY) continue;
      for (d = 0; d < 4; d++) {
        dr = DIRS4[d][0]; dc = DIRS4[d][1];
        sr = (int)r - dr; sc = (int)c - dc;
        if (sr >= 0 && sr < GRID_H && sc >= 0 && sc < GRID_W
            && grid[sr][sc] == col) continue;  /* not the run's start */
        len = 1;
        sr = (int)r + dr; sc = (int)c + dc;
        while (sr >= 0 && sr < GRID_H && sc >= 0 && sc < GRID_W
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
  for (c = 0; c < GRID_W; c++) {
    w = GRID_H - 1;
    for (r = GRID_H - 1; r >= 0; r--) {
      if (grid[r][c] != EMPTY) { grid[w][c] = grid[r][c]; w--; }
    }
    for (; w >= 0; w--) grid[w][c] = EMPTY;
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
    for (r = 0; r < GRID_H; r++)
      for (c = 0; c < GRID_W; c++)
        if (matched[r][c]) grid[r][c] = EMPTY;
    amt = (unsigned int)n * 10u;
    if (chain > 1) amt = amt * chain;
    (void)amt;
    sound_play_tone(0, 0xC0, 6, 4);  /* clear chime */
    apply_gravity();
  }
}

static void lock_piece(void) {
  int8_t i;
  /* Drop the 3 cells into the grid. */
  for (i = 0; i < 3; i++) {
    int8_t y = piece_y + i;
    if (y >= 0 && y < GRID_H) {
      grid[y][piece_x] = piece_col[i];
    }
  }
  resolve_board();
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
  chr_ram_upload(0x0000, tile_blank,    16);  /* sprite slot 0 */
  chr_ram_upload(0x0010, tile_block_r,  16);  /* sprite slots 1..3 */
  chr_ram_upload(0x0020, tile_block_g,  16);
  chr_ram_upload(0x0030, tile_block_b,  16);
  chr_ram_upload(0x1010, tile_wall,     16);  /* BG slot 1 (background table) */
  chr_ram_upload(0x1020, tile_brick,    16);  /* BG slot 2 (cabinet wall)     */
  chr_ram_upload(0x1030, tile_inner,    16);  /* BG slot 3 (well interior)    */
  palette_load(palette);

  /* Draw the cabinet + well into the nametable while rendering is off
   * (vram_unsafe_set = raw PPU write; the friendly tile_set queue would
   * deadlock before ppu_on). The grid is 6 wide × 12 tall at pixel origin
   * (80,16) → tile cols 10..15, rows 2..13; frame it one cell out. We first
   * tile the WHOLE screen with brick (the machine cabinet), then carve the
   * recessed well interior, then stamp the steel-blue frame on top — so the
   * screen is fully covered instead of sprites floating on black. */
  {
    uint16_t gx0 = ORIGIN_X / 8, gy0 = ORIGIN_Y / 8;     /* 10, 2  */
    uint16_t gx1 = gx0 + GRID_W, gy1 = gy0 + GRID_H;     /* 16, 14 (exclusive) */
    uint16_t cc, rr;
    /* whole-screen cabinet brick */
    for (rr = 0; rr < 30; rr++)
      for (cc = 0; cc < 32; cc++)
        vram_unsafe_set((uint16_t)(0x2000 + rr * 32 + cc), BG_BRICK);
    /* recessed well interior (inside the frame) */
    for (rr = gy0; rr < gy1; rr++)
      for (cc = gx0; cc < gx1; cc++)
        vram_unsafe_set((uint16_t)(0x2000 + rr * 32 + cc), BG_INNER);
    /* steel frame one cell out around the well */
    for (cc = gx0 - 1; cc <= gx1; cc++) {
      vram_unsafe_set((uint16_t)(0x2000 + (gy0 - 1) * 32 + cc), BG_WALL); /* top    */
      vram_unsafe_set((uint16_t)(0x2000 + gy1 * 32 + cc), BG_WALL);       /* bottom */
    }
    for (rr = gy0 - 1; rr <= gy1; rr++) {
      vram_unsafe_set((uint16_t)(0x2000 + rr * 32 + (gx0 - 1)), BG_WALL); /* left   */
      vram_unsafe_set((uint16_t)(0x2000 + rr * 32 + gx1), BG_WALL);       /* right  */
    }
  }

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
