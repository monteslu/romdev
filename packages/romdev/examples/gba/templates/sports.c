/* ── sports.c — Game Boy Advance Tonc Pong scaffold ─────────────────
 *
 * One-player Pong against an AI opponent. The GBA only has one
 * controller, so the right paddle is always AI — it tracks the ball
 * vertically.
 *
 * Game state:
 *   - Left + right paddles (24-px tall, 4-px wide), moveable on Y
 *   - Ball with X + Y velocity
 *   - Per-side score (0..9), rendered via TTE
 *   - Ball off either side increments opponent's score + respawns
 *
 * Note: real-hardware GBA doesn't have a second controller port. If
 * you want 2-player you'd need the GBA link cable + a second console
 * — out of scope for this scaffold.
 */

#include <tonc.h>
#include "gba_sfx.h"

#define COURT_TOP   16
#define COURT_BOT   152
#define PADDLE_H    24
#define PADDLE_W    4
#define BALL_SIZE   8
#define PADDLE_X1   8
#define PADDLE_X2   (240 - 8 - PADDLE_W)
#define COURT_W     240

#define TILE_PADDLE 1
#define TILE_BALL   2

/* 4bpp 8x8 solid block — colour index 1. */
static const u32 tile_solid_1[8] = {
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
};

static OBJ_ATTR obj_buffer[128];

static s16 p1y, p2y;
static s16 bx, by;
static s16 bdx, bdy;
static u16 score_p1, score_p2;
static u16 serve_timer;

static void serve_ball(int to_left) {
    bx = COURT_W / 2 - BALL_SIZE / 2;
    by = (COURT_TOP + COURT_BOT) / 2;
    bdx = to_left ? -2 : 2;
    bdy = ((score_p1 + score_p2) & 1) ? -1 : 1;
    serve_timer = 30;
}

static void reset_match(void) {
    p1y = (COURT_TOP + COURT_BOT) / 2 - PADDLE_H / 2;
    p2y = p1y;
    score_p1 = 0;
    score_p2 = 0;
    serve_ball(0);
}

int main(void) {
    /* Sprite palette — both paddles and ball use index 1 = white. */
    pal_obj_mem[1] = CLR_WHITE;

    /* Sprite tiles — char base 4 of OBJ tile area. */
    tonccpy(&tile_mem[4][TILE_PADDLE], tile_solid_1, sizeof(tile_solid_1));
    tonccpy(&tile_mem[4][TILE_BALL],   tile_solid_1, sizeof(tile_solid_1));

    oam_init(obj_buffer, 128);

    /* IRQ setup — required for VBlankIntrWait() to function. */
    irq_init(NULL);
    irq_add(II_VBLANK, NULL);

    sfx_init();

    /* TTE for scores + hint. */
    tte_init_chr4c_default(0, BG_CBB(0) | BG_SBB(31));
    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0 | DCNT_OBJ | DCNT_OBJ_1D;
    tte_write("#{P:16,2}P1");
    tte_write("#{P:208,2}P2");
    tte_write("#{P:36,150}UP/DOWN MOVES YOUR PADDLE");

    reset_match();

    while (1) {
        VBlankIntrWait();
        key_poll();

        /* Player 1 — UP/DOWN. */
        if (key_held(KEY_UP)   && p1y > COURT_TOP)            p1y -= 3;
        if (key_held(KEY_DOWN) && p1y < COURT_BOT - PADDLE_H) p1y += 3;

        /* AI right paddle — tracks ball. */
        s16 target = by - PADDLE_H / 2;
        if (p2y < target && p2y < COURT_BOT - PADDLE_H) p2y += 2;
        else if (p2y > target && p2y > COURT_TOP)       p2y -= 2;

        if (serve_timer > 0) {
            serve_timer--;
        } else {
            bx += bdx;
            by += bdy;

            if (by < COURT_TOP) { by = COURT_TOP; bdy = -bdy; sfx_tone(2, 1100, 2); }
            if (by + BALL_SIZE > COURT_BOT) {
                by = COURT_BOT - BALL_SIZE;
                bdy = -bdy;
                sfx_tone(2, 1100, 2);   /* wall blip */
            }

            if (bdx < 0
                && bx <= PADDLE_X1 + PADDLE_W
                && bx + BALL_SIZE >= PADDLE_X1
                && by + BALL_SIZE > p1y
                && by < p1y + PADDLE_H) {
                bdx = -bdx;
                bx = PADDLE_X1 + PADDLE_W;
                sfx_tone(1, 1500, 3);   /* paddle hit */
            }
            if (bdx > 0
                && bx + BALL_SIZE >= PADDLE_X2
                && bx <= PADDLE_X2 + PADDLE_W
                && by + BALL_SIZE > p2y
                && by < p2y + PADDLE_H) {
                bdx = -bdx;
                bx = PADDLE_X2 - BALL_SIZE;
                sfx_tone(1, 1500, 3);
            }

            if (bx + BALL_SIZE < 0) {
                if (score_p2 < 9) score_p2++;
                sfx_noise(20);          /* point lost — buzz */
                serve_ball(0);
            }
            if (bx > COURT_W) {
                if (score_p1 < 9) score_p1++;
                sfx_tone(1, 1900, 16);  /* point won — chime */
                serve_ball(1);
            }
        }

        /* Sprite slots: 0..2 = P1 paddle (3 vertical tiles)
         *               3..5 = P2 paddle
         *               6    = ball */
        for (int i = 0; i < PADDLE_H / 8; i++) {
            obj_set_attr(&obj_buffer[i],
                ATTR0_SQUARE,
                ATTR1_SIZE_8,
                ATTR2_PALBANK(0) | TILE_PADDLE);
            obj_set_pos(&obj_buffer[i], PADDLE_X1, p1y + i * 8);
        }
        for (int i = 0; i < PADDLE_H / 8; i++) {
            obj_set_attr(&obj_buffer[3 + i],
                ATTR0_SQUARE,
                ATTR1_SIZE_8,
                ATTR2_PALBANK(0) | TILE_PADDLE);
            obj_set_pos(&obj_buffer[3 + i], PADDLE_X2, p2y + i * 8);
        }
        obj_set_attr(&obj_buffer[6],
            ATTR0_SQUARE,
            ATTR1_SIZE_8,
            ATTR2_PALBANK(0) | TILE_BALL);
        obj_set_pos(&obj_buffer[6], bx, by);

        oam_copy(oam_mem, obj_buffer, 7);

        /* Score digits. */
        tte_erase_rect(28, 2, 36, 14);
        tte_printf("#{P:28,2}%d", score_p1 % 10);
        tte_erase_rect(220, 2, 228, 14);
        tte_printf("#{P:220,2}%d", score_p2 % 10);
    }
    return 0;
}
