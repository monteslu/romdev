/* ── racing.c — GameTank top-down road racer (complete example) ──────────────
 *
 * A COMPLETE, working game on the bundled GameTank SDK draw-queue runtime: a
 * vertically-scrolling road with moving lane stripes, your car steering between
 * lanes, rival cars + obstacles to dodge, a distance score that climbs with
 * speed, and crash → lives → restart. The framebuffer makes the scrolling road
 * EASY — the stripes are rects at a moving y-offset; no scroll register, no
 * tilemap streaming.
 *
 * FORK THIS. Markers:
 *   HARDWARE IDIOM (load-bearing) — the "scroll" is a phase counter; road, stripes
 *     and rivals are rects drawn at (phase-shifted) y each frame. The road slab is
 *     drawn at HEIGHT 127, never 128: a full-screen-dimension box is silently
 *     dropped by the blitter (the road would vanish — see gt_draw.h).
 *   GAME LOGIC (clay) — speed curve, spawn rate, lane count, scoring: tune freely.
 *
 * High-contrast palette (dark asphalt vs bright grass) so the road reads clearly.
 * SFX (gt_sound.h): a crash explosion when you hit a rival. Box-drawn HUD.
 * SCREEN: 128x128. PLAYERS: 1. CONTROLS: ←/→ steer · A throttle · A/START to begin.
 */
#include "gametank.h"
#include "draw_queue.h"
#include "input.h"

#include "gt_palette.h"
#include "gt_draw.h"
#include "gt_hud.h"
#include "gt_sound.h"

/* high-contrast palette: DARK road against BRIGHT grass, bright stripes/edges, and
 * vivid distinct cars so everything reads clearly. */
#define C_GRASS  GT_GREEN     /* bright green roadside */
#define C_ROAD   GT_NIGHT     /* near-black asphalt (pops against the grass) */
#define C_STRIPE GT_YELLOW    /* bright lane stripes */
#define C_EDGE   GT_WHITE     /* white road edges */
#define C_CAR    GT_CYAN      /* player car (bright cyan) */
#define C_RIVAL  GT_RED       /* rival cars */
#define C_RIVAL2 GT_MAGENTA   /* alt rival (vivid, distinct from red) */
#define C_HUD    GT_WHITE

#define ROAD_X   24          /* road left edge */
#define ROAD_W   80          /* road width (24..104) */
#define N_RIVAL  4

static unsigned char car_x;          /* player car left edge */
static unsigned char rvx[N_RIVAL], rvy[N_RIVAL], rvc[N_RIVAL], rv_on[N_RIVAL];
static unsigned int  score;
static unsigned char lives, phase, speed, spawn_t;

static void reset_game(void) {
  unsigned char i;
  car_x = 56; score = 0; lives = 3; phase = 0; speed = 3; spawn_t = 0;
  for (i = 0; i < N_RIVAL; i++) rv_on[i] = 0;
}

static unsigned char absd(unsigned char a, unsigned char b) { return a > b ? a - b : b - a; }

static void spawn_rival(void) {
  unsigned char i;
  for (i = 0; i < N_RIVAL; i++) if (!rv_on[i]) {
    rvx[i] = ROAD_X + 6 + (unsigned char)(rnd8() % (ROAD_W - 24));
    rvy[i] = 0; rvc[i] = (unsigned char)(rnd8() & 1); rv_on[i] = 1; return;
  }
}

static unsigned char title_or_over(unsigned char over) {
  gt_start_reset();
  while (1) {
    gt_clear(C_GRASS);
    gt_rect(ROAD_X, 0, ROAD_W, 127, C_ROAD);
    if (!over) {
      gt_rect(30, 38, 68, 10, C_STRIPE);
      gt_rect(54, 70, 14, 22, C_CAR);          /* car */
      gt_rect(ROAD_X + ROAD_W / 2 - 1, 100, 2, 12, C_STRIPE);
    } else { gt_rect(26, 52, 76, 24, C_GRASS); hud_number(score, 70, 58, 3, C_HUD); }
     gt_present(); gt_music_tick(); 
    update_inputs();
    if (gt_start_pressed()) return 1;
  }
}

void main(void) {
  unsigned char i, y;
  reset_game();

  for (;;) {
    title_or_over(0);
    reset_game();

    for (;;) {
      update_inputs();

      /* steer (clamped to the road) — a soft tick on each steer input */
      if ((player1_buttons & INPUT_MASK_LEFT)  && car_x > ROAD_X + 2)            car_x -= 3;
      if ((player1_buttons & INPUT_MASK_RIGHT) && car_x < ROAD_X + ROAD_W - 16)  car_x += 3;
      /* throttle with A = faster (more score, more danger) */
      speed = (player1_buttons & INPUT_MASK_A) ? 5 : 3;

      phase = (phase + speed) & 0x1F;
      score += speed;

      /* rivals */
      spawn_t++;
      if (spawn_t >= (speed > 4 ? 24 : 36)) { spawn_t = 0; spawn_rival(); }
      for (i = 0; i < N_RIVAL; i++) if (rv_on[i]) {
        rvy[i] += speed;
        if (rvy[i] > 124) { rv_on[i] = 0; score += 10; }   /* dodged (no sound) */
        else if (rvy[i] + 20 >= 92 && rvy[i] <= 114 && absd(rvx[i], car_x) < 14) {
          rv_on[i] = 0; gt_sfx(GT_SFX_EXPLODE);                                  /* CRASH */
          if (--lives == 0) goto dead;
        }
      }

      /* ── HARDWARE IDIOM: grass + road + moving stripes + cars, all rects ── */
      gt_clear(C_GRASS);
      gt_rect(ROAD_X, 0, ROAD_W, 127, C_ROAD);
      /* center dashes scroll by phase */
      for (y = 0; y < 128; y += 16) {
        unsigned char yy = (y + phase) & 0x7F;
        gt_rect(ROAD_X + ROAD_W / 2 - 1, yy, 2, 8, C_STRIPE);
      }
      /* road edges */
      gt_rect(ROAD_X - 2, 0, 2, 128, C_EDGE);
      gt_rect(ROAD_X + ROAD_W, 0, 2, 128, C_EDGE);
      for (i = 0; i < N_RIVAL; i++) if (rv_on[i])
        gt_rect(rvx[i], rvy[i], 14, 20, rvc[i] ? C_RIVAL : C_RIVAL2);
      gt_rect(car_x, 92, 14, 22, C_CAR);          /* player car */
      gt_rect(car_x + 3, 96, 8, 6, GT_DKBLUE);     /* windshield */
      hud_number(score, 28, 8, 2, C_HUD);
      hud_pips(lives, 100, 8, 5, C_CAR);
      /* Re-clean the top BORDER (rows 0-6) LAST so the full-height road edges don't
       * leave a stray flickering line on the framebuffer's top scanline. */
      queue_clear_border(C_GRASS);
      gt_present(); gt_music_tick();
    }
  dead:
    title_or_over(1);
  }
}
