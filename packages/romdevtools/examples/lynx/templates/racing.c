/* ── racing.c — Atari Lynx 1P top-down road racer (complete example game) ─────
 *
 * A COMPLETE, working game — DEPTH DODGE, a top-down vertical road racer fit to
 * the Lynx's tiny 160x102 screen: title screen, a 1P endless run with speed
 * control and a steerable car, a best-distance record, MIKEY music + SFX, AND
 * the Lynx's signature party trick: HARDWARE SPRITE SCALING used for PSEUDO-3D
 * DEPTH. Obstacle cars are Suzy scalable sprites that ENTER tiny at the far
 * horizon and SWELL as they rush toward you — an OutRun-ish "coming at you"
 * read built from real hardware scaling, not Mode-7 (the Lynx has no affine
 * background; this is honest sprite scaling, see the HARDWARE IDIOM note).
 *
 * The game: you drive the YELLOW car along the bottom of a vertically-scrolling
 * road. LEFT/RIGHT hop between three lanes; UP accelerates, DOWN brakes
 * (speed 1-5). Faster = more distance banked but obstacles close quicker.
 * Obstacle cars spawn at the horizon and grow as they approach; a same-lane
 * collision when one reaches you is a CRASH (3 crashes ends the run). The run's
 * DISTANCE is the score; your best DISTANCE this power-on is shown on the title.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented Lynx footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — road art, traffic patterns, speeds, scoring rules:
 *     reshape freely.
 *
 * What depends on what:
 *   lynx_sfx.{h,c} — MIKEY 4-voice audio (voice 0 = steer/crash SFX, voice 1 =
 *     background melody, voice 2 = engine/checkpoint blips, voice 3 = noise).
 *   vendor/cc65/libsrc/lynx/ — the FULL cc65 Lynx driver source shipped into
 *     your project. The TGI driver (tgi/lynx-160-102-16.s) is REQUIRED
 *     reading when graphics misbehave: every TGI call is itself a Suzy
 *     sprite, and our scaled obstacle cars ride the same engine via
 *     tgi_ioctl(0).
 *
 * NO HARDWARE TILEMAP (read this — it is the platform's biggest "where's the
 *   road renderer?" surprise): the Lynx has NO background tilemap and NO
 *   hardware scroll. Suzy is a SPRITE BLITTER, not a tile engine. So the road
 *   is drawn the honest way: the full-redraw TGI loop repaints the WHOLE track
 *   every frame as a stack of tgi_bar fills + tgi_line markings, and the road
 *   "scrolls" by animating the lane-dash phase each frame — cheap on a 160x102
 *   screen, and it falls out of the canonical full-redraw loop for free.
 *
 * PLAYERS: 1. This is a handheld — head-to-head on real hardware is ComLynx,
 *   a cable between TWO physical Lynx units. A single emulator instance has
 *   nobody on the other end of the cable, so this example is honestly a 1P
 *   endless racer (no fake "P2 VERSUS" that could never work here — contrast
 *   the NES racing donor, which has a real simultaneous-2P split-road mode).
 *
 * SCREEN: 160x102. The system font is 8x8, so a full row of text is 20
 *   characters — the road + HUD are kept compact to fit.
 */

#include <tgi.h>
#include <joystick.h>
#include <lynx.h>
#include <stdint.h>
#include "lynx_sfx.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it <=16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "DEPTH DODGE"

/* ── GAME LOGIC (clay — reshape freely) — road geometry (fits 160x102) ───────
 * A vertical road down the centre with grass shoulders. ROAD_L/ROAD_R bound
 * the tarmac; three lane centres sit inside it. The player rides near the
 * bottom; obstacles travel the road from HORIZON_Y (top) downward. */
#define ROAD_L      28               /* left tarmac edge                      */
#define ROAD_R      131              /* right tarmac edge                     */
#define HORIZON_Y   14               /* top of the playfield (far distance)   */
#define PLAYER_Y    88               /* player car centre row (near the foot) */
#define CRASH_Y     82               /* y at/after which an obstacle "reaches" */
#define LANES       3
#define START_LIVES 3
#define MAX_OBS     4                /* obstacle pool size                    */
static const int16_t lane_x[LANES] = { 51, 79, 108 };   /* lane centres       */

