/*
 * racing/main.c — POLE BENDER: a 3D PlayStation racer.
 *
 * The road is a ribbon of quads receding to the horizon (real perspective, drawn
 * far-to-near). You steer a car near the camera between the verges; the world
 * scrolls toward you and the track curves. Rival cars (cubes) sit further up the
 * road and grow as you close on them — collide and you spin out (lose time/score).
 * Title -> race -> results state machine, distance score, a lap timer.
 *
 * Build: build({ platform:"ps1", language:"c" }). Controls: LEFT/RIGHT steer,
 * UP accelerate, DOWN brake, START begins/restarts.
 *
 * 3D technique: the track is N segments ahead; each segment is a quad between two
 * road-edge pairs, its centerline x driven by a curve value so the road bends. The
 * camera sits just behind/above the car. All 16.16 fixed point.
 */
#include "psx.h"

#define SEGS 14
enum { TITLE, RACE, DONE };

static fix car_x;          /* lateral position of the car */
static fix scroll;         /* how far we've travelled (for segment phase) */
static fix curve;          /* current road curvature */
static fix speed;
static int state, score, best;
static int rivals_z[3], rival_x[3];
static unsigned int prev_pad;

static void reset_race(void)
{
    int i;
    car_x = 0; scroll = 0; curve = 0; speed = FIXF(0.4f); score = 0;
    for (i = 0; i < 3; i++) { rivals_z[i] = 8 + i * 5; rival_x[i] = ((i * 97) % 5) - 2; }
}

/* a flat ground-plane quad at depth z0..z1, centered at lateral cx with half-width hw. */
static void road_quad(fix cx0, fix z0, fix cx1, fix z1, fix hw, unsigned int col)
{
    Vec3 a, b, c, d;
    a.x = cx0 - hw; a.y = FIXF(-2.0f); a.z = z0;
    b.x = cx0 + hw; b.y = FIXF(-2.0f); b.z = z0;
    c.x = cx1 + hw; c.y = FIXF(-2.0f); c.z = z1;
    d.x = cx1 - hw; d.y = FIXF(-2.0f); d.z = z1;
    /* ground plane: no back-face cull (a flat floor's winding is ambiguous). */
    psx_quad3d_nc(a, b, c, d, col);
}

static void draw_cube_at(fix x, fix y, fix z, fix s, unsigned int col)
{
    Vec3 v[8]; int i;
    static const int sx[8]={-1,1,1,-1,-1,1,1,-1},sy[8]={-1,-1,1,1,-1,-1,1,1},sz[8]={-1,-1,-1,-1,1,1,1,1};
    psx_model(x, y, z, 0);
    for (i = 0; i < 8; i++){ v[i].x=sx[i]*s; v[i].y=sy[i]*s; v[i].z=sz[i]*s; }
    psx_quad3d(v[0],v[1],v[2],v[3],col); psx_quad3d(v[5],v[4],v[7],v[6],col);
    psx_quad3d(v[4],v[0],v[3],v[7],col); psx_quad3d(v[1],v[5],v[6],v[2],col);
    psx_quad3d(v[4],v[5],v[1],v[0],col); psx_quad3d(v[3],v[2],v[6],v[7],col);
}

