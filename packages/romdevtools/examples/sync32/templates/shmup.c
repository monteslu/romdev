/* ── shmup.c — sync32 vertical shooter (complete example game) ───────────────
 *
 * A COMPLETE, working game — title screen, lives, score + persistent hi-score
 * (save slot 0), enemy waves, and a HUD — on monteslu's RP2350 console.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — how the sync32 ABI actually works;
 *     reshape your gameplay around it.
 *   GAME LOGIC (clay) — enemy patterns, scoring, tuning, art: reshape freely.
 *
 * WHAT MAKES sync32 DIFFERENT from every 8/16-bit platform in this tree:
 * there is NO PPU. No tilemap, no OAM, no VRAM, no banking, no scanline
 * timing. A game is one function, `game_main(api)`, handed a struct of
 * function pointers, drawing into a flat 8-bit canvas. Everything you know
 * about fighting a video chip does not apply here — which is why this is the
 * gentlest build target in romdev despite being the newest hardware.
 *
 * SINGLE-PLAYER BY DESIGN: `api->pad(player, ...)` takes a player index, but
 * a second pad is only present if the hardware has one, so a shmup ships 1P.
 * (Analog sticks are reported when present and NEVER required — see
 * `s32_pad_t.connected`.)
 *
 * Frame budget (60Hz, S32CORE_FLOOR_CYCLES = 2 500 000 cycles/frame at a
 * 150MHz-equivalent clock): this game is ~1 ship + 12 bullets + 16 enemies
 * with AABB checks (≈ 200 tests) plus one full 320x240 clear and ~30 sprite
 * blits. That is a rounding error against the budget — sync32 gives you far
 * more headroom than any 8-bit target here, so spend it on gameplay.
 */

#include "sync32.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it short; it is drawn with the built-in
 * 3x5 glyphs below. */
#define GAME_TITLE "STARFALL"

/* ── HARDWARE IDIOM (load-bearing) ───────────────────────────────────────────
 * The console gives you ONE 256-entry RGB565 palette. Sprite sheets are 8-bit
 * INDICES into it, and `api->rect()` takes a raw RGB565 COLOUR (not an index).
 * Mixing those up is the most common sync32 mistake: passing 0 to rect() draws
 * black, and index 0 is also the sheet's transparent key.
 */
#define IDX_TRANSPARENT 0
#define IDX_HULL        1
#define IDX_CANOPY      2
#define IDX_ENGINE      3
#define IDX_ENEMY_A     4
#define IDX_ENEMY_B     5
#define IDX_BULLET      6
#define IDX_EDGE        7

#define RGB(r, g, b) ((uint16_t)((((r) >> 3) << 11) | (((g) >> 2) << 5) | ((b) >> 3)))

#define COL_SPACE   RGB(0x08, 0x0A, 0x14)
#define COL_STAR    RGB(0x9A, 0xA6, 0xC8)
#define COL_STAR_HI RGB(0xFF, 0xFF, 0xFF)
#define COL_HUD     RGB(0xE8, 0xEE, 0xF8)
#define COL_WARN    RGB(0xFF, 0x6A, 0x3B)

#define SCR_W 320
#define SCR_H 240

/* ── GAME LOGIC (clay) ───────────────────────────────────────────────────── */
#define SHIP_W    16
#define SHIP_H    16
#define ENEMY_W   16
#define ENEMY_H   16
#define MAX_BULLETS 12
#define MAX_ENEMIES 16
#define MAX_STARS   48
#define START_LIVES 3
#define FIRE_COOLDOWN 8

typedef struct { float x, y, vy; uint8_t alive; } bullet_t;
typedef struct { float x, y, vx, vy; uint8_t alive, kind; } enemy_t;
typedef struct { float x, y, speed; uint8_t bright; } star_t;

typedef enum { ST_TITLE = 0, ST_PLAY = 1, ST_OVER = 2 } state_t;

static struct {
    state_t  state;
    uint32_t score, hiscore, frames;
    int      lives, cooldown, wave, spawn_timer;
    float    ship_x, ship_y;
    bullet_t bullets[MAX_BULLETS];
    enemy_t  enemies[MAX_ENEMIES];
    star_t   stars[MAX_STARS];
} g;

/* ── HARDWARE IDIOM: the sprite sheet ────────────────────────────────────────
 * Sheets are 8-bit indexed pixels uploaded once with `api->sheet_load()`,
 * which returns a handle. This one is DRAWN IN CODE rather than shipped as
 * art, so the example has no binary dependency — replace it with your own
 * pixels (see `examples({op:'show', example:'sync32/puzzle'})` for a sheet
 * built from a compact string table).
 *
 * Layout, 64x16: [0]=ship [16]=enemy A [32]=enemy B [48]=bullet+spark
 */
