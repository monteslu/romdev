/* ── puzzle.c — Game Boy match-3 falling-block scaffold ─────────────
 *
 * 8-wide × 14-tall well drawn via BG tilemap (each cell = 1 BG tile).
 * 1×3 vertical active piece; LEFT/RIGHT shifts, A/B cycles the colour
 * order, DOWN soft-drops, START hard-drops. Matches of 3+ in a row —
 * horizontal, vertical, or either diagonal — clear, survivors fall
 * (gravity), and cascades chain with rising score.
 *
 * On DMG we differentiate the three block kinds by SHAPE (2bpp stripe
 * patterns), not colour. The GBC template is the full-colour version.
 *
 * RENDERING CONTRACT (the "pieces flash / don't render" fix): this
 * core silently DROPS VRAM writes during active display — and can
 * even drop one early in vblank. So (mirroring the GBC reference
 * puzzle):
 *  - The FALLING piece is OAM sprites 0-2 (one OAM DMA per frame —
 *    no BG writes at all to move it, no erase artifacts).
 *  - The LOCKED well is BG tiles, written ONLY right after
 *    wait_vblank(): a budgeted diff (grid vs shadow) plus a rolling
 *    SCRUB that continuously repaints the well from grid[], so any
 *    dropped write self-heals within ~half a second.
 *  - enable_vblank_irq() at boot → wait_vblank HALTs to the real
 *    vblank leading edge (also ~30x faster on the WASM core than
 *    the LY-polling fallback).
 */

#include "gb_hardware.h"
#include "gb_runtime.h"

#define COLS 8
#define ROWS 14

#define T_BLANK 0
#define T_R     1
#define T_G     2
#define T_B     3
#define T_WALL  4

/* Map placement: centre the 8-col well → BG col offset +6, row offset +1. */
#define WELL_MX 6
#define WELL_MY 1

/* tile_blank is the EMPTY-cell / backdrop tile. It is NOT all-zero: a
 * subtle dither (colour 0 + faint colour 1) so the empty playfield and the
 * area around the well read as a textured surface, never one flat colour
 * (the #1 GB "why is it blank" footgun). Locked blocks / the active piece
 * overdraw it with the R/G/B shape tiles. */
static const uint8_t tile_blank[16] = {
    0x00,0x00, 0x22,0x00, 0x00,0x00, 0x88,0x00,
    0x00,0x00, 0x22,0x00, 0x00,0x00, 0x88,0x00,
};
/* Well frame: a solid colour-2 border drawn around the play area. */
static const uint8_t tile_wall[16] = {
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
};
/* Three distinct tile shapes (since GB BG is 2bpp, we differentiate
 * by *shape*, not colour-on-CGB). */
static const uint8_t tile_r[16] = {
    0xFF,0x00, 0xFF,0x00, 0xFF,0x00, 0xFF,0x00,
    0xFF,0x00, 0xFF,0x00, 0xFF,0x00, 0xFF,0x00,
};
static const uint8_t tile_g[16] = {
    0xAA,0x55, 0xAA,0x55, 0xAA,0x55, 0xAA,0x55,
    0xAA,0x55, 0xAA,0x55, 0xAA,0x55, 0xAA,0x55,
};
static const uint8_t tile_b[16] = {
    0x00,0xFF, 0x00,0xFF, 0x00,0xFF, 0x00,0xFF,
    0x00,0xFF, 0x00,0xFF, 0x00,0xFF, 0x00,0xFF,
};

static const uint16_t bg_palette[4]  = { 0x7FFF, 0x5294, 0x294A, 0x0000 };

#define NCELL (ROWS * COLS)
static uint8_t grid[NCELL];     /* 0 = empty, 1..3 = block colour */
static uint8_t shadow[NCELL];   /* what's currently on the BG (diff redraw) */
static uint8_t matched[NCELL];  /* scratch: cells flagged to clear */
static uint8_t piece[3];
static int16_t piece_x, piece_y;
static uint8_t fall_timer;
static uint16_t score;
static uint16_t rng = 0xACE1;

#define G(r,c) grid[(uint8_t)((r) * COLS + (c))]
#define M(r,c) matched[(uint8_t)((r) * COLS + (c))]

/* the 4 line directions scanned for matches: horizontal, vertical, and
 * both diagonals; each line is only walked from its lowest cell. */
