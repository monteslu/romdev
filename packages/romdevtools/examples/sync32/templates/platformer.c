/* ── platformer.c — sync32 side-scrolling platformer (complete example game) ──────────────
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
#define GAME_TITLE "SKYHOP"

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

#define IDX_BODY  1
#define IDX_SHOE  2
#define IDX_TRIM  3
#define IDX_BRICK 4
#define IDX_COIN  5
#define IDX_EDGE  6

#define COL_SKY   RGB(0x28, 0x50, 0x8A)
#define COL_HILL  RGB(0x1C, 0x3A, 0x64)
#define COL_HUD   RGB(0xF2, 0xF6, 0xFF)
#define COL_WARN  RGB(0xFF, 0x9A, 0x3B)
#define COL_GND   RGB(0x2A, 0x1E, 0x18)

/* ── GAME LOGIC (clay) ─────────────────────────────────────────────────────
 * Side-scrolling platformer: gravity, a jump arc, tile collision, a camera
 * that follows the player, and coins to collect. Fork this for anything with
 * a world + camera: an RPG overworld, a metroidvania, a beat-em-up. */
#define TILE 16
#define MAP_W 96
#define MAP_H 15
#define GRAVITY 0.42f
#define JUMP_V -7.4f
#define RUN_A 0.55f
#define RUN_MAX 3.2f
#define FRICTION 0.80f

typedef enum { ST_TITLE = 0, ST_PLAY = 1, ST_OVER = 2 } state_t;

static struct {
    state_t  state;
    uint32_t score, hiscore, frames;
    int      lives;
    float    x, y, vx, vy;
    int      on_ground, face;
    float    cam;
    uint8_t  map[MAP_H][MAP_W];   /* 0 empty, 1 brick, 2 coin */
} g;

#define SHEET_W 64
#define SHEET_H 16
static uint8_t sheet[SHEET_W * SHEET_H];

static void build_sheet(void) {
    for (int i = 0; i < SHEET_W * SHEET_H; i++) sheet[i] = IDX_TRANSPARENT;
    /* cell 0: the runner */
    for (int y = 2; y < 11; y++) for (int x = 5; x < 11; x++) sheet[y * SHEET_W + x] = IDX_BODY;
    for (int y = 3; y < 6; y++)  for (int x = 6; x < 10; x++) sheet[y * SHEET_W + x] = IDX_TRIM;
    for (int y = 11; y < 15; y++) { sheet[y * SHEET_W + 4] = IDX_SHOE; sheet[y * SHEET_W + 11] = IDX_SHOE; }
    /* cell 1 (x=16): brick */
    for (int y = 0; y < TILE; y++) for (int x = 16; x < 32; x++) {
        int edge = (y == 0 || y == TILE - 1 || x == 16 || x == 31);
        sheet[y * SHEET_W + x] = edge ? IDX_EDGE : IDX_BRICK;
    }
    /* cell 2 (x=32): coin */
    for (int y = 3; y < 13; y++) {
        int half = (y < 8) ? (y - 2) : (12 - y);
        for (int x = 40 - half; x <= 40 + half; x++) sheet[y * SHEET_W + x] = IDX_COIN;
    }
}

static void build_palette(const sync32_api_t *api) {
    static uint16_t pal[256];
    for (int i = 0; i < 256; i++) pal[i] = 0;
    pal[IDX_TRANSPARENT] = 0xF81F;
    pal[IDX_BODY]  = RGB(0xE8, 0x5A, 0x3B);
    pal[IDX_SHOE]  = RGB(0x28, 0x2E, 0x3C);
    pal[IDX_TRIM]  = RGB(0xFF, 0xE0, 0xC0);
    pal[IDX_BRICK] = RGB(0x9A, 0x5A, 0x38);
    pal[IDX_COIN]  = RGB(0xFF, 0xD1, 0x3B);
    pal[IDX_EDGE]  = RGB(0x5A, 0x34, 0x20);
    /* Colours the game DRAWS WITH must be IN the palette — rect()/clear()
     * snap to the nearest entry, so an unregistered colour renders as
     * something else entirely. */
    pal[8] = COL_SKY;
    pal[9] = COL_HILL;
    pal[10] = COL_HUD;
    pal[11] = COL_WARN;
    pal[12] = COL_GND;
    api->palette_set(pal);
}

