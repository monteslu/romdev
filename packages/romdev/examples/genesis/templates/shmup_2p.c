/* ── shmup_2p.c — Genesis SGDK two-player competitive shooter ───────
 *
 * Same shape as `shmup` but with TWO player ships, one per controller
 * port. Each player has their own bullet pool (4 slots each) and their
 * own score. Enemies are shared — first hit wins the points. Cooperate
 * to survive longer; compete on the score counter.
 *
 * Designed for the romdev playtest window with two USB
 * controllers plugged in (R23c hot-plug lands a 2nd pad in port 1).
 * When no second pad is connected, port 2's ship just sits idle — the
 * single-player `shmup` template is still the right pick for that case.
 *
 * SAT layout (well under the 80-sprite Genesis cap):
 *   slot 0          → player 1 (port 0)
 *   slot 1          → player 2 (port 1)
 *   slot 2..5       → P1 bullets (4)
 *   slot 6..9       → P2 bullets (4)
 *   slot 10..15     → enemies (6)
 *   total 16 < 80   → zero flicker
 */

#include <genesis.h>
#include "genesis_sfx.h"

#define MAX_BULLETS_PP 4
#define MAX_ENEMIES    6

#define T_BLANK   (TILE_USER_INDEX + 0)
#define T_SHIP_P1 (TILE_USER_INDEX + 1)
#define T_SHIP_P2 (TILE_USER_INDEX + 2)
#define T_BULLET  (TILE_USER_INDEX + 3)
#define T_ENEMY   (TILE_USER_INDEX + 4)

static const u32 tile_blank[8]   = { 0,0,0,0,0,0,0,0 };
/* P1 ship — palette 0 colour 1 (white). */
static const u32 tile_ship_p1[8] = {
    0x00011000, 0x00011000, 0x00111100, 0x00111100,
    0x01111110, 0x01111110, 0x11111111, 0x11000011,
};
/* P2 ship — palette 0 colour 4 (we'll set to red below). */
static const u32 tile_ship_p2[8] = {
    0x00044000, 0x00044000, 0x00444400, 0x00444400,
    0x04444440, 0x04444440, 0x44444444, 0x44000044,
};
static const u32 tile_bullet[8]  = {
    0x00022000, 0x00022000, 0x00222200, 0x00222200,
    0x00222200, 0x00222200, 0x00022000, 0x00022000,
};
static const u32 tile_enemy[8]   = {
    0x33000033, 0x03333330, 0x33333333, 0x33033033,
    0x33333333, 0x03333330, 0x30000003, 0x03000030,
};

typedef struct { s16 x, y; bool alive; } Obj;

static Obj p1, p2;
static Obj p1_bullets[MAX_BULLETS_PP];
static Obj p2_bullets[MAX_BULLETS_PP];
static Obj enemies[MAX_ENEMIES];
static u16 score_p1, score_p2;
static u16 spawn_timer;

static bool aabb(Obj* a, Obj* b) {
    return (a->x < b->x + 8) && (a->x + 8 > b->x)
        && (a->y < b->y + 8) && (a->y + 8 > b->y);
}

static void fire(Obj* ship, Obj* pool) {
    u16 i;
    for (i = 0; i < MAX_BULLETS_PP; i++) {
        if (!pool[i].alive) {
            pool[i].x = ship->x;
            pool[i].y = ship->y - 8;
            pool[i].alive = TRUE;
            return;
        }
    }
}

static void spawn_enemy(void) {
    u16 i;
    for (i = 0; i < MAX_ENEMIES; i++) {
        if (!enemies[i].alive) {
            enemies[i].x = ((spawn_timer * 37) & 0xFF) % (320 - 16) + 8;
            enemies[i].y = -8;
            enemies[i].alive = TRUE;
            return;
        }
    }
}

static void render_scores(void) {
    char buf[6];
    u16 v;
    s16 i;
    /* P1 score in top-left. */
    v = score_p1;
    for (i = 4; i >= 0; i--) { buf[i] = '0' + (v % 10); v /= 10; }
    buf[5] = 0;
    VDP_drawText(buf, 2, 1);
    /* P2 score in top-right. */
    v = score_p2;
    for (i = 4; i >= 0; i--) { buf[i] = '0' + (v % 10); v /= 10; }
    VDP_drawText(buf, 33, 1);
}