static const int8_t DIRS[4][2] = { {0,1}, {1,0}, {1,1}, {1,-1} };

/* 16-bit xorshift — kept 16-bit on purpose (sm83 has no fast 32-bit
 * shifts; a wider generator there degenerates toward one value). */
static uint8_t xorshift(void) {
    rng ^= rng << 7;
    rng ^= rng >> 9;
    rng ^= rng << 8;
    return (uint8_t)(rng >> 8);
}

static uint8_t random_colour(void) { return 1 + (xorshift() % 3); }

static void new_piece(void) {
    piece[0] = random_colour();
    piece[1] = random_colour();
    piece[2] = random_colour();
    piece_x = COLS / 2 - 1;
    piece_y = -3;
}

static uint8_t tile_for(uint8_t c) {
    switch (c) {
        case 1: return T_R;
        case 2: return T_G;
        case 3: return T_B;
        default: return T_BLANK;
    }
}

static uint8_t collides(int16_t col, int16_t row) {
    uint8_t i;
    int16_t r;
    if (col < 0 || col >= COLS) return 1;
    for (i = 0; i < 3; i++) {
        r = row + i;
        if (r >= ROWS) return 1;
        if (r >= 0 && G(r, col) != 0) return 1;
    }
    return 0;
}

/* ── match / clear / gravity core (mirrors the GBC reference) ─────── */

/* Flag every cell in a 3+ run (any of the 4 directions) into matched[];
 * return the count. A run is walked once, from its lowest end only. */
static uint8_t mark_and_count(void) {
    uint8_t r, c, d, len, cnt, col, k;
    int8_t dr, dc;
    int16_t sr, sc;

    for (r = 0; r < NCELL; r++) matched[r] = 0;

    for (r = 0; r < ROWS; r++) {
        for (c = 0; c < COLS; c++) {
            col = G(r, c);
            if (col == 0) continue;
            for (d = 0; d < 4; d++) {
                dr = DIRS[d][0];
                dc = DIRS[d][1];
                sr = (int16_t)r - dr;
                sc = (int16_t)c - dc;
                if (sr >= 0 && sr < ROWS && sc >= 0 && sc < COLS
                    && G(sr, sc) == col) continue;   /* not the run's start */
                len = 1;
                sr = (int16_t)r + dr;
                sc = (int16_t)c + dc;
                while (sr >= 0 && sr < ROWS && sc >= 0 && sc < COLS
                       && G(sr, sc) == col) {
                    len++;
                    sr += dr;
                    sc += dc;
                }
                if (len >= 3) {
                    sr = (int16_t)r;
                    sc = (int16_t)c;
                    for (k = 0; k < len; k++) {
                        M(sr, sc) = 1;
                        sr += dr;
                        sc += dc;
                    }
                }
            }
        }
    }

    cnt = 0;
    for (r = 0; r < NCELL; r++) if (matched[r]) cnt++;
    return cnt;
}

static void clear_marked(void) {
    uint8_t i;
    for (i = 0; i < NCELL; i++) if (matched[i]) grid[i] = 0;
}

/* collapse each column so survivors rest on the floor — the "rows move
 * down after a clear" the old template was missing. */
static void apply_gravity(void) {
    uint8_t c, r, n, w;
    uint8_t buf[ROWS];
    for (c = 0; c < COLS; c++) {
        n = 0;
        for (r = 0; r < ROWS; r++)
            if (G(r, c)) { buf[n] = G(r, c); n++; }
        for (r = 0; r < (uint8_t)(ROWS - n); r++) G(r, c) = 0;
        w = 0;
        for (r = (uint8_t)(ROWS - n); r < ROWS; r++) { G(r, c) = buf[w]; w++; }
    }
}

/* clear chime — one short square blip per cascade step, pitch rises with
 * the chain so combos audibly escalate. */
static void sfx_clear(uint8_t chain) {
    uint16_t p = 1797 + (uint16_t)chain * 26;   /* ~C5 rising */
    if (p > 1980) p = 1980;
    sound_play_tone(1, p, 6);
}

/* settle the board after a lock: match → clear → gravity, looping so
 * cascades chain; score scales with the chain depth. */
