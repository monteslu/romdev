/*
 * sports/main.c — SLAM COURT: a 3D Nintendo 64 sports game (air-hockey / pong).
 *
 * A 3D playfield seen in perspective: you control the near paddle, the CPU the far
 * one. A ball bounces down the court in 3D (X across, Z into the screen); rally it
 * past the CPU to score, miss and the CPU scores. First to 7. Title -> match ->
 * game-over. The whole court is drawn with the perspective pipeline; the ball's
 * size changes with depth, selling the 3D.
 *
 * Build: build({ platform:"n64", language:"c" }). Controls: LEFT/RIGHT move your
 * paddle, START begin/restart.
 *
 * 3D technique: the court floor is a big no-cull quad; paddles + ball are cubes at
 * world positions. The CPU paddle tracks the ball's X with a capped speed. 16.16 fp.
 */
#include "n64.h"

enum { TITLE, PLAY, OVER };

static fix px;               /* player paddle X (near, z = small) */
static fix cx;               /* cpu paddle X (far, z = big) */
static fix bx, bz, bvx, bvz; /* ball position + velocity */
static int you, cpu, state;
static unsigned int prev_pad;

#define COURT_HW  FIX(5)     /* court half-width */
#define NEAR_Z    FIX(3)
#define FAR_Z     FIX(22)

static void draw_cube_at(fix x, fix y, fix z, fix s, unsigned short col)
{
    Vec3 v[8]; int i;
    static const int sx[8]={-1,1,1,-1,-1,1,1,-1},sy[8]={-1,-1,1,1,-1,-1,1,1},sz[8]={-1,-1,-1,-1,1,1,1,1};
    n64_model(x,y,z,0);
    for(i=0;i<8;i++){v[i].x=sx[i]*s;v[i].y=sy[i]*s;v[i].z=sz[i]*s;}
    n64_quad3d(v[0],v[1],v[2],v[3],col); n64_quad3d(v[5],v[4],v[7],v[6],col);
    n64_quad3d(v[4],v[0],v[3],v[7],col); n64_quad3d(v[1],v[5],v[6],v[2],col);
    n64_quad3d(v[4],v[5],v[1],v[0],col); n64_quad3d(v[3],v[2],v[6],v[7],col);
}

static void serve(int toward_cpu)
{
    bx = 0; bz = (NEAR_Z + FAR_Z) >> 1;
    bvx = (n64_rand() & 1) ? FIXF(0.12f) : FIXF(-0.12f);
    bvz = toward_cpu ? FIXF(0.45f) : FIXF(-0.45f);
}

static void reset_game(void) { px = 0; cx = 0; you = 0; cpu = 0; serve(1); }

static void update(void)
{
    unsigned int pad = n64_pad();
    if (pad & PAD_LEFT)  px -= FIXF(0.22f);
    if (pad & PAD_RIGHT) px += FIXF(0.22f);
    if (px < -COURT_HW) px = -COURT_HW; if (px > COURT_HW) px = COURT_HW;

    /* cpu tracks the ball, capped */
    { fix d = bx - cx; if (d > FIXF(0.16f)) d = FIXF(0.16f); if (d < -FIXF(0.16f)) d = -FIXF(0.16f); cx += d; }

    bx += bvx; bz += bvz;
    if (bx < -COURT_HW || bx > COURT_HW) bvx = -bvx;  /* side walls */

    /* near paddle (player) */
    if (bz <= NEAR_Z) {
        fix d = bx - px; if (d < 0) d = -d;
        if (d < FIX(2)) { bvz = -bvz; bz = NEAR_Z; bvx += (bx - px) >> 4; }
        else { cpu++; if (cpu >= 7) { state = OVER; } else serve(1); }
    }
    /* far paddle (cpu) */
    if (bz >= FAR_Z) {
        fix d = bx - cx; if (d < 0) d = -d;
        if (d < FIX(2)) { bvz = -bvz; bz = FAR_Z; }
        else { you++; if (you >= 7) { state = OVER; } else serve(0); }
    }
    prev_pad = pad;
}

static void render(void)
{
    Vec3 a,b,c,d;
    n64_clear(RGB(20, 40, 30));
    n64_camera(0, FIX(4), FIX(-1), 0, FIXF(-0.30f)); /* look down the court */

    /* court floor */
    a.x=-COURT_HW; a.y=0; a.z=NEAR_Z; b.x=COURT_HW; b.y=0; b.z=NEAR_Z;
    c.x=COURT_HW;  c.y=0; c.z=FAR_Z;  d.x=-COURT_HW; d.y=0; d.z=FAR_Z;
    n64_quad3d_nc(a,b,c,d, RGB(40, 90, 60));
    /* center line */
    a.x=-COURT_HW; a.z=(NEAR_Z+FAR_Z)>>1; b.x=COURT_HW; b.z=a.z;
    c.x=COURT_HW; c.z=a.z+FIXF(0.3f); d.x=-COURT_HW; d.z=c.z;
    a.y=FIXF(0.02f);b.y=a.y;c.y=a.y;d.y=a.y;
    n64_quad3d_nc(a,b,c,d, RGB(220,220,220));

    draw_cube_at(px, FIXF(0.5f), NEAR_Z, FIXF(0.9f), RGB(80, 180, 255)); /* you */
    draw_cube_at(cx, FIXF(0.5f), FAR_Z,  FIXF(0.9f), RGB(255, 100, 80)); /* cpu */
    draw_cube_at(bx, FIXF(0.5f), bz, FIXF(0.4f), RGB(255, 240, 120));    /* ball */

    n64_number(40, 8, (unsigned)you, RGB(80, 180, 255));
    n64_number(240, 8, (unsigned)cpu, RGB(255, 100, 80));
}

int main(void)
{
    n64_init();
    n64_srand(0x5A11);
    state = TITLE; prev_pad = 0;
    for (;;) {
        unsigned int pad = n64_pad();
        if (state == TITLE) {
            static fix t; t += FIX(3);
            n64_clear(RGB(15, 30, 25));
            n64_camera(0, 0, FIX(-1), 0, 0);
            draw_cube_at(0, 0, FIX(6), FIX(1), RGB(80, 180, 255));
            if ((pad & PAD_START) && !(prev_pad & PAD_START)) { reset_game(); state = PLAY; }
            prev_pad = pad;
        } else if (state == PLAY) { update(); render(); }
        else {
            n64_clear(RGB(8, 20, 16));
            n64_number(120, 100, (unsigned)you, RGB(80, 180, 255));
            n64_number(160, 100, (unsigned)cpu, RGB(255, 100, 80));
            if ((pad & PAD_START) && !(prev_pad & PAD_START)) { reset_game(); state = PLAY; }
            prev_pad = pad;
        }
        n64_flip();
    }
    return 0;
}
