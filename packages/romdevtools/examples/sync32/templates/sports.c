/* ── sports.c — sync32 2P paddle versus (complete example game) ──────────────
 *
 * A COMPLETE, working game — title screen, scoring, persistent hi-score
 * (save slot 0) — on monteslu's RP2350 console.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game. Markers:
 *   HARDWARE IDIOM (load-bearing) — how the sync32 ABI actually works.
 *   GAME LOGIC (clay) — tuning, art, rules: reshape freely.
 *
 * WHAT MAKES sync32 DIFFERENT: there is NO PPU. No tilemap, no OAM, no VRAM,
 * no banking, no scanline timing. A game is `game_main(api)` handed a struct
 * of function pointers, drawing into a flat 8-bit canvas.
 *
 * TWO TRAPS worth knowing before you edit:
 *   1. `api->rect()` takes an RGB565 COLOUR; sheet pixels are palette INDICES.
 *      Passing 0 to rect() draws black — and index 0 is the transparent key.
 *   2. Sheet art must sit inside the cell the blit reads. `sprite(sh, sx, ...,
 *      w, ...)` reads columns sx..sx+w-1; anything drawn outside is silently
 *      clipped and the sprite just does not appear.
 *
 * Frame budget (60Hz, 2 500 000 cycles at a 150MHz-equivalent clock): this
 * game does not come close. sync32 gives far more headroom than any 8-bit
 * target here — spend it on gameplay.
 */

#include "sync32.h"

/* examples({op:'fork'}) stamps your game's name here. */
#define GAME_TITLE "RALLY"

/* ── HARDWARE IDIOM (load-bearing): rect()/clear() SNAP TO THE PALETTE ───────
 * `api->clear(rgb565)` and `api->rect(..., rgb565)` take a colour, but the
 * canvas is 8-bit INDEXED — so the console maps your colour to the NEAREST
 * entry in the 256-slot palette and stores that index. A colour you never put
 * in the palette does not render as itself; it snaps to whatever is closest,
 * which is why a "grey road" can come out blue.
 *
 * So: every colour a game DRAWS WITH must also live in the palette. The
 * entries below are registered in build_palette() for exactly that reason —
 * add yours there too, or accept the nearest match.
 */

/* ── Palette indices used by the sprite sheet ───────────────────────────── */
#define IDX_TRANSPARENT 0
#define RGB(r, g, b) ((uint16_t)((((r) >> 3) << 11) | (((g) >> 2) << 5) | ((b) >> 3)))

#define COL_SPACE   RGB(0x08, 0x0A, 0x14)
#define COL_STAR    RGB(0x9A, 0xA6, 0xC8)
#define COL_STAR_HI RGB(0xFF, 0xFF, 0xFF)
#define COL_HUD     RGB(0xE8, 0xEE, 0xF8)
#define COL_WARN    RGB(0xFF, 0x6A, 0x3B)

static const uint8_t GLYPH_DIGIT[10][5] = {
    {7,5,5,5,7},{2,6,2,2,7},{7,1,7,4,7},{7,1,7,1,7},{5,5,7,1,1},
    {7,4,7,1,7},{7,4,7,5,7},{7,1,2,2,2},{7,5,7,5,7},{7,5,7,1,7},
};
/* A-Z, same 3x5 cell. Only the letters the built-in strings need are shaped;
 * the rest are legible blocks. */
static const uint8_t GLYPH_ALPHA[26][5] = {
    {2,5,7,5,5},{6,5,6,5,6},{3,4,4,4,3},{6,5,5,5,6},{7,4,6,4,7},{7,4,6,4,4},
    {3,4,5,5,3},{5,5,7,5,5},{7,2,2,2,7},{1,1,1,5,2},{5,6,4,6,5},{4,4,4,4,7},
    {5,7,7,5,5},{5,7,7,7,5},{2,5,5,5,2},{6,5,6,4,4},{2,5,5,7,3},{6,5,6,5,5},
    {3,4,2,1,6},{7,2,2,2,2},{5,5,5,5,7},{5,5,5,5,2},{5,5,7,7,5},{5,5,2,5,5},
    {5,5,2,2,2},{7,1,2,4,7},
};

static void draw_cell(const sync32_api_t *api, const uint8_t *g5, int x, int y, int s, uint16_t col) {
    for (int row = 0; row < 5; row++)
        for (int c = 0; c < 3; c++)
            if (g5[row] & (4 >> c)) api->rect(x + c * s, y + row * s, s, s, col);
}

static void draw_num(const sync32_api_t *api, uint32_t v, int x, int y, int s, uint16_t col) {
    char d[10]; int n = 0;
    if (!v) d[n++] = 0;
    while (v && n < 10) { d[n++] = (char)(v % 10); v /= 10; }
    for (int i = n - 1; i >= 0; i--) { draw_cell(api, GLYPH_DIGIT[(int)d[i]], x, y, s, col); x += s * 4; }
}

