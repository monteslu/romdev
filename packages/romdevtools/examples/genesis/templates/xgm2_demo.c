/*
 * xgm2_demo.c — Genesis XGM2 music playback demo (SGDK runtime).
 *
 * Shows the canonical 3-line XGM2 boot sequence:
 *   1. XGM2_loadDriver(TRUE)  uploads the Z80 audio driver into Z80 RAM
 *      and waits for the driver's ready handshake.
 *   2. extern music_xgm — the compiled XGM2 blob, embedded in ROM via
 *      a sibling .s file that `.incbin`s demo.xgc into .rodata.
 *   3. XGM2_play(music_xgm) hands the blob to the Z80; it loops the
 *      track until XGM2_stop is called.
 *
 * Per-frame work is just SYS_doVBlankProcess() — SGDK's vblank dispatch
 * runs the XGM2 driver tick internally whenever the driver is loaded,
 * so no manual update calls are needed from the 68000 side.
 *
 * The music asset is a tiny CC0 PSG arpeggio shipped at
 * romdev-toolchain-m68k-gcc/share/genesis/lib/sgdk/music/demo.vgm — re-buildable via
 * `node scripts/build-genesis-demo-vgm.js` + xgm2tool.
 */

#include <genesis.h>

/* music_xgm is defined by xgm2_demo_data.s sibling — a labeled .incbin
 * blob in .rodata. The XGM2 driver expects the compiled XGC2 format
 * (the byte layout produced by `xgm2tool input.vgm output.xgc`). */
extern const u8 music_xgm[];

/* A backdrop block tiled across plane B so the title screen isn't a flat
 * black void (text alone on black reads as "blank" to a human). Colour
 * index 4 field with a colour-5 frame — both set below. */
static const u32 tile_bg[8] = {
    0x44444444, 0x45555554, 0x45000054, 0x45000054,
    0x45000054, 0x45000054, 0x45555554, 0x44444444,
};

#define T_BG (TILE_USER_INDEX + 0)

int main(bool hard) {
    (void)hard;

    /* Plane-B backdrop colours (palette 1) + a tiled backdrop so the
     * music-demo title screen has a visible background behind the text.
     * Plane A (the font) draws above plane B, so the text reads on top. */
    PAL_setColor(16 + 4, 0x0840); /* dark green field */
    PAL_setColor(16 + 5, 0x0C60); /* lighter frame    */
    VDP_loadTileData(tile_bg, T_BG, 1, DMA);
    for (u16 cy = 0; cy < 28; cy++)
        for (u16 cx = 0; cx < 40; cx++)
            VDP_setTileMapXY(BG_B, TILE_ATTR_FULL(PAL1, 0, 0, 0, T_BG), cx, cy);

    /* Title screen text — drawn into VDP plane A's default font region. */
    VDP_drawText("XGM2 MUSIC DEMO",        12, 10);
    VDP_drawText("ROM-DEV-MCP / SGDK",     10, 12);
    VDP_drawText("PSG ARPEGGIO (CC0)",     10, 14);
    VDP_drawText("PLAYING...",             14, 17);

    /* Boot the XGM2 driver. TRUE = wait for the Z80 to signal ready
     * before returning — safest default; takes a few frames. */
    XGM2_loadDriver(TRUE);

    /* Hand the compiled music blob to the driver. The Z80 will loop
     * the track on its own thread — the 68000 is free for game logic. */
    XGM2_play(music_xgm);

    /* SGDK's frame heartbeat. Inside SYS_doVBlankProcess: VDP DMA
     * queue flush, joypad scan, sprite engine commit, and crucially
     * the XGM2 driver sync tick. Music keeps playing without further
     * 68000 intervention. */
    while (TRUE) {
        SYS_doVBlankProcess();
    }
    return 0;
}
