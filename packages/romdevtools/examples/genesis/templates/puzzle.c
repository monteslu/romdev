/* ── puzzle.c — Genesis falling-gem versus puzzle (complete example game) ─────
 *
 * SHARD SIEGE — a COMPLETE, working game: title screen, 1P MARATHON mode
 * (levels speed the fall as you clear) and 2P SIMULTANEOUS VERSUS mode —
 * two 6x12 wells side by side, P1 on controller 1, P2 on controller 2,
 * both falling at once, where every cascade chain you score lays SIEGE to
 * the other well: garbage rows rise from the bottom of your rival's board.
 * Score + persistent hi-score (cartridge SRAM), music + SFX.
 *
 * The game: a falling-trio match-3. A vertical trio of gems drops into a
 * well; LEFT/RIGHT move it, A/B cycle its three colours, DOWN soft-drops,
 * C hard-drops. When it lands, any straight run of 3+ same-coloured gems
 * (horizontal, vertical, or diagonal) clears; survivors fall and cascades
 * chain for multiplied score. First stack to reach the rim loses.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented Genesis footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — match rules, garbage, tuning, art: reshape freely.
 *
 * What depends on what:
 *   genesis_sfx.{h,c} — PSG sound wrapper (tones + noise + a background
 *     melody loop). For full FM music see the xgm2_demo template — PSG keeps
 *     this a single-file game.
 *   rom_header.c (SGDK) — the Sega header at $100. Its 'RA' block at $1B0
 *     DECLARES the cartridge SRAM that hiscore_load/save below depend on
 *     (see the SRAM idiom). The build assembles it automatically.
 *
 * Frame budget (NTSC, 60 fps) — and a TEACHING POINT vs the NES version of
 * this game (examples/nes/templates/puzzle.c): on the NES, board repaints
 * squeeze through a ~16-entry vblank queue, so a full-board repaint is
 * BUDGETED across 12 frames of dirty-row bitmask tricks. The Genesis has
 * no such famine: each dirty well is mirrored in a RAM buffer and queued
 * as ONE DMA rect (576 bytes); the H40 vblank DMA window moves ~7 KB, so
 * BOTH wells + 6 SAT entries + HUD land in a single vblank with most of
 * the budget unspent. Same genre, two bandwidth worlds — fork accordingly.
 */

#include <genesis.h>
#include "genesis_sfx.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "SHARD SIEGE"

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * CONTROLLER MAPPING — two layers, both bite:
 *
 *   On the pad: SGDK's JOY_readJoypad(JOY_1/JOY_2) returns BUTTON_A/B/C/
 *   START/UP/DOWN/LEFT/RIGHT as a bitmask. Here A/B cycle the trio's
 *   colours, C hard-drops (thumbs rest on C — give it the decisive action).
 *
 *   Driving this game HEADLESSLY through an emulator (libretro/gpgx): the
 *   core maps Genesis A/B/C onto libretro Y/B/A. So setInput({y:true})
 *   presses GENESIS A (rotate/1P-start here), setInput({b:true}) presses
 *   GENESIS B (rotate/2P-select), and setInput({a:true}) presses GENESIS C
 *   (hard drop) — NOT Genesis A. Getting this wrong looks like "the game
 *   ignores input". START is start.
 */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Board geometry. Cells are 16x16 px (2x2 tiles) — the Genesis 320x224
 * screen has room to spare; chunky gems read better than 8-px ones.
 * Tile rows 0-1 sit under the WINDOW HUD; well frames at row 2 and 27. */
#define GRID_W   6
#define GRID_H   12
#define WELL_TY  3            /* top TILE row of the well interior        */
#define WELL_1P_TX 14         /* 1P: single centered well (tiles 14-25)   */
#define WELL_VS_P1  3         /* 2P: P1 interior tiles 3-14 ...           */
#define WELL_VS_P2 25         /*     P2 interior tiles 25-36 (split board)*/
#define HUD_ROWS    2         /* window rows reserved for the HUD         */

#define EMPTY 0               /* cell colours 1..3 = ruby/emerald/sapphire */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile art. Genesis tiles are 4bpp: each u32 row = 8 pixels, one hex
 * nibble per pixel = a colour index into the tile's palette line (0 =
 * transparent). Everything game-side (board, frames, gems, trio sprites)
 * lives on PAL1; the backdrop plane uses PAL2; PAL0 keeps the SGDK font.
 *
 * KEY TRICK: the three gem colours are the SAME 16x16 shape. The four
 * quarter tiles are drawn ONCE with fill nibble 1 (rim 5 / glint 4 shared),
 * and the other two colours are GENERATED at boot by remapping nibble 1 ->
 * 2 / 3 into a RAM buffer before upload — one piece of art, three tiles. */
