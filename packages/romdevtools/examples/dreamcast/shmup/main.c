/* Dreamcast SHMUP demo — a vertical shooter scene rendered on the PowerVR2 via the
 * framebuffer path. The ship weaves, bullets stream up, enemies descend + recycle.
 * Self-animating (no input) — proves program-controlled graphics render on the GPU.
 * (DC input via dc_pad() reads the resting controller state; full press wiring is a
 * follow-up — see dc.h.) */
#include "dc.h"

#define NB 12
#define NE 6

static int frame;
static unsigned int rng = 0x1234567u;
static unsigned int rnd(void){ rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng; }

static int bx[NB], by[NB], ba[NB];
static int ex[NE], ey[NE];

void main(void){
    int i;
    dc_video_init();
    for (i = 0; i < NE; i++){ ex[i] = 60 + i*90; ey[i] = -(int)(rnd()%300); }
    for (;;){
        int shipx = DC_W/2 + (int)(80.0 * ((frame % 120) < 60 ? (frame%60) : (60-(frame%60))) / 60.0 - 40);
        int shipy = DC_H - 80;

        /* spawn a bullet every 8 frames */
        if ((frame & 7) == 0){
            for (i = 0; i < NB; i++) if (!ba[i]){ ba[i]=1; bx[i]=shipx; by[i]=shipy; break; }
        }
        dc_clear(dc_rgb(8, 10, 28));
        /* starfield */
        for (i = 0; i < 24; i++){
            int sx = (int)((rnd()%DC_W));
            int sy = (int)((frame*2 + i*53) % DC_H);
            dc_rect(sx, sy, 2, 2, dc_rgb(120,120,160));
        }
        /* enemies */
        for (i = 0; i < NE; i++){
            ey[i] += 2;
            if (ey[i] > DC_H){ ey[i] = -(int)(rnd()%200); ex[i] = (int)(rnd()%(DC_W-40)); }
            if (ey[i] >= 0) dc_rect(ex[i], ey[i], 36, 28, dc_rgb(220, 60, 60));
        }
        /* bullets */
        for (i = 0; i < NB; i++) if (ba[i]){ by[i] -= 8; if (by[i] < 0) ba[i]=0; else dc_rect(bx[i]-2, by[i], 4, 12, dc_rgb(255,240,80)); }
        /* player ship (a little arrow of rects) */
        dc_rect(shipx-4, shipy, 8, 24, dc_rgb(80, 200, 255));
        dc_rect(shipx-16, shipy+14, 32, 8, dc_rgb(60, 160, 230));
        frame++;
    }
}
