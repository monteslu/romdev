/* ── platformer.c — Genesis SGDK side-scrolling platformer scaffold ─
 *
 * A HORIZONTALLY SCROLLING platformer: the world is wider than the
 * screen, a camera follows the player, Plane A scrolls with the world
 * and Plane B scrolls at half rate for parallax depth. Gravity, jump,
 * and land-on-top collision against a static platform list (in WORLD
 * coords). Yours to extend with enemies, goals, pickups, etc.
 *
 * Physics is fixed-point: x/y are in 1/16-pixel subpixel units. The
 * player draws at SCREEN x = (worldX>>4) - camX.
 *
 * World width here is one VDP plane (64 cells = 512 px) so the whole
 * level fits in the scroll plane and plain VDP_setHorizontalScroll moves
 * it — a real working scroller with no streaming. For a world WIDER than
 * 512 px you additionally stream the column entering view each time camX
 * crosses an 8-px boundary (see MENTAL_MODEL.md "How Sonic-style large
 * maps REALLY work"). For a from-scratch smooth-scroll + parallax
 * starting point with NO per-frame tilemap writes, see the
 * two_plane_parallax template + MENTAL_MODEL.md "Scrolling, parallax &
 * the feel trap".
 */

#include <genesis.h>
#include "genesis_sfx.h"

#define T_BLANK    (TILE_USER_INDEX + 0)
#define T_PLATFORM (TILE_USER_INDEX + 1)
#define T_PLAYER   (TILE_USER_INDEX + 2)
#define T_BG       (TILE_USER_INDEX + 3)

static const u32 tile_blank[8]    = { 0,0,0,0,0,0,0,0 };
static const u32 tile_platform[8] = {
    0x11111111, 0x12222221, 0x12222221, 0x12222221,
    0x12222221, 0x12222221, 0x12222221, 0x11111111,
};
static const u32 tile_player[8]   = {
    0x00033000, 0x00333300, 0x03333330, 0x03333330,
    0x03333330, 0x03333330, 0x00333300, 0x00033000,
};
/* A simple background block for the parallax plane. */
static const u32 tile_bg[8] = {
    0x44444444, 0x40000004, 0x40000004, 0x40000004,
    0x40000004, 0x40000004, 0x40000004, 0x44444444,
};

#define WORLD_W   512          /* one 64-cell plane wide */
#define SCREEN_W  320

typedef struct { s16 x, y, w, h; } Rect;

/* Static platforms in WORLD PIXEL coords (not subpixel), spread across
 * the full 512-px world so there's somewhere to scroll to. */
static const Rect platforms[] = {
    {   0, 200, 512,  24 }, /* floor spans the whole world */
    {  40, 160,  64,   8 },
    { 150, 140,  72,   8 },
    { 260, 120,  56,   8 },
    { 360,  96,  64,   8 },
    { 440, 150,  56,   8 },
    { 200,  80,  48,   8 },
};
#define N_PLATFORMS (sizeof(platforms) / sizeof(platforms[0]))

static bool on_platform(s16 px, s16 py) {
    for (u16 i = 0; i < N_PLATFORMS; i++) {
        const Rect* p = &platforms[i];
        if (py + 8 == p->y && px + 8 > p->x && px < p->x + p->w) return TRUE;
    }
    return FALSE;
}