#define T_FRAME (TILE_USER_INDEX + 0)   /* well border                   */
#define T_CELL  (TILE_USER_INDEX + 1)   /* empty (recessed) cell quarter */
#define T_BACK  (TILE_USER_INDEX + 2)   /* plane B cabinet backdrop      */
#define T_BAND  (TILE_USER_INDEX + 3)   /* plane B flat band behind HUD  */
#define T_GEM   (TILE_USER_INDEX + 4)   /* 12 tiles: 3 colours x 4 quarters */

static const u32 tile_frame[8] = {
    0x77777777, 0x76666667, 0x76666667, 0x76666667,
    0x76666667, 0x76666667, 0x76666667, 0x77777777,
};
static const u32 tile_cell[8] = {       /* near-black well + faint speck */
    0x99999999, 0x99999999, 0x99999999, 0x99989999,
    0x99999999, 0x99999999, 0x99999999, 0x99999999,
};
static const u32 tile_back[8] = {       /* framed cabinet block          */
    0x11111111, 0x12222221, 0x12222221, 0x12222221,
    0x12222221, 0x12222221, 0x12222221, 0x11111111,
};
static const u32 tile_band[8] = {
    0x33333333, 0x33333333, 0x33333333, 0x33333333,
    0x33333333, 0x33333333, 0x33333333, 0x33333333,
};
/* Gem quarters in SPRITE TILE ORDER — Genesis 2x2 sprites take their four
 * tiles COLUMN-MAJOR: base+0 top-left, +1 bottom-left, +2 top-right,
 * +3 bottom-right. The tilemap placement below indexes the same way. */
static const u32 gem_quarter[4][8] = {
    { 0x00005555, 0x00551111, 0x05114411, 0x05144111,   /* top-left      */
      0x51141111, 0x51111111, 0x51111111, 0x51111111 },
    { 0x51111111, 0x51111111, 0x51111111, 0x51111111,   /* bottom-left   */
      0x05111111, 0x05111111, 0x00551111, 0x00005555 },
    { 0x55550000, 0x11115500, 0x11111150, 0x11111150,   /* top-right     */
      0x11111115, 0x11111115, 0x11111115, 0x11111115 },
    { 0x11111115, 0x11111115, 0x11111115, 0x11111115,   /* bottom-right  */
      0x11111150, 0x11111150, 0x11115500, 0x55550000 },
};
static u32 gem_ram[3][4][8];            /* colours 1..3, built at boot   */

static void build_gem_tiles(void) {
    u16 k, t, r, i;
    for (k = 0; k < 3; k++)
        for (t = 0; t < 4; t++)
            for (r = 0; r < 8; r++) {
                u32 v = gem_quarter[t][r], out = 0;
                for (i = 0; i < 8; i++) {
                    u32 nib = (v >> (i * 4)) & 0xF;
                    if (nib == 1) nib = 1 + k;     /* fill -> this colour */
                    out |= nib << (i * 4);
                }
                gem_ram[k][t][r] = out;
            }
}

/* ── GAME LOGIC (clay — reshape freely) ── game state.
 * Boards are PLAIN STATIC ARRAYS — the Genesis has 64 KB of work RAM, so
 * none of the NES version's absolute-address scratch-page gymnastics.
 * The hot ones are deliberately NON-static: they then appear in the GNU-ld
 * map (build symbols), so a headless agent can resolve them by name and
 * read/poke live state (symbols -> memory) — same trick as the
 * two_plane_parallax template's g_player_x. */
u8  grid[2][GRID_H][GRID_W];       /* the two wells (P2's unused in 1P)  */
s16 piece_x[2];                    /* falling trio: column 0..5          */
s16 piece_y[2];                    /* row of its TOP cell (<0 above rim) */
u8  piece_col[2][3];               /* trio colours, top to bottom        */
u16 score[2];
u16 hiscore;
u8  level;                         /* 1P: 1..9, speeds up the fall       */
u8  state;                         /* ST_TITLE / ST_PLAY / ST_OVER       */
u8  two_player;

static u8  matched[GRID_H][GRID_W];
static u8  well_tx[2];             /* left interior TILE column per well */
static u8  fall_t[2];              /* frames until next gravity step     */
static u16 prev_pad[2];            /* for edge-triggered input           */
static u16 cleared_total;          /* 1P: gems cleared, drives the level */
static u8  board_dirty[2];         /* well needs a repaint this frame    */
static u16 rng = 0xACE1;

#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2

#define VS_FALL_DELAY 24           /* 2P: fixed gravity (frames per row) */
#define GARBAGE_CAP   4            /* max garbage rows per attack        */

