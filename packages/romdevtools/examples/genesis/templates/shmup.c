/* ── shmup.c — Genesis SGDK vertical-shooter scaffold ──────────────
 *
 * Complete runnable vertical-shmup baseline:
 *   - Player ship (1×1 tile, d-pad moves, A fires)
 *   - 6 bullet slots, 6 enemy slots (fixed-size object pools)
 *   - Enemy wave spawner: one enemy from the top every ~28 frames
 *   - Linear movement, AABB collision (8×8 vs 8×8)
 *   - 16-bit score, rendered as ASCII via VDP_drawText
 *
 * The hard part on every retro platform is the SAT discipline: the
 * Genesis can only show 80 sprites/frame (H40). We allocate fixed
 * slot ranges so we never have to "find a free slot" mid-frame.
 *   slot 0          → player
 *   slot 1..6       → bullets
 *   slot 7..12      → enemies
 *   total 13 < 80   → no flicker even when all alive
 *
 * Idiomatic SGDK frame heartbeat: SYS_doVBlankProcess() drives the
 * DMA queue, sprite-list flush, joypad poll, sound tick. Forget it
 * and the screen freezes.
 */

#include <genesis.h>
#include "genesis_sfx.h"

#define MAX_BULLETS 6
#define MAX_ENEMIES 6

#define T_BLANK  (TILE_USER_INDEX + 0)
#define T_SHIP   (TILE_USER_INDEX + 1)
#define T_BULLET (TILE_USER_INDEX + 2)
#define T_ENEMY  (TILE_USER_INDEX + 3)

static const u32 tile_blank[8]  = { 0,0,0,0,0,0,0,0 };
static const u32 tile_ship[8]   = {
    0x00011000, 0x00011000, 0x00111100, 0x00111100,
    0x01111110, 0x01111110, 0x11111111, 0x11000011,
};
static const u32 tile_bullet[8] = {
    0x00022000, 0x00022000, 0x00222200, 0x00222200,
    0x00222200, 0x00222200, 0x00022000, 0x00022000,
};
static const u32 tile_enemy[8]  = {
    0x33000033, 0x03333330, 0x33333333, 0x33033033,
    0x33333333, 0x03333330, 0x30000003, 0x03000030,
};

typedef struct { s16 x, y; bool alive; } Obj;

static Obj player;
static Obj bullets[MAX_BULLETS];
static Obj enemies[MAX_ENEMIES];
static u16 score;
static u16 spawn_timer;

static bool aabb_hit(Obj* a, Obj* b) {
    return (a->x < b->x + 8) && (a->x + 8 > b->x)
        && (a->y < b->y + 8) && (a->y + 8 > b->y);
}

/* score as 5-digit ASCII */
static void render_score(void) {
    char buf[6];
    u16 v = score;
    for (s16 i = 4; i >= 0; i--) {
        buf[i] = '0' + (v % 10);
        v /= 10;
    }
    buf[5] = 0;
    VDP_drawText(buf, 32, 1);
}

static void fire_bullet(void) {
    for (u16 i = 0; i < MAX_BULLETS; i++) {
        if (!bullets[i].alive) {
            bullets[i].x = player.x;
            bullets[i].y = player.y - 8;
            bullets[i].alive = TRUE;
            return;
        }
    }
}

static u16 spawn_seed;  /* free-running, advances every spawn (NOT spawn_timer,
                         * which is always 28 at the spawn call → one column) */
static void spawn_enemy(void) {
    for (u16 i = 0; i < MAX_ENEMIES; i++) {
        if (!enemies[i].alive) {
            /* Cheap LCG-ish spread across the playfield so enemies don't all
             * descend in a single column. */
            spawn_seed = (u16)(spawn_seed * 1103 + 12345);
            enemies[i].x = (s16)((spawn_seed >> 4) % (320 - 16) + 8);
            enemies[i].y = -8;
            enemies[i].alive = TRUE;
            return;
        }
    }
}

