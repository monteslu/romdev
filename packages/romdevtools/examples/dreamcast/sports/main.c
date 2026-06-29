/* Dreamcast SPORTS demo — a top-down pong/air-hockey rally: two paddles track a
 * bouncing ball with a scoreboard. Self-animating (the CPU "AI" plays both sides).
 * Renders on the PowerVR2 framebuffer. */
#include "dc.h"

void main(void){
    int frame = 0;
    int bx = DC_W/2, by = DC_H/2, vx = 5, vy = 3;
    int p0 = DC_H/2, p1 = DC_H/2;          /* paddle centers (y) */
    int s0 = 0, s1 = 0, i;
    dc_video_init();
    for (;;){
        /* ball physics */
        bx += vx; by += vy;
        if (by < 12 || by > DC_H-12) vy = -vy;
        /* paddles track the ball (simple AI) */
        if (p0 < by) p0 += 4; else p0 -= 4;
        if (p1 < by) p1 += 4; else p1 -= 4;
        /* bounce off paddles / score */
        if (bx < 40){ if (by > p0-50 && by < p0+50) vx = -vx; else { s1++; bx=DC_W/2; by=DC_H/2; vx=5; } }
        if (bx > DC_W-40){ if (by > p1-50 && by < p1+50) vx = -vx; else { s0++; bx=DC_W/2; by=DC_H/2; vx=-5; } }

        dc_clear(dc_rgb(15, 60, 30));                  /* court green */
        /* center line (dashed) */
        for (i = 0; i < DC_H; i += 32) dc_rect(DC_W/2-2, i+8, 4, 16, dc_rgb(200,200,200));
        /* top/bottom rails */
        dc_rect(0, 0, DC_W, 8, dc_rgb(220,220,220));
        dc_rect(0, DC_H-8, DC_W, 8, dc_rgb(220,220,220));
        /* paddles */
        dc_rect(24, p0-50, 14, 100, dc_rgb(80, 160, 255));
        dc_rect(DC_W-38, p1-50, 14, 100, dc_rgb(255, 160, 80));
        /* ball */
        dc_rect(bx-8, by-8, 16, 16, dc_rgb(255, 240, 80));
        /* scoreboard (score as stacked pips) */
        for (i = 0; i < s0 && i < 9; i++) dc_rect(DC_W/2 - 60 - i*10, 16, 8, 8, dc_rgb(80,160,255));
        for (i = 0; i < s1 && i < 9; i++) dc_rect(DC_W/2 + 56 + i*10, 16, 8, 8, dc_rgb(255,160,80));
        frame++; (void)frame;
    }
}
