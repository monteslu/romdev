/* default.c — SNES PVSnesLib starter (C).
 *
 * Smallest "ROM that does something visible" — sets a blue backdrop
 * and parks a white diamond sprite in the centre of the screen.
 * Pressing the d-pad moves the sprite.
 *
 * Picked as the default SNES template because:
 *   - PVSnesLib gives a clean C API (oamSet, padsCurrent, etc.)
 *     instead of raw 65816 / direct register pokes.
 *   - tcc-65816 builds it in <2s.
 *   - You read this file once and know how every SNES C scaffold
 *     is structured (hello_sprite, shmup, platformer all extend it).
 *
 * For raw 65816 see template:"asm" (kept for cycle-accurate work).
 * For text-mode console output see template:"c_hello".
 * For genre-shaped scaffolds see createGame({genre:"shmup", ...}).
 *
 * Sibling `data.asm` provides the sprite tile + palette bytes.
 * Build:
 *   buildSource({
 *     platform:"snes", language:"c",
 *     sourcesPaths:{"main.c":"...","data.asm":"..."},
 *   })
 */
#include <snes.h>

extern char tilsprite, palsprite;

int main(void) {
    u16 x = 120, y = 100;

    /* BG_MODE1 with all BG layers disabled — we render only the
     * sprite layer on top of the backdrop colour. */
    setMode(BG_MODE1, 0);
    bgSetDisable(0);
    bgSetDisable(1);
    bgSetDisable(2);

    /* Backdrop colour (CGRAM entry 0). RGB5: red=0, green=0, blue=15
     * → bright SNES blue. setPaletteColor packs to BGR555 for us. */
    setPaletteColor(0, RGB5(0, 0, 15));

    /* Upload 32 bytes of sprite tile + 32 bytes of sprite palette to
     * VRAM $0000 / OBJ palette slot 0. OBJ_SIZE8_L16 = small sprites
     * are 8×8, large 16×16 (we use small). */
    oamInitGfxSet(&tilsprite, 32, &palsprite, 32,
                  0,              /* OBJ palette slot */
                  0x0000,         /* VRAM address for sprite tiles */
                  OBJ_SIZE8_L16);

    /* Place sprite #0 at the centre. */
    oamSet(0, x, y,
           3 /* highest priority */,
           0 /* no flip */, 0 /* palette */, 0 /* tile index */, 0 /* objsize */);
    oamSetEx(0, OBJ_SMALL, OBJ_SHOW);

    /* Until setScreenOn() fires, the SNES holds forced blank
     * (INIDISP $80) and nothing renders. */
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
