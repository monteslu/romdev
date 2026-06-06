/* ── platformer.c — SNES PVSnesLib SIDE-SCROLLING platformer scaffold
 *
 * A horizontally scrolling platformer: gravity + jump physics with
 * land-on-top collision against a static platform list spread across a
 * 512-px world. A camera follows the player; the BG scrolls in hardware
 * via bgSetScroll(0, camX, 0) and the player sprite draws in SCREEN
 * space (worldX - camX). Mirrors the GB/Genesis side-scroller scaffolds.
 *
 * Physics is fixed-point: x/y in 1/16-pixel subpixel units for sub-pixel
 * acceleration.
 *
 * NOTE ON VISUALS: this scaffold uses the PVSnesLib console (text) BG,
 * which has no tiled platform art — so as you scroll you see the on-BG
 * text slide (proof the hardware scroll register is moving) while the
 * player stays screen-centered. For visible tiled platforms across a
 * wide world, build a real tileset with gfx2snes + bgInitTileSet on a
 * 64-wide map and stream tilemap columns into VRAM during vblank as the
 * camera advances. See the SNES MENTAL_MODEL.md "Horizontal scrolling".
 */

#include <snes.h>
#include "snes_sfx.c"

extern char tilfont, palfont;
extern char tilsprite, palsprite;

typedef struct { s16 x, y, w, h; } Rect;

#define WORLD_W  512
#define SCREEN_W 256

/* Platforms in WORLD coords, spread across the 512-px world. */
static const Rect platforms[] = {
    {   0, 200, 512,  24 }, /* floor spans the world */
    {  30, 160,  56,   8 },
    { 110, 140,  64,   8 },
    { 190, 110,  48,   8 },
    {  60, 100,  32,   8 },
    { 300, 150,  64,   8 },
    { 400, 120,  56,   8 },
    { 360,  84,  48,   8 },
    { 460, 168,  48,   8 },
};
#define N_PLATFORMS (sizeof(platforms) / sizeof(platforms[0]))

#define GRAVITY    12
#define MOVE_SPEED 24
#define JUMP_VEL   -200
#define MAX_FALL   320

static u8 on_platform(s16 px, s16 py) {
    u16 i;
    const Rect* p;
    for (i = 0; i < N_PLATFORMS; i++) {
        p = &platforms[i];
        if (py + 8 == p->y && px + 8 > p->x && px < p->x + p->w) return 1;
    }
    return 0;
}

int main(void) {
    s32 px = 32 << 4, py = 100 << 4;
    s32 vx = 0,       vy = 0;
    s32 np;
    s16 ipx, ipy, npy, camX = 0;
    u8 grounded;
    u16 i, pad, prev = 0;
    const Rect* p;

    consoleSetTextMapPtr(0x6800);
    consoleSetTextGfxPtr(0x3000);
    consoleSetTextOffset(0x0100);
    consoleInitText(0, 16 * 2, &tilfont, &palfont);
    setMode(BG_MODE1, 0);
    bgSetDisable(1);
    bgSetDisable(2);

    oamInitGfxSet(&tilsprite, 32, &palsprite, 32, 0, 0x0000, OBJ_SIZE8_L16);

    consoleDrawText(2, 1, "D-PAD MOVE   A JUMP");
    /* Column markers across the BG so the hardware scroll is visible as
     * you move (the console map is 32 cells / 256 px and wraps). */
    consoleDrawText( 1, 12, "|0");
    consoleDrawText( 9, 12, "|64");
    consoleDrawText(17, 12, "|128");
    consoleDrawText(25, 12, "|192");
    sfx_init();

    oamSet(0, 32, 100, 3, 0, 0, 0, 0);
    setScreenOn();

    while (1) {
        pad = padsCurrent(0);
        vx = 0;
        if (pad & KEY_LEFT)  vx = -MOVE_SPEED;
        if (pad & KEY_RIGHT) vx =  MOVE_SPEED;

        ipx = px >> 4;
        ipy = py >> 4;
        grounded = on_platform(ipx, ipy);
        if ((pad & KEY_A) && !(prev & KEY_A) && grounded) { vy = JUMP_VEL; sfx_play(1); }
        prev = pad;

        vy += GRAVITY;
        if (vy > MAX_FALL) vy = MAX_FALL;
        if (grounded && vy > 0) vy = 0;

        px += vx;
        if (px < 0) px = 0;
        if (px > (WORLD_W - 8) << 4) px = (WORLD_W - 8) << 4;

        np = py + vy;
        npy = np >> 4;
        if (vy > 0) {
            for (i = 0; i < N_PLATFORMS; i++) {
                p = &platforms[i];
                if (ipy + 8 <= p->y && npy + 8 >= p->y
                    && ipx + 8 > p->x && ipx < p->x + p->w) {
                    py = (p->y - 8) << 4;
                    vy = 0;
                    goto done;
                }
            }
        }
        py = np;
        if (py > 224 << 4) { py = 0; vy = 0; }
done:   ;

        /* Camera follows the player, centered, clamped to the world.
         * bgSetScroll moves the BG in hardware; the player draws in
         * SCREEN space (worldX - camX). */
        camX = (px >> 4) - (SCREEN_W / 2 - 4);
        if (camX < 0) camX = 0;
        if (camX > WORLD_W - SCREEN_W) camX = WORLD_W - SCREEN_W;
        bgSetScroll(0, camX, 0);

        oamSetXY(0, (px >> 4) - camX, py >> 4);
        oamUpdate();
        WaitForVBlank();
    }
    return 0;
}
