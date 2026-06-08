// ── hello_sprite.c — Atari Lynx hello + joystick movement ────────────
//
// Uses cc65's TGI (Tiny Graphics Interface) which handles Suzy's
// blitter for us. A single colored square moves under joystick control.
//
// Lynx joystick reading via cc65's joy_* API. We use the bundled
// lynx_stdjoy driver.

#include <tgi.h>
#include <joystick.h>
#include <lynx.h>
#include "lynx_sfx.h"

void main(void) {
  unsigned char x = 80, y = 50;
  unsigned char joy;

  tgi_install(&lynx_160_102_16_tgi);
  tgi_init();
  joy_install(&lynx_stdjoy_joy);
  sfx_init();
  sfx_tone(0, 80, 12);  /* boot chime */

  for (;;) {
    /* CANONICAL LYNX FRAME LOOP — full redraw every frame:
     *   1. WAIT for Suzy's blitter to finish the previous frame. Drawing
     *      while it's mid-flight loses the frame → black screen. This is
     *      the #1 "Lynx stays blank" trap (tgi_clear alone leaves the back
     *      page stale on this core, so we clear with a full-screen bar). */
    while (tgi_busy()) { }

    /* Blue field so the screen is obviously not blank... */
    tgi_setcolor(COLOR_BLUE);
    tgi_bar(0, 0, tgi_getmaxx(), tgi_getmaxy());
    /* ...with a green band so no single colour fills the whole screen. */
    tgi_setcolor(COLOR_GREEN);
    tgi_bar(0, 60, tgi_getmaxx(), 102);

    /* The joystick-driven player square on top. */
    tgi_setcolor(COLOR_YELLOW);
    tgi_bar(x, y, x + 8, y + 8);
    tgi_setcolor(COLOR_WHITE);
    tgi_outtextxy(2, 2, "HELLO LYNX");
    tgi_updatedisplay();
    sfx_update();

    joy = joy_read(JOY_1);
    if (JOY_LEFT(joy)  && x > 0)   x--;
    if (JOY_RIGHT(joy) && x < 152) x++;
    if (JOY_UP(joy)    && y > 12)  y--;
    if (JOY_DOWN(joy)  && y < 94)  y++;
  }
}
