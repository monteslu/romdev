/* ── shmup.c — Atari Lynx depth-dive shooter (complete example game) ─────────
 *
 * A COMPLETE, working game — title screen, score + lives, in-session
 * hi-score, MIKEY music + SFX, and the Lynx's signature party trick:
 * HARDWARE SPRITE SCALING. Enemies dive at you out of the horizon and
 * Suzy (the blitter) scales them up in HARDWARE as they approach —
 * far = tiny speck, near = looming hull — by changing two 8.8 fixed-point
 * fields in the sprite's control block. No CPU pixel work at all.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented Lynx footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — enemy patterns, scoring, tuning, art: reshape freely.
 *
 * What depends on what:
 *   lynx_sfx.{h,c} — MIKEY 4-voice audio (voice 0 = player SFX, voice 1 =
 *     background melody, voice 2 = impact SFX, voice 3 = noise/explosions).
 *   vendor/cc65/libsrc/lynx/ — the FULL cc65 Lynx driver source shipped into
 *     your project. The TGI driver (tgi/lynx-160-102-16.s) is REQUIRED
 *     reading when graphics misbehave: every TGI call is itself a Suzy
 *     sprite, and our scaled sprites ride the same engine via tgi_ioctl(0).
 *
 * PLAYERS: 1. This is a handheld — multiplayer on real hardware is ComLynx,
 *   a cable between TWO Lynx units. A single emulator instance has nobody on
 *   the other end of the cable, so this example is honestly single-player
 *   (no fake "P2" that could never work).
 *
 * SCREEN: 160x102. The system font is 8x8, so a full row of text is 20
 *   characters — keep HUD lines short and the layout compact.
 */

#include <tgi.h>
#include <joystick.h>
#include <lynx.h>
#include <stdint.h>
#include "lynx_sfx.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it <=16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "VOID PLUNGE"

/* ── GAME LOGIC (clay — reshape freely) — object pools & tuning ───────────── */
#define MAX_BULLETS   4
#define MAX_ENEMIES   4
#define START_LIVES   3

/* The depth corridor enemies dive through (screen-Y is our depth axis):
 * Y_FAR is the horizon (vanishing band), Y_NEAR is "in your face". */
#define Y_FAR        22
#define Y_NEAR       97
#define DEPTH_SPAN   (Y_NEAR - Y_FAR)              /* 75 px of travel */

/* Suzy scale (8.8 fixed point: $0100 = 1.0 = one screen pixel per texel).
 * The 8x8 art renders 2 px wide at the horizon and 20 px wide up close —
 * a 10x growth you can't miss, and the hardware does ALL of it. */
#define SCALE_FAR    0x0040u                       /* 0.25x →  2 px */
#define SCALE_NEAR   0x0280u                       /* 2.50x → 20 px */
#define SHIP_SCALE   0x0200u                       /* your ship: fixed 2x */

typedef struct { uint8_t alive; uint8_t lane; unsigned y_fp; } Enemy;
typedef struct { uint8_t alive; uint8_t x, y; } Bullet;

static Enemy   enemies[MAX_ENEMIES];
static Bullet  bullets[MAX_BULLETS];
static uint8_t ship_x, ship_y;          /* ship CENTER (sprites draw centered) */
static uint8_t lives, level, kills;
static unsigned score;
static unsigned hiscore;                /* in-session only — see EEPROM note */
static unsigned enemy_speed;            /* 8.8 px/frame down the corridor */
static uint8_t  spawn_interval, spawn_timer;
static uint8_t  fire_cd, hurt_timer;
static uint8_t  prev_joy;

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;
static uint8_t over_new_hi;

/* ── GAME LOGIC (clay) — Galois LFSR (taps $B8), period 255 ── */
static uint8_t rng_state = 0xA5;
static uint8_t rand8(void) {
  uint8_t lsb = (uint8_t)(rng_state & 1);
  rng_state >>= 1;
  if (lsb) rng_state ^= 0xB8;
  return rng_state;
}

/* Scrolling starfield so the dark space field is never one flat colour
 * (a >=92% single-colour frame trips the render-health audit as "blank"). */
