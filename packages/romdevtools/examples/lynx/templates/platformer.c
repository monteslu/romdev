/* ── platformer.c — Atari Lynx side-scrolling platformer (complete example) ───
 *
 * A COMPLETE, working game — title screen, lives + score, in-session
 * hi-score, MIKEY music + SFX, gravity/jump physics, one-way platforms,
 * pits, spikes, coins, a scrolling level, AND the Lynx's signature party
 * trick: HARDWARE SPRITE SCALING. The hero is a Suzy-scaled sprite, and
 * collectible GEMS breathe (pulse big↔small) every frame purely by
 * rewriting two 8.8 fixed-point fields in a Sprite Control Block — no CPU
 * pixel work at all. That pulse is the bait: the bigger the gem reads, the
 * easier it is to grab, and the hardware does every frame of the animation.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented Lynx footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — level layout, physics tuning, scoring, art: reshape
 *     freely.
 *
 * What depends on what:
 *   lynx_sfx.{h,c} — MIKEY 4-voice audio (voice 0 = jump/coin SFX, voice 1 =
 *     background melody, voice 2 = land/hurt SFX, voice 3 = noise/death).
 *   vendor/cc65/libsrc/lynx/ — the FULL cc65 Lynx driver source shipped into
 *     your project. The TGI driver (tgi/lynx-160-102-16.s) is REQUIRED
 *     reading when graphics misbehave: every TGI call is itself a Suzy
 *     sprite, and our scaled sprites ride the same engine via tgi_ioctl(0).
 *
 * SCROLLING ON THE LYNX (read this — it is the platform's biggest "where's
 *   the hardware feature?" surprise): the Lynx has NO hardware tilemap and NO
 *   background scroll register. Suzy is a SPRITE BLITTER, not a tile engine.
 *   So we scroll the level the honest way: keep a software camera (cam_x) and
 *   REDRAW the visible slice of the world every frame, painting each ground/
 *   platform column at its on-screen position (world_x - cam_x). The full-
 *   redraw TGI loop (below) makes that cheap enough — the whole 160-px window
 *   is a handful of tgi_bar fills. The camera is one-way (never scrolls back),
 *   the classic runner camera. See draw_level().
 *
 * PLAYERS: 1. This is a handheld — multiplayer on real hardware is ComLynx,
 *   a cable between TWO Lynx units. A single emulator instance has nobody on
 *   the other end of the cable, so this example is honestly single-player
 *   (no fake "P2" that could never work).
 *
 * SCREEN: 160x102. The system font is 8x8, so a full row of text is 20
 *   characters — keep the HUD line short and the layout compact.
 */

#include <tgi.h>
#include <joystick.h>
#include <lynx.h>
#include <stdint.h>
#include "lynx_sfx.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it <=16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "RIDGE ROMP"

/* ── GAME LOGIC (clay — reshape freely) — screen + world geometry ─────────── */
#define SCRW         160
#define SCRH         102
#define HUD_H        9                  /* HUD bar height (keep it compact)   */
#define GROUND_Y     90                 /* default ground surface (screen Y)  */
#define PLAYER_W     8                  /* art is 8x8; SCALE keeps that 1:1   */

/* The level is a column map, 8 px per column. world_x of column c = c*8.
 *   ground_y[c] — screen-Y of the ground surface, 0xFF = pit (no floor).
 *   plat_y[c]   — screen-Y of a one-way floating platform, 0 = none.
 * COL_COUNT columns × 8 px = the level length; the run loops when the camera
 * passes the end (we wrap cam_x back to 0 — the seam is a flat runway). */
