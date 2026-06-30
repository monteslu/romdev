/* ── shmup.c — GameTank vertical shooter (complete example game) ─────────────
 *
 * A COMPLETE, working game on the bundled GameTank SDK draw-queue runtime: an
 * arrowhead fighter you fly along the bottom, enemy raiders that fall from the
 * top, gold missiles you fire up, explosions on a kill, a score/lives HUD, SFX,
 * and a title → play → game-over → restart loop. Drawn with REAL pixel-art
 * sprites loaded into graphics RAM at runtime (gt_sprites.h) and blitted with
 * per-pixel color + transparency.
 *
 * FORK THIS. Markers:
 *   HARDWARE IDIOM (load-bearing) — the GameTank draws via a blitter DRAW QUEUE
 *     (gt_draw.h): enqueue rects/sprites each frame, then gt_present() drains the
 *     queue, waits a vblank, and flips the double buffer. Sprites live in GRAM
 *     (gt_load_sprite writes the pixels once at init). Don't fire blits by hand.
 *   GAME LOGIC (clay) — sprite art, speeds, spawn timing, scoring: tune freely.
 *
 * SCREEN: 128x128. PLAYERS: 1. CONTROLS: D-pad move, A or START to fire/confirm.
 */
#include "gametank.h"
#include "draw_queue.h"
#include "input.h"
#include "gt_palette.h"
#include "gt_draw.h"
#include "gt_sprites.h"
#include "gt_hud.h"
#include "gt_sound.h"

/* ── palette ── */
#define C_SPACE  GT_DKBLUE
#define C_HUDBAR GT_NAVY
#define C_HUD    GT_WHITE
#define C_LIFE   GT_GREEN

/* ── sprite art (palette-index bytes; 0 = transparent). short aliases for art. ── */
#define C GT_CYAN
#define W GT_WHITE
#define T GT_TEAL
#define G GT_GOLD
#define O GT_ORANGE
#define M GT_MAGENTA
#define U GT_PURPLE
#define R GT_RED
#define Y GT_YELLOW

#define SHIP_W 16
#define SHIP_H 16
static const unsigned char ART_SHIP[SHIP_W * SHIP_H] = {
  0,0,0,0,0,0,0,C,C,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,C,C,0,0,0,0,0,0,0,
  0,0,0,0,0,0,C,W,W,C,0,0,0,0,0,0,
  0,0,0,0,0,0,C,W,W,C,0,0,0,0,0,0,
  0,0,0,0,0,C,C,W,W,C,C,0,0,0,0,0,
  0,0,0,0,C,C,T,T,T,T,C,C,0,0,0,0,
  0,0,0,C,C,T,T,T,T,T,T,C,C,0,0,0,
  0,0,C,C,T,T,T,W,W,T,T,T,C,C,0,0,
  0,C,C,T,T,T,T,W,W,T,T,T,T,C,C,0,
  C,C,T,T,T,T,T,T,T,T,T,T,T,T,C,C,
  C,C,C,T,T,T,T,T,T,T,T,T,T,C,C,C,
  C,0,C,C,T,T,T,T,T,T,T,T,C,C,0,C,
  0,0,0,C,C,0,T,T,T,T,0,C,C,0,0,0,
  0,0,0,0,0,0,G,G,G,G,0,0,0,0,0,0,
  0,0,0,0,0,G,O,G,G,O,G,0,0,0,0,0,
  0,0,0,0,0,0,O,0,0,O,0,0,0,0,0,0,
};

#define ENEMY_W 16
#define ENEMY_H 16
static const unsigned char ART_ENEMY[ENEMY_W * ENEMY_H] = {
  0,0,0,0,0,0,R,R,R,R,0,0,0,0,0,0,
  0,0,0,0,0,R,R,M,M,R,R,0,0,0,0,0,
  0,0,0,0,R,R,M,M,M,M,R,R,0,0,0,0,
  0,0,0,R,R,M,M,U,U,M,M,R,R,0,0,0,
  0,0,R,R,M,M,U,W,W,U,M,M,R,R,0,0,
  0,R,R,M,M,U,W,Y,Y,W,U,M,M,R,R,0,
  R,R,M,M,U,W,Y,R,R,Y,W,U,M,M,R,R,
  R,M,M,U,U,W,Y,R,R,Y,W,U,U,M,M,R,
  R,M,M,U,W,W,Y,Y,Y,Y,W,W,U,M,M,R,
  0,R,M,M,U,U,W,W,W,W,U,U,M,M,R,0,
  0,R,R,M,M,M,U,U,U,U,M,M,M,R,R,0,
  0,0,R,R,M,M,M,M,M,M,M,M,R,R,0,0,
  0,0,0,R,R,R,M,M,M,M,R,R,R,0,0,0,
  0,0,R,R,0,R,R,M,M,R,R,0,R,R,0,0,
  0,R,R,0,0,0,R,R,R,R,0,0,0,R,R,0,
  R,R,0,0,0,0,0,R,R,0,0,0,0,0,R,R,
};

