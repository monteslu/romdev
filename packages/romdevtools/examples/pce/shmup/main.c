/*
 * PC Engine "shmup" — a vertical shoot-'em-up scaffold.
 *
 * Fly a ship around the bottom of the screen with the d-pad and fire upward
 * with button I. Enemies spawn at the top in waves and drift down; a bullet
 * that overlaps an enemy destroys it and scores 10. The HUD shows the score
 * with background digit tiles. A scrolling starfield BG keeps the screen full
 * (so it clears the verify gate and the sprites read clearly).
 *
 * Mirrors the NES/Genesis/SNES/GB/SMS shmup scaffolds, translated to the PCE
 * helper API:
 *   - object pools (player + bullets + enemies) updated each frame
 *   - AABB collision
 *   - a wave spawner on a frame counter
 *   - 64-sprite shadow SATB + satb_dma()
 *
 * PCE notes (see pce_hw.h / MENTAL_MODEL.md):
 *   - disp_enable() turns on BG + sprites AND the VBlank IRQ so waitvsync()
 *     actually returns (without the IRQ bit the loop spins forever).
 *   - .bss must be non-empty; pce_video.c's _pce_keep[] covers that, and we
 *     touch _pce_keep[0] for clarity.
 *   - sprites get the SPBG-front bit from set_sprite(), so they draw over the
 *     opaque starfield BG.
 *
 * cc65 is C89 — declare locals at the top of a block.
 */
#include <pce.h>
#include "pce_hw.h"

/* ---- VRAM layout (word addresses) --------------------------------------- */
#define BAT_VRAM     0x0000   /* 32x32 background map                        */
#define FONT_VRAM    0x1000   /* digit/glyph tiles (8x8, 16 words each)      */
#define STAR0_VRAM   0x1400   /* BG tile: empty space (solid colour 1)       */
#define STAR1_VRAM   0x1410   /* BG tile: space band (solid colour 2)        */
#define STAR2_VRAM   0x1420   /* BG tile: space + a star pixel               */
#define SHIP_VRAM    0x1800   /* 16x16 player ship                           */
#define BULLET_VRAM  0x1840   /* 16x16 bullet                                */
#define ENEMY_VRAM   0x1880   /* 16x16 enemy                                 */

#define BAT_ENTRY(pal, vram)  ((u16)(((pal) << 12) | ((vram) >> 4)))

#define MAX_BULLETS 6
#define MAX_ENEMIES 6

/* ---- 5x7 glyph font (digits + a few letters for the HUD) ----------------- */
#define G_BLANK 0
#define G_0     1   /* digits 0..9 -> tiles 1..10 */
#define G_S     11
#define G_C     12
#define G_O     13
#define G_R     14
#define G_E     15
#define NUM_GLYPHS 16

static const u8 FONT5x7[NUM_GLYPHS][7] = {
    /* BLANK */ {0,0,0,0,0,0,0},
    /* 0 */ {0x0E,0x11,0x13,0x15,0x19,0x11,0x0E},
    /* 1 */ {0x04,0x0C,0x04,0x04,0x04,0x04,0x0E},
    /* 2 */ {0x0E,0x11,0x01,0x02,0x04,0x08,0x1F},
    /* 3 */ {0x1F,0x02,0x04,0x02,0x01,0x11,0x0E},
    /* 4 */ {0x02,0x06,0x0A,0x12,0x1F,0x02,0x02},
    /* 5 */ {0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E},
    /* 6 */ {0x06,0x08,0x10,0x1E,0x11,0x11,0x0E},
    /* 7 */ {0x1F,0x01,0x02,0x04,0x08,0x08,0x08},
    /* 8 */ {0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E},
    /* 9 */ {0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C},
    /* S */ {0x0F,0x10,0x10,0x0E,0x01,0x01,0x1E},
    /* C */ {0x0E,0x11,0x10,0x10,0x10,0x11,0x0E},
    /* O */ {0x0E,0x11,0x11,0x11,0x11,0x11,0x0E},
    /* R */ {0x1E,0x11,0x11,0x1E,0x14,0x12,0x11},
    /* E */ {0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F},
};

