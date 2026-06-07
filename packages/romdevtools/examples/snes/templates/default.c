/* default.c — SNES PVSnesLib starter (C).
 *
 * Smallest "ROM that does something visible": a full-screen diamond-tile
 * background (BG0) with a movable white sprite parked in the centre.
 * Pressing the d-pad moves the sprite. The tiled backdrop means the very
 * first build shows recognizable content, not a flat colour — the SNES
 * equivalent of the "is anything even rendering?" smoke test.
 *
 * Picked as the default SNES template because:
 *   - PVSnesLib gives a clean C API (bgInitTileSet, oamSet, padsCurrent…)
 *     instead of raw 65816 / direct register pokes.
 *   - tcc-65816 builds it in <2s.
 *   - You read this file once and know how every SNES C scaffold is
 *     structured (hello_sprite, shmup, platformer all extend it).
 *
 * The one footgun this guards against: on the SNES, NOTHING renders until
 * setScreenOn() lifts forced blank (INIDISP $80) AND at least one layer
 * (a BG or the sprite layer) actually has tiles + a non-black palette.
 * Disabling every BG and showing one sprite (the obvious "minimal" move)
 * leaves a near-blank screen — so here we light up BG0 too.
 *
 * For text-mode console output see template:"c_hello".
 * For raw 65816 see template:"asm" (kept for cycle-accurate work).
 * For genre-shaped scaffolds see scaffold({op:'game', genre:"shmup", ...}).
 *
 * Sibling `data.asm` provides tilsprite (one 8×8 4bpp diamond tile) +
 * palsprite (its 16-colour palette). We reuse that one tile for BOTH the
 * sprite and the BG wallpaper — replace with real gfx4snes .pic/.pal art.
 */
#include <snes.h>

extern char tilsprite, palsprite;

/* A 32×32 BG tilemap (one screen), all pointing at tile 0 = the diamond.
 * SNES map entries are 16-bit (tile# + palette/priority/flip bits); 0x0000
 * = tile 0, palette 0, no flip. 32*32 = 1024 entries = 2048 bytes. We fill
 * it at runtime so the source stays small. */
static u16 bg_map[32 * 32];

int main(void) {
    u16 x = 120, y = 100;
    u16 i;

    /* BG_MODE1: BG0/BG1 are 16-colour, BG2 is 4-colour — standard mix.
     * We use BG0 for the wallpaper and the sprite layer on top. */
    setMode(BG_MODE1, 0);
    bgSetDisable(1);
    bgSetDisable(2);

    /* Load the diamond tile + its palette as BG0's tileset. Tile gfx go to
     * VRAM $2000, palette into BG palette 0. 32 bytes of tile (one 8×8 4bpp
     * tile), 32 bytes of palette (16 colours × 2). */
    bgInitTileSet(0, (u8 *)&tilsprite, (u8 *)&palsprite,
                  0,            /* palette entry 0 */
                  32,           /* tile data size  */
                  32,           /* palette size    */
                  BG_16COLORS,  /* colour mode     */
                  0x2000);      /* VRAM addr for BG0 tiles */

    /* Fill the map with tile 0 and upload it to VRAM $6000. */
    for (i = 0; i < 32 * 32; i++) bg_map[i] = 0x0000;
    bgInitMapSet(0, (u8 *)bg_map, sizeof(bg_map), SC_32x32, 0x6000);

    bgSetEnable(0);

    /* Upload the same tile as a sprite (VRAM $0000, OBJ palette slot 0) so
     * the movable sprite reads distinctly on top of the wallpaper. */
    oamInitGfxSet(&tilsprite, 32, &palsprite, 32,
                  0,              /* OBJ palette slot */
                  0x0000,         /* VRAM address for sprite tiles */
                  OBJ_SIZE8_L16);

    /* Place sprite #0 at the centre, highest priority so it sits over BG0. */
    oamSet(0, x, y,
           3 /* priority */, 0 /* no flip */, 0 /* palette */,
           0 /* tile index */, 0 /* objsize */);
    oamSetEx(0, OBJ_SMALL, OBJ_SHOW);

    /* Until setScreenOn() fires, the SNES holds forced blank (INIDISP $80)
     * and nothing renders. */
    setScreenOn();

    while (1) {
        u16 pad = padsCurrent(0);

        if (pad & KEY_LEFT  && x > 0)         x -= 1;
        if (pad & KEY_RIGHT && x < 256 - 8)   x += 1;
        if (pad & KEY_UP    && y > 0)         y -= 1;
        if (pad & KEY_DOWN  && y < 224 - 8)   y += 1;

        oamSetXY(0, x, y);
        oamUpdate();
        WaitForVBlank();
    }
    return 0;
}
