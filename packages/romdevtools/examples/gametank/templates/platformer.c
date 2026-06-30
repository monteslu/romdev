/* ── platformer.c — GameTank side-scrolling platformer (complete example) ─────
 *
 * A COMPLETE, working game on the bundled GameTank SDK draw-queue runtime: title
 * screen, a runner with a 3-frame WALK animation, real gravity + jumping, scrolling
 * platforms to land on, collectible coins (with a pleasant pickup chime), score +
 * lives, fall-death, and a restart loop. The GameTank's framebuffer makes a side-
 * scroller EASY — no tilemap to stream, no hardware scroll register: the world is
 * an array of platforms, you subtract a camera offset, and redraw the visible rects.
 *
 * FORK THIS. Markers:
 *   HARDWARE IDIOM (load-bearing) — redraw the whole frame as blitter rects each
 *     frame; the camera is a subtract on world-x. The hero is the ONLY GRAM sprite
 *     blit per frame (coins are cheap rects) — too many sprite blits overrun the
 *     vblank window and the draw queue silently DROPS rects (platforms flicker /
 *     vanish). Background slabs are clamped to width/height 127, never 128 (a
 *     full-screen-dimension box is dropped — see gt_draw.h).
 *   GAME LOGIC (clay) — gravity, jump height, level layout, scoring: tune freely.
 *
 * PHYSICS GOTCHAS baked in (each was a real bug):
 *   - World x (PLAT_X / COIN_X / cam / hx_world) is unsigned INT — char wraps at
 *     255 and a platform's collision drifts away from where it's drawn.
 *   - Vertical position math is done in a SIGNED temp + clamped to 0: hy is an
 *     unsigned char, so a strong jump that pushes it below 0 would wrap to ~250 and
 *     trip the fall-death check (the "jump high → snap back to ground" bug).
 *   - Landing is SWEPT (feet crossed the platform top this frame), not an
 *     instantaneous thin-overlap test — a fast fall would otherwise tunnel through.
 *
 * CONTROLS: ←/→ run · A or Up = jump · A/START to begin. SCREEN: 128x128. 1 player.
 */
#include "gametank.h"
#include "draw_queue.h"
#include "input.h"
#include "gt_palette.h"
#include "gt_draw.h"
#include "gt_sprites.h"
#include "gt_hud.h"
#include "gt_sound.h"

/* ── palette (verified gt_palette.h) ── */
#define C_SKY1   GT_DKBLUE     /* sky gradient: top */
#define C_SKY2   GT_BLUE
#define C_SKY3   GT_SKY        /* sky near the ground */
#define C_GROUND GT_BROWN
#define C_GRASS  GT_GREEN
#define C_PLAT   GT_ORANGE
#define C_COIN   GT_GOLD
#define C_HUD    GT_WHITE
#define C_LIFE   GT_GREEN

/* ── hero sprite art (12x14): cyan body, white face, gold boots. THREE frames —
 * stand + two walk poses (legs swap) — cycled while running so he looks alive. ── */
#define HERO_W 12
#define HERO_H 14
/* shared top 12 rows (head + torso); only the legs (last 2 rows) differ per frame. */
#define HERO_TOP \
  0,0,0,GT_BROWN,GT_BROWN,GT_BROWN,GT_BROWN,GT_BROWN,0,0,0,0, \
  0,0,GT_BROWN,GT_BROWN,GT_BROWN,GT_BROWN,GT_BROWN,GT_BROWN,GT_BROWN,0,0,0, \
  0,0,0,GT_ROSE,GT_ROSE,GT_ROSE,GT_ROSE,GT_ROSE,0,0,0,0, \
  0,0,GT_ROSE,GT_WHITE,GT_ROSE,GT_ROSE,GT_WHITE,GT_ROSE,0,0,0,0, \
  0,0,GT_ROSE,GT_ROSE,GT_ROSE,GT_ROSE,GT_ROSE,GT_ROSE,0,0,0,0, \
  0,0,0,GT_ROSE,GT_RED,GT_RED,GT_ROSE,0,0,0,0,0, \
  0,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,0,0,0, \
  GT_CYAN,GT_CYAN,GT_SKY,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,GT_SKY,GT_CYAN,GT_CYAN,0,0, \
  GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,0,0, \
  0,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,GT_CYAN,0,0,0