#define NO_GROUND 0xFF
#define COL_COUNT 48                    /* 48 * 8 = 384 px of level           */
static const uint8_t ground_y[COL_COUNT] = {
  90, 90, 90, 90, 90, 90,                         /* start runway            */
  90, 90, NO_GROUND, NO_GROUND, 90, 90,           /* pit 1 (16 px)           */
  82, 82, 82, 90, 90, 90,                          /* a raised step          */
  90, NO_GROUND, NO_GROUND, NO_GROUND, 90, 90,    /* pit 2 (24 px)           */
  90, 90, 74, 74, 74, 90,                          /* high mesa               */
  90, 90, 90, NO_GROUND, NO_GROUND, 90,           /* pit 3 (16 px)           */
  90, 90, 90, 90, 90, 90,
  90, 90, 90, 90, 90, 90,                          /* end runway (loop seam)  */
};
static const uint8_t plat_y[COL_COUNT] = {
  0, 0, 0, 0, 70, 70,                              /* slab over start         */
  0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 58, 58,                              /* high slab               */
  58, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0,
  0, 0, 64, 64, 64, 0,                             /* slab across pit 3       */
  0, 0, 0, 0, 0, 0,
  0, 0, 70, 70, 0, 0,
};

/* ── GAME LOGIC (clay) — physics tuning (all Q4.4: 16 = 1.0 px) ───────────── */
#define GRAVITY_Q44     6               /* +0.375 px/frame/frame              */
#define JUMP_VEL_Q44 (-58)              /* launch vy → ~7 px apex, ~6 tiles   */
#define MAX_VY_Q44     56               /* terminal fall = 3.5 px/frame —     *
                                         * MUST stay under 4: the landing     *
                                         * window is 4 px (tunnelling else)   */
#define MOVE_SPEED      2               /* px/frame walk + scroll speed       */
#define SCROLL_WALL    72               /* past this the world scrolls (cam)  */
#define START_LIVES     3
#define N_COINS         3
#define N_SPIKES        2
#define N_GEMS          2               /* the SCALING collectibles           */

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * SUZY HARDWARE SPRITE SCALING — the Lynx signature. Suzy renders every
 * sprite through a Sprite Control Block (SCB) it walks in cart/work RAM.
 * Two SCB fields, HSIZE and VSIZE, are 8.8 fixed-point scale factors
 * ($0100 = 1.0): the SAME 8x8 source pixels render at any size, every
 * frame, for free. We use it three ways here:
 *   - the HERO renders at a fixed 1.0x via the SAME SCB path (so forking in
 *     a depth/power-up scale is a one-line change);
 *   - the GEMS breathe — HSIZE/VSIZE sweep 0.75x↔1.75x every frame, a pure
 *     hardware animation that doubles as a difficulty tell (a fat gem is an
 *     easy grab, the collision box tracks the live hardware size);
 *   - it costs zero extra CPU vs. a fixed sprite — Suzy scales while it blits.
 *
 * The SCB, field by field (this is cc65's SCB_REHV_PAL from <_suzy.h>):
 *   sprctl0  bits 7-6 = bits per pixel (11 = 4bpp), bits 2-0 = sprite TYPE.
 *            TYPE_NORMAL (4) draws pens 1-15 and treats pen 0 as
 *            TRANSPARENT — that's how shaped sprites sit over the level.
 *   sprctl1  bit 7 LITERAL (raw nybbles, no RLE) + bits 5-4 reload depth:
 *            REHV means "this SCB carries HPOS, VPOS, HSIZE, VSIZE". The
 *            reload bits ARE the struct layout — mismatch them and Suzy
 *            reads palette bytes as size words.
 *   sprcoll  $20 = NO_COLLIDE. Gameplay collision is done in C (in screen
 *            coordinates the collision buffer knows nothing about).
 *   next     pointer to the next SCB, 0 = end of chain (one blit per call).
 *   data     sprite pixel data (LITERAL 4bpp format below).
 *   hpos/vpos signed SCREEN position of the sprite's top-left corner.
 *   hsize/vsize 8.8 scale — THE party trick, rewritten per draw.
 *   penpal[8] 16 nybbles mapping pixel values 0-15 → palette pens.
 *
 * LITERAL 4bpp data format (hand-encodable): each sprite LINE is
 *   [offset byte][width/2 bytes of raw nybble pixels]
 * where offset = 1 + bytes of pixel data; a final offset of 0 ends the
 * sprite. 8 px @ 4bpp = 4 data bytes, so every line starts with 5.
 *
 * Drawing: tgi_sprite(&scb) → tgi_ioctl(0, &scb) — the TGI driver's
 * documented escape hatch (see CONTROL in vendor/cc65/libsrc/lynx/tgi/
 * lynx-160-102-16.s). It points Suzy's SCBNEXT at your SCB, aims VIDBAS at
 * TGI's current DRAW page (so scaled sprites land in the same double-
 * buffered frame as tgi_bar/tgi_outtextxy), fires SPRGO, and sleeps the CPU
 * until SPRSYS reports the blit done.
 *
 * Requires: the cc65 crt0 Suzy init (already done before main()), and calls
 *   only between the tgi_busy() wait and tgi_updatedisplay() — i.e. while
 *   TGI's draw buffer is the blit target. Draw order = paint order: level
 *   fills first, scaled sprites after, HUD text last.
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