static void draw_text(const sync32_api_t *api, const char *t, int x, int y, int s, uint16_t col) {
    for (; *t; t++) {
        if (*t >= 'A' && *t <= 'Z') draw_cell(api, GLYPH_ALPHA[*t - 'A'], x, y, s, col);
        else if (*t >= '0' && *t <= '9') draw_cell(api, GLYPH_DIGIT[*t - '0'], x, y, s, col);
        x += s * 4;
    }
}


/* ── HARDWARE IDIOM: persistence ─────────────────────────────────────────────
 * `save_read`/`save_write` take a SLOT index, not a filename. A short read
 * means "nothing saved yet" — not an error. */
static void hiscore_load(const sync32_api_t *api, uint32_t *hi) {
    uint32_t v = 0;
    *hi = (api->save_read(0, &v, sizeof(v)) == (int)sizeof(v)) ? v : 0;
}
static void hiscore_save(const sync32_api_t *api, uint32_t score, uint32_t *hi) {
    if (score > *hi) { *hi = score; api->save_write(0, hi, sizeof(*hi)); }
}

#define SCR_W 320
#define SCR_H 240

#define IDX_P1   1
#define IDX_P2   2
#define IDX_BALL 3
#define IDX_TRIM 4

#define COL_COURT RGB(0x12, 0x30, 0x1E)
#define COL_LINE  RGB(0x7A, 0xB8, 0x8C)
#define COL_HUD   RGB(0xF2, 0xF8, 0xF2)
#define COL_WARN  RGB(0xFF, 0xC8, 0x3B)

/* ── GAME LOGIC (clay) ─────────────────────────────────────────────────────
 * Two-paddle versus. sync32 exposes `api->pad(player, ...)` for a real second
 * controller — SO THIS SHIPS 2P, and falls back to an AI opponent when port 1
 * reports `connected == 0`. That check is the honest way to do it: never
 * assume a second pad, never refuse to run without one. */
#define PAD_W 6
#define PAD_H 44
#define BALL  6
#define PAD_SPEED 4.0f
#define WIN_SCORE 7

typedef enum { ST_TITLE = 0, ST_PLAY = 1, ST_OVER = 2 } state_t;

static struct {
    state_t  state;
    uint32_t hiscore, frames;
    int      s1, s2, ai;
    float    p1y, p2y, bx, by, bvx, bvy;
} g;

#define SHEET_W 32
#define SHEET_H 16
static uint8_t sheet[SHEET_W * SHEET_H];

static void build_sheet(void) {
    for (int i = 0; i < SHEET_W * SHEET_H; i++) sheet[i] = IDX_TRANSPARENT;
    /* cell 0: the ball, a 6x6 dot centred in its 16x16 cell */
    for (int y = 5; y < 11; y++) for (int x = 5; x < 11; x++) sheet[y * SHEET_W + x] = IDX_BALL;
    for (int y = 6; y < 8; y++)  for (int x = 6; x < 8; x++)  sheet[y * SHEET_W + x] = IDX_TRIM;
}

static void build_palette(const sync32_api_t *api) {
    static uint16_t pal[256];
    for (int i = 0; i < 256; i++) pal[i] = 0;
    pal[IDX_TRANSPARENT] = 0xF81F;
    pal[IDX_P1]   = RGB(0x4A, 0xC8, 0xF0);
    pal[IDX_P2]   = RGB(0xF0, 0x7A, 0x4A);
    pal[IDX_BALL] = RGB(0xF8, 0xF8, 0xF8);
    pal[IDX_TRIM] = RGB(0xC8, 0xE8, 0xFF);
    /* Colours the game DRAWS WITH must be IN the palette — rect()/clear()
     * snap to the nearest entry, so an unregistered colour renders as
     * something else entirely. */
    pal[8] = COL_COURT;
    pal[9] = COL_LINE;
    pal[10] = COL_HUD;
    pal[11] = COL_WARN;
    api->palette_set(pal);
}

static void serve(const sync32_api_t *api, int to_p2) {
    g.bx = SCR_W / 2.0f - BALL / 2.0f;
    g.by = SCR_H / 2.0f - BALL / 2.0f;
    g.bvx = to_p2 ? 3.0f : -3.0f;
    g.bvy = ((api->rng_next() & 1) ? 1.0f : -1.0f) * (1.2f + (float)(api->rng_next() % 12) * 0.1f);
}

static void reset_match(const sync32_api_t *api) {
    g.s1 = g.s2 = 0; g.frames = 0;
    g.p1y = g.p2y = SCR_H / 2.0f - PAD_H / 2.0f;
    serve(api, 1);
}

static void bounce_paddle(float py, int dir) {
    /* Where the ball hit the paddle sets the outgoing angle — the one bit of
     * feel that makes a paddle game playable rather than mechanical. */
    float rel = (g.by + BALL / 2.0f) - (py + PAD_H / 2.0f);
    g.bvy = rel * 0.13f;
    g.bvx = dir * (2.9f + (g.bvx < 0 ? -g.bvx : g.bvx) * 0.06f);
    if (g.bvx > 6.5f) g.bvx = 6.5f;
    if (g.bvx < -6.5f) g.bvx = -6.5f;
}

