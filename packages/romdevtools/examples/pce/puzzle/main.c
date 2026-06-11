/* ── main.c — PC Engine falling-trio versus puzzle (complete example game) ─────
 *
 * TUMBLE TIDE — a COMPLETE, working game: title screen, 1P MARATHON mode
 * (levels speed the fall as you clear) and 2P SIMULTANEOUS VERSUS mode — two
 * 6x12 wells side by side, P1 on the stock pad, P2 on the TurboTap's second
 * pad, both falling at once, where every cascade chain you score sends a TIDE
 * of garbage rows rising from the bottom of your rival's well. Score +
 * persistent hi-score (BRAM backup memory), PSG music + SFX.
 *
 * The game: a falling-trio match-3. A vertical trio of pieces drops into a
 * well; LEFT/RIGHT move it, I/II cycle its three colours, DOWN soft-drops,
 * RUN hard-drops. When it lands, any straight run of 3+ same-coloured cells
 * (horizontal, vertical, or diagonal) clears; survivors fall and cascades
 * chain for multiplied score. First stack to reach the rim loses.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented PCE footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — match rules, garbage, tuning, art: reshape freely.
 *
 * What depends on what:
 *   pce_hw.h / pce_video.c / pce_input.c / pce_sound.c — the helper lib
 *     (VDC/VCE/PSG register dances + joypad). The HARDWARE IDIOM markers in
 *     pce_video.c say which parts are load-bearing.
 *   cc65's pce crt0 + pce.lib are auto-linked; the 'rom32k' linker preset
 *     (applied automatically to example projects) gives a 32KB HuCard.
 *
 * 2P, honestly: the stock PC Engine has ONE controller port; 2P needs a
 * TurboTap. The geargrafx core implements the TurboTap and the romdev host
 * now force-ENABLES it (PLATFORM_CORE_OPTIONS pce: geargrafx_turbotap), so a
 * second pad's input reaches the game on pad slot 2 — verified by driving
 * port-1 input and seeing P2 move. So this game ships REAL simultaneous 2P
 * versus. (On real hardware the player plugs a TurboTap and a second pad.)
 *
 * Frame budget (NTSC, 60fps) — and a TEACHING POINT vs the NES version of
 * this game (examples/nes/templates/puzzle.c): on the NES, board repaints
 * squeeze through a ~16-entry vblank queue, so a full-board repaint is
 * BUDGETED across ~12 frames of dirty-row bitmask tricks. The PC Engine has
 * no such famine: the VDC's VRAM write port streams words back-to-back, and a
 * whole well is 24 tile rows x 12 tile cols = 288 BAT words. Two wells + the
 * 6-entry SATB + the HUD all stream inside one vblank with budget to spare —
 * so this version just REPAINTS THE WHOLE DIRTY WELL each time it changes (no
 * dirty-row machinery at all). Same genre, two bandwidth worlds — fork
 * accordingly.
 */
#include <pce.h>
#include <joystick.h>   /* JOY_2 + joy_read for the 2nd pad (TurboTap port 1) */
#include "pce_hw.h"

/* pce_hw.h gives us u8/u16; the match-scan + piece coords need signed types
 * (cells can sit above the rim at negative rows). cc65's int is 16-bit. */