/* Draw an 8x8 literal sprite at the given 8.8 scale, anchored at the
 * top-left (x,y). The hero stays 1.0x; gems pulse. */
static void draw_scaled(unsigned char *data, int x, int y, unsigned scale) {
  scb.data  = data;
  scb.hsize = scale;
  scb.vsize = scale;
  scb.hpos  = x;
  scb.vpos  = y;
  tgi_sprite(&scb);
}

/* ── GAME LOGIC (clay) — 8x8 4bpp literal sprite art ────────────────────────
 * Pens use the TGI default palette (cc65 lynx.h COLOR_* indices): 2 = red,
 * 9 = yellow, $D = blue, $E = light-blue, $F = white, 0 = transparent. Each
 * line: 5, then 4 nybble bytes; a final 0 byte ends the sprite. */
static unsigned char spr_hero[] = {
  5, 0x00, 0x0E, 0xE0, 0x00,     /* . . . E E . . .  cyan runner, eyes       */
  5, 0x00, 0xEF, 0xFE, 0x00,     /* . . E F F E . .                          */
  5, 0x00, 0xE9, 0x9E, 0x00,     /* . . E 9 9 E . .  (eyes)                  */
  5, 0x0E, 0xEE, 0xEE, 0xE0,     /* . E E E E E E .  body                    */
  5, 0xEE, 0xEE, 0xEE, 0xEE,     /* E E E E E E E E                          */
  5, 0x0E, 0x0E, 0xE0, 0xE0,     /* . E . E E . E .  legs                    */
  5, 0x0E, 0x00, 0x00, 0xE0,     /* . E . . . . E .                          */
  5, 0x0F, 0x00, 0x00, 0xF0,     /* . F . . . . F .  feet                    */
  0
};
static unsigned char spr_gem[] = {
  5, 0x00, 0x09, 0x90, 0x00,     /* . . . 9 9 . . .  yellow gem, white shine */
  5, 0x00, 0x9F, 0xF9, 0x00,     /* . . 9 F F 9 . .                          */
  5, 0x09, 0xFD, 0x9F, 0x90,     /* . 9 F D 9 F 9 .  (blue facet)            */
  5, 0x9F, 0x99, 0x99, 0xF9,     /* 9 F 9 9 9 9 F 9                          */
  5, 0x9F, 0x99, 0x99, 0xF9,     /* 9 F 9 9 9 9 F 9                          */
  5, 0x09, 0x99, 0x99, 0x90,     /* . 9 9 9 9 9 9 .                          */
  5, 0x00, 0x99, 0x99, 0x00,     /* . . 9 9 9 9 . .                          */
  5, 0x00, 0x09, 0x90, 0x00,     /* . . . 9 9 . . .                          */
  0
};

