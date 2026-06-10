/*
 * PC Engine "platformer" — a side-scrolling platformer scaffold.
 *
 * Run and jump across a world wider than one screen. The d-pad moves left/right,
 * button I jumps; gravity pulls you down and you land on top of solid platforms.
 * The camera follows the player and the background scrolls smoothly via the VDC
 * background X-scroll register (BXR/R7).
 *
 * The PCE BAT (background map) is a 32x32 virtual screen (256px) that WRAPS, so
 * a world wider than 256px needs COLUMN STREAMING: each time the camera crosses
 * an 8px boundary we rewrite the BAT column that is about to scroll into view
 * with the next world column's tiles. This mirrors the SMS platformer scaffold,
 * using BXR instead of SMS R8.
 *
 * PCE notes (see pce_hw.h / MENTAL_MODEL.md):
 *   - disp_enable() turns on BG + sprites + the VBlank IRQ (waitvsync needs it).
 *   - .bss must be non-empty (pce_video.c's _pce_keep[] covers it).
 *   - we set BXR every frame via vdc_set_reg(VDC_BXR, camX) for smooth scroll.
 *
 * cc65 is C89 — declare locals at the top of a block.
 */
#include <pce.h>
#include <stdint.h>   /* int8_t/int16_t/int32_t for sub-pixel physics + camera */
#include "pce_hw.h"

/* ---- VRAM layout (word addresses) --------------------------------------- */
#define BAT_VRAM     0x0000   /* 32x32 background map                        */
#define SKY_VRAM     0x1000   /* BG tile: sky (solid colour 1)               */
#define WALL_VRAM    0x1010   /* BG tile: platform block (colour 2)          */
#define WALLTOP_VRAM 0x1020   /* BG tile: platform top edge (colour 3 strip) */
#define PLAYER_VRAM  0x1800   /* 16x16 player                                */

#define BAT_ENTRY(pal, vram)  ((u16)(((pal) << 12) | ((vram) >> 4)))

/* ---- world -------------------------------------------------------------- */
#define WORLD_COLS  96            /* 96 cells = 768 px world                  */
#define WORLD_W     (WORLD_COLS * 8)
#define SCREEN_W    256
#define VIS_ROWS    28            /* 224-line display = 28 rows               */

typedef struct { int16_t x, y, w, h; } Rect;

/* Platforms in WORLD pixel coords, spread across the 768px world. */
static const Rect platforms[] = {
    {   0, 200, 768, 24 },   /* floor spans the world          */
    {  48, 168,  56,  8 },
    { 140, 152,  64,  8 },
    { 232, 128,  56,  8 },
    {  96, 112,  40,  8 },
    { 320, 160,  72,  8 },
    { 416, 128,  64,  8 },
    { 360,  88,  48,  8 },
    { 512, 152,  80,  8 },
    { 600, 120,  56,  8 },
    { 672, 168,  72,  8 },
    { 560,  80,  48,  8 }
};
#define N_PLATFORMS (sizeof(platforms) / sizeof(platforms[0]))

/* ---- state -------------------------------------------------------------- */
static int16_t px, py;        /* player position in 1/16-px units            */
static int16_t vx, vy;
static int16_t camX, lastCamCol;
static u8 pad, prev_pad;
static u16 spr_buf[64];
static u16 tile_buf[16];

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

/* platform-top tile: colour 2 body with a colour-3 highlight on the top 2 rows */
static void make_walltop_tile(u16 *t) {
    make_solid_tile(t, 2);
    /* rows 0,1: set plane0 too so those pixels read colour 3 (planes0+1) */
    t[0] = (u16)(0x00FF | (t[0] & 0xFF00));
    t[1] = (u16)(0x00FF | (t[1] & 0xFF00));
}

