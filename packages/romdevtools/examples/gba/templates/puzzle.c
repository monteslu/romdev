/* ── puzzle.c — Game Boy Advance falling-jewel match-3 (complete game) ────────
 *
 * FACET FALL — a COMPLETE, working game: press-start title, a falling-trio
 * match-3 in a 6x12 well, cascade chains, levels that speed the fall, score +
 * persistent hi-score (cartridge SRAM), and DMA/PSG music + SFX. The jewels
 * are VIVID — the GBA's 15-bit palette gives 32768 colours, so each gem reads
 * as a faceted stone (a bright glint, a mid body, a dark rim) rather than a
 * flat block, and the well sits in a framed cabinet.
 *
 * The game: a vertical trio of three jewels (each its own colour) falls into
 * the well. LEFT/RIGHT move it, A/B cycle its three colours (the classic
 * trio "rotate"), DOWN soft-drops, START hard-drops. When it lands, any
 * straight run of 3+ same-coloured jewels (horizontal, vertical, OR diagonal)
 * clears; survivors fall and cascades chain for multiplied score. Clear enough
 * and the level ticks up and the fall quickens. Stack to the rim and it's over.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented GBA footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — match rules, tuning, art, scoring: reshape freely.
 *
 * What depends on what:
 *   gba_sfx.{h,c} — PSG sound: sfx_tone/sfx_noise one-shots + the music loop
 *     (sfx_music_tick once per frame — forget it and the game is silent).
 *   libtonc (the build links it) — VBlankIntrWait/key_poll/TTE/tonccpy.
 *
 * HANDHELD, SO SINGLE-PLAYER ONLY (honest note): 2P versus on the GBA means a
 * link cable between two units — a second emulator instance this environment
 * can't provide. So FACET FALL is a 1P MARATHON: clear, chain, level up, and
 * push your hi-score. (Contrast the NES/Genesis puzzle templates, which ARE
 * split-screen 2P versus — two controllers on one machine.)
 *
 * BANDWIDTH NOTE — and a TEACHING POINT vs the GB/NES version of this game
 * (examples/nes/templates/puzzle.c): on the NES a full-board repaint must
 * squeeze through a ~16-entry vblank tile queue, BUDGETED across 12 frames of
 * dirty-row-bitmask tricks. The GBA has no such famine — its BG tilemap is
 * plain VRAM you write whenever you like. So FACET FALL just REPAINTS THE
 * WHOLE WELL (72 cells = 72 u16 SE writes) every time the board changes, in
 * one go, no queue, no dirty-row gymnastics. Same genre, two bandwidth
 * worlds — fork accordingly.
 */

#include <tonc.h>
#include "gba_sfx.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "FACET FALL"

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Board geometry. The well is 6 wide x 12 tall, each cell ONE 8x8 BG tile.
 * Origin in BG-tile coords: the playfield sits at pixel (well_tx*8, WELL_TY*8)
 * with the HUD above and the controls hint below. */
#define GRID_W   6
#define GRID_H   12
#define WELL_TY  3            /* top tile row of the well interior            */
#define WELL_TX  16           /* left tile col of the well interior (centered)*/

#define EMPTY 0               /* cell colours 1..3 = ruby / emerald / sapphire */

/* ── GAME LOGIC (clay) — BG tile art (regular Mode-0 4bpp BG tiles).
 * Each 8x8 4bpp tile is 8 u32 rows; each nibble is a palette index within the
 * BG palbank we use (bank 0). Index 0 = transparent → shows the backdrop
 * colour. KEY TRICK: the three jewel tiles are the SAME faceted SHAPE drawn on
 * three different palette indices (glint/body/rim per colour), so a cell
 * changes colour by changing its TILE id — no palette rewrite, no attribute
 * juggling. The faceted look (a 1-3-1 nibble gradient) is what makes the
 * jewels pop on the GBA's wide palette. */
#define BG_BACK   1   /* cabinet backdrop dither                              */
#define BG_BAND   2   /* flat band behind the HUD text                        */
#define BG_FRAME  3   /* well frame / border                                  */
#define BG_INNER  4   /* empty well cell (recessed, faint speck)              */
#define BG_GEM1   5   /* jewel colour 1 (ruby)                                */
#define BG_GEM2   6   /* jewel colour 2 (emerald)                             */
#define BG_GEM3   7   /* jewel colour 3 (sapphire)                            */