#define SHEET_W 64
#define SHEET_H 16
static uint8_t sheet[SHEET_W * SHEET_H];

static void px(int x, int y, uint8_t i) {
    if (x >= 0 && y >= 0 && x < SHEET_W && y < SHEET_H) sheet[y * SHEET_W + x] = i;
}

static void build_sheet(void) {
    for (int i = 0; i < SHEET_W * SHEET_H; i++) sheet[i] = IDX_TRANSPARENT;

    /* ship: a wedge with a canopy and two engine flares */
    for (int y = 0; y < 16; y++) {
        int half = (y * 7) / 15;                 /* widens toward the tail */
        for (int x = 8 - half; x <= 7 + half; x++) px(x, y, IDX_HULL);
    }
    for (int y = 4; y < 9; y++) for (int x = 6; x < 10; x++) px(x, y, IDX_CANOPY);
    for (int y = 13; y < 16; y++) { px(4, y, IDX_ENGINE); px(11, y, IDX_ENGINE); }

    /* enemy A: a blocky saucer */
    for (int y = 3; y < 12; y++) {
        int inset = (y < 5 || y > 9) ? 4 : 1;
        for (int x = 16 + inset; x < 32 - inset; x++) px(x, y, IDX_ENEMY_A);
    }
    for (int x = 20; x < 28; x++) { px(x, 3, IDX_EDGE); px(x, 11, IDX_EDGE); }

    /* enemy B: a diamond */
    for (int y = 0; y < 16; y++) {
        int half = (y < 8) ? y : 15 - y;
        for (int x = 40 - half; x <= 40 + half; x++) px(x, y, IDX_ENEMY_B);
    }

    /* bullet: a 4x8 slug, CENTRED in the 8-wide cell that starts at x=48.
     * The blit below reads sx=48 w=8, i.e. columns 48..55 — art drawn outside
     * that span is silently clipped, which is the easiest sheet mistake to
     * make and the hardest to see (the sprite just does not appear). */
    for (int y = 4; y < 12; y++) for (int x = 50; x < 54; x++) px(x, y, IDX_BULLET);
}

static void build_palette(const sync32_api_t *api) {
    static uint16_t pal[256];
    for (int i = 0; i < 256; i++) pal[i] = 0;
    pal[IDX_TRANSPARENT] = 0xF81F;               /* the console's colour key */
    pal[IDX_HULL]        = RGB(0xC8, 0xD2, 0xE4);
    pal[IDX_CANOPY]      = RGB(0x3B, 0x9B, 0xE0);
    pal[IDX_ENGINE]      = RGB(0xFF, 0x9A, 0x2B);
    pal[IDX_ENEMY_A]     = RGB(0xE0, 0x3B, 0x4B);
    pal[IDX_ENEMY_B]     = RGB(0x9B, 0x4F, 0xD8);
    pal[IDX_BULLET]      = RGB(0xFF, 0xE0, 0x6A);
    pal[IDX_EDGE]        = RGB(0x50, 0x58, 0x6A);
    /* Colours the game DRAWS WITH must be IN the palette — rect()/clear()
     * snap to the nearest entry, so an unregistered colour renders as
     * something else entirely. */
    pal[8] = COL_SPACE;
    pal[9] = COL_STAR;
    pal[10] = COL_STAR_HI;
    pal[11] = COL_HUD;
    pal[12] = COL_WARN;
    api->palette_set(pal);
}

/* ── Text: a 3x5 glyph set, drawn with rects ─────────────────────────────────
 * There is no font in the ABI, so a game brings its own. Scaled 2x this reads
 * cleanly at 320x240.
 */
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
 * `save_read`/`save_write` take a SLOT index (0..S32_SAVE_SLOTS-1), not a
 * file name. A short read means "nothing saved yet" — not an error.
 */
static void hiscore_load(const sync32_api_t *api) {
    uint32_t v = 0;
    g.hiscore = (api->save_read(0, &v, sizeof(v)) == (int)sizeof(v)) ? v : 0;
}
static void hiscore_save(const sync32_api_t *api) {
    if (g.score > g.hiscore) { g.hiscore = g.score; api->save_write(0, &g.hiscore, sizeof(g.hiscore)); }
}

