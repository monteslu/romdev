/* dchello — a minimal Dreamcast homebrew that draws a recognizable test pattern,
 * proving the romdev DC pipeline renders program-controlled graphics end-to-end. */
#include "dc.h"

void main(void) {
    dc_video_init();

    /* Clear to a dark blue background. */
    dc_clear(dc_rgb(16, 24, 64));

    /* Three solid bars (red, green, blue) — distinct, easy to verify in a screenshot. */
    dc_rect(64, 80, 160, 320, dc_rgb(220, 40, 40));    /* red   */
    dc_rect(240, 80, 160, 320, dc_rgb(40, 200, 60));   /* green */
    dc_rect(416, 80, 160, 320, dc_rgb(50, 90, 230));   /* blue  */

    /* A white frame around the screen. */
    dc_rect(0, 0, DC_W, 4, dc_rgb(255, 255, 255));
    dc_rect(0, DC_H - 4, DC_W, 4, dc_rgb(255, 255, 255));
    dc_rect(0, 0, 4, DC_H, dc_rgb(255, 255, 255));
    dc_rect(DC_W - 4, 0, 4, DC_H, dc_rgb(255, 255, 255));

    /* Hold the frame. */
    for (;;) { }
}
