/* ── sports.c — Atari Lynx 1P-vs-CPU court game (complete example game) ───────
 *
 * A COMPLETE, working game — PULSE PARRY, a head-to-head court game (Pong
 * lineage) fit to the Lynx's tiny 160x102 screen: title screen, 1P vs a
 * beatable CPU, first-to-N match flow with a result screen, in-session
 * record, MIKEY music + SFX, AND the Lynx's signature party trick:
 * HARDWARE SPRITE SCALING. The ball is a Suzy scalable sprite that GROWS
 * with its speed (a fast volley looms larger), and the result screen does a
 * SCALE POP — a winner glyph swells then eases back — both pure-hardware
 * "juice" that costs zero CPU pixel work.
 *
 * The game: you are the LEFT paddle; a CPU works the RIGHT. UP/DOWN move you.
 * The ball rallies between you; the angle you return it at depends on where it
 * strikes your paddle (centre = flat, edges = steep), and a ±1 PRNG "spin" on
 * every return guarantees no rally loops forever. First side to WIN_SCORE
 * takes the match → a result screen → back to the title.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented Lynx footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — court art, ball physics, CPU skill, scoring rules:
 *     reshape freely.
 *
 * What depends on what:
 *   lynx_sfx.{h,c} — MIKEY 4-voice audio (voice 0 = paddle/score SFX, voice 1 =
 *     background melody, voice 2 = wall/whistle SFX, voice 3 = noise/miss).
 *   vendor/cc65/libsrc/lynx/ — the FULL cc65 Lynx driver source shipped into
 *     your project. The TGI driver (tgi/lynx-160-102-16.s) is REQUIRED
 *     reading when graphics misbehave: every TGI call is itself a Suzy
 *     sprite, and our scaled ball + result pop ride the same engine via
 *     tgi_ioctl(0).
 *
 * NO HARDWARE TILEMAP (read this — it is the platform's biggest "where's the
 *   court renderer?" surprise): the Lynx has NO background tilemap. Suzy is a
 *   SPRITE BLITTER, not a tile engine. So the court is drawn the honest way:
 *   the full-redraw TGI loop repaints the whole arena every frame as a stack
 *   of tgi_bar fills + tgi_line markings — cheap on a 160x102 screen. The
 *   paddles are flat bars; the ball is a Suzy SCALABLE sprite on top.
 *
 * PLAYERS: 1. This is a handheld — head-to-head on real hardware is ComLynx,
 *   a cable between TWO physical Lynx units. A single emulator instance has
 *   nobody on the other end of the cable, so this example is honestly 1P vs a
 *   CPU opponent (no fake "P2 VERSUS" that could never work here — contrast
 *   the NES sports donor, which has a real simultaneous-2P mode).
 *
 * SCREEN: 160x102. The system font is 8x8, so a full row of text is 20
 *   characters — the court + HUD are kept compact to fit.
 */

#include <tgi.h>
#include <joystick.h>
#include <lynx.h>
#include <stdint.h>
#include "lynx_sfx.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it <=16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "PULSE PARRY"

/* ── GAME LOGIC (clay — reshape freely) — court geometry (fits 160x102) ──────
 * A full-width court with a slim HUD row across the top. COURT_TOP/BOT bound
 * the ball vertically; the paddles ride the left/right edges. */
#define COURT_TOP   12               /* first playable pixel row              */
#define COURT_BOT   100              /* first pixel row of the bottom rail    */
#define PADDLE_H    20               /* paddle height in px (compact court)   */
#define PADDLE_W    3
#define PADDLE_X1   5                /* you — left side                       */
#define PADDLE_X2   (159 - 5 - PADDLE_W)  /* CPU — right side                 */
#define BALL_W      6                /* nominal ball footprint (1.0x sprite)  */
#define WIN_SCORE   5                /* first to 5 takes the match            */

/* Game states — the shell every example shares: title → play → result. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;

/* ── GAME LOGIC (clay) — match state ── */
static int16_t p1y, p2y;             /* paddle top Y                          */
static int16_t bx, by;               /* ball top-left                         */
static int8_t  bdx, bdy;             /* ball velocity (px/frame)              */
static uint8_t score_p1, score_p2;
static uint8_t serve_timer;          /* freeze frames between points          */
static uint8_t streak;               /* current win streak vs CPU (this run)  */
static uint8_t best_streak;          /* in-session record — see end_match()   */
static uint8_t new_record;           /* result screen shows NEW RECORD        */
static uint8_t p1_won;               /* who took the match (result screen)    */
static uint8_t prev_joy;