#define N_STARS 24
static uint8_t star_x[N_STARS];
static uint8_t star_y[N_STARS];

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * SUZY HARDWARE SPRITE SCALING — the Lynx signature. Suzy renders every
 * sprite through a Sprite Control Block (SCB) it walks in cart/work RAM.
 * Two SCB fields, HSIZE and VSIZE, are 8.8 fixed-point scale factors
 * ($0100 = 1.0): the SAME 8x8 source pixels render at any size, every
 * frame, for free. That is this whole game's depth illusion.
 *
 * The SCB, field by field (this is cc65's SCB_REHV_PAL from <_suzy.h>):
 *   sprctl0  %BBxx
 *            bits 7-6 = bits per pixel (11 = 4bpp), bits 2-0 = sprite TYPE.
 *            TYPE_NORMAL (4) draws pens 1-15 and treats pen 0 as
 *            TRANSPARENT — that's how shaped sprites sit over the field.
 *   sprctl1  bit 7 LITERAL (data below is raw nybbles, no RLE packets) +
 *            bits 5-4 reload depth: REHV means "this SCB carries HPOS,
 *            VPOS, HSIZE, VSIZE". The reload bits ARE the struct layout —
 *            mismatch them and Suzy reads palette bytes as size words.
 *   sprcoll  $20 = NO_COLLIDE. We do gameplay collision in C (in DEPTH
 *            coordinates, which the collision buffer knows nothing about).
 *   next     pointer to the next SCB, 0 = end of chain. One blit per call
 *            here; chain SCBs and one SPRGO draws them all.
 *   data     sprite pixel data (format below).
 *   hpos/vpos signed SCREEN position of the sprite's top-left corner.
 *   hsize/vsize 8.8 scale — THE party trick. We recompute these every
 *            frame from each enemy's depth.
 *   penpal[8] 16 nybbles mapping pixel values 0-15 → palette pens
 *            (identity here; sprite art can be recoloured per-SCB for free
 *            — e.g. one art block, four enemy colours).
 *
 * LITERAL 4bpp data format (hand-encodable): each sprite LINE is
 *   [offset byte][width/2 bytes of raw nybble pixels]
 * where offset = 1 + bytes of pixel data (Suzy adds it to find the next
 * line), and a final offset of 0 ends the sprite. 8 px @ 4bpp = 4 data
 * bytes, so every line starts with 5. (The packed/RLE format is what
 * sprpck emits; literal is friendlier to author by hand.)
 *
 * Drawing: tgi_sprite(&scb) → tgi_ioctl(0, &scb) — the TGI driver's
 * documented escape hatch (see CONTROL in vendor/cc65/libsrc/lynx/tgi/
 * lynx-160-102-16.s). It points Suzy's SCBNEXT at your SCB, aims VIDBAS
 * at TGI's current DRAW page (so scaled sprites land in the same
 * double-buffered frame as tgi_bar/tgi_outtextxy), fires SPRGO, and
 * sleeps the CPU until SPRSYS reports the blit done.
 *
 * Requires: the cc65 crt0 Suzy init (SUZYBUSEN=1, SPRSYS, HOFF/VOFF=0 —
 *   already done before main()), and calls only between the tgi_busy()
 *   wait and tgi_updatedisplay() — i.e. while TGI's draw buffer is the
 *   blit target. Draw order = paint order: background bars first, scaled
 *   sprites after, HUD text last.
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

/* Draw an 8x8 literal sprite CENTERED on (cx,cy) at the given 8.8 scale.
 * Centering matters: hpos/vpos are the TOP-LEFT, so a sprite scaled around
 * its corner would slide right/down as it grows. Anchoring the centre keeps
 * the dive reading as "coming straight at you". */
static void draw_scaled(unsigned char *data, int cx, int cy, unsigned scale) {
  unsigned w = scale >> 5;              /* on-screen size: (8 * scale) >> 8 */
  if (w == 0) w = 1;
  scb.data  = data;
  scb.hsize = scale;
  scb.vsize = scale;
  scb.hpos  = cx - (int)(w >> 1);
  scb.vpos  = cy - (int)(w >> 1);
  tgi_sprite(&scb);
}

/* ── GAME LOGIC (clay) — 8x8 4bpp literal sprite art ────────────────────────
 * Pens use the TGI default palette: 2 = red, 3 = pink, 9 = yellow,
 * $D = blue, $F = white, 0 = transparent. Each line: 5, then 4 nybble
 * bytes; final 0 byte ends the sprite (format in the idiom block above). */
