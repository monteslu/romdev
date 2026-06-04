/*
 * PC Engine "catch_game" — a tiny complete, playable game.
 *
 * Move the catcher (a wide paddle sprite at the bottom of the screen) LEFT and
 * RIGHT with the d-pad to catch a fruit that falls from the top. Each catch
 * scores a point, plays a blip, and respawns the fruit at a new random column,
 * a little faster. Miss it (it hits the floor) and you lose a life; lose all 3
 * and the score freezes (game over). The score is drawn with background digit
 * tiles in the top-left.
 *
 * Demonstrates a FULL game loop on the PCE: waitvsync()-paced logic, two moving
 * sprites driven from a shadow SATB, BG tilemap (BAT) text for the HUD, the VCE
 * palette, joypad input, and a PSG sound effect.
 *
 * BUILD (multi-source cc65 — link the PCE helper lib):
 *   sources: { "main.c": <this>, "pce_video.c": ..., "pce_input.c": ...,
 *              "pce_sound.c": ... }
 *   headers/includes: { "pce_hw.h": ... }
 *   buildForPlatform({ platform:"pce", sources, headers, sourceName:"main.c" })
 *
 * cc65 is C89 — locals are declared at the top of each block.
 */
#include <pce.h>
#include "pce_hw.h"

/* ---- VRAM layout (word addresses) --------------------------------------- */
#define BAT_VRAM       0x0000   /* 32x32 background map                       */
#define FONT_VRAM      0x1000   /* digit + glyph tiles (8x8, 16 words each)   */
#define BLANK_VRAM     0x1000   /* tile 0 of the font = blank                 */
#define CATCHER_VRAM   0x1800   /* catcher sprite cell (16x16 = 64 words)     */
#define FRUIT_VRAM     0x1840   /* fruit sprite cell (16x16 = 64 words)       */

/* BAT entry: high nibble = palette, low 12 bits = (tile_vram_word_addr >> 4). */
#define BAT_ENTRY(pal, vram)  ((u16)(((pal) << 12) | ((vram) >> 4)))

/* The 8x8 glyphs we need: blank, the 10 digits, and the letters for "SCORE",
 * "LIVES" and "GAME OVER". Each glyph is a 5x7 bitmap (top-left of the cell).
 * Index order matters — it maps to FONT_VRAM tile slots. */
#define G_BLANK 0
#define G_0     1   /* digits 0..9 -> tiles 1..10 */
#define G_S     11
#define G_C     12
#define G_O     13
#define G_R     14
#define G_E     15
#define G_L     16
#define G_I     17
#define G_V     18
#define G_G     19
#define G_A     20
#define G_M     21
#define G_X     22  /* used as a colon-ish separator: we use blank instead */
#define NUM_GLYPHS 22

/* 5x7 font, one byte per row (bit4..bit0 = leftmost..rightmost of 5 px). */
static const u8 FONT5x7[NUM_GLYPHS][7] = {
    /* G_BLANK */ {0,0,0,0,0,0,0},
    /* 0 */ {0x0E,0x11,0x13,0x15,0x19,0x11,0x0E},
    /* 1 */ {0x04,0x0C,0x04,0x04,0x04,0x04,0x0E},
    /* 2 */ {0x0E,0x11,0x01,0x02,0x04,0x08,0x1F},
    /* 3 */ {0x1F,0x02,0x04,0x02,0x01,0x11,0x0E},
    /* 4 */ {0x02,0x06,0x0A,0x12,0x1F,0x02,0x02},
    /* 5 */ {0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E},
    /* 6 */ {0x06,0x08,0x10,0x1E,0x11,0x11,0x0E},
    /* 7 */ {0x1F,0x01,0x02,0x04,0x08,0x08,0x08},
    /* 8 */ {0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E},
    /* 9 */ {0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C},
    /* S */ {0x0F,0x10,0x10,0x0E,0x01,0x01,0x1E},
    /* C */ {0x0E,0x11,0x10,0x10,0x10,0x11,0x0E},
    /* O */ {0x0E,0x11,0x11,0x11,0x11,0x11,0x0E},
    /* R */ {0x1E,0x11,0x11,0x1E,0x14,0x12,0x11},
    /* E */ {0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F},
    /* L */ {0x10,0x10,0x10,0x10,0x10,0x10,0x1F},
    /* I */ {0x0E,0x04,0x04,0x04,0x04,0x04,0x0E},
    /* V */ {0x11,0x11,0x11,0x11,0x0A,0x0A,0x04},
    /* G */ {0x0E,0x11,0x10,0x17,0x11,0x11,0x0F},
    /* A */ {0x0E,0x11,0x11,0x1F,0x11,0x11,0x11},
    /* M */ {0x11,0x1B,0x15,0x15,0x11,0x11,0x11},
};

/* ---- game state --------------------------------------------------------- */
static u16 catcher_x;      /* catcher sprite X (screen px)                    */
static u16 fruit_x, fruit_y;
static u16 score;
static u8  lives;
static u8  game_over;
static u16 fall_speed;     /* fruit Y px per frame                           */
static u16 rng;            /* tiny LCG for fruit respawn column               */
static u8  pad, prev_pad;

