/* ── puzzle.c — SNES falling-jewel versus puzzle (complete example game) ──────
 *
 * A COMPLETE, working game — title screen, 1P marathon (levels speed the
 * fall) and 2P SIMULTANEOUS split-board versus with garbage attacks,
 * score + persistent hi-score (battery SRAM, survives power cycles),
 * SPC music + SFX, and the board rendered the SNES way: a WRAM shadow
 * tilemap blasted to VRAM by DMA every single frame.
 *
 * The game: a falling-trio match-3. A trio of jewels falls into a 6x12 well;
 * LEFT/RIGHT move it, A/B cycle its three colours, DOWN soft-drops. When it
 * lands, any straight run of 3+ same-coloured jewels (horizontal, vertical,
 * or diagonal) clears; survivors fall and cascades chain for multiplied score.
 *
 * 2P VERSUS design (simultaneous, split board): two 6x12 wells side by side —
 * P1 left on controller 1, P2 right on controller 2 (padsCurrent(1) — that's
 * the entire 2P wiring), both falling at once. Clears ATTACK: every chain
 * step you score sends one garbage row (random jewels with one gap, capped
 * at 4 per attack) rising from the bottom of the opponent's well. First
 * player whose stack reaches the top loses.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented SNES footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — match rules, garbage, tuning, art: reshape freely.
 *
 * What depends on what:
 *   data.asm — console font, the 8-tile board/jewel tileset + palette
 *     (shared by BG2 and the OBJ sprites), and sram_read16/write16.
 *     Load-bearing.
 *   hdr.asm — THIS PROJECT OVERRIDES the stock header to declare battery
 *     SRAM (CARTRIDGETYPE $02 + SRAMSIZE $01). Delete that file and saves
 *     silently stop existing — the build still succeeds.
 *   snes_sfx.{h,c} + snes_sfx_data.asm + apu_blob.bin — the SPC700 sound
 *     driver (music + 2 one-shot samples). #include'd, not separately built.
 *
 * ── SNES vs NES: THE SAME GAME, TWO RENDER BUDGETS (teaching note) ──────────
 * The NES build of this exact game (examples/nes puzzle) has to DRIP board
 * repaints through a queued-VRAM path: the NMI drains at most 16 queue bytes
 * per vblank, so a cascade repaints ONE dirty row per frame and a full-board
 * sweep takes 12 frames. On the SNES none of that machinery exists: the whole
 * 32x32 board tilemap lives in WRAM (board_map below) and general-purpose DMA
 * copies all 2 KB of it to VRAM EVERY frame inside vblank (~12 scanlines of
 * the ~38 available — bus speed makes the budget problem evaporate). Game
 * logic just rewrites WRAM whenever it likes, with zero dirty-row tracking
 * toward the PPU; a 12-row double-cascade lands on screen in ONE frame.
 *
 * Frame budget: input + gravity for two trios is nothing; the spike is
 * resolve_board() at lock time (full 4-direction match scan over 72 cells in
 * tcc-compiled C). It can spill a frame past vblank — that shows as (at
 * most) a one-frame hitch on the falling pieces, never corruption, because
 * the shadow map is only DMA'd after WaitForVBlank.
 *
 * VRAM BUDGET (word addresses):
 *   $2000- board tileset (8 tiles)     $3000- console font (96 glyphs)
 *   $4000- board map (BG2, 32x32)      $6000- OBJ tiles (same 8 tiles)
 *   $6800- console text map (BG1)
 */

#include <snes.h>
#include "snes_sfx.c"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "JEWEL JOUST"

extern char tilfont, palfont;          /* console font + text palette (data.asm) */
extern char tilboard, palboard;        /* board/jewel tiles + palette            */

/* consoleVblank() copies the dirty text tilemap to VRAM during VBlank.
 * No public prototype in console.h, so declare it; call once per frame. */
extern void consoleVblank(void);

/* data.asm exports — battery SRAM accessors ($70:0000 long addressing). */
extern u16 sram_read16(u16 offset);
extern void sram_write16(u16 offset, u16 value);

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Board geometry. Tile coordinates are free on the SNES: unlike the NES there
 * is NO attribute table — every 4bpp map entry carries its own palette bits —
 * so wells can sit at ANY column (the NES version must keep them 2-aligned). */
