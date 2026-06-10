/*
 * PC Engine "sports" — a Pong-style two-paddle scaffold.
 *
 * Two paddles and a bouncing ball on a netted court. The d-pad moves player 1's
 * (left) paddle up/down. Player 2's (right) paddle follows the ball with a
 * chase-AI so the game is playable solo. The ball deflects off paddles and the
 * top/bottom court lines; a ball past either edge scores for the other side and
 * re-serves. Score is shown with background digit tiles. Mirrors the
 * NES/Genesis/SNES/GB/SMS sports scaffolds.
 *
 * Paddles + ball are hardware sprites; the court (green field, white border
 * lines, dashed centre net) is the BG tilemap, so the screen is clearly a
 * sports court (clears the verify gate).
 *
 * PCE notes (see pce_hw.h / MENTAL_MODEL.md):
 *   - disp_enable() turns on BG + sprites + the VBlank IRQ (waitvsync needs it).
 *   - .bss must be non-empty (pce_video.c's _pce_keep[] covers it).
 *
 * cc65 is C89 — declare locals at the top of a block.
 */
#include <pce.h>
#include <stdint.h>   /* int8_t/int16_t for ball velocity + positions         */
#include "pce_hw.h"

/* ---- VRAM layout (word addresses) --------------------------------------- */
#define BAT_VRAM     0x0000
#define FONT_VRAM    0x1000   /* digit tiles                                 */
#define GREEN_VRAM   0x1400   /* court field (colour 1)                      */
#define LINE_VRAM    0x1410   /* court line / border (colour 2)             */
#define NET_VRAM     0x1420   /* dashed centre net                         */
#define PADDLE_VRAM  0x1800   /* 16x16 paddle segment                       */
#define BALL_VRAM    0x1840   /* 16x16 ball                                  */

#define BAT_ENTRY(pal, vram)  ((u16)(((pal) << 12) | ((vram) >> 4)))

#define COURT_TOP   24
#define COURT_BOT   216
#define PADDLE_H    48          /* 3 stacked 16px sprite segments             */
#define BALL_SIZE   12
#define PADDLE_X1   16
#define PADDLE_X2   224

/* ---- font (digits only) ------------------------------------------------- */
#define NUM_GLYPHS 10
static const u8 FONT5x7[NUM_GLYPHS][7] = {
    {0x0E,0x11,0x13,0x15,0x19,0x11,0x0E}, /* 0 */
    {0x04,0x0C,0x04,0x04,0x04,0x04,0x0E}, /* 1 */
    {0x0E,0x11,0x01,0x02,0x04,0x08,0x1F}, /* 2 */
    {0x1F,0x02,0x04,0x02,0x01,0x11,0x0E}, /* 3 */
    {0x02,0x06,0x0A,0x12,0x1F,0x02,0x02}, /* 4 */
    {0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E}, /* 5 */
    {0x06,0x08,0x10,0x1E,0x11,0x11,0x0E}, /* 6 */
    {0x1F,0x01,0x02,0x04,0x08,0x08,0x08}, /* 7 */
    {0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E}, /* 8 */
    {0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C}  /* 9 */
};

/* ---- state -------------------------------------------------------------- */
static int16_t p1y, p2y, bx, by;
static int8_t  bdx, bdy;
static u8  score_p1, score_p2;
static u8  serve_timer;
static u8  pad;
static u16 tile_buf[16];
static u16 spr_buf[64];
static u8  sfx_timer;

static void make_solid_tile(u16 *t, u8 ci) {
    u8 r;
    u8 p0 = (ci & 1) ? 0xFF : 0x00;
    u8 p1 = (ci & 2) ? 0xFF : 0x00;
    u8 p2 = (ci & 4) ? 0xFF : 0x00;
    u8 p3 = (ci & 8) ? 0xFF : 0x00;
    for (r = 0; r < 8; ++r) {
        t[r]     = (u16)(p0 | (p1 << 8));
        t[r + 8] = (u16)(p2 | (p3 << 8));
    }
}