/* frame 0: standing — legs together */
static const unsigned char ART_HERO0[HERO_W*HERO_H] = {
  HERO_TOP,
  0,0,GT_CYAN,GT_CYAN,0,0,GT_CYAN,GT_CYAN,0,0,0,0,
  0,0,GT_GOLD,GT_GOLD,0,0,GT_GOLD,GT_GOLD,0,0,0,0,
  0,GT_GOLD,GT_GOLD,GT_GOLD,0,0,GT_GOLD,GT_GOLD,GT_GOLD,0,0,0,
};
/* frame 1: walk — left leg forward */
static const unsigned char ART_HERO1[HERO_W*HERO_H] = {
  HERO_TOP,
  0,GT_CYAN,GT_CYAN,0,0,0,GT_CYAN,GT_CYAN,0,0,0,0,
  GT_GOLD,GT_GOLD,GT_GOLD,0,0,0,0,GT_GOLD,GT_GOLD,0,0,0,
  GT_GOLD,GT_GOLD,0,0,0,0,0,0,GT_GOLD,GT_GOLD,0,0,
};
/* frame 2: walk — right leg forward (mirror of 1) */
static const unsigned char ART_HERO2[HERO_W*HERO_H] = {
  HERO_TOP,
  0,GT_CYAN,GT_CYAN,0,0,0,GT_CYAN,GT_CYAN,0,0,0,0,
  0,GT_GOLD,GT_GOLD,0,0,0,0,GT_GOLD,GT_GOLD,GT_GOLD,0,0,
  0,0,GT_GOLD,GT_GOLD,0,0,0,0,0,GT_GOLD,GT_GOLD,0,
};

static GtSprite SPR_HERO0, SPR_HERO1, SPR_HERO2;
static void load_art(void) {
  /* 3 hero frames on their own GRAM rows. Coins are drawn as cheap rects (no sprite),
   * which keeps the per-frame GRAM-blit count to just ONE (the hero) — sprite blits
   * are the expensive part of the frame and too many overrun vblank (dropped draws). */
  SPR_HERO0.gx = 0; SPR_HERO0.gy = 0;  SPR_HERO0.w = HERO_W; SPR_HERO0.h = HERO_H;
  SPR_HERO1.gx = 0; SPR_HERO1.gy = 16; SPR_HERO1.w = HERO_W; SPR_HERO1.h = HERO_H;
  SPR_HERO2.gx = 0; SPR_HERO2.gy = 32; SPR_HERO2.w = HERO_W; SPR_HERO2.h = HERO_H;
  gt_load_sprite(ART_HERO0, SPR_HERO0.gx, SPR_HERO0.gy, HERO_W, HERO_H);
  gt_load_sprite(ART_HERO1, SPR_HERO1.gx, SPR_HERO1.gy, HERO_W, HERO_H);
  gt_load_sprite(ART_HERO2, SPR_HERO2.gx, SPR_HERO2.gy, HERO_W, HERO_H);
}

#define GROUND_Y 110
#define GRAVITY  1
#define JUMP_V   12

/* world platforms: x (world), y, w. ⚠ PLAT_X / COIN_X MUST be unsigned int — world
 * coords run past 255 and an unsigned char would WRAP (270 → 14), putting a platform
 * somewhere it isn't drawn, so the hero lands on / falls through empty air. */
/* Platform tops (PLAT_Y) must sit a clear gap ABOVE the ground so the hero (14 tall,
 * feet at GROUND_Y=110 → head at 96) can JUMP UP onto them rather than walk into them
 * from the ground. Lowest here is y=84 (26px of clear air above the floor); they step
 * up from there. */
#define N_PLAT 7
static const unsigned int  PLAT_X[N_PLAT] = { 26,  70, 118, 160, 204, 248, 290 };
static const unsigned char PLAT_Y[N_PLAT] = { 84,  68,  84,  56,  72,  60,  84 };
static const unsigned char PLAT_W[N_PLAT] = { 32,  28,  30,  26,  28,  26,  32 };
/* coins sit just ABOVE each platform's surface (centered on it), so you grab one by
 * landing on or running across that platform — reachable, not floating out of reach.
 * COIN_Y = PLAT_Y - 11 (a coin's height above the deck); COIN_X = platform center. */
#define N_COIN 6
static const unsigned int  COIN_X[N_COIN] = { 38,  80, 130, 170, 214, 258 };
static const unsigned char COIN_Y[N_COIN] = { 73,  57, 73,  45,  61,  49 };

static unsigned int  cam;            /* world-x of screen left edge */
static unsigned char hx_screen;      /* hero x ON screen (kept ~center) */
static unsigned int  hx_world;       /* hero x in world */
static unsigned char hy;             /* hero y (top) */
static signed char   vy;             /* vertical velocity */
static unsigned char on_ground;
static unsigned char coin_got[N_COIN];
static unsigned int  score;
static unsigned char lives;
static unsigned char walk_t, walk_f;   /* hero walk-cycle timer + frame (0,1,0,2) */

/* ── coin pickup chime: the classic RISING two-note sparkle (low → high), played on
 * the PIANO channel (3) for a clean mellow ding — NOT the harsh guitar, and NOT the
 * same note re-hit (that re-trigger mid-decay is what made it clang like a dropped
 * pot). gt_sfx fires the 1st (lower) note; coin_chime_tick() fires the 2nd (higher)
 * a few frames later by keying ch3 directly with a fresh, soft amplitude. ── */
