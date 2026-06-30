/* ── sports.c — GameTank 2-player paddle game (complete example) ─────────────
 *
 * A COMPLETE, working game on the bundled GameTank SDK draw-queue runtime — and
 * a genuine 2-PLAYER one (the GameTank has two gamepad ports, unlike the
 * handhelds). Two paddles, a bouncing ball that speeds up on each hit, first to
 * 7 wins. Title → play → match-point → restart. The framebuffer makes a clean
 * paddle game trivial — paddles + ball are just rects redrawn each frame.
 *
 * FORK THIS. Markers:
 *   HARDWARE IDIOM (load-bearing) — paddles/ball/court = rects redrawn each
 *     frame; the ball's sub-pixel motion is integer x/y with a velocity. No
 *     sprites, no flicker.
 *   GAME LOGIC (clay) — paddle speed, ball speed-up, win score: tune freely.
 *
 * SFX (gt_sound.h, ACP synth): a blip on wall bounces, a "pong" on paddle hits,
 * and a ding on each point scored. Box-drawn HUD (gt_hud.h).
 * SCREEN: 128x128. PLAYERS: 2 (P1 left pad = $2008, P2 right pad = $2009).
 */
#include "gametank.h"
#include "draw_queue.h"
#include "input.h"
#include "gt_palette.h"
#include "gt_draw.h"
#include "gt_hud.h"
#include "gt_sound.h"

#define C_COURT  GT_DKGRN     /* court: dark green */
#define C_NET    GT_WHITE
#define C_P1     GT_CYAN      /* left paddle */
#define C_P2     GT_GOLD      /* right paddle */
#define C_BALL   GT_WHITE
#define C_HUD    GT_WHITE

#define PAD_H 26
#define PAD_W 5
#define WIN   7

static unsigned char p1y, p2y;       /* paddle tops */
static signed char bx, by;           /* ball pos (signed for clamp math) */
static signed char vx, vy;           /* ball velocity */
static unsigned char s1, s2;

static void serve(unsigned char toLeft) {
  bx = 62; by = 60;
  vx = toLeft ? -2 : 2; vy = (by & 1) ? 1 : -1;
}
static void reset_game(void) { p1y = 51; p2y = 51; s1 = 0; s2 = 0; serve(1); }

static unsigned char title_or_win(unsigned char win) {  /* win: 0 title, 1 P1, 2 P2 */
  gt_start_reset();
  while (1) {
    gt_clear(C_COURT);
    if (!win) {
      gt_rect(28, 36, 72, 10, C_BALL);
      gt_rect(20, 64, PAD_W, PAD_H, C_P1);
      gt_rect(103, 64, PAD_W, PAD_H, C_P2);
      gt_rect(62, 72, 5, 5, C_BALL);
    } else {
      gt_rect(30, 52, 68, 24, C_NET);
      hud_digit(win, 60, 56, 4, win == 1 ? C_P1 : C_P2);   /* "1" or "2" wins */
    }
     gt_present(); gt_music_tick(); 
    update_inputs();
    if (gt_start_pressed()) return 1;
  }
}

void main(void) {
  unsigned char i;
  reset_game();

  for (;;) {
    title_or_win(0);
    reset_game();

    for (;;) {
      update_inputs();

      /* P1 (left pad) + P2 (right pad) — update_inputs fills player1/2_buttons */
      if ((player1_buttons & INPUT_MASK_UP)   && p1y > 2)              p1y -= 3;
      if ((player1_buttons & INPUT_MASK_DOWN) && p1y < 127 - PAD_H)    p1y += 3;
      if ((player2_buttons & INPUT_MASK_UP)   && p2y > 2)              p2y -= 3;
      if ((player2_buttons & INPUT_MASK_DOWN) && p2y < 127 - PAD_H)    p2y += 3;

      /* ball move */
      bx += vx; by += vy;
      if (by <= 2)   { by = 2;   vy = -vy; gt_sfx(GT_SFX_SHOOT); }   /* wall blip */
      if (by >= 122) { by = 122; vy = -vy; gt_sfx(GT_SFX_SHOOT); }

      /* paddle collisions (speed up on hit) — the satisfying "pong" */
      if (vx < 0 && bx <= 25 && bx >= 18 && by + 5 >= (signed char)p1y && by <= (signed char)(p1y + PAD_H)) {
        bx = 25; vx = (signed char)(-vx + 1); vy += (signed char)((by - (signed char)(p1y + PAD_H / 2)) >> 3);
        gt_sfx(GT_SFX_HIT);
      }
      if (vx > 0 && bx >= 98 && bx <= 105 && by + 5 >= (signed char)p2y && by <= (signed char)(p2y + PAD_H)) {
        bx = 98; vx = (signed char)(-vx - 1); vy += (signed char)((by - (signed char)(p2y + PAD_H / 2)) >> 3);
        gt_sfx(GT_SFX_HIT);
      }
      if (vx > 4) vx = 4; if (vx < -4) vx = -4;

      /* score — a clear ding for the point */
      if (bx < 0)   { s2++; gt_sfx(GT_SFX_COIN); if (s2 >= WIN) goto win2; serve(0); }
      if (bx > 126) { s1++; gt_sfx(GT_SFX_COIN); if (s1 >= WIN) goto win1; serve(1); }

      /* ── HARDWARE IDIOM: court + net + paddles + ball, all rects ── */
      gt_clear(C_COURT);
      for (i = 4; i < 124; i += 10) gt_rect(63, i, 2, 5, C_NET);   /* dashed net */
      gt_rect(20, p1y, PAD_W, PAD_H, C_P1);
      gt_rect(103, p2y, PAD_W, PAD_H, C_P2);
      gt_rect((unsigned char)bx, (unsigned char)by, 5, 5, C_BALL);
      hud_number(s1, 44, 4, 2, C_P1);
      hud_number(s2, 84, 4, 2, C_P2);
      
      gt_present(); gt_music_tick();
    }
  win1: title_or_win(1); continue;
  win2: title_or_win(2); continue;
  }
}
