/* PUZZLE — a falling-jewel matcher for Game Boy Color.
 *
 * A vertical column of 3 jewels falls into an 8-wide x 17-tall well.  Move it
 * left/right, soft-drop (Down), hard-drop (Start), and CYCLE the three colors
 * (A/B).  Line up 3+ of one color horizontally, vertically, or diagonally to
 * clear them; gravity pulls the survivors down, which can chain.  Every 18th
 * piece is a MAGIC jewel that clears every gem of the color it lands on.
 * SELECT toggles the background music.
 *
 * RENDERING — the hard-won architecture (details at each routine below):
 *  - The FALLING column and the NEXT preview are OBJ sprites (OAM), not BG
 *    tiles, so moving them is just an OAM rewrite — no per-frame BG writes.
 *  - The LOCKED well + HUD are BG tiles, updated through a COLLECT/FLUSH queue:
 *    redraw_collect() decides what to write (RAM only); redraw_flush() writes a
 *    few cells to VRAM as the very first thing in vblank.  The whole per-frame
 *    job (OAM DMA + flush) MUST finish inside the ~10-line vblank window —
 *    overrunning into active display silently DROPS writes on this core, which
 *    is exactly what made the screen disagree with the board.  An idle "scrub"
 *    continuously repaints the well from the grid so nothing can drift.
 *  - We NEVER toggle the LCD in-game (this core blanks the whole frame on any
 *    LCDC bit-7 toggle — a strobe).  LCD-off is used only for the full-screen
 *    title <-> game transitions.
 *
 * WRAM NOTE: build with dataLoc:0xC200 so our statics sit ABOVE shadow_oam
 * ($C100) — else oam_clear() would zero our state (RNG seed / grid).
 */
#include "gb_hardware.h"
#include "gb_runtime.h"
#include "font.h"

#define COLS      8
#define ROWS      17
#define NCELL     (ROWS * COLS)
#define NCOLORS   6          /* jewel colors 1..6 */

/* BG map cell of interior grid cell (0,0) — the well's top-left corner.
 * Open at the top (row 0); walls sit one cell outside on the left/right and
 * below the bottom (floor at WELL_MY+ROWS = row 17, the last screen row). */
#define WELL_MX   1
#define WELL_MY   0

/* BG map column where the HUD text starts (right of the well). */
#define HUD_X     12

#define G(r,c)    grid[((r) * COLS) + (c)]
#define M(r,c)    matched[((r) * COLS) + (c)]

#define T_EMPTY   0
#define T_GEM     1
#define T_WALL    2
#define T_BLANK   3
#define T_MAGIC   4
#define T_EXP0    5     /* explosion frames: gem bursting apart (its own color) */
#define T_EXP1    6
#define T_EXP2    7
#define FONT_BASE 16

#define MAGIC     7

#define PAL_WELL  6
#define PAL_OUT   7

#define ST_PLAY   0
#define ST_OVER   1
#define ST_TITLE  2

#define VRAM ((volatile uint8_t *)0x9800)

/* ── tile pixel data (2bpp) ────────────────────────────────────────── */
static const uint8_t tile_empty[16] = {
    0x00,0x00, 0x22,0x00, 0x00,0x00, 0x88,0x00,
    0x00,0x00, 0x22,0x00, 0x00,0x00, 0x88,0x00,
};
static const uint8_t tile_gem[16] = {
    0x00,0x3C, 0x30,0x4E, 0x60,0x9F, 0x40,0xBF,
    0x02,0xFF, 0x06,0xFF, 0x1C,0x7E, 0x00,0x3C,
};
static const uint8_t tile_wall[16] = {
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
};
static const uint8_t tile_blank[16] = { 0 };
static const uint8_t tile_magic[16] = {
    0x18,0x18, 0x3C,0x3C, 0x7E,0x7E, 0xFF,0xFF,
    0x7E,0x7E, 0x3C,0x3C, 0x18,0x18, 0x00,0x00,
};
/* explosion frames (value 2, drawn in the gem's own colour so they blend with
 * the well — value 0 = C_WELL).  The gem bursts into a star, fragments fly
 * outward, then sparks, then gone.  Shown ONCE, expanding — no blinking. */
static const uint8_t tile_exp0[16] = {
    0x00,0x99, 0x00,0x5A, 0x00,0x3C, 0x00,0xFF,
    0x00,0xFF, 0x00,0x3C, 0x00,0x5A, 0x00,0x99,
};
static const uint8_t tile_exp1[16] = {
    0x00,0x81, 0x00,0x42, 0x00,0x24, 0x00,0x18,
    0x00,0x18, 0x00,0x24, 0x00,0x42, 0x00,0x81,
};
static const uint8_t tile_exp2[16] = {
    0x00,0x81, 0x00,0x00, 0x00,0x00, 0x00,0x00,
    0x00,0x00, 0x00,0x00, 0x00,0x00, 0x00,0x81,
};

/* ── palettes (15-bit BGR) ─────────────────────────────────────────── */
#define RGB(r,g,b) ((uint16_t)(((uint16_t)(b)<<10)|((uint16_t)(g)<<5)|(r)))
#define C_WELL  RGB(4,6,12)
#define C_OUT   RGB(1,2,4)
#define C_FAINT RGB(7,9,15)
#define C_FRAME RGB(16,20,28)