/* Game states — the shell every example shares: title → play → over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;

/* ── GAME LOGIC (clay) — run state ── */
static uint8_t  player_lane;         /* 0..2                                  */
static uint8_t  speed;               /* 1..5 road px/frame                    */
static uint16_t dist;                /* run distance (the score)              */
static uint8_t  dist_frac;
static uint16_t best;                /* in-session best distance — see below  */
static uint8_t  lives;
static uint8_t  invuln;              /* post-crash blink/no-collide frames    */
static uint8_t  spawn_timer;
static uint8_t  road_phase;          /* lane-dash scroll phase (0..11)        */
static uint8_t  prev_joy;
static uint8_t  new_record;          /* result screen shows NEW RECORD        */

/* The result SCALE POP: when >0 the result glyph draws swollen for a few
 * frames (the SCALING signature), counting back to the resting 1.0x. */
static uint8_t  pop_timer;
#define POP_FRAMES 12

/* Obstacle pool (fixed slots, no allocation). y travels HORIZON_Y..CRASH_Y. */
static uint8_t  obs_alive[MAX_OBS];
static uint8_t  obs_lane[MAX_OBS];
static int16_t  obs_y[MAX_OBS];

/* ── GAME LOGIC (clay) — xorshift16 PRNG (~tens of cycles per call).
 * Picks obstacle lanes; without a noise source the spawn pattern would be a
 * fixed loop. rand8() is also ticked once per play frame so identical game
 * states a few seconds apart still diverge. */
