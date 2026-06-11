/* ── sports.c — SNES PVSnesLib two-player Pong scaffold ─────────────
 *
 * Two-player Pong. Both ports wired:
 *   padsCurrent(0) — UP/DOWN moves the left paddle (player 1)
 *   padsCurrent(1) — UP/DOWN moves the right paddle (player 2)
 *
 * AI fallback on port 1 when no second controller is plugged in
 * (padsCurrent(1) returns 0). Per-side score 0-9 via consoleDrawText.
 *
 * tcc-65816 is C89 — all declarations at block top, no inline `for (u16 i …)`.
 */

#include <snes.h>
#include "snes_sfx.c"

extern char tilfont, palfont;
extern char tilsprite, palsprite;
extern char tilbg, palbg;       /* wallpaper tile + palette (data.asm) */

/* consoleVblank() copies the dirty text tilemap to VRAM during VBlank.
 * No public prototype in console.h, so declare it; call once per frame. */
extern void consoleVblank(void);

/* BG1 wallpaper map: a full 32x32 screen of the 4-colour tile so the
 * court reads as a real backdrop, not flat blank. Filled at runtime. */
static u16 bg_map[32 * 32];

#define COURT_TOP   16
#define COURT_BOT   208
#define PADDLE_H    24
#define BALL_SIZE   8
#define PADDLE_X1   16
#define PADDLE_X2   232

/* oamSet's FIRST arg is a BYTE OFFSET into OAM, not a slot number: slot N lives
 * at byte offset N*4. Passing the raw slot writes every sprite into OAM bytes
 * 0-9, corrupting each other → black/garbled screen. (The shmup scaffold gets
 * this right; sports/racing did not — SNES-1.) */
#define SPR(slot) ((slot) << 2)

static s16 p1y, p2y, bx, by;
static s8  bdx, bdy;
static u16 score_p1, score_p2;
static u16 serve_timer;

static void serve_ball(u8 to_left) {
    bx = 124;
    by = 110;
    bdx = to_left ? -2 : 2;
    bdy = ((score_p1 + score_p2) & 1) ? -1 : 1;
    serve_timer = 30;
}

static void reset_match(void) {
    p1y = 96;
    p2y = 96;
    score_p1 = 0;
    score_p2 = 0;
    serve_ball(0);
}

static void render_scores(void) {
    char buf[2];
    buf[1] = 0;
    buf[0] = '0' + (score_p1 % 10);
    consoleDrawText(6, 2, buf);
    buf[0] = '0' + (score_p2 % 10);
    consoleDrawText(24, 2, buf);
}

/* Draw a Pong court out of font glyphs on the text BG (no extra tile
 * data needed): a dashed rail across the top and bottom of the playfield
 * plus a dashed centre net. The text grid is 32x28 cells (8px each). */
#define COURT_NET_COL  16
#define COURT_ROW_TOP  4
#define COURT_ROW_BOT  23
static void draw_court(void) {
    char rail[29];
    u16 i;
    for (i = 0; i < 28; i++) rail[i] = '-';
    rail[28] = 0;
    consoleDrawText(2, COURT_ROW_TOP, rail);
    consoleDrawText(2, COURT_ROW_BOT, rail);
    /* Dashed centre net: a ':' every other row between the rails. */
    for (i = COURT_ROW_TOP + 1; i < COURT_ROW_BOT; i += 2) {
        consoleDrawText(COURT_NET_COL, i, ":");
    }
}