static void reset_run(const sync32_api_t *api) {
    g.score = 0; g.lives = START_LIVES; g.wave = 1;
    g.cooldown = 0; g.spawn_timer = 0; g.frames = 0;
    g.ship_x = SCR_W / 2 - SHIP_W / 2;
    g.ship_y = SCR_H - 34;
    for (int i = 0; i < MAX_BULLETS; i++) g.bullets[i].alive = 0;
    for (int i = 0; i < MAX_ENEMIES; i++) g.enemies[i].alive = 0;
    for (int i = 0; i < MAX_STARS; i++) {
        g.stars[i].x = (float)(api->rng_next() % SCR_W);
        g.stars[i].y = (float)(api->rng_next() % SCR_H);
        g.stars[i].speed = 0.4f + (float)(api->rng_next() % 24) * 0.08f;
        g.stars[i].bright = (uint8_t)(api->rng_next() & 3);
    }
}

static void fire(const sync32_api_t *api) {
    (void)api;
    for (int i = 0; i < MAX_BULLETS; i++) {
        if (g.bullets[i].alive) continue;
        g.bullets[i].alive = 1;
        g.bullets[i].x = g.ship_x + SHIP_W / 2 - 2;
        g.bullets[i].y = g.ship_y - 6;
        g.bullets[i].vy = -5.5f;
        return;
    }
}

static void spawn_enemy(const sync32_api_t *api) {
    for (int i = 0; i < MAX_ENEMIES; i++) {
        if (g.enemies[i].alive) continue;
        g.enemies[i].alive = 1;
        g.enemies[i].kind = (uint8_t)(api->rng_next() & 1);
        g.enemies[i].x = (float)(8 + (api->rng_next() % (SCR_W - ENEMY_W - 16)));
        g.enemies[i].y = -(float)ENEMY_H;
        g.enemies[i].vy = 0.9f + 0.16f * (float)g.wave + (float)(api->rng_next() % 5) * 0.1f;
        g.enemies[i].vx = g.enemies[i].kind ? ((api->rng_next() & 1) ? 0.9f : -0.9f) : 0.0f;
        return;
    }
}

