/* Dreamcast PLATFORMER demo — a side-scrolling scene: a hero hops across platforms
 * while the camera scrolls. Self-animating (no input). Renders on the PowerVR2 via
 * the framebuffer path. */
#include "dc.h"

void main(void){
    int frame = 0;
    dc_video_init();
    for (;;){
        int scroll = (frame * 2) % (DC_W);
        int t = frame % 90;
        int jump = t < 45 ? t : (90 - t);              /* 0..45..0 hop */
        int hy = DC_H - 140 - jump * 2;
        int hx = DC_W/2 - 16;

        dc_clear(dc_rgb(80, 150, 230));                /* sky */
        /* parallax hills */
        { int i; for (i = -1; i < 6; i++){ int x = i*140 - (scroll/2); dc_rect(x, DC_H-200, 120, 200, dc_rgb(60, 170, 90)); } }
        /* ground */
        dc_rect(0, DC_H-60, DC_W, 60, dc_rgb(120, 80, 40));
        /* floating platforms (scrolling) */
        { int i; for (i = -1; i < 6; i++){ int x = i*180 - (scroll % 180); dc_rect(x, DC_H-160, 90, 18, dc_rgb(150, 110, 60)); } }
        /* hero (head + body) */
        dc_rect(hx, hy, 32, 32, dc_rgb(240, 90, 70));
        dc_rect(hx+6, hy+6, 6, 6, dc_rgb(255,255,255)); /* eye */
        dc_rect(hx, hy+32, 32, 20, dc_rgb(40, 60, 200)); /* legs */
        /* a coin that bobs */
        dc_rect(DC_W/2 + 120 - (scroll%240), DC_H-220 + (jump), 18, 18, dc_rgb(255, 220, 60));
        frame++;
    }
}
