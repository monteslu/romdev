/*
 * catch_game — a tiny COMPLETE MSX game (SDCC z80, C89).
 *
 * Move the basket at the bottom of the screen left/right with the joystick (or
 * the keyboard cursor keys — stick 0) to catch the coin falling from the top.
 * Catch it: +1 score and the coin respawns at the top in a new column. Miss it
 * (it reaches the floor): the coin just respawns, no penalty — a friendly demo.
 * The score is drawn as on-screen tiles ("SCORE 000") along the top row.
 *
 * Hardware path (all through the romdev MSX helper lib, no fragile inline asm):
 *   - msx_set_screen2()      screen 2 (GRAPHIC II), 256x192, display ON
 *   - msx_vram_write()       upload our tile font + sprite patterns to VRAM
 *   - msx_set_sprite()       position the basket + coin sprites each frame
 *   - msx_read_joystick()    BIOS GTSTCK — 0=center, 1-8 = direction clockwise
 *   - msx_psg_tone/off()     a short blip on a catch
 *   - msx_vblank_wait()      one game step per VDP frame (~60 Hz NTSC)
 *
 * Cartridge rule: INIT must never return, so main() ends in for(;;). C-BIOS
 * shows its logo ~150 frames before CALLing the cart — step >= 300 before you
 * expect to see the playfield.
 *
 * Build (multi-source — .c/.s in `sources`, .h in `includes`):
 *   buildForPlatform({ platform:"msx",
 *     sources:  { "main.c":<this>, "msx_vdp.c":<lib>, "msx_crt0.s":<crt0> },
 *     includes: { "msx_hw.h":<hdr> },
 *     crt0:".module empty\n", sourceName:"main.c" })
 */
#include "msx_hw.h"

/* ── interrupt-free vblank sync ─────────────────────────────────────────────
 * The shared lib's msx_vblank_wait() spins on the BIOS JIFFY counter, which
 * only advances if the BIOS VBlank ISR is running (interrupts enabled). On a
 * bare cartridge we can't rely on that, so we poll the VDP itself: VDP status
 * register S#0 bit 7 is the frame (VBlank) flag — it sets at the start of
 * vertical blanking and the act of READING S#0 clears it. So we read once to
 * clear, then spin until it sets again = exactly one frame elapsed. This needs
 * no interrupts and works on any MSX. Port 0x99 returns the selected status
 * register; S#0 is selected by default after INIGRP. */
__sfr __at 0x99 VDPSTATUS;   /* reading port 0x99 returns the selected S# */

static void vsync(void) {
    (void)VDPSTATUS;                 /* clear any pending frame flag */
    while (!(VDPSTATUS & 0x80)) {    /* wait for the next VBlank */
    }
}

/* ── tile font ────────────────────────────────────────────────────────────
 * Screen 2's pattern generator holds 256 8x8 chars per third of the screen.
 * We define a tiny font (space, S C O R E, and the 10 digits) and place those
 * patterns at known tile indices, then replicate the SAME pattern bytes into
 * all three pattern-generator thirds so a tile renders identically anywhere.
 *
 * Each glyph is 8 bytes (one bitmask per row, MSB = leftmost pixel). */

/* tile indices we assign to glyphs in the name table */
#define T_SPACE 0
#define T_S     1
#define T_C     2
#define T_O     3
#define T_R     4
#define T_E     5
#define T_0     6   /* digits 0..9 are consecutive: T_0 + n */