static unsigned char spr_enemy[] = {
  5, 0x00, 0x02, 0x20, 0x00,     /* . . . 2 2 . . .  red diver, pink core */
  5, 0x00, 0x23, 0x32, 0x00,     /* . . 2 3 3 2 . .                       */
  5, 0x02, 0x3F, 0xF3, 0x20,     /* . 2 3 F F 3 2 .                       */
  5, 0x22, 0x3F, 0xF3, 0x22,     /* 2 2 3 F F 3 2 2                       */
  5, 0x23, 0x33, 0x33, 0x32,     /* 2 3 3 3 3 3 3 2                       */
  5, 0x02, 0x23, 0x32, 0x20,     /* . 2 2 3 3 2 2 .                       */
  5, 0x00, 0x22, 0x22, 0x00,     /* . . 2 2 2 2 . .                       */
  5, 0x00, 0x02, 0x20, 0x00,     /* . . . 2 2 . . .                       */
  0
};
static unsigned char spr_ship[] = {
  5, 0x00, 0x0F, 0xF0, 0x00,     /* . . . F F . . .  yellow interceptor   */
  5, 0x00, 0x09, 0x90, 0x00,     /* . . . 9 9 . . .                       */
  5, 0x00, 0x99, 0x99, 0x00,     /* . . 9 9 9 9 . .                       */
  5, 0x00, 0x9D, 0xD9, 0x00,     /* . . 9 D D 9 . .                       */
  5, 0x09, 0x9D, 0xD9, 0x90,     /* . 9 9 D D 9 9 .                       */
  5, 0x99, 0x99, 0x99, 0x99,     /* 9 9 9 9 9 9 9 9                       */
  5, 0x90, 0x9D, 0xD9, 0x09,     /* 9 . 9 D D 9 . 9                       */
  5, 0x00, 0xD0, 0x0D, 0x00,     /* . . D . . D . .                       */
  0
};

/* ── GAME LOGIC (clay) — depth → screen mapping ─────────────────────────────
 * Screen-Y doubles as the depth axis: an enemy at the horizon (Y_FAR) is
 * far away; at Y_NEAR it has reached you. Scale and X both interpolate on
 * the same depth fraction, so divers fan OUT of the vanishing point toward
 * their lane while they grow — a poor man's perspective projection. */
static unsigned scale_for_y(uint8_t y) {
  unsigned span = (unsigned)(y - Y_FAR);
  return SCALE_FAR + (span * (SCALE_NEAR - SCALE_FAR)) / DEPTH_SPAN;
}
static uint8_t enemy_screen_x(const Enemy *e) {
  uint8_t y = (uint8_t)(e->y_fp >> 8);
  int span = (int)(y - Y_FAR);
  return (uint8_t)(80 + ((int)(e->lane - 80) * span) / DEPTH_SPAN);
}
/* Current half-width in pixels (collision box tracks the HARDWARE scale —
 * a far speck is genuinely harder to hit than a looming hull). */
static uint8_t enemy_half(const Enemy *e) {
  return (uint8_t)(scale_for_y((uint8_t)(e->y_fp >> 8)) >> 6);  /* (w/2) */
}

static void spawn_enemy(void) {
  uint8_t i;
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemies[i].alive) {
      enemies[i].alive = 1;
      enemies[i].lane = (uint8_t)(14 + (rand8() % 132));  /* target column */
      enemies[i].y_fp = (unsigned)Y_FAR << 8;
      return;
    }
  }
}

static void fire_bullet(void) {
  uint8_t i;
  for (i = 0; i < MAX_BULLETS; i++) {
    if (!bullets[i].alive) {
      bullets[i].alive = 1;
      bullets[i].x = ship_x;
      bullets[i].y = ship_y - 8;
      sfx_tone(0, 70, 4);                 /* voice 0: pew */
      return;
    }
  }
}

/* ── GAME LOGIC (clay) — score text (no sprintf: it drags in ~6KB) ── */
static char numbuf[6];
static char *fmt5(unsigned v) {
  uint8_t i;
  for (i = 0; i < 5; i++) { numbuf[4 - i] = (char)('0' + v % 10); v /= 10; }
  numbuf[5] = 0;
  return numbuf;
}