/* ── GAME LOGIC (clay) — gem pulse (the SCALING signature) ──────────────────
 * One shared phase drives every gem's HSIZE/VSIZE. The 8.8 scale sweeps
 * SCALE_MIN..SCALE_MAX and back; gem_scale() returns the current value and
 * gem_half() the matching on-screen half-width so the grab box tracks the
 * hardware size exactly. */
#define SCALE_MIN  0x00C0u             /* 0.75x →  6 px */
#define SCALE_MAX  0x01C0u             /* 1.75x → 14 px */
static unsigned gem_phase;             /* 0..255 triangle wave */
static unsigned gem_scale(void) {
  unsigned t = gem_phase < 128 ? gem_phase : (255 - gem_phase);  /* 0..127 */
  return SCALE_MIN + (t * (SCALE_MAX - SCALE_MIN)) / 127u;
}
static uint8_t gem_half(void) {
  return (uint8_t)((gem_scale() * 8u) >> 9);   /* (8*scale>>8)/2 */
}

typedef struct { uint8_t alive; int16_t wx; uint8_t y; } Coin;   /* world-x */
typedef struct { uint8_t alive; int16_t wx; uint8_t y; } Spike;
typedef struct { uint8_t alive; int16_t wx; uint8_t y; } Gem;

static Coin  coins[N_COINS];
static Spike spikes[N_SPIKES];
static Gem   gems[N_GEMS];

/* Player state. px is SCREEN x (camera holds it at SCROLL_WALL while
 * scrolling); world x = px + cam_x. py is Q4.4 for sub-pixel gravity. */
static uint8_t  px;
static int16_t  py_q44;
static int8_t   vy_q44;
static uint8_t  on_ground;
static unsigned cam_x;                 /* software camera (one-way) */
static uint8_t  lives;
static unsigned score, hiscore;        /* hiscore: in-session only (see below) */
static uint8_t  dist_sub;              /* 64 px scrolled = +1 distance point */
static uint8_t  hurt_timer;
static uint8_t  prev_joy;

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;
static uint8_t over_new_hi;

/* ── GAME LOGIC (clay) — Galois LFSR (taps $B8), period 255 ── */
static uint8_t rng_state = 0x5A;
static uint8_t rand8(void) {
  uint8_t lsb = (uint8_t)(rng_state & 1);
  rng_state >>= 1;
  if (lsb) rng_state ^= 0xB8;
  return rng_state;
}

/* ── GAME LOGIC (clay) — score text (no sprintf: it drags in ~6KB) ── */
static char numbuf[6];
static char *fmt5(unsigned v) {
  uint8_t i;
  for (i = 0; i < 5; i++) { numbuf[4 - i] = (char)('0' + v % 10); v /= 10; }
  numbuf[5] = 0;
  return numbuf;
}
static uint8_t udist(uint8_t a, uint8_t b) { return a > b ? a - b : b - a; }

/* ── GAME LOGIC (clay) — column-map lookups (world x → column) ──────────────
 * The level loops: world x wraps at COL_COUNT*8 so the run is endless. */
#define LEVEL_LEN ((unsigned)COL_COUNT * 8u)
static uint8_t col_of(unsigned wx) { return (uint8_t)((wx % LEVEL_LEN) >> 3); }

/* ── GAME LOGIC (clay) — draw the scrolling level (SOFTWARE camera) ─────────
 * No hardware scroll on the Lynx (see header). We paint the visible window
 * column by column: for each on-screen column, look up the world column at
 * (cam_x + screenX) and fill its ground body + grass cap + any platform
 * slab. Per-column tgi_bar fills keep the code legible — the whole strip is
 * well under the frame budget. */
