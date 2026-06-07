/* ── shmup.c — Game Boy vertical-shooter scaffold ────────────────────
 *
 * Mirrors the NES/Genesis/SNES shmup scaffolds for the Game Boy:
 *   - Player ship at OAM slot 0
 *   - 4 bullet slots, 4 enemy slots (smaller pools for the Game Boy's
 *     40-sprite hard cap — total = 9, leaves plenty of headroom)
 *   - Wave spawner every ~28 frames
 *   - Linear movement, AABB collision (8×8 vs 8×8)
 *   - Score rendered to OAM digits would need a font tile blob; we
 *     keep a running u16 score in WRAM for now — extend with BG-map
 *     text rendering when you wire a font.
 *
 * GB OAM coords are HARDWARE coords: visible Y range is 16..160,
 * visible X range is 8..168. Y=0 hides the sprite (off-screen).
 */

#include "gb_hardware.h"
#include "gb_runtime.h"

#define MAX_BULLETS 4
#define MAX_ENEMIES 4

static const uint8_t tile_blank[16] = { 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0 };
static const uint8_t tile_ship[16] = {
    0x18,0x18, 0x3C,0x3C, 0x7E,0x7E, 0xFF,0xFF,
    0xFF,0xFF, 0x7E,0x7E, 0x3C,0x3C, 0x18,0x18,
};
static const uint8_t tile_bullet[16] = {
    0x00,0x00, 0x18,0x18, 0x3C,0x3C, 0x3C,0x3C,
    0x3C,0x3C, 0x3C,0x3C, 0x18,0x18, 0x00,0x00,
};
static const uint8_t tile_enemy[16] = {
    0x81,0x81, 0x42,0x42, 0x24,0x24, 0xFF,0xFF,
    0xFF,0xFF, 0x24,0x24, 0x42,0x42, 0x81,0x81,
};

static const uint16_t obj_palette[4] = {
    0x7FFF, /* 0 transparent */
    0x7FFF, /* 1 white   — player ship */
    0x03FF, /* 2 yellow  — bullets */
    0x001F, /* 3 red     — enemies */
};

/* CGB BG palette 0 — used for the dark-blue starfield background. */
static const uint16_t bg_palette[4] = {
    0x2842, /* 0 deep space blue */
    0x4A52, /* 1 mid blue */
    0x6B5A, /* 2 light blue (stars) */
    0x7FFF, /* 3 white (highlight) */
};

typedef struct { uint8_t x, y, alive; } Obj;

static Obj player;
static Obj bullets[MAX_BULLETS];
static Obj enemies[MAX_ENEMIES];
static uint16_t score;
static uint8_t spawn_timer;

static uint8_t aabb(Obj *a, Obj *b) {
    /* Coord conversion: sprites are stored in screen coords here
     * (px..px+8) NOT hardware coords. We translate to hardware in OAM. */
    return a->x < b->x + 8 && a->x + 8 > b->x
        && a->y < b->y + 8 && a->y + 8 > b->y;
}

static void fire(void) {
    uint8_t i;
    for (i = 0; i < MAX_BULLETS; i++) {
        if (!bullets[i].alive) {
            bullets[i].x = player.x;
            bullets[i].y = player.y - 8;
            bullets[i].alive = 1;
            return;
        }
    }
}

static void spawn(void) {
    uint8_t i;
    for (i = 0; i < MAX_ENEMIES; i++) {
        if (!enemies[i].alive) {
            enemies[i].x = ((spawn_timer * 37) & 0x7F) % (160 - 16) + 8;
            enemies[i].y = 0;
            enemies[i].alive = 1;
            return;
        }
    }
}

static void upload_tile(uint8_t slot, const uint8_t *src) {
    uint8_t *dst = (uint8_t *)(0x8000 + slot * 16);
    uint8_t i;
    for (i = 0; i < 16; i++) dst[i] = src[i];
}

void main(void) {
    uint8_t pad, prev = 0;
    uint8_t i, j;

    lcd_init_default();
    LCDC = 0;

    upload_tile(0, tile_blank);
    upload_tile(1, tile_ship);
    upload_tile(2, tile_bullet);
    upload_tile(3, tile_enemy);

    /* Sprite palette 0 — uploaded to OCPS/OCPD (CGB-only registers). */
    OCPS = 0x80;
    for (i = 0; i < 4; i++) {
        OCPD = (uint8_t)(obj_palette[i] & 0xFF);
        OCPD = (uint8_t)((obj_palette[i] >> 8) & 0xFF);
    }

    /* BG palette 0 — starfield background colors. */
    BCPS = 0x80;
    for (i = 0; i < 4; i++) {
        BCPD = (uint8_t)(bg_palette[i] & 0xFF);
        BCPD = (uint8_t)((bg_palette[i] >> 8) & 0xFF);
    }

    player.x = 76; player.y = 130; player.alive = 1;
    for (i = 0; i < MAX_BULLETS; i++) bullets[i].alive = 0;
    for (i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = 0;
    score = 0;
    spawn_timer = 0;

    oam_clear();
    LCDC = LCDC_LCD_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO;
    sound_init();

    while (1) {
        wait_vblank();

        /* Stage OAM for this frame BEFORE we update game state — the
         * shadow OAM gets DMA'd next vblank. */
        for (i = 0; i < 40; i++) oam_set(i, 0, 0, 0, 0);
        oam_set(0, player.y + 16, player.x + 8, 1, 0);
        for (i = 0; i < MAX_BULLETS; i++) {
            if (bullets[i].alive)
                oam_set(1 + i, bullets[i].y + 16, bullets[i].x + 8, 2, 0);
        }
        for (i = 0; i < MAX_ENEMIES; i++) {
            if (enemies[i].alive)
                oam_set(5 + i, enemies[i].y + 16, enemies[i].x + 8, 3, 0);
        }
        oam_dma_flush();

        pad = joypad_read();

        if (pad & PAD_LEFT  && player.x > 0)        player.x -= 2;
        if (pad & PAD_RIGHT && player.x < 160 - 8)  player.x += 2;
        if (pad & PAD_UP    && player.y > 0)        player.y -= 2;
        if (pad & PAD_DOWN  && player.y < 144 - 8)  player.y += 2;
        if ((pad & PAD_A) && !(prev & PAD_A)) {
            fire();
            sound_play_tone(2, 1900, 4);
        }
        prev = pad;

        for (i = 0; i < MAX_BULLETS; i++) {
            if (!bullets[i].alive) continue;
            if (bullets[i].y < 4) { bullets[i].alive = 0; continue; }
            bullets[i].y -= 4;
        }
        for (i = 0; i < MAX_ENEMIES; i++) {
            if (!enemies[i].alive) continue;
            enemies[i].y += 1;
            if (enemies[i].y >= 144) enemies[i].alive = 0;
        }
        if (++spawn_timer >= 28) { spawn_timer = 0; spawn(); }

        for (i = 0; i < MAX_BULLETS; i++) {
            if (!bullets[i].alive) continue;
            for (j = 0; j < MAX_ENEMIES; j++) {
                if (!enemies[j].alive) continue;
                if (aabb(&bullets[i], &enemies[j])) {
                    bullets[i].alive = 0;
                    enemies[j].alive = 0;
                    if (score < 65500u) score += 10;
                    sound_play_noise(6);
                    break;
                }
            }
        }
    }
}
