/* ── puzzle.c — NES falling-gem versus puzzle (complete example game) ─────────
 *
 * A COMPLETE, working game — title screen, 1P marathon and 2P simultaneous
 * VERSUS modes, levels, score + persistent hi-score (battery SRAM), music +
 * SFX, and a background-tile playfield driven through the queued VRAM path
 * (the load-bearing trick of every NES puzzle game).
 *
 * The game: a falling-trio match-3. A trio of gems falls into a 6x12 well; LEFT/RIGHT
 * move it, A/B cycle its three colours, DOWN soft-drops. When it lands, any
 * straight run of 3+ same-coloured gems (horizontal, vertical, or diagonal)
 * clears; survivors fall and cascades chain for multiplied score.
 *
 * 2P VERSUS design (simultaneous, split board): two 6x12 wells side by side —
 * P1 left, P2 right — each driven by its own controller, both falling at
 * once. Clears ATTACK: every chain step you score sends one garbage row
 * (random gems with one gap, capped at 4 per attack) rising from the bottom
 * of the opponent's well. First player whose stack reaches the top loses.
 * Both update each frame; the whole thing fits the budget because the boards
 * are background tiles and only the two falling trios are sprites (6 OAM
 * entries total).
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented NES footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — match rules, garbage, tuning, art: reshape freely.
 *
 * What depends on what:
 *   nes_runtime.{h,c} — rendering/input/sound/text/hi-score library.
 *   chr-ram-runtime.crt0.s — boot + NMI + iNES header (BATTERY bit feeds
 *     hiscore_load/save). Load-bearing; edit with TROUBLESHOOTING open.
 *
 * Frame budget (NTSC, 60fps): steady state is tiny — input + gravity for two
 * pieces, ≤6 sprites, ≤11 queued VRAM bytes (one board row + one HUD number).
 * The spike is resolve_board() at lock time (full 4-direction match scan over
 * 72 cells in cc65 code): it can spill a frame or two past vblank. That's
 * fine — the NMI keeps rendering and the queue keeps draining, so it shows
 * as (at most) a one-frame hitch on the falling pieces, never corruption.
 */

#include "nes_runtime.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "GEM DUEL"

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Board geometry. The wells are placed on EVEN tile coordinates on purpose —
 * see the attribute-table idiom below before moving them. */
#define GRID_W   6
#define GRID_H   12
#define WELL_TY  8            /* top tile row of the well interior */
#define WELL_1P_TX 12         /* 1P: single centered well (cols 12-17) */
#define WELL_VS_P1 4          /* 2P: P1 well cols 4-9 ...              */
#define WELL_VS_P2 22         /*     P2 well cols 22-27 (split board)  */

#define EMPTY 0               /* cell colours 1..3 = white/green/red */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile art. Each 8x8 tile = 16 bytes: 8 plane-0 rows then 8 plane-1 rows
 * (2bpp — plane0-only pixels use colour 1, plane1-only colour 2, both = 3).
 * KEY TRICK: the three gem tiles are the SAME shape on different planes, so
 * a cell changes colour by changing its TILE — no attribute-table rewrite
 * (attributes cover 16x16 px, way coarser than one 8x8 cell). */
