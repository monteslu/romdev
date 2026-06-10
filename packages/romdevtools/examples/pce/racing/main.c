/*
 * PC Engine "racing" — a top-down lane-racer scaffold.
 *
 * Drive a car at the bottom of the screen up a 3-lane road. LEFT/RIGHT switch
 * lanes; obstacle cars spawn at the top and slide down toward you. Dodge them —
 * a collision freezes the game for a beat, then auto-resets. The road scrolls
 * (dashed lane stripes animate via the BG Y-scroll register) and speed grows
 * with your distance score. Mirrors the NES/Genesis/SNES/GB/SMS racing
 * scaffolds, translated to the PCE helper API.
 *
 * Cars are hardware sprites; the road (grey lanes between green shoulders with
 * animated dashed lane lines) is the BG tilemap, so the screen is clearly a
 * road scene (clears the verify gate).
 *
 * PCE notes (see pce_hw.h / MENTAL_MODEL.md):
 *   - disp_enable() turns on BG + sprites + the VBlank IRQ (waitvsync needs it).
 *   - the road scroll is BG Y-scroll: vdc_set_reg(VDC_BYR, scroll).
 *   - .bss must be non-empty (pce_video.c's _pce_keep[] covers it).
 *
 * cc65 is C89 — declare locals at the top of a block.
 */
#include <pce.h>
#include <stdint.h>   /* int16_t for the per-frame speed step                 */
#include "pce_hw.h"

/* ---- VRAM layout (word addresses) --------------------------------------- */
#define BAT_VRAM     0x0000
#define FONT_VRAM    0x1000
#define GRASS_VRAM   0x1400   /* shoulder grass (colour 1)                   */
#define ROAD_VRAM    0x1410   /* plain road (colour 2)                       */
#define DASH_VRAM    0x1420   /* road with a lane dash (colour 3)            */
#define PLAYER_VRAM  0x1800   /* 16x16 player car                            */
#define ENEMY_VRAM   0x1840   /* 16x16 enemy car                             */

#define BAT_ENTRY(pal, vram)  ((u16)(((pal) << 12) | ((vram) >> 4)))

#define LANE_L_X     76
#define LANE_M_X    120
#define LANE_R_X    164
#define PLAYER_Y    176
#define MAX_OBST      4

/* ---- font (digits only) ------------------------------------------------- */
#define NUM_GLYPHS 10
static const u8 FONT5x7[NUM_GLYPHS][7] = {
    {0x0E,0x11,0x13,0x15,0x19,0x11,0x0E},
    {0x04,0x0C,0x04,0x04,0x04,0x04,0x0E},
    {0x0E,0x11,0x01,0x02,0x04,0x08,0x1F},
    {0x1F,0x02,0x04,0x02,0x01,0x11,0x0E},
    {0x02,0x06,0x0A,0x12,0x1F,0x02,0x02},
    {0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E},
    {0x06,0x08,0x10,0x1E,0x11,0x11,0x0E},
    {0x1F,0x01,0x02,0x04,0x08,0x08,0x08},
    {0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E},
    {0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C}
};

/* ---- state -------------------------------------------------------------- */
typedef struct { u16 x, y; u8 alive; } Car;

static Car player;
static Car obst[MAX_OBST];
static u16 score;
static u8  spawn_timer;
static u8  crash_timer;
static u8  player_lane;
static u8  road_scroll;
static u16 rng;
static u8  pad, prev_pad;
static u8  sfx_timer;
static u16 tile_buf[16];
static u16 spr_buf[64];

static const u16 lane_x[3] = { LANE_L_X, LANE_M_X, LANE_R_X };

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

/* road tile with a centred lane dash in colour 3 (top half of the tile) */
static void make_dash_tile(u16 *t) {
    u8 r;
    make_solid_tile(t, 2);          /* base road (colour 2) */
    for (r = 0; r < 4; ++r) {
        /* centre 4px (mask 0x18) -> colour 3 (planes 0+1): add plane0 bits */
        t[r] = (u16)((t[r] & 0xFF00) | 0x18 | (t[r] & 0x00FF));
    }
}

