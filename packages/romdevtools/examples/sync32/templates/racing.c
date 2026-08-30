/* ── racing.c — sync32 lane racer (complete example game) ──────────────
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
#define GAME_TITLE "OVERDRIVE"

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

#define IDX_CAR   1
#define IDX_GLASS 2
#define IDX_TYRE  3
#define IDX_HAZ   4
#define IDX_EDGE  5

#define COL_GRASS RGB(0x1C, 0x40, 0x22)
#define COL_ROAD  RGB(0x36, 0x38, 0x40)
#define COL_LINE  RGB(0xE8, 0xE2, 0xC0)
#define COL_HUD   RGB(0xF6, 0xF8, 0xFF)
#define COL_WARN  RGB(0xFF, 0x6A, 0x3B)

/* ── GAME LOGIC (clay) ─────────────────────────────────────────────────────
 * Forward-scrolling lane racer: steer between lanes, dodge traffic, speed
 * climbs with distance. Fork this for anything with a scrolling field and
 * lane logic — an endless runner, a rhythm game, a bullet-hell lane dodger. */
#define LANES 4
#define ROAD_W 200
#define ROAD_X ((SCR_W - ROAD_W) / 2)
#define LANE_W (ROAD_W / LANES)
#define CAR_W 20
#define CAR_H 28
#define MAX_HAZ 8

typedef enum { ST_TITLE = 0, ST_PLAY = 1, ST_OVER = 2 } state_t;

typedef struct { float y; int lane; uint8_t alive; } haz_t;

static struct {
    state_t  state;
    uint32_t score, hiscore, frames;
    int      lives, lane, spawn_timer;
    float    lane_x, speed, stripe;
    haz_t    haz[MAX_HAZ];
} g;

#define SHEET_W 64
#define SHEET_H 32
static uint8_t sheet[SHEET_W * SHEET_H];

static void car_at(int ox, uint8_t body) {
    /* A 20x28 car centred in a 32-wide cell — inside the blit span (trap 2). */
    for (int y = 2; y < 30; y++) {
        int inset = (y < 6 || y > 25) ? 4 : 1;
        for (int x = ox + 6 + inset; x < ox + 26 - inset; x++) sheet[y * SHEET_W + x] = body;
    }
    for (int y = 8; y < 15; y++) for (int x = ox + 9; x < ox + 23; x++) sheet[y * SHEET_W + x] = IDX_GLASS;
    for (int y = 5; y < 11; y++)  { sheet[y * SHEET_W + ox + 5] = IDX_TYRE; sheet[y * SHEET_W + ox + 26] = IDX_TYRE; }
    for (int y = 21; y < 27; y++) { sheet[y * SHEET_W + ox + 5] = IDX_TYRE; sheet[y * SHEET_W + ox + 26] = IDX_TYRE; }
}

static void build_sheet(void) {
    for (int i = 0; i < SHEET_W * SHEET_H; i++) sheet[i] = IDX_TRANSPARENT;
    car_at(0,  IDX_CAR);    /* player, cell 0 */
    car_at(32, IDX_HAZ);    /* traffic, cell 1 */
}

static void build_palette(const sync32_api_t *api) {
    static uint16_t pal[256];
    for (int i = 0; i < 256; i++) pal[i] = 0;
    pal[IDX_TRANSPARENT] = 0xF81F;
    pal[IDX_CAR]   = RGB(0x3B, 0xA8, 0xF0);
    pal[IDX_GLASS] = RGB(0x18, 0x22, 0x30);
    pal[IDX_TYRE]  = RGB(0x14, 0x14, 0x18);
    pal[IDX_HAZ]   = RGB(0xE0, 0x46, 0x3B);
    pal[IDX_EDGE]  = RGB(0x60, 0x64, 0x70);
    /* Colours the game DRAWS WITH must be IN the palette — rect()/clear()
     * snap to the nearest entry, so an unregistered colour renders as
     * something else entirely. */
    pal[8] = COL_GRASS;
    pal[9] = COL_ROAD;
    pal[10] = COL_LINE;
    pal[11] = COL_HUD;
    pal[12] = COL_WARN;
    api->palette_set(pal);
}

static float lane_center(int lane) { return (float)(ROAD_X + lane * LANE_W + (LANE_W - CAR_W) / 2); }

static void reset_run(void) {
    g.score = 0; g.lives = 3; g.frames = 0;
    g.lane = LANES / 2; g.lane_x = lane_center(g.lane);
    g.speed = 3.0f; g.stripe = 0; g.spawn_timer = 0;
    for (int i = 0; i < MAX_HAZ; i++) g.haz[i].alive = 0;
}