static const uint8_t tile_blank[16] = { 0 };
static const uint8_t tile_gem1[16] = {          /* colour 1 (white) */
  0x3C, 0x7E, 0xFF, 0xFF, 0xFF, 0xFF, 0x7E, 0x3C,
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t tile_gem2[16] = {          /* colour 2 (green) */
  0,    0,    0,    0,    0,    0,    0,    0,
  0x3C, 0x7E, 0xFF, 0xFF, 0xFF, 0xFF, 0x7E, 0x3C,
};
static const uint8_t tile_gem3[16] = {          /* colour 3 (red) */
  0x3C, 0x7E, 0xFF, 0xFF, 0xFF, 0xFF, 0x7E, 0x3C,
  0x3C, 0x7E, 0xFF, 0xFF, 0xFF, 0xFF, 0x7E, 0x3C,
};
/* BG furniture (background pattern table $1000 — separate from the sprite
 * table at $0000; the runtime's PPUCTRL setup makes that split). */
static const uint8_t tile_wall[16] = {          /* well frame, colour 3 */
  0xFF, 0xFF, 0xE7, 0xC3, 0xC3, 0xE7, 0xFF, 0xFF,
  0xFF, 0xFF, 0xE7, 0xC3, 0xC3, 0xE7, 0xFF, 0xFF,
};
static const uint8_t tile_dither[16] = {        /* cabinet backdrop, colour 2 */
  0,    0,    0,    0,    0,    0,    0,    0,
  0x55, 0x00, 0xAA, 0x00, 0x55, 0x00, 0xAA, 0x00,
};
static const uint8_t tile_inner[16] = {         /* empty-cell speck, colour 1 */
  0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00,
  0,    0,    0,    0,    0,    0,    0,    0,
};
#define BG_WALL     1
#define BG_DITHER   2
#define BG_INNER    3
#define BG_GEM_BASE 4         /* BG tiles 4/5/6 = gem colours 1/2/3 */

static const uint8_t palette[32] = {
  /* BG pal 0 = WELL INTERIOR: gem colours (white/green/red on black).
   * BG pal 1 = everything else: white text, dark-grey dither, blue frame.
   * The attribute table below assigns pal 0 to the wells, pal 1 elsewhere. */
  0x0F, 0x30, 0x2A, 0x16,
  0x0F, 0x30, 0x00, 0x11,
  0x0F, 0x30, 0x00, 0x11,
  0x0F, 0x30, 0x00, 0x11,
  /* Sprite pal 0 mirrors BG pal 0 so the falling trio matches locked gems. */
  0x0F, 0x30, 0x2A, 0x16,
  0x0F, 0x30, 0x2A, 0x16,
  0x0F, 0x30, 0x2A, 0x16,
  0x0F, 0x30, 0x2A, 0x16,
};

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Big arrays live OUTSIDE the linker's RAM area. The chr-ram-runtime preset
 * places C BSS in $0300-$04FF (512 bytes), and the runtime's own statics
 * (256-byte shadow attribute table + VRAM queue) already eat most of it —
 * two 72-byte boards plus a 72-byte match mask would overflow the segment
 * and the LINK fails. The preset reserves $0500-$05FF as the USER SCRATCH
 * PAGE for exactly this (the linker never places anything there); these
 * three arrays use 216 of its 256 bytes. DO NOT stray past $05FF: the cc65
 * C parameter stack owns $0600-$06FF and the music driver's scratch page
 * is $0700-$07FF — writes there corrupt live state silently. Bonus: fixed
 * addresses make the boards trivially inspectable from the debugger
 * (P1 board at $0500, P2 at $0548, match mask at $0590). */
#define grid_of(p) ((uint8_t (*)[GRID_W])((p) ? 0x0548 : 0x0500))
#define matched    ((uint8_t (*)[GRID_W])0x0590)

/* ── GAME LOGIC (clay — reshape freely) ── small state (fits normal BSS). */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t  state;
static uint8_t  two_player;        /* mode chosen on the title screen */
static uint8_t  well_tx[2];        /* left tile column of each well */
static uint8_t  piece_x[2];        /* falling trio: column 0..5 */
static int8_t   piece_y[2];        /* row of its TOP cell (<0 = above rim) */
static uint8_t  piece_col[2][3];   /* trio colours, top to bottom */
static uint8_t  fall_t[2];         /* frames until next gravity step */
static uint8_t  prev_pad[2];       /* for edge-triggered input */
static uint16_t score[2];
static uint16_t hiscore;
static uint16_t cleared_total;     /* 1P: gems cleared, drives the level */
static uint8_t  level;             /* 1P: 1..9, speeds up the fall */
static uint16_t dirty_rows[2];     /* bitmask: board rows needing repaint */
static uint8_t  hud_dirty[2];      /* score (or level) number needs redraw */
static uint8_t  drain_turn;        /* which player's row repaints this frame */
static uint16_t rng = 0xACE1;

#define VS_FALL_DELAY 24           /* 2P: fixed gravity (frames per row) */
#define GARBAGE_CAP   4            /* max garbage rows per attack */

/* ── GAME LOGIC (clay) — xorshift16 PRNG (~tens of cycles per call) ── */
static uint8_t random8(void) {
  uint16_t r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (uint8_t)r;
}

/* cell colour → BG tile (empty cells show the faint speck, not raw black,
 * so the well reads as a recessed playfield). */
static uint8_t bg_tile_for(uint8_t col) {
  return col ? (uint8_t)(BG_GEM_BASE - 1 + col) : BG_INNER;
}

static void mark_row_dirty(uint8_t p, int8_t r) {
  if (r >= 0 && r < GRID_H) dirty_rows[p] |= (uint16_t)1 << r;
}
static void mark_all_dirty(uint8_t p) {
  dirty_rows[p] = 0x0FFF;          /* all 12 rows */
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * The board is BACKGROUND TILES, updated only through the QUEUED path
 * (tile_set / text_draw). The NMI drains at most 16 queue entries per
 * vblank — that is the entire write bandwidth you get while rendering is on.
 * NEVER vram_unsafe_set while rendering: raw $2007 traffic mid-frame
 * corrupts the PPU address latch and shears the screen.
 *
 * So repaints are BUDGETED: board changes mark rows dirty, and this drainer
 * repaints ONE row (6 cells) + ONE HUD number (5 digits) per frame — 11
 * entries, safely inside the 16. A full-board repaint (cascade + gravity)
 * spreads over up to 12 frames per player (~0.2s) — you SEE the well sweep
 * top-to-bottom, which puzzle players read as a clear animation. Free juice.
 * (Overflowing the queue doesn't corrupt anything — tile_set blocks until
 * the NMI drains a slot — but every blocked push silently costs a whole
 * frame, so a naive 72-cell repaint would freeze the game for ~4 frames.) */
static void drain_vram_budget(void) {
  uint8_t p, r, c;
  uint8_t (*g)[GRID_W];
  /* One dirty board row, alternating players so neither well starves. */
  p = drain_turn;
  drain_turn ^= 1;
  if (!dirty_rows[p]) p ^= 1;
  if (dirty_rows[p]) {
    g = grid_of(p);
    for (r = 0; r < GRID_H; r++) {
      if (dirty_rows[p] & ((uint16_t)1 << r)) {
        for (c = 0; c < GRID_W; c++)
          tile_set(0, (uint8_t)(well_tx[p] + c), (uint8_t)(WELL_TY + r),
                   bg_tile_for(g[r][c]));
        dirty_rows[p] &= (uint16_t)~((uint16_t)1 << r);
        break;                     /* one row per frame — that's the budget */
      }
    }
  }
  /* One HUD number per frame. HUD LAYOUT RULE (overscan): nametable row 0
   * is cropped on NTSC — all HUD text sits on rows 1-2, never row 0. */
  if (hud_dirty[0]) {
    text_draw_u16(0, 2, 2, score[0]);
    hud_dirty[0] = 0;
  } else if (hud_dirty[1]) {
    if (two_player) text_draw_u16(0, 22, 2, score[1]);
    else            text_draw_u16(0, 22, 2, level);
    hud_dirty[1] = 0;
  }
}

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Match scan: mark every straight run of 3+ same-coloured gems in all 4
 * directions (a cell can belong to several runs — the mask de-dupes), and
 * return how many cells matched. This is the resolve-time spike the header's
 * frame-budget note talks about. */
static const int8_t DIRS4[4][2] = { {0,1}, {1,0}, {1,1}, {1,-1} };

static uint8_t mark_and_count(uint8_t p) {
  uint8_t r, c, d, len, k, cnt, col;
  int8_t dr, dc;
  int sr, sc;
  uint8_t (*g)[GRID_W] = grid_of(p);
  cnt = 0;
  for (r = 0; r < GRID_H; r++)
    for (c = 0; c < GRID_W; c++) matched[r][c] = 0;
  for (r = 0; r < GRID_H; r++) {
    for (c = 0; c < GRID_W; c++) {
      col = g[r][c];
      if (col == EMPTY) continue;
      for (d = 0; d < 4; d++) {
        dr = DIRS4[d][0]; dc = DIRS4[d][1];
        sr = (int)r - dr; sc = (int)c - dc;
        if (sr >= 0 && sr < GRID_H && sc >= 0 && sc < GRID_W
            && g[sr][sc] == col) continue;     /* not the run's start */
        len = 1;
        sr = (int)r + dr; sc = (int)c + dc;
        while (sr >= 0 && sr < GRID_H && sc >= 0 && sc < GRID_W
               && g[sr][sc] == col) { len++; sr += dr; sc += dc; }
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

/* Collapse each column so survivors rest on the floor (walk from the bottom,
 * copying gems down to a write cursor, then zero everything above it). */
static void apply_gravity(uint8_t p) {
  uint8_t c;
  int8_t r, w;
  uint8_t (*g)[GRID_W] = grid_of(p);
  for (c = 0; c < GRID_W; c++) {
    w = GRID_H - 1;
    for (r = GRID_H - 1; r >= 0; r--) {
      if (g[r][c] != EMPTY) { g[w][c] = g[r][c]; w--; }
    }
    for (; w >= 0; w--) g[w][c] = EMPTY;
  }
}

/* ── GAME LOGIC (clay) — end of game (top-out). `loser` topped out. ── */
static void game_end(uint8_t loser) {
  uint16_t best = score[0];
  if (two_player && score[1] > best) best = score[1];
  if (best > hiscore) {
    hiscore = best;
    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * Persists via battery PRG-RAM at $6000; works because the crt0's iNES
     * header sets the BATTERY bit. See nes_runtime.c for the magic+checksum
     * layout (first boot reads garbage — the checksum rejects it). ── */
    hiscore_save(hiscore);
  }
  sound_play_noise(8, 12, 16);                 /* game-over rumble */
  if (two_player) text_draw(0, 12, 22, loser ? "P1 WINS" : "P2 WINS");
  else            text_draw(0, 11, 22, "GAME OVER");
  text_draw(0, 9, 24, "START - TITLE");
  prev_pad[0] = 0xFF;                          /* require a fresh press */
  state = ST_OVER;
}

/* ── GAME LOGIC (clay) — clear matches, drop survivors, chain cascades.
 * Returns the chain depth (0 = the lock matched nothing). Score and repaints
 * happen here; the actual VRAM writes trickle out via drain_vram_budget. */
static uint8_t resolve_board(uint8_t p) {
  uint8_t n, r, c, chain;
  uint16_t amt;
  uint8_t (*g)[GRID_W] = grid_of(p);
  chain = 0;
  for (;;) {
    n = mark_and_count(p);
    if (n == 0) break;
    ++chain;
    for (r = 0; r < GRID_H; r++)
      for (c = 0; c < GRID_W; c++)
        if (matched[r][c]) g[r][c] = EMPTY;
    amt = (uint16_t)n * 10;
    if (chain > 1) amt *= chain;               /* cascades pay multiplied */
    score[p] += amt;
    hud_dirty[p] = 1;
    /* clear chime — rises with chain depth */
    sound_play_tone(0, (uint16_t)(0x120 - ((uint16_t)chain << 4)), 8, 8);
    apply_gravity(p);
    mark_all_dirty(p);                         /* gravity moved everything */
    if (!two_player) {
      cleared_total += n;
      while (level < 9 && cleared_total >= (uint16_t)level * 10) {
        ++level;
        hud_dirty[1] = 1;                      /* 1P: slot 1 shows the level */
      }
    }
  }
  return chain;
}

/* ── GAME LOGIC (clay) — VERSUS attack: garbage rows rise from the bottom of
 * the victim's well (random gems with one gap — matchable, so a skilled
 * victim digs out). The victim's stack rising into row <0 territory means
 * the falling trio shifts up one to stay aligned; if the rim row is already
 * occupied, the victim tops out and loses. ── */
static void garbage_insert(uint8_t v, uint8_t nrows) {
  uint8_t k, c, gap;
  int8_t r;
  uint8_t (*g)[GRID_W] = grid_of(v);
  sound_play_noise(10, 8, 8);                  /* incoming-garbage thud */
  for (k = 0; k < nrows; k++) {
    for (c = 0; c < GRID_W; c++) {
      if (g[0][c] != EMPTY) { game_end(v); return; }
    }
    for (r = 0; r < GRID_H - 1; r++)
      for (c = 0; c < GRID_W; c++)
        g[r][c] = g[r + 1][c];
    gap = random8() % GRID_W;
    for (c = 0; c < GRID_W; c++)
      g[GRID_H - 1][c] = (c == gap) ? EMPTY : (uint8_t)(1 + random8() % 3);
    if (piece_y[v] > -3) --piece_y[v];         /* keep the trio board-relative */
  }
  mark_all_dirty(v);
}

/* Can the trio occupy column x, rows y..y+2? Cells above the rim are fine
 * (pieces enter from above); below the floor or on a gem is not. */
static uint8_t can_place(uint8_t p, int8_t x, int8_t y) {
  int8_t i, cy;
  uint8_t (*g)[GRID_W] = grid_of(p);
  if (x < 0 || x >= GRID_W) return 0;
  for (i = 0; i < 3; i++) {
    cy = (int8_t)(y + i);
    if (cy < 0) continue;
    if (cy >= GRID_H) return 0;
    if (g[cy][x] != EMPTY) return 0;
  }
  return 1;
}

static void spawn_piece(uint8_t p) {
  piece_x[p] = GRID_W / 2;
  piece_y[p] = -2;
  piece_col[p][0] = (uint8_t)(1 + random8() % 3);
  piece_col[p][1] = (uint8_t)(1 + random8() % 3);
  piece_col[p][2] = (uint8_t)(1 + random8() % 3);
  if (!can_place(p, (int8_t)piece_x[p], piece_y[p])) game_end(p);
}

/* ── GAME LOGIC (clay) — land the trio, resolve, attack, respawn. ── */
static void lock_piece(uint8_t p) {
  int8_t i, y;
  uint8_t chain;
  uint8_t (*g)[GRID_W] = grid_of(p);
  for (i = 0; i < 3; i++) {
    y = (int8_t)(piece_y[p] + i);
    if (y >= 0) {
      g[y][piece_x[p]] = piece_col[p][i];
      mark_row_dirty(p, y);
    }
  }
  sound_play_tone(1, 0x1C0, 4, 3);             /* lock thunk */
  if (piece_y[p] < 0) { game_end(p); return; } /* locked above the rim */
  chain = resolve_board(p);
  if (state != ST_PLAY) return;
  if (chain && two_player) {
    garbage_insert(p ^ 1, chain > GARBAGE_CAP ? GARBAGE_CAP : chain);
    if (state != ST_PLAY) return;              /* garbage topped them out */
  }
  spawn_piece(p);
}

/* ── GAME LOGIC (clay) — per-player input + gravity. Edge-triggered moves
 * (one cell per press), held DOWN soft-drops. A/B cycle the trio's colours
 * — the classic trio "rotate". ── */
static void update_player(uint8_t p) {
  uint8_t pad, newp, fd, t;
  pad = pad_poll(p);
  newp = (uint8_t)(pad & (uint8_t)~prev_pad[p]);
  prev_pad[p] = pad;
  if ((newp & PAD_LEFT) && can_place(p, (int8_t)(piece_x[p] - 1), piece_y[p]))
    --piece_x[p];
  if ((newp & PAD_RIGHT) && can_place(p, (int8_t)(piece_x[p] + 1), piece_y[p]))
    ++piece_x[p];
  if (newp & PAD_A) {                          /* cycle colours downward */
    t = piece_col[p][2];
    piece_col[p][2] = piece_col[p][1];
    piece_col[p][1] = piece_col[p][0];
    piece_col[p][0] = t;
    sound_play_tone(1, 0x0A0, 3, 2);
  }
  if (newp & PAD_B) {                          /* cycle colours upward */
    t = piece_col[p][0];
    piece_col[p][0] = piece_col[p][1];
    piece_col[p][1] = piece_col[p][2];
    piece_col[p][2] = t;
    sound_play_tone(1, 0x0C0, 3, 2);
  }
  if (pad & PAD_DOWN) fall_t[p] += 4;          /* soft drop */
  ++fall_t[p];
  fd = two_player ? VS_FALL_DELAY
                  : (uint8_t)(32 - ((level << 1) + level));   /* 29..5 */
  if (fall_t[p] >= fd) {
    fall_t[p] = 0;
    if (can_place(p, (int8_t)piece_x[p], (int8_t)(piece_y[p] + 1)))
      ++piece_y[p];
    else
      lock_piece(p);                           /* may end the game */
  }
}

/* Stage the falling trio's sprites (board gems are BG tiles, NOT sprites —
 * only what moves every frame earns OAM slots). */
static void stage_piece(uint8_t p) {
  uint8_t i;
  int8_t y;
  for (i = 0; i < 3; i++) {
    y = (int8_t)(piece_y[p] + i);
    if (y >= 0)
      oam_spr((uint8_t)((well_tx[p] + piece_x[p]) << 3),
              (uint8_t)((WELL_TY + (uint8_t)y) << 3),
              piece_col[p][i], 0);
  }
}

/* 5-digit number with the PPU off (the queued text_draw_u16 would deadlock
 * before rendering is enabled — same rule as text_draw_unsafe). */
static void text_u16_unsafe(uint16_t addr, uint16_t v) {
  uint8_t d[5], i;
  for (i = 0; i < 5; i++) { d[i] = v % 10; v /= 10; }
  for (i = 0; i < 5; i++)
    vram_unsafe_set((uint16_t)(addr + i), (uint8_t)(0x40 + d[4 - i]));
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Attribute table = palette per 16x16-PIXEL area (one 2-bit quadrant per
 * 2x2 TILES). The wells use BG palette 0 (gem colours) and everything else
 * palette 1 (text/frame/dither) — which only works because the wells are
 * aligned to EVEN tile coordinates (WELL_TY=8; well columns 4/12/22), so
 * every attribute quadrant is fully inside or fully outside a well. Move a
 * well to an odd column and its edge quadrants straddle the boundary —
 * half-recoloured gems. Keep wells 2-aligned (or budget palettes so
 * neighbouring regions share one). */
static uint8_t quad_pal(uint8_t tc, uint8_t tr) {
  if (tr >= WELL_TY && tr < WELL_TY + GRID_H) {
    if (tc >= well_tx[0] && tc < well_tx[0] + GRID_W) return 0;
    if (two_player && tc >= well_tx[1] && tc < well_tx[1] + GRID_W) return 0;
  }
  return 1;
}

static void paint_attributes(void) {
  uint8_t ar, ac, b;
  for (ar = 0; ar < 8; ar++) {
    for (ac = 0; ac < 8; ac++) {
      b = (uint8_t)( quad_pal((uint8_t)(ac * 4),     (uint8_t)(ar * 4))
                  | (quad_pal((uint8_t)(ac * 4 + 2), (uint8_t)(ar * 4))     << 2)
                  | (quad_pal((uint8_t)(ac * 4),     (uint8_t)(ar * 4 + 2)) << 4)
                  | (quad_pal((uint8_t)(ac * 4 + 2), (uint8_t)(ar * 4 + 2)) << 6));
      vram_unsafe_set((uint16_t)(0x23C0 + ar * 8 + ac), b);
    }
  }
}

/* ── GAME LOGIC (clay) — the title screen ──────────────────────────────────
 * Painted with the PPU OFF (text_draw_unsafe = raw VRAM writes; the queued
 * variant would deadlock with rendering disabled — see TROUBLESHOOTING). */
static void paint_title(void) {
  uint8_t r, c;
  ppu_off();
  for (r = 0; r < 30; r++)
    for (c = 0; c < 32; c++)
      vram_unsafe_set((uint16_t)(0x2000 + (uint16_t)r * 32 + c),
                      (r < 2) ? 0 : BG_DITHER);
  for (c = 0; c < 64; c++)                     /* whole screen → palette 1 */
    vram_unsafe_set((uint16_t)(0x23C0 + c), 0x55);
  text_draw_unsafe(0x2000 + 8 * 32 + ((32 - sizeof(GAME_TITLE) + 1) / 2), GAME_TITLE);
  text_draw_unsafe(0x2000 + 13 * 32 + 10, "1P START - A");
  text_draw_unsafe(0x2000 + 15 * 32 + 9,  "2P VERSUS - B");
  text_draw_unsafe(0x2000 + 20 * 32 + 10, "HI");
  text_u16_unsafe((uint16_t)(0x2000 + 20 * 32 + 13), hiscore);
  ppu_scroll(0, 0);
  oam_clear();
  ppu_on_all();
}

/* ── GAME LOGIC (clay) — paint the playfield: cabinet dither, well frames,
 * recessed interiors, HUD labels + starting numbers. PPU off throughout. ── */
static void paint_well(uint8_t p) {
  uint8_t r, c, x0;
  x0 = well_tx[p];
  for (c = (uint8_t)(x0 - 1); c <= (uint8_t)(x0 + GRID_W); c++) {
    vram_unsafe_set((uint16_t)(0x2000 + (WELL_TY - 1) * 32 + c), BG_WALL);
    vram_unsafe_set((uint16_t)(0x2000 + (WELL_TY + GRID_H) * 32 + c), BG_WALL);
  }
  for (r = (uint8_t)(WELL_TY - 1); r <= (uint8_t)(WELL_TY + GRID_H); r++) {
    vram_unsafe_set((uint16_t)(0x2000 + (uint16_t)r * 32 + (x0 - 1)), BG_WALL);
    vram_unsafe_set((uint16_t)(0x2000 + (uint16_t)r * 32 + (x0 + GRID_W)), BG_WALL);
  }
  for (r = 0; r < GRID_H; r++)
    for (c = 0; c < GRID_W; c++)
      vram_unsafe_set((uint16_t)(0x2000 + (uint16_t)(WELL_TY + r) * 32 + x0 + c),
                      BG_INNER);
}

static void paint_play(void) {
  uint8_t r, c;
  ppu_off();
  /* Cabinet dither everywhere; rows 0-2 blank (row 0 = overscan-cropped,
   * rows 1-2 = the HUD band — keep text on a clean background). */
  for (r = 0; r < 30; r++)
    for (c = 0; c < 32; c++)
      vram_unsafe_set((uint16_t)(0x2000 + (uint16_t)r * 32 + c),
                      (r < 3) ? 0 : BG_DITHER);
  paint_well(0);
  if (two_player) paint_well(1);
  paint_attributes();
  /* HUD: labels row 1, numbers row 2 (row 0 NEVER — overscan). */
  text_draw_unsafe(0x2000 + 32 + 4,  two_player ? "P1" : "SC");
  text_draw_unsafe(0x2000 + 32 + 14, "HI");
  text_draw_unsafe(0x2000 + 32 + 24, two_player ? "P2" : "LV");
  text_u16_unsafe(0x2000 + 64 + 2,  0);
  text_u16_unsafe(0x2000 + 64 + 12, hiscore);
  text_u16_unsafe(0x2000 + 64 + 22, two_player ? 0 : 1);
  ppu_scroll(0, 0);
  oam_clear();
  ppu_on_all();
}

/* ── GAME LOGIC (clay) — start a run ── */
static void start_game(uint8_t versus) {
  uint8_t p, r, c;
  uint8_t (*g)[GRID_W];
  two_player = versus;
  well_tx[0] = versus ? WELL_VS_P1 : WELL_1P_TX;
  well_tx[1] = WELL_VS_P2;
  /* Stir the PRNG with time-spent-on-title so runs differ. */
  rng ^= (uint16_t)(((uint16_t)nmi_counter << 7) | nmi_counter);
  if (rng == 0) rng = 0xACE1;
  for (p = 0; p < 2; p++) {
    g = grid_of(p);
    for (r = 0; r < GRID_H; r++)
      for (c = 0; c < GRID_W; c++) g[r][c] = EMPTY;
    fall_t[p] = 0;
    score[p] = 0;
    hud_dirty[p] = 0;
    dirty_rows[p] = 0;
    prev_pad[p] = 0xFF;            /* the button that started the game
                                    * shouldn't also rotate the first trio */
  }
  cleared_total = 0;
  level = 1;
  drain_turn = 0;
  paint_play();
  state = ST_PLAY;
  spawn_piece(0);
  if (versus) spawn_piece(1);
}

void main(void) {
  uint8_t pad, newp;

  /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
   * Init order: PPU off → CHR upload → palette → nametable (raw writes) →
   * OAM clear → rendering on. CHR/palette/nametable writes REQUIRE the PPU
   * off (raw $2007 traffic during rendering corrupts the address latch
   * mid-frame). The runtime's ppu_off/ppu_on_all pair owns the PPUCTRL/
   * PPUMASK bits — don't poke those registers directly alongside it. */
  ppu_off();
  chr_ram_upload(0x0000, tile_blank,  16);     /* sprite table: trio gems */
  chr_ram_upload(0x0010, tile_gem1,   16);
  chr_ram_upload(0x0020, tile_gem2,   16);
  chr_ram_upload(0x0030, tile_gem3,   16);
  chr_ram_upload(0x1010, tile_wall,   16);     /* BG table: furniture + gems */
  chr_ram_upload(0x1020, tile_dither, 16);
  chr_ram_upload(0x1030, tile_inner,  16);
  chr_ram_upload(0x1040, tile_gem1,   16);
  chr_ram_upload(0x1050, tile_gem2,   16);
  chr_ram_upload(0x1060, tile_gem3,   16);
  font_upload();
  palette_load(palette);
  sound_init();

  hiscore = hiscore_load();        /* battery SRAM — 0 on first boot */
  state = ST_TITLE;
  prev_pad[0] = 0xFF;
  paint_title();

  for (;;) {
    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: A/START = 1P, B = 2P versus ── */
      oam_clear();
      ppu_wait_nmi();
      sound_music_tick();
      pad = pad_poll(0);
      newp = (uint8_t)(pad & (uint8_t)~prev_pad[0]);
      prev_pad[0] = pad;
      if (newp & PAD_A) start_game(0);
      else if (newp & PAD_B) start_game(1);
      else if (newp & PAD_START) start_game(0);
      continue;
    }

    if (state == ST_OVER) {
      /* Freeze the boards (trios hidden); finish trickling out any queued
       * repaints; START or A returns to the title. */
      oam_clear();
      ppu_wait_nmi();
      sound_music_tick();
      drain_vram_budget();
      pad = pad_poll(0);
      newp = (uint8_t)(pad & (uint8_t)~prev_pad[0]);
      prev_pad[0] = pad;
      if (newp & (PAD_START | PAD_A)) {
        /* Flush the queue BEFORE repainting: paint_title turns the PPU off,
         * and any still-queued board writes would otherwise land on top of
         * the freshly painted title when the NMI comes back. */
        ppu_wait_nmi();
        ppu_wait_nmi();
        state = ST_TITLE;
        prev_pad[0] = 0xFF;
        paint_title();
      }
      continue;
    }

    /* ── ST_PLAY ─────────────────────────────────────────────────────── */

    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * Stage ALL sprites BEFORE ppu_wait_nmi(). The NMI DMAs shadow OAM →
     * real OAM at the START of vblank, copying whatever shadow OAM holds AT
     * THAT MOMENT. Stage-then-wait; flipping it shows stale/empty sprites. */
    oam_clear();
    stage_piece(0);
    if (two_player) stage_piece(1);

    ppu_wait_nmi();
    sound_music_tick();

    /* ── GAME LOGIC (clay — reshape freely) ── */
    update_player(0);
    if (two_player && state == ST_PLAY) update_player(1);
    if (state == ST_PLAY) drain_vram_budget();
  }
}