int main(bool hard) {
    (void)hard;

    /* PAL0 — used by player + font */
    PAL_setColor(0 + 1, 0x0EEE); /* ship white */
    /* PAL1 — bullet */
    PAL_setColor(16 + 2, 0x00EE); /* bullet yellow */
    /* PAL2 — enemy */
    PAL_setColor(32 + 3, 0x000E); /* enemy red */

    sfx_init();

    VDP_loadTileData(tile_blank,  T_BLANK,  1, DMA);
    VDP_loadTileData(tile_ship,   T_SHIP,   1, DMA);
    VDP_loadTileData(tile_bullet, T_BULLET, 1, DMA);
    VDP_loadTileData(tile_enemy,  T_ENEMY,  1, DMA);

    player.x = 152; player.y = 180; player.alive = TRUE;
    for (u16 i = 0; i < MAX_BULLETS; i++) bullets[i].alive = FALSE;
    for (u16 i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = FALSE;
    score = 0;
    spawn_timer = 0;

    VDP_drawText("SCORE", 26, 1);
    VDP_drawText("D-PAD MOVE   A FIRE", 10, 26);

    u16 prev = 0;

    while (TRUE) {
        u16 pad = JOY_readJoypad(JOY_1);

        if (pad & BUTTON_LEFT  && player.x > 8)        player.x -= 2;
        if (pad & BUTTON_RIGHT && player.x < 320 - 16) player.x += 2;
        if (pad & BUTTON_UP    && player.y > 16)       player.y -= 2;
        if (pad & BUTTON_DOWN  && player.y < 224 - 16) player.y += 2;
        if ((pad & BUTTON_A) && !(prev & BUTTON_A)) {
            fire_bullet();
            sfx_tone(1, 200, 4);   /* pew */
        }
        prev = pad;

        for (u16 i = 0; i < MAX_BULLETS; i++) {
            if (!bullets[i].alive) continue;
            bullets[i].y -= 4;
            if (bullets[i].y < -8) bullets[i].alive = FALSE;
        }
        for (u16 i = 0; i < MAX_ENEMIES; i++) {
            if (!enemies[i].alive) continue;
            enemies[i].y += 1;
            if (enemies[i].y > 224) enemies[i].alive = FALSE;
        }
        if (++spawn_timer >= 28) {
            spawn_timer = 0;
            spawn_enemy();
        }

        /* Bullet × enemy collisions. */
        for (u16 i = 0; i < MAX_BULLETS; i++) {
            if (!bullets[i].alive) continue;
            for (u16 j = 0; j < MAX_ENEMIES; j++) {
                if (!enemies[j].alive) continue;
                if (aabb_hit(&bullets[i], &enemies[j])) {
                    bullets[i].alive = FALSE;
                    enemies[j].alive = FALSE;
                    if (score < 65500) score += 10;
                    sfx_noise(8);   /* explosion */
                    break;
                }
            }
        }

        /* Stage the SAT for this frame. */
        VDP_setSprite(0, player.x, player.y, SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(PAL0, 1, 0, 0, T_SHIP));
        for (u16 i = 0; i < MAX_BULLETS; i++) {
            s16 by = bullets[i].alive ? bullets[i].y : -16;
            VDP_setSprite(1 + i, bullets[i].x, by, SPRITE_SIZE(1, 1),
                          TILE_ATTR_FULL(PAL1, 1, 0, 0, T_BULLET));
        }
        for (u16 i = 0; i < MAX_ENEMIES; i++) {
            s16 ey = enemies[i].alive ? enemies[i].y : -16;
            VDP_setSprite(7 + i, enemies[i].x, ey, SPRITE_SIZE(1, 1),
                          TILE_ATTR_FULL(PAL2, 1, 0, 0, T_ENEMY));
        }
        /* CHAIN the sprite linked list before uploading: VDP_setSprite does NOT
         * set the link byte, and the SAT link bytes init to 0 (= "end of list"),
         * so the VDP's sprite walk stops after slot 0 → only ONE sprite draws.
         * VDP_linkSprites(0, N) links slots 0..N-1 so all N render. */
        VDP_linkSprites(0, 1 + MAX_BULLETS + MAX_ENEMIES);
        VDP_updateSprites(1 + MAX_BULLETS + MAX_ENEMIES, DMA);

        render_score();

        sfx_update();
        SYS_doVBlankProcess();
    }
    return 0;
}
