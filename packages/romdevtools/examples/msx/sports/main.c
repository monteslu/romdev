/* ── sports/main.c — MSX two-player Pong scaffold (screen 2) ─────────
 *
 * Mirrors the SMS/GB/etc Pong scaffolds, translated to the MSX VDP via the
 * romdev helper lib (msx_hw.h + msx_vdp.c).
 *
 * The court (green field + white top/bottom + sidelines + dashed centre
 * net) fills the whole 32x24 screen-2 name table. Two paddles (each three
 * stacked 8x8 sprites) and a ball are sprites.
 *
 * Controls:
 *   Player 1 — joystick PORT 1 UP/DOWN moves the left paddle.
 *   Player 2 — joystick PORT 2 UP/DOWN moves the right paddle; when no
 *     second pad is present (stick 2 reads centre) the right paddle falls
 *     back to chase-the-ball AI, so the game is playable solo. Plug a
 *     second pad in mid-session and player 2 just starts working.
 *
 * Cartridge rule: INIT must never return — main() ends in for(;;).
 */
#include "msx_hw.h"

/* ── interrupt-free vblank sync (poll VDP status S#0 bit 7) ────────────── */
__sfr __at 0x99 VDPSTATUS;
static void vsync(void) {
    (void)VDPSTATUS;
    while (!(VDPSTATUS & 0x80)) {
    }
}

#define COURT_TOP   16
#define COURT_BOT   184
#define PADDLE_H    24
#define BALL_SIZE   8
#define PADDLE_X1   16
#define PADDLE_X2   232

/* tile patterns (8x8) for the court */
#define T_FIELD 0
#define T_LINE  1
#define T_NET   2

static const uint8_t TILE_FIELD[8] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};
static const uint8_t TILE_LINE[8]  = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};
static const uint8_t TILE_NET[8]   = {0x18,0x18,0x00,0x00,0x18,0x18,0x00,0x00};

/* colour bytes (hi fg, lo bg). 3=green(dark), 12=green(light), 15=white */
#define COL_FIELD 0x21   /* dark green field on black             */
#define COL_LINE  0xF1   /* white line on black                   */
#define COL_NET   0xF2   /* white net dashes on dark-green field  */

/* paddle/ball sprite pattern (8x8 solid block) */
static const uint8_t SPR_BLOCK[8] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};
#define COL_SPR 15   /* white */

static int16_t p1y, p2y, bx, by;
static int8_t  bdx, bdy;
static uint8_t score_p1, score_p2;
static uint8_t serve_timer;
static uint8_t blip;

static void load_tiles(void) {
    uint8_t third;
    uint16_t pat, col;
    for (third = 0; third < 3; third++) {
        pat = (uint16_t)(VRAM_PATTERN + ((uint16_t)third << 11));
        col = (uint16_t)(VRAM_COLOR   + ((uint16_t)third << 11));
        msx_vram_write((uint16_t)(pat + T_FIELD * 8), TILE_FIELD, 8);
        msx_vram_write((uint16_t)(pat + T_LINE  * 8), TILE_LINE,  8);
        msx_vram_write((uint16_t)(pat + T_NET   * 8), TILE_NET,   8);
        msx_fill_vram((uint16_t)(col + T_FIELD * 8), 8, COL_FIELD);
        msx_fill_vram((uint16_t)(col + T_LINE  * 8), 8, COL_LINE);
        msx_fill_vram((uint16_t)(col + T_NET   * 8), 8, COL_NET);
    }
}

static void set_cell(uint8_t row, uint8_t col, uint8_t tile) {
    msx_vram_write((uint16_t)(VRAM_NAME + (uint16_t)row * 32 + col), &tile, 1);
}

static void draw_court(void) {
    uint8_t row, col, t;
    for (row = 0; row < 24; row++) {
        for (col = 0; col < 32; col++) {
            t = T_FIELD;
            if (row <= 1 || row >= 22) t = T_LINE;
            else if (col == 1 || col == 30) t = T_LINE;
            else if (col == 16) t = T_NET;
            set_cell(row, col, t);
        }
    }
}

