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
    tgi_setcolor(COLOR_BLACK);
    tgi_bar(0, 0, tgi_getmaxx(), tgi_getmaxy());
    tgi_setcolor(COLOR_WHITE);
    tgi_bar(PADDLE_X1, (unsigned)p1y, PADDLE_X1 + PADDLE_W - 1, (unsigned)(p1y + PADDLE_H - 1));
    tgi_bar(PADDLE_X2, (unsigned)p2y, PADDLE_X2 + PADDLE_W - 1, (unsigned)(p2y + PADDLE_H - 1));
    tgi_setcolor(COLOR_YELLOW);
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