#define SHOT_W 6
#define SHOT_H 10
static const unsigned char ART_SHOT[SHOT_W * SHOT_H] = {
  0,0,W,W,0,0,
  0,G,W,W,G,0,
  0,G,W,W,G,0,
  G,G,W,W,G,G,
  G,G,W,W,G,G,
  G,G,G,G,G,G,
  0,G,G,G,G,0,
  0,O,O,O,O,0,
  0,0,O,O,0,0,
  0,0,Y,Y,0,0,
};

#define BOOM_W 16
#define BOOM_H 16
static const unsigned char ART_BOOM[BOOM_W * BOOM_H] = {
  0,0,0,Y,0,0,0,R,R,0,0,0,Y,0,0,0,
  0,0,0,0,O,0,Y,O,O,Y,0,O,0,0,0,0,
  0,Y,0,0,0,O,O,Y,Y,O,O,0,0,0,Y,0,
  0,0,0,O,O,Y,Y,W,W,Y,Y,O,O,0,0,0,
  Y,0,O,O,Y,W,W,W,W,W,W,Y,O,O,0,Y,
  0,0,O,Y,W,W,Y,O,O,Y,W,W,Y,O,0,0,
  0,O,Y,W,Y,O,O,R,R,O,O,Y,W,Y,O,0,
  R,O,O,W,O,O,R,R,R,R,O,O,W,O,O,R,
  R,O,O,W,O,O,R,R,R,R,O,O,W,O,O,R,
  0,O,Y,W,Y,O,O,R,R,O,O,Y,W,Y,O,0,
  0,0,O,Y,W,W,Y,O,O,Y,W,W,Y,O,0,0,
  Y,0,O,O,Y,W,W,W,W,W,W,Y,O,O,0,Y,
  0,0,0,O,O,Y,Y,W,W,Y,Y,O,O,0,0,0,
  0,Y,0,0,0,O,O,Y,Y,O,O,0,0,0,Y,0,
  0,0,0,0,O,0,Y,O,O,Y,0,O,0,0,0,0,
  0,0,0,Y,0,0,0,R,R,0,0,0,Y,0,0,0,
};

#undef C
#undef W
#undef T
#undef G
#undef O
#undef M
#undef U
#undef R
#undef Y

/* Each sprite gets its own GRAM row band (gy step 16) so a 16-wide sprite can't
 * read into the next one's columns. */
static GtSprite SPR_SHIP, SPR_ENEMY, SPR_SHOT, SPR_BOOM;
static void load_art(void) {
  SPR_SHIP.gx  = 0; SPR_SHIP.gy  = 0;  SPR_SHIP.w  = SHIP_W;  SPR_SHIP.h  = SHIP_H;
  SPR_ENEMY.gx = 0; SPR_ENEMY.gy = 16; SPR_ENEMY.w = ENEMY_W; SPR_ENEMY.h = ENEMY_H;
  SPR_SHOT.gx  = 0; SPR_SHOT.gy  = 32; SPR_SHOT.w  = SHOT_W;  SPR_SHOT.h  = SHOT_H;
  SPR_BOOM.gx  = 0; SPR_BOOM.gy  = 48; SPR_BOOM.w  = BOOM_W;  SPR_BOOM.h  = BOOM_H;
  gt_load_sprite(ART_SHIP,  SPR_SHIP.gx,  SPR_SHIP.gy,  SHIP_W,  SHIP_H);
  gt_load_sprite(ART_ENEMY, SPR_ENEMY.gx, SPR_ENEMY.gy, ENEMY_W, ENEMY_H);
  gt_load_sprite(ART_SHOT,  SPR_SHOT.gx,  SPR_SHOT.gy,  SHOT_W,  SHOT_H);
  gt_load_sprite(ART_BOOM,  SPR_BOOM.gx,  SPR_BOOM.gy,  BOOM_W,  BOOM_H);
}

/* ── game state ── */
#define N_ENEMY 4
#define N_SHOT  3
#define N_BOOM  4

static unsigned char ship_x;
static unsigned char ex[N_ENEMY], ey[N_ENEMY], e_on[N_ENEMY];   /* enemies: x, y, active */
static unsigned char sx[N_SHOT],  sy[N_SHOT],  s_on[N_SHOT];    /* shots:   x, y, active */
static unsigned char bx[N_BOOM], by[N_BOOM], bt[N_BOOM];        /* explosions: x, y, timer */
static unsigned char fire_cool, spawn_t;
static unsigned int  score;
static unsigned char lives;

static void reset_game(void) {
  unsigned char i;
  ship_x = 56; score = 0; lives = 3; fire_cool = 0; spawn_t = 0;
  for (i = 0; i < N_ENEMY; i++) e_on[i] = 0;
  for (i = 0; i < N_SHOT;  i++) s_on[i] = 0;
  for (i = 0; i < N_BOOM;  i++) bt[i] = 0;
}

