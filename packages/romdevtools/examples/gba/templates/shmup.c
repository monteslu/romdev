/* ── shmup.c — Game Boy Advance Tonc vertical-shooter scaffold ──────
 *
 * Complete runnable vertical-shmup baseline:
 *   - Player ship (1 sprite, d-pad moves, A fires)
 *   - 6 bullet slots, 6 enemy slots (fixed-size object pools)
 *   - Enemy wave spawner: one enemy from the top every ~28 frames
 *   - Linear movement, AABB collision (8x8 vs 8x8)
 *   - 16-bit score, rendered as text via TTE (Tonc Text Engine)
 *
 * Sprite slot discipline (GBA has 128 OAM entries, more than enough):
 *   slot 0          → player
 *   slot 1..6       → bullets
 *   slot 7..12      → enemies
 *   total 13 << 128 → no flicker
 *
 * Idiomatic Tonc frame heartbeat: VBlankIntrWait() + key_poll() at the
 * top of every frame, oam_copy() at the bottom. Update positions in a
 * shadow OAM buffer (obj_buffer[]); copy to hardware OAM in one DMA.
 */

#include <tonc.h>
#include "gba_sfx.h"

#define MAX_BULLETS 6
#define MAX_ENEMIES 6

#define TILE_BLANK  0
#define TILE_SHIP   1
#define TILE_BULLET 2
#define TILE_ENEMY  3

/* 4bpp tiles (8 rows × 32 bits each = 32 bytes). Each nibble is a
 * palette index. Index 0 = transparent. */
static const u32 tile_ship[8] = {
    0x00011000, 0x00011000, 0x00111100, 0x00111100,
    0x01111110, 0x01111110, 0x11111111, 0x11000011,
};
static const u32 tile_bullet[8] = {
    0x00022000, 0x00022000, 0x00222200, 0x00222200,
    0x00222200, 0x00222200, 0x00022000, 0x00022000,
};
static const u32 tile_enemy[8] = {
    0x33000033, 0x03333330, 0x33333333, 0x33033033,
    0x33333333, 0x03333330, 0x30000003, 0x03000030,
};

typedef struct { s16 x, y; u16 alive; } Obj;

static OBJ_ATTR obj_buffer[128];

static Obj player;
static Obj bullets[MAX_BULLETS];
static Obj enemies[MAX_ENEMIES];
static u16 score;
static u16 spawn_timer;

static int aabb_hit(const Obj *a, const Obj *b) {
    return (a->x < b->x + 8) && (a->x + 8 > b->x)
        && (a->y < b->y + 8) && (a->y + 8 > b->y);
}

static void fire_bullet(void) {
    for (int i = 0; i < MAX_BULLETS; i++) {
        if (!bullets[i].alive) {
            bullets[i].x = player.x;
            bullets[i].y = player.y - 8;
            bullets[i].alive = 1;
            return;
        }
    }
}

static void spawn_enemy(void) {
    for (int i = 0; i < MAX_ENEMIES; i++) {
        if (!enemies[i].alive) {
            /* cheap deterministic x scatter */
            enemies[i].x = ((spawn_timer * 37) & 0xFF) % (240 - 16) + 8;
            enemies[i].y = -8;
            enemies[i].alive = 1;
            return;
        }
    }
}

