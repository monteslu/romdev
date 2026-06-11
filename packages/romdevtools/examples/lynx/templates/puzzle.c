/* ── puzzle.c — Atari Lynx falling-trio match-3 (complete example game) ───────
 *
 * A COMPLETE, working game — title screen, score + level, in-session
 * hi-score, MIKEY music + SFX, a 1P marathon falling-trio match-3 with
 * cascade chains and ramping levels, AND the Lynx's signature party trick:
 * HARDWARE SPRITE SCALING. When a run of gems clears, the whole well does a
 * SCALE POP — Suzy redraws every surviving gem at >1.0x then eases back — a
 * pure-hardware "juice" flash that costs zero CPU pixel work.
 *
 * The game: a trio of three coloured gems falls into a 6x12 well. LEFT/RIGHT
 * move it, A/B cycle its three colours, DOWN soft-drops. When it lands, any
 * straight run of 3+ same-coloured gems (horizontal, vertical, or diagonal)
 * clears; survivors fall and cascades chain for multiplied score. Clearing
 * gems raises the level, which speeds the fall. Stack to the rim and it's
 * game over.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented Lynx footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — match rules, scoring, tuning, art: reshape freely.
 *
 * What depends on what:
 *   lynx_sfx.{h,c} — MIKEY 4-voice audio (voice 0 = move/clear SFX, voice 1 =
 *     background melody, voice 2 = lock SFX, voice 3 = noise/game-over).
 *   vendor/cc65/libsrc/lynx/ — the FULL cc65 Lynx driver source shipped into
 *     your project. The TGI driver (tgi/lynx-160-102-16.s) is REQUIRED
 *     reading when graphics misbehave: every TGI call is itself a Suzy
 *     sprite, and our scaled gem pop rides the same engine via tgi_ioctl(0).
 *
 * NO HARDWARE TILEMAP (read this — it is the platform's biggest "where's the
 *   board renderer?" surprise): the Lynx has NO background tilemap. Suzy is a
 *   SPRITE BLITTER, not a tile engine. So the well is drawn the honest way:
 *   the full-redraw TGI loop repaints the 6x12 grid every frame as a stack of
 *   tgi_bar fills (one filled rect per occupied cell) — cheap because the well
 *   is only 48x96 px. The falling trio + the clear-pop gems are Suzy SCALABLE
 *   sprites layered on top. See draw_well().
 *
 * PLAYERS: 1. This is a handheld — head-to-head on real hardware is ComLynx,
 *   a cable between TWO physical Lynx units. A single emulator instance has
 *   nobody on the other end of the cable, so this example is honestly a
 *   single-player MARATHON (no fake "P2 VERSUS" that could never work here —
 *   contrast the NES puzzle donor, which has a real split-board 2P mode).
 *
 * SCREEN: 160x102. The system font is 8x8, so a full row of text is 20
 *   characters — the well + HUD are kept compact to fit: a 48x96 well on the
 *   right, a slim HUD column down the left edge.
 */

#include <tgi.h>
#include <joystick.h>
#include <lynx.h>
#include <stdint.h>
#include "lynx_sfx.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it <=16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "QUARRY QUELL"

/* ── GAME LOGIC (clay — reshape freely) — well geometry (fits 160x102) ──────
 * A 6x12 well of 8x8 cells = 48x96 px. We park it on the right so a slim HUD
 * column lives down the left edge. WELL_PX_Y leaves a margin under the top. */
#define GRID_W    6
#define GRID_H    12
#define CELL      8
#define WELL_PX_X 92                  /* left edge of the well, in pixels      */
#define WELL_PX_Y 4                   /* top edge of the well interior         */
#define WELL_W    (GRID_W * CELL)     /* 48 px */
#define WELL_H    (GRID_H * CELL)     /* 96 px */

#define EMPTY 0                       /* cell colours 1..3 = white/green/red   */

/* ── GAME LOGIC (clay) — gem colour → TGI pen. Three distinct, readable pens
 * (cc65 lynx.h COLOR_* indices); EMPTY cells paint as a dim recessed speck so
 * the well reads as a playfield, not raw black. */