static void make_player_sprite(void) {
    static const u16 body[16] = {
        0x07E0, 0x0FF0, 0x1FF8, 0x1818, 0x1FF8, 0x1FF8, 0x3FFC, 0x7FFE,
        0x7FFE, 0x7FFE, 0x3FFC, 0x1FF8, 0x0E70, 0x0C30, 0x0C30, 0x1818
    };
    static const u16 eyes[16] = {
        0x0000, 0x0000, 0x0000, 0x0000, 0x0990, 0x0990, 0x0000, 0x0000,
        0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000
    };
    u8 r;
    for (r = 0; r < 64; ++r) spr_buf[r] = 0;
    for (r = 0; r < 16; ++r) {
        spr_buf[r]      = (u16)(body[r] & ~eyes[r]);   /* plane0 -> colour 1 */
        spr_buf[r + 16] = eyes[r];                     /* plane1 -> colour 2 */
    }
    load_tiles(PLAYER_VRAM, spr_buf, 64);
}

/* Is world cell (col,row) inside any platform? */
static u8 cell_is_wall(int16_t col, u8 row) {
    int16_t cx = (int16_t)(col << 3);
    int16_t cy = (int16_t)((int16_t)row << 3);
    u8 i;
    const Rect *p;
    for (i = 0; i < N_PLATFORMS; ++i) {
        p = &platforms[i];
        if (cx + 8 > p->x && cx < p->x + p->w &&
            cy + 8 > p->y && cy < p->y + p->h) return 1;
    }
    return 0;
}

/* Is world cell the TOP row of a platform (for the highlighted edge tile)? */
static u8 cell_is_top(int16_t col, u8 row) {
    int16_t cy = (int16_t)((int16_t)row << 3);
    int16_t cx = (int16_t)(col << 3);
    u8 i;
    const Rect *p;
    for (i = 0; i < N_PLATFORMS; ++i) {
        p = &platforms[i];
        if (cx + 8 > p->x && cx < p->x + p->w && cy >= p->y && cy < p->y + 8) return 1;
    }
    return 0;
}

/* Write one world column into its wrapped BAT column. */
static void paint_column(int16_t worldCol) {
    u8 ntCol, row;
    u16 e;
    if (worldCol < 0 || worldCol >= WORLD_COLS) return;
    ntCol = (u8)(worldCol & 31);
    for (row = 0; row < 32; ++row) {
        if (row < VIS_ROWS && cell_is_wall(worldCol, row)) {
            e = cell_is_top(worldCol, row)
                ? BAT_ENTRY(0, WALLTOP_VRAM)
                : BAT_ENTRY(0, WALL_VRAM);
        } else {
            e = BAT_ENTRY(0, SKY_VRAM);
        }
        vram_set_write_addr((u16)(BAT_VRAM + row * 32 + ntCol));
        VDC_DATA_LO = (u8)(e & 0xFF);
        VDC_DATA_HI = (u8)(e >> 8);
    }
}

static void paint_initial(void) {
    int16_t c;
    for (c = 0; c < 32; ++c) paint_column(c);
}

static u8 on_platform(int16_t ipx, int16_t ipy) {
    u8 i;
    const Rect *p;
    for (i = 0; i < N_PLATFORMS; ++i) {
        p = &platforms[i];
        if (ipy + 16 == p->y && ipx + 12 > p->x && ipx + 4 < p->x + p->w) return 1;
    }
    return 0;
}