static const uint16_t palettes[8][4] = {
    /* 0 red    */ { C_WELL, RGB(31,16,16), RGB(31,3,3),   RGB(17,1,1) },
    /* 1 orange */ { C_WELL, RGB(31,24,12), RGB(31,16,2),  RGB(20,9,0) },
    /* 2 yellow */ { C_WELL, RGB(31,31,18), RGB(30,28,4),  RGB(22,18,0) },
    /* 3 green  */ { C_WELL, RGB(16,31,16), RGB(6,26,8),   RGB(1,16,4) },
    /* 4 blue   */ { C_WELL, RGB(14,22,31), RGB(5,12,31),  RGB(2,5,20) },
    /* 5 purple */ { C_WELL, RGB(28,16,31), RGB(20,5,30),  RGB(12,1,20) },
    /* 6 well   */ { C_WELL, C_FAINT,       RGB(8,11,18),  C_FRAME },
    /* 7 out/txt*/ { C_OUT,  RGB(2,3,7),    C_OUT,         RGB(31,31,31) },
};

/* ── game state ────────────────────────────────────────────────────── */
static uint8_t grid[NCELL];         /* the well: 0 = empty, 1..NCOLORS = a gem */
static uint8_t matched[NCELL];      /* scratch: cells flagged for clearing */
static uint8_t shadow[NCELL];       /* color currently on the BG, for diff redraw */
static uint8_t piece[3];            /* the 3 falling colors, top→bottom */
static uint8_t nextp[3];            /* the previewed next column */
static uint8_t piece_x, piece_y;    /* well coords of the falling column's top */
static uint8_t piece_active;        /* a column is currently falling */
static uint8_t piece_magic;         /* the falling column is a MAGIC piece */
static uint8_t next_dirty;          /* NEXT-preview sprites need re-writing */
static uint8_t piece_counter;       /* pieces since last magic (→ magic every 18) */
static uint8_t fall_timer;          /* frames since the column last stepped down */
static uint8_t cur_fall_rate;       /* frames per downward step (lower = faster) */
static uint16_t total_cleared;      /* gems cleared this game (drives level) */
static uint8_t level;
static uint8_t score_d[6];          /* 6-digit BCD score, most significant first */
static uint8_t state;               /* ST_PLAY / ST_OVER / ST_TITLE */
static uint8_t chain;               /* cascade depth of the current resolve */
static uint16_t rng = 0xACE1;       /* xorshift PRNG state */

/* the 4 line directions we scan for matches: horizontal, vertical, and the
 * two diagonals (we only walk each line once, from its lowest cell). */
static const int8_t DIRS[4][2] = { {0,1}, {1,0}, {1,1}, {1,-1} };

/* 16-bit xorshift PRNG — kept 16-bit on purpose (sm83 has no fast 32-bit
 * shifts; a wider generator there degenerates toward one value). */
static uint8_t xorshift(void) {
    rng ^= rng << 7;
    rng ^= rng >> 9;
    rng ^= rng << 8;
    return (uint8_t)(rng >> 8);
}

/* fill a 3-jewel column with random colors 1..NCOLORS */
static void roll(uint8_t *p) {
    p[0] = 1 + (uint8_t)(xorshift() % NCOLORS);
    p[1] = 1 + (uint8_t)(xorshift() % NCOLORS);
    p[2] = 1 + (uint8_t)(xorshift() % NCOLORS);
}

/* add to the 6-digit BCD score (score_d[0] = most significant), with carry */
static void add_score(uint16_t amt) {
    uint8_t k, idx;
    uint16_t carry = amt;
    for (k = 0; k < 6; k++) {
        if (carry == 0) break;
        idx = 5 - k;
        carry += score_d[idx];
        score_d[idx] = (uint8_t)(carry % 10);
        carry = carry / 10;
    }
}

/* ── sound effects ──────────────────────────────────────────────────
 * A tiny note sequencer driving square channel 2 directly.  Each note has
 * a real volume-decay envelope (NR22) so it fades instead of clicking off
 * (the old sound_play_tone hard-cut every note — that was the "static").
 * sfx_tick() advances one step per frame; multi-note effects become little
 * arpeggios.  GB period p ⇒ freq = 131072/(2048-p); higher p = higher note. */
#define P_C4  1548
#define P_G4  1714
#define P_A4  1750
#define P_C5  1797
#define P_E5  1849
#define P_G5  1881
#define P_A5  1899
#define P_C6  1923

/* NR21 duty: 0x40 = 25% (soft), 0x80 = 50% (full).  NR22 vol/env byte:
 * (volume<<4)|(0=decay)|envPace — bigger pace = slower fade. */
#define SFX_STEPS 4
static uint16_t sfx_p[SFX_STEPS];
static uint8_t  sfx_v[SFX_STEPS];
static uint8_t  sfx_d[SFX_STEPS];
static uint8_t  sfx_f[SFX_STEPS];
static uint8_t  sfx_n, sfx_i, sfx_t;

static void sfx_tick(void) {
    if (sfx_i >= sfx_n) return;
    if (sfx_t != 0) { sfx_t--; return; }
    NR21 = sfx_d[sfx_i];
    NR22 = sfx_v[sfx_i];
    NR23 = (uint8_t)(sfx_p[sfx_i] & 0xFF);
    NR24 = (uint8_t)(0x80 | (sfx_p[sfx_i] >> 8));   /* trigger (let envelope end it) */
    sfx_t = sfx_f[sfx_i];
    sfx_i++;
}