static void build_map(const sync32_api_t *api) {
    for (int r = 0; r < MAP_H; r++) for (int c = 0; c < MAP_W; c++) g.map[r][c] = 0;
    /* floor, with gaps you have to jump */
    for (int c = 0; c < MAP_W; c++) {
        int gap = (c > 12) && ((c % 17) == 0 || (c % 17) == 1);
        if (!gap) { g.map[MAP_H - 1][c] = 1; g.map[MAP_H - 2][c] = 1; }
    }
    /* platforms + coins */
    for (int c = 6; c < MAP_W - 4; c += 7) {
        int h = 4 + (int)(api->rng_next() % 5);
        int w = 2 + (int)(api->rng_next() % 4);
        for (int k = 0; k < w && c + k < MAP_W; k++) {
            g.map[MAP_H - 2 - h][c + k] = 1;
            if ((api->rng_next() & 1)) g.map[MAP_H - 3 - h][c + k] = 2;
        }
    }
}

static int solid(int c, int r) {
    if (c < 0 || c >= MAP_W || r < 0) return 0;
    if (r >= MAP_H) return 0;
    return g.map[r][c] == 1;
}

static void reset_run(const sync32_api_t *api) {
    g.score = 0; g.lives = 3; g.frames = 0;
    g.x = 32; g.y = (float)((MAP_H - 3) * TILE);
    g.vx = g.vy = 0; g.on_ground = 0; g.face = 1; g.cam = 0;
    build_map(api);
}

static void respawn(const sync32_api_t *api) {
    if (--g.lives <= 0) { hiscore_save(api, g.score, &g.hiscore); g.state = ST_OVER; return; }
    g.x = 32; g.y = (float)((MAP_H - 3) * TILE); g.vx = g.vy = 0;
}

