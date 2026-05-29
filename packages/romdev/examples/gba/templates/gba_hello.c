/* ── gba_hello.c — Game Boy Advance libgba starter ──────────────────
 *
 * Idiomatic GBA C against the devkitPro libgba SDK — same shape every
 * published devkitARM tutorial uses. Mode 3 framebuffer, draws a red
 * pixel that moves left/right via the d-pad.
 *
 * Build via rom-dev-mcp:
 *   buildSource({platform:"gba", language:"c", runtime:"libgba",
 *                source: <this file>})
 *
 * NOTE: the DEFAULT GBA runtime is libtonc (use `tonc_hello.c` instead
 * for the Tonc-tutorial-aligned starter). This file is the libgba
 * opt-in path — pass `runtime: "libgba"` to use it.
 *
 * The bundled libgba runtime gives you:
 *   - <gba.h>     umbrella header — pulls in every other libgba header
 *   - REG_DISPCNT, MODE_3, BG2_ON, etc.   display registers + flags
 *   - MODE3_FB[]                          framebuffer at 0x06000000
 *   - RGB5(r,g,b)                         pack a 15-bit color
 *   - SPRITE_GFX / OAM / BG_PALETTE       sprite + BG memory regions
 *   - REG_KEYINPUT, KEY_A/B/L/R/SELECT/START etc.   input
 *   - dmaCopy, dmaFill                    BIOS DMA helpers
 *   - irqInit, irqEnable                  interrupt table setup
 *   - VBlankIntrWait()                    frame heartbeat (REQUIRES irq)
 *
 * ⚠️  IRQ INIT IS REQUIRED. VBlankIntrWait() is a BIOS function that
 *    halts the CPU until a vblank IRQ fires. Without irqInit() +
 *    irqEnable(IRQ_VBLANK) the BIOS halts forever — ROM appears to
 *    load but freezes on frame 1. Single most common GBA gotcha.
 *
 * ⚠️  iprintf-style stdio (console.c) is NOT bundled — see
 *    TROUBLESHOOTING.md for workarounds. The libtonc default runtime
 *    provides TTE which sidesteps the issue entirely.
 */

#include <gba.h>

int main(void) {
    /* MODE_3: 240×160 framebuffer, 15-bit color, BG2 = the framebuffer. */
    REG_DISPCNT = MODE_3 | BG2_ON;

    /* IRQ table — REQUIRED for VBlankIntrWait() to function. */
    irqInit();
    irqEnable(IRQ_VBLANK);

    int x = 120;
    int y = 80;

    while (1) {
        VBlankIntrWait();

        /* Read d-pad. REG_KEYINPUT is active-LOW (bit clear = pressed).
         * Invert + mask to get "is pressed" semantics. */
        u16 keys = ~REG_KEYINPUT & 0x3FF;
        if ((keys & KEY_LEFT)  && x > 0)   x--;
        if ((keys & KEY_RIGHT) && x < 239) x++;
        if ((keys & KEY_UP)    && y > 0)   y--;
        if ((keys & KEY_DOWN)  && y < 159) y++;

        /* Trail effect: don't erase, just keep drawing. */
        MODE3_FB[y][x] = RGB5(31, 0, 0);
    }
    return 0;
}