static void sfx_go(uint8_t n) { sfx_n = n; sfx_i = 0; sfx_t = 0; sfx_tick(); }

static void sfx_move(void) {
    sfx_p[0] = P_A5; sfx_v[0] = 0x81; sfx_d[0] = 0x40; sfx_f[0] = 4;
    sfx_go(1);
}
static void sfx_rotate(void) {
    sfx_p[0] = P_C6; sfx_v[0] = 0x81; sfx_d[0] = 0x40; sfx_f[0] = 4;
    sfx_go(1);
}
static void sfx_drop(void) {
    sfx_p[0] = P_C5; sfx_v[0] = 0xC2; sfx_d[0] = 0x80; sfx_f[0] = 3;
    sfx_p[1] = P_C4; sfx_v[1] = 0xC3; sfx_d[1] = 0x80; sfx_f[1] = 8;
    sfx_go(2);
}
static void sfx_clear(void) {      /* bright ascending C-E-G */
    sfx_p[0] = P_C5; sfx_v[0] = 0xD2; sfx_d[0] = 0x80; sfx_f[0] = 4;
    sfx_p[1] = P_E5; sfx_v[1] = 0xD2; sfx_d[1] = 0x80; sfx_f[1] = 4;
    sfx_p[2] = P_G5; sfx_v[2] = 0xD3; sfx_d[2] = 0x80; sfx_f[2] = 8;
    sfx_go(3);
}
static void sfx_chain(uint8_t n) { /* arpeggio whose top note rises per chain */
    uint16_t top = (uint16_t)(P_C6 + (uint16_t)n * 6);
    if (top > 1980) top = 1980;
    sfx_p[0] = P_E5; sfx_v[0] = 0xD2; sfx_d[0] = 0x80; sfx_f[0] = 3;
    sfx_p[1] = P_G5; sfx_v[1] = 0xD2; sfx_d[1] = 0x80; sfx_f[1] = 3;
    sfx_p[2] = top;  sfx_v[2] = 0xD3; sfx_d[2] = 0x80; sfx_f[2] = 8;
    sfx_go(3);
}
static void sfx_over(void) {       /* slow descending */
    sfx_p[0] = P_A4; sfx_v[0] = 0xC3; sfx_d[0] = 0x80; sfx_f[0] = 10;
    sfx_p[1] = P_G4; sfx_v[1] = 0xC3; sfx_d[1] = 0x80; sfx_f[1] = 10;
    sfx_p[2] = P_C4; sfx_v[2] = 0xC5; sfx_d[2] = 0x80; sfx_f[2] = 24;
    sfx_go(3);
}

/* ── background music ───────────────────────────────────────────────
 * A looping square-wave lead on channel 1 (SFX live on channel 2, so they
 * mix and the effects cut through the music).  music_tick() plays one melody
 * step every 12 frames, re-triggering ch1 at a steady volume.  Toggle on/off
 * with SELECT — defaults ON.
 *
 * The melody is the GB 11-bit period split into low/high BYTE arrays (NR13 +
 * NR14 low 3 bits) — period p ⇒ freq 131072/(2048-p).  hi == 0xFF marks a
 * rest.  Arpeggios over a C - Am - F - G chord loop, 8 steps each. */
static const uint8_t mel_lo[32] = {
    0x06,0x39,0x59,0x83, 0x59,0x39,0x06,0x00,   /* C E G C6 G E C  - */
    0xD6,0x06,0x39,0x6B, 0x39,0x06,0xD6,0x00,   /* A C E A5 E C A  - */
    0x88,0xD6,0x06,0x44, 0x06,0xD6,0x88,0x00,   /* F A C F5 C A F  - */
    0xB2,0xF7,0x21,0x59, 0x21,0xF7,0xB2,0x00,   /* G B D G5 D B G  - */
};
static const uint8_t mel_hi[32] = {             /* high 3 bits; 0xFF = rest */
    0x07,0x07,0x07,0x07, 0x07,0x07,0x07,0xFF,
    0x06,0x07,0x07,0x07, 0x07,0x07,0x06,0xFF,
    0x06,0x06,0x07,0x07, 0x07,0x06,0x06,0xFF,
    0x06,0x06,0x07,0x07, 0x07,0x06,0x06,0xFF,
};
static uint8_t music_on;
static uint8_t music_idx;
static uint8_t music_timer;

static void music_note(uint8_t idx) {
    uint8_t hi = mel_hi[idx];
    if (hi == 0xFF) { NR12 = 0x00; NR14 = 0x80; return; }   /* rest: silence ch1 */
    NR10 = 0x00;                        /* no sweep */
    NR11 = 0x80;                        /* 50% duty, no length counter */
    NR12 = 0x90;                        /* volume 9, no envelope (steady lead) */
    NR13 = mel_lo[idx];
    NR14 = (uint8_t)(0x80 | hi);        /* trigger + freq high bits */
}

static void music_tick(void) {
    if (!music_on) return;
    if (music_timer == 0) {
        music_note(music_idx);
        music_timer = 12;
        if (++music_idx >= 32) music_idx = 0;
    }
    music_timer--;
}

static void music_toggle(void) {
    music_on = (uint8_t)(!music_on);
    music_idx = 0;
    music_timer = 0;
    if (!music_on) { NR12 = 0x00; NR14 = 0x80; }   /* kill the lead immediately */
}

