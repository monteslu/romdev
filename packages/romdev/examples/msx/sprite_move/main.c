/* MSX sprite_move — a joystick-controlled sprite over a screen-2 TILED background.
 *
 * A checkerboard of two tile patterns fills the whole 32x24 screen-2 name table,
 * and a 16x16 sprite (four 8x8 cells, VDP "size 1 = 16x16") moves over it with the
 * joystick. The sprite clamps to the visible area. This is the minimal
 * "draw a real tiled background + read input + move a sprite" loop every action
 * game starts from.
 *
 * Why a 16x16 sprite: screen-2 sprites default to 8x8; we set VDP R1 bit 1 (SI)
 * to get 16x16, whose pattern is four 8x8 quadrants stored as 32 consecutive
 * bytes (top-left col, bottom-left col, top-right col, bottom-right col).
 *
 * Build: buildForPlatform({ platform:"msx",
 *   sources:{ "main.c":..., "msx_vdp.c":..., "msx_crt0.s":... },
 *   includes:{ "msx_hw.h":... }, crt0:".module empty\n", sourceName:"main.c" })
 */
#include "msx_hw.h"

/* ── Background tile patterns (8x8, 1bpp; a bit set = foreground colour) ──────
 * tile 0: a framed block (outline) — reads as a grid cell.
 * tile 1: a small centre dot — the alternating checkerboard cell. */
static const unsigned char TILE_FRAME[8] = {
    0xFF, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xFF
};
static const unsigned char TILE_DOT[8] = {
    0x00, 0x00, 0x18, 0x3C, 0x3C, 0x18, 0x00, 0x00
};

/* ── Colour bytes (one per 8-pixel tile row): high nibble = fg, low = bg ──────
 * TMS9918 fixed palette: 4=dark blue, 5=light blue, 6=dark red, 14=grey,
 * 15=white, 1=transparent/black. */
#define COL_FRAME 0xF4   /* white frame on dark-blue field   */
#define COL_DOT   0x54   /* light-blue dot on dark-blue field */

/* ── 16x16 sprite: a filled blob with an outline, stored as 4 quadrants ───────
 * VDP 16x16 layout = 32 bytes: bytes 0-7 = left half rows 0-7,
 * 8-15 = left half rows 8-15, 16-23 = right half rows 0-7, 24-31 = right rows 8-15. */
static const unsigned char SPR_BLOB[32] = {
    /* left half, top    */ 0x07, 0x1F, 0x3F, 0x7F, 0x7F, 0xFF, 0xFF, 0xFF,
    /* left half, bottom */ 0xFF, 0xFF, 0xFF, 0x7F, 0x7F, 0x3F, 0x1F, 0x07,
    /* right half, top   */ 0xE0, 0xF8, 0xFC, 0xFE, 0xFE, 0xFF, 0xFF, 0xFF,
    /* right half, bottom*/ 0xFF, 0xFF, 0xFF, 0xFE, 0xFE, 0xFC, 0xF8, 0xE0
};

/* Lay a checkerboard of tile 0 / tile 1 across all 32x24 name-table cells. */
static void draw_background(void) {
    unsigned char row, col;
    /* Pattern + colour generators: screen 2 has THREE 256-tile banks (one per
     * vertical third). We only use tiles 0 and 1, so write them into all three
     * banks at base + third*0x800 so the whole screen shares the same art. */
    unsigned char third;
    for (third = 0; third < 3; third++) {
        unsigned int poff = (unsigned int)third * 0x800;
        /* pattern bytes for tile 0 and tile 1 */
        msx_vram_write((unsigned int)(VRAM_PATTERN + poff +  0), TILE_FRAME, 8);
        msx_vram_write((unsigned int)(VRAM_PATTERN + poff +  8), TILE_DOT,   8);
        /* colour bytes — 8 rows each, constant per tile */
        msx_fill_vram((unsigned int)(VRAM_COLOR + poff +  0), 8, COL_FRAME);
        msx_fill_vram((unsigned int)(VRAM_COLOR + poff +  8), 8, COL_DOT);
    }
    /* Name table: checkerboard of tile 0 / tile 1. */
    for (row = 0; row < 24; row++) {
        for (col = 0; col < 32; col++) {
            unsigned int cell = VRAM_NAME + (unsigned int)row * 32 + col;
            msx_fill_vram(cell, 1, (unsigned char)((row + col) & 1));
        }
    }
}

void main(void) {
    unsigned char px = 120, py = 88;   /* sprite top-left position */
    unsigned char dir;

    msx_set_screen2();                 /* 256x192 graphic mode, display on */
    msx_clear_sprites();

    /* Switch sprites to 16x16 (VDP R1: keep display-on bit 6 + 16K bit 7 that
     * INIGRP set, add bit 1 = size 16x16). INIGRP leaves R1 = 0xE2 on MSX2;
     * 0xE2 | 0x02 = 0xE2 already has size; set explicitly to be safe. */
    msx_wrtvdp(1, 0xE2);               /* 0x40 disp-on | 0x80 16K | 0x02 16x16 */

    msx_vram_write(VRAM_SPRPAT, SPR_BLOB, 32);  /* 16x16 sprite, pattern #0 */
    draw_background();

    for (;;) {
        /* Port 1 = the joystick port (port 0 is the keyboard cursor, which an
         * emulator's gamepad does NOT drive). 0=center, 1-8 clockwise from up. */
        dir = msx_read_joystick(1);
        if (dir == 8 || dir == 1 || dir == 2) { if (py > 2)   py -= 2; }
        if (dir == 4 || dir == 5 || dir == 6) { if (py < 174) py += 2; }
        if (dir == 6 || dir == 7 || dir == 8) { if (px > 2)   px -= 2; }
        if (dir == 2 || dir == 3 || dir == 4) { if (px < 238) px += 2; }

        /* Plane 0, pattern 0, colour 15 = white. (16x16 sprite uses pattern *4
         * indices internally; pattern #0 maps to the 32-byte block we uploaded.) */
        msx_set_sprite(0, px, py, 0, 15);

        msx_vblank_wait();
    }
}