/* cell colour (1..3) → BG tile id; empty shows the recessed inner cell. */
static u16 bg_tile_for(u8 col) {
    return col ? (u16)(BG_GEM1 - 1 + col) : BG_INNER;
}

static const u32 bg_tile_back[8] = {       /* steel dither cabinet           */
    0x12121212, 0x21212121, 0x12121212, 0x21212121,
    0x12121212, 0x21212121, 0x12121212, 0x21212121,
};
static const u32 bg_tile_band[8] = {       /* solid band behind the HUD      */
    0x33333333, 0x33333333, 0x33333333, 0x33333333,
    0x33333333, 0x33333333, 0x33333333, 0x33333333,
};
static const u32 bg_tile_frame[8] = {      /* bevelled steel border          */
    0x44444444, 0x43333334, 0x43333334, 0x43333334,
    0x43333334, 0x43333334, 0x43333334, 0x44444444,
};
static const u32 bg_tile_inner[8] = {      /* recessed empty cell + speck    */
    0x00000000, 0x00000000, 0x00000000, 0x00011000,
    0x00011000, 0x00000000, 0x00000000, 0x00000000,
};
/* One faceted-jewel SHAPE per colour. The nibbles are a tiny gradient:
 *   2 = glint (bright), 1 = body (mid), 3 = rim (dark). build_gem_tiles()
 * remaps {1,2,3} into each colour's three palette indices so the single
 * shape becomes three distinct, vivid stones. */
static const u32 gem_shape[8] = {
    0x00033300, 0x00321230, 0x03212210, 0x32122130,
    0x32112130, 0x03211230, 0x00321330, 0x00033300,
};
static u32 gem_ram[3][8];                   /* colours 1..3, built at boot   */

/* ── GAME LOGIC (clay) — remap the one jewel shape into three vivid colours.
 * Shape nibble n in {1,2,3} → palette index (3*k + n) for colour k, so each
 * jewel uses its own 3-index slice of the palbank (glint/body/rim). */
static void build_gem_tiles(void) {
    int k, r, i;
    for (k = 0; k < 3; k++)
        for (r = 0; r < 8; r++) {
            u32 v = gem_shape[r], out = 0;
            for (i = 0; i < 8; i++) {
                u32 nib = (v >> (i * 4)) & 0xF;
                if (nib) nib = (u32)(3 * k + nib);   /* into this colour's slice */
                out |= nib << (i * 4);
            }
            gem_ram[k][r] = out;
        }
}

/* ── GAME LOGIC (clay — reshape freely) — game state (plain BSS; the GBA has
 * 256 KB of EWRAM + 32 KB of IWRAM, so none of the NES version's
 * absolute-address scratch-page gymnastics).
 * NOTE for headless verification: unlike the Genesis template (whose work-RAM
 * globals are readable by symbol name), the GBA libretro core exposes NO
 * IWRAM/EWRAM region, so a headless agent reads game state from what's ON
 * HARDWARE — the BG0 tilemap (the locked well, in VRAM), OAM (the falling
 * trio), and save_ram (the hi-score). The verify harness decodes those. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static u8  state;

static u8  grid[GRID_H][GRID_W];   /* the well: 0 = empty, 1..3 = colour      */
static s16 piece_x;                /* falling trio: column 0..5               */
static s16 piece_y;                /* row of its TOP cell (<0 = above rim)    */
static u8  piece_col[3];           /* trio colours, top to bottom             */
static u16 score, hiscore;
static u16 cleared_total;          /* gems cleared, drives the level          */
static u8  level;                  /* 1..9, speeds up the fall                */

static u8  matched[GRID_H][GRID_W];/* match scan scratch                      */
static u16 fall_t;                 /* frames until next gravity step          */

/* ── GAME LOGIC (clay) — xorshift16 PRNG (a handful of ARM instructions) ── */
static u16 rng = 0xACE1;
static u8 random8(void) {
    u16 r = rng;
    r ^= r << 7;
    r ^= r >> 9;
    r ^= r << 8;
    rng = r;
    return (u8)r;
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * PERSISTENT SRAM at 0x0E000000. Two footguns, both fatal-but-silent:
 *   1. The SRAM bus is 8 BITS WIDE. Byte reads/writes only — a u16/u32
 *      access doesn't fault, it just reads the same byte mirrored (and a
 *      wide write stores one byte), so your data "almost" round-trips and
 *      then the checksum never matches. Every access below is via vu8.
 *   2. Emulators and flashcarts detect the SAVE TYPE by scanning the ROM
 *      image for a marker string. Without "SRAM_V" in the ROM, mGBA gives
 *      the cart NO save memory at all and writes to 0x0E000000 vanish.
 *      The aligned, (used)-attributed const below plants that marker —
 *      delete it and persistence dies even though this code is untouched.
 * Layout: 'V' 'X' score-lo score-hi checksum (xor ^ 0xA5) — magic+checksum
 * so a fresh (0xFF-filled) cart reads as "no record" instead of garbage.
 * requires: nothing else — self-contained; safe to transplant whole. */