/* ---- game state --------------------------------------------------------- */
typedef struct { u16 x, y; u8 alive; } Obj;

static Obj player;
static Obj bullets[MAX_BULLETS];
static Obj enemies[MAX_ENEMIES];
static u16 score;
static u8  spawn_timer;
static u16 rng;
static u8  pad, prev_pad;
static u8  sfx_timer;

static u16 tile_buf[16];      /* scratch for one 8x8 tile                    */
static u16 spr_buf[64];       /* scratch for one 16x16 sprite                */

/* ---- tile/sprite builders ----------------------------------------------- */
static void make_solid_tile(u16 *t, u8 ci) {
    u8 r;
    u8 p0 = (ci & 1) ? 0xFF : 0x00;
    u8 p1 = (ci & 2) ? 0xFF : 0x00;
    u8 p2 = (ci & 4) ? 0xFF : 0x00;
    u8 p3 = (ci & 8) ? 0xFF : 0x00;
    for (r = 0; r < 8; ++r) {
        t[r]     = (u16)(p0 | (p1 << 8));
        t[r + 8] = (u16)(p2 | (p3 << 8));
    }
}

/* space tile with one star pixel in colour index 3 at (row 2, col 5) */
static void make_star_tile(u16 *t) {
    u8 r;
    for (r = 0; r < 8; ++r) { t[r] = 0x00FF; t[r + 8] = 0x0000; } /* base = colour 1 */
    /* star = colour 3 (planes 0+1) at row 2: set plane1 bit too for that row */
    t[2] = (u16)(0x00FF | (0x04 << 8));   /* plane0 row + plane1 single pixel */
}

/* upload one 16x16 sprite from a 16-row body mask in colour `ci` */
static void make_sprite(u16 vram, const u16 *body, u8 ci) {
    u8 r;
    for (r = 0; r < 64; ++r) spr_buf[r] = 0;
    for (r = 0; r < 16; ++r) {
        if (ci & 1) spr_buf[r]      = body[r];        /* plane0 */
        if (ci & 2) spr_buf[r + 16] = body[r];        /* plane1 */
        if (ci & 4) spr_buf[r + 32] = body[r];        /* plane2 */
        if (ci & 8) spr_buf[r + 48] = body[r];        /* plane3 */
    }
    load_tiles(vram, spr_buf, 64);
}

static void upload_font(void) {
    u8 g, row, bits, plane0;
    for (g = 0; g < NUM_GLYPHS; ++g) {
        for (row = 0; row < 16; ++row) tile_buf[row] = 0;
        for (row = 0; row < 7; ++row) {
            bits = FONT5x7[g][row];
            plane0 = 0;
            if (bits & 0x10) plane0 |= 0x40;
            if (bits & 0x08) plane0 |= 0x20;
            if (bits & 0x04) plane0 |= 0x10;
            if (bits & 0x02) plane0 |= 0x08;
            if (bits & 0x01) plane0 |= 0x04;
            tile_buf[row] = (u16)plane0;
        }
        load_tiles((u16)(FONT_VRAM + g * 16), tile_buf, 16);
    }
}

static void upload_art(void) {
    /* ship: an upward-pointing arrow */
    static const u16 ship[16] = {
        0x0180, 0x0180, 0x03C0, 0x03C0, 0x07E0, 0x07E0, 0x0FF0, 0x0FF0,
        0x1FF8, 0x1FF8, 0x3FFC, 0x7FFE, 0xFFFF, 0xE187, 0xC003, 0x8001
    };
    /* bullet: a small vertical pellet */
    static const u16 bullet[16] = {
        0x0000, 0x0180, 0x03C0, 0x03C0, 0x07E0, 0x07E0, 0x07E0, 0x07E0,
        0x07E0, 0x07E0, 0x03C0, 0x03C0, 0x0180, 0x0000, 0x0000, 0x0000
    };
    /* enemy: a downward, blocky invader */
    static const u16 enemy[16] = {
        0x0000, 0x4002, 0x6006, 0x7FFE, 0x7FFE, 0xFDBF, 0xFFFF, 0xFFFF,
        0xFFFF, 0x7FFE, 0x3FFC, 0x1FF8, 0x300C, 0x6006, 0x4002, 0x0000
    };
    upload_font();
    make_solid_tile(tile_buf, 1); load_tiles(STAR0_VRAM, tile_buf, 16);
    make_solid_tile(tile_buf, 2); load_tiles(STAR1_VRAM, tile_buf, 16);
    make_star_tile(tile_buf);     load_tiles(STAR2_VRAM, tile_buf, 16);
    make_sprite(SHIP_VRAM,   ship,   1);   /* white   */
    make_sprite(BULLET_VRAM, bullet, 1);   /* white (sub-pal 1 = yellow) */
    make_sprite(ENEMY_VRAM,  enemy,  1);   /* white (sub-pal 2 = red)    */
}