void main(void) {
    const int16_t GRAVITY = 10;
    const int16_t MOVE    = 22;
    const int16_t JUMP    = -200;
    const int16_t MAXFALL = 300;

    _pce_keep[0] = 0;

    /* palette */
    vce_set_color(0,   PCE_RGB(1, 2, 5));   /* backdrop sky blue            */
    vce_set_color(1,   PCE_RGB(2, 4, 7));   /* BG c1: sky                   */
    vce_set_color(2,   PCE_RGB(3, 2, 1));   /* BG c2: brown platform        */
    vce_set_color(3,   PCE_RGB(1, 6, 1));   /* BG c3: green grassy top      */
    vce_set_color(256, PCE_RGB(0, 0, 0));   /* spr transparent              */
    vce_set_color(257, PCE_RGB(7, 1, 1));   /* spr c1: red body             */
    vce_set_color(258, PCE_RGB(7, 7, 7));   /* spr c2: white eyes           */

    make_solid_tile(tile_buf, 1); load_tiles(SKY_VRAM, tile_buf, 16);
    make_solid_tile(tile_buf, 2); load_tiles(WALL_VRAM, tile_buf, 16);
    make_walltop_tile(tile_buf);  load_tiles(WALLTOP_VRAM, tile_buf, 16);
    make_player_sprite();

    paint_initial();

    px = (int16_t)(24 << 4);
    py = (int16_t)(160 << 4);
    vx = 0; vy = 0;
    camX = 0; lastCamCol = 0;
    prev_pad = 0;

    set_sprite(0, (u16)(px >> 4), (u16)(py >> 4), PLAYER_VRAM >> 6, 0);
    satb_dma();

    pce_joy_init();
    disp_enable();

    for (;;) {
        int16_t ipx, ipy, npy, sx;
        int16_t camCol;
        int32_t np;
        u8 grounded;
        u8 i;
        const Rect *p;

        waitvsync();

        psg_music_tick();
        pad = pce_joy_read();

        ipx = px >> 4;
        ipy = py >> 4;

        /* camera follows player, clamped to world */
        camX = (int16_t)(ipx - (SCREEN_W / 2 - 8));
        if (camX < 0) camX = 0;
        if (camX > WORLD_W - SCREEN_W) camX = (int16_t)(WORLD_W - SCREEN_W);

        /* stream columns entering from the edges */
        camCol = camX >> 3;
        while (camCol > lastCamCol) { lastCamCol++; paint_column((int16_t)(lastCamCol + 31)); }
        while (camCol < lastCamCol) { lastCamCol--; paint_column(lastCamCol); }

        /* smooth pixel scroll via BG X register */
        vdc_set_reg(VDC_BXR, (u16)camX);

        /* horizontal move */
        vx = 0;
        if (pad & PCE_JOY_LEFT)  vx = (int16_t)(-MOVE);
        if (pad & PCE_JOY_RIGHT) vx = MOVE;

        grounded = on_platform(ipx, ipy);
        if ((pad & PCE_JOY_I) && !(prev_pad & PCE_JOY_I) && grounded) {
            vy = JUMP;
            psg_tone(0, 0x200, 24);
        }
        prev_pad = pad;

        vy = (int16_t)(vy + GRAVITY);
        if (vy > MAXFALL) vy = MAXFALL;
        if (grounded && vy > 0) vy = 0;

        /* horizontal integrate + clamp */
        px = (int16_t)(px + vx);
        if (px < 0) px = 0;
        if (px > ((WORLD_W - 16) << 4)) px = (int16_t)((WORLD_W - 16) << 4);

        /* vertical integrate with land-on-top */
        np = (int32_t)py + (int32_t)vy;
        npy = (int16_t)(np >> 4);
        if (vy > 0) {
            u8 landed = 0;
            for (i = 0; i < N_PLATFORMS; ++i) {
                p = &platforms[i];
                if (ipy + 16 <= p->y && npy + 16 >= p->y &&
                    ipx + 12 > p->x && ipx + 4 < p->x + p->w) {
                    py = (int16_t)((p->y - 16) << 4);
                    vy = 0;
                    landed = 1;
                    break;
                }
            }
            if (!landed) py = (int16_t)np;
        } else {
            py = (int16_t)np;
        }
        if (py > (224 << 4)) { px = (int16_t)(24 << 4); py = (int16_t)(160 << 4); vy = 0; }

        /* free the jump SFX channel after it rings */
        if (vy == 0) psg_off(0);

        /* draw player in screen space */
        sx = (int16_t)((px >> 4) - camX);
        if (sx < 0) sx = 0;
        if (sx > 240) sx = 240;
        set_sprite(0, (u16)sx, (u16)(py >> 4), PLAYER_VRAM >> 6, 0);
        satb_dma();
    }
}
