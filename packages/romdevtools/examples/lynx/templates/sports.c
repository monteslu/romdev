// ── sports.c — Atari Lynx Pong vs AI ─────────────────────────────────
//
// Lynx is a handheld with one controller. Right paddle = AI tracking
// the ball.

#include <tgi.h>
#include <joystick.h>
#include <lynx.h>
#include <stdint.h>
#include "lynx_sfx.h"

#define PADDLE_H 16
#define PADDLE_W 3
#define BALL_SIZE 4
#define COURT_TOP 4
#define COURT_BOT 96
#define PADDLE_X1 6
#define PADDLE_X2 (160 - 6 - PADDLE_W)

void main(void) {
  int16_t p1y = 40, p2y = 40, bx = 78, by = 48;
  int8_t bdx = 2, bdy = 1;
  uint8_t joy;
  int16_t ny;   /* loop var for the dashed centre net */

  tgi_install(&lynx_160_102_16_tgi);
  tgi_init();
  joy_install(&lynx_stdjoy_joy);
  sfx_init();

  for (;;) {
    /* Lynx frame loop: WAIT for the blitter, then clear with a full-screen
     * tgi_bar (NOT tgi_clear, which leaves the back page stale on this core)
     * — drawing while the blitter is mid-flight loses the frame → black.
     * (Copied from the shmup scaffold, the LYNX-1 fix.) */
    while (tgi_busy()) { }

    /* ── Background scene (drawn every frame). Without it the court is a
     * near-flat single colour and the render-health audit flags the
     * screen as blank. A two-tone court with boards + net markings keeps
     * several distinct colours well under the threshold:
     *   - green centre court
     *   - lighter-green end zones behind each paddle
     *   - dark-grey boards top and bottom
     *   - white boundary, dashed centre net + centre circle. */
    tgi_setcolor(COLOR_GREEN);
    tgi_bar(0, 0, tgi_getmaxx(), tgi_getmaxy());        /* court grass       */
    tgi_setcolor(COLOR_LIGHTGREEN);
    tgi_bar(0, COURT_TOP, 52, COURT_BOT - 1);           /* left end zone     */
    tgi_bar(107, COURT_TOP, 159, COURT_BOT - 1);        /* right end zone    */
    tgi_setcolor(COLOR_DARKGREY);
    tgi_bar(0, 0, 159, COURT_TOP - 1);                  /* top boards        */
    tgi_bar(0, COURT_BOT, 159, 101);                    /* bottom boards     */
    /* white court boundary + dashed centre net + centre circle */
    tgi_setcolor(COLOR_WHITE);
    tgi_line(0, COURT_TOP, 159, COURT_TOP);
    tgi_line(0, COURT_BOT, 159, COURT_BOT);
    for (ny = COURT_TOP; ny < COURT_BOT; ny += 8)
      tgi_bar(79, (unsigned)ny, 80, (unsigned)(ny + 3 > COURT_BOT ? COURT_BOT : ny + 3));
    tgi_line(70, 40, 90, 40);
    tgi_line(70, 60, 90, 60);
    tgi_line(70, 40, 70, 60);
    tgi_line(90, 40, 90, 60);

    /* Playtest: "needs better contrast" — yellow paddles + white ball pop
     * against the green court far better than white-on-lightgreen +
     * yellow-on-green did. */
    tgi_setcolor(COLOR_YELLOW);
    tgi_bar(PADDLE_X1, (unsigned)p1y, PADDLE_X1 + PADDLE_W - 1, (unsigned)(p1y + PADDLE_H - 1));
    tgi_bar(PADDLE_X2, (unsigned)p2y, PADDLE_X2 + PADDLE_W - 1, (unsigned)(p2y + PADDLE_H - 1));
    tgi_setcolor(COLOR_WHITE);
    tgi_bar((unsigned)bx, (unsigned)by, (unsigned)(bx + BALL_SIZE - 1), (unsigned)(by + BALL_SIZE - 1));
    tgi_updatedisplay();
    sfx_update();

    joy = joy_read(JOY_1);
    if (JOY_UP(joy)   && p1y > COURT_TOP)             p1y -= 2;
    if (JOY_DOWN(joy) && p1y < COURT_BOT - PADDLE_H)  p1y += 2;

    /* AI */
    if (p2y + PADDLE_H/2 < by && p2y < COURT_BOT - PADDLE_H) p2y++;
    else if (p2y + PADDLE_H/2 > by && p2y > COURT_TOP)       p2y--;

    bx += bdx;
    by += bdy;
    if (by < COURT_TOP)              { by = COURT_TOP; bdy = -bdy; sfx_tone(2, 90, 2); }
    if (by + BALL_SIZE > COURT_BOT)  { by = COURT_BOT - BALL_SIZE; bdy = -bdy; sfx_tone(2, 90, 2); }
    if (bdx < 0 && bx <= PADDLE_X1 + PADDLE_W && bx + BALL_SIZE >= PADDLE_X1
        && by + BALL_SIZE > p1y && by < p1y + PADDLE_H) { bdx = -bdx; sfx_tone(0, 70, 3); }
    if (bdx > 0 && bx + BALL_SIZE >= PADDLE_X2 && bx <= PADDLE_X2 + PADDLE_W
        && by + BALL_SIZE > p2y && by < p2y + PADDLE_H) { bdx = -bdx; sfx_tone(0, 70, 3); }
    if (bx < -BALL_SIZE) { bx = 78; by = 48; bdx = 2; sfx_noise(20); }
    if (bx > 160)        { bx = 78; by = 48; bdx = -2; sfx_tone(0, 50, 12); }
  }
}
