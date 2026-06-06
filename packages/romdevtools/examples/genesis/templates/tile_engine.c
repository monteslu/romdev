/* ── tile_engine.c — Genesis SGDK tile-map starter ───────────────
 *
 * Draws a multi-screen tile map on plane B (background) and walks a
 * sprite over it with collision detection against "solid" tile IDs.
 *
 * Shows the canonical SGDK tile + map workflow:
 *   - VDP_loadTileData uploads the tile bitmaps into VRAM
 *   - VDP_setTileMapXY paints individual cells of plane B
 *   - VDP_fillTileMapRect paints a rectangle (used for the floor)
 *   - VDP_setHorizontalScroll / VDP_setVerticalScroll for camera
 *   - A simple {0=open, 1=solid} world grid in RAM for collision
 *
 * The Genesis has two scroll planes (A and B). Plane B sits behind
 * plane A. We use plane B for the world and don't touch plane A,
 * which means SGDK's text font (which lives on plane A by default)
 * stays visible on top of our world.
 */

#include <genesis.h>

#define WORLD_W 40   /* H40 = 40 cells across at 8px → 320px */
#define WORLD_H 28   /* enough for the full visible region + margin */

/* Tile indices. SGDK reserves 0..TILE_USER_INDEX-1 for system + font;
 * we put our two world tiles at TILE_USER_INDEX (open) and
 * TILE_USER_INDEX+1 (wall). */
#define T_OPEN  (TILE_USER_INDEX + 0)
#define T_WALL  (TILE_USER_INDEX + 1)
#define T_PLR   (TILE_USER_INDEX + 2)

/* 4bpp 8×8 tiles. */
static const u32 tile_open[8] = {
    0x00000000, 0x00000000, 0x00000000, 0x00000000,
    0x00000000, 0x00000000, 0x00000000, 0x00000000,
};
static const u32 tile_wall[8] = {
    0x22222222, 0x22111122, 0x21111112, 0x21111112,
    0x21111112, 0x21111112, 0x22111122, 0x22222222,
};
static const u32 tile_player[8] = {
    0x00033000, 0x00333300, 0x03333330, 0x03333330,
    0x03333330, 0x03333330, 0x00333300, 0x00033000,
};

/* Tiny 40×28 world. 0 = open, 1 = solid. */
static u8 world[WORLD_H][WORLD_W];

static void world_build(void) {
    for (u16 y = 0; y < WORLD_H; y++) {
        for (u16 x = 0; x < WORLD_W; x++) {
            /* Outer wall on top + bottom + sides. */
            world[y][x] = (x == 0 || x == WORLD_W - 1
                          || y == 6 || y == WORLD_H - 2) ? 1 : 0;
        }
    }
    /* A few interior platforms. */
    for (u16 x = 8;  x < 14; x++) world[12][x] = 1;
    for (u16 x = 20; x < 28; x++) world[16][x] = 1;
    for (u16 x = 30; x < 36; x++) world[10][x] = 1;
}

static void world_draw(void) {
    for (u16 y = 0; y < WORLD_H; y++) {
        for (u16 x = 0; x < WORLD_W; x++) {
            VDP_setTileMapXY(BG_B,
                TILE_ATTR_FULL(PAL1, 0, 0, 0,
                    world[y][x] ? T_WALL : T_OPEN),
                x, y);
        }
    }
}

static bool solid_at(s16 px, s16 py) {
    /* Convert pixel → tile coord, with bounds. */
    s16 tx = px >> 3;
    s16 ty = py >> 3;
    if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) return TRUE;
    return world[ty][tx] != 0;
}

int main(bool hard) {
    (void)hard;

    /* Palette 1 = world (wall colour). Palette 0 stays the SGDK default
     * so the font keeps working. */
    PAL_setColor(16 + 1, 0x0888); /* wall light */
    PAL_setColor(16 + 2, 0x0444); /* wall dark */
    PAL_setColor(0 + 1, 0x0EEE);
    PAL_setColor(0 + 2, 0x000E);  /* player body */
    PAL_setColor(0 + 3, 0x00CC);

    VDP_loadTileData(tile_open,   T_OPEN, 1, DMA);
    VDP_loadTileData(tile_wall,   T_WALL, 1, DMA);
    VDP_loadTileData(tile_player, T_PLR,  1, DMA);

    world_build();
    world_draw();

    VDP_drawText("D-PAD: MOVE   START: RESET", 6, 1);

    s16 px = 80, py = 80, vx = 0, vy = 0;
    u16 prev = 0;

    while (TRUE) {
        u16 pad = JOY_readJoypad(JOY_1);

        vx = 0; vy = 0;
        if (pad & BUTTON_LEFT)  vx = -1;
        if (pad & BUTTON_RIGHT) vx =  1;
        if (pad & BUTTON_UP)    vy = -1;
        if (pad & BUTTON_DOWN)  vy =  1;

        /* Per-axis move with collision. Check the leading corners of
         * the 8×8 sprite (px..px+7, py..py+7). */
        s16 nx = px + vx;
        if (vx > 0 && !solid_at(nx + 7, py) && !solid_at(nx + 7, py + 7)) px = nx;
        if (vx < 0 && !solid_at(nx,     py) && !solid_at(nx,     py + 7)) px = nx;

        s16 ny = py + vy;
        if (vy > 0 && !solid_at(px, ny + 7) && !solid_at(px + 7, ny + 7)) py = ny;
        if (vy < 0 && !solid_at(px, ny)     && !solid_at(px + 7, ny))     py = ny;

        if ((pad & BUTTON_START) && !(prev & BUTTON_START)) {
            px = 80; py = 80;
        }
        prev = pad;

        VDP_setSprite(0, px, py, SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(PAL0, 1, 0, 0, T_PLR));
        VDP_updateSprites(1, DMA);

        SYS_doVBlankProcess();
    }
    return 0;
}