/* ── GAME LOGIC (clay) — shared scene painter (runs every frame) ────────────
 * Full-redraw, painter's order: space field, horizon bands, stars, then the
 * caller layers sprites + text on top. Layered bands keep any one colour
 * comfortably under the render-health blank threshold. */
static void draw_scene(void) {
  uint8_t i;
  tgi_setcolor(COLOR_BLACK);
  tgi_bar(0, 0, 159, 101);                          /* deep space          */
  tgi_setcolor(COLOR_DARKGREY);
  tgi_bar(0, 0, 159, 8);                            /* HUD bar             */
  tgi_bar(0, Y_FAR - 4, 159, Y_FAR - 3);            /* horizon glow, outer */
  tgi_setcolor(COLOR_PURPLE);
  tgi_bar(0, Y_FAR - 2, 159, Y_FAR - 1);            /* horizon glow, inner */
  tgi_setcolor(COLOR_WHITE);
  for (i = 0; i < N_STARS; i++) {
    tgi_setpixel(star_x[i], star_y[i]);
    tgi_setpixel(star_x[i], (uint8_t)((star_y[i] + 1) % 102));
  }
}
static void drift_stars(void) {
  uint8_t i;
  for (i = 0; i < N_STARS; i++) {
    if (star_y[i] >= 101) { star_y[i] = Y_FAR; star_x[i] = (uint8_t)(rand8() % 160); }
    else star_y[i]++;
  }
}

