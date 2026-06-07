/*
 * sgdk_hello.c — minimum SGDK starter for Sega Genesis C.
 *
 * Demonstrates the canonical SGDK game-loop shape:
 *   - main(bool hard) is the entry point (called from SGDK's sega.s crt0)
 *   - VDP_drawText writes ASCII into the default font region
 *   - SYS_doVBlankProcess is SGDK's frame heartbeat — drives DMA queue
 *     flushing, sprite engine updates, joypad reads, sound driver tick
 *
 * Extend from here:
 *   - SPR_init() then SPR_addSprite() for sprite work
 *   - PAL_setColors() for palette uploads
 *   - JOY_readJoypad(JOY_1) for input
 *   - XGM2_startPlay() for music
 *
 * SGDK's full API surface lives in include/genesis.h and the per-module
 * headers (vdp.h, joy.h, sprite_eng.h, sound.h, etc.). The headers are
 * shipped alongside this file — your project is self-contained and can
 * rebuild on any machine with m68k-elf-gcc installed.
 */

#include <genesis.h>

/* Two simple 8x8 background tiles for the far plane (BG_B). Tiling them
 * in a checkerboard fills the whole screen so it doesn't read as a blank
 * black backdrop. T_BG_A is a framed block (colour 1 border, colour 2
 * fill); T_BG_B is the same block in colour 3 — alternating them gives a
 * two-tone grid with a clear majority of non-backdrop pixels. */
#define T_BG_A (TILE_USER_INDEX + 0)
#define T_BG_B (TILE_USER_INDEX + 1)

static const u32 tile_bg_a[8] = {
    0x11111111, 0x12222221, 0x12222221, 0x12222221,
    0x12222221, 0x12222221, 0x12222221, 0x11111111,
};
static const u32 tile_bg_b[8] = {
    0x11111111, 0x13333331, 0x13333331, 0x13333331,
    0x13333331, 0x13333331, 0x13333331, 0x11111111,
};

int main(bool hard) {
    /* Boot info: hard == TRUE on power-on, FALSE on soft reset (we
     * could re-init differently in each case; this minimum starter
     * treats them identically). */
    (void)hard;

    /* SGDK initialized the VDP + default palette in sega.s + libmd
     * before main() ran. We add a tiled background so the screen isn't a
     * flat black backdrop, then draw the text on top. */
    PAL_setColor(16 + 1, 0x0444); /* dark grey grid border */
    PAL_setColor(16 + 2, 0x0A22); /* deep blue fill        */
    PAL_setColor(16 + 3, 0x022A); /* deep red fill (2nd block) */

    VDP_loadTileData(tile_bg_a, T_BG_A, 1, DMA);
    VDP_loadTileData(tile_bg_b, T_BG_B, 1, DMA);

    /* Fill the far plane (BG_B) with a checkerboard of the two blocks so
     * a clear majority of the visible 40x28 cells are non-backdrop. */
    for (u16 cy = 0; cy < 28; cy++)
        for (u16 cx = 0; cx < 40; cx++)
            VDP_setTileMapXY(BG_B,
                TILE_ATTR_FULL(PAL1, 0, 0, 0, ((cx ^ cy) & 1) ? T_BG_A : T_BG_B),
                cx, cy);

    VDP_drawText("HELLO SEGA GENESIS", 10, 12);
    VDP_drawText("BUILT WITH ROM-DEV-MCP", 8, 14);

    /* Game loop. SYS_doVBlankProcess blocks until vblank, then runs
     * SGDK's per-frame housekeeping. */
    while (TRUE) {
        SYS_doVBlankProcess();
    }
    return 0;
}