static void resolve_board(void) {
    uint8_t n, chain = 0;
    uint16_t amt;
    while (1) {
        n = mark_and_count();
        if (n == 0) break;
        chain++;
        sfx_clear(chain);
        clear_marked();
        amt = (uint16_t)n * 10;
        if (chain > 1) amt = amt * chain;
        if (score < (uint16_t)(65500u - amt)) score += amt;
        apply_gravity();
    }
}

static void lock_piece(void) {
    uint8_t i, written = 0;
    int16_t r;
    for (i = 0; i < 3; i++) {
        r = piece_y + i;
        if (r >= 0 && r < ROWS) { G(r, piece_x) = piece[i]; written++; }
    }
    sound_play_noise(3);
    resolve_board();
    if (written == 0) {
        /* The piece locked entirely ABOVE the well — the stack reached the
         * top. Without this the game silently softlocks (invisible pieces
         * locking off-screen forever). Scaffold behavior: low game-over
         * tone, clear the board, restart the run. */
        sound_play_tone(1, 1548, 30);
        for (i = 0; i < NCELL; i++) grid[i] = 0;
        score = 0;
    }
}

/* ── rendering (vblank-budgeted; gameplay code never touches VRAM) ── */

static void upload_tile(uint8_t slot, const uint8_t *src) {
    uint8_t *dst = (uint8_t *)(0x8000 + slot * 16);
    /* memcpy_vram (pointer-walk) — NOT an indexed dst[i]=src[i] loop, which
     * SDCC sm83 miscompiles when dst points into VRAM ($8000-$9FFF). */
    memcpy_vram(dst, src, 16);
}

#define VRAM_MAP ((volatile uint8_t *)0x9800)

/* Direct cell write — ONLY safe with the LCD off or just after vblank. */
static void set_cell(uint8_t c, uint8_t r, uint8_t tile) {
    VRAM_MAP[(uint16_t)(WELL_MY + r) * 32 + WELL_MX + c] = tile;
}

/* COLLECT/FLUSH split (the reference puzzle's architecture, and the part
 * that actually fixes "pieces flash / don't render"):
 *  - collect_well() runs OUTSIDE vblank: scans for grid-vs-shadow diffs
 *    (bounded), or queues rolling SCRUB cells when nothing changed, into a
 *    tiny queue of precomputed (map offset, tile) pairs. RAM only.
 *  - flush_well() runs FIRST thing after wait_vblank: pure pointer writes,
 *    no scanning, no multiplies — the whole batch lands inside the ~10-line
 *    vblank window every frame. The scrub means even a write the core drops
 *    anyway heals itself on the next pass instead of sticking forever. */
#define WQ_MAX 4
static uint8_t  wq_n;
static uint16_t wq_off[WQ_MAX];
static uint8_t  wq_tile[WQ_MAX];
static uint8_t diff_cursor, scrub_cursor;

static uint16_t cell_off(uint8_t i) {
    return (uint16_t)(WELL_MY + i / COLS) * 32 + WELL_MX + (i % COLS);
}

static void collect_well(void) {
    uint8_t scanned = 0, i, k;
    wq_n = 0;
    i = diff_cursor;
    while (scanned < NCELL && wq_n < WQ_MAX) {
        if (grid[i] != shadow[i]) {
            shadow[i] = grid[i];
            wq_off[wq_n] = cell_off(i);
            wq_tile[wq_n] = tile_for(grid[i]);
            wq_n++;
        }
        i++;
        if (i >= NCELL) i = 0;
        scanned++;
    }
    diff_cursor = i;
    if (wq_n == 0) {
        /* idle: queue scrub cells so dropped writes self-heal */
        for (k = 0; k < 2; k++) {
            wq_off[wq_n] = cell_off(scrub_cursor);
            wq_tile[wq_n] = tile_for(grid[scrub_cursor]);
            wq_n++;
            scrub_cursor++;
            if (scrub_cursor >= NCELL) scrub_cursor = 0;
        }
    }
}

static void flush_well(void) {
    uint8_t k;
    for (k = 0; k < wq_n; k++) VRAM_MAP[wq_off[k]] = wq_tile[k];
    wq_n = 0;
}

/* The falling piece = OAM sprites 0-2 (written to shadow_oam, flushed by
 * one OAM DMA right after vblank starts). Rows above the well top (r < 0)
 * park the sprite at Y=0 (offscreen). */