#define COIN_CH   3
#define COIN_NOTE2 80                  /* 2nd note, higher than the COIN preset's 76 */
static unsigned char coin_chime;       /* frames left until the 2nd note, 0 = idle */
static void coin_pickup_sound(void) { gt_sfx(GT_SFX_COIN); coin_chime = 4; }
static void coin_chime_tick(void) {
  if (coin_chime) {
    coin_chime--;
    if (coin_chime == 0) {             /* fire the 2nd (higher) note on the PIANO ch */
      unsigned char op = COIN_CH << 2;
      set_note(op, COIN_NOTE2);
      gt_sfx_amp[COIN_CH] = 0x44; gt_sfx_fade[COIN_CH] = 18;   /* soft, quick fade */
      set_audio_param(AMPLITUDE + op,   (0x44 >> 1) + 128);
      set_audio_param(AMPLITUDE + op+1, (0x44 >> 1) + 128);
      set_audio_param(AMPLITUDE + op+2, (0x44 >> 1) + 128);
      set_audio_param(AMPLITUDE + op+3, (0x44 >> 1) + 128);
    }
  }
}

static void reset_level(void) {
  unsigned char i;
  cam = 0; hx_world = 20; hy = GROUND_Y - 14; vy = 0; on_ground = 1;
  for (i = 0; i < N_COIN; i++) coin_got[i] = 0;
}
static void reset_game(void) { score = 0; lives = 3; reset_level(); }