/* ── GAME LOGIC (clay) — start a run ── */
static void start_game(void) {
  uint8_t i;
  for (i = 0; i < MAX_BULLETS; i++) bullets[i].alive = 0;
  for (i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = 0;
  ship_x = 80; ship_y = 92;
  lives = START_LIVES; level = 1; kills = 0;
  score = 0;
  enemy_speed = 0x00B0;             /* 0.69 px/frame — ~109-frame dives  */
  spawn_interval = 120;             /* level 1: one diver at a time      */
  spawn_timer = 30;
  fire_cd = 0; hurt_timer = 0;
  state = ST_PLAY;
}

static void game_over(void) {
  over_new_hi = 0;
  if (score > hiscore) {
    /* ── In-session hi-score ONLY — and here's the honest why. Real Lynx
     * carts persist via a 93Cxx serial EEPROM on the cart PCB (cc65 even
     * ships lynx_eeprom_read/write for it — bit-banged over A7/A1/AUDIN;
     * see vendor/cc65/libsrc/lynx/eeprom.s). PROBED 2026-06: the bundled
     * handy core emulates CEEPROM internally but its libretro build
     * exposes NO save path — retro_get_memory(SAVE_RAM) returns
     * NULL/size 0, so nothing can survive host.hardReset(), and the
     * bit-banged round-trip reads back garbage under the WASM build.
     * Wiring the EEPROM to SAVE_RAM is a future core round; until then a
     * fake "save" would be lying. The hi-score DOES survive title↔play
     * cycles within one power-on. ── */
    hiscore = score;
    over_new_hi = 1;
  }
  sfx_tone(2, 240, 24);             /* voice 2: low game-over drone */
  state = ST_OVER;
}

/* ── GAME LOGIC (clay) — per-state frames. Each runs INSIDE the canonical
 * loop below: scene already painted, tgi_updatedisplay not yet called. ── */

static unsigned attract_y_fp = (unsigned)Y_FAR << 8;
static uint8_t  attract_lane = 120;

static void frame_title(uint8_t joy) {
  uint8_t ty;
  /* Attract demo: one enemy dives on a loop — the scaling idiom IS the
   * title screen's pitch. */
  attract_y_fp += 0x00C0;
  ty = (uint8_t)(attract_y_fp >> 8);
  if (ty >= Y_NEAR) { attract_y_fp = (unsigned)Y_FAR << 8; attract_lane = (uint8_t)(30 + (rand8() % 100)); }
  else {
    Enemy demo;
    demo.lane = attract_lane; demo.y_fp = attract_y_fp;
    draw_scaled(spr_enemy, enemy_screen_x(&demo), ty, scale_for_y(ty));
  }
  draw_scaled(spr_ship, 80, 92, SHIP_SCALE);

  tgi_setcolor(COLOR_WHITE);
  tgi_outtextxy(36, 1, GAME_TITLE);                  /* on the HUD bar     */
  tgi_setcolor(COLOR_YELLOW);
  tgi_outtextxy(48, 38, "PRESS A");
  tgi_setcolor(COLOR_LIGHTGREY);
  tgi_outtextxy(28, 50, "HI ");
  tgi_outtextxy(52, 50, fmt5(hiscore));
  tgi_outtextxy(24, 62, "1 PLAYER GAME");           /* handheld honesty   */

  if (JOY_BTN_1(joy) && !JOY_BTN_1(prev_joy)) start_game();
}

static void frame_over(uint8_t joy) {
  tgi_setcolor(COLOR_DARKGREY);
  tgi_bar(20, 34, 139, 70);
  tgi_setcolor(COLOR_WHITE);
  tgi_outtextxy(44, 38, "GAME OVER");
  tgi_setcolor(COLOR_YELLOW);
  tgi_outtextxy(36, 48, "SCORE ");
  tgi_outtextxy(84, 48, fmt5(score));
  if (over_new_hi) { tgi_setcolor(COLOR_LIGHTGREEN); tgi_outtextxy(32, 58, "NEW HI SCORE"); }
  else { tgi_setcolor(COLOR_LIGHTGREY); tgi_outtextxy(36, 58, "A = TITLE"); }
  if (JOY_BTN_1(joy) && !JOY_BTN_1(prev_joy)) state = ST_TITLE;
}

static void frame_play(uint8_t joy) {
  uint8_t i, j, ex, ey, hw;

  /* ── draw: enemies (each rescaled from its depth EVERY frame), ship,
   * bullets, HUD ── */
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemies[i].alive) continue;
    ey = (uint8_t)(enemies[i].y_fp >> 8);
    draw_scaled(spr_enemy, enemy_screen_x(&enemies[i]), ey, scale_for_y(ey));
  }
  if (hurt_timer == 0 || (hurt_timer & 4))           /* blink while hurt   */
    draw_scaled(spr_ship, ship_x, ship_y, SHIP_SCALE);
  tgi_setcolor(COLOR_WHITE);
  for (i = 0; i < MAX_BULLETS; i++)
    if (bullets[i].alive)
      tgi_bar(bullets[i].x - 1, bullets[i].y - 2, bullets[i].x, bullets[i].y + 1);

  tgi_setcolor(COLOR_WHITE);
  tgi_outtextxy(2, 1, "SC");
  tgi_outtextxy(20, 1, fmt5(score));
  tgi_setcolor(COLOR_LIGHTGREY);
  tgi_outtextxy(66, 1, "HI");
  tgi_outtextxy(84, 1, fmt5(hiscore));
  tgi_setcolor(COLOR_YELLOW);
  tgi_outtextxy(132, 1, "L");
  numbuf[0] = (char)('0' + lives); numbuf[1] = 0;
  tgi_outtextxy(140, 1, numbuf);

  /* ── update: ship ── */
  if ((joy & JOY_LEFT_MASK)  && ship_x > 9)   ship_x -= 2;
  if ((joy & JOY_RIGHT_MASK) && ship_x < 150) ship_x += 2;
  if ((joy & JOY_UP_MASK)    && ship_y > 70)  ship_y--;
  if ((joy & JOY_DOWN_MASK)  && ship_y < 96)  ship_y++;
  if (JOY_BTN_1(joy) && fire_cd == 0) { fire_bullet(); fire_cd = 8; }
  if (fire_cd) fire_cd--;
  if (hurt_timer) hurt_timer--;

  /* bullets fly "away" up the corridor */
  for (i = 0; i < MAX_BULLETS; i++) {
    if (!bullets[i].alive) continue;
    if (bullets[i].y < Y_FAR + 3) { bullets[i].alive = 0; continue; }
    bullets[i].y -= 3;
  }

  /* enemies dive (subpixel 8.8 speed) */
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemies[i].alive) continue;
    enemies[i].y_fp += enemy_speed;
    ey = (uint8_t)(enemies[i].y_fp >> 8);
    if (ey >= Y_NEAR) {
      /* Reached your depth plane: ram you, or whoosh past. */
      ex = enemy_screen_x(&enemies[i]);
      hw = enemy_half(&enemies[i]);
      enemies[i].alive = 0;
      if (hurt_timer == 0
          && (uint8_t)(ex > ship_x ? ex - ship_x : ship_x - ex) < hw + 7
          && (uint8_t)(ey > ship_y ? ey - ship_y : ship_y - ey) < hw + 6) {
        sfx_tone(2, 220, 10);                        /* voice 2: thump     */
        sfx_noise(12);                               /* voice 3: crunch    */
        hurt_timer = 45;
        if (lives) lives--;
        if (lives == 0) { game_over(); return; }
      }
    }
  }

  /* bullets vs enemies — in the SCALED box: the hitbox grows with the
   * hardware sprite, so range determines difficulty (far 3pt speck, mid
   * 2pt, near 1pt barn door). */
  for (i = 0; i < MAX_BULLETS; i++) {
    if (!bullets[i].alive) continue;
    for (j = 0; j < MAX_ENEMIES; j++) {
      if (!enemies[j].alive) continue;
      ex = enemy_screen_x(&enemies[j]);
      ey = (uint8_t)(enemies[j].y_fp >> 8);
      hw = enemy_half(&enemies[j]);
      if ((uint8_t)(bullets[i].x > ex ? bullets[i].x - ex : ex - bullets[i].x) < hw + 2
          && (uint8_t)(bullets[i].y > ey ? bullets[i].y - ey : ey - bullets[i].y) < hw + 3) {
        bullets[i].alive = 0;
        enemies[j].alive = 0;
        sfx_noise(8);                                /* voice 3: boom      */
        score += (ey < Y_FAR + 25) ? 3 : (ey < Y_FAR + 50) ? 2 : 1;
        kills++;
        if (kills >= 10) {                           /* level ramp         */
          kills = 0;
          level++;
          if (enemy_speed < 0x0200) enemy_speed += 0x18;
          if (spawn_interval > 40) spawn_interval -= 10;
        }
        break;
      }
    }
  }

  if (spawn_timer == 0) { spawn_timer = spawn_interval; spawn_enemy(); }
  else spawn_timer--;
}