int main(void) {
    /* ── Sprite tiles ─ char base 4 is the OBJ tile area in BG mode 0 ─ */
    tonccpy(&tile_mem[4][TILE_SHIP],   tile_ship,   sizeof(tile_ship));
    tonccpy(&tile_mem[4][TILE_BULLET], tile_bullet, sizeof(tile_bullet));
    tonccpy(&tile_mem[4][TILE_ENEMY],  tile_enemy,  sizeof(tile_enemy));

    /* ── Sprite palette ── one palette bank per object class ─────────
     * pal_obj_bank[N][i] = colour i of bank N. Index 0 = transparent. */
    pal_obj_bank[0][1] = CLR_WHITE;   /* ship */
    pal_obj_bank[1][2] = CLR_YELLOW;  /* bullets */
    pal_obj_bank[2][3] = CLR_RED;     /* enemies */

    oam_init(obj_buffer, 128);

    /* IRQ setup — required for VBlankIntrWait() to function. */
    irq_init(NULL);
    irq_add(II_VBLANK, NULL);

    sfx_init();

    player.x = 116; player.y = 130; player.alive = 1;
    for (int i = 0; i < MAX_BULLETS; i++) bullets[i].alive = 0;
    for (int i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = 0;
    score = 0;
    spawn_timer = 0;

    /* TTE on BG0 at screen-block 31, char-block 0. Renders into VRAM
     * tile map — no libsysbase / iprintf dependency. */
    tte_init_chr4c_default(0, BG_CBB(0) | BG_SBB(31));
    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0 | DCNT_OBJ | DCNT_OBJ_1D;
    tte_write("#{P:8,8}SCORE 00000");
    tte_write("#{P:8,144}D-PAD MOVE  A FIRE");

    u16 prev = 0;

    while (1) {
        VBlankIntrWait();
        key_poll();

        if (key_held(KEY_LEFT)  && player.x > 8)        player.x -= 2;
        if (key_held(KEY_RIGHT) && player.x < 240 - 16) player.x += 2;
        if (key_held(KEY_UP)    && player.y > 24)       player.y -= 2;
        if (key_held(KEY_DOWN)  && player.y < 160 - 24) player.y += 2;

        u16 now = key_curr_state();
        if ((now & KEY_A) && !(prev & KEY_A)) {
            fire_bullet();
            sfx_tone(2, 1900, 4);   /* pew */
        }
        prev = now;

        for (int i = 0; i < MAX_BULLETS; i++) {
            if (!bullets[i].alive) continue;
            bullets[i].y -= 4;
            if (bullets[i].y < -8) bullets[i].alive = 0;
        }
        for (int i = 0; i < MAX_ENEMIES; i++) {
            if (!enemies[i].alive) continue;
            enemies[i].y += 1;
            if (enemies[i].y > 160) enemies[i].alive = 0;
        }
        if (++spawn_timer >= 28) { spawn_timer = 0; spawn_enemy(); }

        /* Bullet × enemy collisions. */
        for (int i = 0; i < MAX_BULLETS; i++) {
            if (!bullets[i].alive) continue;
            for (int j = 0; j < MAX_ENEMIES; j++) {
                if (!enemies[j].alive) continue;
                if (aabb_hit(&bullets[i], &enemies[j])) {
                    bullets[i].alive = 0;
                    enemies[j].alive = 0;
                    if (score < 65500) score += 10;
                    sfx_noise(6);   /* explosion */
                    break;
                }
            }
        }

        /* ── Stage shadow OAM ────────────────────────────────────────
         * Slot 0: player. Slots 1..6: bullets. Slots 7..12: enemies.
         * Hide inactive slots by parking them offscreen (y = 160). */
        obj_set_attr(&obj_buffer[0],
            ATTR0_SQUARE,
            ATTR1_SIZE_8,
            ATTR2_PALBANK(0) | TILE_SHIP);
        obj_set_pos(&obj_buffer[0], player.x, player.y);

        for (int i = 0; i < MAX_BULLETS; i++) {
            int by = bullets[i].alive ? bullets[i].y : 200;
            obj_set_attr(&obj_buffer[1 + i],
                ATTR0_SQUARE,
                ATTR1_SIZE_8,
                ATTR2_PALBANK(1) | TILE_BULLET);
            obj_set_pos(&obj_buffer[1 + i], bullets[i].x, by);
        }
        for (int i = 0; i < MAX_ENEMIES; i++) {
            int ey = enemies[i].alive ? enemies[i].y : 200;
            obj_set_attr(&obj_buffer[7 + i],
                ATTR0_SQUARE,
                ATTR1_SIZE_8,
                ATTR2_PALBANK(2) | TILE_ENEMY);
            obj_set_pos(&obj_buffer[7 + i], enemies[i].x, ey);
        }

        oam_copy(oam_mem, obj_buffer, 128);

        /* Score: 5-digit ASCII via TTE printf. Tte handles VRAM tile
         * writes — safe to call once per frame. */
        tte_erase_rect(8 + 6*8, 8, 8 + 11*8, 16);
        tte_printf("#{P:%d,8}%05d", 8 + 6*8, score);
    }
    return 0;
}