#define CATCHER_Y   200
#define CATCHER_W   32         /* catcher is two 16px cells wide visually     */
#define FLOOR_Y     216

/* tile buffers built at runtime */
static u16 font_cell[16];      /* one 8x8 4bpp tile = 16 words                */
static u16 catcher_cell[64];   /* 16x16 sprite                                */
static u16 fruit_cell[64];     /* 16x16 sprite                                */

/* ---- build a font tile from a 5x7 glyph --------------------------------- */
/* PCE tiles are 8x8, 4 bitplanes. A word holds 8 px of one plane-pair row:
 * low byte = plane0 row, high byte = plane1 row. We draw the glyph in colour
 * index 1 (plane0 set, others clear), so only the low byte (plane0) is used.
 * Tile word layout: words 0..7 = plane0/1 rows, words 8..15 = plane2/3 rows. */
static void upload_font(void) {
    u8 g, row, bits, plane0;
    for (g = 0; g < NUM_GLYPHS; ++g) {
        for (row = 0; row < 16; ++row) font_cell[row] = 0;
        for (row = 0; row < 7; ++row) {
            bits = FONT5x7[g][row];
            /* shift the 5-px glyph right by 1 so it sits inset in the cell,
             * and reverse so bit4 (leftmost) lands at pixel 0. */
            plane0 = 0;
            if (bits & 0x10) plane0 |= 0x40;
            if (bits & 0x08) plane0 |= 0x20;
            if (bits & 0x04) plane0 |= 0x10;
            if (bits & 0x02) plane0 |= 0x08;
            if (bits & 0x01) plane0 |= 0x04;
            font_cell[row] = (u16)plane0;        /* plane0 in low byte */
        }
        load_tiles((u16)(FONT_VRAM + g * 16), font_cell, 16);
    }
}

/* ---- build the two sprite cells ----------------------------------------- */
static void upload_sprites(void) {
    u16 i;
    /* Catcher: a solid 16x16 bar, colour index 1 (planes 0+1 set). It reads as
     * a chunky paddle; we draw two of them side-by-side for a wide catcher. */
    for (i = 0; i < 64; ++i) catcher_cell[i] = 0;
    for (i = 0; i < 16; ++i) {
        catcher_cell[i]      = 0xFFFF;  /* plane0 all 16 rows (full width)   */
        catcher_cell[16 + i] = 0xFFFF;  /* plane1 -> colour index 3          */
    }
    load_tiles(CATCHER_VRAM, catcher_cell, 64);

    /* Fruit: a filled diamond in colour index 1. */
    for (i = 0; i < 64; ++i) fruit_cell[i] = 0;
    {
        static const u16 diamond[16] = {
            0x0180, 0x03C0, 0x07E0, 0x0FF0, 0x1FF8, 0x3FFC, 0x7FFE, 0xFFFF,
            0xFFFF, 0x7FFE, 0x3FFC, 0x1FF8, 0x0FF0, 0x07E0, 0x03C0, 0x0180,
        };
        for (i = 0; i < 16; ++i) fruit_cell[i] = diamond[i];  /* plane0 */
    }
    load_tiles(FRUIT_VRAM, fruit_cell, 64);
}

/* ---- clear the whole BAT to blank tiles --------------------------------- */
static void clear_bat(void) {
    u16 r, c;
    u16 blank = BAT_ENTRY(0, BLANK_VRAM);
    for (r = 0; r < 32; ++r) {
        vram_set_write_addr((u16)(BAT_VRAM + r * 32));
        for (c = 0; c < 32; ++c) {
            VDC_DATA_LO = (u8)(blank & 0xFF);
            VDC_DATA_HI = (u8)(blank >> 8);
        }
    }
}

/* put a glyph tile at BAT cell (col,row) */
static void put_glyph(u8 col, u8 row, u8 glyph) {
    u16 e = BAT_ENTRY(0, (u16)(FONT_VRAM + glyph * 16));
    vram_set_write_addr((u16)(BAT_VRAM + row * 32 + col));
    VDC_DATA_LO = (u8)(e & 0xFF);
    VDC_DATA_HI = (u8)(e >> 8);
}

/* draw a short word from glyph ids */
static void put_word(u8 col, u8 row, const u8 *glyphs, u8 n) {
    u8 i;
    for (i = 0; i < n; ++i) put_glyph((u8)(col + i), row, glyphs[i]);
}

/* draw the score (up to 4 digits) right-aligned at a fixed HUD slot */
static void draw_score(void) {
    u16 v = score;
    u8  d0, d1, d2, d3;
    d3 = (u8)(v % 10); v /= 10;
    d2 = (u8)(v % 10); v /= 10;
    d1 = (u8)(v % 10); v /= 10;
    d0 = (u8)(v % 10);
    put_glyph(6, 1, (u8)(G_0 + d0));
    put_glyph(7, 1, (u8)(G_0 + d1));
    put_glyph(8, 1, (u8)(G_0 + d2));
    put_glyph(9, 1, (u8)(G_0 + d3));
}

