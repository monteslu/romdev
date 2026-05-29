/* ── sports.c — Genesis SGDK two-player Pong scaffold ──────────────
 *
 * Two-player Pong. Both Genesis controller ports are wired —
 * `JOY_readJoypad(JOY_1)` drives the left paddle, `JOY_readJoypad(JOY_2)`
 * drives the right paddle. With a single controller, the right paddle
 * falls back to a "chase the ball" AI so the game is still playable
 * solo.
 *
 * Game state:
 *   - Left + right paddles (24-px tall, 4-px wide), moveable on Y
 *   - Ball with X + Y velocity
 *   - Per-side score (0..9), rendered via VDP_drawText
 *   - Ball off either side increments opponent's score + respawns
 *     toward the loser
 *
 * Designed for the romdev playtest window with hot-plugged
 * controllers — plug in a second pad mid-session and player 2
 * just starts working without a restart.
 */

#include <genesis.h>
#include "genesis_sfx.h"

#define COURT_TOP   16
#define COURT_BOT   208
#define PADDLE_H    24
#define PADDLE_W    4
#define BALL_SIZE   8
#define PADDLE_X1   16
#define PADDLE_X2   (320 - 16 - PADDLE_W)
#define COURT_W     320

#define T_PADDLE    (TILE_USER_INDEX + 0)
#define T_BALL      (TILE_USER_INDEX + 1)

/* 4bpp 8×8 tile, all colour 1 → solid white block. */
static const u32 tile_solid[8] = {
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
};

static s16 p1y, p2y;       /* paddle top Y, pixels */
static s16 bx, by;         /* ball top-left, pixels */
static s16 bdx, bdy;
static u16 score_p1, score_p2;
static u16 serve_timer;

static void serve_ball(bool to_left) {
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
    serve_ball(FALSE);
}

static void render_scores(void) {
    char buf[2] = { 0, 0 };
    buf[0] = '0' + (score_p1 % 10);
    VDP_drawText(buf, 6,  2);
    buf[0] = '0' + (score_p2 % 10);
    VDP_drawText(buf, 32, 2);
}

int main(bool hard) {
    (void)hard;

    /* Sprite palette 0: white + cyan accents. */
    PAL_setColor(0 + 1, 0x0EEE);

    VDP_loadTileData(tile_solid, T_PADDLE, 1, DMA);
    VDP_loadTileData(tile_solid, T_BALL,   1, DMA);

    VDP_drawText("PLAYER 1", 2, 1);
    VDP_drawText("PLAYER 2", 28, 1);
    VDP_drawText("UP/DOWN MOVES YOUR PADDLE", 7, 27);

    sfx_init();
    reset_match();

    while (TRUE) {
        u16 p1 = JOY_readJoypad(JOY_1);
        u16 p2 = JOY_readJoypad(JOY_2);

        /* Player 1 (left paddle) — UP/DOWN. */
        if ((p1 & BUTTON_UP)   && p1y > COURT_TOP)             p1y -= 3;
        if ((p1 & BUTTON_DOWN) && p1y < COURT_BOT - PADDLE_H)  p1y += 3;

        /* Player 2 (right paddle) — human if any input this frame,
         * otherwise AI chases the ball. JOY_readJoypad returns 0 when
         * no controller is plugged into port 2. */
        if (p2 != 0) {
            if ((p2 & BUTTON_UP)   && p2y > COURT_TOP)            p2y -= 3;
            if ((p2 & BUTTON_DOWN) && p2y < COURT_BOT - PADDLE_H) p2y += 3;
        } else {
            s16 target = by - PADDLE_H / 2;
            if (p2y < target && p2y < COURT_BOT - PADDLE_H) p2y += 2;
            else if (p2y > target && p2y > COURT_TOP)       p2y -= 2;
        }

        if (serve_timer > 0) {
            serve_timer--;
        } else {
            bx += bdx;
            by += bdy;

            if (by < COURT_TOP)               { by = COURT_TOP;            bdy = -bdy; sfx_tone(2, 350, 2); }
            if (by + BALL_SIZE > COURT_BOT)   { by = COURT_BOT - BALL_SIZE;bdy = -bdy; sfx_tone(2, 350, 2); }

            /* Paddle 1 (left) collision */
            if (bdx < 0
                && bx <= PADDLE_X1 + PADDLE_W
                && bx + BALL_SIZE >= PADDLE_X1
                && by + BALL_SIZE > p1y
                && by < p1y + PADDLE_H) {
                bdx = -bdx;
                bx = PADDLE_X1 + PADDLE_W;
                sfx_tone(1, 280, 3);   /* paddle hit */
            }
            /* Paddle 2 (right) collision */
            if (bdx > 0
                && bx + BALL_SIZE >= PADDLE_X2
                && bx <= PADDLE_X2 + PADDLE_W
                && by + BALL_SIZE > p2y
                && by < p2y + PADDLE_H) {
                bdx = -bdx;
                bx = PADDLE_X2 - BALL_SIZE;
                sfx_tone(1, 280, 3);
            }

            if (bx + BALL_SIZE < 0) {
                if (score_p2 < 9) score_p2++;
                sfx_noise(24);          /* point lost — buzz */
                serve_ball(FALSE);
            }
            if (bx > COURT_W) {
                if (score_p1 < 9) score_p1++;
                sfx_tone(0, 200, 16);   /* point won — chime */
                serve_ball(TRUE);
            }
        }

        /* Sprite SAT update — paddles are 3 stacked 1×1 sprites, ball
         * is one. We only use 7 sprite slots which is well under the
         * 80 the VDP allows. */
        u16 slot = 0;
        for (u16 i = 0; i < PADDLE_H / 8; i++) {
            VDP_setSprite(slot++, PADDLE_X1, p1y + i * 8, SPRITE_SIZE(1, 1),
                          TILE_ATTR_FULL(PAL0, 1, 0, 0, T_PADDLE));
        }
        for (u16 i = 0; i < PADDLE_H / 8; i++) {
            VDP_setSprite(slot++, PADDLE_X2, p2y + i * 8, SPRITE_SIZE(1, 1),
                          TILE_ATTR_FULL(PAL0, 1, 0, 0, T_PADDLE));
        }
        VDP_setSprite(slot++, bx, by, SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(PAL0, 1, 0, 0, T_BALL));
        VDP_updateSprites(slot, DMA);

        render_scores();

        sfx_update();
        SYS_doVBlankProcess();
    }
    return 0;
}