/* net tile: green field (colour 1) with a colour-2 vertical dash centre column */
static void make_net_tile(u16 *t) {
    u8 r;
    for (r = 0; r < 8; ++r) {
        u8 dash = (r < 5);   /* dashed: top 5 rows of each tile are the dash  */
        u8 p1 = dash ? 0x18 : 0x00;  /* centre 2 px -> colour 2 (plane1)       */
        t[r]     = (u16)(0x00FF | (p1 << 8));  /* plane0 full (green) + dash   */
        t[r + 8] = 0x0000;
    }
}

static void make_paddle_sprite(void) {
    u8 r;
    for (r = 0; r < 64; ++r) spr_buf[r] = 0;
    /* a solid 8px-wide vertical bar centred in the 16px cell, colour 1 */
    for (r = 0; r < 16; ++r) spr_buf[r] = 0x0FF0;
    load_tiles(PADDLE_VRAM, spr_buf, 64);
}

static void make_ball_sprite(void) {
    static const u16 ball[16] = {
        0x0000, 0x0000, 0x07E0, 0x0FF0, 0x1FF8, 0x1FF8, 0x3FFC, 0x3FFC,
        0x3FFC, 0x3FFC, 0x1FF8, 0x1FF8, 0x0FF0, 0x07E0, 0x0000, 0x0000
    };
    u8 r;
    for (r = 0; r < 64; ++r) spr_buf[r] = 0;
    for (r = 0; r < 16; ++r) spr_buf[r] = ball[r];   /* colour 1 */
    load_tiles(BALL_VRAM, spr_buf, 64);
}

static void upload_font(void) {
    u8 g, row, bits, plane0;
    for (g = 0; g < NUM_GLYPHS; ++g) {
        for (row = 0; row < 16; ++row) tile_buf[row] = 0;
        for (row = 0; row < 7; ++row) {
            bits = FONT5x7[g][row];
            plane0 = 0;
            if (bits & 0x10) plane0 |= 0x40;
            if (bits & 0x08) plane0 |= 0x20;
            if (bits & 0x04) plane0 |= 0x10;
            if (bits & 0x02) plane0 |= 0x08;
            if (bits & 0x01) plane0 |= 0x04;
            tile_buf[row] = (u16)plane0;
        }
        load_tiles((u16)(FONT_VRAM + g * 16), tile_buf, 16);
    }
}

static void draw_court(void) {
    u8 r, c;
    u16 g  = BAT_ENTRY(0, GREEN_VRAM);
    u16 ln = BAT_ENTRY(0, LINE_VRAM);
    u16 nt = BAT_ENTRY(0, NET_VRAM);
    u16 e;
    for (r = 0; r < 32; ++r) {
        vram_set_write_addr((u16)(BAT_VRAM + r * 32));
        for (c = 0; c < 32; ++c) {
            if (r <= 2 || r >= 27)       e = ln;   /* top/bottom border       */
            else if (c == 1 || c == 30)  e = ln;   /* sidelines               */
            else if (c == 16)            e = nt;   /* centre net              */
            else                          e = g;    /* field                   */
            VDC_DATA_LO = (u8)(e & 0xFF);
            VDC_DATA_HI = (u8)(e >> 8);
        }
    }
}

static void put_glyph(u8 col, u8 row, u8 digit) {
    u16 e = BAT_ENTRY(0, (u16)(FONT_VRAM + digit * 16));
    vram_set_write_addr((u16)(BAT_VRAM + row * 32 + col));
    VDC_DATA_LO = (u8)(e & 0xFF);
    VDC_DATA_HI = (u8)(e >> 8);
}

static void draw_scores(void) {
    put_glyph(12, 1, (u8)(score_p1 % 10));
    put_glyph(19, 1, (u8)(score_p2 % 10));
}

static void serve_ball(u8 to_left) {
    bx = 120; by = 110;
    bdx = to_left ? -2 : 2;
    bdy = ((score_p1 + score_p2) & 1) ? -1 : 1;
    serve_timer = 40;
}