int main(bool hard) {
    (void)hard;

    PAL_setColor(0 + 2, 0x000E); /* player red  */
    PAL_setColor(0 + 3, 0x00CC);
    PAL_setColor(16 + 1, 0x0888); /* platform light */
    PAL_setColor(16 + 2, 0x0666); /* platform dark  */
    PAL_setColor(16 + 4, 0x0420); /* parallax bg    */

    VDP_loadTileData(tile_blank,    T_BLANK,    1, DMA);
    VDP_loadTileData(tile_platform, T_PLATFORM, 1, DMA);
    VDP_loadTileData(tile_player,   T_PLAYER,   1, DMA);
    VDP_loadTileData(tile_bg,       T_BG,       1, DMA);

    /* Plane A: the foreground world — platforms painted in world coords. */
    for (u16 i = 0; i < N_PLATFORMS; i++) {
        const Rect* p = &platforms[i];
        VDP_fillTileMapRect(BG_A,
            TILE_ATTR_FULL(PAL1, 0, 0, 0, T_PLATFORM),
            p->x >> 3, p->y >> 3, (p->w + 7) >> 3, (p->h + 7) >> 3);
    }
    /* Plane B: a sparse parallax backdrop — every 4th cell, upper area. */
    for (u16 cx = 0; cx < 64; cx += 4)
        for (u16 cy = 2; cy < 20; cy += 4)
            VDP_setTileMapXY(BG_B, TILE_ATTR_FULL(PAL1, 0, 0, 0, T_BG), cx, cy);

    VDP_drawText("D-PAD MOVE  A JUMP  (scrolls)", 5, 1);

    sfx_init();

    s32 px = 32 << 4, py = 100 << 4;   /* world subpixel coords */
    s32 vx = 0, vy = 0;
    s16 camX = 0;

    const s32 GRAVITY = 12, MOVE_SPEED = 24, JUMP_VEL = -200, MAX_FALL = 320;
    u16 prev = 0;

    while (TRUE) {
        u16 pad = JOY_readJoypad(JOY_1);

        vx = 0;
        if (pad & BUTTON_LEFT)  vx = -MOVE_SPEED;
        if (pad & BUTTON_RIGHT) vx =  MOVE_SPEED;

        s16 ipx = px >> 4, ipy = py >> 4;
        bool grounded = on_platform(ipx, ipy);
        if ((pad & BUTTON_A) && !(prev & BUTTON_A) && grounded) {
            vy = JUMP_VEL; sfx_tone(1, 300, 6);
        }
        prev = pad;

        vy += GRAVITY;
        if (vy > MAX_FALL) vy = MAX_FALL;
        if (grounded && vy > 0) vy = 0;

        /* Horizontal move, clamped to the world (no wrap now — it scrolls). */
        px += vx;
        if (px < 0) px = 0;
        if (px > (WORLD_W - 8) << 4) px = (WORLD_W - 8) << 4;

        /* Vertical move with land-on-top snap. */
        s32 np = py + vy; s16 npy = np >> 4;
        bool landed = FALSE;
        if (vy > 0) {
            for (u16 i = 0; i < N_PLATFORMS; i++) {
                const Rect* p = &platforms[i];
                if (ipy + 8 <= p->y && npy + 8 >= p->y
                    && ipx + 8 > p->x && ipx < p->x + p->w) {
                    py = (p->y - 8) << 4; vy = 0; landed = TRUE;
                    sfx_tone(2, 700, 3); break;
                }
            }
        }
        if (!landed) {
            py = np;
            if (py > 224 << 4) { py = 0; vy = 0; }
        }

        /* Camera follows the player, centered, clamped to the world. */
        camX = (px >> 4) - (SCREEN_W / 2 - 4);
        if (camX < 0) camX = 0;
        if (camX > WORLD_W - SCREEN_W) camX = WORLD_W - SCREEN_W;

        /* Scroll: Plane A with the world, Plane B at half rate (parallax).
         * The VDP scroll value moves the plane LEFT for positive camX, so
         * we write the negative camera offset. */
        VDP_setHorizontalScroll(BG_A, -camX);
        VDP_setHorizontalScroll(BG_B, -(camX >> 1));

        /* Player drawn in SCREEN space = world - camera. */
        VDP_setSprite(0, (px >> 4) - camX, py >> 4, SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(PAL0, 1, 0, 0, T_PLAYER));
        VDP_updateSprites(1, DMA);

        sfx_update();
        SYS_doVBlankProcess();
    }
    return 0;
}
