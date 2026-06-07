/* ── gba_hello.c — Game Boy Advance libgba starter ──────────────────
 *
 * Idiomatic GBA C against the devkitPro libgba SDK — same shape every
 * published devkitARM tutorial uses. Mode 3 (240×160 bitmap) framebuffer:
 * draws a navy sky + green ground + a yellow box you move with the d-pad.
 *
 * Build via romdev:
 *   build({ output: "rom", platform:"gba", language:"c", runtime:"libgba",
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

#define SCR_W 240
#define SCR_H 160
#define BOX   16          /* movable box size in pixels */

/* Fill a solid rectangle in the Mode-3 framebuffer. */
static void fill_rect(int x, int y, int w, int h, u16 color) {
    int yy, xx;
    for (yy = y; yy < y + h; yy++)
        for (xx = x; xx < x + w; xx++)
            MODE3_FB[yy][xx] = color;
}

int main(void) {
    int x = (SCR_W - BOX) / 2;
    int y = (SCR_H - BOX) / 2;

    /* MODE_3: 240×160 framebuffer, 15-bit color, BG2 = the framebuffer. */
    REG_DISPCNT = MODE_3 | BG2_ON;

    /* IRQ table — REQUIRED for VBlankIntrWait() to function. */
    irqInit();
    irqEnable(IRQ_VBLANK);

    while (1) {
        VBlankIntrWait();

        /* Read d-pad. REG_KEYINPUT is active-LOW (bit clear = pressed).
         * Invert + mask to get "is pressed" semantics. */
        u16 keys = ~REG_KEYINPUT & 0x3FF;
        if ((keys & KEY_LEFT)  && x > 0)            x -= 2;
        if ((keys & KEY_RIGHT) && x < SCR_W - BOX)  x += 2;
        if ((keys & KEY_UP)    && y > 0)            y -= 2;
        if ((keys & KEY_DOWN)  && y < SCR_H - BOX)  y += 2;

        /* Draw a recognizable scene every frame:
         *   - a navy sky filling the whole framebuffer (so it is
         *     obviously NOT a blank screen),
         *   - a green ground strip along the bottom,
         *   - a yellow d-pad-movable box. */
        fill_rect(0, 0,        SCR_W, SCR_H,      RGB5(2, 4, 12));   /* sky    */
        fill_rect(0, SCR_H-32, SCR_W, 32,         RGB5(4, 18, 4));   /* ground */
        fill_rect(x, y,        BOX,   BOX,        RGB5(31, 31, 0));  /* box    */
    }
    return 0;
}