#define SRAM_BYTE ((volatile u8 *)0x0E000000)
__attribute__((used, aligned(4))) static const char sram_type_marker[] = "SRAM_V113";

static u16 hiscore_load(void) {
    u8 lo, hi;
    if (SRAM_BYTE[0] != 'V' || SRAM_BYTE[1] != 'X') return 0;
    lo = SRAM_BYTE[2];
    hi = SRAM_BYTE[3];
    if (SRAM_BYTE[4] != (u8)(lo ^ hi ^ 0xA5)) return 0;
    return (u16)(lo | (hi << 8));
}

static void hiscore_save(u16 v) {
    SRAM_BYTE[0] = 'V';
    SRAM_BYTE[1] = 'X';
    SRAM_BYTE[2] = (u8)v;
    SRAM_BYTE[3] = (u8)(v >> 8);
    SRAM_BYTE[4] = (u8)((u8)v ^ (u8)(v >> 8) ^ 0xA5);
}

/* ── GAME LOGIC (clay) — TTE text helpers ────────────────────────────────────
 * Draw right-aligned decimal digits at pixel (x,y) WITHOUT tte_printf. The
 * bundled libtonc's tte_printf with a %d conversion is broken (it routes
 * through a vsnprintf path that isn't wired in this build — it garbles
 * output AND wedges the loop when called per-frame, GBA-1). We build the
 * string ourselves and use tte_write, which processes the #{P:x,y} position
 * command but does NO format conversion → safe every frame. */