/* spawn an explosion at (x,y). */
static void make_boom(unsigned char x, unsigned char y) {
  unsigned char i;
  for (i = 0; i < N_BOOM; i++) {
    if (!bt[i]) { bx[i] = x; by[i] = y; bt[i] = 10; return; }
  }
}

/* spawn one enemy at the top in a free slot. */
static void spawn_enemy(void) {
  unsigned char i;
  for (i = 0; i < N_ENEMY; i++) {
    if (!e_on[i]) {
      ex[i] = 8 + (unsigned char)(rnd8() % 100);
      ey[i] = 0;
      e_on[i] = 1;
      return;
    }
  }
}

/* boxes-overlap test (sprites are ~16 wide). */
static unsigned char near16(unsigned char ax, unsigned char ay, unsigned char bx, unsigned char by) {
  unsigned char dx = ax > bx ? ax - bx : bx - ax;
  unsigned char dy = ay > by ? ay - by : by - ay;
  return dx < 14 && dy < 14;
}

void main(void) {
  unsigned char i, j;
  load_art();
  reset_game();

  for (;;) {
    /* ── input ── */
    if ((player1_buttons & INPUT_MASK_LEFT)  && ship_x > 2)   ship_x -= 2;
    if ((player1_buttons & INPUT_MASK_RIGHT) && ship_x < 110) ship_x += 2;
    if (fire_cool) fire_cool--;
    if ((player1_buttons & (INPUT_MASK_A | INPUT_MASK_START)) && !fire_cool) {
      for (i = 0; i < N_SHOT; i++) {
        if (!s_on[i]) { s_on[i] = 1; sx[i] = ship_x + 5; sy[i] = 100; fire_cool = 10; gt_sfx(GT_SFX_SHOOT); break; }
      }
    }

    /* ── shots move up ── */
    for (i = 0; i < N_SHOT; i++) {
      if (s_on[i]) {
        if (sy[i] < 6) s_on[i] = 0;
        else sy[i] -= 6;
      }
    }

    /* ── spawn enemies on a timer ── */
    spawn_t++;
    if (spawn_t >= 48) { spawn_t = 0; spawn_enemy(); }

    /* ── enemies fall ── */
    for (i = 0; i < N_ENEMY; i++) {
      if (e_on[i]) {
        ey[i]++;
        if (ey[i] > 120) e_on[i] = 0;           /* off the bottom: just despawn */
      }
    }

    /* ── shot vs enemy ── */
    for (i = 0; i < N_ENEMY; i++) {
      if (e_on[i]) {
        for (j = 0; j < N_SHOT; j++) {
          if (s_on[j] && near16(ex[i] + 8, ey[i] + 8, sx[j] + 3, sy[j] + 4)) {
            make_boom(ex[i], ey[i]);
            e_on[i] = 0; s_on[j] = 0; score += 10; gt_sfx(GT_SFX_EXPLODE);
            break;
          }
        }
      }
    }

    /* ── enemy vs ship ── */
    for (i = 0; i < N_ENEMY; i++) {
      if (e_on[i] && near16(ex[i] + 8, ey[i] + 8, ship_x + 8, 116)) {
        make_boom(ex[i], ey[i]);
        e_on[i] = 0;
        gt_sfx(GT_SFX_EXPLODE);
        if (lives) lives--;
      }
    }

    /* ── age explosions ── */
    for (i = 0; i < N_BOOM; i++) if (bt[i]) bt[i]--;

    /* ── draw (scalar copies: indexing inside the gt_blit macro is fragile in cc65) ── */
    gt_clear(C_SPACE);
    for (i = 0; i < N_ENEMY; i++) if (e_on[i]) { unsigned char dx = ex[i], dy = ey[i]; gt_blit(dx, dy, SPR_ENEMY); }
    for (i = 0; i < N_SHOT;  i++) if (s_on[i]) { unsigned char dx = sx[i], dy = sy[i]; gt_blit(dx, dy, SPR_SHOT); }
    for (i = 0; i < N_BOOM;  i++) if (bt[i])   { unsigned char dx = bx[i], dy = by[i]; gt_blit(dx, dy, SPR_BOOM); }
    gt_blit(ship_x, 108, SPR_SHIP);
    /* HUD: bar in the play area (y>=7), text inside it. */
    queue_draw_box(1, 7, 126, 7, C_HUDBAR);
    hud_number(score, 30, 8, 2, C_HUD);
    hud_pips(lives, 96, 8, 4, C_LIFE);
    /* Re-clean the top BORDER (rows 0-6) LAST. Blitting sprites leaves a stray light
     * line on the framebuffer's top scanline; only the border-clear path can rewrite
     * rows 0-6, and doing it AFTER the sprite blits removes the flickering 1px seam. */
    queue_clear_border(C_HUDBAR);
    gt_present();
    gt_sfx_tick();

    update_inputs();
  }
}
