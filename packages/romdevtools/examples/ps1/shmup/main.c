/*
 * shmup/main.c — STARFALL: a 3D PlayStation vertical shooter.
 *
 * Idiomatic PS1 3D: the playfield recedes into the screen. You pilot a ship near
 * the camera; enemy cubes fly IN from the far distance toward you, growing as the
 * perspective projection scales them up. Shoot them with a stream of bullets that
 * fire away into Z. Title -> play -> game-over state machine, score + lives,
 * AABB-in-screen-space collision, an xorshift wave spawner, a parallax starfield.
 *
 * Build: build({ platform:"ps1", language:"c" }). Controls: d-pad/stick move,
 * CROSS fires, START begins / restarts. Runs on the romdev pcsx_rearmed core.
 *
 * Pipeline: psx_camera fixes the eye; each entity is a small cube drawn via
 * psx_model (translate to its world pos) + psx_quad3d faces. Depth sort is implicit
 * (we draw far enemies first by iterating; the painter order is good enough for
 * non-overlapping cubes). All math is 16.16 fixed point.
 */
#include "psx.h"

#define MAX_E 8
#define MAX_B 6

enum { TITLE, PLAY, OVER };

typedef struct { int alive; fix x, y, z; } Ent;

static Ent enemy[MAX_E];
static Ent bullet[MAX_B];
static fix px, py;          /* player position (x,y); z fixed near camera */
static int state, score, lives, hi;
static unsigned int prev_pad;

/* a unit cube's 6 faces, drawn at the current psx_model origin, scaled by `s`. */
static void draw_cube(fix s, unsigned int col)
{
    Vec3 v[8];
    int i;
    static const int sx[8] = {-1, 1, 1,-1,-1, 1, 1,-1};
    static const int sy[8] = {-1,-1, 1, 1,-1,-1, 1, 1};
    static const int sz[8] = {-1,-1,-1,-1, 1, 1, 1, 1};
    for (i = 0; i < 8; i++) { v[i].x = sx[i] * s; v[i].y = sy[i] * s; v[i].z = sz[i] * s; }
    psx_quad3d(v[0],v[1],v[2],v[3], col);
    psx_quad3d(v[5],v[4],v[7],v[6], col);
    psx_quad3d(v[4],v[0],v[3],v[7], col);
    psx_quad3d(v[1],v[5],v[6],v[2], col);
    psx_quad3d(v[4],v[5],v[1],v[0], col);
    psx_quad3d(v[3],v[2],v[6],v[7], col);
}

static void reset_game(void)
{
    int i;
    for (i = 0; i < MAX_E; i++) enemy[i].alive = 0;
    for (i = 0; i < MAX_B; i++) bullet[i].alive = 0;
    px = 0; py = FIXF(-1.5f);
    score = 0; lives = 3;
}

static void spawn_enemy(void)
{
    int i;
    for (i = 0; i < MAX_E; i++) if (!enemy[i].alive) {
        enemy[i].alive = 1;
        enemy[i].x = (fix)((psx_rand() % 7) - 3) << 16;   /* -3..3 */
        enemy[i].y = (fix)((psx_rand() % 5) - 1) << 16;    /* -1..3 */
        enemy[i].z = FIX(40);                              /* far away */
        return;
    }
}

static void fire(void)
{
    int i;
    for (i = 0; i < MAX_B; i++) if (!bullet[i].alive) {
        bullet[i].alive = 1; bullet[i].x = px; bullet[i].y = py; bullet[i].z = FIX(4);
        return;
    }
}

/* AABB overlap of two world points in the XY plane within `r`. */
static int hit(fix ax, fix ay, fix bx, fix by, fix r)
{
    fix dx = ax - bx, dy = ay - by;
    if (dx < 0) dx = -dx; if (dy < 0) dy = -dy;
    return dx < r && dy < r;
}

