/*
 * PC Engine "sprite_move" — a joypad-controlled 16x16 sprite over a tiled BG.
 *
 * Press the d-pad to slide a yellow-faced sprite around a green/dark checkerboard
 * background. This is the canonical PCE "read pad + move a sprite over a tilemap"
 * starter: it exercises the whole helper library end to end —
 *
 *   vce_set_color()           BG + sprite palette entries (9-bit GRB)
 *   load_tiles()/vram_write() tile patterns + sprite pattern into VRAM
 *   (fill_bat)                a tiled background map streamed to the BAT
 *   set_sprite()+satb_dma()   a 16x16 sprite via the shadow SATB + R19 DMA
 *   bg_enable()/spr_enable()  master display-enable + VBlank IRQ (waitvsync)
 *   pce_joy_init/pce_joy_read d-pad input
 *
 * BUILD: link main.c + pce_video.c + pce_input.c + pce_sound.c together, with
 * pce_hw.h in includes. (PCE cc65 target supplies crt0 + pce.lib automatically.)
 *
 * cc65 is C89 — declare locals at the top of a block. A cart INIT must never
 * return, so main() ends in for(;;){}.
 *
 * EMPTY-BSS TRAP: linking pce_video.c pulls in _pce_keep[4], so .bss is never
 * empty (no ld65 range-error / black screen). We touch _pce_keep[0] for clarity.
 */
#include <pce.h>
#include "pce_hw.h"

/* ------------------------------------------------------------------ VRAM map */
#define TILE_A_VRAM   0x1000   /* 8x8 BG tile A (green block)   */
#define TILE_B_VRAM   0x1010   /* 8x8 BG tile B (dark block)    */
#define SPR_VRAM      0x1800   /* 16x16 sprite pattern          */
#define BAT_VRAM      0x0000   /* background attribute table    */

/* The BAT entry packs: bits 0..11 = (tileVramWordAddr >> 4), bits 12..15 = the
 * 16-color BG sub-palette. We use sub-palette 0 for both tiles. */
#define BAT_ENTRY(vram, pal)  ((u16)(((u16)(pal) << 12) | ((u16)(vram) >> 4)))

/* Tile pattern buffers. PCE tiles are 4bpp, 8x8 = 16 words (4 bitplanes x 8
 * rows, interleaved as plane0/1 first 8 words, plane2/3 next 8 words). */
static u16 tile_a[16];   /* color index 1 -> green */
static u16 tile_b[16];   /* color index 2 -> dark teal */

/* 16x16 sprite = 64 words. A little face: outline in color 1, eyes/mouth in 2. */
static u16 sprite_cell[64];

/* Player position (top-left of the 16x16 sprite, in pixels). */
static u16 px, py;
static u8  pad;

/* Build an 8x8 tile that is a SOLID fill of `ci` (color index 1..15). For a
 * 4bpp tile, color index `ci` means: for each of the 4 bitplanes p, set the
 * row byte to 0xFF if bit p of ci is set. plane0/1 occupy words 0..7,
 * plane2/3 words 8..15; each word's low byte = even plane, high byte = odd. */
static void make_solid_tile(u16 *t, u8 ci) {
    u8 r;
    u8 p0 = (ci & 1) ? 0xFF : 0x00;
    u8 p1 = (ci & 2) ? 0xFF : 0x00;
    u8 p2 = (ci & 4) ? 0xFF : 0x00;
    u8 p3 = (ci & 8) ? 0xFF : 0x00;
    for (r = 0; r < 8; ++r) {
        t[r]     = (u16)(p0 | (p1 << 8));   /* planes 0 (lo) + 1 (hi) */
        t[r + 8] = (u16)(p2 | (p3 << 8));   /* planes 2 (lo) + 3 (hi) */
    }
}

/* Build the 16x16 sprite face. PCE 16x16 sprite = 64 words: 4 bitplanes, each
 * plane is 16 rows of 16-bit masks, stored plane0[16], plane1[16], plane2[16],
 * plane3[16]. We only need 2 colors:
 *   color 1 (plane0 bit set)  -> face fill
 *   color 2 (plane1 bit set)  -> eyes + mouth
 * `face[r]` is the 16-bit row mask for the body; `feat[r]` for the features. */
