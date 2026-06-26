/*
 * platformer/main.c — BLOCK HOP: a 3D PlayStation platformer.
 *
 * A 3D character (cube hero) runs and jumps across floating platforms rendered in
 * perspective. Gravity + jump physics in 16.16 fixed point, AABB landing tests
 * against platform tops, coins to collect, a pit you can fall into (lose a life),
 * a chase camera that follows the hero. Title -> play -> game-over, score + lives.
 *
 * Build: build({ platform:"ps1", language:"c" }). Controls: LEFT/RIGHT run,
 * CROSS jump, START begin/restart.
 *
 * 3D technique: platforms are flat-topped boxes drawn as no-cull quads; the hero
 * is a culled cube. The camera tracks the hero's X with a slight downward tilt so
 * you see the platform tops. Coins are small spinning cubes.
 */
#include "psx.h"

#define NPLAT 6
#define NCOIN 6
enum { TITLE, PLAY, OVER };

typedef struct { fix x, y, z, w; } Plat;   /* top-center + half-width */
static Plat plat[NPLAT];
static struct { fix x, y, z; int got; } coin[NCOIN];

static fix hx, hy, vy;       /* hero pos + vertical velocity */
static int onground;
static int state, score, lives, hi;
static fix cam_x, spin;
static unsigned int prev_pad;

static void box_top(fix cx, fix top, fix z, fix hw, fix depth, unsigned int col)
{
    Vec3 a,b,c,d;
    a.x=cx-hw; a.y=top; a.z=z-depth; b.x=cx+hw; b.y=top; b.z=z-depth;
    c.x=cx+hw; c.y=top; c.z=z+depth; d.x=cx-hw; d.y=top; d.z=z+depth;
    psx_quad3d_nc(a,b,c,d,col);                       /* top face */
    /* front face for thickness */
    a.y=top; b.y=top; c.y=top-FIX(2); d.y=top-FIX(2);
    a.x=cx-hw; a.z=z+depth; b.x=cx+hw; b.z=z+depth; c.x=cx+hw; c.z=z+depth; d.x=cx-hw; d.z=z+depth;
    psx_quad3d_nc(a,b,c,d, col - RGB(20,20,20));
}

static void draw_cube_at(fix x, fix y, fix z, fix s, fix yaw, unsigned int col)
{
    Vec3 v[8]; int i;
    static const int sx[8]={-1,1,1,-1,-1,1,1,-1},sy[8]={-1,-1,1,1,-1,-1,1,1},sz[8]={-1,-1,-1,-1,1,1,1,1};
    psx_model(x,y,z,yaw);
    for(i=0;i<8;i++){v[i].x=sx[i]*s;v[i].y=sy[i]*s;v[i].z=sz[i]*s;}
    psx_quad3d(v[0],v[1],v[2],v[3],col); psx_quad3d(v[5],v[4],v[7],v[6],col);
    psx_quad3d(v[4],v[0],v[3],v[7],col); psx_quad3d(v[1],v[5],v[6],v[2],col);
    psx_quad3d(v[4],v[5],v[1],v[0],col); psx_quad3d(v[3],v[2],v[6],v[7],col);
}

static void reset_game(void)
{
    int i;
    /* a run of platforms along +X with a gap (pit) in the middle */
    for (i = 0; i < NPLAT; i++) {
        plat[i].x = (fix)(i * 4 - 4) << 16;
        plat[i].y = (fix)((i % 3) - 1) << 16;
        plat[i].z = FIX(8);
        plat[i].w = FIX(2);
    }
    plat[3].y = FIX(-6);          /* the pit: a platform dropped far below */
    for (i = 0; i < NCOIN; i++) { coin[i].x = (fix)(i*4-3)<<16; coin[i].y = plat[i].y + FIX(2); coin[i].z = FIX(8); coin[i].got = 0; }
    hx = FIX(-4); hy = FIX(2); vy = 0; onground = 0;
    score = 0; lives = 3;
}