#define GRID_W   6
#define GRID_H   12
#define GRID_CELLS (GRID_W * GRID_H)
#define WELL_TY  8            /* top tile row of the well interior */
#define WELL_1P_TX 13         /* 1P: single centered well (cols 13-18) */
#define WELL_VS_P1 4          /* 2P: P1 well cols 4-9 ...              */
#define WELL_VS_P2 22         /*     P2 well cols 22-27 (split board)  */

#define EMPTY 0               /* cell colours 1..3 = ruby/emerald/amber */

/* board tileset indices — MUST match the tile order in data.asm */
#define BG_BLANK    0
#define BG_WALL     1
#define BG_DITHER   2
#define BG_INNER    3
#define BG_GEM_BASE 4         /* tiles 4/5/6 = jewel colours 1/2/3 */

/* BG2 map entries select CGRAM palette block 1 (vhopppcc cccccccc). */
#define MAP_PAL1  0x0400

#define VS_FALL_DELAY 24      /* 2P: fixed gravity (frames per row) */
#define GARBAGE_CAP   4       /* max garbage rows per attack */

/* SRAM layout: [0]=magic "JJ", [2]=hi-score, [4]=hi ^ 0xA5C3.
 * Magic is written LAST in hi_save so a torn write never validates. */
#define SRAM_MAGIC 0x4A4Au

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2

static u8  state;
static u8  two_player;         /* mode chosen on the title screen */
static u8  sound_ok;
static u8  well_tx[2];         /* left tile column of each well */
static u8  piece_x[2];         /* falling trio: column 0..5 */
static s8  piece_y[2];         /* row of its TOP cell (<0 = above rim) */
static u8  piece_col[2][3];    /* trio colours, top to bottom */
static u8  fall_t[2];          /* frames until next gravity step */
static u16 prev_pad[2];        /* per-player edge-triggered input */
static u16 prev_pad0;          /* shell (title/game-over) edge detect */
static u16 score[2];
static u16 hiscore;
static u16 cleared_total;      /* 1P: jewels cleared, drives the level */
static u8  level;              /* 1P: 1..9, speeds up the fall */
static u8  board_dirty[2];     /* well cells changed → recompose shadow map */
static u8  garb_rows[2];       /* garbage rows RECEIVED (telemetry + tuning) */
static u16 frames;             /* free-running frame counter (PRNG stir) */
static u16 rng = 0xACE1;
static char tbuf[8];           /* 5-digit number formatter output */

/* the two boards, flattened (row*GRID_W+col); P2's right after P1's */
static u8 grid[2 * GRID_CELLS];
static u8 matched[GRID_CELLS];
#define GRIDOF(p) (grid + ((p) ? GRID_CELLS : 0))

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * The board's WRAM shadow tilemap. This 2 KB array IS the screen: game code
 * writes map entries here whenever it likes (any time, mid-frame, mid-logic),
 * and the main loop DMAs the whole thing to VRAM word $4000 right after
 * WaitForVBlank — full repaint, every frame, no queue, no dirty-row budget
 * (see the NES-contrast note in the header). The ONLY rule is the DMA's:
 * VRAM writes land correctly ONLY during vblank/forced blank, so the
 * dmaCopyVram call must stay where it is, between WaitForVBlank and the
 * frame's logic. Writing board_map itself is always safe. */
static u16 board_map[32 * 32];

/* headless-test telemetry — magic "JW"+0xBD; a test harness scans WRAM for
 * it and plays the game from real state instead of parsing pixels. Costs a
 * few byte-writes per frame; delete freely. */
static u8 telem[24];

/* ── GAME LOGIC (clay) — xorshift16 PRNG (~tens of cycles per call) ── */
static u8 random8(void) {
  u16 r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (u8)r;
}

/* cell colour → board tile (empty cells show the faint speck, not raw
 * backdrop, so the well reads as a recessed playfield). */
static u16 cell_entry(u8 col) {
  return (u16)(col ? (u8)(BG_GEM_BASE - 1 + col) : BG_INNER) | MAP_PAL1;
}

/* ── GAME LOGIC (clay) — shadow-map painters ─────────────────────────────────
 * All of these only touch board_map (WRAM); the per-frame DMA makes them
 * visible. paint_board is the per-change repaint: ~72 u16 stores, cheap
 * enough to run whole-board whenever anything locked/cleared/shifted. */
static void map_fill(u8 tile) {
  u16 i, e;
  e = (u16)tile | MAP_PAL1;
  for (i = 0; i < 32 * 32; i++) board_map[i] = e;
}

