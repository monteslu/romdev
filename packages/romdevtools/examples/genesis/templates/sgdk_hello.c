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

int main(bool hard) {
    /* Boot info: hard == TRUE on power-on, FALSE on soft reset (we
     * could re-init differently in each case; this minimum starter
     * treats them identically). */
    (void)hard;

    /* SGDK initialized the VDP + default palette in sega.s + libmd
     * before main() ran. Just draw text. */
    VDP_drawText("HELLO SEGA GENESIS", 10, 12);
    VDP_drawText("BUILT WITH ROM-DEV-MCP", 8, 14);

    /* Game loop. SYS_doVBlankProcess blocks until vblank, then runs
     * SGDK's per-frame housekeeping. */
    while (TRUE) {
        SYS_doVBlankProcess();
    }
    return 0;
}
