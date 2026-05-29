// ── platformer.c — Atari Lynx single-screen platformer ──────────────
//
// Subpixel gravity + jump + land-on-top collision. Static platforms
// drawn as rectangles each frame. cc65 tgi + lynx joystick.

#include <tgi.h>
#include <joystick.h>
#include <lynx.h>
#include <stdint.h>
#include "lynx_sfx.h"

typedef struct { int16_t x, y, w, h; } Rect;

static const Rect platforms[] = {
  {   0, 94, 160,  8 }, /* floor */
  {  16, 76,  32,  4 },
  {  64, 64,  32,  4 },
  { 112, 52,  32,  4 },
  {  32, 40,  24,  4 },
  {  88, 28,  40,  4 },
};
#define N_PLATFORMS (sizeof(platforms) / sizeof(platforms[0]))

static uint8_t on_platform(int16_t px, int16_t py) {
  uint8_t i;
  for (i = 0; i < N_PLATFORMS; i++) {
    if (py + 6 == platforms[i].y
        && px + 6 > platforms[i].x
        && px     < platforms[i].x + platforms[i].w) return 1;
  }
  return 0;
}

void main(void) {
  int16_t px = 80, py = 88;
  int8_t  vy = 0;
  uint8_t joy, prev = 0, btn, grounded;
  uint8_t i;

  tgi_install(&lynx_160_102_16_tgi);
  tgi_init();
  joy_install(&lynx_stdjoy_joy);
  sfx_init();

  for (;;) {
    tgi_clear();
    tgi_setcolor(COLOR_GREY);
    for (i = 0; i < N_PLATFORMS; i++) {
      tgi_bar(platforms[i].x, platforms[i].y, platforms[i].x + platforms[i].w - 1, platforms[i].y + platforms[i].h - 1);
    }
    tgi_setcolor(COLOR_YELLOW);
    tgi_bar((unsigned)px, (unsigned)py, (unsigned)(px + 6), (unsigned)(py + 6));
    tgi_updatedisplay();
    sfx_update();

    joy = joy_read(JOY_1);
    btn = JOY_BTN_1(joy) ? 1 : 0;
    grounded = on_platform(px, py);

    if (JOY_LEFT(joy)  && px > 0)   px--;
    if (JOY_RIGHT(joy) && px < 154) px++;
    if (btn && !prev && grounded) { vy = -6; sfx_tone(0, 100, 6); }
    prev = btn;

    vy++;
    if (vy > 4) vy = 4;
    py += vy;
    if (py < 0)  py = 0;
    if (py > 96) py = 96;
    if (vy > 0 && on_platform(px, py)) { py = py & 0xFC; vy = 0; }
  }
}