static void map_row_fill(u8 row, u8 tile) {
  u16 i, base;
  base = (u16)row << 5;
  for (i = 0; i < 32; i++) board_map[base + i] = (u16)tile | MAP_PAL1;
}

static void paint_board(u8 p) {
  u8 r, c;
  u16 base;
  u8 *g = GRIDOF(p);
  for (r = 0; r < GRID_H; r++) {
    base = ((u16)(WELL_TY + r) << 5) + well_tx[p];
    for (c = 0; c < GRID_W; c++)
      board_map[base + c] = cell_entry(*g++);
  }
}

static void paint_well_frame(u8 p) {
  u8 r, c, x0;
  u16 e;
  x0 = well_tx[p];
  e = (u16)BG_WALL | MAP_PAL1;
  for (c = (u8)(x0 - 1); c <= (u8)(x0 + GRID_W); c++) {
    board_map[((u16)(WELL_TY - 1) << 5) + c] = e;
    board_map[((u16)(WELL_TY + GRID_H) << 5) + c] = e;
  }
  for (r = (u8)(WELL_TY - 1); r <= (u8)(WELL_TY + GRID_H); r++) {
    board_map[((u16)r << 5) + (u16)(x0 - 1)] = e;
    board_map[((u16)r << 5) + (u16)(x0 + GRID_W)] = e;
  }
}

/* title backdrop: dither cabinet, a clear band for the menu text, and a
 * jewel stripe under the logo (the attract twist below scrolls its hues). */
static void paint_title_map(void) {
  u8 r, c;
  map_fill(BG_DITHER);
  for (r = 2; r <= 6; r++) map_row_fill(r, BG_BLANK);
  for (r = 13; r <= 17; r++) map_row_fill(r, BG_BLANK);
  for (c = 0; c < 32; c++) {
    board_map[(25u << 5) + c] = (u16)BG_WALL | MAP_PAL1;
  }
}

static void paint_title_stripe(u8 phase) {
  u8 c;
  for (c = 10; c < 22; c++)
    board_map[(7u << 5) + c] =
      (u16)(BG_GEM_BASE + (u8)((c + phase) % 3)) | MAP_PAL1;
}

static void paint_play_map(void) {
  u8 r;
  map_fill(BG_DITHER);
  for (r = 0; r < 3; r++) map_row_fill(r, BG_BLANK);  /* clean HUD band */
  paint_well_frame(0);
  paint_board(0);
  if (two_player) { paint_well_frame(1); paint_board(1); }
}

/* ── GAME LOGIC (clay) — text helpers (console BG1, queued via consoleVblank) */
static void fmt5(u16 v) {
  s8 i;
  for (i = 4; i >= 0; i--) { tbuf[i] = (char)('0' + (v % 10)); v /= 10; }
  tbuf[5] = 0;
}

static void clear_rows(u8 a, u8 b) {
  u8 y;
  for (y = a; y <= b; y++)
    consoleDrawText(0, y, "                                ");
}

static void draw_hud_num(u8 p) {
  if (p == 0) { fmt5(score[0]); consoleDrawText(2, 2, tbuf); }
  else {
    if (two_player) fmt5(score[1]); else fmt5(level);
    consoleDrawText(24, 2, tbuf);
  }
}

static void draw_hi(u8 x, u8 y) {
  fmt5(hiscore);
  consoleDrawText(x, y, tbuf);
}

/* ── GAME LOGIC (clay) — hi-score in battery SRAM (see sram_* in data.asm) ── */
static u16 hi_load(void) {
  u16 v;
  if (sram_read16(0) != SRAM_MAGIC) return 0;
  v = sram_read16(2);
  if (sram_read16(4) != (u16)(v ^ 0xA5C3u)) return 0;
  return v;
}

static void hi_save(u16 v) {
  sram_write16(2, v);
  sram_write16(4, (u16)(v ^ 0xA5C3u));
  sram_write16(0, SRAM_MAGIC);      /* magic LAST — torn write = no record */
}

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Match scan: mark every straight run of 3+ same-coloured jewels in all 4
 * directions (a cell can belong to several runs — the mask de-dupes), and
 * return how many cells matched. This is the resolve-time spike the header's
 * frame-budget note talks about. */
static const s8 DR4[4] = { 0, 1, 1,  1 };
static const s8 DC4[4] = { 1, 0, 1, -1 };