/* 16 glyph patterns (indices 0..15, the rest of VRAM stays blank) */
static const uint8_t font[16][8] = {
    /* 0  SPACE */ {0,0,0,0,0,0,0,0},
    /* 1  S */ {0x7C,0xC0,0xC0,0x78,0x0C,0x0C,0xF8,0x00},
    /* 2  C */ {0x7C,0xC6,0xC0,0xC0,0xC0,0xC6,0x7C,0x00},
    /* 3  O */ {0x7C,0xC6,0xC6,0xC6,0xC6,0xC6,0x7C,0x00},
    /* 4  R */ {0xFC,0xC6,0xC6,0xFC,0xD8,0xCC,0xC6,0x00},
    /* 5  E */ {0xFE,0xC0,0xC0,0xF8,0xC0,0xC0,0xFE,0x00},
    /* 6  0 */ {0x7C,0xCE,0xDE,0xF6,0xE6,0xC6,0x7C,0x00},
    /* 7  1 */ {0x18,0x38,0x18,0x18,0x18,0x18,0x7E,0x00},
    /* 8  2 */ {0x7C,0xC6,0x06,0x1C,0x70,0xC0,0xFE,0x00},
    /* 9  3 */ {0x7C,0xC6,0x06,0x3C,0x06,0xC6,0x7C,0x00},
    /* 10 4 */ {0x1C,0x3C,0x6C,0xCC,0xFE,0x0C,0x0C,0x00},
    /* 11 5 */ {0xFE,0xC0,0xFC,0x06,0x06,0xC6,0x7C,0x00},
    /* 12 6 */ {0x3C,0x60,0xC0,0xFC,0xC6,0xC6,0x7C,0x00},
    /* 13 7 */ {0xFE,0x06,0x0C,0x18,0x30,0x30,0x30,0x00},
    /* 14 8 */ {0x7C,0xC6,0xC6,0x7C,0xC6,0xC6,0x7C,0x00},
    /* 15 9 */ {0x7C,0xC6,0xC6,0x7E,0x06,0x0C,0x78,0x00}
};

/* ── sprite patterns ───────────────────────────────────────────────────────
 * Two 8x8 sprite patterns: the basket (plane 0) and the coin (plane 1).
 * Sprite pattern N lives at sprite-pattern-base + N*8. */
static const uint8_t spr_basket[8] = {
    0x00, 0x00, 0x81, 0x81, 0xC3, 0x7E, 0x3C, 0x00  /* an open cup/basket */
};
static const uint8_t spr_coin[8] = {
    0x3C, 0x7E, 0xFF, 0xFF, 0xFF, 0xFF, 0x7E, 0x3C  /* a round coin */
};

/* sprite colours (TMS9918 fixed palette): 4=blue, 10=yellow, 15=white */
#define COL_BASKET 15
#define COL_COIN   10

/* ── game state ──────────────────────────────────────────────────────────── */
static uint8_t  basket_x;   /* basket sprite X (pixels), 0..248                */
static uint8_t  coin_x;     /* coin sprite X (pixels)                          */
static uint8_t  coin_y;     /* coin sprite Y (pixels), grows until caught/floor*/
static uint16_t score;      /* caught count                                    */
static uint16_t rng;        /* tiny LFSR-ish pseudo-random for respawn columns */

#define BASKET_Y    160     /* basket rides near the bottom                    */
#define FLOOR_Y     168     /* below this the coin is "missed"                 */
#define BASKET_W    8
#define COIN_W      8

/* upload the 16 glyph patterns into ALL THREE screen-2 pattern thirds, and
 * paint a solid colour (white on black) over the tile rows we draw text in.
 * Pattern third K covers tile rows K*8..K*8+7; each third is 0x800 bytes of
 * pattern and 0x800 of colour. We only use the top third for the score line,
 * but writing all three keeps any tile we place looking right. */
static void load_font(void) {
    uint8_t third;
    uint16_t patbase, colbase;
    uint8_t i;

    for (third = 0; third < 3; third++) {
        patbase = (uint16_t)(VRAM_PATTERN + ((uint16_t)third << 11));
        colbase = (uint16_t)(VRAM_COLOR   + ((uint16_t)third << 11));
        for (i = 0; i < 16; i++) {
            /* pattern bytes for glyph i */
            msx_vram_write((uint16_t)(patbase + ((uint16_t)i << 3)), font[i], 8);
            /* colour bytes for glyph i: 0xF0 = white fg (15) on black bg (0) */
            msx_fill_vram((uint16_t)(colbase + ((uint16_t)i << 3)), 8, 0xF0);
        }
    }
}

/* place one tile (pattern index) at name-table cell (col,row) of the 32x24 grid */
static void put_tile(uint8_t col, uint8_t row, uint8_t tile) {
    uint16_t addr = (uint16_t)(VRAM_NAME + (uint16_t)row * 32 + col);
    msx_vram_write(addr, &tile, 1);
}

/* draw the static "SCORE" label at the top-left */
static void draw_label(void) {
    put_tile(1, 0, T_S);
    put_tile(2, 0, T_C);
    put_tile(3, 0, T_O);
    put_tile(4, 0, T_R);
    put_tile(5, 0, T_E);
}

