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

/* Draw a 5-digit score at pixel (x,8) WITHOUT tte_printf. The bundled libtonc's
 * tte_printf with a %d/%05d conversion is broken (it routes through a vsnprintf
 * path that isn't wired in this build — it garbles the output AND wedges the
 * game loop when called per-frame, GBA-1). We build the string ourselves and
 * use tte_write, which processes the #{P:x,y} position command but does NO
 * format conversion → safe every frame. */
static void draw_score(int x, unsigned v) {
    char buf[24];
    int i, n = 0;
    /* "#{P:<x>,8}" position command, then 5 decimal digits. */
    buf[n++]='#'; buf[n++]='{'; buf[n++]='P'; buf[n++]=':';
    if (x >= 100) buf[n++] = '0' + (x/100)%10;
    if (x >= 10)  buf[n++] = '0' + (x/10)%10;
    buf[n++] = '0' + x%10;
    buf[n++]=','; buf[n++]='8'; buf[n++]='}';
    for (i = 4; i >= 0; i--) { buf[n+i] = '0' + (v % 10); v /= 10; }
    n += 5; buf[n] = 0;
    tte_write(buf);
}

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

/* ── Starfield backdrop tiles (4bpp) ─────────────────────────────────
 * Two space-coloured fill tiles (palette indices 4 and 5) laid in
 * vertical bands so the whole BG is filled — NOT a flat blank backdrop.
 * A handful of star pixels (index 6) are punched into each tile so the
 * field reads as space rather than a solid block. */
static const u32 tile_star_a[8] = {
    0x44464444, 0x44444444, 0x46444444, 0x44444644,
    0x44444444, 0x64444444, 0x44444444, 0x44446444,
};
static const u32 tile_star_b[8] = {
    0x55555555, 0x55655555, 0x55555555, 0x55555565,
    0x65555555, 0x55555555, 0x55556555, 0x55555555,
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

/* Galois LFSR (taps $B8), period 255 -- real per-spawn randomness.
 * The old code derived the spawn column from spawn_timer, but the caller
 * resets spawn_timer just before calling here, so it was CONSTANT and
 * every enemy spawned in the same left column/lane. */
static u8 rng_state = 0xA5;
static u8 rand8(void) {
  u8 lsb = (u8)(rng_state & 1);
  rng_state >>= 1;
  if (lsb) rng_state ^= 0xB8;
  return rng_state;
}

static void spawn_enemy(void) {
    for (int i = 0; i < MAX_ENEMIES; i++) {
        if (!enemies[i].alive) {
            /* cheap deterministic x scatter */
            enemies[i].x = rand8() % (240 - 16) + 8;
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

    /* ── Starfield backdrop on BG0 ───────────────────────────────────
     * Fill the whole screen with a banded space backdrop + scattered
     * stars so the playfield doesn't read as a blank black screen. BG
     * palette indices 4/5 = the two space bands, 6 = star colour. Tile
     * data → char-block 0, map → screen-block 28 (clear of TTE on
     * char-block 2 / screen-block 30). BG0 sits at the lowest priority
     * so the ship/bullets/enemies draw in front of it. */
    pal_bg_mem[0] = CLR_BLACK;
    pal_bg_mem[4] = RGB15(1, 2, 7);    /* dark space band   */
    pal_bg_mem[5] = RGB15(2, 3, 10);   /* lighter band      */
    pal_bg_mem[6] = RGB15(28, 28, 31); /* stars             */
    tonccpy(&tile_mem[0][4], tile_star_a, sizeof(tile_star_a));
    tonccpy(&tile_mem[0][5], tile_star_b, sizeof(tile_star_b));
    REG_BG0CNT = BG_CBB(0) | BG_SBB(28) | BG_REG_32x32 | BG_4BPP | BG_PRIO(3);
    {
        SCR_ENTRY *map = se_mem[28];
        for (int ty = 0; ty < 32; ty++)
            for (int tx = 0; tx < 32; tx++)
                map[ty * 32 + tx] = SE_BUILD(4 + ((ty >> 1) & 1), 0, 0, 0);
    }

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

    /* TTE on BG1 at screen-block 30, char-block 2 (BG0 holds the
     * starfield). Renders into VRAM tile map — no libsysbase / iprintf
     * dependency. BG1 priority 0 → score/hint text in front. */
    tte_init_chr4c_default(1, BG_CBB(2) | BG_SBB(30));
    REG_BG1CNT |= BG_PRIO(0);
    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0 | DCNT_BG1 | DCNT_OBJ | DCNT_OBJ_1D;
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
                    if (score < 65500u) score += 10;
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

        /* Score: 5 digits via draw_score (NOT tte_printf — see GBA-1). */
        tte_erase_rect(8 + 6*8, 8, 8 + 11*8, 16);
        draw_score(8 + 6*8, score);
    }
    return 0;
}