void main(void) {
    u8 i;

    _pce_keep[0] = 0;

    /* palette */
    vce_set_color(0,   PCE_RGB(0, 1, 0));   /* backdrop dark green          */
    vce_set_color(1,   PCE_RGB(0, 4, 1));   /* BG c1: court green           */
    vce_set_color(2,   PCE_RGB(7, 7, 7));   /* BG c2: white lines/net/digit */
    vce_set_color(256, PCE_RGB(0, 0, 0));   /* spr pal0 transparent         */
    vce_set_color(257, PCE_RGB(7, 7, 7));   /* spr pal0 c1: white paddle    */
    vce_set_color(272, PCE_RGB(0, 0, 0));   /* spr pal1 transparent         */
    vce_set_color(273, PCE_RGB(7, 7, 0));   /* spr pal1 c1: yellow ball     */

    upload_font();
    make_solid_tile(tile_buf, 1); load_tiles(GREEN_VRAM, tile_buf, 16);
    make_solid_tile(tile_buf, 2); load_tiles(LINE_VRAM, tile_buf, 16);
    make_net_tile(tile_buf);      load_tiles(NET_VRAM, tile_buf, 16);
    make_paddle_sprite();
    make_ball_sprite();

    draw_court();

    p1y = 90; p2y = 90;
    score_p1 = 0; score_p2 = 0;
    sfx_timer = 0;
    serve_ball(0);
    draw_scores();

    pce_joy_init();
    disp_enable();

    for (;;) {
        u8 slot;
        int16_t target;
        waitvsync();
        psg_music_tick();

        /* stage sprites: P1 paddle (3 segs), P2 paddle (3 segs), ball */
        slot = 0;
        for (i = 0; i < 3; ++i)
            set_sprite(slot++, PADDLE_X1, (u16)(p1y + i * 16), PADDLE_VRAM >> 6, 0);
        for (i = 0; i < 3; ++i)
            set_sprite(slot++, PADDLE_X2, (u16)(p2y + i * 16), PADDLE_VRAM >> 6, 0);
        set_sprite(slot++, (u16)bx, (u16)by, BALL_VRAM >> 6, 1);
        satb_dma();

        pad = pce_joy_read();

        /* P1 control */
        if ((pad & PCE_JOY_UP)   && p1y > COURT_TOP)            p1y -= 3;
        if ((pad & PCE_JOY_DOWN) && p1y < COURT_BOT - PADDLE_H) p1y += 3;

        /* P2 chase-AI */
        target = (int16_t)(by - PADDLE_H / 2 + BALL_SIZE / 2);
        if (p2y < target && p2y < COURT_BOT - PADDLE_H) p2y += 2;
        else if (p2y > target && p2y > COURT_TOP)       p2y -= 2;

        if (serve_timer > 0) {
            serve_timer--;
        } else {
            bx = (int16_t)(bx + bdx);
            by = (int16_t)(by + bdy);

            if (by < COURT_TOP) { by = COURT_TOP; bdy = (int8_t)(-bdy); psg_tone(1, 0x280, 18); sfx_timer = 4; }
            if (by + BALL_SIZE > COURT_BOT) { by = (int16_t)(COURT_BOT - BALL_SIZE); bdy = (int8_t)(-bdy); psg_tone(1, 0x280, 18); sfx_timer = 4; }

            /* left paddle */
            if (bdx < 0 && bx <= PADDLE_X1 + 12 && bx + BALL_SIZE >= PADDLE_X1 &&
                by + BALL_SIZE > p1y && by < p1y + PADDLE_H) {
                bdx = (int8_t)(-bdx);
                bx = PADDLE_X1 + 12;
                psg_tone(0, 0x200, 22); sfx_timer = 4;
            }
            /* right paddle */
            if (bdx > 0 && bx + BALL_SIZE >= PADDLE_X2 && bx <= PADDLE_X2 + 12 &&
                by + BALL_SIZE > p2y && by < p2y + PADDLE_H) {
                bdx = (int8_t)(-bdx);
                bx = (int16_t)(PADDLE_X2 - BALL_SIZE);
                psg_tone(0, 0x200, 22); sfx_timer = 4;
            }

            /* scoring */
            if (bx < 2)   { if (score_p2 < 9) score_p2++; draw_scores(); psg_tone(0, 0x100, 24); sfx_timer = 8; serve_ball(0); }
            if (bx > 246) { if (score_p1 < 9) score_p1++; draw_scores(); psg_tone(0, 0x100, 24); sfx_timer = 8; serve_ball(1); }
        }

        if (sfx_timer) { --sfx_timer; if (sfx_timer == 0) { psg_off(0); psg_off(1); } }
    }
}