static void draw_level(void) {
  int sx;
  uint8_t c, gy, pgy;
  for (sx = 0; sx < SCRW; sx += 8) {
    c  = col_of(cam_x + (unsigned)sx);
    gy = ground_y[c];
    /* ground column: grass cap (green) over a dirt body (brown) */
    if (gy != NO_GROUND) {
      tgi_setcolor(COLOR_BROWN);
      tgi_bar(sx, gy + 2, sx + 7, SCRH - 1);
      tgi_setcolor(COLOR_LIGHTGREEN);
      tgi_bar(sx, gy, sx + 7, gy + 1);
    }
    /* one-way platform slab (grey ledge) */
    pgy = plat_y[c];
    if (pgy) {
      tgi_setcolor(COLOR_GREY);
      tgi_bar(sx, pgy, sx + 7, pgy + 2);
    }
  }
}

/* ── GAME LOGIC (clay) — shared scene painter (runs every frame) ────────────
 * Full-redraw, painter's order: sky, far parallax hills, HUD bar, then the
 * caller layers the level + sprites + text on top. Layered bands keep any
 * one colour comfortably under the render-health blank threshold. */
static const unsigned char hill_x[6] = { 8, 44, 78, 112, 138, 156 };
static void draw_scene(void) {
  uint8_t i, hx;
  tgi_setcolor(COLOR_BLUE);
  tgi_bar(0, 0, SCRW - 1, SCRH - 1);                  /* sky                 */
  /* far parallax hills (drift slower than the camera → depth) */
  tgi_setcolor(COLOR_PURPLE);
  for (i = 0; i < 6; i++) {
    hx = (uint8_t)((hill_x[i] + SCRW - (uint8_t)((cam_x >> 2) % SCRW)) % SCRW);
    tgi_bar(hx, 62, (hx + 26 < SCRW ? hx + 26 : SCRW - 1), 89);
  }
  tgi_setcolor(COLOR_DARKGREY);
  tgi_bar(0, 0, SCRW - 1, HUD_H - 1);                 /* HUD bar             */
}

/* ── GAME LOGIC (clay) — place world objects across the level ── */
static void place_objects(void) {
  uint8_t i, c;
  for (i = 0; i < N_COINS; i++) {
    coins[i].alive = 1;
    coins[i].wx = (int16_t)(40 + i * 110);
    c = col_of(coins[i].wx);
    /* hover a little above the surface, with a touch of LFSR jitter so the
     * pickup arc isn't a flat line */
    coins[i].y  = (uint8_t)((ground_y[c] == NO_GROUND ? 60 : ground_y[c] - 18)
                            - (rand8() & 7));
  }
  for (i = 0; i < N_SPIKES; i++) {
    spikes[i].wx = (int16_t)(96 + i * 150);
    c = col_of(spikes[i].wx);
    spikes[i].alive = ground_y[c] != NO_GROUND;
    spikes[i].y  = (uint8_t)((ground_y[c] == NO_GROUND ? GROUND_Y : ground_y[c]) - 6);
  }
  /* gems sit higher (a reach jump) and pulse via the scaling idiom */
  for (i = 0; i < N_GEMS; i++) {
    gems[i].alive = 1;
    gems[i].wx = (int16_t)(150 + i * 130);
    gems[i].y  = (uint8_t)(48 + (i & 1) * 8);
  }
}

/* ── GAME LOGIC (clay) — start a run ── */
static void start_game(void) {
  px = 24;
  py_q44 = (int16_t)((GROUND_Y - PLAYER_W) << 4);
  vy_q44 = 0;
  on_ground = 1;
  cam_x = 0;
  dist_sub = 0;
  lives = START_LIVES;
  score = 0;
  hurt_timer = 0;
  gem_phase = 0;
  place_objects();
  sfx_tone(0, 80, 8);               /* start chirp */
  state = ST_PLAY;
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
     * Wiring the EEPROM to SAVE_RAM is a future core round; until then a
     * fake "save" would be lying. The hi-score DOES survive title↔play
     * cycles within one power-on. ── */
    hiscore = score;
    over_new_hi = 1;
  }
  sfx_tone(2, 240, 24);             /* voice 2: low game-over drone */
  sfx_noise(16);                    /* voice 3: crunch */
  state = ST_OVER;
}