/* is grid cell (r,col) off the bottom or already filled? */
static uint8_t cell_blocked(uint8_t r, uint8_t col) {
    if (r >= ROWS) return 1;
    return grid[(uint8_t)(r * COLS + col)] ? 1 : 0;
}

/* would the 3-tall falling column collide if its top cell were at (col,topy)?
 * Checks are unrolled (not a loop) — short indexed-read loops can miscompile on
 * sm83, and this is the hottest correctness check in the game. */
static uint8_t collides(uint8_t col, uint8_t topy) {
    if (col >= COLS) return 1;
    if (cell_blocked(topy, col)) return 1;
    if (cell_blocked((uint8_t)(topy + 1), col)) return 1;
    if (cell_blocked((uint8_t)(topy + 2), col)) return 1;
    return 0;
}

/* start a new falling column at the top-center.  Every 18th piece is a MAGIC
 * column; otherwise take the previewed colors and roll the next preview.  If
 * it can't even appear, the well is full → game over. */
static void spawn(void) {
    rng ^= DIV;
    if (++piece_counter >= 18) {
        piece_counter = 0;
        piece_magic = 1;
        piece[0] = MAGIC; piece[1] = MAGIC; piece[2] = MAGIC;
    } else {
        piece_magic = 0;
        piece[0] = nextp[0]; piece[1] = nextp[1]; piece[2] = nextp[2];
        roll(nextp);
    }
    piece_x = COLS / 2 - 1;
    piece_y = 0;
    piece_active = 1;
    fall_timer = 0;
    next_dirty = 1;
    if (collides(piece_x, piece_y)) {
        piece_active = 0;
        state = ST_OVER;
    }
}

/* Flag every gem that's part of a run of 3+ same-color cells in any of the 4
 * directions, into matched[]; return how many cells were flagged.  Each line
 * is counted from its lowest end only (we skip a cell if its predecessor in
 * that direction is the same color), so runs aren't double-walked. */
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
                    && G(sr, sc) == col) continue;
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

/* empty every flagged cell */
static void clear_marked(void) {
    uint8_t i;
    for (i = 0; i < NCELL; i++) if (matched[i]) grid[i] = 0;
}

/* collapse each column so all gems rest on the floor with no gaps */
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

/* level rises every 15 cleared gems (capped at 13); each level shortens the
 * frames-per-row fall interval, so the column drops faster. */
static void update_level(void) {
    level = (uint8_t)(total_cleared / 15);
    if (level > 13) level = 13;
    cur_fall_rate = 32 - level * 2;
    if (cur_fall_rate < 4) cur_fall_rate = 4;
}

/* Matched gems burst apart before they clear — a one-shot expanding star in
 * each gem's own colour (no blinking, no LCD-off).  Only ever runs on a real
 * match.  Direct vblank writes (no OAM DMA contends here, so plenty of room);
 * blocks ~6 frames, which is the satisfying beat. */
static void explode_matched(void) {
    uint8_t i, j, n, tile;
    uint16_t offs[8];
    uint8_t  cols[8];
    uint8_t *o = (uint8_t *)0xC100;
    for (i = 0; i < 12; i++) *o++ = 0;             /* hide the locked piece sprites */
    ((void (*)(uint8_t))0xFF80)(0xC1);
    n = 0;
    for (i = 0; i < NCELL && n < 8; i++) {
        if (matched[i]) {
            offs[n] = (uint16_t)(WELL_MY + (i >> 3)) * 32 + WELL_MX + (i & 7);
            cols[n] = (uint8_t)(grid[i] - 1);
            n++;
        }
    }
    for (j = 0; j < 9; j++) {
        tile = (j < 3) ? T_EXP0 : (j < 6) ? T_EXP1 : T_EXP2;
        wait_vblank();
        sfx_tick();
        music_tick();
        VBK = 0;
        for (i = 0; i < n; i++) VRAM[offs[i]] = tile;
        VBK = 1;
        for (i = 0; i < n; i++) VRAM[offs[i]] = cols[i];
        VBK = 0;
    }
}

/* Settle the board after a lock: repeatedly find matches, burst+clear them,
 * score, and apply gravity — looping so cascades chain.  Score per clear scales
 * with level and (for 2nd+ cascades) the chain depth. */
static void resolve_board(void) {
    uint8_t n;
    uint16_t amt, mult;
    chain = 0;
    while (1) {
        n = mark_and_count();
        if (n == 0) break;
        chain++;
        sfx_chain(chain);
        explode_matched();
        clear_marked();
        mult = (uint16_t)(10 + level * 2);
        amt = (uint16_t)n * mult;
        if (chain > 1) amt = amt * chain;
        if (amt > 60000) amt = 60000;
        add_score(amt);
        total_cleared += n;
        apply_gravity();
    }
    update_level();
}

/* MAGIC column: clears every gem sharing the color of whatever it landed on,
 * then resolves any resulting cascades. */
static void magic_clear(void) {
    uint8_t below = (uint8_t)(piece_y + 3);
    uint8_t target, i;
    uint16_t cleared = 0;
    piece_active = 0;
    if (below < ROWS) {
        target = G(below, piece_x);
        if (target != 0 && target != MAGIC) {
            for (i = 0; i < NCELL; i++)
                if (grid[i] == target) { grid[i] = 0; cleared++; }
            if (cleared) {
                add_score((uint16_t)cleared * 20u);
                total_cleared += cleared;
                sfx_clear();
            }
            apply_gravity();
        }
    }
    resolve_board();
}