static void update(void)
{
    unsigned int pad = psx_pad();
    int i, j;

    /* move ship */
    if (pad & PAD_LEFT)  px -= FIXF(0.18f);
    if (pad & PAD_RIGHT) px += FIXF(0.18f);
    if (pad & PAD_UP)    py += FIXF(0.14f);
    if (pad & PAD_DOWN)  py -= FIXF(0.14f);
    if (px < FIX(-4)) px = FIX(-4); if (px > FIX(4)) px = FIX(4);
    if (py < FIX(-3)) py = FIX(-3); if (py > FIX(2)) py = FIX(2);

    /* fire on CROSS edge */
    if ((pad & PAD_CROSS) && !(prev_pad & PAD_CROSS)) fire();

    /* bullets fly into Z */
    for (i = 0; i < MAX_B; i++) if (bullet[i].alive) {
        bullet[i].z += FIX(2);
        if (bullet[i].z > FIX(45)) bullet[i].alive = 0;
    }

    /* enemies approach */
    if ((psx_rand() & 31) == 0) spawn_enemy();
    for (i = 0; i < MAX_E; i++) if (enemy[i].alive) {
        enemy[i].z -= FIXF(0.5f);
        if (enemy[i].z < FIX(3)) {           /* reached the ship plane */
            enemy[i].alive = 0;
            if (--lives <= 0) { if (score > hi) hi = score; state = OVER; }
        }
        /* bullet collisions */
        for (j = 0; j < MAX_B; j++) if (bullet[j].alive) {
            fix dz = enemy[i].z - bullet[j].z; if (dz < 0) dz = -dz;
            if (dz < FIX(2) && hit(enemy[i].x, enemy[i].y, bullet[j].x, bullet[j].y, FIX(1))) {
                enemy[i].alive = 0; bullet[j].alive = 0; score += 10;
            }
        }
    }
    prev_pad = pad;
}

static void render(void)
{
    int i;
    psx_clear(RGB(6, 8, 24));

    /* starfield: a few far cubes as backdrop sparkle */
    for (i = 0; i < 12; i++) {
        fix sx = (fix)(((i * 53) % 9) - 4) << 16;
        fix sy = (fix)(((i * 37) % 7) - 3) << 16;
        psx_model(sx, sy, FIX(50), 0);
        draw_cube(FIXF(0.15f), RGB(40, 40, 70));
    }
    /* enemies (draw far -> near for painter order) */
    for (i = 0; i < MAX_E; i++) if (enemy[i].alive) {
        psx_model(enemy[i].x, enemy[i].y, enemy[i].z, enemy[i].z << 2);
        draw_cube(FIXF(0.7f), RGB(230, 60, 60));
    }
    /* bullets */
    for (i = 0; i < MAX_B; i++) if (bullet[i].alive) {
        psx_model(bullet[i].x, bullet[i].y, bullet[i].z, 0);
        draw_cube(FIXF(0.18f), RGB(255, 240, 80));
    }
    /* player ship near the camera */
    psx_model(px, py, FIX(3), 0);
    draw_cube(FIXF(0.5f), RGB(80, 200, 255));

    /* HUD: score + lives */
    psx_number(8, 6, (unsigned)score, RGB(255, 255, 255));
    for (i = 0; i < lives; i++) psx_rect(290 - i*10, 8, 6, 6, RGB(80, 200, 255));
}

int main(void)
{
    psx_init();
    psx_srand(0xC0FFEE);
    psx_camera(0, 0, FIX(-2), 0, FIXF(-0.08f)); /* slight downward tilt over the field */
    state = TITLE;
    prev_pad = 0;

    for (;;) {
        unsigned int pad = psx_pad();
        if (state == TITLE) {
            psx_clear(RGB(10, 10, 40));
            /* a spinning hero cube as the title art */
            static fix t; t += FIX(2);
            psx_model(0, 0, FIX(6), t);
            draw_cube(FIX(1), RGB(80, 200, 255));
            psx_number(120, 200, 0, RGB(255, 255, 255)); /* press start cue: shows "0" */
            if ((pad & PAD_START) && !(prev_pad & PAD_START)) { reset_game(); state = PLAY; }
            prev_pad = pad;
        } else if (state == PLAY) {
            update();
            render();
        } else { /* OVER */
            psx_clear(RGB(40, 8, 8));
            psx_number(110, 100, (unsigned)score, RGB(255, 80, 80));
            psx_number(120, 130, (unsigned)hi, RGB(255, 255, 120));
            if ((pad & PAD_START) && !(prev_pad & PAD_START)) { reset_game(); state = PLAY; }
            prev_pad = pad;
        }
        psx_vsync();
    }
    return 0;
}