static int overlaps(float ax, float ay, int aw, int ah, float bx, float by, int bw, int bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

static void draw_starfield(const sync32_api_t *api) {
    for (int i = 0; i < MAX_STARS; i++) {
        uint16_t c = g.stars[i].bright >= 2 ? COL_STAR_HI : COL_STAR;
        api->rect((int)g.stars[i].x, (int)g.stars[i].y, 1, g.stars[i].bright >= 2 ? 2 : 1, c);
    }
}

static void step_starfield(void) {
    for (int i = 0; i < MAX_STARS; i++) {
        g.stars[i].y += g.stars[i].speed;
        if (g.stars[i].y >= SCR_H) { g.stars[i].y = 0; }
    }
}

void game_main(const sync32_api_t *api) {
    build_palette(api);
    build_sheet();
    int sh = api->sheet_load(sheet, SHEET_W, SHEET_H);
    api->rng_seed(0x5741C3ull);

    hiscore_load(api);
    reset_run(api);
    g.state = ST_TITLE;

    uint16_t prev = 0;

    for (;;) {
        s32_pad_t pad;
        api->pad(0, &pad);
        uint16_t pressed = (uint16_t)(pad.buttons & ~prev);   /* edge, not level */

        step_starfield();

        if (g.state == ST_TITLE) {
            if (pressed & (S32_PAD_START | S32_PAD_A)) { reset_run(api); g.state = ST_PLAY; }
        } else if (g.state == ST_OVER) {
            if (pressed & (S32_PAD_START | S32_PAD_A)) { reset_run(api); g.state = ST_PLAY; }
        } else {
            /* ---- ship ---- */
            float dx = 0, dy = 0;
            if (pad.buttons & S32_PAD_LEFT)  dx -= 3.4f;
            if (pad.buttons & S32_PAD_RIGHT) dx += 3.4f;
            if (pad.buttons & S32_PAD_UP)    dy -= 3.0f;
            if (pad.buttons & S32_PAD_DOWN)  dy += 3.0f;
            g.ship_x += dx; g.ship_y += dy;
            if (g.ship_x < 0) g.ship_x = 0;
            if (g.ship_y < 0) g.ship_y = 0;
            if (g.ship_x > SCR_W - SHIP_W) g.ship_x = SCR_W - SHIP_W;
            if (g.ship_y > SCR_H - SHIP_H) g.ship_y = SCR_H - SHIP_H;

            if (g.cooldown > 0) g.cooldown--;
            if ((pad.buttons & S32_PAD_A) && g.cooldown == 0) { fire(api); g.cooldown = FIRE_COOLDOWN; }

            /* ---- spawning: waves get denser as the score climbs ---- */
            if (--g.spawn_timer <= 0) {
                spawn_enemy(api);
                g.spawn_timer = 46 - (g.wave * 3);
                if (g.spawn_timer < 12) g.spawn_timer = 12;
            }
            if (g.score >= (uint32_t)(g.wave * 220)) g.wave++;

            /* ---- bullets ---- */
            for (int i = 0; i < MAX_BULLETS; i++) {
                if (!g.bullets[i].alive) continue;
                g.bullets[i].y += g.bullets[i].vy;
                if (g.bullets[i].y < -8) g.bullets[i].alive = 0;
            }

            /* ---- enemies + collisions ---- */
            for (int e = 0; e < MAX_ENEMIES; e++) {
                if (!g.enemies[e].alive) continue;
                g.enemies[e].y += g.enemies[e].vy;
                g.enemies[e].x += g.enemies[e].vx;
                if (g.enemies[e].x < 4 || g.enemies[e].x > SCR_W - ENEMY_W - 4) g.enemies[e].vx = -g.enemies[e].vx;

                if (g.enemies[e].y > SCR_H) { g.enemies[e].alive = 0; continue; }

                for (int b = 0; b < MAX_BULLETS; b++) {
                    if (!g.bullets[b].alive) continue;
                    if (overlaps(g.bullets[b].x, g.bullets[b].y, 4, 8,
                                 g.enemies[e].x, g.enemies[e].y, ENEMY_W, ENEMY_H)) {
                        g.bullets[b].alive = 0;
                        g.enemies[e].alive = 0;
                        g.score += g.enemies[e].kind ? 25 : 10;
                        break;
                    }
                }
                if (!g.enemies[e].alive) continue;

                if (overlaps(g.ship_x, g.ship_y, SHIP_W, SHIP_H,
                             g.enemies[e].x, g.enemies[e].y, ENEMY_W, ENEMY_H)) {
                    g.enemies[e].alive = 0;
                    if (--g.lives <= 0) { hiscore_save(api); g.state = ST_OVER; }
                    else { g.ship_x = SCR_W / 2 - SHIP_W / 2; g.ship_y = SCR_H - 34; }
                }
            }
            g.frames++;
        }
        prev = pad.buttons;

        /* ---- draw ---- */
        api->clear(COL_SPACE);
        draw_starfield(api);

        if (g.state == ST_TITLE) {
            draw_text(api, GAME_TITLE, 96, 84, 4, COL_HUD);
            draw_text(api, "PRESS START", 104, 140, 2, COL_STAR);
            if (g.hiscore) {
                draw_text(api, "HI", 128, 168, 2, COL_STAR);
                draw_num(api, g.hiscore, 152, 168, 2, COL_WARN);
            }
            api->sprite(sh, 0, 0, SHIP_W, SHIP_H, SCR_W / 2 - 8, 190, 0);
        } else {
            for (int e = 0; e < MAX_ENEMIES; e++)
                if (g.enemies[e].alive)
                    api->sprite(sh, g.enemies[e].kind ? 32 : 16, 0, ENEMY_W, ENEMY_H,
                                (int)g.enemies[e].x, (int)g.enemies[e].y, 0);
            for (int b = 0; b < MAX_BULLETS; b++)
                if (g.bullets[b].alive)
                    api->sprite(sh, 48, 0, 8, 16, (int)g.bullets[b].x - 2, (int)g.bullets[b].y, 0);
            if (g.state == ST_PLAY)
                api->sprite(sh, 0, 0, SHIP_W, SHIP_H, (int)g.ship_x, (int)g.ship_y, 0);

            draw_num(api, g.score, 8, 8, 2, COL_HUD);
            for (int l = 0; l < g.lives; l++) api->rect(SCR_W - 16 - l * 12, 9, 8, 8, COL_WARN);

            if (g.state == ST_OVER) {
                api->rect(56, 92, 208, 56, RGB(0x10, 0x12, 0x1C));
                draw_text(api, "GAME OVER", 92, 104, 3, COL_HUD);
                draw_num(api, g.score, 132, 128, 2, COL_WARN);
            }
        }

        api->present();

        if ((pad.buttons & S32_PAD_START) && (pad.buttons & S32_PAD_SELECT)) api->exit();
    }
}