/* Stamp the falling column into the grid where it came to rest, then resolve.
 * A magic column takes its own path. */
static void lock_and_resolve(void) {
    uint8_t i, r;
    if (piece_magic) { magic_clear(); return; }
    for (i = 0; i < 3; i++) {
        r = (uint8_t)(piece_y + i);
        if (r < ROWS) G(r, piece_x) = piece[i];
    }
    piece_active = 0;
    resolve_board();
}

/* ── rendering ─────────────────────────────────────────────────────── */
/* copy one 16-byte 2bpp tile into VRAM tile slot `slot` ($8000 + slot*16) */
static void upload_tile(uint8_t slot, const uint8_t *src) {
    memcpy_vram((uint8_t *)(0x8000 + slot * 16), src, 16);
}

/* push all 8 BG palettes (4 colors each, 15-bit BGR) via the BCPS/BCPD port */
static void load_palettes(void) {
    uint8_t p, i;
    BCPS = 0x80;
    for (p = 0; p < 8; p++)
        for (i = 0; i < 4; i++) {
            BCPD = (uint8_t)(palettes[p][i] & 0xFF);
            BCPD = (uint8_t)((palettes[p][i] >> 8) & 0xFF);
        }
}

/* OBJ palettes: 0-5 = jewels (light/main/dark), 6 = magic white. Color 0 of
 * every OBJ palette is transparent (sprite shows the well behind it). */
static void load_obj_palettes(void) {
    uint8_t p, i;
    uint16_t col;
    OCPS = 0x80;
    for (p = 0; p < 8; p++)
        for (i = 0; i < 4; i++) {
            if (p < 6) col = palettes[p][i];
            else if (p == 6) col = (i == 3) ? RGB(31,31,31) : C_OUT;
            else col = 0;
            OCPD = (uint8_t)(col & 0xFF);
            OCPD = (uint8_t)((col >> 8) & 0xFF);
        }
}

/* The falling column = sprites 0-2; the NEXT preview = sprites 3-5 (sprites
 * so their transparent corners blend with the dark HUD).  Then flush OAM.
 * MUST be the first VRAM/OAM work after wait_vblank: the OAM DMA has to
 * land in vblank, or sprites tear on a fixed scanline near the top. */
static void update_sprites(void) {
    /* Write shadow_oam ($C100) directly with a walking pointer — calling
     * oam_set() six times burns ~10 scanlines of vblank (SDCC call overhead),
     * starving the BG flush.  Inlined it's ~2 lines. */
    uint8_t *o = (uint8_t *)0xC100;
    uint8_t i, tile, sx, sy, pal0, pal1, pal2;
    if (piece_active) {
        tile = piece_magic ? T_MAGIC : T_GEM;
        sx = (uint8_t)((WELL_MX + piece_x) * 8 + 8);
        sy = (uint8_t)((WELL_MY + piece_y) * 8 + 16);
        if (piece_magic) { pal0 = pal1 = pal2 = 6; }
        else { pal0 = piece[0] - 1; pal1 = piece[1] - 1; pal2 = piece[2] - 1; }
        *o++ = sy;          *o++ = sx; *o++ = tile; *o++ = pal0;
        *o++ = (uint8_t)(sy + 8);  *o++ = sx; *o++ = tile; *o++ = pal1;
        *o++ = (uint8_t)(sy + 16); *o++ = sx; *o++ = tile; *o++ = pal2;
    } else {
        for (i = 0; i < 12; i++) *o++ = 0;
    }
    /* NEXT preview (sprites 3-5) only changes on a spawn — skip it most
     * frames to keep the OAM build short enough to leave the BG flush vblank. */
    if (next_dirty) {
        next_dirty = 0;
        o = (uint8_t *)0xC10C;             /* sprite slot 3 */
        if (state == ST_TITLE) {
            for (i = 0; i < 12; i++) *o++ = 0;
        } else {
            sx = (uint8_t)((HUD_X + 2) * 8 + 8);
            for (i = 0; i < 3; i++) {
                *o++ = (uint8_t)((9 + i) * 8 + 16);
                *o++ = sx;
                *o++ = T_GEM;
                *o++ = (uint8_t)(nextp[i] - 1);
            }
        }
    }
    /* Trigger the OAM DMA via the HRAM stub directly (skip the oam_dma_flush
     * / oam_dma_copy wrappers).  A = high byte of shadow_oam ($C100). */
    ((void (*)(uint8_t))0xFF80)(0xC1);
}

/* write one BG map cell: tile index (VRAM bank 0) + palette/attr (bank 1).
 * Direct, unbounded — only safe with the LCD off or in a bounded vblank batch. */
static void set_cell(uint8_t mx, uint8_t my, uint8_t tile, uint8_t pal) {
    uint16_t off = (uint16_t)my * 32 + mx;
    VBK = 0;
    VRAM[off] = tile;
    VBK = 1;
    VRAM[off] = pal;
    VBK = 0;
}

/* map an ASCII char to its font tile slot (digits, then A-Z); blank otherwise */
static uint8_t font_slot(char ch) {
    if (ch >= '0' && ch <= '9') return FONT_BASE + (uint8_t)(ch - '0');
    if (ch >= 'A' && ch <= 'Z') return FONT_BASE + 10 + (uint8_t)(ch - 'A');
    return T_BLANK;
}