static u8 mark_and_count(u8 p) {
  u8 d, len, k, cnt, col;
  s16 r, c, sr, sc, dr, dc;
  u8 *g = GRIDOF(p);
  cnt = 0;
  for (k = 0; k < GRID_CELLS; k++) matched[k] = 0;
  for (r = 0; r < GRID_H; r++) {
    for (c = 0; c < GRID_W; c++) {
      col = g[r * GRID_W + c];
      if (col == EMPTY) continue;
      for (d = 0; d < 4; d++) {
        dr = DR4[d]; dc = DC4[d];
        sr = r - dr; sc = c - dc;
        if (sr >= 0 && sr < GRID_H && sc >= 0 && sc < GRID_W
            && g[sr * GRID_W + sc] == col) continue;   /* not the run's start */
        len = 1;
        sr = r + dr; sc = c + dc;
        while (sr >= 0 && sr < GRID_H && sc >= 0 && sc < GRID_W
               && g[sr * GRID_W + sc] == col) { len++; sr += dr; sc += dc; }
        if (len >= 3) {
          sr = r; sc = c;
          for (k = 0; k < len; k++) {
            if (!matched[sr * GRID_W + sc]) { matched[sr * GRID_W + sc] = 1; cnt++; }
            sr += dr; sc += dc;
          }
        }
      }
    }
  }
  return cnt;
}

/* Collapse each column so survivors rest on the floor (walk from the bottom,
 * copying jewels down to a write cursor, then zero everything above it). */
static void apply_gravity(u8 p) {
  s16 c, r, w;
  u8 *g = GRIDOF(p);
  for (c = 0; c < GRID_W; c++) {
    w = GRID_H - 1;
    for (r = GRID_H - 1; r >= 0; r--) {
      if (g[r * GRID_W + c] != EMPTY) { g[w * GRID_W + c] = g[r * GRID_W + c]; w--; }
    }
    for (; w >= 0; w--) g[w * GRID_W + c] = EMPTY;
  }
}

/* ── GAME LOGIC (clay) — end of game (top-out). `loser` topped out. ── */
static void game_end(u8 loser) {
  u16 best = score[0];
  if (two_player && score[1] > best) best = score[1];
  if (best > hiscore) {
    hiscore = best;
    hi_save(hiscore);               /* battery SRAM — survives power-off */
    draw_hi(13, 2);
  }
  if (sound_ok) sfx_play(2);        /* game-over thud */
  if (two_player) consoleDrawText(12, 22, loser ? "P1 WINS" : "P2 WINS");
  else            consoleDrawText(11, 22, "GAME OVER");
  consoleDrawText(9, 24, "START - TITLE");
  prev_pad0 = 0xFFFF;               /* require a fresh press */
  state = ST_OVER;
}

/* ── GAME LOGIC (clay) — clear matches, drop survivors, chain cascades.
 * Returns the chain depth (0 = the lock matched nothing). The repaint is
 * just board_dirty=1: the whole well redraws into the shadow map this frame
 * and the next vblank's DMA shows it — chains land instantly on screen. */
static u8 resolve_board(u8 p) {
  u8 n, k, chain;
  u16 amt;
  u8 *g = GRIDOF(p);
  chain = 0;
  for (;;) {
    n = mark_and_count(p);
    if (n == 0) break;
    ++chain;
    for (k = 0; k < GRID_CELLS; k++)
      if (matched[k]) g[k] = EMPTY;
    amt = (u16)n * 10;
    if (chain > 1) amt *= chain;               /* cascades pay multiplied */
    score[p] += amt;
    draw_hud_num(p);
    if (sound_ok) sfx_play(2);                 /* clear chime */
    apply_gravity(p);
    board_dirty[p] = 1;
    if (!two_player) {
      cleared_total += n;
      while (level < 9 && cleared_total >= (u16)level * 10) {
        ++level;
        draw_hud_num(1);                       /* 1P: slot 1 shows the level */
      }
    }
  }
  return chain;
}

/* ── GAME LOGIC (clay) — VERSUS attack: garbage rows rise from the bottom of
 * the victim's well (random jewels with one gap — matchable, so a skilled
 * victim digs out). The victim's stack rising means the falling trio shifts
 * up one to stay board-relative; if the top row is already occupied, the
 * victim tops out and loses. ── */