static unsigned char overlap(unsigned int ax, unsigned char ay, unsigned char aw, unsigned char ah,
                             unsigned int bx, unsigned char by, unsigned char bw, unsigned char bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/* sky + ground.  IDIOM (anti-flicker): only gt_clear paints a flicker-free fill —
 * every extra full-width queue_draw_box flickers on its TOP scanline (the blitter
 * leaves that row inconsistent between the two double-buffer pages). So keep the
 * background to gt_clear + a SINGLE ground box, and hide that one seam under the
 * grass-topped platforms / hero feet. (No multi-band haze — it just adds seams.) */
static void draw_world_bg(void) {
  gt_clear(C_SKY1);                                       /* sky: deep blue */
  /* ⚠ width MUST be <= 127 — the GameTank blitter drops a box whose width is 128
   * (a full-screen-wide box wraps/rejects). Always 127, never 128. */
  queue_draw_box(0, GROUND_Y, 127, 128 - GROUND_Y, C_GROUND);  /* ground slab */
  queue_draw_box(0, GROUND_Y, 127, 2, C_GRASS);          /* grass cap (one shared seam) */
}

static unsigned char title(void) {
  gt_start_reset();
  while (1) {
    draw_world_bg();
    queue_draw_box(28, 30, 72, 12, C_PLAT);   /* banner */
    gt_blit(58, 70, SPR_HERO0);
    queue_draw_box(41, 81, 5, 5, C_COIN); queue_draw_box(81, 81, 5, 5, C_COIN);  /* coins */
    queue_clear_border(C_SKY1);
    gt_present();
    gt_music_tick();
    update_inputs();
    if (gt_start_pressed()) return 1;
  }
}

void main(void) {
  unsigned char i;
  load_art();
  reset_game();

  for (;;) {
    title();
    reset_game();

    for (;;) {
      update_inputs();

      /* run: hero advances through the world; camera follows, hero stays mid-screen */
      if (player1_buttons & INPUT_MASK_RIGHT) { hx_world += 2; }
      if ((player1_buttons & INPUT_MASK_LEFT) && hx_world > 2) { hx_world -= 2; }
      /* jump */
      if ((player1_new_buttons & (INPUT_MASK_A | INPUT_MASK_UP)) && on_ground) { vy = -JUMP_V; on_ground = 0; }

      /* gravity + vertical move. hy is UNSIGNED, so compute the new y in a SIGNED temp:
       * a strong jump can push y below 0, and `hy += vy` would WRAP to ~250 → the
       * "hy > 124" fall-death check fires and resets the run (the "jump high → snap to
       * ground" bug). Clamp the top to 0. Remember the OLD feet for swept landing. */
      {
        signed int foot_prev = (signed int)hy + 14;   /* feet before moving */
        signed int ny;
        vy += GRAVITY;
        if (vy > 10) vy = 10;
        ny = (signed int)hy + vy;
        if (ny < 0) { ny = 0; vy = 0; }                /* bonked the top of the screen */
        hy = (unsigned char)ny;

        /* land — SWEPT, so a fast fall can't tunnel through a thin platform top. The
         * hero lands when, while falling (vy>=0), his feet were ABOVE a platform's top
         * last frame and are now AT/BELOW it, and he's horizontally over that platform. */
        on_ground = 0;
        if (hy + 14 >= GROUND_Y) { hy = GROUND_Y - 14; vy = 0; on_ground = 1; }
        if (vy >= 0) {
          signed int foot = (signed int)hy + 14;
          for (i = 0; i < N_PLAT; i++) {
            unsigned int px = PLAT_X[i];
            signed int top = (signed int)PLAT_Y[i];
            if (hx_world + 10 > px && hx_world < px + PLAT_W[i]   /* horizontally over it */
                && foot_prev <= top && foot >= top) {            /* crossed the top */
              hy = (unsigned char)(top - 14); vy = 0; on_ground = 1;
            }
          }
        }
      }
      /* fall off the bottom = lose a life (only when actually falling, not at the top) */
      if (hy > 124 && vy > 0) { if (--lives == 0) goto dead; reset_level(); continue; }

      /* coins — collect on overlap: score + a pleasant "ding-ding" chime. */
      for (i = 0; i < N_COIN; i++) if (!coin_got[i] &&
          overlap(hx_world, hy, 10, 14, COIN_X[i], COIN_Y[i], 8, 8)) {
        coin_got[i] = 1; score += 25; coin_pickup_sound();
      }
      coin_chime_tick();   /* sequence the 2nd blip of the coin chime */

      /* camera: keep hero ~45px from the left */
      cam = (hx_world > 45) ? hx_world - 45 : 0;
      hx_screen = (unsigned char)(hx_world - cam);

      /* hero walk animation: cycle frames 0→1→0→2 while moving, stand still otherwise. */
      if (player1_buttons & (INPUT_MASK_LEFT | INPUT_MASK_RIGHT)) {
        if (++walk_t >= 6) { walk_t = 0; walk_f++; if (walk_f >= 4) walk_f = 0; }
      } else { walk_f = 0; walk_t = 0; }

      /* ── redraw the frame; world rects minus the camera ── */
      draw_world_bg();
      for (i = 0; i < N_PLAT; i++) {
        unsigned int px = PLAT_X[i];
        unsigned char pw = PLAT_W[i];
        /* on screen only when fully within [cam, cam+128). For a platform straddling
         * the LEFT edge, px-cam would underflow — clamp the screen x to 0 and trim the
         * width so the DRAWN rect matches the WORLD rect the collision uses (no desync). */
        if (px + pw > cam && px < cam + 128) {
          unsigned char sx, sw;
          if (px >= cam) { sx = (unsigned char)(px - cam); sw = pw; }
          else { sx = 0; sw = (unsigned char)(pw - (cam - px)); }    /* left-clipped */
          if (sx + sw > 128) sw = (unsigned char)(128 - sx);          /* right-clip */
          gt_rect(sx, PLAT_Y[i], sw, 5, C_PLAT);
          gt_rect(sx, PLAT_Y[i], sw, 2, C_GRASS);                     /* grassy top */
        }
      }
      /* coins as cheap RECTS (a gold ring) — not GRAM sprites — so the only expensive
       * sprite blit per frame is the hero; that's what keeps the queue inside vblank. */
      for (i = 0; i < N_COIN; i++) if (!coin_got[i]) {
        unsigned int cx = COIN_X[i];
        /* coins float above the platforms against the sky. Drawn as a bright YELLOW
         * disc with a white sparkle + dark outline so they read clearly and don't
         * blend into the orange platforms. Only drawn fully on-screen. */
        if (cx >= cam && cx < cam + 120) {
          unsigned char dx = (unsigned char)(cx - cam);
          unsigned char cy = COIN_Y[i];
          gt_rect(dx + 1, cy,     6, 8, C_COIN);            /* body (rounded) */
          gt_rect(dx,     cy + 1, 8, 6, C_COIN);
          gt_rect(dx + 2, cy + 1, 2, 3, GT_WHITE);          /* bright shine */
          gt_rect(dx + 4, cy + 4, 3, 3, GT_ORANGE);         /* shaded edge */
        }
      }
      /* the single sprite blit: the hero, animated */
      gt_blit(hx_screen, hy,
              (walk_f == 1) ? SPR_HERO1 : (walk_f == 3) ? SPR_HERO2 : SPR_HERO0);
      queue_draw_box(1, 7, 126, 7, GT_NAVY);      /* HUD bar (in play area, y>=7) */
      hud_number(score, 30, 8, 2, C_HUD);
      hud_pips(lives, 100, 8, 5, C_LIFE);
      gt_present();
      gt_music_tick();
    }
  dead:
    while (1) {
      draw_world_bg();
      queue_draw_box(20, 48, 88, 30, GT_NAVY);
      hud_number(score, 76, 56, 3, C_HUD);
      gt_present();
      gt_music_tick();
      update_inputs();
      if (gt_start_pressed()) break;
    }
  }
}