/* ---- BAT / HUD ---------------------------------------------------------- */
static void draw_starfield(void) {
    u8 r, c;
    u16 e0 = BAT_ENTRY(0, STAR0_VRAM);
    u16 e1 = BAT_ENTRY(0, STAR1_VRAM);
    u16 e2 = BAT_ENTRY(0, STAR2_VRAM);
    u16 e;
    for (r = 0; r < 32; ++r) {
        vram_set_write_addr((u16)(BAT_VRAM + r * 32));
        for (c = 0; c < 32; ++c) {
            e = (r & 2) ? e1 : e0;                       /* depth bands */
            if (((r * 7 + c * 5) & 7) == 0) e = e2;      /* sparse stars */
            VDC_DATA_LO = (u8)(e & 0xFF);
            VDC_DATA_HI = (u8)(e >> 8);
        }
    }
}

static void put_glyph(u8 col, u8 row, u8 glyph) {
    u16 e = BAT_ENTRY(0, (u16)(FONT_VRAM + glyph * 16));
    vram_set_write_addr((u16)(BAT_VRAM + row * 32 + col));
    VDC_DATA_LO = (u8)(e & 0xFF);
    VDC_DATA_HI = (u8)(e >> 8);
}

static void draw_hud_label(void) {
    static const u8 lbl[5] = { G_S, G_C, G_O, G_R, G_E };
    u8 i;
    for (i = 0; i < 5; ++i) put_glyph((u8)(1 + i), 1, lbl[i]);
}

static void draw_score(void) {
    u16 v = score;
    u8 d0, d1, d2, d3;
    d3 = (u8)(v % 10); v /= 10;
    d2 = (u8)(v % 10); v /= 10;
    d1 = (u8)(v % 10); v /= 10;
    d0 = (u8)(v % 10);
    put_glyph(7,  1, (u8)(G_0 + d0));
    put_glyph(8,  1, (u8)(G_0 + d1));
    put_glyph(9,  1, (u8)(G_0 + d2));
    put_glyph(10, 1, (u8)(G_0 + d3));
}

/* ---- gameplay helpers --------------------------------------------------- */
static u8 aabb(Obj *a, Obj *b) {
    return (u8)(a->x < b->x + 14 && a->x + 14 > b->x &&
                a->y < b->y + 14 && a->y + 14 > b->y);
}

static u16 next_rand(void) {
    rng = (u16)(rng * 25173u + 13849u);
    return rng;
}

static void fire(void) {
    u8 i;
    for (i = 0; i < MAX_BULLETS; ++i) {
        if (!bullets[i].alive) {
            bullets[i].x = player.x;
            bullets[i].y = (u16)(player.y - 10);
            bullets[i].alive = 1;
            psg_tone(2, 0x180, 26);
            sfx_timer = 4;
            return;
        }
    }
}

static void spawn(void) {
    u8 i;
    for (i = 0; i < MAX_ENEMIES; ++i) {
        if (!enemies[i].alive) {
            enemies[i].x = (u16)(8 + (next_rand() >> 8) % 224);
            enemies[i].y = 8;
            enemies[i].alive = 1;
            return;
        }
    }
}