void game_main(const sync32_api_t *api) {
    build_palette(api);
    build_sheet();
    int sh = api->sheet_load(sheet, SHEET_W, SHEET_H);
    api->rng_seed(0xC0FFEEull);
    hiscore_load(api, &g.hiscore);
    reset_run(api);
    g.state = ST_TITLE;

    uint16_t prev = 0;
    for (;;) {
        s32_pad_t pad;
        api->pad(0, &pad);
        uint16_t pressed = (uint16_t)(pad.buttons & ~prev);

        if (g.state != ST_PLAY) {
            if (pressed & (S32_PAD_START | S32_PAD_A)) { reset_run(api); g.state = ST_PLAY; }
        } else {
            /* ---- HARDWARE-INDEPENDENT physics: float maths is cheap here ---- */
            if (pad.buttons & S32_PAD_LEFT)  { g.vx -= RUN_A; g.face = -1; }
            if (pad.buttons & S32_PAD_RIGHT) { g.vx += RUN_A; g.face =  1; }
            if (!(pad.buttons & (S32_PAD_LEFT | S32_PAD_RIGHT))) g.vx *= FRICTION;
            if (g.vx >  RUN_MAX) g.vx =  RUN_MAX;
            if (g.vx < -RUN_MAX) g.vx = -RUN_MAX;

            if ((pressed & S32_PAD_A) && g.on_ground) { g.vy = JUMP_V; g.on_ground = 0; }
            g.vy += GRAVITY;
            if (g.vy > 9.0f) g.vy = 9.0f;

            /* horizontal sweep, then vertical — the classic order that stops
             * a fast fall from tunnelling through a floor tile */
            g.x += g.vx;
            {
                int r0 = (int)(g.y) / TILE, r1 = (int)(g.y + TILE - 1) / TILE;
                int c  = (g.vx > 0) ? (int)(g.x + TILE - 1) / TILE : (int)g.x / TILE;
                for (int r = r0; r <= r1; r++) if (solid(c, r)) {
                    g.x = (g.vx > 0) ? (float)(c * TILE - TILE) : (float)((c + 1) * TILE);
                    g.vx = 0; break;
                }
            }
            g.y += g.vy;
            g.on_ground = 0;
            {
                int c0 = (int)(g.x) / TILE, c1 = (int)(g.x + TILE - 1) / TILE;
                int r  = (g.vy > 0) ? (int)(g.y + TILE - 1) / TILE : (int)g.y / TILE;
                for (int c = c0; c <= c1; c++) if (solid(c, r)) {
                    if (g.vy > 0) { g.y = (float)(r * TILE - TILE); g.on_ground = 1; }
                    else g.y = (float)((r + 1) * TILE);
                    g.vy = 0; break;
                }
            }

            /* coins */
            {
                int c = (int)(g.x + TILE / 2) / TILE, r = (int)(g.y + TILE / 2) / TILE;
                if (c >= 0 && c < MAP_W && r >= 0 && r < MAP_H && g.map[r][c] == 2) {
                    g.map[r][c] = 0; g.score += 50;
                }
            }

            if (g.x < 0) { g.x = 0; g.vx = 0; }
            if (g.x > (MAP_W - 1) * TILE) { g.x = (float)((MAP_W - 1) * TILE); g.vx = 0; }
            if (g.y > (MAP_H + 2) * TILE) respawn(api);      /* fell in a gap */

            /* camera follows, clamped to the world */
            g.cam = g.x - SCR_W / 2.0f;
            if (g.cam < 0) g.cam = 0;
            if (g.cam > (float)(MAP_W * TILE - SCR_W)) g.cam = (float)(MAP_W * TILE - SCR_W);
            g.frames++;
        }
        prev = pad.buttons;

        /* ---- draw ---- */
        api->clear(COL_SKY);
        for (int i = 0; i < 6; i++) {                        /* parallax hills */
            int hx = (int)(i * 90 - (int)(g.cam * 0.35f) % 540);
            api->rect(hx, 150, 70, 90, COL_HILL);
        }
        api->rect(0, SCR_H - 8, SCR_W, 8, COL_GND);

        int c0 = (int)g.cam / TILE, c1 = c0 + SCR_W / TILE + 1;
        for (int r = 0; r < MAP_H; r++) {
            for (int c = c0; c <= c1 && c < MAP_W; c++) {
                if (!g.map[r][c]) continue;
                int sx = (g.map[r][c] == 1) ? 16 : 32;
                api->sprite(sh, sx, 0, TILE, TILE, c * TILE - (int)g.cam, r * TILE, 0);
            }
        }
        if (g.state == ST_PLAY)
            api->sprite(sh, 0, 0, TILE, TILE, (int)(g.x - g.cam), (int)g.y,
                        g.face < 0 ? S32_SPRITE_FLIP_X : 0);

        draw_num(api, g.score, 8, 6, 2, COL_HUD);
        for (int l = 0; l < g.lives; l++) api->rect(SCR_W - 16 - l * 12, 8, 8, 8, COL_WARN);

        if (g.state == ST_TITLE) {
            api->rect(36, 84, 248, 62, COL_HILL);
            draw_text(api, GAME_TITLE, 64, 92, 3, COL_HUD);
            draw_text(api, "PRESS START", 96, 124, 2, COL_HUD);
        } else if (g.state == ST_OVER) {
            api->rect(48, 92, 224, 56, COL_HILL);
            draw_text(api, "GAME OVER", 84, 104, 3, COL_HUD);
            draw_num(api, g.score, 132, 128, 2, COL_WARN);
        }

        api->present();
        if ((pad.buttons & S32_PAD_START) && (pad.buttons & S32_PAD_SELECT)) api->exit();
    }
}