int main(bool hard) {
    (void)hard;

    /* Palette 0:
     *   1 = white  (P1 ship)
     *   2 = yellow (bullets)
     *   3 = (unused)
     *   4 = red    (P2 ship)
     */
    PAL_setColor(0 + 1, 0x0EEE);
    PAL_setColor(0 + 2, 0x00EE);
    PAL_setColor(0 + 4, 0x000E);
    /* Palette 2 = enemy red */
    PAL_setColor(32 + 3, 0x00EE);

    sfx_init();

    VDP_loadTileData(tile_blank,   T_BLANK,   1, DMA);
    VDP_loadTileData(tile_ship_p1, T_SHIP_P1, 1, DMA);
    VDP_loadTileData(tile_ship_p2, T_SHIP_P2, 1, DMA);
    VDP_loadTileData(tile_bullet,  T_BULLET,  1, DMA);
    VDP_loadTileData(tile_enemy,   T_ENEMY,   1, DMA);

    p1.x = 100; p1.y = 180; p1.alive = TRUE;
    p2.x = 220; p2.y = 180; p2.alive = TRUE;
    {
        u16 i;
        for (i = 0; i < MAX_BULLETS_PP; i++) p1_bullets[i].alive = FALSE;
        for (i = 0; i < MAX_BULLETS_PP; i++) p2_bullets[i].alive = FALSE;
        for (i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = FALSE;
    }
    score_p1 = 0;
    score_p2 = 0;
    spawn_timer = 0;

    VDP_drawText("P1",    1, 1);
    VDP_drawText("P2",   32, 1);
    VDP_drawText("D-PAD MOVE  A/C FIRE", 10, 26);

    u16 prev1 = 0, prev2 = 0;

    while (TRUE) {
        u16 pad1 = JOY_readJoypad(JOY_1);
        u16 pad2 = JOY_readJoypad(JOY_2);

        /* P1 movement + fire. */
        if (pad1 & BUTTON_LEFT  && p1.x > 8)          p1.x -= 2;
        if (pad1 & BUTTON_RIGHT && p1.x < 320 - 16)   p1.x += 2;
        if (pad1 & BUTTON_UP    && p1.y > 16)         p1.y -= 2;
        if (pad1 & BUTTON_DOWN  && p1.y < 224 - 16)   p1.y += 2;
        if ((pad1 & BUTTON_A) && !(prev1 & BUTTON_A)) { fire(&p1, p1_bullets); sfx_tone(1, 200, 4); }
        prev1 = pad1;

        /* P2 movement + fire (uses C button so A/C → P1 fire, P2 fire feel symmetric). */
        if (pad2 & BUTTON_LEFT  && p2.x > 8)          p2.x -= 2;
        if (pad2 & BUTTON_RIGHT && p2.x < 320 - 16)   p2.x += 2;
        if (pad2 & BUTTON_UP    && p2.y > 16)         p2.y -= 2;
        if (pad2 & BUTTON_DOWN  && p2.y < 224 - 16)   p2.y += 2;
        if ((pad2 & BUTTON_A) && !(prev2 & BUTTON_A)) { fire(&p2, p2_bullets); sfx_tone(2, 250, 4); }
        prev2 = pad2;

        /* Bullet motion + offscreen cleanup. */
        u16 i, j;
        for (i = 0; i < MAX_BULLETS_PP; i++) {
            if (p1_bullets[i].alive) {
                p1_bullets[i].y -= 4;
                if (p1_bullets[i].y < -8) p1_bullets[i].alive = FALSE;
            }
            if (p2_bullets[i].alive) {
                p2_bullets[i].y -= 4;
                if (p2_bullets[i].y < -8) p2_bullets[i].alive = FALSE;
            }
        }

        /* Enemy motion + cleanup. */
        for (i = 0; i < MAX_ENEMIES; i++) {
            if (!enemies[i].alive) continue;
            enemies[i].y += 1;
            if (enemies[i].y > 224) enemies[i].alive = FALSE;
        }
        if (++spawn_timer >= 28) {
            spawn_timer = 0;
            spawn_enemy();
        }

        /* Bullet × enemy collisions — whoever hit first scores. */
        for (j = 0; j < MAX_ENEMIES; j++) {
            if (!enemies[j].alive) continue;
            for (i = 0; i < MAX_BULLETS_PP; i++) {
                if (p1_bullets[i].alive && aabb(&p1_bullets[i], &enemies[j])) {
                    p1_bullets[i].alive = FALSE;
                    enemies[j].alive = FALSE;
                    if (score_p1 < 65500) score_p1 += 10;
                    sfx_noise(8);
                    break;
                }
            }
            if (!enemies[j].alive) continue;
            for (i = 0; i < MAX_BULLETS_PP; i++) {
                if (p2_bullets[i].alive && aabb(&p2_bullets[i], &enemies[j])) {
                    p2_bullets[i].alive = FALSE;
                    enemies[j].alive = FALSE;
                    if (score_p2 < 65500) score_p2 += 10;
                    sfx_noise(8);
                    break;
                }
            }
        }

        /* SAT staging — fixed slot layout. */
        VDP_setSprite(0, p1.x, p1.y, SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(PAL0, 1, 0, 0, T_SHIP_P1));
        VDP_setSprite(1, p2.x, p2.y, SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(PAL0, 1, 0, 0, T_SHIP_P2));
        for (i = 0; i < MAX_BULLETS_PP; i++) {
            s16 by = p1_bullets[i].alive ? p1_bullets[i].y : -16;
            VDP_setSprite(2 + i, p1_bullets[i].x, by, SPRITE_SIZE(1, 1),
                          TILE_ATTR_FULL(PAL0, 1, 0, 0, T_BULLET));
        }
        for (i = 0; i < MAX_BULLETS_PP; i++) {
            s16 by = p2_bullets[i].alive ? p2_bullets[i].y : -16;
            VDP_setSprite(6 + i, p2_bullets[i].x, by, SPRITE_SIZE(1, 1),
                          TILE_ATTR_FULL(PAL0, 1, 0, 0, T_BULLET));
        }
        for (i = 0; i < MAX_ENEMIES; i++) {
            s16 ey = enemies[i].alive ? enemies[i].y : -16;
            VDP_setSprite(10 + i, enemies[i].x, ey, SPRITE_SIZE(1, 1),
                          TILE_ATTR_FULL(PAL2, 1, 0, 0, T_ENEMY));
        }
        VDP_updateSprites(16, DMA);

        render_scores();

        sfx_update();
        SYS_doVBlankProcess();
    }
    return 0;
}