static void serve_ball(uint8_t to_left) {
    bx = 124;
    by = 90;
    bdx = to_left ? -2 : 2;
    bdy = ((score_p1 + score_p2) & 1) ? -1 : 1;
    serve_timer = 30;
}

static void reset_match(void) {
    p1y = 84; p2y = 84;
    score_p1 = 0; score_p2 = 0;
    serve_ball(0);
}

void main(void) {
    uint8_t i, slot, p1, p2;
    int16_t target;

    msx_set_screen2();
    msx_clear_sprites();
    load_tiles();
    draw_court();
    msx_vram_write((uint16_t)(VRAM_SPRPAT + 0), SPR_BLOCK, 8);

    blip = 0;
    reset_match();

    for (;;) {
        vsync();
        msx_music_tick();

        /* push sprites: left paddle (3 cells), right paddle (3), ball */
        slot = 0;
        for (i = 0; i < PADDLE_H / 8; i++)
            msx_set_sprite(slot++, PADDLE_X1, (uint8_t)(p1y + i * 8), 0, COL_SPR);
        for (i = 0; i < PADDLE_H / 8; i++)
            msx_set_sprite(slot++, PADDLE_X2, (uint8_t)(p2y + i * 8), 0, COL_SPR);
        msx_set_sprite(slot++, (uint8_t)bx, (uint8_t)by, 0, COL_SPR);

        p1 = msx_read_joystick(1);
        p2 = msx_read_joystick(2);

        if ((p1 == STICK_UP || p1 == STICK_UL || p1 == STICK_UR)
            && p1y > COURT_TOP) p1y -= 3;
        if ((p1 == STICK_DOWN || p1 == STICK_DL || p1 == STICK_DR)
            && p1y < COURT_BOT - PADDLE_H) p1y += 3;

        if (p2 != STICK_CENTER) {
            if ((p2 == STICK_UP || p2 == STICK_UL || p2 == STICK_UR)
                && p2y > COURT_TOP) p2y -= 3;
            if ((p2 == STICK_DOWN || p2 == STICK_DL || p2 == STICK_DR)
                && p2y < COURT_BOT - PADDLE_H) p2y += 3;
        } else {
            target = (int16_t)(by - PADDLE_H / 2);
            if (p2y < target && p2y < COURT_BOT - PADDLE_H) p2y += 2;
            else if (p2y > target && p2y > COURT_TOP) p2y -= 2;
        }

        if (serve_timer > 0) {
            serve_timer--;
        } else {
            bx = (int16_t)(bx + bdx);
            by = (int16_t)(by + bdy);
            if (by < COURT_TOP) { by = COURT_TOP; bdy = (int8_t)(-bdy); msx_psg_tone(1, 0x300, 8); blip = 3; }
            if (by + BALL_SIZE > COURT_BOT) { by = (int16_t)(COURT_BOT - BALL_SIZE); bdy = (int8_t)(-bdy); msx_psg_tone(1, 0x300, 8); blip = 3; }

            if (bdx < 0
                && bx <= PADDLE_X1 + 8
                && bx + BALL_SIZE >= PADDLE_X1
                && by + BALL_SIZE > p1y
                && by < p1y + PADDLE_H) {
                bdx = (int8_t)(-bdx);
                bx = PADDLE_X1 + 8;
                msx_psg_tone(0, 0x200, 10); blip = 4;
            }
            if (bdx > 0
                && bx + BALL_SIZE >= PADDLE_X2
                && bx <= PADDLE_X2 + 8
                && by + BALL_SIZE > p2y
                && by < p2y + PADDLE_H) {
                bdx = (int8_t)(-bdx);
                bx = (int16_t)(PADDLE_X2 - BALL_SIZE);
                msx_psg_tone(0, 0x200, 10); blip = 4;
            }

            if (bx < 4)   { if (score_p2 < 9) score_p2++; msx_psg_tone(0, 0x500, 14); blip = 8; serve_ball(0); }
            if (bx > 252) { if (score_p1 < 9) score_p1++; msx_psg_tone(0, 0x180, 14); blip = 8; serve_ball(1); }
        }

        if (blip) { blip--; if (!blip) { msx_psg_off(0); msx_psg_off(1); } }
    }
}