static void garbage_insert(u8 v, u8 nrows) {
  u8 k, c, gap;
  s16 r;
  u8 *g = GRIDOF(v);
  if (sound_ok) sfx_play(2);                   /* incoming-garbage thud */
  for (k = 0; k < nrows; k++) {
    for (c = 0; c < GRID_W; c++)
      if (g[c] != EMPTY) { board_dirty[v] = 1; game_end(v); return; }
    for (r = 0; r < GRID_H - 1; r++)
      for (c = 0; c < GRID_W; c++)
        g[r * GRID_W + c] = g[(r + 1) * GRID_W + c];
    gap = random8() % GRID_W;
    for (c = 0; c < GRID_W; c++)
      g[(GRID_H - 1) * GRID_W + c] = (c == gap) ? EMPTY : (u8)(1 + random8() % 3);
    if (piece_y[v] > -3) --piece_y[v];         /* keep the trio board-relative */
    ++garb_rows[v];
  }
  board_dirty[v] = 1;
}

/* Can the trio occupy column x, rows y..y+2? Cells above the rim are fine
 * (pieces enter from above); below the floor or on a jewel is not. */
static u8 can_place(u8 p, s16 x, s16 y) {
  s16 i, cy;
  u8 *g = GRIDOF(p);
  if (x < 0 || x >= GRID_W) return 0;
  for (i = 0; i < 3; i++) {
    cy = y + i;
    if (cy < 0) continue;
    if (cy >= GRID_H) return 0;
    if (g[cy * GRID_W + x] != EMPTY) return 0;
  }
  return 1;
}

static void spawn_piece(u8 p) {
  piece_x[p] = GRID_W / 2;
  piece_y[p] = -2;
  piece_col[p][0] = (u8)(1 + random8() % 3);
  piece_col[p][1] = (u8)(1 + random8() % 3);
  piece_col[p][2] = (u8)(1 + random8() % 3);
  if (!can_place(p, (s16)piece_x[p], (s16)piece_y[p])) game_end(p);
}