/* draw the 3-digit score after the label */
static void draw_score(void) {
    uint16_t s = score;
    uint8_t hundreds = (uint8_t)((s / 100) % 10);
    uint8_t tens     = (uint8_t)((s / 10) % 10);
    uint8_t ones     = (uint8_t)(s % 10);
    put_tile(7, 0, (uint8_t)(T_0 + hundreds));
    put_tile(8, 0, (uint8_t)(T_0 + tens));
    put_tile(9, 0, (uint8_t)(T_0 + ones));
}

/* cheap pseudo-random 0..255 (xorshift on a 16-bit seed) */
static uint8_t next_rand(void) {
    rng ^= (uint16_t)(rng << 7);
    rng ^= (uint16_t)(rng >> 9);
    rng ^= (uint16_t)(rng << 8);
    return (uint8_t)(rng & 0xFF);
}

/* respawn the coin at the top in a random column (8..240) */
static void respawn_coin(void) {
    coin_x = (uint8_t)(8 + (next_rand() % 232));
    coin_y = 0;
}

void main(void) {
    uint8_t stick, dir, frame;

    /* ── set up the screen ── */
    msx_set_screen2();          /* screen 2, VRAM cleared, display ON */
    msx_clear_sprites();        /* park all 32 sprite planes off-list */
    load_font();                /* upload glyph patterns + colours    */

    /* fill the whole 32x24 name table with the SPACE tile so the playfield is
     * uniformly blank under our score line + sprites */
    msx_fill_vram(VRAM_NAME, 32 * 24, T_SPACE);

    /* upload the two 8x8 sprite patterns: basket=pattern 0, coin=pattern 1 */
    msx_vram_write((uint16_t)(VRAM_SPRPAT + 0 * 8), spr_basket, 8);
    msx_vram_write((uint16_t)(VRAM_SPRPAT + 1 * 8), spr_coin,   8);

    draw_label();

    /* ── init game state ── */
    basket_x = 120;
    score = 0;
    rng = 0xACE1;               /* nonzero LFSR seed */
    respawn_coin();
    frame = 0;
    draw_score();

    /* ── main loop: one step per VDP frame ── */
    for (;;) {
        vsync();

        /* read joystick 0 (keyboard cursor) AND joystick 1 (port), so it works
         * whether the player uses keys or a pad. Any nonzero wins. */
        dir = msx_read_joystick(0);
        if (dir == STICK_CENTER) {
            dir = msx_read_joystick(1);
        }
        stick = dir;

        /* left = directions 6,7,8 (DL,LEFT,UL); right = 2,3,4 (UR,RIGHT,DR) */
        if (stick == STICK_LEFT || stick == STICK_UL || stick == STICK_DL) {
            if (basket_x >= 3) basket_x -= 3;
        } else if (stick == STICK_RIGHT || stick == STICK_UR || stick == STICK_DR) {
            if (basket_x <= 248 - 3) basket_x += 3;
        }

        /* coin falls 2px/frame */
        coin_y += 2;

        /* caught? coin overlaps the basket near the basket row */
        if (coin_y + COIN_W >= BASKET_Y && coin_y <= BASKET_Y + 8) {
            /* AABB overlap on X */
            if (coin_x + COIN_W > basket_x && coin_x < basket_x + BASKET_W) {
                score++;
                if (score > 999) score = 0;
                draw_score();
                /* short catch blip on PSG channel 0 */
                msx_psg_tone(0, 0x080, 13);
                frame = 4;       /* hold the blip ~4 frames then silence */
                respawn_coin();
            }
        }

        /* missed (hit the floor)? just respawn — friendly demo, no game-over */
        if (coin_y >= FLOOR_Y) {
            respawn_coin();
        }

        /* silence the catch blip a few frames after it started */
        if (frame) {
            frame--;
            if (frame == 0) msx_psg_off(0);
        }

        /* push sprite positions for this frame */
        msx_set_sprite(0, basket_x, BASKET_Y, 0, COL_BASKET);  /* plane 0 basket */
        msx_set_sprite(1, coin_x,   coin_y,   1, COL_COIN);    /* plane 1 coin   */
    }
}
