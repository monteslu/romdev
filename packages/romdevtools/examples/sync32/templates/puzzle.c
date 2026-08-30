/* ── puzzle.c — sync32 match-4 gravity puzzle (complete example game) ──────────────
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
#define GAME_TITLE "CASCADE"

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

#define IDX_BLOCK_A 1
#define IDX_BLOCK_B 2
#define IDX_BLOCK_C 3
#define IDX_BLOCK_D 4
#define IDX_EDGE    5
#define IDX_HILITE  6

#define COL_BG    RGB(0x0E, 0x10, 0x18)
#define COL_GRID  RGB(0x1E, 0x22, 0x30)
#define COL_HUD   RGB(0xE8, 0xEE, 0xF8)
#define COL_WARN  RGB(0xFF, 0x8A, 0x3B)

/* ── GAME LOGIC (clay) ─────────────────────────────────────────────────────
 * A match-4 gravity puzzle: pieces fall down a grid, land, and any run of 4+
 * in a row or column clears and cascades. Fork this for anything grid+state:
 * an RPG map, a board game, a tactics grid. */
#define COLS 10
#define ROWS 14
#define CELL 16
#define GRID_X ((SCR_W - COLS * CELL) / 2)
#define GRID_Y 24
#define KINDS 4
#define MATCH_RUN 4

typedef enum { ST_TITLE = 0, ST_PLAY = 1, ST_OVER = 2 } state_t;

static struct {
    state_t  state;
    uint32_t score, hiscore, frames;
    uint8_t  grid[ROWS][COLS];      /* 0 = empty, else 1..KINDS */
    int      px, py, pkind;         /* the falling piece */
    int      fall_timer, fall_rate, chain;
} g;

#define SHEET_W 64
#define SHEET_H 16
static uint8_t sheet[SHEET_W * SHEET_H];

static void build_sheet(void) {
    for (int i = 0; i < SHEET_W * SHEET_H; i++) sheet[i] = IDX_TRANSPARENT;
    /* Four 16x16 faces, each a bevelled block. Cell n starts at x = n*16, so
     * every pixel below stays inside its own cell (see trap 2 up top). */
    for (int k = 0; k < KINDS; k++) {
        int ox = k * CELL;
        uint8_t face = (uint8_t)(IDX_BLOCK_A + k);
        for (int y = 0; y < CELL; y++) {
            for (int x = 0; x < CELL; x++) {
                int edge = (x == 0 || y == 0 || x == CELL - 1 || y == CELL - 1);
                int lit  = (x + y < 6);
                sheet[y * SHEET_W + ox + x] = edge ? IDX_EDGE : (lit ? IDX_HILITE : face);
            }
        }
    }
}

static void build_palette(const sync32_api_t *api) {
    static uint16_t pal[256];
    for (int i = 0; i < 256; i++) pal[i] = 0;
    pal[IDX_TRANSPARENT] = 0xF81F;
    pal[IDX_BLOCK_A] = RGB(0xE0, 0x3B, 0x4B);
    pal[IDX_BLOCK_B] = RGB(0x3B, 0xC7, 0x6E);
    pal[IDX_BLOCK_C] = RGB(0x3B, 0x8B, 0xE0);
    pal[IDX_BLOCK_D] = RGB(0xF2, 0xC2, 0x38);
    pal[IDX_EDGE]    = RGB(0x2A, 0x30, 0x40);
    pal[IDX_HILITE]  = RGB(0xFF, 0xFF, 0xFF);
    /* Colours the game DRAWS WITH must be IN the palette — rect()/clear()
     * snap to the nearest entry, so an unregistered colour renders as
     * something else entirely. */
    pal[8] = COL_BG;
    pal[9] = COL_GRID;
    pal[10] = COL_HUD;
    pal[11] = COL_WARN;
    api->palette_set(pal);
}

static void new_piece(const sync32_api_t *api) {
    g.px = COLS / 2;
    g.py = 0;
    g.pkind = 1 + (int)(api->rng_next() % KINDS);
    if (g.grid[0][g.px]) { hiscore_save(api, g.score, &g.hiscore); g.state = ST_OVER; }
}

static void reset_game(const sync32_api_t *api) {
    for (int r = 0; r < ROWS; r++) for (int c = 0; c < COLS; c++) g.grid[r][c] = 0;
    g.score = 0; g.frames = 0; g.chain = 0;
    g.fall_rate = 26; g.fall_timer = g.fall_rate;
    new_piece(api);
}

/* Clear every run of MATCH_RUN+ horizontally and vertically. Returns how many
 * cells were removed, so the caller can score the cascade. */