void main(void) {
  uint8_t joy, i;
  uint32_t srng = 0x1234;

  tgi_install(&lynx_160_102_16_tgi);
  tgi_init();
  joy_install(&lynx_stdjoy_joy);
  sfx_init();          /* MIKEY up; background melody starts on voice 1 */

  for (i = 0; i < N_STARS; i++) {
    srng = srng * 1103515245u + 12345u;
    star_x[i] = (uint8_t)((srng >> 16) % 160);
    srng = srng * 1103515245u + 12345u;
    star_y[i] = (uint8_t)(Y_FAR + ((srng >> 16) % (102 - Y_FAR)));
  }
  state = ST_TITLE;
  prev_joy = 0;

  for (;;) {
    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * CANONICAL LYNX GAME LOOP — full-redraw every frame, in this order:
     *   1. while (tgi_busy()) { }  — WAIT for the previous frame's page
     *      flip. Skipping this is the #1 "Lynx screen stays blank" trap:
     *      drawing while the swap is pending loses the frame.
     *   2. Repaint the WHOLE scene with tgi_bar fills — NOT tgi_clear()
     *      (which can leave the framebuffer stale on this toolchain+
     *      emulator path). TGI double-buffers; the back buffer holds the
     *      frame from two flips ago, so partial redraws ghost.
     *   3. Draw every object (every TGI call and every tgi_sprite() is a
     *      synchronous Suzy blit into the SAME draw page).
     *   4. tgi_updatedisplay() — request the page flip at next VBL.
     *   5. sfx_update() IMMEDIATELY after — MIKEY voice writes must land
     *      in vblank: handy reschedules its timer sweep on the spot when
     *      a voice CTL bit-3 write lands, and mid-frame that sweep can
     *      preempt an in-flight Suzy blit and eat sprites (the R57 bug —
     *      history in lynx_sfx.c). sfx_tone()/sfx_noise() only STAGE;
     *      sfx_update() is the hardware flush. */
    while (tgi_busy()) { }

    draw_scene();
    joy = joy_read(JOY_1);

    if      (state == ST_TITLE) frame_title(joy);
    else if (state == ST_PLAY)  frame_play(joy);
    else                        frame_over(joy);

    tgi_updatedisplay();
    sfx_update();

    drift_stars();
    prev_joy = joy;
  }
}