/* find the platform top under the hero's x (or a very low floor = pit). */
static fix ground_at(fix x)
{
    int i; fix best = FIX(-20);
    for (i = 0; i < NPLAT; i++) {
        fix dx = x - plat[i].x; if (dx < 0) dx = -dx;
        if (dx < plat[i].w) { if (plat[i].y > best) best = plat[i].y; }
    }
    return best;
}

static void update(void)
{
    unsigned int pad = psx_pad();
    int i;
    if (pad & PAD_LEFT)  hx -= FIXF(0.18f);
    if (pad & PAD_RIGHT) hx += FIXF(0.18f);
    if (hx < FIX(-6)) hx = FIX(-6); if (hx > FIX(14)) hx = FIX(14);

    if ((pad & PAD_CROSS) && !(prev_pad & PAD_CROSS) && onground) { vy = FIXF(0.55f); onground = 0; }

    vy -= FIXF(0.04f);            /* gravity */
    hy += vy;
    {
        fix g = ground_at(hx) + FIX(1);  /* hero sits 1 unit above the platform top */
        if (hy <= g && vy <= 0) {
            if (g < FIX(-8)) { /* fell in the pit */
                if (--lives <= 0) { if (score>hi) hi=score; state = OVER; }
                hx = FIX(-4); hy = FIX(4); vy = 0;
            } else { hy = g; vy = 0; onground = 1; }
        } else onground = 0;
    }

    for (i = 0; i < NCOIN; i++) if (!coin[i].got) {
        fix dx = hx - coin[i].x, dy = hy - coin[i].y;
        if (dx<0)dx=-dx; if (dy<0)dy=-dy;
        if (dx < FIX(1) && dy < FIX(2)) { coin[i].got = 1; score += 100; }
    }

    cam_x += (hx - cam_x) >> 3;   /* smooth follow */
    spin += FIX(4);
    prev_pad = pad;
}

static void render(void)
{
    int i;
    psx_clear(RGB(40, 60, 120));   /* sky */
    psx_camera(cam_x, FIX(2), FIX(-1), 0, FIXF(-0.22f));

    for (i = 0; i < NPLAT; i++)
        box_top(plat[i].x, plat[i].y, plat[i].z, plat[i].w, FIX(2),
                (i==3)?RGB(120,40,40):RGB(90, 150, 70));
    for (i = 0; i < NCOIN; i++) if (!coin[i].got)
        draw_cube_at(coin[i].x, coin[i].y, coin[i].z, FIXF(0.3f), spin, RGB(255, 220, 40));

    draw_cube_at(hx, hy, FIX(8), FIXF(0.6f), 0, RGB(230, 90, 60));

    psx_number(8, 6, (unsigned)score, RGB(255,255,255));
    for (i = 0; i < lives; i++) psx_rect(290 - i*10, 8, 6, 6, RGB(230, 90, 60));
}

int main(void)
{
    psx_init();
    psx_srand(0xBEEF);
    state = TITLE; prev_pad = 0; cam_x = 0;
    for (;;) {
        unsigned int pad = psx_pad();
        if (state == TITLE) {
            psx_clear(RGB(20, 30, 60));
            psx_camera(0, 0, FIX(-1), 0, 0);
            spin += FIX(3);
            draw_cube_at(0, 0, FIX(6), FIX(1), spin, RGB(230, 90, 60));
            if ((pad & PAD_START) && !(prev_pad & PAD_START)) { reset_game(); state = PLAY; }
            prev_pad = pad;
        } else if (state == PLAY) { update(); render(); }
        else {
            psx_clear(RGB(8, 8, 30));
            psx_number(110, 100, (unsigned)score, RGB(255, 220, 40));
            psx_number(120, 130, (unsigned)hi, RGB(255, 255, 120));
            if ((pad & PAD_START) && !(prev_pad & PAD_START)) { reset_game(); state = PLAY; }
            prev_pad = pad;
        }
        psx_vsync();
    }
    return 0;
}