static void draw_num(int x, int y, unsigned v, int digits) {
    char buf[24];
    int i, n = 0;
    buf[n++] = '#'; buf[n++] = '{'; buf[n++] = 'P'; buf[n++] = ':';
    if (x >= 100) buf[n++] = (char)('0' + (x / 100) % 10);
    if (x >= 10)  buf[n++] = (char)('0' + (x / 10) % 10);
    buf[n++] = (char)('0' + x % 10);
    buf[n++] = ',';
    if (y >= 100) buf[n++] = (char)('0' + (y / 100) % 10);
    if (y >= 10)  buf[n++] = (char)('0' + (y / 10) % 10);
    buf[n++] = (char)('0' + y % 10);
    buf[n++] = '}';
    for (i = digits - 1; i >= 0; i--) { buf[n + i] = (char)('0' + (v % 10)); v /= 10; }
    n += digits; buf[n] = 0;
    tte_write(buf);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * THE WELL IS BACKGROUND TILES on BG0 (Mode 0, a REGULAR text BG). A 32x32
 * map (BG_REG_32x32) is one screenblock; each map entry is a u16: tile id
 * (10 bits) + hflip/vflip + a 4-bit palbank. SE_BUILD(tile, palbank, hf, vf)
 * packs it. Footguns this dodges:
 *   - VRAM IGNORES BYTE WRITES (a u8 store duplicates the byte into both
 *     halves of the 16-bit lane). We only ever write whole u16 SE entries
 *     (via this helper) and tonccpy() tile data — both VRAM-safe.
 *   - TTE owns BG1 (CBB 2 / SBB 30). Keep this map (SBB 28) and our tile
 *     graphics (CBB 0) clear of those blocks or text and well corrupt each
 *     other.
 * Unlike the NES, there is NO vblank-queue famine here — set_cell can run
 * any time, so paint_well() just rewrites all 72 cells when the board changes.
 * requires: REG_BG0CNT → CBB 0 / SBB 28 (set in main), DCNT_BG0 enabled. */
static SCR_ENTRY *const well_map = se_mem[28];
static void set_cell(int tx, int ty, u16 tile) {
    well_map[ty * 32 + tx] = SE_BUILD(tile, 0, 0, 0);
}

/* Repaint the whole well interior from the grid (cheap on GBA — see idiom). */
static void paint_well(void) {
    int r, c;
    for (r = 0; r < GRID_H; r++)
        for (c = 0; c < GRID_W; c++)
            set_cell(WELL_TX + c, WELL_TY + r, bg_tile_for(grid[r][c]));
}

/* Paint the static cabinet: backdrop dither, HUD band, well frame. Done once
 * per state entry (the interior is then repainted by paint_well). */
static void paint_cabinet(void) {
    int r, c, x0 = WELL_TX - 1;
    for (r = 0; r < 32; r++)
        for (c = 0; c < 32; c++)
            set_cell(c, r, (r < 2) ? BG_BAND : BG_BACK);   /* rows 0-1 = HUD band */
    /* well frame: a border box around the interior */
    for (c = 0; c <= GRID_W + 1; c++) {
        set_cell(x0 + c, WELL_TY - 1, BG_FRAME);
        set_cell(x0 + c, WELL_TY + GRID_H, BG_FRAME);
    }
    for (r = 0; r < GRID_H; r++) {
        set_cell(x0, WELL_TY + r, BG_FRAME);
        set_cell(x0 + GRID_W + 1, WELL_TY + r, BG_FRAME);
    }
}

/* ── GAME LOGIC (clay) — HUD / screens (TTE on BG1, priority 0) ── */
static void draw_hud_numbers(void) {
    tte_erase_rect(28, 4, 70, 12);   draw_num(28, 4, score, 5);
    tte_erase_rect(116, 4, 158, 12); draw_num(116, 4, hiscore, 5);
    tte_erase_rect(210, 4, 220, 12); draw_num(210, 4, level, 1);
}

static void draw_hud_labels(void) {
    tte_erase_screen();
    tte_write("#{P:8,4}SC");
    tte_write("#{P:96,4}HI");
    tte_write("#{P:196,4}LV");
}

static void enter_title(void) {
    state = ST_TITLE;
    paint_cabinet();
    for (int r = 0; r < GRID_H; r++)
        for (int c = 0; c < GRID_W; c++) { grid[r][c] = EMPTY; set_cell(WELL_TX + c, WELL_TY + r, BG_INNER); }
    tte_erase_screen();
    tte_write("#{P:64,40}" GAME_TITLE);
    tte_write("#{P:76,72}PRESS START");
    tte_write("#{P:88,92}HI");
    draw_num(112, 92, hiscore, 5);
    tte_write("#{P:32,116}DPAD MOVE - AB SPIN");
    tte_write("#{P:48,128}START DROP - 1P MARATHON");
}

static void spawn_piece(void);
static void enter_play(void) {
    int r, c;
    state = ST_PLAY;
    for (r = 0; r < GRID_H; r++)
        for (c = 0; c < GRID_W; c++) grid[r][c] = EMPTY;
    score = 0; level = 1; cleared_total = 0; fall_t = 0;
    /* Stir the PRNG with time-on-title so each run differs. */
    rng ^= (u16)REG_VCOUNT ^ ((u16)REG_VCOUNT << 7);
    if (rng == 0) rng = 0xACE1;
    paint_cabinet();
    paint_well();
    draw_hud_labels();
    draw_hud_numbers();
    /* No need to swallow the START that began the run: key_hit only fires on a
     * fresh press (curr & ~prev), so the held START doesn't also hard-drop. */
    spawn_piece();
}

static void enter_over(void) {
    state = ST_OVER;
    if (score > hiscore) {
        hiscore = score;
        hiscore_save(hiscore);   /* byte-wise SRAM write — see the SRAM idiom  */
        draw_hud_numbers();
    }
    sfx_noise(20);                                  /* game-over rumble        */
    tte_write("#{P:84,60}GAME OVER");
    tte_write("#{P:76,80}PRESS START");
}

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Match scan: mark every straight run of 3+ same-coloured jewels in all 4
 * directions (a cell can belong to several runs — the mask de-dupes), and
 * return how many cells matched. Runs flat-out on the ARM7 — no need to smear
 * it across frames like the cc65 (NES) version. */
static const s8 DIRS4[4][2] = { {0,1}, {1,0}, {1,1}, {1,-1} };

static u8 mark_and_count(void) {
    u8 r, c, d, len, k, cnt, col;
    s8 dr, dc;
    s16 sr, sc;
    cnt = 0;
    for (r = 0; r < GRID_H; r++)
        for (c = 0; c < GRID_W; c++) matched[r][c] = 0;
    for (r = 0; r < GRID_H; r++) {
        for (c = 0; c < GRID_W; c++) {
            col = grid[r][c];
            if (col == EMPTY) continue;
            for (d = 0; d < 4; d++) {
                dr = DIRS4[d][0]; dc = DIRS4[d][1];
                sr = (s16)r - dr; sc = (s16)c - dc;
                if (sr >= 0 && sr < GRID_H && sc >= 0 && sc < GRID_W
                    && grid[sr][sc] == col) continue;     /* not the run's start */
                len = 1;
                sr = (s16)r + dr; sc = (s16)c + dc;
                while (sr >= 0 && sr < GRID_H && sc >= 0 && sc < GRID_W
                       && grid[sr][sc] == col) { len++; sr += dr; sc += dc; }
                if (len >= 3) {
                    sr = r; sc = c;
                    for (k = 0; k < len; k++) {
                        if (!matched[sr][sc]) { matched[sr][sc] = 1; cnt++; }
                        sr += dr; sc += dc;
                    }
                }
            }
        }
    }
    return cnt;
}

/* Collapse each column so survivors rest on the floor (walk from the bottom,
 * copying jewels down to a write cursor, then zero everything above it). */
static void apply_gravity(void) {
    u8 c;
    s16 r, w;
    for (c = 0; c < GRID_W; c++) {
        w = GRID_H - 1;
        for (r = GRID_H - 1; r >= 0; r--) {
            if (grid[r][c] != EMPTY) { grid[w][c] = grid[r][c]; w--; }
        }
        for (; w >= 0; w--) grid[w][c] = EMPTY;
    }
}

/* ── GAME LOGIC (clay) — clear matches, drop survivors, chain cascades.
 * Returns the chain depth (0 = the lock matched nothing). Score, level and the
 * full-well repaint happen here. */
static u8 resolve_board(void) {
    u8 n, r, c, chain;
    u16 amt;
    chain = 0;
    for (;;) {
        n = mark_and_count();
        if (n == 0) break;
        ++chain;
        for (r = 0; r < GRID_H; r++)
            for (c = 0; c < GRID_W; c++)
                if (matched[r][c]) grid[r][c] = EMPTY;
        amt = (u16)n * 10;
        if (chain > 1) amt *= chain;                 /* cascades pay multiplied */
        if (score < 65000u) score += amt;
        /* clear chime — pitch rises with chain depth (bigger freq code = higher) */
        sfx_tone(1, (u16)(1500 + ((u16)chain << 6)), 8);
        apply_gravity();
        cleared_total += n;
        while (level < 9 && cleared_total >= (u16)level * 10) ++level;
    }
    if (chain) { paint_well(); draw_hud_numbers(); }
    return chain;
}

/* Can the trio occupy column x, rows y..y+2? Cells above the rim are fine
 * (pieces enter from above); below the floor or on a jewel is not. */
static u8 can_place(s16 x, s16 y) {
    s16 i, cy;
    if (x < 0 || x >= GRID_W) return 0;
    for (i = 0; i < 3; i++) {
        cy = y + i;
        if (cy < 0) continue;
        if (cy >= GRID_H) return 0;
        if (grid[cy][x] != EMPTY) return 0;
    }
    return 1;
}

static void spawn_piece(void) {
    piece_x = GRID_W / 2;
    piece_y = -2;
    piece_col[0] = (u8)(1 + random8() % 3);
    piece_col[1] = (u8)(1 + random8() % 3);
    piece_col[2] = (u8)(1 + random8() % 3);
    if (!can_place(piece_x, piece_y)) enter_over();   /* well full → game over */
}

/* ── GAME LOGIC (clay) — land the trio, resolve, respawn. ── */
static void lock_piece(void) {
    s16 i, y;
    for (i = 0; i < 3; i++) {
        y = piece_y + i;
        if (y >= 0) grid[y][piece_x] = piece_col[i];
    }
    paint_well();
    sfx_tone(2, 900, 4);                              /* lock thunk            */
    if (piece_y < 0) { enter_over(); return; }        /* locked above the rim  */
    resolve_board();
    if (state != ST_PLAY) return;
    spawn_piece();
}

/* ── GAME LOGIC (clay) — input + gravity. Edge-triggered moves (key_hit = one
 * cell per press), held DOWN soft-drops, A/B cycle the trio's colours, START
 * hard-drops. libtonc's key_poll() (called once per frame in main) maintains
 * the curr/prev key state that key_hit/key_held read — that's the idiomatic
 * Tonc edge-trigger, no hand-rolled prev-mask needed. May end the game
 * (lock → top-out). ── */
static void update_play(void) {
    u8 t, fd;

    if (key_hit(KEY_LEFT)  && can_place(piece_x - 1, piece_y)) --piece_x;
    if (key_hit(KEY_RIGHT) && can_place(piece_x + 1, piece_y)) ++piece_x;
    if (key_hit(KEY_A)) {                             /* cycle colours downward */
        t = piece_col[2]; piece_col[2] = piece_col[1];
        piece_col[1] = piece_col[0]; piece_col[0] = t;
        sfx_tone(2, 1300, 3);
    }
    if (key_hit(KEY_B)) {                             /* cycle colours upward   */
        t = piece_col[0]; piece_col[0] = piece_col[1];
        piece_col[1] = piece_col[2]; piece_col[2] = t;
        sfx_tone(2, 1400, 3);
    }
    if (key_hit(KEY_START)) {                         /* hard drop             */
        while (can_place(piece_x, piece_y + 1)) ++piece_y;
        lock_piece();
        return;
    }

    if (key_held(KEY_DOWN)) fall_t += 4;              /* soft drop             */
    ++fall_t;
    fd = (u8)(32 - ((level << 1) + level));           /* 29 (lv1) .. 5 (lv9)   */
    if (fall_t >= fd) {
        fall_t = 0;
        if (can_place(piece_x, piece_y + 1)) ++piece_y;
        else lock_piece();                            /* may end the game      */
    }
}

/* ── GAME LOGIC (clay) — stage the falling trio's sprites. The LOCKED well is
 * BG tiles (only what moves every frame earns OAM slots): 3 sprites for the
 * trio. Cells above the rim aren't drawn — they'd poke out over the HUD band.
 * Off-screen / inactive slots park at y=200. ── */
static OBJ_ATTR obj_buffer[128];
#define TILE_TRIO 1   /* OBJ tile 1 = the faceted jewel sprite (4bpp 8x8)     */

static void stage_sprites(void) {
    int i;
    int playing = (state == ST_PLAY);
    for (i = 0; i < 3; i++) {
        s16 r = piece_y + (s16)i;
        u8 col = piece_col[i] ? piece_col[i] : 1;
        if (playing && r >= 0) {
            obj_set_attr(&obj_buffer[i], ATTR0_SQUARE, ATTR1_SIZE_8,
                         (u16)(ATTR2_PALBANK(col - 1) | TILE_TRIO));
            obj_set_pos(&obj_buffer[i], (WELL_TX + piece_x) * 8, (WELL_TY + r) * 8);
        } else {
            obj_set_attr(&obj_buffer[i], ATTR0_SQUARE, ATTR1_SIZE_8,
                         (u16)(ATTR2_PALBANK(0) | TILE_TRIO));
            obj_set_pos(&obj_buffer[i], 250, 200);
        }
    }
}

int main(void) {
    int k;

    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * Init order: tiles/palettes → oam_init → irq_init + II_VBLANK → TTE init
     * → DISPCNT last. VBlankIntrWait() HANGS FOREVER without the vblank IRQ
     * registered (the #1 "frozen on frame 1" cause), and enabling DISPCNT
     * layers before their tiles/maps exist flashes garbage. TTE owns BG1
     * (CBB 2 / SBB 30) — keep other layers off those blocks.
     * requires: nothing prior; this IS the boot. */

    /* BG palette (bank 0). Vivid faceted jewels: each colour gets a 3-index
     * slice — body / glint / rim. The GBA's 15-bit RGB gives saturated stones
     * the GB/NES can only hint at. */
    pal_bg_mem[0]  = RGB15(2, 2, 5);      /* backdrop / transparent base       */
    pal_bg_mem[1]  = RGB15(7, 7, 10);     /* cabinet dither A                  */
    pal_bg_mem[2]  = RGB15(4, 4, 7);      /* cabinet dither B                  */
    pal_bg_mem[3]  = RGB15(2, 2, 3);      /* HUD band near-black               */
    pal_bg_mem[BG_FRAME]   = RGB15(10, 11, 14);  /* frame steel               */
    pal_bg_mem[BG_FRAME+1] = RGB15(18, 19, 23);  /* frame lip                 */
    /* jewel palette slices: index (3*k + n), n in 1..3 → body/glint/rim.
     * colour 1 = ruby, 2 = emerald, 3 = sapphire. */
    pal_bg_mem[3*0+1] = RGB15(26, 4, 8);  pal_bg_mem[3*0+2] = RGB15(31, 18, 20); pal_bg_mem[3*0+3] = RGB15(13, 1, 3);
    pal_bg_mem[3*1+1] = RGB15(4, 24, 8);  pal_bg_mem[3*1+2] = RGB15(20, 31, 18); pal_bg_mem[3*1+3] = RGB15(1, 11, 4);
    pal_bg_mem[3*2+1] = RGB15(6, 12, 30); pal_bg_mem[3*2+2] = RGB15(20, 24, 31); pal_bg_mem[3*2+3] = RGB15(2, 4, 14);

    /* BG tile graphics → char-block 0 (TTE uses CBB 2 — kept clear). */
    tonccpy(&tile_mem[0][BG_BACK],  bg_tile_back,  sizeof(bg_tile_back));
    tonccpy(&tile_mem[0][BG_BAND],  bg_tile_band,  sizeof(bg_tile_band));
    tonccpy(&tile_mem[0][BG_FRAME], bg_tile_frame, sizeof(bg_tile_frame));
    tonccpy(&tile_mem[0][BG_INNER], bg_tile_inner, sizeof(bg_tile_inner));
    build_gem_tiles();
    tonccpy(&tile_mem[0][BG_GEM1], gem_ram[0], sizeof(gem_ram[0]));
    tonccpy(&tile_mem[0][BG_GEM2], gem_ram[1], sizeof(gem_ram[1]));
    tonccpy(&tile_mem[0][BG_GEM3], gem_ram[2], sizeof(gem_ram[2]));

    /* Trio sprite: the same faceted jewel shape at OBJ tile 1, drawn per
     * colour via three OBJ palbanks (0/1/2) that mirror the BG jewel slices. */
    tonccpy(&tile_mem[4][TILE_TRIO], gem_shape, sizeof(gem_shape));
    /* The sprite tile uses the RAW gem_shape (nibbles 1/2/3 = body/glint/rim),
     * so the trio's colour is picked by the OBJ PALBANK at draw time: bank k
     * carries colour-(k+1)'s body/glint/rim at indices 1/2/3. One tile, three
     * vivid jewels — exactly mirroring the BG jewel palette slices. */
    for (k = 0; k < 3; k++) {
        pal_obj_bank[k][1] = pal_bg_mem[3*k+1];       /* body  */
        pal_obj_bank[k][2] = pal_bg_mem[3*k+2];       /* glint */
        pal_obj_bank[k][3] = pal_bg_mem[3*k+3];       /* rim   */
    }

    REG_BG0CNT = BG_CBB(0) | BG_SBB(28) | BG_REG_32x32 | BG_4BPP | BG_PRIO(2);

    oam_init(obj_buffer, 128);         /* hides all 128                        */

    irq_init(NULL);
    irq_add(II_VBLANK, NULL);

    sfx_init();                        /* APU on; music loop ticks below       */

    /* TTE text on BG1 (4bpp char block 2, screenblock 30), priority 0 so text
     * draws over everything. Mode 0 = all four BGs regular/tiled. */
    tte_init_chr4c_default(1, BG_CBB(2) | BG_SBB(30));
    REG_BG1CNT |= BG_PRIO(0);
    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0 | DCNT_BG1 | DCNT_OBJ | DCNT_OBJ_1D;

    hiscore = hiscore_load();          /* cartridge SRAM — 0 on first boot     */
    enter_title();

    while (1) {
        /* Idiomatic Tonc heartbeat: wait vblank, poll keys, update, then
         * commit OAM while still inside vblank (the update is far quicker than
         * the 4.9ms vblank window). */
        VBlankIntrWait();
        key_poll();
        sfx_music_tick();              /* forget this → silent game            */

        if (state == ST_TITLE) {
            if (key_hit(KEY_START | KEY_A)) enter_play();
        } else if (state == ST_OVER) {
            if (key_hit(KEY_START)) enter_title();
        } else {
            update_play();
        }

        stage_sprites();
        oam_copy(oam_mem, obj_buffer, 128);
    }
    return 0;
}