static uint16_t rng = 0xC0A7;
static uint8_t rand8(void) {
  uint16_t r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (uint8_t)r;
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * SUZY HARDWARE SPRITE SCALING — the Lynx signature, used here for PSEUDO-3D
 * DEPTH. Suzy renders every sprite through a Sprite Control Block (SCB) it
 * walks in cart/work RAM. Two SCB fields, HSIZE and VSIZE, are 8.8 fixed-point
 * scale factors ($0100 = 1.0): the SAME 8x8 source pixels render at any size,
 * every frame, for free. This game uses it to fake DEPTH:
 *   - each OBSTACLE car is a Suzy sprite whose 8.8 scale is computed from its
 *     screen Y — small at the far HORIZON, swelling toward 1.0x+ as it nears
 *     the player — recomputed every frame, zero CPU pixel cost (Suzy scales
 *     while it blits). A car that "rushes at you" is the hardware doing the
 *     perspective, not a pre-scaled sprite sheet.
 *   - the player car and the RESULT POP (the glyph swells then eases back when
 *     a run ends) ride the same scaling SCB path.
 * This is NOT Mode-7 / affine backgrounds (the Lynx has none): it is honest
 * SPRITE scaling, and the hitbox below TRACKS the live hardware size so the
 * collision reads what you SEE.
 *
 * The SCB, field by field (this is cc65's SCB_REHV_PAL from <_suzy.h>):
 *   sprctl0  bits 7-6 = bits per pixel (11 = 4bpp), bits 2-0 = sprite TYPE.
 *            TYPE_NORMAL (4) draws pens 1-15 and treats pen 0 as
 *            TRANSPARENT — that's how the car shape sits over the road.
 *   sprctl1  bit 7 LITERAL (raw nybbles, no RLE) + bits 5-4 reload depth:
 *            REHV means "this SCB carries HPOS, VPOS, HSIZE, VSIZE". The
 *            reload bits ARE the struct layout — mismatch them and Suzy reads
 *            palette bytes as size words.
 *   sprcoll  $20 = NO_COLLIDE. Car/obstacle collision is done in C on the road
 *            coordinates (the collision buffer knows nothing about gameplay).
 *   next     pointer to the next SCB, 0 = end of chain (one blit per call).
 *   data     sprite pixel data (LITERAL 4bpp format below).
 *   hpos/vpos signed SCREEN position of the sprite's top-left corner.
 *   hsize/vsize 8.8 scale — THE party trick, rewritten per draw.
 *   penpal[8] 16 nybbles mapping pixel values 0-15 → palette pens. We RECOLOUR
 *            the sprite per draw here (one 8x8 art block, any pen) by pointing
 *            the art's pixel value 1 at the wanted pen — no extra art.
 *
 * LITERAL 4bpp data format (hand-encodable): each sprite LINE is
 *   [offset byte][width/2 bytes of raw nybble pixels]
 * where offset = 1 + bytes of pixel data; a final offset of 0 ends the sprite.
 * 8 px @ 4bpp = 4 data bytes, so every line starts with 5.
 *
 * Drawing: tgi_sprite(&scb) → tgi_ioctl(0, &scb) — the TGI driver's
 * documented escape hatch (see CONTROL in vendor/cc65/libsrc/lynx/tgi/
 * lynx-160-102-16.s). It points Suzy's SCBNEXT at your SCB, aims VIDBAS at
 * TGI's current DRAW page (so scaled sprites land in the same double-buffered
 * frame as tgi_bar/tgi_outtextxy), fires SPRGO, and sleeps the CPU until
 * SPRSYS reports the blit done.
 *
 * Requires: the cc65 crt0 Suzy init (already done before main()), and calls
 *   only between the tgi_busy() wait and tgi_updatedisplay() — i.e. while
 *   TGI's draw buffer is the blit target. Draw order = paint order: road fills
 *   first, scaled obstacle/player cars after, HUD text last.
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

/* ── GAME LOGIC (clay) — 8x8 4bpp literal sprite art ────────────────────────
 * A nose-up car in pixel value 1 (plus value $F = white windshield glint).
 * draw_sprite() recolours value 1 → the wanted pen via the SCB penpal, so one
 * art block paints any colour (player = yellow, obstacles = red). Each line:
 * 5, then 4 nybble bytes; a final 0 byte ends the sprite. */
static unsigned char spr_car[] = {
  5, 0x01, 0x11, 0x11, 0x10,     /* . 1 1 1 1 1 1 .  roof                     */
  5, 0x01, 0x1F, 0xF1, 0x10,     /* . 1 1 F F 1 1 .  windshield glint         */
  5, 0x11, 0x11, 0x11, 0x11,     /* 1 1 1 1 1 1 1 1  cabin                    */
  5, 0x01, 0x11, 0x11, 0x10,     /* . 1 1 1 1 1 1 .                           */
  5, 0x11, 0x11, 0x11, 0x11,     /* 1 1 1 1 1 1 1 1  body                     */
  5, 0x11, 0x11, 0x11, 0x11,     /* 1 1 1 1 1 1 1 1                           */
  5, 0x10, 0x11, 0x11, 0x01,     /* 1 . 1 1 1 1 . 1  wheels                   */
  5, 0x10, 0x00, 0x00, 0x01,     /* 1 . . . . . . 1                          */
  0
};
/* A chunky trophy/cup glyph for the result pop (pixel value 1 = body). */
static unsigned char spr_cup[] = {
  5, 0x01, 0x11, 0x11, 0x10,     /* . 1 1 1 1 1 1 .  cup bowl                 */
  5, 0x01, 0x11, 0x11, 0x10,     /* . 1 1 1 1 1 1 .                           */
  5, 0x01, 0x11, 0x11, 0x10,     /* . 1 1 1 1 1 1 .                           */
  5, 0x00, 0x11, 0x11, 0x00,     /* . . 1 1 1 1 . .  taper                    */
  5, 0x00, 0x01, 0x10, 0x00,     /* . . . 1 1 . . .  stem                     */
  5, 0x00, 0x01, 0x10, 0x00,     /* . . . 1 1 . . .                           */
  5, 0x00, 0x11, 0x11, 0x00,     /* . . 1 1 1 1 . .  base                     */
  5, 0x01, 0x11, 0x11, 0x10,     /* . 1 1 1 1 1 1 .                           */
  0
};

/* Draw an 8x8 literal sprite CENTERED on (cx,cy) at the given 8.8 scale,
 * recoloured so art pixel value 1 paints `pen`. Centering matters: hpos/vpos
 * are the TOP-LEFT, so a sprite scaled around its corner would slide as it
 * grows — anchoring the centre keeps a growing obstacle reading as "coming at
 * you" along its lane, and the result pop as a uniform swell. */
static void draw_sprite(unsigned char *data, int cx, int cy, uint8_t pen, unsigned scale) {
  unsigned w = (8u * scale) >> 8;
  if (w == 0) w = 1;
  scb.penpal[0] = (uint8_t)((0u << 4) | pen);  /* val0=transparent, val1=pen */
  scb.data  = data;
  scb.hsize = scale;
  scb.vsize = scale;
  scb.hpos  = cx - (int)(w >> 1);
  scb.vpos  = cy - (int)(w >> 1);
  tgi_sprite(&scb);
}

/* ── HARDWARE IDIOM (load-bearing) — DEPTH→SCALE mapping ─────────────────────
 * The pseudo-3D read lives here: an obstacle's 8.8 scale is a function of its
 * screen Y. At the HORIZON it is tiny (~0.5x); as it travels down to the
 * player it swells to ~1.5x — so a car genuinely LOOMS as it nears. The same
 * function feeds the on-screen footprint AND the collision box (obs_px below),
 * so the hardware size and the hitbox never disagree. Tune the 0x0080 floor /
 * 0x0140 span to make traffic loom harder or gentler. */
#define OBS_SCALE_MIN  0x0080u        /* 0.5x at the far horizon */
#define OBS_SCALE_SPAN 0x0140u        /* +1.25x by the time it reaches you */
static unsigned obs_scale(int16_t y) {
  /* progress 0..256 as y goes HORIZON_Y..PLAYER_Y */
  int16_t num = y - HORIZON_Y;
  int16_t den = PLAYER_Y - HORIZON_Y;
  unsigned prog;
  if (num < 0) num = 0;
  if (num > den) num = den;
  prog = (unsigned)((long)num * 256 / den);
  return OBS_SCALE_MIN + (OBS_SCALE_SPAN * prog) / 256u;
}
/* The obstacle's current on-screen pixel footprint (8 px * scale), used for
 * the same-lane "did it reach me" overlap so collision matches what's drawn. */
static unsigned obs_px(int16_t y) {
  unsigned p = (8u * obs_scale(y)) >> 8;
  return p ? p : 1;
}

/* Current result-pop scale: 1.0x at rest, swelling to ~2.0x at the peak and
 * easing back. POP drives the SCALING idiom on the result screen. */
#define POP_SCALE_PEAK 0x0200u          /* 2.0x */
static unsigned pop_scale(void) {
  if (pop_timer == 0) return 0x0100u;
  return 0x0100u + ((unsigned)pop_timer * (POP_SCALE_PEAK - 0x0100u)) / POP_FRAMES;
}

/* ── GAME LOGIC (clay) — number text (no sprintf: it drags in ~6KB) ── */
static char numbuf[6];
static char *fmt5(unsigned v) {
  uint8_t i;
  for (i = 0; i < 5; i++) { numbuf[4 - i] = (char)('0' + v % 10); v /= 10; }
  numbuf[5] = 0;
  return numbuf;
}

/* ── GAME LOGIC (clay) — paint the road (full redraw, every frame) ──────────
 * No hardware tilemap, so the road is bars + lines: grass fill, tarmac, solid
 * white edges, dashed lane dividers whose phase scrolls each frame (the road
 * "moves"), and a darker horizon band for depth. Layered tones keep any one
 * colour comfortably under the render-health blank threshold (>=92% one colour
 * reads as "blank"). */
static void draw_road(void) {
  int16_t y;
  /* grass + rumble shoulders */
  tgi_setcolor(COLOR_GREEN);
  tgi_bar(0, 0, 159, 101);
  tgi_setcolor(COLOR_LIGHTGREEN);
  for (y = (int16_t)road_phase - 8; y < 102; y += 16) {
    tgi_bar(0,   (unsigned)(y < 0 ? 0 : y), 6,   (unsigned)(y + 6 > 101 ? 101 : y + 6));
    tgi_bar(153, (unsigned)(y < 0 ? 0 : y), 159, (unsigned)(y + 6 > 101 ? 101 : y + 6));
  }
  /* tarmac + a darker far band for depth */
  tgi_setcolor(COLOR_GREY);
  tgi_bar(ROAD_L, HORIZON_Y, ROAD_R, 101);
  tgi_setcolor(COLOR_DARKGREY);
  tgi_bar(ROAD_L, HORIZON_Y, ROAD_R, HORIZON_Y + 10);     /* horizon haze     */
  tgi_bar(0, 0, 159, HORIZON_Y - 1);                       /* top HUD band     */
  /* solid road edges */
  tgi_setcolor(COLOR_WHITE);
  tgi_line(ROAD_L, HORIZON_Y, ROAD_L, 101);
  tgi_line(ROAD_R, HORIZON_Y, ROAD_R, 101);
  tgi_line(0, HORIZON_Y, 159, HORIZON_Y);
  /* dashed lane dividers between the 3 lanes, scrolling downward */
  for (y = (int16_t)road_phase - 12; y < 102; y += 12) {
    int16_t y0 = y < HORIZON_Y ? HORIZON_Y : y;
    int16_t y1 = y + 6 > 101 ? 101 : y + 6;
    if (y1 <= y0) continue;
    tgi_bar(65, (unsigned)y0, 66, (unsigned)y1);
    tgi_bar(93, (unsigned)y0, 94, (unsigned)y1);
  }
}

/* ── GAME LOGIC (clay) — HUD: distance + lives across the top band ── */
static void draw_hud(void) {
  tgi_setcolor(COLOR_YELLOW);
  tgi_outtextxy(2, 2, "D");
  tgi_outtextxy(12, 2, fmt5(dist));
  tgi_setcolor(COLOR_RED);
  tgi_outtextxy(120, 2, "CAR");
  numbuf[0] = (char)('0' + lives); numbuf[1] = 0;
  tgi_outtextxy(148, 2, numbuf);
}

/* ── GAME LOGIC (clay) — obstacle pool ── */
static void spawn_obstacle(void) {
  uint8_t i;
  for (i = 0; i < MAX_OBS; i++) {
    if (!obs_alive[i]) {
      obs_alive[i] = 1;
      obs_lane[i]  = (uint8_t)(rand8() % LANES);
      obs_y[i]     = HORIZON_Y;
      return;
    }
  }
}

/* ── GAME LOGIC (clay) — start a run ── */
static void start_run(void) {
  uint8_t i;
  for (i = 0; i < MAX_OBS; i++) obs_alive[i] = 0;
  player_lane = 1;
  speed = 1;
  dist = 0; dist_frac = 0;
  lives = START_LIVES;
  invuln = 0;
  spawn_timer = 0;
  new_record = 0;
  prev_joy = 0xFF;             /* the button that started the run shouldn't
                               * also count as the first frame's input */
  sfx_tone(0, 80, 8);          /* start chirp */
  state = ST_PLAY;
}

/* ── GAME LOGIC (clay) — run over: result + record bookkeeping.
 * Persistence choice: best DISTANCE this power-on. ── */
static void end_run(void) {
  if (dist > best) {
    /* ── In-session record ONLY — and here's the honest why. Real Lynx
     * carts persist via a 93Cxx serial EEPROM on the cart PCB (cc65 even
     * ships lynx_eeprom_read/write for it; see vendor/cc65/libsrc/lynx/
     * eeprom.s). PROBED: the bundled handy core emulates CEEPROM internally
     * but its libretro build exposes NO save path — retro_get_memory(
     * SAVE_RAM) returns NULL/size 0, so nothing survives host.hardReset()
     * and a bit-banged round-trip reads back garbage under the WASM build.
     * Wiring the EEPROM to SAVE_RAM is a future core round; until then a
     * fake "save" would be lying. The best DOES survive title↔play cycles
     * within one power-on. ── */
    best = dist;
    new_record = 1;
    sfx_tone(0, 60, 16);        /* record fanfare */
  } else {
    sfx_tone(2, 220, 18);       /* low defeat thump */
  }
  sfx_noise(14);                 /* crash debris */
  pop_timer = POP_FRAMES;        /* trigger the result SCALE POP */
  state = ST_OVER;
}

/* ── GAME LOGIC (clay) — a crash ── */
static void crash(void) {
  sfx_noise(12);
  invuln = 45;                   /* blink + no-collide grace */
  speed = 1;                     /* a wreck kills your momentum */
  if (lives > 0) --lives;
  if (lives == 0) end_run();
}

/* ── GAME LOGIC (clay) — per-state frames. Each runs INSIDE the canonical
 * loop below: road already painted, tgi_updatedisplay not yet called. ── */

static unsigned attract_phase;

static void frame_title(uint8_t joy) {
  /* attract: a lone obstacle car in the title's clear zone "approaches" via
   * the SCALING idiom — the same swell traffic uses in play, shown off on the
   * menu by sweeping its scale small↔large. */
  unsigned t = attract_phase < 64 ? attract_phase : (127 - attract_phase);
  unsigned s = OBS_SCALE_MIN + (t * (0x0220u - OBS_SCALE_MIN)) / 63u;  /* small↔big */
  attract_phase = (attract_phase + 2) & 127;
  draw_sprite(spr_car, 79, 40, COLOR_RED, s);              /* approaching car */

  tgi_setcolor(COLOR_WHITE);
  tgi_outtextxy(8, 20, GAME_TITLE);
  tgi_setcolor(COLOR_YELLOW);
  tgi_outtextxy(48, 56, "PRESS A");
  tgi_setcolor(COLOR_LIGHTGREY);
  tgi_outtextxy(28, 70, "BEST ");
  tgi_outtextxy(68, 70, fmt5(best));
  tgi_outtextxy(36, 84, "1P RACE");           /* handheld honesty             */

  if (JOY_BTN_1(joy) && !JOY_BTN_1(prev_joy)) start_run();
}

static void frame_over(uint8_t joy) {
  unsigned ps = pop_scale();
  /* the SCALE POP: the result glyph swells then eases back to 1.0x */
  if (new_record) draw_sprite(spr_cup, 80, 38, COLOR_YELLOW, ps);
  else            draw_sprite(spr_car, 80, 38, COLOR_RED, ps);
  if (pop_timer) pop_timer--;

  tgi_setcolor(COLOR_DARKGREY);
  tgi_bar(24, 52, 135, 98);
  tgi_setcolor(COLOR_WHITE);
  tgi_outtextxy(48, 56, "WRECKED");
  tgi_setcolor(COLOR_LIGHTGREY);
  tgi_outtextxy(28, 68, "DIST ");
  tgi_outtextxy(68, 68, fmt5(dist));
  if (new_record) { tgi_setcolor(COLOR_YELLOW); tgi_outtextxy(32, 80, "NEW RECORD"); }
  else { tgi_setcolor(COLOR_LIGHTGREY); tgi_outtextxy(44, 80, "A = TITLE"); }
  tgi_setcolor(COLOR_LIGHTGREY);
  tgi_outtextxy(28, 90, "BEST ");
  tgi_outtextxy(68, 90, fmt5(best));

  if (JOY_BTN_1(joy) && !JOY_BTN_1(prev_joy)) state = ST_TITLE;
}

static void frame_play(uint8_t joy) {
  uint8_t i;

  /* ── draw: obstacle cars (SCALED by depth), the player car, HUD ──
   * Draw obstacles FAR-FIRST (smallest at the horizon) then the player on
   * top, so a near obstacle that overlaps the player paints over it correctly.
   * Each obstacle's hardware scale is obs_scale(y) — the pseudo-3D loom. */
  for (i = 0; i < MAX_OBS; i++) {
    if (!obs_alive[i]) continue;
    draw_sprite(spr_car, (int)lane_x[obs_lane[i]], (int)obs_y[i],
                COLOR_RED, obs_scale(obs_y[i]));
  }
  if (!(invuln & 2))            /* crash blink: skip the player on odd frames */
    draw_sprite(spr_car, (int)lane_x[player_lane], PLAYER_Y, COLOR_YELLOW, 0x0100u);
  draw_hud();

  /* ── update ── */
  rand8();                       /* tick the noise source every play frame */

  /* steer: LEFT/RIGHT hop lanes (edge-detected so a held d-pad doesn't
   * machine-gun across the road). */
  if ((joy & JOY_LEFT_MASK)  && !(prev_joy & JOY_LEFT_MASK)  && player_lane > 0) {
    --player_lane; sfx_tone(0, 90, 3);
  }
  if ((joy & JOY_RIGHT_MASK) && !(prev_joy & JOY_RIGHT_MASK) && player_lane < LANES - 1) {
    ++player_lane; sfx_tone(0, 90, 3);
  }
  /* speed: UP accelerates, DOWN brakes (edge-detected, 1..5) */
  if ((joy & JOY_UP_MASK)   && !(prev_joy & JOY_UP_MASK)   && speed < 5) {
    ++speed; sfx_tone(2, (uint8_t)(120 - speed * 12), 4);   /* engine rev */
  }
  if ((joy & JOY_DOWN_MASK) && !(prev_joy & JOY_DOWN_MASK) && speed > 1) {
    --speed; sfx_tone(2, 180, 3);                           /* brake blip */
  }

  if (invuln > 0) --invuln;

  /* distance: 1 unit per 4 scrolled "road units"; a chime every 256 units. */
  dist_frac = (uint8_t)(dist_frac + speed);
  if (dist_frac >= 4) {
    dist_frac -= 4;
    if (dist < 65535u) ++dist;
    if (dist != 0 && (dist & 0xFF) == 0) sfx_tone(2, 110, 8);   /* checkpoint */
  }

  /* scroll the road (animate the dash + rumble phase) */
  road_phase = (uint8_t)(road_phase + speed);
  while (road_phase >= 12) road_phase -= 12;

  /* obstacles travel from the horizon toward you at road speed; despawn past
   * the bottom with a pass tick. A same-lane obstacle that REACHES the player
   * (its near edge overlaps PLAYER_Y) while you share its lane is a crash. */
  for (i = 0; i < MAX_OBS; i++) {
    if (!obs_alive[i]) continue;
    obs_y[i] += speed;
    if (obs_y[i] >= 104) {
      obs_alive[i] = 0;
      sfx_tone(2, 70, 2);          /* whoosh past */
      continue;
    }
    if (!invuln && obs_lane[i] == player_lane) {
      /* the obstacle's live (scaled) footprint reaches the player row */
      unsigned half = obs_px(obs_y[i]) >> 1;
      if (obs_y[i] + (int)half >= CRASH_Y && obs_y[i] - (int)half <= PLAYER_Y + 4) {
        obs_alive[i] = 0;
        crash();
        if (state != ST_PLAY) return;
      }
    }
  }

  /* spawn cadence: faster speed spawns slightly more often (denser traffic
   * the quicker you push). */
  if (++spawn_timer >= (uint8_t)(48 - speed * 4)) {
    spawn_timer = 0;
    spawn_obstacle();
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
  best = 0;
  road_phase = 0;

  for (;;) {
    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * CANONICAL LYNX GAME LOOP — full-redraw every frame, in this order:
     *   1. while (tgi_busy()) { }  — WAIT for the previous frame's page flip.
     *      Skipping this is the #1 "Lynx screen stays blank" trap: drawing
     *      while the swap is pending loses the frame.
     *   2. Repaint the WHOLE scene with tgi_bar/tgi_line fills — NOT
     *      tgi_clear() (which can leave the framebuffer stale on this
     *      toolchain+emulator path). TGI double-buffers; the back buffer holds
     *      the frame from two flips ago, so partial redraws ghost. With no
     *      hardware tilemap, the ROAD is repainted every frame (and the
     *      lane-dash phase animation IS the scroll).
     *   3. Draw every object (every TGI call and every tgi_sprite() is a
     *      synchronous Suzy blit into the SAME draw page) — obstacles SCALED
     *      by depth, then the player car, then HUD text.
     *   4. tgi_updatedisplay() — request the page flip at next VBL.
     *   5. sfx_update() IMMEDIATELY after — MIKEY voice writes must land in
     *      vblank: handy reschedules its timer sweep on the spot when a voice
     *      CTL bit-3 write lands, and mid-frame that sweep can preempt an
     *      in-flight Suzy blit and eat sprites (the R57 bug — history in
     *      lynx_sfx.c). sfx_tone()/sfx_noise() only STAGE; sfx_update() is
     *      the hardware flush. */
    while (tgi_busy()) { }

    draw_road();

    joy = joy_read(JOY_1);

    if      (state == ST_TITLE) frame_title(joy);
    else if (state == ST_PLAY)  frame_play(joy);
    else                        frame_over(joy);

    tgi_updatedisplay();
    sfx_update();

    prev_joy = joy;
  }
}