/* draw a NUL-terminated string into the BG map starting at (col,row) */
static void draw_text(uint8_t col, uint8_t row, const char *s) {
    uint8_t i;
    for (i = 0; s[i] != 0; i++)
        set_cell((uint8_t)(col + i), row, font_slot(s[i]), PAL_OUT);
}

/* Only the DYNAMIC HUD values (~11 cells) — the labels are static, drawn
 * once in draw_static.  Small enough to write inside one vblank. */
static void draw_hud(void) {
    uint8_t i;
    for (i = 0; i < 6; i++) set_cell((uint8_t)(HUD_X + i), 2, FONT_BASE + score_d[i], PAL_OUT);
    set_cell(HUD_X, 5, FONT_BASE + (uint8_t)(level / 10), PAL_OUT);
    set_cell((uint8_t)(HUD_X + 1), 5, FONT_BASE + (uint8_t)(level % 10), PAL_OUT);
    /* NEXT gems are sprites now (update_sprites) — nothing to draw here */
}

/* Lay down the unchanging screen: clear the whole map, draw the well's left/
 * right/bottom walls, and the static HUD labels.  Only called with the LCD off
 * (it writes the entire map at once). */
static void draw_static(void) {
    uint8_t x, y;
    uint16_t off;
    VBK = 0;
    for (y = 0; y < 18; y++)
        for (x = 0; x < 20; x++) { off = (uint16_t)y * 32 + x; VRAM[off] = T_EMPTY; }
    VBK = 1;
    for (y = 0; y < 18; y++)
        for (x = 0; x < 20; x++) { off = (uint16_t)y * 32 + x; VRAM[off] = PAL_OUT; }
    VBK = 0;
    for (y = WELL_MY; y < (uint8_t)(WELL_MY + ROWS); y++) {
        set_cell((uint8_t)(WELL_MX - 1), y, T_WALL, PAL_WELL);
        set_cell((uint8_t)(WELL_MX + COLS), y, T_WALL, PAL_WELL);
    }
    for (x = (uint8_t)(WELL_MX - 1); x <= (uint8_t)(WELL_MX + COLS); x++)
        set_cell(x, (uint8_t)(WELL_MY + ROWS), T_WALL, PAL_WELL);
    /* static HUD labels (drawn once — the values come from draw_hud) */
    draw_text(HUD_X, 1, "SCORE");
    draw_text(HUD_X, 4, "LEVEL");
    draw_text(HUD_X, 7, "NEXT");
}

/* Full LOCKED-well redraw (no piece — that's a sprite).  Used only with the
 * LCD OFF (boot / title↔game transitions), where writing all changed cells
 * at once is safe. */
static void redraw_all(void) {
    uint8_t r, c, col;
    uint8_t i = 0;
    uint16_t rowoff, off;
    for (r = 0; r < ROWS; r++) {
        rowoff = (uint16_t)(WELL_MY + r) * 32 + WELL_MX;
        for (c = 0; c < COLS; c++) {
            col = grid[i];
            if (col != shadow[i]) {
                shadow[i] = col;
                off = rowoff + c;
                VBK = 0; VRAM[off] = col ? T_GEM : T_EMPTY;
                VBK = 1; VRAM[off] = col ? (uint8_t)(col - 1) : PAL_WELL;
                VBK = 0;
            }
            i++;
        }
    }
}

/* ── deferred well/HUD rendering (NO LCD toggling in-game) ───────────
 * This core blanks the whole frame on ANY LCDC bit-7 toggle (a strobe we
 * must never do), AND it occasionally drops a VRAM write even at the start
 * of vblank.  So in-game we never touch the LCD; instead:
 *   COLLECT — queue work (RAM only): changed cells after a lock, the HUD,
 *             and — when idle — a rolling SCRUB of the whole well.
 *   FLUSH   — write the queue to VRAM as the FIRST thing after wait_vblank.
 * The scrub re-writes every well cell from the grid every ~0.2s, so any
 * dropped write self-corrects instead of becoming a permanent wrong color
 * (the "3 oranges that won't clear" bug).  Idempotent ⇒ invisible. */
/* Batches are kept small so the whole flush fits in vblank AFTER the OAM DMA
 * — overrunning into active display drops writes (a garbage "burst" on lock
 * frames before the scrub heals them). */
#define REDRAW_BUDGET 4             /* changed well cells per frame (responsive) */
#define SCRUB_N       4             /* idle cells re-written per frame (self-heal) */
#define WQ_MAX        6             /* queue capacity (≤4 pushed per frame) */
static uint8_t scanning, hud_pending, over_pending;
static uint8_t hud_phase, over_phase;   /* split big HUD/text writes across frames */
static uint8_t scan_i, scan_c, scrub_i;
static uint16_t scan_rowoff;

static uint8_t  wq_n;
static uint16_t wq_off[WQ_MAX];
static uint8_t  wq_tile[WQ_MAX];
static uint8_t  wq_attr[WQ_MAX];

static void start_redraw(void) {
    scanning = 1;
    scan_i = 0; scan_c = 0;
    scan_rowoff = (uint16_t)WELL_MY * 32 + WELL_MX;
}

