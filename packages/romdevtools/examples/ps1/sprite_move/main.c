/*
 * sprite_move/main.c — PS1 starter (mips-elf-gcc + the bundled psx.h helper).
 *
 * Boots a visible 320x240 display and animates a colored box bouncing around the
 * screen — the canonical "GPU is alive, here's a moving primitive" PS1 starter.
 * Exercises the whole helper lib: psx_init (GPU bring-up), psx_clear + psx_rect
 * (flat polygons), psx_vsync (pacing).
 *
 * Build with: build({ platform:"ps1", language:"c" }) — language defaults to C.
 * Output is a PS-EXE the HLE BIOS loads at 0x80010000; main() loops forever
 * (no OS to return to).
 *
 * PS1 NOTE: there is no tile/sprite/nametable hardware — the GPU draws polygons
 * into a framebuffer. A "sprite" here is a textured/flat quad you draw each frame.
 */
#include "psx.h"

int main(void)
{
    int x = 40, y = 40, dx = 2, dy = 2;
    const int W = 32, H = 32;

    psx_init();

    for (;;) {
        /* move + bounce */
        x += dx; y += dy;
        if (x < 0 || x + W > 320) dx = -dx;
        if (y < 0 || y + H > 240) dy = -dy;
        if (x < 0) x = 0; if (x + W > 320) x = 320 - W;
        if (y < 0) y = 0; if (y + H > 240) y = 240 - H;

        psx_clear(RGB(20, 30, 60));            /* deep-blue background */
        psx_rect(x, y, W, H, RGB(255, 180, 40)); /* the bouncing box */
        psx_vsync();
    }
    return 0;
}