/* ── GAME LOGIC (clay) — death + respawn at the run start ── */
static void lose_life(void) {
  sfx_noise(14);                    /* voice 3: splat */
  if (lives) lives--;
  if (lives == 0) { game_over(); return; }
  /* respawn at a safe runway tile, keep the camera (one-way run) */
  px = 24;
  py_q44 = (int16_t)((GROUND_Y - PLAYER_W) << 4);
  vy_q44 = 0;
  on_ground = 1;
  hurt_timer = 45;
  prev_joy = 0xFF;                  /* swallow held jump across the respawn */
}

/* ── GAME LOGIC (clay) — landing probe against the column map ───────────────
 * One-way platforms: only catch the player while FALLING through a narrow
 * 4-px window at a surface's top. Probe both columns under the 8-px-wide
 * feet so a foot half-off a ledge still lands. Returns the surface Y to snap
 * to, or 0 for "no floor here". */
static uint8_t land_top(uint8_t feet) {
  uint8_t c0, c1, gy, pgy;
  unsigned wx = cam_x + px;
  c0 = col_of(wx);
  c1 = col_of(wx + 7);
  /* platform slabs first (they sit above the ground) */
  pgy = plat_y[c0]; if (!pgy) pgy = plat_y[c1];
  if (pgy && (uint8_t)(feet + 1) >= pgy && feet <= (uint8_t)(pgy + 4)) return pgy;
  /* then the ground surface */
  gy = ground_y[c0];
  if (gy == NO_GROUND) gy = ground_y[c1];
  if (gy != NO_GROUND && (uint8_t)(feet + 1) >= gy && feet <= (uint8_t)(gy + 4))
    return gy;
  return 0;
}

/* ── GAME LOGIC (clay) — per-state frames. Each runs INSIDE the canonical
 * loop below: scene already painted, tgi_updatedisplay not yet called. ── */

static unsigned attract_cam;

static void frame_title(uint8_t joy) {
  cam_x = attract_cam;                 /* attract: the level drifts by        */
  draw_level();
  /* a lone breathing gem sells the scaling idiom on the title screen —
   * parked in a clear top-right zone (away from all the text) so the pulse
   * reads cleanly. */
  draw_scaled(spr_gem, 132, 14, gem_scale());
  draw_scaled(spr_hero, 28, GROUND_Y - PLAYER_W, 0x0100);
  attract_cam++;
  if (attract_cam >= LEVEL_LEN) attract_cam -= LEVEL_LEN;

  tgi_setcolor(COLOR_WHITE);
  tgi_outtextxy(40, 1, GAME_TITLE);                  /* on the HUD bar       */
  tgi_setcolor(COLOR_YELLOW);
  tgi_outtextxy(52, 30, "PRESS A");
  tgi_setcolor(COLOR_LIGHTGREY);
  tgi_outtextxy(32, 44, "HI ");
  tgi_outtextxy(56, 44, fmt5(hiscore));
  tgi_outtextxy(24, 56, "1 PLAYER GAME");            /* handheld honesty     */

  if (JOY_BTN_1(joy) && !JOY_BTN_1(prev_joy)) start_game();
}

static void frame_over(uint8_t joy) {
  tgi_setcolor(COLOR_DARKGREY);
  tgi_bar(20, 28, 139, 66);
  tgi_setcolor(COLOR_WHITE);
  tgi_outtextxy(44, 32, "GAME OVER");
  tgi_setcolor(COLOR_YELLOW);
  tgi_outtextxy(36, 42, "SCORE ");
  tgi_outtextxy(84, 42, fmt5(score));
  if (over_new_hi) { tgi_setcolor(COLOR_LIGHTGREEN); tgi_outtextxy(32, 54, "NEW HI SCORE"); }
  else { tgi_setcolor(COLOR_LIGHTGREY); tgi_outtextxy(40, 54, "A = TITLE"); }
  if (JOY_BTN_1(joy) && !JOY_BTN_1(prev_joy)) state = ST_TITLE;
}

