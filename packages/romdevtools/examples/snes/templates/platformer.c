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
extern char tilbg, palbg;       /* wallpaper tile + palette (data.asm) */

/* consoleVblank() copies the dirty text tilemap to VRAM during VBlank.
 * No public prototype in console.h, so declare it; call once per frame. */
extern void consoleVblank(void);

/* BG1 wallpaper map: a full 32x32 screen of the 4-colour tile so the
 * playfield reads as a real backdrop, not flat blank. Filled at runtime. */
static u16 bg_map[32 * 32];

typedef struct { s16 x, y, w, h; } Rect;

#define WORLD_W  256   /* = the 32x32 console map width, so platforms are drawable */
#define SCREEN_W 256

/* Platforms in WORLD coords. The world is 256 px — exactly the 32x32
 * console map — so every platform can be DRAWN on the text layer and
 * scrolls 1:1 with the physics. (The old 512-px world only existed as
 * invisible collision rects: the 32-col map can't show cols 32-63, so
 * the player appeared to stand and jump on nothing.) */
static const Rect platforms[] = {
    {   0, 200, 256,  24 }, /* floor spans the world */
    {  24, 168,  56,   8 },
    { 104, 144,  64,   8 },
    { 184, 112,  48,   8 },
    {  48,  96,  40,   8 },
    { 208,  72,  40,   8 },
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
    consoleSetTextOffset(0x0000);   /* tile index = (char-0x20); font is at the BG char base */
    consoleInitText(0, 16 * 2, &tilfont, &palfont);
    setMode(BG_MODE1, 0);
    /* consoleInitText DMAs the font but does NOT set the PPU BG base
     * registers — point BG0 at the same font ($3000) + map ($6800). */
    bgSetGfxPtr(0, 0x3000);
    bgSetMapPtr(0, 0x6800, SC_32x32);

    /* BG1 = full-screen wallpaper so the playfield never reads as blank.
     * Tiles -> VRAM $2000, map -> VRAM $4000 (clear of sprites $0000 and
     * the console gfx $3000 / map $6800). Map entries use palette block 1
     * (0x0400) so the wallpaper palette doesn't disturb the console font
     * palette in block 0 (HUD text stays legible). */
    bgInitTileSet(1, (u8 *)&tilbg, (u8 *)&palbg, 1,
                  32, 32, BG_16COLORS, 0x2000);
    for (i = 0; i < 32 * 32; i++) bg_map[i] = 0x0400;
    bgInitMapSet(1, (u8 *)bg_map, sizeof(bg_map), SC_32x32, 0x4000);
    bgSetEnable(1);
    bgSetDisable(2);

    oamInitGfxSet(&tilsprite, 32, &palsprite, 32, 0, 0x0000, OBJ_SIZE8_L16);

    consoleDrawText(2, 1, "D-PAD MOVE   A JUMP");
    /* Column markers across the BG so the hardware scroll is visible as
     * you move (the console map is 32 cells / 256 px and wraps). */
    /* Draw every platform as a row of '=' on the (scrolling) text layer
     * so the player can SEE what they're standing on. */
    {
        char buf[33];
        u16 pi, k, cols;
        for (pi = 0; pi < N_PLATFORMS; pi++) {
            cols = platforms[pi].w / 8;
            if (cols > 32) cols = 32;
            for (k = 0; k < cols; k++) buf[k] = '=';
            buf[cols] = 0;
            consoleDrawText(platforms[pi].x / 8, platforms[pi].y / 8, buf);
        }
    }

    oamSet(0, 32, 100, 3, 0, 0, 0, 0);
    /* Screen ON first, THEN sound. sfx_init() must run AFTER setScreenOn()
     * (snes_sfx.h:63) — if the SPC stalls before the screen is on you get a
     * black/forced-blank screen forever. */
    setScreenOn();
    sfx_init();

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
        consoleVblank();
    }
    return 0;
}