static void make_car_sprite(u16 vram, u8 ci) {
    static const u16 car[16] = {
        0x0660, 0x0660, 0x3FFC, 0x7FFE, 0x7FFE, 0x7FFE, 0x6FF6, 0x6FF6,
        0x7FFE, 0x7FFE, 0x6FF6, 0x6FF6, 0x7FFE, 0x3FFC, 0x6006, 0x6006
    };
    u8 r;
    for (r = 0; r < 64; ++r) spr_buf[r] = 0;
    for (r = 0; r < 16; ++r) {
        if (ci & 1) spr_buf[r]      = car[r];
        if (ci & 2) spr_buf[r + 16] = car[r];
        if (ci & 4) spr_buf[r + 32] = car[r];
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

/* Paint the road: grass shoulders, grey road in the middle, dashed lane lines
 * between the three lanes. Player X spans ~76..164 -> BAT cols ~9..22. */
static void draw_road(void) {
    u8 r, c;
    u16 grass = BAT_ENTRY(0, GRASS_VRAM);
    u16 road  = BAT_ENTRY(0, ROAD_VRAM);
    u16 dash  = BAT_ENTRY(0, DASH_VRAM);
    u16 e;
    for (r = 0; r < 32; ++r) {
        vram_set_write_addr((u16)(BAT_VRAM + r * 32));
        for (c = 0; c < 32; ++c) {
            if (c < 8 || c > 23) {
                e = grass;
            } else if ((c == 12 || c == 17) && (r & 1)) {
                e = dash;            /* dashed lane dividers, every other row  */
            } else {
                e = road;
            }
            VDC_DATA_LO = (u8)(e & 0xFF);
            VDC_DATA_HI = (u8)(e >> 8);
        }
    }
}

static void put_glyph(u8 col, u8 row, u8 digit) {
    u16 e = BAT_ENTRY(0, (u16)(FONT_VRAM + digit * 16));
    vram_set_write_addr((u16)(BAT_VRAM + row * 32 + col));
    VDC_DATA_LO = (u8)(e & 0xFF);
    VDC_DATA_HI = (u8)(e >> 8);
}

static void draw_score(void) {
    u16 v = score;
    u8 d0, d1, d2, d3;
    d3 = (u8)(v % 10); v /= 10;
    d2 = (u8)(v % 10); v /= 10;
    d1 = (u8)(v % 10); v /= 10;
    d0 = (u8)(v % 10);
    put_glyph(1, 1, d0);
    put_glyph(2, 1, d1);
    put_glyph(3, 1, d2);
    put_glyph(4, 1, d3);
}

static u8 aabb(Car *a, Car *b) {
    return (u8)(a->x < b->x + 14 && a->x + 14 > b->x &&
                a->y < b->y + 14 && a->y + 14 > b->y);
}

static u16 next_rand(void) {
    rng = (u16)(rng * 25173u + 13849u);
    return rng;
}

static void reset_run(void) {
    u8 i;
    player_lane = 1;
    player.x = lane_x[1];
    player.y = PLAYER_Y;
    player.alive = 1;
    for (i = 0; i < MAX_OBST; ++i) obst[i].alive = 0;
    score = 0;
    spawn_timer = 0;
    crash_timer = 0;
}

static void spawn_obst(void) {
    u8 i;
    for (i = 0; i < MAX_OBST; ++i) {
        if (!obst[i].alive) {
            obst[i].x = lane_x[(next_rand() >> 9) % 3];
            obst[i].y = 0;
            obst[i].alive = 1;
            return;
        }
    }
}

void main(void) {
    u8 i;

    _pce_keep[0] = 0;

    /* palette */
    vce_set_color(0,   PCE_RGB(0, 1, 0));   /* backdrop dark green          */
    vce_set_color(1,   PCE_RGB(1, 5, 1));   /* BG c1: grass                 */
    vce_set_color(2,   PCE_RGB(2, 2, 2));   /* BG c2: road grey             */
    vce_set_color(3,   PCE_RGB(7, 7, 1));   /* BG c3: yellow lane dash      */
    vce_set_color(256, PCE_RGB(0, 0, 0));   /* spr pal0 transparent         */
    vce_set_color(257, PCE_RGB(2, 5, 7));   /* spr pal0 c1: cyan player     */
    vce_set_color(272, PCE_RGB(0, 0, 0));   /* spr pal1 transparent         */
    vce_set_color(273, PCE_RGB(7, 1, 1));   /* spr pal1 c1: red enemy       */

    upload_font();
    make_solid_tile(tile_buf, 1); load_tiles(GRASS_VRAM, tile_buf, 16);
    make_solid_tile(tile_buf, 2); load_tiles(ROAD_VRAM, tile_buf, 16);
    make_dash_tile(tile_buf);     load_tiles(DASH_VRAM, tile_buf, 16);
    make_car_sprite(PLAYER_VRAM, 1);   /* colour 1 */
    make_car_sprite(ENEMY_VRAM,  1);   /* colour 1 (sub-pal 1 = red) */

    draw_road();

    rng = 0xBEEF;
    road_scroll = 0;
    prev_pad = 0;
    sfx_timer = 0;
    reset_run();
    draw_score();

    pce_joy_init();
    disp_enable();

    for (;;) {
        u8 slot;
        int16_t step;
        waitvsync();
        psg_music_tick();

        /* stage sprites: player + obstacles */
        slot = 0;
        set_sprite(slot++, player.x, player.y, PLAYER_VRAM >> 6, 0);
        for (i = 0; i < MAX_OBST; ++i) {
            u16 ey = obst[i].alive ? obst[i].y : 0x1F0;
            set_sprite(slot++, obst[i].x, ey, ENEMY_VRAM >> 6, 1);
        }
        satb_dma();

        pad = pce_joy_read();

        if (crash_timer > 0) {
            crash_timer--;
            if (crash_timer == 0) reset_run();
            prev_pad = pad;
            if (sfx_timer) { --sfx_timer; if (sfx_timer == 0) psg_off(0); }
            continue;
        }

        /* lane switch (edge-triggered) */
        if ((pad & PCE_JOY_LEFT)  && !(prev_pad & PCE_JOY_LEFT)  && player_lane > 0) { player_lane--; psg_tone(1, 0x2C0, 16); sfx_timer = 3; }
        if ((pad & PCE_JOY_RIGHT) && !(prev_pad & PCE_JOY_RIGHT) && player_lane < 2) { player_lane++; psg_tone(1, 0x2C0, 16); sfx_timer = 3; }
        player.x = lane_x[player_lane];
        prev_pad = pad;

        /* speed grows with score */
        step = (int16_t)(2 + (score / 400));
        if (step > 5) step = 5;

        /* scroll the road to sell motion */
        road_scroll = (u8)(road_scroll + step);
        vdc_set_reg(VDC_BYR, (u16)road_scroll);

        for (i = 0; i < MAX_OBST; ++i) {
            if (!obst[i].alive) continue;
            obst[i].y = (u16)(obst[i].y + step);
            if (obst[i].y >= 216) obst[i].alive = 0;
        }

        spawn_timer++;
        if (spawn_timer >= 40) { spawn_timer = 0; spawn_obst(); }

        for (i = 0; i < MAX_OBST; ++i) {
            if (obst[i].alive && aabb(&player, &obst[i])) {
                crash_timer = 70;
                psg_tone(0, 0x080, 28);   /* crash buzz */
                sfx_timer = 16;
                break;
            }
        }

        if (score < 9999) score++;
        if ((score & 7) == 0) draw_score();

        if (sfx_timer) { --sfx_timer; if (sfx_timer == 0) { psg_off(0); psg_off(1); } }
    }
}