static void make_sprite(void) {
    static const u16 face[16] = {
        0x0000, 0x07E0, 0x1FF8, 0x3FFC, 0x7FFE, 0x7FFE, 0xFFFF, 0xFFFF,
        0xFFFF, 0xFFFF, 0x7FFE, 0x7FFE, 0x3FFC, 0x1FF8, 0x07E0, 0x0000
    };
    /* eyes on rows 5-6, mouth on rows 10-11 */
    static const u16 feat[16] = {
        0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x1818, 0x1818, 0x0000,
        0x0000, 0x0000, 0x3C3C, 0x3C3C, 0x0000, 0x0000, 0x0000, 0x0000
    };
    u8 r;
    for (r = 0; r < 64; ++r) sprite_cell[r] = 0;
    for (r = 0; r < 16; ++r) {
        /* plane0 = face body MINUS the feature pixels (so they read color 2) */
        sprite_cell[r]      = (u16)(face[r] & ~feat[r]);
        /* plane1 = the feature pixels -> color index 2 */
        sprite_cell[r + 16] = feat[r];
        /* planes 2,3 stay zero */
    }
}

/* Draw a 32x32-cell checkerboard of TILE_A / TILE_B across the BAT. The default
 * PCE virtual screen is 32x32 cells (256x256 px), which covers the display.
 * A two-colour checkerboard (green + dark teal) makes the whole playfield read
 * as a real, visible background — a SOLID single-colour fill instead looks blank
 * to a human (one colour covers >92% of the screen), so we alternate by cell. */
static void fill_bat(void) {
    u16 ea = BAT_ENTRY(TILE_A_VRAM, 0);
    u16 eb = BAT_ENTRY(TILE_B_VRAM, 0);
    u16 r, col, e;
    for (r = 0; r < 32; ++r) {
        vram_set_write_addr((u16)(BAT_VRAM + r * 32));
        for (col = 0; col < 32; ++col) {
            /* 2x2-cell checkerboard: alternates green/teal so the background is
             * unmistakably present while the sprite still stands out clearly. */
            e = (((r >> 1) ^ (col >> 1)) & 1) ? eb : ea;
            VDC_DATA_LO = (u8)(e & 0xFF);
            VDC_DATA_HI = (u8)(e >> 8);
        }
    }
}

void main(void) {
    _pce_keep[0] = 0;

    px = 120; py = 100;

    /* --- palettes ---------------------------------------------------------- */
    /* BG sub-palette 0: index 0 = backdrop, 1 = green, 2 = dark teal. */
    vce_set_color(0, PCE_RGB(0, 0, 1));   /* backdrop: near-black blue */
    vce_set_color(1, PCE_RGB(1, 6, 1));   /* BG color 1: green         */
    vce_set_color(2, PCE_RGB(0, 2, 2));   /* BG color 2: dark teal     */
    /* Sprite sub-palette 0 lives at VCE 256..271. */
    vce_set_color(256, PCE_RGB(0, 0, 0)); /* sprite transparent        */
    vce_set_color(257, PCE_RGB(7, 7, 7)); /* sprite color 1: white     */
    vce_set_color(258, PCE_RGB(7, 1, 0)); /* sprite color 2: red       */

    /* --- patterns ---------------------------------------------------------- */
    make_solid_tile(tile_a, 1);
    make_solid_tile(tile_b, 2);
    make_sprite();

    load_tiles(TILE_A_VRAM, tile_a, 16);
    load_tiles(TILE_B_VRAM, tile_b, 16);
    load_tiles(SPR_VRAM,    sprite_cell, 64);

    fill_bat();

    /* --- first sprite frame ------------------------------------------------ */
    /* set_sprite pattern arg = the 16x16 cell index; the VDC pattern address is
     * (cell << 1) words. SPR_VRAM word addr 0x1800 -> cell 0x1800 >> 6 = 0x60. */
    set_sprite(0, px, py, SPR_VRAM >> 6, 0);
    satb_dma();

    /* --- enable display + input -------------------------------------------- */
    bg_enable();
    spr_enable();
    pce_joy_init();

    for (;;) {
        waitvsync();
        pad = pce_joy_read();
        if ((pad & PCE_JOY_LEFT)  && px > 1)   px -= 2;
        if ((pad & PCE_JOY_RIGHT) && px < 240) px += 2;
        if ((pad & PCE_JOY_UP)    && py > 1)   py -= 2;
        if ((pad & PCE_JOY_DOWN)  && py < 208) py += 2;
        set_sprite(0, px, py, SPR_VRAM >> 6, 0);
        satb_dma();
    }
}