int main(void) {
    u16 p1, p2;
    u16 i, slot;
    s16 target;

    consoleSetTextMapPtr(0x6800);
    consoleSetTextGfxPtr(0x3000);
    consoleSetTextOffset(0x0000);   /* tile index = (char-0x20); font is at the BG char base */
    consoleInitText(0, 16 * 2, &tilfont, &palfont);
    setMode(BG_MODE1, 0);
    /* consoleInitText DMAs the font but does NOT set the PPU BG base
     * registers — point BG0 at the same font ($3000) + map ($6800). */
    bgSetGfxPtr(0, 0x3000);
    bgSetMapPtr(0, 0x6800, SC_32x32);

    /* BG1 = full-screen wallpaper so the court never reads as blank.
     * Tiles -> VRAM $2000, map -> VRAM $4000 (clear of sprites $0000 and
     * the console gfx $3000 / map $6800). Map entries use palette block 1
     * (0x0400) so the wallpaper palette doesn't disturb the console font
     * palette in block 0 (HUD/court text stays legible). */
    bgInitTileSet(1, (u8 *)&tilbg, (u8 *)&palbg, 1,
                  32, 32, BG_16COLORS, 0x2000);

    /* Per-genre backdrop tint — every SNES scaffold used to ship the same
     * blue checkered wallpaper ('no variety'). Recolor the wallpaper's
     * CGRAM entries (block 1 = entries 16+) to a court green scheme. */
    setPaletteColor(0, RGB5(2,9,4));
    setPaletteColor(17, RGB5(5,14,7));
    setPaletteColor(18, RGB5(3,11,5));
    for (i = 0; i < 32 * 32; i++) bg_map[i] = 0x0400;
    bgInitMapSet(1, (u8 *)bg_map, sizeof(bg_map), SC_32x32, 0x4000);
    bgSetEnable(1);
    bgSetDisable(2);

    oamInitGfxSet(&tilsprite, 32, &palsprite, 32, 0, 0x0000, OBJ_SIZE8_L16);

    consoleDrawText(2, 1, "P1");
    consoleDrawText(28, 1, "P2");
    consoleDrawText(6, 26, "UP/DOWN MOVES YOUR PADDLE");
    draw_court();   /* dashed rails + centre net (font glyphs, no extra tiles) */

    /* Hide all OAM slots initially. */
    for (i = 0; i < 7; i++) oamSet(SPR(i), 0, 240, 3, 0, 0, 0, 0);

    setScreenOn();
    sfx_init();
    WaitForVBlank();   /* one frame before any SPC command — the driver seeds its
                        * command edge-detector AFTER init returns; a same-frame
                        * command is silently swallowed (see music_demo.c) */
    reset_match();

    while (1) {
        slot = 0;
        /* Left paddle = 3 stacked 8×8 sprites */
        for (i = 0; i < PADDLE_H / 8; i++) {
            oamSet(SPR(slot++), PADDLE_X1, (u16)(p1y + i * 8), 3, 0, 0, 0, 0);
        }
        for (i = 0; i < PADDLE_H / 8; i++) {
            oamSet(SPR(slot++), PADDLE_X2, (u16)(p2y + i * 8), 3, 0, 0, 0, 0);
        }
        oamSet(SPR(slot++), bx, by, 3, 0, 0, 0, 0);
        oamUpdate();
        render_scores();
        WaitForVBlank();
        consoleVblank();

        p1 = padsCurrent(0);
        p2 = padsCurrent(1);

        if ((p1 & KEY_UP)   && p1y > COURT_TOP)            p1y -= 2;
        if ((p1 & KEY_DOWN) && p1y < COURT_BOT - PADDLE_H) p1y += 2;

        if (p2 != 0) {
            if ((p2 & KEY_UP)   && p2y > COURT_TOP)            p2y -= 2;
            if ((p2 & KEY_DOWN) && p2y < COURT_BOT - PADDLE_H) p2y += 2;
        } else {
            target = by - PADDLE_H / 2;
            if (p2y < target && p2y < COURT_BOT - PADDLE_H) p2y += 1;
            else if (p2y > target && p2y > COURT_TOP)       p2y -= 1;
        }

        if (serve_timer > 0) {
            serve_timer--;
        } else {
            bx = (s16)(bx + bdx);
            by = (s16)(by + bdy);

            if (by < COURT_TOP)             { by = COURT_TOP; bdy = (s8)(-bdy); }
            if (by + BALL_SIZE > COURT_BOT) { by = COURT_BOT - BALL_SIZE; bdy = (s8)(-bdy); }

            if (bdx < 0
                && bx <= PADDLE_X1 + 8
                && bx + BALL_SIZE >= PADDLE_X1
                && by + BALL_SIZE > p1y
                && by < p1y + PADDLE_H) {
                bdx = (s8)(-bdx);
                bx = PADDLE_X1 + 8;
                sfx_play(1);  /* paddle hit */
            }
            if (bdx > 0
                && bx + BALL_SIZE >= PADDLE_X2
                && bx <= PADDLE_X2 + 8
                && by + BALL_SIZE > p2y
                && by < p2y + PADDLE_H) {
                bdx = (s8)(-bdx);
                bx = PADDLE_X2 - BALL_SIZE;
                sfx_play(1);
            }

            if (bx < 4)   { if (score_p2 < 9) score_p2++; sfx_play(2); serve_ball(0); }
            if (bx > 252) { if (score_p1 < 9) score_p1++; sfx_play(2); serve_ball(1); }
        }
    }
    return 0;
}