/* ── GAME LOGIC (clay) — xorshift16 PRNG (a few 68k instructions) ── */
static u8 random8(void) {
    u16 r = rng;
    r ^= r << 7;
    r ^= r >> 9;
    r ^= r << 8;
    rng = r;
    return (u8)r;
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * CARTRIDGE SRAM — the Genesis battery-save mechanism, three parts:
 *
 *   1. The ROM HEADER declares it: bytes $1B0.. hold 'R','A', a type word
 *      ($F820 = battery-backed, byte-wide on ODD addresses — the classic
 *      cart wiring), then start/end addresses $200000/$20FFFF. SGDK's
 *      rom_header.c (assembled into every build) already declares exactly
 *      this — no linker work needed. Emulators allocate the save RAM by
 *      READING THIS HEADER; no 'RA' block = writes to $200000+ go nowhere.
 *   2. The MAPPER GATE: writing 1 to $A130F1 banks SRAM into $200000+,
 *      0 banks the ROM back in. SGDK's SRAM_enable()/SRAM_disable() do
 *      this. ALWAYS disable after access — on carts >2 MB the SRAM window
 *      shadows ROM, and leaving it enabled corrupts later ROM fetches.
 *   3. ODD-BYTE ADDRESSING: SRAM_readByte/writeByte(offset) access 68k
 *      address $200001 + offset*2. Headlessly, the emulator's save_ram
 *      region interleaves with dead even bytes: SGDK offset k lives at
 *      save_ram[k*2 + 1] (the even bytes read back $FF).
 *
 * Hi-score record layout (SGDK offsets): 0='H' 1='S' 2=lo 3=hi
 * 4=checksum(lo^hi^$A5). Fresh SRAM is all $FF — the magic+checksum
 * rejects it (and any corruption) so first boot shows 0, not 65535.
 *
 * Emulator note (verified against gpgx): the core sizes its save_ram
 * region by scanning for the last non-$FF byte, so the region reads as
 * EMPTY until the first write below lands — that's why hiscore_init runs
 * at the very top of main(). Real hardware and .srm-restoring frontends
 * have no such wrinkle. */
static u16 hiscore_load(void) {
    u8 m0, m1, lo, hi, ck;
    SRAM_enableRO();
    m0 = SRAM_readByte(0);
    m1 = SRAM_readByte(1);
    lo = SRAM_readByte(2);
    hi = SRAM_readByte(3);
    ck = SRAM_readByte(4);
    SRAM_disable();
    if (m0 == 'H' && m1 == 'S' && ck == (u8)(lo ^ hi ^ 0xA5))
        return ((u16)hi << 8) | lo;
    return 0;
}

static void hiscore_save(u16 sc) {
    u8 lo = (u8)sc, hi = (u8)(sc >> 8);
    SRAM_enable();
    SRAM_writeByte(0, 'H');
    SRAM_writeByte(1, 'S');
    SRAM_writeByte(2, lo);
    SRAM_writeByte(3, hi);
    SRAM_writeByte(4, (u8)(lo ^ hi ^ 0xA5));
    SRAM_disable();
}

/* Format-on-first-boot: if the magic is absent (fresh battery), write a
 * valid zero record immediately so the save file exists from frame one. */
static void hiscore_init(void) {
    hiscore = hiscore_load();
    if (hiscore == 0) hiscore_save(0);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * DMA-QUEUED TILEMAP WRITES — the board repaint path, and where the
 * Genesis earns its keep for puzzle games. Each well keeps a full tilemap
 * MIRROR in work RAM (24 tile rows x 12 tile cols = 576 bytes of attrs);
 * when game logic dirties a board we rebuild the mirror and queue it with
 * ONE VDP_setTileMapDataRect(..., DMA_QUEUE) call. SYS_doVBlankProcess
 * flushes the queue during vblank, where VRAM bandwidth lives (~7 KB per
 * H40 vblank — both wells together use 1.2 KB, so a worst-case double
 * cascade repaints in ONE frame; the NES version budgets the same repaint
 * across 12). Three rules make it safe:
 *   - the mirror buffers are STATIC: the queue reads them AT FLUSH TIME,
 *     so stack buffers are gone by then, shipping garbage to VRAM;
 *   - everything VRAM-bound in the loop goes through DMA_QUEUE (sprites
 *     too) so writes land in vblank, never mid-scanline;
 *   - the queue holds 80 entries (a rect = one entry per row, so a well
 *     is 24) — flush every frame and you'll never overflow it.
 * Mid-frame VDP_drawTextBG / VDP_fillTileMapRect port writes (HUD numbers,
 * state-change repaints) are FINE on Genesis — the VDP FIFO absorbs them.
 * That freedom is exactly what the NES does not give you. */
static u16 wellmap[2][GRID_H * 2 * GRID_W * 2];   /* 576 bytes per well */

static void queue_board(u8 p) {
    u16 r, c, q, base;
    u16 *m = wellmap[p];
    for (r = 0; r < GRID_H; r++) {
        for (c = 0; c < GRID_W; c++) {
            u8 v = grid[p][r][c];
            base = v ? (u16)(T_GEM + (v - 1) * 4) : T_CELL;
            for (q = 0; q < 4; q++) {            /* column-major quarters */
                u16 tile = v ? (u16)(base + q) : T_CELL;
                m[(r * 2 + (q & 1)) * (GRID_W * 2) + c * 2 + (q >> 1)] =
                    TILE_ATTR_FULL(PAL1, 0, 0, 0, tile);
            }
        }
    }
    VDP_setTileMapDataRect(BG_A, m, well_tx[p], WELL_TY,
                           GRID_W * 2, GRID_H * 2, GRID_W * 2, DMA_QUEUE);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * WINDOW-PLANE HUD — the fixed status bar. The window is a third tilemap
 * that REPLACES plane A wherever it's shown and IGNORES ALL SCROLLING —
 * a hardware-fixed HUD with zero per-frame cost. (The NES needs a sprite-0
 * raster trick for this; on Genesis it's one register.)
 * VDP_setWindowOnTop(2) shows it on the top 2 cell rows; text goes in with
 * VDP_drawTextBG(WINDOW, ...). Two footguns:
 *   - The window only lives at screen edges (top/bottom N rows or left/
 *     right N columns) — it cannot float mid-screen.
 *   - It replaces plane A ONLY: plane B and sprites still render behind/
 *     over it. We paint plane B's top rows with a flat dark band so HUD
 *     text always reads, and the trio sprites never rise above y=24
 *     (rows above the rim are simply not drawn). */
static void hud_init(void) {
    VDP_setWindowOnTop(HUD_ROWS);
}

/* ── GAME LOGIC (clay) — HUD text (window plane, redrawn only on change) ── */
static void draw_u16(VDPPlane plane, u16 v, u16 x, u16 y) {
    char buf[8];
    uintToStr(v, buf, 5);
    VDP_drawTextBG(plane, buf, x, y);
}

static u8 hud_dirty_layout = 1;   /* set when the HUD layout changes (title<->play) */

static void draw_hud(void) {
    char b[2];
    if (state == ST_TITLE) {
        hud_dirty_layout = 1;            /* next play entry repaints its layout */
        VDP_clearTextAreaBG(WINDOW, 0, 0, 40, HUD_ROWS);
        VDP_drawTextBG(WINDOW, "HI", 18, 0);
        draw_u16(WINDOW, hiscore, 21, 0);
        return;
    }
    /* Entering play from the title leaves the title HUD's glyphs behind
     * (different column layout) — clear the row before the play layout, or
     * the leftovers merge into garbage like "HIH0000000". */
    if (hud_dirty_layout) { VDP_clearTextAreaBG(WINDOW, 0, 0, 40, HUD_ROWS); hud_dirty_layout = 0; }
    VDP_drawTextBG(WINDOW, two_player ? "P1" : "SC", 1, 0);
    draw_u16(WINDOW, score[0], 4, 0);
    VDP_drawTextBG(WINDOW, "HI", 16, 0);
    draw_u16(WINDOW, hiscore, 19, 0);
    if (two_player) {
        VDP_drawTextBG(WINDOW, "P2", 30, 0);
        draw_u16(WINDOW, score[1], 33, 0);
    } else {
        VDP_drawTextBG(WINDOW, "LV", 30, 0);
        b[0] = '0' + level; b[1] = 0;
        VDP_drawTextBG(WINDOW, b, 33, 0);
    }
}

/* ── GAME LOGIC (clay) — paint the planes ───────────────────────────────────
 * Plane B (backdrop) is painted ONCE at boot and never touched again.
 * Plane A is repainted on state changes (title text ↔ wells ↔ results);
 * inside the loop only the queued board rects and HUD numbers change. */
static void paint_backdrop(void) {
    VDP_fillTileMapRect(BG_B, TILE_ATTR_FULL(PAL2, 0, 0, 0, T_BAND),
                        0, 0, 64, HUD_ROWS);
    VDP_fillTileMapRect(BG_B, TILE_ATTR_FULL(PAL2, 0, 0, 0, T_BACK),
                        0, HUD_ROWS, 64, 32 - HUD_ROWS);
}

static void paint_frame(u8 p) {
    u16 attr = TILE_ATTR_FULL(PAL1, 0, 0, 0, T_FRAME);
    u16 x0 = well_tx[p] - 1;
    VDP_fillTileMapRect(BG_A, attr, x0, WELL_TY - 1, GRID_W * 2 + 2, 1);
    VDP_fillTileMapRect(BG_A, attr, x0, WELL_TY + GRID_H * 2, GRID_W * 2 + 2, 1);
    VDP_fillTileMapRect(BG_A, attr, x0, WELL_TY, 1, GRID_H * 2);
    VDP_fillTileMapRect(BG_A, attr, x0 + GRID_W * 2 + 1, WELL_TY, 1, GRID_H * 2);
}

static void paint_play(void) {
    VDP_clearPlane(BG_A, TRUE);
    paint_frame(0);
    if (two_player) {
        paint_frame(1);
        VDP_drawTextBG(BG_A, "VS", 19, 14);
    }
    draw_hud();
}

/* ── GAME LOGIC (clay) — the title screen (text on plane A) ── */
static void paint_title(void) {
    VDP_clearPlane(BG_A, TRUE);
    VDP_drawTextBG(BG_A, GAME_TITLE, (40 - (sizeof(GAME_TITLE) - 1)) / 2, 8);
    VDP_drawTextBG(BG_A, "1P START - A", 14, 14);
    VDP_drawTextBG(BG_A, "2P VERSUS - B", 13, 16);
    VDP_drawTextBG(BG_A, "A B ROTATE - C DROP", 10, 20);
    VDP_drawTextBG(BG_A, "CHAINS BESIEGE YOUR RIVAL", 7, 22);
    draw_hud();
}

/* ── GAME LOGIC (clay) — the game-over / results screen ── */
static void paint_over(u8 loser) {
    VDP_clearPlane(BG_A, TRUE);
    if (two_player)
        VDP_drawTextBG(BG_A, loser ? "P1 WINS" : "P2 WINS", 16, 8);
    else
        VDP_drawTextBG(BG_A, "GAME OVER", 15, 8);
    VDP_drawTextBG(BG_A, "P1", 13, 12);
    draw_u16(BG_A, score[0], 17, 12);
    if (two_player) {
        VDP_drawTextBG(BG_A, "P2", 13, 14);
        draw_u16(BG_A, score[1], 17, 14);
    }
    VDP_drawTextBG(BG_A, "HI", 13, 17);
    draw_u16(BG_A, hiscore, 17, 17);
    VDP_drawTextBG(BG_A, "START - TITLE", 13, 21);
}

/* ── GAME LOGIC (clay) — end of game (top-out). `loser` topped out. ── */
static void game_end(u8 loser) {
    u16 best = score[0];
    if (two_player && score[1] > best) best = score[1];
    if (best > hiscore) {
        hiscore = best;
        hiscore_save(hiscore);   /* battery SRAM — see the SRAM idiom    */
    }
    sfx_noise(20);                                /* game-over rumble    */
    state = ST_OVER;
    board_dirty[0] = board_dirty[1] = 0;   /* plane A is the results
                                            * screen now — a stale queued
                                            * board rect would stamp gems
                                            * over it */
    prev_pad[0] = 0xFFFF;                  /* require a fresh press      */
    paint_over(loser);
}

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Match scan: mark every straight run of 3+ same-coloured gems in all 4
 * directions (a cell can belong to several runs — the mask de-dupes), and
 * return how many cells matched. Runs flat-out on the 68000 — no need to
 * smear it across frames like the cc65 version. */
static const s8 DIRS4[4][2] = { {0,1}, {1,0}, {1,1}, {1,-1} };

static u8 mark_and_count(u8 p) {
    u8 r, c, d, len, k, cnt, col;
    s8 dr, dc;
    s16 sr, sc;
    cnt = 0;
    for (r = 0; r < GRID_H; r++)
        for (c = 0; c < GRID_W; c++) matched[r][c] = 0;
    for (r = 0; r < GRID_H; r++) {
        for (c = 0; c < GRID_W; c++) {
            col = grid[p][r][c];
            if (col == EMPTY) continue;
            for (d = 0; d < 4; d++) {
                dr = DIRS4[d][0]; dc = DIRS4[d][1];
                sr = (s16)r - dr; sc = (s16)c - dc;
                if (sr >= 0 && sr < GRID_H && sc >= 0 && sc < GRID_W
                    && grid[p][sr][sc] == col) continue;   /* not the run's start */
                len = 1;
                sr = (s16)r + dr; sc = (s16)c + dc;
                while (sr >= 0 && sr < GRID_H && sc >= 0 && sc < GRID_W
                       && grid[p][sr][sc] == col) { len++; sr += dr; sc += dc; }
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
 * copying gems down to a write cursor, then zero everything above it). */
static void apply_gravity(u8 p) {
    u8 c;
    s16 r, w;
    for (c = 0; c < GRID_W; c++) {
        w = GRID_H - 1;
        for (r = GRID_H - 1; r >= 0; r--) {
            if (grid[p][r][c] != EMPTY) { grid[p][w][c] = grid[p][r][c]; w--; }
        }
        for (; w >= 0; w--) grid[p][w][c] = EMPTY;
    }
}

/* ── GAME LOGIC (clay) — clear matches, drop survivors, chain cascades.
 * Returns the chain depth (0 = the lock matched nothing). */
static u8 resolve_board(u8 p) {
    u8 n, r, c, chain;
    u16 amt;
    chain = 0;
    for (;;) {
        n = mark_and_count(p);
        if (n == 0) break;
        ++chain;
        for (r = 0; r < GRID_H; r++)
            for (c = 0; c < GRID_W; c++)
                if (matched[r][c]) grid[p][r][c] = EMPTY;
        amt = (u16)n * 10;
        if (chain > 1) amt *= chain;             /* cascades pay multiplied */
        if (score[p] < 65000) score[p] += amt;
        /* clear chime — pitch rises with chain depth (smaller divider =
         * higher note on the PSG) */
        sfx_tone(0, (u16)(360 - ((u16)chain << 5)), 10);
        apply_gravity(p);
        board_dirty[p] = 1;
        if (!two_player) {
            cleared_total += n;
            while (level < 9 && cleared_total >= (u16)level * 10) ++level;
        }
        draw_hud();
    }
    return chain;
}

/* ── GAME LOGIC (clay) — VERSUS attack: garbage rows rise from the bottom of
 * the victim's well (random gems with one gap — matchable, so a skilled
 * victim digs out). The victim's stack rising means the falling trio shifts
 * up one to stay board-aligned; if the top row is already occupied, the
 * victim tops out and loses. ── */
static void garbage_insert(u8 v, u8 nrows) {
    u8 k, c, gap;
    s16 r;
    sfx_noise(8);                                /* incoming-garbage thud */
    for (k = 0; k < nrows; k++) {
        for (c = 0; c < GRID_W; c++) {
            if (grid[v][0][c] != EMPTY) { game_end(v); return; }
        }
        for (r = 0; r < GRID_H - 1; r++)
            for (c = 0; c < GRID_W; c++)
                grid[v][r][c] = grid[v][r + 1][c];
        gap = random8() % GRID_W;
        for (c = 0; c < GRID_W; c++)
            grid[v][GRID_H - 1][c] = (c == gap) ? EMPTY : (u8)(1 + random8() % 3);
        if (piece_y[v] > -3) --piece_y[v];       /* keep the trio aligned */
    }
    board_dirty[v] = 1;
}

/* Can the trio occupy column x, rows y..y+2? Cells above the rim are fine
 * (pieces enter from above); below the floor or on a gem is not. */
static u8 can_place(u8 p, s16 x, s16 y) {
    s16 i, cy;
    if (x < 0 || x >= GRID_W) return 0;
    for (i = 0; i < 3; i++) {
        cy = y + i;
        if (cy < 0) continue;
        if (cy >= GRID_H) return 0;
        if (grid[p][cy][x] != EMPTY) return 0;
    }
    return 1;
}

static void spawn_piece(u8 p) {
    piece_x[p] = GRID_W / 2;
    piece_y[p] = -2;
    piece_col[p][0] = (u8)(1 + random8() % 3);
    piece_col[p][1] = (u8)(1 + random8() % 3);
    piece_col[p][2] = (u8)(1 + random8() % 3);
    if (!can_place(p, piece_x[p], piece_y[p])) game_end(p);
}

/* ── GAME LOGIC (clay) — land the trio, resolve, attack, respawn. ── */
static void lock_piece(u8 p) {
    s16 i, y;
    u8 chain;
    for (i = 0; i < 3; i++) {
        y = piece_y[p] + i;
        if (y >= 0) grid[p][y][piece_x[p]] = piece_col[p][i];
    }
    board_dirty[p] = 1;
    sfx_tone(1, 700, 4);                         /* lock thunk            */
    if (piece_y[p] < 0) { game_end(p); return; } /* locked above the rim  */
    chain = resolve_board(p);
    if (state != ST_PLAY) return;
    if (chain && two_player) {
        garbage_insert(p ^ 1, chain > GARBAGE_CAP ? GARBAGE_CAP : chain);
        if (state != ST_PLAY) return;            /* garbage topped them out */
    }
    spawn_piece(p);
}

/* ── GAME LOGIC (clay) — per-player input + gravity. Edge-triggered moves
 * (one cell per press), held DOWN soft-drops, A/B cycle the trio's colours
 * (the classic trio "rotate"), C hard-drops. P2 reads CONTROLLER 2. ── */
static void update_player(u8 p) {
    u16 pad, fresh;
    u8 t, fd;
    pad = JOY_readJoypad(p ? JOY_2 : JOY_1);
    fresh = pad & ~prev_pad[p];
    prev_pad[p] = pad;
    if ((fresh & BUTTON_LEFT) && can_place(p, piece_x[p] - 1, piece_y[p]))
        --piece_x[p];
    if ((fresh & BUTTON_RIGHT) && can_place(p, piece_x[p] + 1, piece_y[p]))
        ++piece_x[p];
    if (fresh & BUTTON_A) {                      /* cycle colours downward */
        t = piece_col[p][2];
        piece_col[p][2] = piece_col[p][1];
        piece_col[p][1] = piece_col[p][0];
        piece_col[p][0] = t;
        sfx_tone(1, 320, 3);
    }
    if (fresh & BUTTON_B) {                      /* cycle colours upward   */
        t = piece_col[p][0];
        piece_col[p][0] = piece_col[p][1];
        piece_col[p][1] = piece_col[p][2];
        piece_col[p][2] = t;
        sfx_tone(1, 280, 3);
    }
    if (fresh & BUTTON_C) {                      /* hard drop              */
        while (can_place(p, piece_x[p], piece_y[p] + 1)) ++piece_y[p];
        lock_piece(p);                           /* may end the game       */
        return;
    }
    if (pad & BUTTON_DOWN) fall_t[p] += 4;       /* soft drop              */
    ++fall_t[p];
    fd = two_player ? VS_FALL_DELAY
                    : (u8)(32 - ((level << 1) + level));      /* 29..5    */
    if (fall_t[p] >= fd) {
        fall_t[p] = 0;
        if (can_place(p, piece_x[p], piece_y[p] + 1))
            ++piece_y[p];
        else
            lock_piece(p);                       /* may end the game       */
    }
}

/* ── GAME LOGIC (clay) — stage this frame's sprites ─────────────────────────
 * Only the falling trios are sprites (locked gems are plane-A tiles): 3
 * SAT slots per player, 16x16 each. Cells above the rim aren't drawn —
 * they'd poke out from under the HUD band. */
#define HIDE_Y (-32)
static void stage_sprites(void) {
    u16 p, i, slot;
    for (p = 0; p < 2; p++) {
        u8 active = (state == ST_PLAY) && (p == 0 || two_player);
        for (i = 0; i < 3; i++) {
            s16 r = piece_y[p] + (s16)i;
            u8 col = piece_col[p][i] ? piece_col[p][i] : 1;
            slot = p * 3 + i;
            if (active && r >= 0)
                VDP_setSprite(slot,
                              (s16)((well_tx[p] + piece_x[p] * 2) << 3),
                              (s16)((WELL_TY + r * 2) << 3),
                              SPRITE_SIZE(2, 2),
                              TILE_ATTR_FULL(PAL1, 1, 0, 0, T_GEM + (col - 1) * 4));
            else
                /* Hidden sprites park at y = -32 (above the screen).
                 * NEVER hide with x = -128..0 — a SAT x of 0 is the VDP's
                 * sprite-masking trigger and silently blanks every lower-
                 * priority sprite on those scanlines. */
                VDP_setSprite(slot, 8, HIDE_Y, SPRITE_SIZE(2, 2),
                              TILE_ATTR_FULL(PAL1, 1, 0, 0, T_GEM));
        }
    }
    /* ── HARDWARE IDIOM (load-bearing) — CHAIN the sprite list before
     * uploading. VDP_setSprite does NOT set the SAT link byte, and link 0
     * means "end of list": skip this and the VDP draws sprite 0 only.
     * VDP_linkSprites(0, 6) links slots 0..5; the queued DMA flushes the
     * 6 SAT entries during vblank. ── */
    VDP_linkSprites(0, 6);
    VDP_updateSprites(6, DMA_QUEUE);
}

/* ── GAME LOGIC (clay) — start a run ── */
static void start_game(u8 versus) {
    u8 p, r, c;
    two_player = versus;
    well_tx[0] = versus ? WELL_VS_P1 : WELL_1P_TX;
    well_tx[1] = WELL_VS_P2;
    /* Stir the PRNG with time-spent-on-title so runs differ. */
    rng ^= (u16)vtimer ^ ((u16)vtimer << 7);
    if (rng == 0) rng = 0xACE1;
    for (p = 0; p < 2; p++) {
        for (r = 0; r < GRID_H; r++)
            for (c = 0; c < GRID_W; c++) grid[p][r][c] = EMPTY;
        fall_t[p] = 0;
        score[p] = 0;
        prev_pad[p] = 0xFFFF;          /* the button that started the game
                                        * shouldn't also rotate the first trio */
    }
    cleared_total = 0;
    level = 1;
    state = ST_PLAY;
    paint_play();
    board_dirty[0] = 1;
    board_dirty[1] = versus;
    spawn_piece(0);
    if (versus) spawn_piece(1);
    sfx_tone(0, 200, 10);                        /* start jingle          */
}

int main(bool hard) {
    u16 pad, fresh;
    (void)hard;

    /* SRAM first — before any VDP work. The save file then exists within
     * the game's first frames of life, which is what lets a frontend (or
     * a headless host) see a non-empty save_ram region as early as
     * possible (see the SRAM idiom note on gpgx's size scan). */
    hiscore_init();

    /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
     * Init order: window size before window text, tiles + palettes before
     * tilemaps that reference them. SGDK's boot already did the dangerous
     * part (VDP regs, Z80, vblank int). No scrolling here, so the scroll
     * mode stays at its boot default — if you add scrolling, set
     * VDP_setScrollingMode FIRST (see the platformer template). */
    hud_init();

    /* Palettes: PAL1 = board + gems + trio sprites, PAL2 = plane B
     * backdrop, PAL0 index 15 = the SGDK font. Colours are BGR, 3 bits
     * per channel: 0x0BGR with E = full. */
    PAL_setColor(15,     0x0EEE);  /* font white                         */
    PAL_setColor(16 + 1, 0x022E);  /* gem 1 ruby                         */
    PAL_setColor(16 + 2, 0x02C2);  /* gem 2 emerald                      */
    PAL_setColor(16 + 3, 0x0E62);  /* gem 3 sapphire                     */
    PAL_setColor(16 + 4, 0x0EEE);  /* gem glint                          */
    PAL_setColor(16 + 5, 0x0222);  /* gem rim                            */
    PAL_setColor(16 + 6, 0x0666);  /* frame steel                        */
    PAL_setColor(16 + 7, 0x0AAA);  /* frame lip                          */
    PAL_setColor(16 + 8, 0x0421);  /* empty-cell speck                   */
    PAL_setColor(16 + 9, 0x0200);  /* well interior near-black           */
    PAL_setColor(32 + 1, 0x0202);  /* backdrop block border              */
    PAL_setColor(32 + 2, 0x0413);  /* backdrop block fill                */
    PAL_setColor(32 + 3, 0x0101);  /* HUD band near-black                */

    VDP_loadTileData(tile_frame, T_FRAME, 1, DMA);
    VDP_loadTileData(tile_cell,  T_CELL,  1, DMA);
    VDP_loadTileData(tile_back,  T_BACK,  1, DMA);
    VDP_loadTileData(tile_band,  T_BAND,  1, DMA);
    build_gem_tiles();
    VDP_loadTileData((u32 *)gem_ram, T_GEM, 12, DMA);   /* 3 colours x 4 */

    paint_backdrop();          /* plane B: painted once                  */
    sfx_init();                /* PSG: sfx channels + background melody  */

    state = ST_TITLE;
    prev_pad[0] = 0xFFFF;
    paint_title();

    while (TRUE) {
        if (state == ST_TITLE) {
            /* ── GAME LOGIC (clay) — title: A/C/START = 1P, B = 2P versus ── */
            stage_sprites();
            pad = JOY_readJoypad(JOY_1);
            fresh = pad & ~prev_pad[0];
            if (fresh & (BUTTON_A | BUTTON_C | BUTTON_START)) start_game(0);
            else if (fresh & BUTTON_B) start_game(1);
            else prev_pad[0] = pad;
            sfx_update();
            SYS_doVBlankProcess();
            continue;
        }

        if (state == ST_OVER) {
            /* Results screen; START or A/C returns to the title. */
            stage_sprites();
            pad = JOY_readJoypad(JOY_1);
            fresh = pad & ~prev_pad[0];
            if (fresh & (BUTTON_START | BUTTON_A | BUTTON_C)) {
                state = ST_TITLE;
                prev_pad[0] = 0xFFFF;  /* swallow the held START          */
                paint_title();
            } else {
                prev_pad[0] = pad;
            }
            sfx_update();
            SYS_doVBlankProcess();
            continue;
        }

        /* ── ST_PLAY ──────────────────────────────────────────────────── */

        /* ── GAME LOGIC (clay — reshape freely) — both players update
         * EVERY frame (simultaneous versus, not alternating turns). Any
         * update can end the game, so re-check state between them. */
        update_player(0);
        if (two_player && state == ST_PLAY) update_player(1);

        if (state == ST_PLAY) {
            /* Queue dirty board repaints — see the DMA-queue idiom. */
            if (board_dirty[0]) { queue_board(0); board_dirty[0] = 0; }
            if (two_player && board_dirty[1]) { queue_board(1); board_dirty[1] = 0; }
        }

        stage_sprites();
        sfx_update();
        SYS_doVBlankProcess();
    }
    return 0;
}
