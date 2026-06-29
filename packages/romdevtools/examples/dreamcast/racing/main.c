/* Dreamcast RACING demo — a pseudo-3D road that curves + scrolls toward a horizon,
 * with a car at the bottom that drifts side to side. Self-animating (no input).
 * Renders on the PowerVR2 framebuffer. */
#include "dc.h"

/* tiny fixed sine via a 16-entry quarter table */
static const int SIN16[17] = {0,49,97,142,181,213,236,251,256,251,236,213,181,142,97,49,0};
static int isin(int a){ a &= 63; if(a<16) return SIN16[a]; if(a<32) return SIN16[32-a]; if(a<48) return -SIN16[a-32]; return -SIN16[64-a]; }

void main(void){
    int frame = 0, y;
    dc_video_init();
    for (;;){
        int horizon = DC_H/3;
        dc_clear(dc_rgb(60, 140, 230));               /* sky */
        dc_rect(0, horizon, DC_W, DC_H-horizon, dc_rgb(40, 120, 50)); /* grass */

        /* road: for each scanline below the horizon, a trapezoid widening to the
           bottom, shifted by a curve that scrolls. */
        for (y = horizon; y < DC_H; y++){
            int depth = y - horizon;
            int half = depth * (DC_W/2 - 20) / (DC_H - horizon) + 12;
            int curve = isin((frame/2 + depth/4)) * depth / 256;
            int cx = DC_W/2 + curve;
            /* road stripe alternation for motion */
            u16 rc = (((depth + frame) / 12) & 1) ? dc_rgb(70,70,75) : dc_rgb(90,90,95);
            dc_rect(cx - half, y, half*2, 1, rc);
            /* center dashes */
            if ((((depth + frame*2)/16) & 1)) dc_rect(cx-2, y, 4, 1, dc_rgb(240,240,120));
        }
        /* the car (drifts L/R) */
        { int carx = DC_W/2 + isin(frame/3) * 60 / 256 - 24;
          dc_rect(carx, DC_H-70, 48, 40, dc_rgb(220, 40, 40));
          dc_rect(carx+6, DC_H-64, 36, 14, dc_rgb(40,40,60));     /* windshield */
          dc_rect(carx-4, DC_H-44, 10, 18, dc_rgb(20,20,20));     /* wheels */
          dc_rect(carx+42, DC_H-44, 10, 18, dc_rgb(20,20,20)); }
        frame++;
    }
}