void game_main(const sync32_api_t *api) {
    build_palette(api);
    build_sheet();
    int sh = api->sheet_load(sheet, SHEET_W, SHEET_H);
    api->rng_seed(0xB0A7ull);
    hiscore_load(api, &g.hiscore);
    reset_match(api);
    g.state = ST_TITLE;

    uint16_t prev = 0;
    for (;;) {
        s32_pad_t p1, p2;
        api->pad(0, &p1);
        api->pad(1, &p2);
        /* HARDWARE IDIOM: `connected` is the honest 1P/2P switch. */
        g.ai = !p2.connected;
        uint16_t pressed = (uint16_t)(p1.buttons & ~prev);

        if (g.state != ST_PLAY) {
            if (pressed & (S32_PAD_START | S32_PAD_A)) { reset_match(api); g.state = ST_PLAY; }
        } else {
            if (p1.buttons & S32_PAD_UP)   g.p1y -= PAD_SPEED;
            if (p1.buttons & S32_PAD_DOWN) g.p1y += PAD_SPEED;

            if (g.ai) {
                /* Deliberately imperfect: tracks the ball with a dead zone so
                 * it can be beaten. Tighten the 0.82f to make it harder. */
                float want = g.by + BALL / 2.0f - PAD_H / 2.0f;
                float d = want - g.p2y;
                if (d > 3.0f || d < -3.0f) g.p2y += (d > 0 ? 1.0f : -1.0f) * PAD_SPEED * 0.82f;
            } else {
                if (p2.buttons & S32_PAD_UP)   g.p2y -= PAD_SPEED;
                if (p2.buttons & S32_PAD_DOWN) g.p2y += PAD_SPEED;
            }
            if (g.p1y < 0) g.p1y = 0;
            if (g.p2y < 0) g.p2y = 0;
            if (g.p1y > SCR_H - PAD_H) g.p1y = SCR_H - PAD_H;
            if (g.p2y > SCR_H - PAD_H) g.p2y = SCR_H - PAD_H;

            g.bx += g.bvx; g.by += g.bvy;
            if (g.by < 0) { g.by = 0; g.bvy = -g.bvy; }
            if (g.by > SCR_H - BALL) { g.by = SCR_H - BALL; g.bvy = -g.bvy; }

            if (g.bx <= 20 && g.bx >= 12 && g.by + BALL >= g.p1y && g.by <= g.p1y + PAD_H && g.bvx < 0)
                bounce_paddle(g.p1y, 1);
            if (g.bx + BALL >= SCR_W - 20 && g.bx + BALL <= SCR_W - 12 &&
                g.by + BALL >= g.p2y && g.by <= g.p2y + PAD_H && g.bvx > 0)
                bounce_paddle(g.p2y, -1);

            if (g.bx < -BALL)      { g.s2++; serve(api, 0); }
            if (g.bx > SCR_W)      { g.s1++; serve(api, 1); }
            if (g.s1 >= WIN_SCORE || g.s2 >= WIN_SCORE) {
                hiscore_save(api, (uint32_t)(g.s1 * 10), &g.hiscore);
                g.state = ST_OVER;
            }
            g.frames++;
        }
        prev = p1.buttons;

        /* ---- draw ---- */
        api->clear(COL_COURT);
        for (int y = 0; y < SCR_H; y += 16) api->rect(SCR_W / 2 - 1, y, 2, 9, COL_LINE);
        api->rect(0, 0, SCR_W, 2, COL_LINE);
        api->rect(0, SCR_H - 2, SCR_W, 2, COL_LINE);

        api->rect(14, (int)g.p1y, PAD_W, PAD_H, RGB(0x4A, 0xC8, 0xF0));
        api->rect(SCR_W - 14 - PAD_W, (int)g.p2y, PAD_W, PAD_H, RGB(0xF0, 0x7A, 0x4A));
        api->sprite(sh, 0, 0, 16, 16, (int)g.bx - 5, (int)g.by - 5, 0);

        draw_num(api, (uint32_t)g.s1, SCR_W / 2 - 56, 10, 3, COL_HUD);
        draw_num(api, (uint32_t)g.s2, SCR_W / 2 + 32, 10, 3, COL_HUD);

        if (g.state == ST_TITLE) {
            api->rect(40, 88, 240, 64, COL_COURT);
            draw_text(api, GAME_TITLE, 80, 96, 3, COL_HUD);
            draw_text(api, g.ai ? "1P VS CPU" : "2P VERSUS", 100, 128, 2, COL_LINE);
        } else if (g.state == ST_OVER) {
            api->rect(48, 92, 224, 56, COL_COURT);
            draw_text(api, g.s1 > g.s2 ? "P1 WINS" : "P2 WINS", 100, 104, 3, COL_HUD);
            draw_text(api, "PRESS START", 96, 130, 2, COL_WARN);
        }

        api->present();
        if ((p1.buttons & S32_PAD_START) && (p1.buttons & S32_PAD_SELECT)) api->exit();
    }
}