static int clear_matches(void) {
    static uint8_t mark[ROWS][COLS];
    for (int r = 0; r < ROWS; r++) for (int c = 0; c < COLS; c++) mark[r][c] = 0;
    int hits = 0;

    for (int r = 0; r < ROWS; r++) {
        int run = 1;
        for (int c = 1; c <= COLS; c++) {
            int same = (c < COLS) && g.grid[r][c] && g.grid[r][c] == g.grid[r][c - 1];
            if (same) run++;
            else {
                if (run >= MATCH_RUN) for (int k = 0; k < run; k++) mark[r][c - 1 - k] = 1;
                run = 1;
            }
        }
    }
    for (int c = 0; c < COLS; c++) {
        int run = 1;
        for (int r = 1; r <= ROWS; r++) {
            int same = (r < ROWS) && g.grid[r][c] && g.grid[r][c] == g.grid[r - 1][c];
            if (same) run++;
            else {
                if (run >= MATCH_RUN) for (int k = 0; k < run; k++) mark[r - 1 - k][c] = 1;
                run = 1;
            }
        }
    }
    for (int r = 0; r < ROWS; r++) for (int c = 0; c < COLS; c++)
        if (mark[r][c]) { g.grid[r][c] = 0; hits++; }
    return hits;
}

/* Gravity: let everything fall into the holes a clear left behind. */
static int settle(void) {
    int moved = 0;
    for (int c = 0; c < COLS; c++) {
        int write = ROWS - 1;
        for (int r = ROWS - 1; r >= 0; r--) {
            if (g.grid[r][c]) {
                if (write != r) { g.grid[write][c] = g.grid[r][c]; g.grid[r][c] = 0; moved = 1; }
                write--;
            }
        }
    }
    return moved;
}

static void lock_piece(const sync32_api_t *api) {
    g.grid[g.py][g.px] = (uint8_t)g.pkind;
    g.chain = 0;
    for (;;) {
        int hits = clear_matches();
        if (!hits) break;
        g.chain++;
        g.score += (uint32_t)(hits * 10 * g.chain);   /* cascades pay more */
        while (settle()) { }
    }
    if (g.fall_rate > 8 && g.score > 0 && (g.score / 300) > (uint32_t)(26 - g.fall_rate))
        g.fall_rate--;
    new_piece(api);
}

static int blocked(int c, int r) { return c < 0 || c >= COLS || r >= ROWS || (r >= 0 && g.grid[r][c]); }

void game_main(const sync32_api_t *api) {
    build_palette(api);
    build_sheet();
    int sh = api->sheet_load(sheet, SHEET_W, SHEET_H);
    api->rng_seed(0x9E3779B9ull);
    hiscore_load(api, &g.hiscore);
    reset_game(api);
    g.state = ST_TITLE;

    uint16_t prev = 0;
    for (;;) {
        s32_pad_t pad;
        api->pad(0, &pad);
        uint16_t pressed = (uint16_t)(pad.buttons & ~prev);

        if (g.state != ST_PLAY) {
            if (pressed & (S32_PAD_START | S32_PAD_A)) { reset_game(api); g.state = ST_PLAY; }
        } else {
            if ((pressed & S32_PAD_LEFT)  && !blocked(g.px - 1, g.py)) g.px--;
            if ((pressed & S32_PAD_RIGHT) && !blocked(g.px + 1, g.py)) g.px++;
            if (pressed & S32_PAD_A) g.pkind = 1 + (g.pkind % KINDS);   /* cycle colour */

            int drop = (pad.buttons & S32_PAD_DOWN) ? 4 : 1;
            g.fall_timer -= drop;
            if (g.fall_timer <= 0) {
                g.fall_timer = g.fall_rate;
                if (blocked(g.px, g.py + 1)) lock_piece(api);
                else g.py++;
            }
            g.frames++;
        }
        prev = pad.buttons;

        /* ---- draw ---- */
        api->clear(COL_BG);
        for (int c = 0; c <= COLS; c++) api->rect(GRID_X + c * CELL, GRID_Y, 1, ROWS * CELL, COL_GRID);
        for (int r = 0; r <= ROWS; r++) api->rect(GRID_X, GRID_Y + r * CELL, COLS * CELL, 1, COL_GRID);

        for (int r = 0; r < ROWS; r++)
            for (int c = 0; c < COLS; c++)
                if (g.grid[r][c])
                    api->sprite(sh, (g.grid[r][c] - 1) * CELL, 0, CELL, CELL,
                                GRID_X + c * CELL, GRID_Y + r * CELL, 0);

        if (g.state == ST_PLAY)
            api->sprite(sh, (g.pkind - 1) * CELL, 0, CELL, CELL,
                        GRID_X + g.px * CELL, GRID_Y + g.py * CELL, 0);

        draw_num(api, g.score, 8, 6, 2, COL_HUD);
        if (g.hiscore) draw_num(api, g.hiscore, SCR_W - 72, 6, 2, COL_WARN);

        if (g.state == ST_TITLE) {
            api->rect(40, 88, 240, 60, COL_BG);
            draw_text(api, GAME_TITLE, 72, 96, 3, COL_HUD);
            draw_text(api, "PRESS START", 96, 126, 2, COL_GRID);
        } else if (g.state == ST_OVER) {
            api->rect(48, 92, 224, 56, COL_BG);
            draw_text(api, "GAME OVER", 84, 104, 3, COL_HUD);
            draw_num(api, g.score, 132, 128, 2, COL_WARN);
        }

        api->present();
        if ((pad.buttons & S32_PAD_START) && (pad.buttons & S32_PAD_SELECT)) api->exit();
    }
}