typedef signed char s8;
typedef int         s16;

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "TUMBLE TIDE"

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * VRAM map (WORD addresses — the VDC is a 16-bit-word machine; an 8x8 tile is
 * 16 words, a 16x16 sprite cell is 64). Sprites and BG tiles share one 64KB
 * VRAM, so lay it out ONCE and keep the SATB out of pattern space:
 *   $0000  BAT (32x32 background map — matches vdc_init's VDC_MWR setting)
 *   $1000  font glyphs (38 tiles: blank, 0-9, A-Z, dash)
 *   $1400  board furniture tiles (backdrop, HUD band, frame, empty cell)
 *   $1500  CELL tiles: 3 colours, each its own 8x8 tile (a 16x16 cell is 2x2)
 *   $1800  16x16 trio SPRITE cells: 3 colours
 *   $7F00  shadow SATB destination (satb_dma copies it here, VDC reads it) */
#define BAT_VRAM      0x0000
#define FONT_VRAM     0x1000
#define BACK_VRAM     0x1400   /* solid colour 1 — cabinet backdrop          */
#define BAND_VRAM     0x1410   /* solid colour 2 — band behind the HUD text  */
#define FRAME_VRAM    0x1420   /* solid colour 3 — well border               */
#define INNER_VRAM    0x1430   /* near-black well interior + faint speck     */
#define CELL0_VRAM    0x1500   /* locked-cell BG tile, colour A (8x8)        */
#define CELL1_VRAM    0x1510   /* locked-cell BG tile, colour B              */
#define CELL2_VRAM    0x1520   /* locked-cell BG tile, colour C              */
#define SPR0_VRAM     0x1800   /* 16x16 falling-trio sprite, colour A        */
#define SPR1_VRAM     0x1840   /* 16x16 falling-trio sprite, colour B        */
#define SPR2_VRAM     0x1880   /* 16x16 falling-trio sprite, colour C        */

#define BAT_ENTRY(pal, vram)  ((u16)(((pal) << 12) | ((vram) >> 4)))

/* Sprite pattern codes = VRAM >> 6 (the 16x16 cell index). */
#define SPR_PAT(c)   ((u16)((SPR0_VRAM >> 6) + (c)))   /* colour 0..2 */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Board geometry. Cells are 16x16 px (2x2 BAT tiles) — the PCE 256x224 screen
 * has room to spare; chunky cells read better than 8-px ones. The BAT is
 * 32 tiles wide; a 12-wide well (6 cells x 2 tiles) fits twice for the split
 * board. Tile rows 0-1 sit under the HUD band; well interiors start at row 3. */
#define GRID_W   6
#define GRID_H   12
#define WELL_TR  3             /* top TILE row of the well interior          */
#define WELL_1P_TC 10          /* 1P: single centered well (tiles 10-21)     */
#define WELL_VS_P1  2          /* 2P: P1 interior tiles 2-13 ...             */
#define WELL_VS_P2 18          /*     P2 interior tiles 18-29 (split board)  */
#define HUD_ROWS    2          /* BAT rows reserved for the HUD band         */

#define EMPTY 0                /* cell colours 1..3 = amber/teal/magenta     */

/* SATB slot plan: 3 trio sprites per player (slot order = priority). */
#define SLOT_TRIO(p, i)  (u8)((p) * 3 + (i))
#define OFFSCREEN_Y  0x1F0     /* park hidden sprites below the display       */
/* Each trio colour gets its OWN sprite sub-palette (1/2/3) so the falling
 * pieces show their three distinct hues, matching the locked-board cells. */
#define PAL_TRIO(col)  (u8)(col)   /* colour 1..3 -> sprite sub-palette 1..3 */

/* ── GAME LOGIC (clay — reshape freely) ── game state ── */
static u8  grid[2][GRID_H][GRID_W];   /* the two wells (P2's unused in 1P)  */
static s16 piece_x[2];                /* falling trio: column 0..5          */
static s16 piece_y[2];                /* row of its TOP cell (<0 above rim) */
static u8  piece_col[2][3];           /* trio colours, top to bottom        */
static u16 score[2];
static u16 hiscore;
static u8  level;                     /* 1P: 1..9, speeds up the fall       */
static u8  state;                     /* ST_TITLE / ST_PLAY / ST_OVER       */
static u8  two_player;

static u8  matched[GRID_H][GRID_W];
static u8  well_tc[2];                 /* left interior TILE column per well */
static u8  fall_t[2];                  /* frames until next gravity step     */
static u8  prev_pad[2];                /* for edge-triggered input           */
static u16 cleared_total;              /* 1P: cells cleared, drives the level */
static u8  board_dirty[2];             /* well needs a repaint this frame    */
static u8  loser;                      /* who topped out (2P result text)    */
static u16 rng = 0xACE1;
static u8  sfx_timer;
static u8  hud_dirty;

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2

#define VS_FALL_DELAY 24           /* 2P: fixed gravity (frames per row)   */
#define GARBAGE_CAP   4            /* max garbage rows per attack          */

static u16 tile_buf[16];           /* scratch for one 8x8 tile             */
static u16 spr_buf[64];            /* scratch for one 16x16 sprite cell    */

/* ── GAME LOGIC (clay) — 5x7 glyph font: blank, 0-9, A-Z, dash ──────────────
 * Each glyph is 7 rows of 5 bits (bit4 = leftmost). upload_font() expands
 * them into 8x8 1-plane tiles; drawn with BG sub-palette 1 (white). */
#define G_BLANK 0
#define G_DIGIT 1          /* '0'..'9' -> glyphs 1..10                       */
#define G_ALPHA 11         /* 'A'..'Z' -> glyphs 11..36                      */
#define G_DASH  37
#define NUM_GLYPHS 38

static const u8 FONT5x7[NUM_GLYPHS][7] = {
    {0,0,0,0,0,0,0},
    {0x0E,0x11,0x13,0x15,0x19,0x11,0x0E}, {0x04,0x0C,0x04,0x04,0x04,0x04,0x0E},
    {0x0E,0x11,0x01,0x02,0x04,0x08,0x1F}, {0x1F,0x02,0x04,0x02,0x01,0x11,0x0E},
    {0x02,0x06,0x0A,0x12,0x1F,0x02,0x02}, {0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E},
    {0x06,0x08,0x10,0x1E,0x11,0x11,0x0E}, {0x1F,0x01,0x02,0x04,0x08,0x08,0x08},
    {0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E}, {0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C},
    {0x0E,0x11,0x11,0x1F,0x11,0x11,0x11}, {0x1E,0x11,0x11,0x1E,0x11,0x11,0x1E},
    {0x0E,0x11,0x10,0x10,0x10,0x11,0x0E}, {0x1E,0x11,0x11,0x11,0x11,0x11,0x1E},
    {0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F}, {0x1F,0x10,0x10,0x1E,0x10,0x10,0x10},
    {0x0E,0x11,0x10,0x17,0x11,0x11,0x0F}, {0x11,0x11,0x11,0x1F,0x11,0x11,0x11},
    {0x0E,0x04,0x04,0x04,0x04,0x04,0x0E}, {0x07,0x02,0x02,0x02,0x02,0x12,0x0C},
    {0x11,0x12,0x14,0x18,0x14,0x12,0x11}, {0x10,0x10,0x10,0x10,0x10,0x10,0x1F},
    {0x11,0x1B,0x15,0x15,0x11,0x11,0x11}, {0x11,0x19,0x15,0x13,0x11,0x11,0x11},
    {0x0E,0x11,0x11,0x11,0x11,0x11,0x0E}, {0x1E,0x11,0x11,0x1E,0x10,0x10,0x10},
    {0x0E,0x11,0x11,0x11,0x15,0x12,0x0D}, {0x1E,0x11,0x11,0x1E,0x14,0x12,0x11},
    {0x0F,0x10,0x10,0x0E,0x01,0x01,0x1E}, {0x1F,0x04,0x04,0x04,0x04,0x04,0x04},
    {0x11,0x11,0x11,0x11,0x11,0x11,0x0E}, {0x11,0x11,0x11,0x11,0x11,0x0A,0x04},
    {0x11,0x11,0x11,0x15,0x15,0x15,0x0A}, {0x11,0x11,0x0A,0x04,0x0A,0x11,0x11},
    {0x11,0x11,0x0A,0x04,0x04,0x04,0x04}, {0x1F,0x01,0x02,0x04,0x08,0x10,0x1F},
    {0x00,0x00,0x00,0x1F,0x00,0x00,0x00},
};

/* ── GAME LOGIC (clay) — a 16x16 round-cell mask (16 rows × 16 bits, bit15
 * leftmost). The falling-trio sprites use this whole; one piece of art, three
 * colours (the colour is the PALETTE, not the bits). */
static const u16 cell_mask[16] = {
    0x07E0, 0x1FF8, 0x3FFC, 0x7E7E, 0x7C3E, 0xFC3F, 0xFFFF, 0xFFFF,
    0xFFFF, 0xFFFF, 0xFC3F, 0x7C3E, 0x7E7E, 0x3FFC, 0x1FF8, 0x07E0
};

/* ── GAME LOGIC (clay) — tile/sprite builders ────────────────────────────── */
static void make_solid_tile(u16 *t, u8 ci) {
    u8 r;
    u8 p0 = (ci & 1) ? 0xFF : 0x00;
    u8 p1 = (ci & 2) ? 0xFF : 0x00;
    for (r = 0; r < 8; ++r) {
        t[r]     = (u16)(p0 | (p1 << 8));
        t[r + 8] = 0;
    }
}

/* one-colour 16x16 sprite cell from a 16-row mask (colour = plane0 → index 1) */
static void make_sprite16(u16 vram, const u16 *mask) {
    u8 r;
    for (r = 0; r < 64; ++r) spr_buf[r] = 0;
    for (r = 0; r < 16; ++r) spr_buf[r] = mask[r];   /* plane 0 → colour 1 */
    load_tiles(vram, spr_buf, 64);
}

/* A locked-board cell is a chunky 8x8 "pip" tile (a 16x16 cell is 2x2 of it):
 * a filled colour-1 square with a dark 1-px rim on every edge so adjacent
 * cells read as separate pieces. The colour is the PALETTE, not the bits. */
static void make_cell_tile(u16 *t) {
    u8 r;
    for (r = 0; r < 8; ++r) {
        u16 fill = 0x00FF;                 /* plane0 all set → colour 1       */
        if (r == 0 || r == 7) fill = 0;    /* clear top/bottom rim rows       */
        else fill &= 0x007E;               /* clear left+right edge columns    */
        t[r]     = fill;
        t[r + 8] = 0;
    }
}

static void upload_font(void) {
    u8 g, row, bits, px;
    for (g = 0; g < NUM_GLYPHS; ++g) {
        for (row = 0; row < 16; ++row) tile_buf[row] = 0;
        for (row = 0; row < 7; ++row) {
            bits = FONT5x7[g][row];
            px = 0;
            if (bits & 0x10) px |= 0x40;
            if (bits & 0x08) px |= 0x20;
            if (bits & 0x04) px |= 0x10;
            if (bits & 0x02) px |= 0x08;
            if (bits & 0x01) px |= 0x04;
            tile_buf[row] = (u16)px;
        }
        load_tiles((u16)(FONT_VRAM + g * 16), tile_buf, 16);
    }
}

static void upload_art(void) {
    upload_font();
    make_solid_tile(tile_buf, 1); load_tiles(BACK_VRAM, tile_buf, 16);
    make_solid_tile(tile_buf, 2); load_tiles(BAND_VRAM, tile_buf, 16);
    make_solid_tile(tile_buf, 3); load_tiles(FRAME_VRAM, tile_buf, 16);
    /* well interior: near-black colour-1 with one faint colour-3 speck */
    make_solid_tile(tile_buf, 1); tile_buf[4] |= 0x1000; tile_buf[4 + 8] = 0x1000;
    load_tiles(INNER_VRAM, tile_buf, 16);
    /* one cell tile shape, reused for all three colours (palette gives hue) */
    make_cell_tile(tile_buf);
    load_tiles(CELL0_VRAM, tile_buf, 16);
    load_tiles(CELL1_VRAM, tile_buf, 16);
    load_tiles(CELL2_VRAM, tile_buf, 16);
    make_sprite16(SPR0_VRAM, cell_mask);
    make_sprite16(SPR1_VRAM, cell_mask);
    make_sprite16(SPR2_VRAM, cell_mask);
}

/* cell colour 1..3 → its locked-board BG tile VRAM */
static u16 cell_vram(u8 col) {
    return (col == 1) ? CELL0_VRAM : (col == 2) ? CELL1_VRAM : CELL2_VRAM;
}

/* ── GAME LOGIC (clay) — BAT text + board paint ──────────────────────────── */
static void put_glyph(u8 col, u8 row, u8 glyph) {
    u16 e = BAT_ENTRY(1, (u16)(FONT_VRAM + glyph * 16));  /* pal 1 = white   */
    vram_set_write_addr((u16)(BAT_VRAM + row * 32 + col));
    VDC_DATA_LO = (u8)(e & 0xFF);
    VDC_DATA_HI = (u8)(e >> 8);
}

static void put_tile(u8 col, u8 row, u16 e) {
    vram_set_write_addr((u16)(BAT_VRAM + row * 32 + col));
    VDC_DATA_LO = (u8)(e & 0xFF);
    VDC_DATA_HI = (u8)(e >> 8);
}

static void draw_text(u8 col, u8 row, const char *s) {
    u8 c;
    while ((c = (u8)*s++) != 0) {
        u8 g = G_BLANK;
        if (c >= '0' && c <= '9') g = (u8)(G_DIGIT + c - '0');
        else if (c >= 'A' && c <= 'Z') g = (u8)(G_ALPHA + c - 'A');
        else if (c == '-') g = G_DASH;
        put_glyph(col++, row, g);
    }
}

static void draw_num5(u8 col, u8 row, u16 v) {
    u8 i, d[5];
    for (i = 0; i < 5; ++i) { d[i] = (u8)(v % 10); v /= 10; }
    for (i = 0; i < 5; ++i) put_glyph((u8)(col + i), row, (u8)(G_DIGIT + d[4 - i]));
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * WHOLE-BOARD BAT REPAINT — the PCE's puzzle bandwidth, the inverse of the
 * NES famine. A locked cell is two-by-two of one BG tile (on its own colour
 * sub-palette); an empty cell is two-by-two of the INNER tile. When a board
 * changes we simply rewrite ALL 24x12 of its BAT entries — 288 word writes
 * straight at the VDC's VWR port (vram_set_write_addr arms the auto-
 * incrementing address, then we stream). The whole well streams in well under
 * a vblank; both wells + the SATB + HUD fit one frame. The NES version of THIS
 * GAME budgets the same repaint across ~12 frames through a 16-entry queue —
 * the PCE just blasts it. Two rules:
 *   - do the streaming inside the vblank window (we repaint just after
 *     waitvsync()), so the VDC isn't fetching the BAT for display mid-write;
 *   - keep the SATB-DMA after the BAT writes — both share the VDC and the DMA
 *     wants the address latch left where it expects it.
 *
 * requires: BAT 32x32 (vdc_init's MWR); well within the 32-wide BAT (it is:
 *   the split board uses tiles 2-13 and 18-29). */
static void paint_board(u8 p) {
    u8 r, c, tr, tc;
    u16 e_inner = BAT_ENTRY(0, INNER_VRAM);
    u8 left = well_tc[p];
    for (r = 0; r < GRID_H; r++) {
        for (c = 0; c < GRID_W; c++) {
            u8 col = grid[p][r][c];
            /* each locked colour gets its own BG sub-palette (3/4/5) so the
             * one cell-tile shape (all pixels colour index 1) renders three
             * distinct hues; empty interior uses sub-palette 0 (backdrop). */
            u16 e = col ? BAT_ENTRY(2 + col, cell_vram(col)) : e_inner;
            tr = (u8)(WELL_TR + r * 2);
            tc = (u8)(left + c * 2);
            put_tile(tc,            tr,            e);   /* 2x2 of the cell tile */
            put_tile((u8)(tc + 1),  tr,            e);
            put_tile(tc,            (u8)(tr + 1),  e);
            put_tile((u8)(tc + 1),  (u8)(tr + 1),  e);
        }
    }
}

static void paint_frame(u8 p) {
    u8 r, tr, c;
    u16 e = BAT_ENTRY(0, FRAME_VRAM);
    u8 x0 = (u8)(well_tc[p] - 1);
    u8 w  = (u8)(GRID_W * 2 + 2);
    /* top + bottom rails */
    for (c = 0; c < w; c++) {
        put_tile((u8)(x0 + c), (u8)(WELL_TR - 1), e);
        put_tile((u8)(x0 + c), (u8)(WELL_TR + GRID_H * 2), e);
    }
    /* side rails */
    for (r = 0; r < GRID_H * 2; r++) {
        tr = (u8)(WELL_TR + r);
        put_tile(x0, tr, e);
        put_tile((u8)(x0 + GRID_W * 2 + 1), tr, e);
    }
}

/* Fill the whole 32x32 BAT: HUD band on the top rows, backdrop below. */
static void paint_backdrop(void) {
    u8 r, c;
    u16 band = BAT_ENTRY(0, BAND_VRAM);
    u16 back = BAT_ENTRY(0, BACK_VRAM);
    for (r = 0; r < 32; r++) {
        vram_set_write_addr((u16)(BAT_VRAM + r * 32));
        for (c = 0; c < 32; c++) {
            u16 e = (r < HUD_ROWS) ? band : back;
            VDC_DATA_LO = (u8)(e & 0xFF);
            VDC_DATA_HI = (u8)(e >> 8);
        }
    }
}

/* HUD: row 0 = "SC 00000  HI 00000  LV 1" (1P) or "P1 .. HI .. P2 .." (2P). */
static void draw_hud(void) {
    u8 i;
    /* clear the HUD text row before repainting (band tile under the glyphs) */
    for (i = 0; i < 32; i++) put_tile(i, 0, BAT_ENTRY(0, BAND_VRAM));
    if (state == ST_TITLE) {
        draw_text(13, 0, "HI");
        draw_num5(16, 0, hiscore);
        return;
    }
    if (two_player) {
        draw_text(1, 0, "P1");
        draw_num5(4, 0, score[0]);
        draw_text(12, 0, "HI");
        draw_num5(15, 0, hiscore);
        draw_text(24, 0, "P2");
        draw_num5(27, 0, score[1]);
    } else {
        draw_text(1, 0, "SC");
        draw_num5(4, 0, score[0]);
        draw_text(12, 0, "HI");
        draw_num5(15, 0, hiscore);
        draw_text(24, 0, "LV");
        put_glyph(27, 0, (u8)(G_DIGIT + level));
    }
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * BRAM hi-score persistence. The PCE's battery save is the 2KB "backup RAM"
 * at BANK $F7 (the Tennokoe / CD-interface memory) — geargrafx exposes it as
 * the libretro save_ram region, so it persists across power cycles. Two
 * dances are required, and both are footguns:
 *
 *   1. BANK MAPPING. BRAM is not in the CPU's address space until you TAM
 *      bank $F7 into a free MPR slot. cc65's inline asm() only knows 6502
 *      mnemonics — TAM/TMA are HuC6280-only and it REJECTS them — so the two
 *      5-byte mapper thunks below are hand-assembled machine code in RAM
 *      arrays, called through a function pointer:
 *        A9 F7   LDA #$F7
 *        53 04   TAM #%00000100   ; MPR2: $4000-$5FFF = bank $F7 (BRAM)
 *        60      RTS
 *      (MPR2 is free here: cc65's crt0 only assigns MPR0/1/4-7.)
 *   2. THE WRITE LOCK. BRAM powers up WRITE-PROTECTED. Writes are silently
 *      discarded until you store $80 to $1807; store $00 to re-lock after.
 *      Forgetting the unlock is the classic "my save never sticks" bug.
 *
 * Real BRAM is SHARED by every CD-era game and managed by the System Card
 * BIOS as a directory ('HUBM' header + per-game entries). A HuCard homebrew
 * has no BIOS to call, so this example keeps one fixed checksummed record at
 * a fixed offset instead — honest and verifiable, but DON'T ship that scheme
 * on real hardware next to CD saves you care about.
 *
 * requires: nothing else touches MPR2; record layout below.              */
static unsigned char bram_map_thunk[5]   = { 0xA9, 0xF7, 0x53, 0x04, 0x60 };
static unsigned char bram_unmap_thunk[5] = { 0xA9, 0xF8, 0x53, 0x04, 0x60 };

#define BRAM_LOCK_REG (*(volatile u8 *)0x1807)
#define BRAM_BASE     ((volatile u8 *)0x4000)
/* record: offset 16 = 'O','S', score lo, score hi, checksum (lo^hi^0xA5) */
#define HS_OFF 16

static void bram_map(void)   { ((void (*)(void))bram_map_thunk)(); }
static void bram_unmap(void) { ((void (*)(void))bram_unmap_thunk)(); }

static u16 hiscore_load(void) {
    u16 v = 0;
    bram_map();
    if (BRAM_BASE[HS_OFF] == 'O' && BRAM_BASE[HS_OFF + 1] == 'S' &&
        BRAM_BASE[HS_OFF + 4] == (u8)(BRAM_BASE[HS_OFF + 2] ^ BRAM_BASE[HS_OFF + 3] ^ 0xA5)) {
        v = (u16)(BRAM_BASE[HS_OFF + 2] | (BRAM_BASE[HS_OFF + 3] << 8));
    }
    bram_unmap();
    return v;
}

static void hiscore_save(u16 v) {
    bram_map();
    BRAM_LOCK_REG = 0x80;                  /* unlock writes — see footgun #2 */
    BRAM_BASE[HS_OFF]     = 'O';
    BRAM_BASE[HS_OFF + 1] = 'S';
    BRAM_BASE[HS_OFF + 2] = (u8)(v & 0xFF);
    BRAM_BASE[HS_OFF + 3] = (u8)(v >> 8);
    BRAM_BASE[HS_OFF + 4] = (u8)((v & 0xFF) ^ (v >> 8) ^ 0xA5);
    BRAM_LOCK_REG = 0x00;                  /* re-lock                        */
    bram_unmap();
}

/* ── GAME LOGIC (clay) — music: a 2-channel tune ticked once per frame ──────
 * PSG channel plan: 5 = melody, 4 = bass, 2/3 = SFX (tones cut by sfx_timer).
 * PCE frequency regs are DIVIDERS: pitch ≈ 3.58MHz / (32 × value), so a
 * BIGGER number is a LOWER note. Note indices into NOTE_DIV below. */
enum { R = 0, A2N, C3, F3, G3, A3, B3, C4, D4, E4, F4, G4, A4, B4, C5, D5, E5 };
static const u16 NOTE_DIV[17] = {
    0, 1017, 854, 641, 571, 508, 453, 427, 381, 339, 320, 285, 254, 226, 214, 190, 170
};
/* 16 melody steps + 8 bass steps (one bass note per 2 melody steps) */
static const u8 MEL_TITLE[16] = { A3,C4,E4,A4, G4,E4,C4,E4, F4,A4,C5,A4, G4,E4,D4,C4 };
static const u8 BAS_TITLE[8]  = { A2N,A2N, F3,F3, C3,C3, G3,G3 };
static const u8 MEL_PLAY[16]  = { C4,E4,G4,E4, D4,F4,A4,F4, E4,G4,C5,G4, A4,G4,E4,R  };
static const u8 BAS_PLAY[8]   = { C3,C3, F3,F3, A2N,A2N, G3,G3 };
static const u8 MEL_OVER[16]  = { C5,R,A4,R, F4,R,E4,R, D4,R,C4,R, A2N,R,R,R };

static u8 music_song;          /* reuses the ST_* ids                        */
static u8 music_step, music_timer, music_done;

static void music_set(u8 song) {
    music_song = song;
    music_step = 0;
    music_timer = 0;
    music_done = 0;
    psg_off(4);
    psg_off(5);
}

static void music_tick(void) {
    const u8 *mel;
    u8 n;
    if (music_done) return;
    if (music_timer == 0) {
        mel = (music_song == ST_PLAY) ? MEL_PLAY
            : (music_song == ST_OVER) ? MEL_OVER : MEL_TITLE;
        n = mel[music_step & 15];
        if (n != R) psg_tone(5, NOTE_DIV[n], 26);
        else psg_off(5);
        if (music_song != ST_OVER) {       /* the game-over jingle has no bass */
            n = ((music_step & 1) == 0)
                ? ((music_song == ST_PLAY) ? BAS_PLAY[(music_step >> 1) & 7]
                                           : BAS_TITLE[(music_step >> 1) & 7])
                : R;
            if (n != R) psg_tone(4, NOTE_DIV[n], 20);
        }
        ++music_step;
        if (music_song == ST_OVER && music_step >= 16) {  /* play once, stop */
            music_done = 1;
            psg_off(4);
            psg_off(5);
        }
    }
    ++music_timer;
    if (music_timer >= 9) music_timer = 0;
}

/* short SFX on channels 2/3, auto-cut by sfx_timer */
static void sfx(u8 chan, u16 freq, u8 frames) {
    psg_tone(chan, freq, 31);
    if (frames > sfx_timer) sfx_timer = frames;
}

/* ── GAME LOGIC (clay) — xorshift16 PRNG ── */
static u8 random8(void) {
    u16 r = rng;
    r ^= r << 7;
    r ^= r >> 9;
    r ^= r << 8;
    rng = r;
    return (u8)r;
}

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Match scan: mark every straight run of 3+ same-coloured cells in all 4
 * directions (a cell can belong to several runs — the mask de-dupes), and
 * return how many cells matched. Runs flat-out on the HuC6280 — no need to
 * smear it across frames like the cc65 NES version's queue dance. */
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

/* Collapse each column so survivors rest on the floor. */
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

/* ── GAME LOGIC (clay) — end of game (top-out). `who` topped out. ── */
static void game_end(u8 who) {
    u16 best = score[0];
    if (two_player && score[1] > best) best = score[1];
    if (best > hiscore) {
        hiscore = best;
        hiscore_save(hiscore);   /* BRAM — survives a power cycle */
    }
    loser = who;
    sfx(3, 0x500, 24);                              /* game-over rumble */
    state = ST_OVER;
    board_dirty[0] = board_dirty[1] = 0;
    prev_pad[0] = prev_pad[1] = 0xFF;               /* require a fresh press */
    /* paint the result screen onto the BAT */
    paint_backdrop();
    if (two_player)
        draw_text(13, 8, loser ? "P1 WINS" : "P2 WINS");
    else
        draw_text(12, 8, "GAME OVER");
    draw_text(11, 12, "P1");
    draw_num5(15, 12, score[0]);
    if (two_player) {
        draw_text(11, 14, "P2");
        draw_num5(15, 14, score[1]);
    }
    draw_text(11, 17, "HI");
    draw_num5(15, 17, hiscore);
    draw_text(9, 21, "RUN - TITLE");
    music_set(ST_OVER);
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
        if (score[p] < 65000u) score[p] += amt;
        /* clear chime — pitch rises with chain depth (smaller divider) */
        sfx(2, (u16)(0x140 - ((u16)chain << 4)), 8);
        apply_gravity(p);
        board_dirty[p] = 1;
        if (!two_player) {
            cleared_total += n;
            while (level < 9 && cleared_total >= (u16)level * 10) ++level;
        }
        hud_dirty = 1;
    }
    return chain;
}

/* ── GAME LOGIC (clay) — VERSUS attack: garbage rows rise from the bottom of
 * the victim's well (random cells with one gap — matchable, so a skilled
 * victim digs out). The victim's stack rising means the falling trio shifts
 * up one to stay board-aligned; if the top row is already occupied, the
 * victim tops out and loses. ── */
static void garbage_insert(u8 v, u8 nrows) {
    u8 k, c, gap;
    s16 r;
    sfx(3, 0x300, 8);                            /* incoming-garbage thud */
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

/* Can the trio occupy column x, rows y..y+2? Cells above the rim are fine. */
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
    sfx(2, 0x300, 4);                            /* lock thunk            */
    if (piece_y[p] < 0) { game_end(p); return; } /* locked above the rim  */
    chain = resolve_board(p);
    if (state != ST_PLAY) return;
    if (chain && two_player) {
        garbage_insert((u8)(p ^ 1), chain > GARBAGE_CAP ? GARBAGE_CAP : chain);
        if (state != ST_PLAY) return;            /* garbage topped them out */
    }
    spawn_piece(p);
}

/* ── GAME LOGIC (clay) — per-player input + gravity. Edge-triggered moves
 * (one cell per press), held DOWN soft-drops, I/II cycle the trio's colours
 * (the classic trio "rotate"), RUN hard-drops. ── */
static void update_player(u8 p, u8 pad) {
    u8 fresh, fd, t;
    fresh = (u8)(pad & ~prev_pad[p]);
    prev_pad[p] = pad;
    if ((fresh & PCE_JOY_LEFT) && can_place(p, piece_x[p] - 1, piece_y[p]))
        --piece_x[p];
    if ((fresh & PCE_JOY_RIGHT) && can_place(p, piece_x[p] + 1, piece_y[p]))
        ++piece_x[p];
    if (fresh & PCE_JOY_I) {                      /* cycle colours downward */
        t = piece_col[p][2];
        piece_col[p][2] = piece_col[p][1];
        piece_col[p][1] = piece_col[p][0];
        piece_col[p][0] = t;
        sfx(2, 0x140, 3);
    }
    if (fresh & PCE_JOY_II) {                     /* cycle colours upward   */
        t = piece_col[p][0];
        piece_col[p][0] = piece_col[p][1];
        piece_col[p][1] = piece_col[p][2];
        piece_col[p][2] = t;
        sfx(2, 0x120, 3);
    }
    if (fresh & PCE_JOY_RUN) {                    /* hard drop              */
        while (can_place(p, piece_x[p], piece_y[p] + 1)) ++piece_y[p];
        lock_piece(p);                           /* may end the game       */
        return;
    }
    if (pad & PCE_JOY_DOWN) fall_t[p] += 4;       /* soft drop              */
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
 * Only the falling trios are sprites (locked cells are BAT tiles): 3 SATB
 * slots per player, 16x16 each. Cells above the rim aren't drawn — they'd
 * poke out from under the HUD band. */
static void push_sprites(void) {
    u8 p, i;
    for (p = 0; p < 2; p++) {
        u8 active = (state == ST_PLAY) && (p == 0 || two_player);
        for (i = 0; i < 3; i++) {
            s16 r = piece_y[p] + (s16)i;
            u8 col = piece_col[p][i] ? piece_col[p][i] : 1;
            u8 slot = SLOT_TRIO(p, i);
            if (active && r >= 0) {
                u16 x = (u16)((well_tc[p] + piece_x[p] * 2) * 8);
                u16 y = (u16)((WELL_TR + r * 2) * 8);
                set_sprite(slot, x, y, SPR_PAT((u16)(col - 1)), PAL_TRIO(col));
            } else {
                set_sprite(slot, 0, OFFSCREEN_Y, SPR_PAT(0), PAL_TRIO(1));
            }
        }
    }
}

/* ── GAME LOGIC (clay) — screen painters (full BAT repaint per state change) ── */
static void paint_title(void) {
    paint_backdrop();
    draw_text((u8)((32 - (sizeof(GAME_TITLE) - 1)) / 2), 8, GAME_TITLE);
    draw_text(10, 13, "1P RUN - I");
    draw_text(10, 15, "2P VS - II");
    draw_text(8, 19, "I II ROTATE RUN DROP");
    draw_text(6, 22, "CHAINS FLOOD YOUR RIVAL");
    draw_hud();
}

static void paint_play(void) {
    paint_backdrop();
    paint_frame(0);
    paint_board(0);
    if (two_player) {
        paint_frame(1);
        paint_board(1);
        draw_text(15, 14, "VS");
    }
    draw_hud();
}

/* ── GAME LOGIC (clay) — start a run ── */
static void start_game(u8 versus) {
    u8 p, r, c;
    two_player = versus;
    well_tc[0] = versus ? WELL_VS_P1 : WELL_1P_TC;
    well_tc[1] = WELL_VS_P2;
    if (rng == 0) rng = 0xACE1;
    for (p = 0; p < 2; p++) {
        for (r = 0; r < GRID_H; r++)
            for (c = 0; c < GRID_W; c++) grid[p][r][c] = EMPTY;
        fall_t[p] = 0;
        score[p] = 0;
        prev_pad[p] = 0xFF;          /* the button that started the game
                                      * shouldn't also rotate the first trio */
    }
    cleared_total = 0;
    level = 1;
    state = ST_PLAY;
    board_dirty[0] = 1;
    board_dirty[1] = versus;
    paint_play();
    music_set(ST_PLAY);
    sfx(2, 0x180, 6);                            /* start blip            */
    spawn_piece(0);
    if (versus) spawn_piece(1);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * 2P INPUT via the TurboTap. pce_joy_read() reads pad 1 (slot 0). For pad 2 we
 * read cc65's JOY_2 directly and translate it to the same clean PCE bitmask
 * pce_input.c builds for pad 1. The host force-enables the TurboTap core
 * option, so JOY_2 carries real port-1 input; without that override port 1 is
 * dead and this would silently fall back to 1P. ── */
static u8 read_pad2(void) {
    u8 raw = joy_read(JOY_2);
    u8 m = 0;
    if (JOY_UP(raw))    m |= PCE_JOY_UP;
    if (JOY_DOWN(raw))  m |= PCE_JOY_DOWN;
    if (JOY_LEFT(raw))  m |= PCE_JOY_LEFT;
    if (JOY_RIGHT(raw)) m |= PCE_JOY_RIGHT;
    if (JOY_BTN_1(raw)) m |= PCE_JOY_I;
    if (JOY_BTN_2(raw)) m |= PCE_JOY_II;
    if (JOY_BTN_3(raw)) m |= PCE_JOY_SELECT;
    if (JOY_BTN_4(raw)) m |= PCE_JOY_RUN;
    return m;
}

void main(void) {
    u8 pad1, pad2, newpad;

    _pce_keep[0] = 0;   /* see the EMPTY-BSS TRAP note in pce_hw.h */

    /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
     * Init order: palette → VRAM uploads → BAT paint → joypad → display ON.
     * disp_enable() also sets the VBlank IRQ bit — without it waitvsync()
     * never returns and the game freezes on its first frame. */
    /* BG sub-pal 0: backdrop/frame/interior + text-on-band. BG sub-pal 1:
     * HUD/text (white). BG sub-pal 3: the three locked-cell hues. */
    vce_set_color(0,   PCE_RGB(0, 0, 1));   /* backdrop: near-black blue     */
    vce_set_color(1,   PCE_RGB(1, 1, 2));   /* cabinet block                 */
    vce_set_color(2,   PCE_RGB(1, 1, 1));   /* HUD band: dark grey           */
    vce_set_color(3,   PCE_RGB(4, 4, 5));   /* well frame: steel             */
    vce_set_color(17,  PCE_RGB(7, 7, 7));   /* pal1 text: white              */
    /* locked cells: one tile shape (colour index 1) on three BG sub-palettes
     * (3/4/5) → three hues. Entry = sub-palette*16 + 1. */
    vce_set_color(3 * 16 + 1, PCE_RGB(7, 5, 0));  /* pal3 c1: amber          */
    vce_set_color(4 * 16 + 1, PCE_RGB(0, 6, 5));  /* pal4 c1: teal           */
    vce_set_color(5 * 16 + 1, PCE_RGB(7, 1, 6));  /* pal5 c1: magenta        */
    /* sprite sub-palettes (256 + pal*16 + index) — the falling trio mirrors
     * the locked-cell hues, one sub-palette per colour so all three trio
     * colours are visible (push_sprites selects PAL_TRIO(col) per cell). */
    vce_set_color(256 + 1 * 16 + 1, PCE_RGB(7, 5, 0));  /* spr pal1 c1: amber   */
    vce_set_color(256 + 2 * 16 + 1, PCE_RGB(0, 6, 5));  /* spr pal2 c1: teal    */
    vce_set_color(256 + 3 * 16 + 1, PCE_RGB(7, 1, 6));  /* spr pal3 c1: magenta */

    upload_art();

    hiscore = hiscore_load();   /* BRAM — 0 on first boot / bad checksum     */
    state = ST_TITLE;
    paint_title();
    music_set(ST_TITLE);

    pce_joy_init();
    disp_enable();

    for (;;) {
        waitvsync();

        /* ── vblank work first: BAT repaints + sprites + SATB DMA ──
         * Whole-board BAT repaint (see the WHOLE-BOARD REPAINT idiom) — both
         * dirty wells stream in this one vblank, then the SATB DMA. */
        if (board_dirty[0]) { paint_board(0); board_dirty[0] = 0; }
        if (two_player && board_dirty[1]) { paint_board(1); board_dirty[1] = 0; }
        if (hud_dirty) { draw_hud(); hud_dirty = 0; }
        push_sprites();
        satb_dma();

        music_tick();
        if (sfx_timer) {
            --sfx_timer;
            if (sfx_timer == 0) { psg_off(2); psg_off(3); }
        }

        /* ── 2P input via the TurboTap (see read_pad2's idiom note). In 2P
         * versus BOTH play simultaneously, so we read BOTH pads every frame;
         * on the menus only pad 1 matters. ── */
        pad1 = pce_joy_read();
        pad2 = (state == ST_PLAY && two_player) ? read_pad2() : 0;

        if (state == ST_TITLE) {
            newpad = (u8)(pad1 & ~prev_pad[0]);
            prev_pad[0] = pad1;
            if (newpad & (PCE_JOY_RUN | PCE_JOY_I)) start_game(0);
            else if (newpad & PCE_JOY_II) start_game(1);
            continue;
        }
        if (state == ST_OVER) {
            newpad = (u8)(pad1 & ~prev_pad[0]);
            prev_pad[0] = pad1;
            if (newpad & (PCE_JOY_RUN | PCE_JOY_I)) {
                state = ST_TITLE;
                paint_title();
                music_set(ST_TITLE);
            }
            continue;
        }

        /* ── ST_PLAY — both players update every frame (simultaneous versus,
         * not alternating turns). Any update can end the game, so re-check
         * state between them. ── */
        update_player(0, pad1);
        if (two_player && state == ST_PLAY) update_player(1, pad2);
    }
}