static void wq_push(uint16_t off, uint8_t tile, uint8_t attr) {
    if (wq_n < WQ_MAX) {
        wq_off[wq_n] = off; wq_tile[wq_n] = tile; wq_attr[wq_n] = attr; wq_n++;
    }
}

static void wq_text(uint8_t col, uint8_t row, const char *s) {
    uint8_t i;
    for (i = 0; s[i] != 0; i++)
        wq_push((uint16_t)row * 32 + col + i, font_slot(s[i]), PAL_OUT);
}

/* Fill the queue with the next batch of pending changes (RAM only).
 * Each branch pushes at most REDRAW_BUDGET cells, so the flush always fits
 * in vblank; the HUD and game-over text are split across two frames. */
static void redraw_collect(void) {
    uint8_t col, k, r, c, i;
    wq_n = 0;
    if (scanning) {
        while (scan_i < NCELL && wq_n < REDRAW_BUDGET) {
            col = grid[scan_i];
            if (col != shadow[scan_i]) {
                shadow[scan_i] = col;
                wq_off[wq_n]  = scan_rowoff + scan_c;
                wq_tile[wq_n] = col ? T_GEM : T_EMPTY;
                wq_attr[wq_n] = col ? (uint8_t)(col - 1) : PAL_WELL;
                wq_n++;
            }
            scan_i++; scan_c++;
            if (scan_c >= COLS) { scan_c = 0; scan_rowoff += 32; }
        }
        if (scan_i >= NCELL) { scanning = 0; hud_pending = 1; hud_phase = 0; }
    } else if (hud_pending) {
        if (hud_phase == 0) {                       /* score digits 0-3 */
            for (i = 0; i < 4; i++)
                wq_push((uint16_t)2 * 32 + HUD_X + i, FONT_BASE + score_d[i], PAL_OUT);
            hud_phase = 1;
        } else {                                    /* score digits 4-5 + level */
            wq_push((uint16_t)2 * 32 + HUD_X + 4, FONT_BASE + score_d[4], PAL_OUT);
            wq_push((uint16_t)2 * 32 + HUD_X + 5, FONT_BASE + score_d[5], PAL_OUT);
            wq_push((uint16_t)5 * 32 + HUD_X,     FONT_BASE + (uint8_t)(level / 10), PAL_OUT);
            wq_push((uint16_t)5 * 32 + HUD_X + 1, FONT_BASE + (uint8_t)(level % 10), PAL_OUT);
            hud_pending = 0;
            if (state == ST_OVER) { over_pending = 1; over_phase = 0; }
        }
    } else if (over_pending) {
        if (over_phase == 0) { wq_text(3, 6, "GAME"); over_phase = 1; }
        else { wq_text(3, 7, "OVER"); over_pending = 0; }
    } else if (state == ST_PLAY) {
        /* idle: rolling scrub of the well so any dropped write heals itself.
         * (COLS is a power of two, so >>3 / &7 split index → row,col cheaply.)
         * Only during play — would erase the title gems / game-over text. */
        for (k = 0; k < SCRUB_N; k++) {
            r = scrub_i >> 3; c = scrub_i & 7;
            col = grid[scrub_i];
            wq_push((uint16_t)(WELL_MY + r) * 32 + WELL_MX + c,
                    col ? T_GEM : T_EMPTY, col ? (uint8_t)(col - 1) : PAL_WELL);
            scrub_i++;
            if (scrub_i >= NCELL) scrub_i = 0;
        }
    }
}

/* Write the queued cells to VRAM.  MUST run first after wait_vblank, and
 * MUST finish inside the ~10-line vblank window or writes drop.  Pointer-walk
 * (not array indexing) — SDCC sm83 generates far tighter code for *p++. */
static void redraw_flush(void) {
    uint8_t k = wq_n;
    uint16_t *op;
    uint8_t *tp, *ap;
    uint16_t off;
    if (k == 0) return;
    op = wq_off; tp = wq_tile; ap = wq_attr;
    while (k != 0) {
        off = *op++;
        VBK = 0; VRAM[off] = *tp++;
        VBK = 1; VRAM[off] = *ap++;
        k--;
    }
    VBK = 0;
    wq_n = 0;
}

/* a jagged, colorful gem pile to dress up the empty well on the title */
static const uint8_t title_heights[COLS] = { 5, 7, 4, 8, 6, 7, 5, 6 };

static void draw_title(void) {
    uint8_t x, y, c, k, color;
    /* clear the right panel (overwrites the HUD labels from draw_static) */
    for (y = 0; y <= 17; y++)
        for (x = 10; x <= 19; x++) set_cell(x, y, T_EMPTY, PAL_OUT);
    /* decorative gems piled at the bottom of the well */
    color = 1;
    for (c = 0; c < COLS; c++) {
        for (k = 0; k < title_heights[c]; k++) {
            y = (uint8_t)(ROWS - 1 - k);
            set_cell((uint8_t)(WELL_MX + c), (uint8_t)(WELL_MY + y),
                     T_GEM, (uint8_t)(color - 1));
            color++; if (color > NCOLORS) color = 1;
        }
    }
    /* title text, aligned to the in-game HUD column */
    draw_text(HUD_X, 2, "PUZZLE");
    draw_text(HUD_X, 9, "PRESS");
    draw_text(HUD_X, 10, "START");
}

/* LCD off / on — only used to bracket the full-screen rebuilds at the title and
 * game-start transitions.  NEVER call these from the in-game loop (the off-frame
 * blanks the whole screen — a flash/strobe). */