/* ── GAME LOGIC (clay) — land the trio, resolve, attack, respawn. ── */
static void lock_piece(u8 p) {
  s16 i, y;
  u8 chain;
  u8 *g = GRIDOF(p);
  for (i = 0; i < 3; i++) {
    y = piece_y[p] + i;
    if (y >= 0) g[y * GRID_W + piece_x[p]] = piece_col[p][i];
  }
  board_dirty[p] = 1;
  if (sound_ok) sfx_play(1);                   /* lock click */
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
 * — the classic trio "rotate". P2's pad is just padsCurrent(1). ── */
static void update_player(u8 p) {
  u16 pad, newp;
  u8 fd, t;
  pad = padsCurrent(p);
  newp = pad & (u16)~prev_pad[p];
  prev_pad[p] = pad;
  if ((newp & KEY_LEFT) && can_place(p, (s16)(piece_x[p] - 1), (s16)piece_y[p]))
    --piece_x[p];
  if ((newp & KEY_RIGHT) && can_place(p, (s16)(piece_x[p] + 1), (s16)piece_y[p]))
    ++piece_x[p];
  if (newp & KEY_A) {                          /* cycle colours downward */
    t = piece_col[p][2];
    piece_col[p][2] = piece_col[p][1];
    piece_col[p][1] = piece_col[p][0];
    piece_col[p][0] = t;
    if (sound_ok) sfx_play(1);
  }
  if (newp & KEY_B) {                          /* cycle colours upward */
    t = piece_col[p][0];
    piece_col[p][0] = piece_col[p][1];
    piece_col[p][1] = piece_col[p][2];
    piece_col[p][2] = t;
    if (sound_ok) sfx_play(1);
  }
  if (pad & KEY_DOWN) fall_t[p] += 4;          /* soft drop */
  ++fall_t[p];
  fd = two_player ? VS_FALL_DELAY
                  : (u8)(32 - level * 3);      /* 1P: 29..5 frames per row */
  if (fall_t[p] >= fd) {
    fall_t[p] = 0;
    if (can_place(p, (s16)piece_x[p], (s16)(piece_y[p] + 1)))
      ++piece_y[p];
    else
      lock_piece(p);                           /* may end the game */
  }
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * The falling trios are the ONLY sprites (board jewels are BG tiles — only
 * what moves every frame earns OAM slots). oamSet's first arg is a BYTE
 * OFFSET into OAM (slot*4), its gfxoffset is a tile INDEX into the OBJ page.
 * Hiding = parking at y=240 (no oamSetEx churn). oamUpdate() queues the
 * shadow table; PVSnesLib's VBlank ISR DMAs it to hardware on channel 7
 * every NMI — so stage sprites BEFORE WaitForVBlank, never after. */
static void stage_pieces(void) {
  u8 p, i, n;
  s8 y;
  for (p = 0; p < 2; p++) {
    for (i = 0; i < 3; i++) {
      n = (u8)((p * 3 + i) << 2);
      y = (s8)(piece_y[p] + i);
      if (state == ST_PLAY && y >= 0 && (p == 0 || two_player))
        oamSet(n, (u16)((well_tx[p] + piece_x[p]) << 3),
               (u16)((WELL_TY + (u8)y) << 3), 3, 0, 0,
               (u16)(BG_GEM_BASE - 1 + piece_col[p][i]), 0);
      else
        oamSet(n, 0, 240, 3, 0, 0, 0, 0);      /* y=240 = hidden */
    }
  }
}

/* ── GAME LOGIC (clay) — state entries ─────────────────────────────────────── */
static void title_enter(void) {
  clear_rows(0, 27);
  consoleDrawText(10, 3, GAME_TITLE);
  consoleDrawText(11, 5, "HI"); draw_hi(14, 5);
  consoleDrawText(8, 14, "A - 1P MARATHON");
  consoleDrawText(8, 16, "B - 2P VERSUS");
  consoleDrawText(2, 26, "LR MOVE  A B SPIN  DOWN DROP");
  paint_title_map();
  paint_title_stripe(0);
  prev_pad0 = 0xFFFF;   /* swallow the press that ENTERED this state — without
                         * this, the START that left the game-over screen
                         * instantly starts a new 1P run (classic edge-detect
                         * reuse bug) */
  state = ST_TITLE;
}

static void start_game(u8 versus) {
  u8 p, k;
  two_player = versus;
  well_tx[0] = versus ? WELL_VS_P1 : WELL_1P_TX;
  well_tx[1] = WELL_VS_P2;
  /* Stir the PRNG with time-spent-on-title so runs differ. */
  rng ^= (u16)((frames << 7) | frames);
  if (rng == 0) rng = 0xACE1;
  for (p = 0; p < 2; p++) {
    u8 *g = GRIDOF(p);
    for (k = 0; k < GRID_CELLS; k++) g[k] = EMPTY;
    fall_t[p] = 0;
    score[p] = 0;
    garb_rows[p] = 0;
    board_dirty[p] = 0;
    prev_pad[p] = 0xFFFF;          /* the button that started the game
                                    * shouldn't also spin the first trio */
  }
  cleared_total = 0;
  level = 1;
  clear_rows(0, 27);
  /* HUD: labels row 1, numbers row 2 */
  consoleDrawText(2, 1, versus ? "P1" : "SC");
  consoleDrawText(13, 1, "HI");
  consoleDrawText(24, 1, versus ? "P2" : "LV");
  draw_hud_num(0);
  draw_hi(13, 2);
  draw_hud_num(1);
  paint_play_map();
  state = ST_PLAY;
  spawn_piece(0);
  if (versus) spawn_piece(1);
}

/* Headless-test telemetry — see the static block's comment. */
static void telem_update(void) {
  telem[0] = 'J'; telem[1] = 'W'; telem[2] = 0xBD;
  telem[3] = state;
  telem[4] = (u8)((sound_ok << 7) | two_player);
  telem[5] = level;
  telem[6] = (u8)score[0];  telem[7] = (u8)(score[0] >> 8);
  telem[8] = (u8)score[1];  telem[9] = (u8)(score[1] >> 8);
  telem[10] = piece_x[0];   telem[11] = (u8)piece_y[0];
  telem[12] = piece_x[1];   telem[13] = (u8)piece_y[1];
  telem[14] = (u8)hiscore;  telem[15] = (u8)(hiscore >> 8);
  telem[16] = garb_rows[0]; telem[17] = garb_rows[1];
  telem[18] = (u8)(piece_col[0][0] | (piece_col[0][1] << 2) | (piece_col[0][2] << 4));
  telem[19] = (u8)(piece_col[1][0] | (piece_col[1][1] << 2) | (piece_col[1][2] << 4));
  telem[20] = (u8)((u16)grid); telem[21] = (u8)((u16)grid >> 8);
  telem[22] = (u8)cleared_total; telem[23] = (u8)(cleared_total >> 8);
}

int main(void) {
  u16 pad, newp;
  u8 i;

  /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
   * Init order: console text pointers FIRST, then mode, then VRAM uploads
   * while the screen is still off (forced blank = unrestricted VRAM access;
   * once the screen is on, only the vblank DMA path below may touch VRAM).
   * consoleInitText DMAs the font but does NOT set the PPU BG base registers
   * — point BG1 at the same font/map yourself. */
  consoleSetTextMapPtr(0x6800);
  consoleSetTextGfxPtr(0x3000);
  consoleSetTextOffset(0x0000);
  consoleInitText(0, 16 * 2, &tilfont, &palfont);
  setMode(BG_MODE1, 0);
  bgSetGfxPtr(0, 0x3000);
  bgSetMapPtr(0, 0x6800, SC_32x32);

  /* BG2 = the board layer: 8-tile set → VRAM $2000, palette → CGRAM block 1
   * (map entries carry MAP_PAL1 so the console font palette in block 0 stays
   * untouched), shadow map → VRAM $4000. */
  bgInitTileSet(1, (u8 *)&tilboard, (u8 *)&palboard, 1,
                256, 32, BG_16COLORS, 0x2000);
  paint_title_map();
  bgInitMapSet(1, (u8 *)board_map, sizeof(board_map), SC_32x32, 0x4000);
  bgSetEnable(1);
  bgSetDisable(2);                  /* BG3 carries garbage in mode 1 */
  setPaletteColor(0, RGB5(2, 2, 6));     /* backdrop: near-black indigo */

  /* OBJ: the SAME 8 board tiles → OBJ base $6000 + palette → OBJ pal 0, so
   * falling jewels match locked jewels exactly. 8x8 sprites (OBJ_SIZE8_L16,
   * size bit stays small). */
  oamInitGfxSet((u8 *)&tilboard, 256, (u8 *)&palboard, 32, 0, 0x6000,
                OBJ_SIZE8_L16);
  for (i = 0; i < 6; i++) oamSet((u8)(i << 2), 0, 240, 3, 0, 0, 0, 0);

  setScreenOn();

  /* ── HARDWARE IDIOM (load-bearing) — sfx_init AFTER setScreenOn, and CHECK
   * the return: a wedged SPC700 must not take the video down with it. ── */
  sound_ok = (sfx_init() == 0);
  /* ── HARDWARE IDIOM (load-bearing) — one frame between init and the first
   * command. sfx_init returns the instant the SPC echoes the jump command,
   * but the driver then spends ~50 port writes initialising the DSP BEFORE
   * it seeds its command edge-detector from $2140. Send a command in that
   * window and the seed swallows it — music silently never starts. A
   * WaitForVBlank is thousands of SPC cycles — deterministic cure. ── */
  WaitForVBlank();
  if (sound_ok) sfx_music_play();

  hiscore = hi_load();              /* battery SRAM — 0 on first boot */
  title_enter();

  while (1) {
    pad = padsCurrent(0);
    newp = pad & (u16)~prev_pad0;
    prev_pad0 = pad;

    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: A/START = 1P, B = 2P versus; the jewel
       * stripe cycles its hues (board_map is live every frame — free juice) */
      if ((frames & 31) == 0) paint_title_stripe((u8)(frames >> 5));
      if (newp & (KEY_A | KEY_START)) start_game(0);
      else if (newp & KEY_B) start_game(1);
    } else if (state == ST_PLAY) {
      /* ── GAME LOGIC (clay — reshape freely) ── */
      update_player(0);
      if (two_player && state == ST_PLAY) update_player(1);
      if (board_dirty[0]) { paint_board(0); board_dirty[0] = 0; }
      if (board_dirty[1]) { paint_board(1); board_dirty[1] = 0; }
    } else { /* ST_OVER — boards stay frozen on screen */
      if (newp & (KEY_START | KEY_A)) title_enter();
    }

    stage_pieces();                 /* sprites staged BEFORE the vblank wait */
    telem_update();
    frames++;
    oamUpdate();

    WaitForVBlank();
    /* vblank-only writes — FIRST after the wait: the full-board DMA (see the
     * shadow-map idiom above + the NES-contrast note in the header). */
    dmaCopyVram((u8 *)board_map, 0x4000, sizeof(board_map));
    consoleVblank();
  }
  return 0;
}