/* draw remaining lives as a digit */
static void draw_lives(void) {
    put_glyph(8, 2, (u8)(G_0 + lives));
}

static void draw_hud_labels(void) {
    static const u8 SCORE[] = { G_S, G_C, G_O, G_R, G_E };
    static const u8 LIVES[] = { G_L, G_I, G_V, G_E, G_S };
    put_word(1, 1, SCORE, 5);
    put_word(1, 2, LIVES, 5);
}

static void draw_game_over(void) {
    static const u8 GAME[] = { G_G, G_A, G_M, G_E };
    static const u8 OVER[] = { G_O, G_V, G_E, G_R };
    put_word(12, 13, GAME, 4);
    put_word(17, 13, OVER, 4);
}

/* simple LCG -> a fruit spawn column in [16, 240] */
static u16 next_fruit_x(void) {
    rng = (u16)(rng * 25173u + 13849u);
    return (u16)(16 + (rng >> 8) % 224);
}

static void spawn_fruit(void) {
    fruit_x = next_fruit_x();
    fruit_y = 16;
}

static void blip(u16 freq, u8 vol) {
    psg_tone(0, freq, vol);
}

void main(void) {
    u8 sfx_timer;

    _pce_keep[0] = 0;

    /* palette: backdrop, BG text colours, sprite colours */
    vce_set_color(0,   PCE_RGB(0, 0, 1));     /* backdrop: near-black blue   */
    vce_set_color(1,   PCE_RGB(7, 7, 7));     /* BG colour 1: white text     */
    vce_set_color(256, PCE_RGB(0, 0, 0));     /* sprite transparent          */
    vce_set_color(257, PCE_RGB(2, 5, 7));     /* sprite c1: cyan (catcher 0) */
    vce_set_color(259, PCE_RGB(2, 5, 7));     /* sprite c3: cyan (catcher)   */
    /* sprite sub-palette 1 (entries 272..287) for the fruit = red/orange */
    vce_set_color(272, PCE_RGB(0, 0, 0));     /* fruit pal1 transparent      */
    vce_set_color(273, PCE_RGB(7, 4, 0));     /* fruit pal1 c1: orange       */

    upload_font();
    upload_sprites();

    clear_bat();
    draw_hud_labels();

    /* init game state */
    catcher_x = 110;
    score = 0;
    lives = 3;
    game_over = 0;
    fall_speed = 2;
    rng = 0xACE1;
    spawn_fruit();
    draw_score();
    draw_lives();

    pce_joy_init();
    disp_enable();          /* BG + sprites + VBlank IRQ (waitvsync works)    */

    prev_pad = 0;
    sfx_timer = 0;

    for (;;) {
        waitvsync();
        pad = pce_joy_read();

        if (!game_over) {
            /* move catcher */
            if ((pad & PCE_JOY_LEFT)  && catcher_x > 8)              catcher_x -= 3;
            if ((pad & PCE_JOY_RIGHT) && catcher_x < (256 - CATCHER_W - 8)) catcher_x += 3;

            /* fall */
            fruit_y += fall_speed;

            /* catch test: fruit centre within catcher span and at catcher row */
            if (fruit_y + 8 >= CATCHER_Y && fruit_y <= CATCHER_Y + 16) {
                u16 fcx = fruit_x + 8;
                if (fcx >= catcher_x && fcx <= catcher_x + CATCHER_W) {
                    if (score < 9999) ++score;
                    draw_score();
                    blip(0x080, 28);          /* high blip on catch          */
                    sfx_timer = 8;
                    if (fall_speed < 8 && (score & 3) == 0) ++fall_speed;
                    spawn_fruit();
                }
            }

            /* miss: hit the floor */
            if (fruit_y >= FLOOR_Y) {
                if (lives > 0) --lives;
                draw_lives();
                blip(0x300, 24);              /* low buzz on miss            */
                sfx_timer = 12;
                if (lives == 0) {
                    game_over = 1;
                    draw_game_over();
                } else {
                    spawn_fruit();
                }
            }
        } else {
            /* game over — RUN restarts */
            if ((pad & PCE_JOY_RUN) && !(prev_pad & PCE_JOY_RUN)) {
                clear_bat();
                draw_hud_labels();
                score = 0; lives = 3; game_over = 0; fall_speed = 2;
                catcher_x = 110;
                spawn_fruit();
                draw_score();
                draw_lives();
            }
        }

        /* stop the SFX after a few frames so it's a blip, not a drone */
        if (sfx_timer) {
            --sfx_timer;
            if (sfx_timer == 0) psg_off(0);
        }

        /* push sprites: catcher (two cells wide) + fruit */
        set_sprite(0, catcher_x,      CATCHER_Y, CATCHER_VRAM >> 6, 0);
        set_sprite(1, catcher_x + 16, CATCHER_Y, CATCHER_VRAM >> 6, 0);
        set_sprite(2, fruit_x,        fruit_y,   FRUIT_VRAM   >> 6, 1);
        satb_dma();

        prev_pad = pad;
    }
}