/* The result SCALE POP: when >0 the winner glyph draws swollen for a few
 * frames (the SCALING signature), counting back down to the resting 1.0x. */
static uint8_t  pop_timer;
#define POP_FRAMES 10

/* ── GAME LOGIC (clay) — xorshift16 PRNG (~tens of cycles per call).
 * A versus game NEEDS this: the Lynx is fully deterministic, so without a
 * noise source two fixed strategies lock into an infinite rally loop (the
 * exact same cycle, forever). rand8() is ticked once per play frame so
 * identical game states a few seconds apart still diverge. */
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
 * SUZY HARDWARE SPRITE SCALING — the Lynx signature. Suzy renders every
 * sprite through a Sprite Control Block (SCB) it walks in cart/work RAM.
 * Two SCB fields, HSIZE and VSIZE, are 8.8 fixed-point scale factors
 * ($0100 = 1.0): the SAME 8x8 source pixels render at any size, every frame,
 * for free. This game uses it two ways:
 *   - the BALL is a Suzy sprite whose 8.8 scale tracks its SPEED — a slow
 *     serve is a small dot, a fast volley looms larger — recomputed every
 *     frame, zero CPU pixel cost (Suzy scales while it blits);
 *   - the RESULT POP — for POP_FRAMES after a match ends, the winner glyph is
 *     redrawn at >1.0x then eased back to 1.0x, a pure-hardware "juice" flash.
 *
 * The SCB, field by field (this is cc65's SCB_REHV_PAL from <_suzy.h>):
 *   sprctl0  bits 7-6 = bits per pixel (11 = 4bpp), bits 2-0 = sprite TYPE.
 *            TYPE_NORMAL (4) draws pens 1-15 and treats pen 0 as
 *            TRANSPARENT — that's how the round ball sits over the court.
 *   sprctl1  bit 7 LITERAL (raw nybbles, no RLE) + bits 5-4 reload depth:
 *            REHV means "this SCB carries HPOS, VPOS, HSIZE, VSIZE". The
 *            reload bits ARE the struct layout — mismatch them and Suzy reads
 *            palette bytes as size words.
 *   sprcoll  $20 = NO_COLLIDE. Ball/paddle collision is done in C on the court
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
 *   TGI's draw buffer is the blit target. Draw order = paint order: court
 *   fills first, scaled ball/glyph after, HUD text last.
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
 * A round ball in pixel value 1 (plus value $F = white glint). draw_sprite()
 * recolours value 1 → the wanted pen via the SCB penpal, so one art block
 * paints any colour. Each line: 5, then 4 nybble bytes; a final 0 byte ends
 * the sprite. */
static unsigned char spr_ball[] = {
  5, 0x00, 0x11, 0x10, 0x00,     /* . . 1 1 1 . . .  round ball body          */
  5, 0x01, 0x1F, 0xF1, 0x10,     /* . 1 1 F F 1 1 .  (white glint)            */
  5, 0x11, 0x11, 0x11, 0x11,     /* 1 1 1 1 1 1 1 1                           */
  5, 0x11, 0x11, 0x11, 0x11,     /* 1 1 1 1 1 1 1 1                           */
  5, 0x11, 0x11, 0x11, 0x11,     /* 1 1 1 1 1 1 1 1                           */
  5, 0x11, 0x11, 0x11, 0x11,     /* 1 1 1 1 1 1 1 1                           */
  5, 0x01, 0x11, 0x11, 0x10,     /* . 1 1 1 1 1 1 .                           */
  5, 0x00, 0x11, 0x10, 0x00,     /* . . 1 1 1 . . .                          */
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
 * grows — anchoring the centre keeps a growing ball reading as "coming at
 * you", and the result pop as a uniform swell. */
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

/* Ball scale tracks its speed: |bdx|+|bdy| (1..~5) maps onto 0.75x..1.6x.
 * A faster volley genuinely looms larger — the HARDWARE scale is the speed
 * read-out, not a decoration. */
static unsigned ball_scale(void) {
  unsigned spd = (unsigned)((bdx < 0 ? -bdx : bdx) + (bdy < 0 ? -bdy : bdy));
  if (spd > 6) spd = 6;
  return 0x00C0u + spd * 0x0028u;       /* 0.75x + 0.156x per speed unit */
}

/* Current result-pop scale: 1.0x at rest, swelling to ~2.0x at the peak and
 * easing back. POP drives the SCALING idiom on the result screen. */
#define POP_SCALE_PEAK 0x0200u          /* 2.0x */
static unsigned pop_scale(void) {
  if (pop_timer == 0) return 0x0100u;
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

/* ── GAME LOGIC (clay) — serve: ball to centre, toward the chosen side ── */
static void serve_ball(uint8_t to_left) {
  bx = 78;
  by = 48;
  bdx = to_left ? -2 : 2;
  bdy = ((score_p1 + score_p2) & 1) ? -1 : 1;   /* alternate the angle */
  serve_timer = 30;                              /* half-second breather */
}

/* ── GAME LOGIC (clay) — paint the court (full redraw, every frame) ──────────
 * No hardware tilemap, so the arena is bars + lines: grass fill, end zones,
 * top/bottom rails, the white boundary + dashed centre net + centre circle.
 * Layered tones keep any one colour comfortably under the render-health blank
 * threshold (>=92% one colour reads as "blank"). */
static void draw_court(void) {
  int16_t ny;
  tgi_setcolor(COLOR_GREEN);
  tgi_bar(0, 0, 159, 101);                              /* court grass        */
  tgi_setcolor(COLOR_LIGHTGREEN);
  tgi_bar(0, COURT_TOP, 50, COURT_BOT - 1);             /* left end zone      */
  tgi_bar(109, COURT_TOP, 159, COURT_BOT - 1);          /* right end zone     */
  tgi_setcolor(COLOR_DARKGREY);
  tgi_bar(0, 0, 159, COURT_TOP - 1);                    /* top HUD/rail band  */
  tgi_bar(0, COURT_BOT, 159, 101);                      /* bottom rail        */
  tgi_setcolor(COLOR_WHITE);
  tgi_line(0, COURT_TOP, 159, COURT_TOP);
  tgi_line(0, COURT_BOT, 159, COURT_BOT);
  for (ny = COURT_TOP; ny < COURT_BOT; ny += 8)
    tgi_bar(79, (unsigned)ny, 80,
            (unsigned)(ny + 3 > COURT_BOT ? COURT_BOT : ny + 3));   /* net */
  tgi_line(70, 46, 90, 46);
  tgi_line(70, 66, 90, 66);
  tgi_line(70, 46, 70, 66);
  tgi_line(90, 46, 90, 66);
}

/* Draw the two paddles. */
static void draw_paddles(void) {
  tgi_setcolor(COLOR_YELLOW);
  tgi_bar(PADDLE_X1, (unsigned)p1y, PADDLE_X1 + PADDLE_W - 1,
          (unsigned)(p1y + PADDLE_H - 1));
  tgi_setcolor(COLOR_RED);
  tgi_bar(PADDLE_X2, (unsigned)p2y, PADDLE_X2 + PADDLE_W - 1,
          (unsigned)(p2y + PADDLE_H - 1));
}

/* ── GAME LOGIC (clay) — start a match ── */
static void start_match(void) {
  p1y = 40; p2y = 40;
  score_p1 = 0; score_p2 = 0;
  new_record = 0;
  prev_joy = 0xFF;             /* the button that started the match shouldn't
                               * also count as the first frame's input */
  sfx_tone(0, 80, 8);          /* start chirp */
  serve_ball(0);
  state = ST_PLAY;
}

/* ── GAME LOGIC (clay) — match over: result + record bookkeeping.
 * Persistence choice: for a VERSUS game a raw hi-score is meaningless (every
 * match ends 5-x), so we keep the longest CPU-beating win STREAK — the stat a
 * returning player actually chases — in-session only (see the EEPROM note). */
static void end_match(void) {
  p1_won = (score_p1 >= WIN_SCORE);
  if (p1_won) {
    ++streak;
    if (streak > best_streak) {
      /* ── In-session record ONLY — and here's the honest why. Real Lynx
       * carts persist via a 93Cxx serial EEPROM on the cart PCB (cc65 even
       * ships lynx_eeprom_read/write for it; see vendor/cc65/libsrc/lynx/
       * eeprom.s). PROBED: the bundled handy core emulates CEEPROM internally
       * but its libretro build exposes NO save path — retro_get_memory(
       * SAVE_RAM) returns NULL/size 0, so nothing survives host.hardReset()
       * and a bit-banged round-trip reads back garbage under the WASM build.
       * Wiring the EEPROM to SAVE_RAM is a future core round; until then a
       * fake "save" would be lying. The record DOES survive title↔play cycles
       * within one power-on. ── */
      best_streak = streak;
      new_record = 1;
    }
    sfx_tone(0, 60, 16);        /* victory rise */
  } else {
    streak = 0;                 /* the streak dies with the loss */
    sfx_tone(2, 220, 18);       /* low defeat whistle */
    sfx_noise(12);
  }
  pop_timer = POP_FRAMES;       /* trigger the result SCALE POP */
  state = ST_OVER;
}

/* ── GAME LOGIC (clay) — one point scored ── */
static void score_point(uint8_t for_p1) {
  if (for_p1) ++score_p1; else ++score_p2;
  sfx_noise(6);
  if (score_p1 >= WIN_SCORE || score_p2 >= WIN_SCORE) end_match();
  else serve_ball(for_p1);      /* winner of the point receives */
}

/* ── GAME LOGIC (clay) — paddle hit: deflect by where the ball struck.
 * Centre = flat-ish, edges = steep. A ±1 random "spin" on every return keeps
 * rallies from repeating (see the PRNG note above), so an idle match (you
 * never moving) still ENDS — the CPU eventually wins. */
static void deflect(int16_t paddle_y) {
  int16_t rel = (by + BALL_W / 2) - (paddle_y + PADDLE_H / 2);
  bdy = (int8_t)(rel >> 3);
  bdy += (int8_t)((rand8() & 2) - 1);       /* spin: -1 or +1 */
  if (bdy > 3) bdy = 3;
  if (bdy < -3) bdy = -3;
  if (bdy == 0) bdy = (rel < 0) ? -1 : 1;   /* never return a flat ball */
  sfx_tone(0, 70, 4);
}

/* ── GAME LOGIC (clay) — HUD: scores + labels across the top band ── */
static void draw_hud(void) {
  tgi_setcolor(COLOR_YELLOW);
  tgi_outtextxy(2, 2, "P1");
  numbuf[0] = (char)('0' + score_p1); numbuf[1] = 0;
  tgi_outtextxy(20, 2, numbuf);
  tgi_setcolor(COLOR_RED);
  tgi_outtextxy(136, 2, "CPU");
  numbuf[0] = (char)('0' + score_p2); numbuf[1] = 0;
  tgi_outtextxy(124, 2, numbuf);
  tgi_setcolor(COLOR_LIGHTGREY);
  tgi_outtextxy(56, 2, "WIN");
  numbuf[0] = (char)('0' + WIN_SCORE); numbuf[1] = 0;
  tgi_outtextxy(84, 2, numbuf);
}

/* ── GAME LOGIC (clay) — per-state frames. Each runs INSIDE the canonical
 * loop below: court already painted, tgi_updatedisplay not yet called. ── */

static unsigned attract_phase;

static void frame_title(uint8_t joy) {
  /* attract: a lone ball in the title's clear zone pulses via the SCALING
   * idiom — the same swell the speed-scaled ball + result pop use, shown off
   * on the menu. */
  unsigned t = attract_phase < 64 ? attract_phase : (127 - attract_phase);
  unsigned s = 0x00C0u + (t * (0x0220u - 0x00C0u)) / 63u;   /* 0.75x..2.13x */
  attract_phase = (attract_phase + 2) & 127;
  draw_sprite(spr_ball, 80, 34, COLOR_WHITE, s);            /* breathing ball */

  tgi_setcolor(COLOR_WHITE);
  tgi_outtextxy(8, 18, GAME_TITLE);
  tgi_setcolor(COLOR_YELLOW);
  tgi_outtextxy(48, 52, "PRESS A");
  tgi_setcolor(COLOR_LIGHTGREY);
  tgi_outtextxy(36, 66, "BEST ");
  numbuf[0] = (char)('0' + (best_streak > 9 ? 9 : best_streak)); numbuf[1] = 0;
  tgi_outtextxy(76, 66, numbuf);
  tgi_outtextxy(20, 80, "1P VS CPU");        /* handheld honesty             */

  if (JOY_BTN_1(joy) && !JOY_BTN_1(prev_joy)) start_match();
}

static void frame_over(uint8_t joy) {
  unsigned ps = pop_scale();
  draw_paddles();
  /* the SCALE POP: a winner glyph swells then eases back to 1.0x */
  if (p1_won) draw_sprite(spr_cup, 80, 40, COLOR_YELLOW, ps);
  else        draw_sprite(spr_ball, 80, 40, COLOR_RED, ps);
  if (pop_timer) pop_timer--;

  tgi_setcolor(COLOR_DARKGREY);
  tgi_bar(28, 54, 131, 96);
  tgi_setcolor(COLOR_WHITE);
  tgi_outtextxy(44, 58, "GAME OVER");
  tgi_setcolor(p1_won ? COLOR_LIGHTGREEN : COLOR_RED);
  tgi_outtextxy(40, 68, p1_won ? "YOU WIN" : "CPU WINS");
  if (new_record) { tgi_setcolor(COLOR_YELLOW); tgi_outtextxy(36, 78, "NEW RECORD"); }
  else { tgi_setcolor(COLOR_LIGHTGREY); tgi_outtextxy(44, 78, "A = TITLE"); }
  tgi_setcolor(COLOR_LIGHTGREY);
  tgi_outtextxy(40, 88, "SCORE ");
  numbuf[0] = (char)('0' + score_p1); numbuf[1] = '-';
  numbuf[2] = (char)('0' + score_p2); numbuf[3] = 0;
  tgi_outtextxy(88, 88, numbuf);

  if (JOY_BTN_1(joy) && !JOY_BTN_1(prev_joy)) state = ST_TITLE;
}

static void frame_play(uint8_t joy) {
  /* ── draw: paddles, the SPEED-SCALED ball (Suzy), HUD ── */
  draw_paddles();
  draw_sprite(spr_ball, (int)bx + BALL_W / 2, (int)by + BALL_W / 2,
              COLOR_WHITE, ball_scale());
  draw_hud();

  /* ── update ── */
  rand8();                       /* tick the noise source every play frame */

  /* you — UP/DOWN, 2px/frame */
  if ((joy & JOY_UP_MASK)   && p1y > COURT_TOP)            p1y -= 2;
  if ((joy & JOY_DOWN_MASK) && p1y < COURT_BOT - PADDLE_H) p1y += 2;

  /* CPU — chases the ball centre at 1px/frame (half your speed) with a small
   * dead zone. Beatable by design: steep edge deflections outrun it. */
  {
    int16_t target = by + BALL_W / 2 - PADDLE_H / 2;
    if (p2y + 2 < target && p2y < COURT_BOT - PADDLE_H) p2y += 1;
    else if (p2y > target + 2 && p2y > COURT_TOP)       p2y -= 1;
  }

  /* ball frozen during the post-point serve pause */
  if (serve_timer > 0) { --serve_timer; return; }
  bx += bdx;
  by += bdy;

  /* rail bounce */
  if (by < COURT_TOP)              { by = COURT_TOP;          bdy = -bdy; sfx_tone(2, 90, 3); }
  if (by + BALL_W > COURT_BOT)     { by = COURT_BOT - BALL_W; bdy = -bdy; sfx_tone(2, 90, 3); }

  /* paddle collisions (direction-gated so the ball can't double-hit) */
  if (bdx < 0
      && bx <= PADDLE_X1 + PADDLE_W && bx + BALL_W >= PADDLE_X1
      && by + BALL_W > p1y && by < p1y + PADDLE_H) {
    bdx = -bdx; bx = PADDLE_X1 + PADDLE_W; deflect(p1y);
  }
  if (bdx > 0
      && bx + BALL_W >= PADDLE_X2 && bx <= PADDLE_X2 + PADDLE_W
      && by + BALL_W > p2y && by < p2y + PADDLE_H) {
    bdx = -bdx; bx = PADDLE_X2 - BALL_W; deflect(p2y);
  }

  /* off either side → point */
  if (bx < -BALL_W) score_point(0);    /* past you → CPU scores */
  if (bx > 160)     score_point(1);    /* past CPU → you score  */
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
  best_streak = 0;
  streak = 0;
  p1_won = 0;

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
     *      hardware tilemap, the COURT is repainted every frame.
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

    draw_court();

    joy = joy_read(JOY_1);

    if      (state == ST_TITLE) frame_title(joy);
    else if (state == ST_PLAY)  frame_play(joy);
    else                        frame_over(joy);

    tgi_updatedisplay();
    sfx_update();

    prev_joy = joy;
  }
}