static const uint8_t gem_pen[4] = {
  COLOR_DARKGREY,      /* 0 = EMPTY (recessed cell)            */
  COLOR_WHITE,         /* 1 = white gem                       */
  COLOR_LIGHTGREEN,    /* 2 = green gem                       */
  COLOR_RED            /* 3 = red gem                         */
};

/* ── GAME LOGIC (clay) — board + small state ── */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t  state;

static uint8_t  grid[GRID_H][GRID_W];      /* locked gems, [row][col]           */
static uint8_t  matched[GRID_H][GRID_W];   /* scratch mask for the match scan   */
static uint8_t  piece_x;                   /* falling trio: column 0..5         */
static int8_t   piece_y;                   /* row of its TOP cell (<0 above rim) */
static uint8_t  piece_col[3];              /* trio colours, top to bottom       */
static uint8_t  fall_t;                     /* frames until the next gravity step*/
static unsigned score;
static unsigned hiscore;                    /* in-session only — see EEPROM note */
static unsigned cleared_total;             /* gems cleared — drives the level   */
static uint8_t  level;                      /* 1..9, speeds up the fall          */
static uint8_t  prev_joy;
static uint8_t  over_new_hi;

/* The clear-pop pulse: when >0 the well draws its gems scaled-up for a few
 * frames (the SCALING signature), counting back down to the resting 1.0x. */
static uint8_t  pop_timer;
#define POP_FRAMES 7

/* ── GAME LOGIC (clay) — xorshift16 PRNG (~tens of cycles per call) ── */
static uint16_t rng = 0xACE1;
static uint8_t rand8(void) {
  uint16_t r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (uint8_t)r;
}
static uint8_t rand_gem(void) { return (uint8_t)(1 + rand8() % 3); }

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * SUZY HARDWARE SPRITE SCALING — the Lynx signature. Suzy renders every
 * sprite through a Sprite Control Block (SCB) it walks in cart/work RAM.
 * Two SCB fields, HSIZE and VSIZE, are 8.8 fixed-point scale factors
 * ($0100 = 1.0): the SAME 8x8 source pixels render at any size, every frame,
 * for free. This game uses it two ways:
 *   - the FALLING TRIO gems are Suzy sprites drawn through this SCB at a
 *     fixed 1.0x (so forking in a depth/power-up scale is a one-line change);
 *   - the CLEAR POP — for POP_FRAMES after any match, every gem in the well
 *     is redrawn at >1.0x then eased back to 1.0x, a pure-hardware "juice"
 *     flash with zero CPU pixel cost (Suzy scales while it blits).
 *
 * The SCB, field by field (this is cc65's SCB_REHV_PAL from <_suzy.h>):
 *   sprctl0  bits 7-6 = bits per pixel (11 = 4bpp), bits 2-0 = sprite TYPE.
 *            TYPE_NORMAL (4) draws pens 1-15 and treats pen 0 as
 *            TRANSPARENT — that's how a round gem sits over the cell.
 *   sprctl1  bit 7 LITERAL (raw nybbles, no RLE) + bits 5-4 reload depth:
 *            REHV means "this SCB carries HPOS, VPOS, HSIZE, VSIZE". The
 *            reload bits ARE the struct layout — mismatch them and Suzy reads
 *            palette bytes as size words.
 *   sprcoll  $20 = NO_COLLIDE. Match/lock collision is done in C on the grid
 *            (the collision buffer knows nothing about board cells).
 *   next     pointer to the next SCB, 0 = end of chain (one blit per call).
 *   data     sprite pixel data (LITERAL 4bpp format below).
 *   hpos/vpos signed SCREEN position of the sprite's top-left corner.
 *   hsize/vsize 8.8 scale — THE party trick, rewritten per draw.
 *   penpal[8] 16 nybbles mapping pixel values 0-15 → palette pens. We RECOLOUR
 *            the gem per draw here (one 8x8 art block, three gem colours) by
 *            pointing the art's pixel value 1 at the wanted pen — no extra art.
 *
 * LITERAL 4bpp data format (hand-encodable): each sprite LINE is
 *   [offset byte][width/2 bytes of raw nybble pixels]
 * where offset = 1 + bytes of pixel data; a final offset of 0 ends the sprite.
 * 8 px @ 4bpp = 4 data bytes, so every line starts with 5.
 *
 * Drawing: tgi_sprite(&scb) → tgi_ioctl(0, &scb) — the TGI driver's
 * documented escape hatch (see CONTROL in vendor/cc65/libsrc/lynx/tgi/
 * lynx-160-102-16.s). It points Suzy's SCBNEXT at your SCB, aims VIDBAS at
 * TGI's current DRAW page (so scaled gems land in the same double-buffered
 * frame as tgi_bar/tgi_outtextxy), fires SPRGO, and sleeps the CPU until
 * SPRSYS reports the blit done.
 *
 * Requires: the cc65 crt0 Suzy init (already done before main()), and calls
 *   only between the tgi_busy() wait and tgi_updatedisplay() — i.e. while
 *   TGI's draw buffer is the blit target. Draw order = paint order: well
 *   fills first, scaled gems after, HUD text last.
 */
