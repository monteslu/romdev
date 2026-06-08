/* ── platformer/main.c — MSX SIDE-SCROLLING platformer scaffold ──────
 *
 * Mirrors the SMS/GB/etc platformer scaffolds, translated to the MSX VDP
 * via the romdev helper lib (msx_hw.h + msx_vdp.c).
 *
 * The world is 512 px wide (64 cells); the screen-2 name table is only 32
 * cells (256 px) and wraps, so a world wider than one screen needs COLUMN
 * STREAMING: each time the camera crosses an 8-px boundary we rewrite the
 * name-table column about to scroll into view with the next world column's
 * tiles. Screen 2 has no smooth-pixel-scroll register, so the camera moves
 * in whole 8-px cells — the streaming gives a clean tile-by-tile scroll.
 *
 * Subpixel state (x/y in 1/16-pixel units) for fine gravity/acceleration;
 * the player sprite draws in SCREEN space ((worldX>>4) - camX).
 *
 * Controls: joystick LEFT/RIGHT walks, trigger A jumps (only when grounded).
 *
 * Cartridge rule: INIT must never return — main() ends in for(;;).
 */
#include "msx_hw.h"

/* ── interrupt-free vblank sync (poll VDP status S#0 bit 7) ────────────── */
__sfr __at 0x99 VDPSTATUS;
static void vsync(void) {
    (void)VDPSTATUS;
    while (!(VDPSTATUS & 0x80)) {
    }
}
/* jump uses the BIOS GTTRIG wrapper (gttrig) provided by msx_hw.h. */

#define T_OPEN  0
#define T_WALL  1

#define WORLD_COLS 64
#define WORLD_W    (WORLD_COLS * 8)
#define SCREEN_W   256
#define VIS_ROWS   24

/* background tile patterns (8x8) */
static const uint8_t TILE_OPEN[8] = {0,0,0,0,0,0,0,0};
static const uint8_t TILE_WALL[8] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};

#define COL_OPEN 0x14   /* light-blue "open" (sky) on dark blue */
#define COL_WALL 0xE4   /* grey wall on dark blue               */

/* player sprite (8x8) */
static const uint8_t SPR_PLAYER[8] = {0x3C,0x7E,0xFF,0xFF,0xFF,0xFF,0x7E,0x3C};
#define COL_PLAYER 9    /* red-ish */

typedef struct { int16_t x, y, w, h; } Rect;

/* platforms in WORLD coords, spread across the 512-px world */
static const Rect platforms[] = {
    {   0, 176, 512,  16 }, /* floor spans the world */
    {  32, 144,  56,   8 },
    { 120, 144,  64,   8 },
    { 200, 112,  48,   8 },
    {  56,  96,  40,   8 },
    { 288, 136,  64,   8 },
    { 384, 104,  56,   8 },
    { 440, 152,  48,   8 },
    { 320,  72,  48,   8 }
};
#define N_PLATFORMS (sizeof(platforms) / sizeof(platforms[0]))

static int16_t  px, py;       /* player pos, 1/16-px units */
static int16_t  vx, vy;
static int16_t  camX;         /* camera X in pixels (cell-aligned) */
static int16_t  lastCamCol;

static void load_tiles(void) {
    uint8_t third;
    uint16_t poff;
    for (third = 0; third < 3; third++) {
        poff = (uint16_t)((uint16_t)third << 11);
        msx_vram_write((uint16_t)(VRAM_PATTERN + poff + 0), TILE_OPEN, 8);
        msx_vram_write((uint16_t)(VRAM_PATTERN + poff + 8), TILE_WALL, 8);
        msx_fill_vram((uint16_t)(VRAM_COLOR + poff + 0), 8, COL_OPEN);
        msx_fill_vram((uint16_t)(VRAM_COLOR + poff + 8), 8, COL_WALL);
    }
}

static uint8_t cell_is_wall(int16_t col, uint8_t row) {
    int16_t cx = (int16_t)(col << 3);
    int16_t cy = (int16_t)((int16_t)row << 3);
    uint8_t i;
    const Rect *p;
    for (i = 0; i < N_PLATFORMS; i++) {
        p = &platforms[i];
        if (cx + 8 > p->x && cx < p->x + p->w
            && cy + 8 > p->y && cy < p->y + p->h) return 1;
    }
    return 0;
}

static uint8_t on_platform(int16_t ipx, int16_t ipy) {
    uint8_t i;
    const Rect *p;
    for (i = 0; i < N_PLATFORMS; i++) {
        p = &platforms[i];
        if (ipy + 8 == p->y && ipx + 8 > p->x && ipx < p->x + p->w) return 1;
    }
    return 0;
}