static void spawn(const sync32_api_t *api) {
    for (int i = 0; i < MAX_HAZ; i++) {
        if (g.haz[i].alive) continue;
        g.haz[i].alive = 1;
        g.haz[i].lane = (int)(api->rng_next() % LANES);
        g.haz[i].y = -(float)CAR_H;
        return;
    }
}

void game_main(const sync32_api_t *api) {
    build_palette(api);
    build_sheet();
    int sh = api->sheet_load(sheet, SHEET_W, SHEET_H);
    api->rng_seed(0xD1CEull);
    hiscore_load(api, &g.hiscore);
    reset_run();
    g.state = ST_TITLE;

    uint16_t prev = 0;
    for (;;) {
        s32_pad_t pad;
        api->pad(0, &pad);
        uint16_t pressed = (uint16_t)(pad.buttons & ~prev);

        if (g.state != ST_PLAY) {
            if (pressed & (S32_PAD_START | S32_PAD_A)) { reset_run(); g.state = ST_PLAY; }
        } else {
            if ((pressed & S32_PAD_LEFT)  && g.lane > 0) g.lane--;
            if ((pressed & S32_PAD_RIGHT) && g.lane < LANES - 1) g.lane++;
            /* Ease toward the lane centre instead of snapping — the steering
             * feel comes from this one lerp. */
            float target = lane_center(g.lane);
            g.lane_x += (target - g.lane_x) * 0.28f;

            g.speed += 0.0022f;
            if (g.speed > 9.5f) g.speed = 9.5f;
            g.stripe += g.speed;
            g.score += (uint32_t)(g.speed * 0.5f);

            if (--g.spawn_timer <= 0) {
                spawn(api);
                g.spawn_timer = (int)(44.0f - g.speed * 2.6f);
                if (g.spawn_timer < 12) g.spawn_timer = 12;
            }

            float py = (float)(SCR_H - CAR_H - 14);
            for (int i = 0; i < MAX_HAZ; i++) {
                if (!g.haz[i].alive) continue;
                g.haz[i].y += g.speed;
                if (g.haz[i].y > SCR_H) { g.haz[i].alive = 0; g.score += 25; continue; }
                float hx = lane_center(g.haz[i].lane);
                if (g.haz[i].y + CAR_H > py && g.haz[i].y < py + CAR_H &&
                    hx + CAR_W > g.lane_x && hx < g.lane_x + CAR_W) {
                    g.haz[i].alive = 0;
                    g.speed *= 0.55f;
                    if (--g.lives <= 0) { hiscore_save(api, g.score, &g.hiscore); g.state = ST_OVER; }
                }
            }
            g.frames++;
        }
        prev = pad.buttons;

        /* ---- draw ---- */
        api->clear(COL_GRASS);
        api->rect(ROAD_X, 0, ROAD_W, SCR_H, COL_ROAD);
        api->rect(ROAD_X - 3, 0, 3, SCR_H, COL_LINE);
        api->rect(ROAD_X + ROAD_W, 0, 3, SCR_H, COL_LINE);
        for (int l = 1; l < LANES; l++) {
            int lx = ROAD_X + l * LANE_W - 1;
            for (int y = -32; y < SCR_H; y += 32)
                api->rect(lx, y + ((int)g.stripe % 32), 2, 16, COL_LINE);
        }

        for (int i = 0; i < MAX_HAZ; i++)
            if (g.haz[i].alive)
                api->sprite(sh, 32, 0, 32, 32, (int)lane_center(g.haz[i].lane) - 6, (int)g.haz[i].y, 0);

        if (g.state == ST_PLAY)
            api->sprite(sh, 0, 0, 32, 32, (int)g.lane_x - 6, SCR_H - CAR_H - 14, 0);

        draw_num(api, g.score, 8, 6, 2, COL_HUD);
        for (int l = 0; l < g.lives; l++) api->rect(SCR_W - 16 - l * 12, 8, 8, 8, COL_WARN);

        if (g.state == ST_TITLE) {
            api->rect(40, 88, 240, 62, COL_GRASS);
            draw_text(api, GAME_TITLE, 76, 96, 3, COL_HUD);
            draw_text(api, "PRESS START", 96, 126, 2, COL_LINE);
        } else if (g.state == ST_OVER) {
            api->rect(48, 92, 224, 56, COL_GRASS);
            draw_text(api, "GAME OVER", 84, 104, 3, COL_HUD);
            draw_num(api, g.score, 132, 128, 2, COL_WARN);
        }

        api->present();
        if ((pad.buttons & S32_PAD_START) && (pad.buttons & S32_PAD_SELECT)) api->exit();
    }
}