/* clamp+test that a world object is on-screen; returns its screen-x or -1 */
static int obj_sx(int16_t wx) {
  int16_t s = wx - (int16_t)cam_x;
  if (s < 0 || s >= SCRW) return -1;
  return (int)s;
}

static void frame_play(uint8_t joy) {
  uint8_t i, py8, feet, top, gh;
  int s;
  uint8_t moved = 0;

  /* ── draw: level, world objects (camera-relative), hero, HUD ── */
  draw_level();

  for (i = 0; i < N_COINS; i++) {
    if (!coins[i].alive) continue;
    s = obj_sx(coins[i].wx); if (s < 0) continue;
    tgi_setcolor(COLOR_YELLOW);
    tgi_bar(s, coins[i].y, s + 5, coins[i].y + 5);
    tgi_setcolor(COLOR_BROWN);
    tgi_bar(s + 2, coins[i].y + 2, s + 3, coins[i].y + 3);
  }
  for (i = 0; i < N_SPIKES; i++) {
    if (!spikes[i].alive) continue;
    s = obj_sx(spikes[i].wx); if (s < 0) continue;
    tgi_setcolor(COLOR_RED);
    tgi_bar(s, spikes[i].y, s + 1, spikes[i].y + 5);
    tgi_bar(s + 2, spikes[i].y - 2, s + 3, spikes[i].y + 5);
    tgi_bar(s + 4, spikes[i].y, s + 5, spikes[i].y + 5);
  }
  /* gems — drawn via the SCALING SCB (pulse this frame's hardware size) */
  for (i = 0; i < N_GEMS; i++) {
    if (!gems[i].alive) continue;
    s = obj_sx(gems[i].wx); if (s < 0) continue;
    draw_scaled(spr_gem, s, gems[i].y, gem_scale());
  }
  /* hero (blink while hurt) at a fixed 1.0x through the same SCB path */
  py8 = (uint8_t)(py_q44 >> 4);
  if (hurt_timer == 0 || (hurt_timer & 4))
    draw_scaled(spr_hero, (int)px, py8, 0x0100);

  tgi_setcolor(COLOR_WHITE);
  tgi_outtextxy(2, 1, "SC");
  tgi_outtextxy(20, 1, fmt5(score));
  tgi_setcolor(COLOR_LIGHTGREY);
  tgi_outtextxy(72, 1, "HI");
  tgi_outtextxy(90, 1, fmt5(hiscore));
  tgi_setcolor(COLOR_YELLOW);
  tgi_outtextxy(140, 1, "L");
  numbuf[0] = (char)('0' + lives); numbuf[1] = 0;
  tgi_outtextxy(148, 1, numbuf);

  /* ── update: input ── */
  if (joy & JOY_RIGHT_MASK) {
    if (px < SCROLL_WALL) px += MOVE_SPEED;
    else { cam_x += MOVE_SPEED; moved = MOVE_SPEED; }
  }
  if ((joy & JOY_LEFT_MASK) && px > 8) px -= MOVE_SPEED;
  if (JOY_BTN_1(joy) && !JOY_BTN_1(prev_joy) && on_ground) {
    vy_q44 = JUMP_VEL_Q44;
    on_ground = 0;
    sfx_tone(0, 110, 6);                              /* voice 0: jump whoop */
  }
  if (hurt_timer) hurt_timer--;
  if (cam_x >= LEVEL_LEN) cam_x -= LEVEL_LEN;          /* loop the run        */

  /* distance scoring */
  if (moved) {
    dist_sub += moved;
    if (dist_sub >= 64) { dist_sub -= 64; score++; }
  }

  /* ── physics: gravity + sub-pixel Y ── */
  if (vy_q44 < MAX_VY_Q44) vy_q44 += GRAVITY_Q44;
  py_q44 += vy_q44;
  py8 = (uint8_t)(py_q44 >> 4);

  /* fell below the screen (into a pit) → lose a life */
  if (py_q44 < 0 || py8 >= SCRH - 2) { lose_life(); return; }

  /* landing probe (only while falling) */
  if (vy_q44 >= 0) {
    feet = py8 + PLAYER_W;
    top = land_top(feet);
    if (top) {
      py_q44 = (int16_t)((top - PLAYER_W) << 4);
      vy_q44 = 0;
      if (!on_ground) sfx_tone(2, 180, 3);            /* voice 2: land thud  */
      on_ground = 1;
    } else {
      on_ground = 0;
    }
  }

  /* ── collisions (screen space; gem box tracks the live hardware size) ── */
  gh = gem_half();
  for (i = 0; i < N_GEMS; i++) {
    if (!gems[i].alive) continue;
    s = obj_sx(gems[i].wx); if (s < 0) continue;
    if (udist((uint8_t)(s + 4), (uint8_t)(px + 4)) < gh + 4
        && udist((uint8_t)(gems[i].y + 4), (uint8_t)(py8 + 4)) < gh + 4) {
      gems[i].alive = 0;
      score += 25;                                    /* fat gem = fat points */
      sfx_tone(0, 60, 6);                             /* voice 0: sparkle    */
    }
  }
  for (i = 0; i < N_COINS; i++) {
    if (!coins[i].alive) continue;
    s = obj_sx(coins[i].wx); if (s < 0) continue;
    if (udist((uint8_t)(s + 3), (uint8_t)(px + 4)) < 8
        && udist((uint8_t)(coins[i].y + 3), (uint8_t)(py8 + 4)) < 8) {
      coins[i].alive = 0;
      score += 10;
      sfx_tone(0, 70, 5);                             /* voice 0: coin ping  */
    }
  }
  if (hurt_timer == 0) {
    for (i = 0; i < N_SPIKES; i++) {
      if (!spikes[i].alive) continue;
      s = obj_sx(spikes[i].wx); if (s < 0) continue;
      if (udist((uint8_t)(s + 3), (uint8_t)(px + 4)) < 7
          && udist((uint8_t)(spikes[i].y + 3), (uint8_t)(py8 + 4)) < 7) {
        lose_life();
        return;
      }
    }
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
  attract_cam = 0;
  hiscore = 0;

  for (;;) {
    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * CANONICAL LYNX GAME LOOP — full-redraw every frame, in this order:
     *   1. while (tgi_busy()) { }  — WAIT for the previous frame's page
     *      flip. Skipping this is the #1 "Lynx screen stays blank" trap:
     *      drawing while the swap is pending loses the frame.
     *   2. Repaint the WHOLE scene with tgi_bar fills — NOT tgi_clear()
     *      (which can leave the framebuffer stale on this toolchain+
     *      emulator path). TGI double-buffers; the back buffer holds the
     *      frame from two flips ago, so partial redraws ghost. The SOFTWARE
     *      camera (header) means scrolling = redrawing the visible slice.
     *   3. Draw every object (every TGI call and every tgi_sprite() is a
     *      synchronous Suzy blit into the SAME draw page).
     *   4. tgi_updatedisplay() — request the page flip at next VBL.
     *   5. sfx_update() IMMEDIATELY after — MIKEY voice writes must land in
     *      vblank: handy reschedules its timer sweep on the spot when a
     *      voice CTL bit-3 write lands, and mid-frame that sweep can preempt
     *      an in-flight Suzy blit and eat sprites (the R57 bug — history in
     *      lynx_sfx.c). sfx_tone()/sfx_noise() only STAGE; sfx_update() is
     *      the hardware flush. */
    while (tgi_busy()) { }

    draw_scene();
    joy = joy_read(JOY_1);

    if      (state == ST_TITLE) frame_title(joy);
    else if (state == ST_PLAY)  frame_play(joy);
    else                        frame_over(joy);

    tgi_updatedisplay();
    sfx_update();

    gem_phase = (gem_phase + 4) & 255;   /* advance the shared scaling pulse */
    prev_joy = joy;
  }
}