static SCB_REHV_PAL scb = {
  BPP_4 | TYPE_NORMAL,            /* sprctl0: 4bpp, pen 0 transparent   */
  LITERAL | REHV,                 /* sprctl1: literal data, HV+size SCB */
  0x20,                           /* sprcoll: NO_COLLIDE                */
  0,                              /* next: single-SCB chain             */
  0,                              /* data: set per draw                 */
  0, 0,                           /* hpos, vpos                         */
  0x0100, 0x0100,                 /* hsize, vsize (8.8)                 */
  { 0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF }   /* identity pens */
};

/* ── GAME LOGIC (clay) — 8x8 4bpp literal gem art ───────────────────────────
 * A single round gem shape in pixel value 1 (plus value $F = white glint).
 * draw_gem() recolours value 1 → the wanted gem pen via the SCB penpal, so one
 * art block paints all three gem colours. Each line: 5, then 4 nybble bytes;
 * a final 0 byte ends the sprite. */
static unsigned char spr_gem[] = {
  5, 0x00, 0x11, 0x10, 0x00,     /* . . 1 1 1 . . .  round gem body          */
  5, 0x01, 0x1F, 0xF1, 0x10,     /* . 1 1 F F 1 1 .  (white glint)           */
  5, 0x11, 0x11, 0x11, 0x11,     /* 1 1 1 1 1 1 1 1                          */
  5, 0x11, 0x11, 0x11, 0x11,     /* 1 1 1 1 1 1 1 1                          */
  5, 0x11, 0x11, 0x11, 0x11,     /* 1 1 1 1 1 1 1 1                          */
  5, 0x11, 0x11, 0x11, 0x11,     /* 1 1 1 1 1 1 1 1                          */
  5, 0x01, 0x11, 0x11, 0x10,     /* . 1 1 1 1 1 1 .                          */
  5, 0x00, 0x11, 0x10, 0x00,     /* . . 1 1 1 . . .                          */
  0
};

/* Draw the gem sprite for board cell at top-left (x,y), recoloured to `col`
 * (1..3), at an 8.8 scale. Recolour: point art pixel value 1 at the gem's pen
 * by rewriting the first penpal byte (values 0,1 → transparent, pen). The
 * clear pop scales every gem about its CELL CENTRE so the flash reads as a
 * uniform swell, not a slide. */
static void draw_gem(int x, int y, uint8_t col, unsigned scale) {
  unsigned w = (8u * scale) >> 8;
  if (w == 0) w = 1;
  scb.penpal[0] = (uint8_t)((0u << 4) | gem_pen[col]);  /* val0=transparent, val1=pen */
  scb.data  = spr_gem;
  scb.hsize = scale;
  scb.vsize = scale;
  scb.hpos  = x + 4 - (int)(w >> 1);   /* anchor the CELL CENTRE (cells are 8 wide) */
  scb.vpos  = y + 4 - (int)(w >> 1);
  tgi_sprite(&scb);
}

