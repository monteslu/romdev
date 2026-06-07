/* ── hello_sprite.c — SNES PVSnesLib starter (one sprite + d-pad) ──
 *
 * Drives one 8×8 sprite around the screen with the directional pad.
 * Uses PVSnesLib's oamSet + oamUpdate path — the canonical SNES C
 * sprite loop.
 *
 * Boots-from-cold game-loop:
 *   1. consoleInitText + setMode(BG_MODE1) — gives us text on BG0
 *      so we have a visible status line.
 *   2. oamInitGfxSet uploads the sprite tile data + sprite palette
 *      into VRAM/CGRAM.
 *   3. oamSet places sprite #0 at its initial position.
 *   4. setScreenOn lifts the forced blank.
 *   5. Game loop reads padsCurrent(0), moves the sprite, oamUpdate,
 *      WaitForVBlank.
 *
 * Sibling data.asm provides tilfont + palfont (text font) AND
 * tilsprite + palsprite (sprite tile + palette). Both are stubbed
 * with hand-authored 8×8 4bpp data — replace with .incbin'd .pic /
 * .pal from gfx4snes for real art.
 */

#include <snes.h>

extern char tilfont, palfont;
extern char tilsprite, palsprite;

/* consoleVblank() copies the dirty text tilemap to VRAM during VBlank.
 * No public prototype in console.h, so declare it; call once per frame. */
extern void consoleVblank(void);

int main(void) {
    u16 x = 120, y = 100;
    u16 prev = 0;

    /* Text setup — same layout as c-hello. */
    consoleSetTextMapPtr(0x6800);
    consoleSetTextGfxPtr(0x3000);
    consoleSetTextOffset(0x0000);   /* tile index = (char-0x20); font is at the BG char base */
    consoleInitText(0, 16 * 2, &tilfont, &palfont);

    setMode(BG_MODE1, 0);
    /* consoleInitText DMAs the font but does NOT set the PPU BG base
     * registers — point BG0 at the same font ($3000) + map ($6800). */
    bgSetGfxPtr(0, 0x3000);
    bgSetMapPtr(0, 0x6800, SC_32x32);
    bgSetDisable(1);
    bgSetDisable(2);

    /* OAM init — sprite tiles at VRAM $0000, 8x8 default. */
    oamInitGfxSet(&tilsprite, 32 /* sprite tile bytes */,
                  &palsprite, 32 /* palette bytes */,
                  0 /* palette slot */, 0x0000 /* VRAM addr */,
                  OBJ_SIZE8_L16);

    consoleDrawText(2, 2, "D-PAD MOVES THE SPRITE");
    consoleDrawText(2, 4, "START FOR SOFT RESET");

    /* Place sprite #0. */
    oamSet(0, x, y, 3 /* highest priority */, 0, 0, 0, 0);
    oamSetEx(0, OBJ_SMALL, OBJ_SHOW);

    setScreenOn();

    while (1) {
        u16 pad = padsCurrent(0);

        if (pad & KEY_LEFT)  x = (x > 0)         ? x - 1 : 0;
        if (pad & KEY_RIGHT) x = (x < 255 - 8)   ? x + 1 : 247;
        if (pad & KEY_UP)    y = (y > 0)         ? y - 1 : 0;
        if (pad & KEY_DOWN)  y = (y < 223 - 8)   ? y + 1 : 215;

        /* Edge-detect START → centre. */
        if ((pad & KEY_START) && !(prev & KEY_START)) {
            x = 120; y = 100;
        }
        prev = pad;

        oamSetXY(0, x, y);
        oamUpdate();
        WaitForVBlank();
        consoleVblank();
    }
    return 0;
}