static void update_piece_sprites(void) {
    uint8_t i, sy, sx;
    int16_t r;
    for (i = 0; i < 3; i++) {
        r = piece_y + i;
        if (r >= 0 && r < ROWS) {
            sy = (uint8_t)((WELL_MY + r) * 8 + 16);
            sx = (uint8_t)((WELL_MX + piece_x) * 8 + 8);
            oam_set(i, sy, sx, tile_for(piece[i]), 0);
        } else {
            oam_set(i, 0, 0, 0, 0);
        }
    }
}

static void draw_well_frame(void) {
    uint8_t r;
    for (r = 0; r < ROWS; r++) {
        VRAM_MAP[(uint16_t)(WELL_MY + r) * 32 + WELL_MX - 1]    = T_WALL;
        VRAM_MAP[(uint16_t)(WELL_MY + r) * 32 + WELL_MX + COLS] = T_WALL;
    }
    for (r = 0; r < (uint8_t)(COLS + 2); r++)
        VRAM_MAP[(uint16_t)(WELL_MY + ROWS) * 32 + WELL_MX - 1 + r] = T_WALL;
}

void main(void) {
    uint8_t pad, prev = 0, fall_rate, t, i;
    int16_t c;
    uint8_t *map;

    lcd_init_default();
    enable_vblank_irq();
    sound_init();
    oam_dma_init_hram();
    oam_clear();
    LCDC = 0;
    OBP0 = 0xE4;                 /* DMG sprite palette: 3=black .. 0=white */

    upload_tile(T_BLANK, tile_blank);
    upload_tile(T_R,     tile_r);
    upload_tile(T_G,     tile_g);
    upload_tile(T_B,     tile_b);
    upload_tile(T_WALL,  tile_wall);

    BCPS = 0x80;
    for (i = 0; i < 4; i++) {
        BCPD = (uint8_t)(bg_palette[i] & 0xFF);
        BCPD = (uint8_t)((bg_palette[i] >> 8) & 0xFF);
    }

    map = (uint8_t *)0x9800;
    for (i = 0; i < 32; i++) {
        c = 0;
        while (c < 32) { map[(uint16_t)i * 32 + c] = T_BLANK; c++; }
    }

    for (i = 0; i < NCELL; i++) { grid[i] = 0; shadow[i] = 0; }

    score = 0;
    fall_timer = 0;
    rng ^= DIV;                  /* a dash of boot-time entropy */
    new_piece();
    draw_well_frame();

    LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO;

    while (1) {
        pad = joypad_read();

        if ((pad & PAD_LEFT)  && !(prev & PAD_LEFT)
            && !collides(piece_x - 1, piece_y)) { piece_x--; sound_play_tone(1, 1899, 2); }
        if ((pad & PAD_RIGHT) && !(prev & PAD_RIGHT)
            && !collides(piece_x + 1, piece_y)) { piece_x++; sound_play_tone(1, 1899, 2); }
        if ((pad & PAD_A) && !(prev & PAD_A)) {
            t = piece[0]; piece[0] = piece[1]; piece[1] = piece[2]; piece[2] = t;
            sound_play_tone(1, 1923, 2);
        }
        if ((pad & PAD_B) && !(prev & PAD_B)) {
            t = piece[2]; piece[2] = piece[1]; piece[1] = piece[0]; piece[0] = t;
            sound_play_tone(1, 1923, 2);
        }
        if ((pad & PAD_START) && !(prev & PAD_START)) {
            while (!collides(piece_x, piece_y + 1)) piece_y++;
            lock_piece();
            new_piece();
        } else {
            fall_rate = (pad & PAD_DOWN) ? 4 : 30;
            if (++fall_timer >= fall_rate) {
                fall_timer = 0;
                if (collides(piece_x, piece_y + 1)) {
                    lock_piece();
                    new_piece();
                } else {
                    piece_y++;
                }
            }
        }
        prev = pad;

        /* COLLECT (RAM only, runs in active display) … */
        update_piece_sprites();
        collect_well();
        /* … then FLUSH right after vblank starts: OAM DMA first (sprites
         * tear if it slips out of vblank), then the queued BG writes. */
        wait_vblank();
        oam_dma_flush();
        flush_well();
    }
}