/* write one world column into its wrapped name-table column */
static void paint_column(int16_t worldCol) {
    uint8_t ntCol, row, tile;
    uint16_t addr;
    if (worldCol < 0 || worldCol >= WORLD_COLS) return;
    ntCol = (uint8_t)(worldCol & 31);
    for (row = 0; row < VIS_ROWS; row++) {
        tile = cell_is_wall(worldCol, row) ? T_WALL : T_OPEN;
        addr = (uint16_t)(VRAM_NAME + (uint16_t)row * 32 + ntCol);
        msx_vram_write(addr, &tile, 1);
    }
}

static void paint_initial(void) {
    int16_t c;
    for (c = 0; c < 32; c++) paint_column(c);
}

void main(void) {
    const int16_t GRAVITY = 10;
    const int16_t MOVE    = 24;
    const int16_t JUMP    = -200;
    const int16_t MAXFALL = 280;
    uint8_t dir, trig, prev_trig, grounded, blip;

    msx_set_screen2();
    msx_clear_sprites();
    load_tiles();
    msx_fill_vram(VRAM_NAME, 32 * 24, T_OPEN);
    msx_vram_write((uint16_t)(VRAM_SPRPAT + 0), SPR_PLAYER, 8);

    px = (int16_t)(16 << 4);
    py = (int16_t)(64 << 4);
    vx = 0; vy = 0;
    camX = 0; lastCamCol = 0;
    prev_trig = 0; blip = 0;

    paint_initial();

    for (;;) {
        int16_t ipx, ipy, npy, sx, camCol;
        int32_t np;
        uint8_t i, landed;
        const Rect *p;

        vsync();

        ipx = (int16_t)(px >> 4);
        ipy = (int16_t)(py >> 4);

        /* camera follows the player, centered, clamped, snapped to a cell */
        camX = (int16_t)(ipx - (SCREEN_W / 2 - 4));
        if (camX < 0) camX = 0;
        if (camX > WORLD_W - SCREEN_W) camX = (int16_t)(WORLD_W - SCREEN_W);
        camX = (int16_t)(camX & ~7);

        camCol = (int16_t)(camX >> 3);
        while (camCol > lastCamCol) { lastCamCol++; paint_column((int16_t)(lastCamCol + 31)); }
        while (camCol < lastCamCol) { lastCamCol--; paint_column(lastCamCol); }

        sx = (int16_t)(ipx - camX);
        if (sx < 0) sx = 0;
        if (sx > 248) sx = 248;
        msx_set_sprite(0, (uint8_t)sx, (uint8_t)ipy, 0, COL_PLAYER);

        dir = msx_read_joystick(1);
        if (dir == STICK_CENTER) dir = msx_read_joystick(0);
        trig = (uint8_t)(gttrig(1) || gttrig(2));

        vx = 0;
        if (dir == STICK_LEFT || dir == STICK_UL || dir == STICK_DL) vx = (int16_t)(-MOVE);
        if (dir == STICK_RIGHT || dir == STICK_UR || dir == STICK_DR) vx = MOVE;

        grounded = on_platform(ipx, ipy);
        if (trig && !prev_trig && grounded) { vy = JUMP; msx_psg_tone(0, 0x180, 12); blip = 6; }
        prev_trig = trig;

        vy = (int16_t)(vy + GRAVITY);
        if (vy > MAXFALL) vy = MAXFALL;
        if (grounded && vy > 0) vy = 0;

        px = (int16_t)(px + vx);
        if (px < 0) px = 0;
        if (px > (int16_t)((WORLD_W - 8) << 4)) px = (int16_t)((WORLD_W - 8) << 4);

        np = (int32_t)py + (int32_t)vy;
        npy = (int16_t)(np >> 4);
        if (vy > 0) {
            landed = 0;
            for (i = 0; i < N_PLATFORMS; i++) {
                p = &platforms[i];
                if (ipy + 8 <= p->y && npy + 8 >= p->y
                    && ipx + 8 > p->x && ipx < p->x + p->w) {
                    py = (int16_t)((p->y - 8) << 4);
                    vy = 0;
                    landed = 1;
                    break;
                }
            }
            if (!landed) py = (int16_t)np;
        } else {
            py = (int16_t)np;
        }
        if (py > (int16_t)(192 << 4)) { py = (int16_t)(64 << 4); vy = 0; }

        if (blip) { blip--; if (!blip) msx_psg_off(0); }
    }
}