static void blit_off(void) { wait_vblank(); LCDC = 0; }
static void blit_on(void)  { LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO; }

/* zero the board and all run stats for a fresh game (shadow set to 0xFF so the
 * first redraw repaints every cell).  Does not touch music_on. */
static void reset_state(void) {
    uint8_t i;
    for (i = 0; i < NCELL; i++) grid[i] = 0;
    for (i = 0; i < NCELL; i++) shadow[i] = 0xFF;
    for (i = 0; i < 6; i++) score_d[i] = 0;
    total_cleared = 0;
    level = 0;
    cur_fall_rate = 32;
    fall_timer = 0;
    piece_counter = 0;
    piece_magic = 0;
}

/* leave the title and begin play: reset, seed the first piece + preview, and
 * rebuild the screen with the LCD off. */
static void start_game(void) {
    reset_state();
    state = ST_PLAY;
    roll(nextp);
    spawn();
    blit_off();
    draw_static();
    redraw_all();
    draw_hud();
    blit_on();
    update_sprites();
    scanning = 0; hud_pending = 0; over_pending = 0; wq_n = 0;
}

/* show the title screen (decorative gem pile + PUZZLE / PRESS START) */
static void go_title(void) {
    reset_state();
    piece_active = 0;
    state = ST_TITLE;
    blit_off();
    draw_static();
    redraw_all();
    draw_title();
    next_dirty = 1;
    blit_on();
    update_sprites();
    scanning = 0; hud_pending = 0; over_pending = 0; wq_n = 0;
}

void main(void) {
    uint8_t pad, prev = 0, t, rate, g;

    /* one-time hardware setup: LCD defaults, vblank IRQ (so wait_vblank HALTs),
     * the APU, then LCD off while we populate VRAM. */
    lcd_init_default();
    enable_vblank_irq();
    sound_init();
    music_on = 1;          /* background music on by default (SELECT toggles) */
    LCDC = 0;

    upload_tile(T_EMPTY, tile_empty);
    upload_tile(T_GEM,   tile_gem);
    upload_tile(T_WALL,  tile_wall);
    upload_tile(T_BLANK, tile_blank);
    upload_tile(T_MAGIC, tile_magic);
    upload_tile(T_EXP0,  tile_exp0);
    upload_tile(T_EXP1,  tile_exp1);
    upload_tile(T_EXP2,  tile_exp2);
    for (g = 0; g < FONT_GLYPHS; g++)
        memcpy_vram((uint8_t *)(0x8000 + (FONT_BASE + g) * 16), &font_data[g * 16], 16);
    load_palettes();
    load_obj_palettes();
    oam_clear();

    go_title();

    /* Main loop, one pass per frame.  The order is deliberate: the two VRAM/OAM
     * writers (sprites, then the bounded BG flush) run FIRST so they land inside
     * vblank; audio and game logic follow; the next frame's BG writes are queued
     * last (RAM only) for the following frame's flush. */
    while (1) {
        wait_vblank();
        update_sprites();  /* OAM DMA FIRST — must land in vblank (no tear) */
        redraw_flush();    /* then drain queued BG writes (≤4, fits vblank) */
        sfx_tick();
        music_tick();

        pad = joypad_read();

        /* SELECT toggles the background music, in any state */
        if ((pad & PAD_SELECT) && !(prev & PAD_SELECT)) music_toggle();

        if (state == ST_TITLE) {
            if ((pad & PAD_START) && !(prev & PAD_START)) start_game();
        } else if (state == ST_PLAY) {
            if ((pad & PAD_LEFT) && !(prev & PAD_LEFT)
                && !collides((uint8_t)(piece_x - 1), piece_y)) { piece_x--; sfx_move(); }
            if ((pad & PAD_RIGHT) && !(prev & PAD_RIGHT)
                && !collides((uint8_t)(piece_x + 1), piece_y)) { piece_x++; sfx_move(); }
            if ((pad & PAD_A) && !(prev & PAD_A) && !piece_magic) {
                t = piece[0]; piece[0] = piece[1]; piece[1] = piece[2]; piece[2] = t;
                sfx_rotate();
            }
            if ((pad & PAD_B) && !(prev & PAD_B) && !piece_magic) {
                t = piece[2]; piece[2] = piece[1]; piece[1] = piece[0]; piece[0] = t;
                sfx_rotate();
            }
            if ((pad & PAD_START) && !(prev & PAD_START)) {
                while (!collides(piece_x, (uint8_t)(piece_y + 1))) piece_y++;
                sfx_drop();
                lock_and_resolve();
                spawn();
                if (state == ST_OVER) sfx_over();
                start_redraw();
            }

            rate = (pad & PAD_DOWN) ? 3 : cur_fall_rate;
            if (++fall_timer >= rate) {
                fall_timer = 0;
                if (collides(piece_x, (uint8_t)(piece_y + 1))) {
                    sfx_drop();
                    lock_and_resolve();
                    spawn();
                    if (state == ST_OVER) sfx_over();
                    start_redraw();
                } else {
                    piece_y++;
                }
            }
        } else { /* ST_OVER — START restarts immediately */
            if ((pad & PAD_START) && !(prev & PAD_START)) start_game();
        }

        redraw_collect();   /* queue next frame's VRAM writes (RAM only) */
        prev = pad;
    }
}