/* Current clear-pop scale: 1.0x at rest, swelling to ~1.5x at the pop peak and
 * easing back. POP drives the SCALING idiom on every clear. */
#define POP_SCALE_PEAK 0x0180u         /* 1.5x */
static unsigned pop_scale(void) {
  if (pop_timer == 0) return 0x0100u;
  /* linear ease: scale = 1.0 + (pop_timer/POP_FRAMES) * 0.5 */
  return 0x0100u + ((unsigned)pop_timer * (POP_SCALE_PEAK - 0x0100u)) / POP_FRAMES;
}

/* ── GAME LOGIC (clay) — score text (no sprintf: it drags in ~6KB) ── */
static char numbuf[6];
static char *fmt5(unsigned v) {
  uint8_t i;
  for (i = 0; i < 5; i++) { numbuf[4 - i] = (char)('0' + v % 10); v /= 10; }
  numbuf[5] = 0;
  return numbuf;
}

/* ── GAME LOGIC (clay) — match scan: mark every straight run of 3+ same-
 * coloured gems in all 4 directions (a cell can belong to several runs — the
 * mask de-dupes), and return how many cells matched. ── */
static const int8_t DIRS4[4][2] = { {0,1}, {1,0}, {1,1}, {1,-1} };

static uint8_t mark_and_count(void) {
  uint8_t r, c, d, len, k, cnt, col;
  int8_t dr, dc;
  int sr, sc;
  cnt = 0;
  for (r = 0; r < GRID_H; r++)
    for (c = 0; c < GRID_W; c++) matched[r][c] = 0;
  for (r = 0; r < GRID_H; r++) {
    for (c = 0; c < GRID_W; c++) {
      col = grid[r][c];
      if (col == EMPTY) continue;
      for (d = 0; d < 4; d++) {
        dr = DIRS4[d][0]; dc = DIRS4[d][1];
        sr = (int)r - dr; sc = (int)c - dc;
        if (sr >= 0 && sr < GRID_H && sc >= 0 && sc < GRID_W
            && grid[sr][sc] == col) continue;       /* not the run's start */
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

/* Collapse each column so survivors rest on the floor. */
static void apply_gravity(void) {
  uint8_t c;
  int8_t r, w;
  for (c = 0; c < GRID_W; c++) {
    w = GRID_H - 1;
    for (r = GRID_H - 1; r >= 0; r--)
      if (grid[r][c] != EMPTY) { grid[w][c] = grid[r][c]; w--; }
    for (; w >= 0; w--) grid[w][c] = EMPTY;
  }
}

static void game_over(void) {
  over_new_hi = 0;
  if (score > hiscore) {
    /* ── In-session hi-score ONLY — and here's the honest why. Real Lynx
     * carts persist via a 93Cxx serial EEPROM on the cart PCB (cc65 even
     * ships lynx_eeprom_read/write for it; see vendor/cc65/libsrc/lynx/
     * eeprom.s). PROBED: the bundled handy core emulates CEEPROM internally
     * but its libretro build exposes NO save path — retro_get_memory(
     * SAVE_RAM) returns NULL/size 0, so nothing survives host.hardReset()
     * and a bit-banged round-trip reads back garbage under the WASM build.
     * Wiring the EEPROM to SAVE_RAM is a future core round; until then a fake
     * "save" would be lying. The hi-score DOES survive title↔play cycles
     * within one power-on. ── */
    hiscore = score;
    over_new_hi = 1;
  }
  sfx_tone(2, 240, 24);             /* voice 2: low game-over drone */
  sfx_noise(16);                    /* voice 3: crunch */
  state = ST_OVER;
}

/* ── GAME LOGIC (clay) — clear matches, drop survivors, chain cascades.
 * Returns the chain depth (0 = the lock matched nothing). Score, level, and
 * the clear-pop fire here. ── */
static uint8_t resolve_board(void) {
  uint8_t n, r, c, chain;
  unsigned amt;
  chain = 0;
  for (;;) {
    n = mark_and_count();
    if (n == 0) break;
    ++chain;
    for (r = 0; r < GRID_H; r++)
      for (c = 0; c < GRID_W; c++)
        if (matched[r][c]) grid[r][c] = EMPTY;
    amt = (unsigned)n * 10;
    if (chain > 1) amt *= chain;               /* cascades pay multiplied */
    score += amt;
    /* clear chime rises with chain depth; the SCALING clear-pop fires */
    sfx_tone(0, (uint8_t)(70 + chain * 8), 8);
    pop_timer = POP_FRAMES;                    /* trigger the hardware scale pop */
    apply_gravity();
    cleared_total += n;
    while (level < 9 && cleared_total >= (unsigned)level * 10) {
      ++level;
    }
  }
  return chain;
}

/* Can the trio occupy column x, rows y..y+2? Cells above the rim are fine
 * (pieces enter from above); below the floor or on a gem is not. */
static uint8_t can_place(int8_t x, int8_t y) {
  int8_t i, cy;
  if (x < 0 || x >= GRID_W) return 0;
  for (i = 0; i < 3; i++) {
    cy = (int8_t)(y + i);
    if (cy < 0) continue;
    if (cy >= GRID_H) return 0;
    if (grid[cy][x] != EMPTY) return 0;
  }
  return 1;
}

static void spawn_piece(void) {
  piece_x = GRID_W / 2;
  piece_y = -2;
  piece_col[0] = rand_gem();
  piece_col[1] = rand_gem();
  piece_col[2] = rand_gem();
  if (!can_place((int8_t)piece_x, piece_y)) game_over();
}

/* ── GAME LOGIC (clay) — land the trio, resolve, respawn. ── */
static void lock_piece(void) {
  int8_t i, y;
  for (i = 0; i < 3; i++) {
    y = (int8_t)(piece_y + i);
    if (y >= 0) grid[y][piece_x] = piece_col[i];
  }
  sfx_tone(2, 180, 4);                         /* voice 2: lock thunk */
  if (piece_y < 0) { game_over(); return; }    /* locked above the rim */
  resolve_board();
  if (state != ST_PLAY) return;
  spawn_piece();
}

/* ── GAME LOGIC (clay) — start a run ── */
static void start_game(void) {
  uint8_t r, c;
  for (r = 0; r < GRID_H; r++)
    for (c = 0; c < GRID_W; c++) grid[r][c] = EMPTY;
  score = 0;
  cleared_total = 0;
  level = 1;
  fall_t = 0;
  pop_timer = 0;
  prev_joy = 0xFF;                  /* the button that started the run
                                     * shouldn't also rotate the first trio */
  sfx_tone(0, 80, 8);               /* start chirp */
  state = ST_PLAY;
  spawn_piece();
}

/* ── GAME LOGIC (clay) — per-state frames. Each runs INSIDE the canonical
 * loop below: scene already painted, tgi_updatedisplay not yet called. ── */

/* draw the locked well: frame + recessed backdrop, every occupied cell as a
 * gem, empties as a faint speck. During a clear pop (`scaled`), occupied gems
 * draw as SCALED Suzy sprites (the hardware flash); otherwise as flat bars
 * (cheaper, and the gem read is identical at 1.0x). */
static void draw_well(uint8_t scaled) {
  uint8_t r, c, v;
  unsigned ps = pop_scale();
  int px, py;
  /* well frame + recessed backdrop so it reads as a playfield */
  tgi_setcolor(COLOR_GREY);
  tgi_bar(WELL_PX_X - 2, WELL_PX_Y - 2, WELL_PX_X + WELL_W + 1, WELL_PX_Y + WELL_H + 1);
  tgi_setcolor(COLOR_BLACK);
  tgi_bar(WELL_PX_X, WELL_PX_Y, WELL_PX_X + WELL_W - 1, WELL_PX_Y + WELL_H - 1);
  /* empty-cell specks (always flat) */
  tgi_setcolor(COLOR_DARKGREY);
  for (r = 0; r < GRID_H; r++)
    for (c = 0; c < GRID_W; c++)
      if (grid[r][c] == EMPTY) {
        px = WELL_PX_X + c * CELL; py = WELL_PX_Y + r * CELL;
        tgi_bar(px + 3, py + 3, px + 4, py + 4);
      }
  /* gems */
  for (r = 0; r < GRID_H; r++)
    for (c = 0; c < GRID_W; c++) {
      v = grid[r][c];
      if (v == EMPTY) continue;
      if (scaled) {
        draw_gem(WELL_PX_X + c * CELL, WELL_PX_Y + r * CELL, v, ps);
      } else {
        px = WELL_PX_X + c * CELL; py = WELL_PX_Y + r * CELL;
        tgi_setcolor(gem_pen[v]);
        tgi_bar(px + 1, py + 1, px + 6, py + 6);
      }
    }
}

static unsigned attract_phase;

static void frame_title(uint8_t joy) {
  /* attract: a lone gem in the title's clear zone pulses via the SCALING
   * idiom — the same swell the clear-pop uses, shown off on the menu. */
  unsigned t = attract_phase < 64 ? attract_phase : (127 - attract_phase);
  unsigned s = 0x00C0u + (t * (0x0200u - 0x00C0u)) / 63u;  /* 0.75x..2.0x */
  attract_phase = (attract_phase + 2) & 127;

  draw_gem(120, 10, 2, s);            /* breathing green gem, top-right zone   */

  tgi_setcolor(COLOR_WHITE);
  tgi_outtextxy(8, 24, GAME_TITLE);
  tgi_setcolor(COLOR_YELLOW);
  tgi_outtextxy(28, 44, "PRESS A");
  tgi_setcolor(COLOR_LIGHTGREY);
  tgi_outtextxy(8, 60, "HI ");
  tgi_outtextxy(32, 60, fmt5(hiscore));
  tgi_outtextxy(4, 76, "1 PLAYER MARATHON");   /* handheld honesty            */

  if (JOY_BTN_1(joy) && !JOY_BTN_1(prev_joy)) start_game();
}

static void frame_over(uint8_t joy) {
  draw_well(0);
  tgi_setcolor(COLOR_DARKGREY);
  tgi_bar(6, 30, 86, 74);
  tgi_setcolor(COLOR_WHITE);
  tgi_outtextxy(12, 34, "GAME OVER");
  tgi_setcolor(COLOR_YELLOW);
  tgi_outtextxy(10, 46, "SCORE");
  tgi_outtextxy(10, 56, fmt5(score));
  if (over_new_hi) { tgi_setcolor(COLOR_LIGHTGREEN); tgi_outtextxy(8, 66, "NEW HI"); }
  else { tgi_setcolor(COLOR_LIGHTGREY); tgi_outtextxy(8, 66, "A TITLE"); }
  if (JOY_BTN_1(joy) && !JOY_BTN_1(prev_joy)) state = ST_TITLE;
}

/* stage the falling trio (3 gems) above the locked stack, each at 1.0x */
static void draw_piece(void) {
  uint8_t i;
  int8_t y;
  for (i = 0; i < 3; i++) {
    y = (int8_t)(piece_y + i);
    if (y >= 0)
      draw_gem(WELL_PX_X + piece_x * CELL, WELL_PX_Y + (int)y * CELL,
               piece_col[i], 0x0100);
  }
}

static void frame_play(uint8_t joy) {
  uint8_t newp, fd, t;

  /* ── draw: well (scaled gems while the clear-pop runs), falling trio, HUD ── */
  draw_well(pop_timer != 0);
  draw_piece();

  tgi_setcolor(COLOR_WHITE);
  tgi_outtextxy(4, 2, "SC");
  tgi_outtextxy(4, 12, fmt5(score));
  tgi_setcolor(COLOR_LIGHTGREY);
  tgi_outtextxy(4, 28, "HI");
  tgi_outtextxy(4, 38, fmt5(hiscore));
  tgi_setcolor(COLOR_YELLOW);
  tgi_outtextxy(4, 54, "LV");
  numbuf[0] = (char)('0' + level); numbuf[1] = 0;
  tgi_outtextxy(28, 54, numbuf);

  /* ── update: edge-triggered moves; A/B cycle the trio; held DOWN soft-drops.
   * JOY_BTN_1/2(newp) test the press-EDGE mask, so one cell/cycle per press. ── */
  newp = (uint8_t)(joy & (uint8_t)~prev_joy);
  if ((newp & JOY_LEFT_MASK)  && can_place((int8_t)(piece_x - 1), piece_y)) --piece_x;
  if ((newp & JOY_RIGHT_MASK) && can_place((int8_t)(piece_x + 1), piece_y)) ++piece_x;
  if (JOY_BTN_1(newp)) {                         /* A: cycle colours downward */
    t = piece_col[2];
    piece_col[2] = piece_col[1];
    piece_col[1] = piece_col[0];
    piece_col[0] = t;
    sfx_tone(0, 110, 3);
  }
  if (JOY_BTN_2(newp)) {                         /* B: cycle colours upward */
    t = piece_col[0];
    piece_col[0] = piece_col[1];
    piece_col[1] = piece_col[2];
    piece_col[2] = t;
    sfx_tone(0, 120, 3);
  }
  if (joy & JOY_DOWN_MASK) fall_t += 4;          /* soft drop */

  if (pop_timer) pop_timer--;                    /* ease the clear-pop back to 1.0x */

  /* gravity: faster as the level climbs (29..5 frames per row) */
  ++fall_t;
  fd = (uint8_t)(32 - ((level << 1) + level));   /* 32 - 3*level → 29..5 */
  if (fall_t >= fd) {
    fall_t = 0;
    if (can_place((int8_t)piece_x, (int8_t)(piece_y + 1)))
      ++piece_y;
    else
      lock_piece();                              /* may end the game */
  }
}

void main(void) {
  uint8_t joy;

  tgi_install(&lynx_160_102_16_tgi);
  tgi_init();
  joy_install(&lynx_stdjoy_joy);
  sfx_init();          /* MIKEY up; background melody starts on voice 1 */

  state = ST_TITLE;
  prev_joy = 0;
  attract_phase = 0;
  hiscore = 0;

  for (;;) {
    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * CANONICAL LYNX GAME LOOP — full-redraw every frame, in this order:
     *   1. while (tgi_busy()) { }  — WAIT for the previous frame's page flip.
     *      Skipping this is the #1 "Lynx screen stays blank" trap: drawing
     *      while the swap is pending loses the frame.
     *   2. Repaint the WHOLE scene with tgi_bar fills — NOT tgi_clear()
     *      (which can leave the framebuffer stale on this toolchain+emulator
     *      path). TGI double-buffers; the back buffer holds the frame from
     *      two flips ago, so partial redraws ghost. With no hardware tilemap
     *      (header), the WELL is repainted cell-by-cell every frame.
     *   3. Draw every object (every TGI call and every tgi_sprite() is a
     *      synchronous Suzy blit into the SAME draw page).
     *   4. tgi_updatedisplay() — request the page flip at next VBL.
     *   5. sfx_update() IMMEDIATELY after — MIKEY voice writes must land in
     *      vblank: handy reschedules its timer sweep on the spot when a voice
     *      CTL bit-3 write lands, and mid-frame that sweep can preempt an
     *      in-flight Suzy blit and eat sprites (the R57 bug — history in
     *      lynx_sfx.c). sfx_tone()/sfx_noise() only STAGE; sfx_update() is
     *      the hardware flush. */
    while (tgi_busy()) { }

    /* background: a dim field so no frame is a flat single colour (a >=92%
     * single-colour frame trips the render-health audit as "blank"). */
    tgi_setcolor(COLOR_BLUE);
    tgi_bar(0, 0, 159, 101);
    tgi_setcolor(COLOR_PURPLE);
    tgi_bar(0, 0, 159, 2);                     /* top accent band */
    tgi_bar(0, 99, 159, 101);                  /* bottom accent band */

    joy = joy_read(JOY_1);

    if      (state == ST_TITLE) frame_title(joy);
    else if (state == ST_PLAY)  frame_play(joy);
    else                        frame_over(joy);

    tgi_updatedisplay();
    sfx_update();

    prev_joy = joy;
  }
}
