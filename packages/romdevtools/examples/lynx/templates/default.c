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
  /* Cycle the centre square through warm/bright shades only — NOT the
   * blues, which would blend into the blue background and make the
   * screen read as "almost one colour". */
  static const unsigned char palette[6] = {
    COLOR_RED,   COLOR_YELLOW,     COLOR_GREEN,
    COLOR_WHITE, COLOR_LIGHTGREEN, COLOR_PURPLE,
  };
  unsigned char shade = 0;
  unsigned int  frame = 0;

  tgi_install(&lynx_160_102_16_tgi);
  tgi_init();

  for (;;) {
    /* CANONICAL LYNX FRAME LOOP — full redraw every frame, in this order:
     *   1. WAIT for Suzy's blitter to finish the previous frame. Drawing
     *      while it's mid-flight loses the frame → black screen. This is
     *      the #1 "Lynx stays blank" trap.
     *   2. CLEAR with a full-screen tgi_bar in the background colour, NOT
     *      tgi_clear() — which leaves the back page stale in this
     *      toolchain+emulator path (the other genre scaffolds all do the
     *      same; see shmup.c's LYNX-1 note).
     *   3. DRAW everything.
     *   4. tgi_updatedisplay() to push the frame. */
    while (tgi_busy()) { }

    /* Blue field so the screen is obviously not blank. */
    tgi_setcolor(COLOR_BLUE);
    tgi_bar(0, 0, tgi_getmaxx(), tgi_getmaxy());

    /* A fixed green frame around the centre — always a distinct colour,
     * so the screen never collapses to a single shade even while the
     * inner square is cycling. */
    tgi_setcolor(COLOR_GREEN);
    tgi_bar(50, 30, 110, 72);

    /* Colour-cycling square in the centre. */
    tgi_setcolor(palette[shade]);
    tgi_bar(60, 36, 100, 66);

    /* Greeting on top. The tgi font is 8 px wide; "BUILT WITH ROMDEV"
     * is 17 chars = 136 px, so start near the left edge to stay inside
     * the 160-px-wide screen. */
    tgi_setcolor(COLOR_WHITE);
    tgi_outtextxy(40, 14, "HELLO LYNX");
    tgi_outtextxy(12, 86, "BUILT WITH ROMDEV");
    tgi_updatedisplay();

    frame++;
    if ((frame % 24) == 0) {          /* advance the inner square */
      shade++;
      if (shade >= 6) shade = 0;
    }
  }
}
