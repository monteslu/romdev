/* ── default.c — minimal Atari Lynx starter ──────────────────────
 *
 * Boots TGI (cc65's graphics layer over Suzy's blitter), draws a
 * color-cycling square + greeting. Smallest possible "ROM that does
 * something visible" — use this as the starting point when you're
 * not yet sure what you want to build.
 *
 * For something more game-shaped:
 *   - hello_sprite — joystick-moved sprite
 *   - shmup / platformer / puzzle / sports / racing — genre scaffolds
 *   - music_demo   — cc65's lynx_snd_play streaming music engine
 */

#include <tgi.h>
#include <lynx.h>

void main(void) {
  static const unsigned char palette[8] = {
    COLOR_RED,    COLOR_YELLOW, COLOR_GREEN,     COLOR_LIGHTBLUE,
    COLOR_BLUE,   COLOR_PURPLE, COLOR_LIGHTGREEN, COLOR_WHITE,
  };
  unsigned char shade = 0;
  unsigned int  frame = 0;

  tgi_install(&lynx_160_102_16_tgi);
  tgi_init();

  for (;;) {
    tgi_clear();
    tgi_setcolor(palette[shade]);
    tgi_bar(70, 40, 90, 62);
    tgi_setcolor(COLOR_WHITE);
    tgi_outtextxy(2, 2, "HELLO LYNX");
    tgi_updatedisplay();

    frame++;
    if ((frame & 0x1F) == 0) {        /* every 32 frames */
      shade = (shade + 1) & 0x07;
    }
  }
}