void main(void) {
    u8 i, j;

    _pce_keep[0] = 0;

    /* palette: BG sub-pal 0 + sprite sub-pals 0/1/2 */
    vce_set_color(0,   PCE_RGB(0, 0, 1));   /* backdrop dark blue          */
    vce_set_color(1,   PCE_RGB(0, 0, 3));   /* BG c1: deep space blue      */
    vce_set_color(2,   PCE_RGB(1, 1, 4));   /* BG c2: lighter space band   */
    vce_set_color(3,   PCE_RGB(7, 7, 7));   /* BG c3: star white           */
    vce_set_color(256, PCE_RGB(0, 0, 0));   /* spr pal0 transparent        */
    vce_set_color(257, PCE_RGB(2, 6, 7));   /* spr pal0 c1: cyan ship      */
    vce_set_color(272, PCE_RGB(0, 0, 0));   /* spr pal1 transparent        */
    vce_set_color(273, PCE_RGB(7, 7, 0));   /* spr pal1 c1: yellow bullet  */
    vce_set_color(288, PCE_RGB(0, 0, 0));   /* spr pal2 transparent        */
    vce_set_color(289, PCE_RGB(7, 1, 1));   /* spr pal2 c1: red enemy      */

    upload_art();
    draw_starfield();
    draw_hud_label();

    player.x = 120; player.y = 180; player.alive = 1;
    for (i = 0; i < MAX_BULLETS; ++i) bullets[i].alive = 0;
    for (i = 0; i < MAX_ENEMIES; ++i) enemies[i].alive = 0;
    score = 0;
    spawn_timer = 0;
    rng = 0xC0DE;
    prev_pad = 0;
    sfx_timer = 0;
    draw_score();

    pce_joy_init();
    disp_enable();

    for (;;) {
        waitvsync();
        pad = pce_joy_read();

        /* move ship */
        if ((pad & PCE_JOY_LEFT)  && player.x > 2)   player.x -= 3;
        if ((pad & PCE_JOY_RIGHT) && player.x < 238) player.x += 3;
        if ((pad & PCE_JOY_UP)    && player.y > 8)   player.y -= 3;
        if ((pad & PCE_JOY_DOWN)  && player.y < 208) player.y += 3;
        if ((pad & PCE_JOY_I) && !(prev_pad & PCE_JOY_I)) fire();
        prev_pad = pad;

        /* advance bullets */
        for (i = 0; i < MAX_BULLETS; ++i) {
            if (!bullets[i].alive) continue;
            if (bullets[i].y < 6) { bullets[i].alive = 0; continue; }
            bullets[i].y -= 6;
        }

        /* advance enemies */
        for (i = 0; i < MAX_ENEMIES; ++i) {
            if (!enemies[i].alive) continue;
            enemies[i].y += 1;
            if (enemies[i].y >= 224) enemies[i].alive = 0;
        }

        /* spawn waves */
        spawn_timer++;
        if (spawn_timer >= 36) { spawn_timer = 0; spawn(); }

        /* bullet vs enemy */
        for (i = 0; i < MAX_BULLETS; ++i) {
            if (!bullets[i].alive) continue;
            for (j = 0; j < MAX_ENEMIES; ++j) {
                if (!enemies[j].alive) continue;
                if (aabb(&bullets[i], &enemies[j])) {
                    bullets[i].alive = 0;
                    enemies[j].alive = 0;
                    if (score < 9999) score += 10;
                    draw_score();
                    psg_tone(3, 0x040, 28);
                    sfx_timer = 6;
                    break;
                }
            }
        }

        /* free the SFX channels so they're blips, not drones */
        if (sfx_timer) {
            --sfx_timer;
            if (sfx_timer == 0) { psg_off(2); psg_off(3); }
        }

        /* push sprites: player(0), bullets(1..6), enemies(7..12) */
        set_sprite(0, player.x, player.y, SHIP_VRAM >> 6, 0);
        for (i = 0; i < MAX_BULLETS; ++i) {
            u16 by = bullets[i].alive ? bullets[i].y : 0x1F0;  /* park off-screen */
            set_sprite((u8)(1 + i), bullets[i].x, by, BULLET_VRAM >> 6, 1);
        }
        for (i = 0; i < MAX_ENEMIES; ++i) {
            u16 ey = enemies[i].alive ? enemies[i].y : 0x1F0;
            set_sprite((u8)(7 + i), enemies[i].x, ey, ENEMY_VRAM >> 6, 2);
        }
        satb_dma();
    }
}