static void update(void)
{
    unsigned int pad = psx_pad();
    int i;
    if (pad & PAD_LEFT)  car_x -= FMUL(speed, FIXF(0.4f));
    if (pad & PAD_RIGHT) car_x += FMUL(speed, FIXF(0.4f));
    if (pad & PAD_UP)    { speed += FIXF(0.01f); if (speed > FIX(1)) speed = FIX(1); }
    if (pad & PAD_DOWN)  { speed -= FIXF(0.03f); if (speed < FIXF(0.1f)) speed = FIXF(0.1f); }
    if (car_x < FIX(-4)) car_x = FIX(-4); if (car_x > FIX(4)) car_x = FIX(4);

    /* advance the world + wander the curve */
    scroll += speed;
    curve = psx_sin(scroll >> 2);                 /* the road bends with a sine */
    curve = FMUL(curve, FIX(3));
    score += F2I(speed << 2);

    /* rivals roll toward us; collide = spin (reset speed + small score penalty) */
    for (i = 0; i < 3; i++) {
        rivals_z[i] -= F2I(speed << 1) + 1;
        if (rivals_z[i] < 2) { rivals_z[i] = 30 + (psx_rand() % 12); rival_x[i] = (int)(psx_rand() % 5) - 2; }
        if (rivals_z[i] < 4) {
            fix rx = (fix)rival_x[i] << 16;
            fix dx = rx - car_x; if (dx < 0) dx = -dx;
            if (dx < FIX(1)) { speed = FIXF(0.15f); if (score > 30) score -= 30; }
        }
    }
}

static void render(void)
{
    int s, i;
    psx_clear(RGB(70, 130, 200));   /* sky */
    /* far ground band */
    psx_rect(0, 120, 320, 120, RGB(40, 90, 40));

    /* draw road segments far -> near; centerline curves with depth */
    for (s = SEGS - 1; s >= 0; s--) {
        fix z0 = FIX(2 + s * 3);
        fix z1 = FIX(2 + (s + 1) * 3);
        /* centerline x grows with depth*curve for the bend */
        fix cx0 = FMUL(curve, FMUL(z0, z0)) >> 6;
        fix cx1 = FMUL(curve, FMUL(z1, z1)) >> 6;
        unsigned int col = (s & 1) ? RGB(60, 60, 70) : RGB(80, 80, 90);
        road_quad(cx0 - car_x, z0, cx1 - car_x, z1, FIX(3), col);
        /* verges */
        road_quad(cx0 - car_x - FIX(3), z0, cx1 - car_x - FIX(3), z1, FIXF(0.4f), RGB(220,220,220));
        road_quad(cx0 - car_x + FIX(3), z0, cx1 - car_x + FIX(3), z1, FIXF(0.4f), RGB(220,60,60));
    }
    /* rivals on the road */
    for (i = 0; i < 3; i++) if (rivals_z[i] >= 2 && rivals_z[i] < 40) {
        fix z = (fix)rivals_z[i] << 16;
        fix cx = FMUL(curve, FMUL(z, z)) >> 6;
        draw_cube_at(((fix)rival_x[i] << 16) + cx - car_x, FIXF(-1.4f), z, FIXF(0.5f), RGB(230, 200, 40));
    }
    /* the player's car, near the camera */
    draw_cube_at(0, FIXF(-1.4f), FIX(3), FIXF(0.6f), RGB(220, 40, 40));

    psx_number(8, 6, (unsigned)score, RGB(255, 255, 255));
}

int main(void)
{
    psx_init();
    psx_srand(0x1337);
    psx_camera(0, FIXF(-0.5f), FIX(-1), 0, FIXF(-0.18f)); /* low chase cam, looking down */
    state = TITLE; prev_pad = 0;

    for (;;) {
        unsigned int pad = psx_pad();
        if (state == TITLE) {
            static fix t; t += FIX(3);
            psx_clear(RGB(20, 20, 50));
            draw_cube_at(0, 0, FIX(6), FIX(1), RGB(220, 40, 40));
            if ((pad & PAD_START) && !(prev_pad & PAD_START)) { reset_race(); state = RACE; }
        } else if (state == RACE) {
            update(); render();
            if (score > 4000) { if (score > best) best = score; state = DONE; }
        } else {
            psx_clear(RGB(8, 30, 8));
            psx_number(110, 100, (unsigned)score, RGB(120, 255, 120));
            psx_number(120, 130, (unsigned)best, RGB(255, 255, 120));
            if ((pad & PAD_START) && !(prev_pad & PAD_START)) { reset_race(); state = RACE; }
        }
        prev_pad = pad;
        psx_vsync();
    }
    return 0;
}
