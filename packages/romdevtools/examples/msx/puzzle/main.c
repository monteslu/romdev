/* ── puzzle/main.c — MSX falling-trio match-3 puzzle (complete example game) ──
 *
 * STOKE STACK — a COMPLETE, working game: title screen, 1P MARATHON mode
 * (levels speed the fall as you clear) and 2P SIMULTANEOUS VERSUS mode —
 * two 6x12 wells side by side, P1 on JOYSTICK PORT 1, P2 on JOYSTICK PORT 2,
 * both falling at once, where every cascade CHAIN you score stokes the heat
 * under your rival: a garbage row rises from the bottom of their well.
 * Score + session hi-score, music + SFX on the AY-3-8910 PSG, and the MSX's
 * signature SCREEN-2 PER-ROW COLOR: the two wells, the HUD band, and a
 * one-tile vertical "ember" gradient seam come ENTIRELY from the three
 * independent color thirds, costing zero extra tiles.
 *
 * The game: a falling-trio match-3. A vertical trio of gems drops into a well;
 * LEFT/RIGHT move it, trigger A cycles its three colours, DOWN soft-drops,
 * trigger B hard-drops. When it lands, any straight run of 3+ same-coloured
 * gems (horizontal, vertical, or diagonal) clears; survivors fall and cascades
 * chain for multiplied score. In versus, the stack that reaches the rim loses.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented MSX footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — match rules, garbage, scoring, tuning, art: reshape
 *     freely.
 *
 * What depends on what:
 *   msx_hw.h / msx_vdp.c — VDP + PSG + joystick helpers (direct Z80 ports;
 *     the PSG functions carry a DI/EI guard against the BIOS KEYINT race —
 *     read msx_vdp.c before adding your own PSG pokes).
 *   msx_crt0.s — the $4000 "AB" cart header + static-init copy. Load-bearing;
 *     INIT must NEVER return, so main() ends in for(;;).
 *
 * Frame budget — and a TEACHING POINT vs the Genesis version of this game
 * (examples/genesis/templates/puzzle.c): the Genesis mirrors each well in RAM
 * and repaints it as ONE queued DMA rect in vblank. The MSX has no DMA: every
 * dirty cell is a per-byte VRAM port write (msx_vram_write). But screen-2 VRAM
 * writes are CHEAP at C speed (~29 Z80 cycles between VDP accesses, and SDCC
 * loops are slower than that — see TROUBLESHOOTING), and we only ever repaint
 * the cells that CHANGED (the active trio + a board redraw after a lock), so a
 * worst-case double cascade still lands inside one frame. Same genre, two
 * bandwidth worlds — fork accordingly.
 *
 * Controls: JOYSTICK PORT 1 (or keyboard cursors) plays well 0 — LEFT/RIGHT
 *   move, trigger A (or SPACE) cycles colours, DOWN soft-drops, trigger B
 *   hard-drops. In 2P versus, JOYSTICK PORT 2 plays well 1 the same way. On
 *   the title screen trigger A starts 1P marathon; trigger B starts 2P versus.
 *
 * Hi-score honesty: the bundled bluemsx core build exposes NO battery save
 *   path (retro_get_memory(SAVE_RAM) is unimplemented for MSX carts), so the
 *   hi-score lives in plain RAM: it survives title↔game cycles but NOT a
 *   power cycle / hardReset. Never fake persistence — if you need real saves,
 *   that's a future core round (ASCII8-SRAM mapper carts exist; the core just
 *   doesn't surface their RAM yet).
 */
#include "msx_hw.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "STOKE STACK"

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Interrupt-free vblank sync: poll VDP status S#0 bit 7 (port 0x99). Reading
 * the port ALSO clears the flag, so one read per frame = one game step per
 * frame. We deliberately do NOT use the BIOS JIFFY counter here: this poll
 * works even with interrupts masked, and never depends on the BIOS ISR
 * keeping pace. (The BIOS KEYINT also reads S#0 — on rare frames it eats the
 * flag first and this loop just waits for the next one; a one-frame hiccup,
 * never a hang.) */
__sfr __at 0x99 VDPSTATUS;
static void vsync(void) {
    (void)VDPSTATUS;                 /* throw away a possibly-stale flag    */
    while (!(VDPSTATUS & 0x80)) {
    }
}

/* ── GAME LOGIC (clay — reshape freely) — board geometry ─────────────────────
 * Two 6x12 wells on the 32x24 screen-2 name table. Cells are ONE 8x8 tile
 * each (the MSX screen is 256x192 — a 6-wide well is 48 px, both wells plus a
 * "VS" gap fit comfortably). Row 0 is the HUD band; the wells live in the air
 * thirds and rest on the ground third. */
#define GRID_W   6
#define GRID_H   12
#define WELL_TOP 6            /* name-table row of the well's TOP interior cell */
#define WELL_1P_LX 13         /* 1P: single centered well, interior cols 13-18  */
#define WELL_VS_LX0 4         /* 2P: P1 well interior cols 4-9  ...             */
#define WELL_VS_LX1 22        /*     P2 well interior cols 22-27 (split board)  */

#define EMPTY 0               /* cell colours 1..3 = ruby / emerald / sapphire  */

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Tile font: index 0 = space, 1-26 = A-Z, 27-36 = 0-9, 37 = dash, then the
 * board tiles. One 8x8 pattern = 8 bytes, one bit per pixel; set bits draw in
 * the tile's FOREGROUND color, clear bits in its BACKGROUND color (both come
 * from the screen-2 color table — see the per-row-color idiom below). */
#define T_SPACE  0
#define T_A      1           /* 'A'..'Z' = T_A + (c - 'A')                  */
#define T_0      27          /* '0'..'9' = T_0 + (c - '0')                  */
#define T_DASH   37
#define T_FIELD  38          /* empty well interior cell (recessed, faint speck)*/
#define T_FRAME  39          /* well border                                     */
#define T_GEM    40          /* a locked gem cell (its COLOR picks the colour)  */
#define T_EMBER  41          /* the per-8x1-row gradient strip (see below)      */
#define NUM_TILES 42

static const uint8_t font[NUM_TILES][8] = {
    /*    SPACE */ {0,0,0,0,0,0,0,0},
    /*  1 A */ {0x38,0x6C,0xC6,0xC6,0xFE,0xC6,0xC6,0x00},
    /*  2 B */ {0xFC,0xC6,0xC6,0xFC,0xC6,0xC6,0xFC,0x00},
    /*  3 C */ {0x7C,0xC6,0xC0,0xC0,0xC0,0xC6,0x7C,0x00},
    /*  4 D */ {0xF8,0xCC,0xC6,0xC6,0xC6,0xCC,0xF8,0x00},
    /*  5 E */ {0xFE,0xC0,0xC0,0xF8,0xC0,0xC0,0xFE,0x00},
    /*  6 F */ {0xFE,0xC0,0xC0,0xF8,0xC0,0xC0,0xC0,0x00},
    /*  7 G */ {0x7C,0xC6,0xC0,0xCE,0xC6,0xC6,0x7C,0x00},
    /*  8 H */ {0xC6,0xC6,0xC6,0xFE,0xC6,0xC6,0xC6,0x00},
    /*  9 I */ {0x7E,0x18,0x18,0x18,0x18,0x18,0x7E,0x00},
    /* 10 J */ {0x1E,0x06,0x06,0x06,0xC6,0xC6,0x7C,0x00},
    /* 11 K */ {0xC6,0xCC,0xD8,0xF0,0xD8,0xCC,0xC6,0x00},
    /* 12 L */ {0xC0,0xC0,0xC0,0xC0,0xC0,0xC0,0xFE,0x00},
    /* 13 M */ {0xC6,0xEE,0xFE,0xD6,0xC6,0xC6,0xC6,0x00},
    /* 14 N */ {0xC6,0xE6,0xF6,0xDE,0xCE,0xC6,0xC6,0x00},
    /* 15 O */ {0x7C,0xC6,0xC6,0xC6,0xC6,0xC6,0x7C,0x00},
    /* 16 P */ {0xFC,0xC6,0xC6,0xFC,0xC0,0xC0,0xC0,0x00},
    /* 17 Q */ {0x7C,0xC6,0xC6,0xC6,0xD6,0xCC,0x76,0x00},
    /* 18 R */ {0xFC,0xC6,0xC6,0xFC,0xD8,0xCC,0xC6,0x00},
    /* 19 S */ {0x7C,0xC0,0xC0,0x78,0x0C,0x0C,0xF8,0x00},
    /* 20 T */ {0x7E,0x18,0x18,0x18,0x18,0x18,0x18,0x00},
    /* 21 U */ {0xC6,0xC6,0xC6,0xC6,0xC6,0xC6,0x7C,0x00},
    /* 22 V */ {0xC6,0xC6,0xC6,0xC6,0x6C,0x38,0x10,0x00},
    /* 23 W */ {0xC6,0xC6,0xC6,0xD6,0xFE,0xEE,0xC6,0x00},
    /* 24 X */ {0xC6,0x6C,0x38,0x10,0x38,0x6C,0xC6,0x00},
    /* 25 Y */ {0x66,0x66,0x66,0x3C,0x18,0x18,0x18,0x00},
    /* 26 Z */ {0xFE,0x0C,0x18,0x30,0x60,0xC0,0xFE,0x00},
    /* 27 0 */ {0x7C,0xCE,0xDE,0xF6,0xE6,0xC6,0x7C,0x00},
    /* 28 1 */ {0x18,0x38,0x18,0x18,0x18,0x18,0x7E,0x00},
    /* 29 2 */ {0x7C,0xC6,0x06,0x1C,0x70,0xC0,0xFE,0x00},
    /* 30 3 */ {0x7C,0xC6,0x06,0x3C,0x06,0xC6,0x7C,0x00},
    /* 31 4 */ {0x1C,0x3C,0x6C,0xCC,0xFE,0x0C,0x0C,0x00},
    /* 32 5 */ {0xFE,0xC0,0xFC,0x06,0x06,0xC6,0x7C,0x00},
    /* 33 6 */ {0x3C,0x60,0xC0,0xFC,0xC6,0xC6,0x7C,0x00},
    /* 34 7 */ {0xFE,0x06,0x0C,0x18,0x30,0x30,0x30,0x00},
    /* 35 8 */ {0x7C,0xC6,0xC6,0x7C,0xC6,0xC6,0x7C,0x00},
    /* 36 9 */ {0x7C,0xC6,0xC6,0x7E,0x06,0x0C,0x78,0x00},
    /* 37 - */ {0x00,0x00,0x00,0x7E,0x00,0x00,0x00,0x00},
    /* 38 FIELD (recessed cell + faint speck) */
               {0x00,0x00,0x00,0x00,0x10,0x00,0x00,0x00},
    /* 39 FRAME (solid border)  */ {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF},
    /* 40 GEM   (rounded gem; its COLOR byte picks ruby/emerald/sapphire) */
               {0x3C,0x7E,0xFF,0xFF,0xFF,0xFF,0x7E,0x3C},
    /* 41 EMBER (solid fg — its COLOR bytes paint the gradient) */
               {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF},
};

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * SCREEN-2 PER-ROW COLOR — the MSX's signature background trick, AND the
 * reason a single GEM tile can show THREE colours.
 *
 * Screen 2 (GRAPHIC II) is NOT "one color byte per tile" like most consoles:
 *
 *   1. The 256x192 screen is THREE INDEPENDENT THIRDS of 8 rows each
 *      (name-table rows 0-7, 8-15, 16-23). Each third has its OWN 2KB
 *      pattern table slice and its OWN 2KB color table slice:
 *        patterns: VRAM_PATTERN + third*0x800,  colors: VRAM_COLOR + third*0x800
 *      The SAME tile index can look completely different in each third. We
 *      exploit exactly that to draw the THREE gem colours from ONE T_GEM tile:
 *      the gem pattern is uploaded identically to all three thirds, but each
 *      third's color byte for T_GEM is a DIFFERENT foreground (ruby / emerald /
 *      sapphire). A gem's colour is therefore chosen by WHICH NAME-TABLE ROW
 *      it sits in — so the board is laid out three rows per colour band (see
 *      gem_tile_for / well row→third mapping below). One piece of art, three
 *      colours, zero extra tiles — the puzzle-genre twin of the shmup's
 *      depth-banded starfield.
 *
 *   2. Within a tile, the color table holds EIGHT bytes — one per 8x1 pixel
 *      row — each packing (foreground<<4)|background from the fixed TMS9918
 *      palette. So one tile can carry an 8-color vertical gradient
 *      (T_EMBER's whole "forge glow" seam is a single tile, colors only).
 *
 * Requires: the screen-2 table layout set by msx_set_screen2() (R3=0xFF,
 *   R4=0x03 — the "thirds" configuration), and pattern + color uploads to
 *   EVERY third a tile is used in. Tile N's slot is pattern[N*8] / color[N*8].
 *
 * TMS9918 fixed palette used here: 1 black, 4 dark blue, 5 light blue,
 * 6 dark red, 8 cyan, 9 light red, 11 light yellow, 12 green, 14 gray,
 * 15 white (high nibble = fg, low nibble = bg of each row byte). */
static const uint8_t col_text[3]  = { 0xF4, 0xF1, 0xF1 }; /* HUD white-on-blue; title/play white-on-black */
static const uint8_t col_field[3] = { 0x41, 0x41, 0x41 }; /* recessed cell: dark-blue speck on black        */
static const uint8_t col_frame[3] = { 0xE1, 0xE1, 0xE1 }; /* well border: gray on black, every third         */
/* THE GEM-COLOUR-PER-THIRD trick: T_GEM's foreground in each third is a
 * different gem colour. Board rows are bucketed into colour bands by third so
 * a locked gem renders in its colour with no per-cell palette work:
 *   third 0 (top, rows 0-7)    → ruby     (fg 9 light red)
 *   third 1 (middle, rows 8-15)→ emerald  (fg 12 green)
 *   third 2 (bottom, rows 16-23)→ sapphire(fg 5 light blue)
 * ...so the in-well colour a gem SHOWS depends on its name-table row third.
 * (gem_tile_for() picks the row a colour-c gem must occupy — see below.) */
static const uint8_t col_gem[3]   = { 0x91, 0xC1, 0x51 }; /* ruby / emerald / sapphire, each on black */
/* T_EMBER: 8 DIFFERENT color bytes inside ONE tile = an 8-pixel-row forge
 * glow (black → dark red → light red → yellow → white and back down). The
 * pattern is solid 0xFF so only the fg nibbles show. Drawn as the seam row
 * directly under each well. */
static const uint8_t col_ember[8] = { 0x11,0x61,0x91,0xB1,0xF1,0xB1,0x91,0x61 };

static void load_tiles(void) {
    uint8_t third, i;
    uint16_t patbase, colbase;
    for (third = 0; third < 3; third++) {
        patbase = (uint16_t)(VRAM_PATTERN + ((uint16_t)third << 11));
        colbase = (uint16_t)(VRAM_COLOR   + ((uint16_t)third << 11));
        for (i = 0; i < NUM_TILES; i++) {
            uint8_t col;
            /* pattern bits are the same in every third — only COLOR varies */
            msx_vram_write((uint16_t)(patbase + ((uint16_t)i << 3)), font[i], 8);
            if (i == T_EMBER) {            /* the one per-pixel-row gradient   */
                msx_vram_write((uint16_t)(colbase + ((uint16_t)i << 3)), col_ember, 8);
                continue;
            }
            if      (i == T_FIELD) col = col_field[third];
            else if (i == T_FRAME) col = col_frame[third];
            else if (i == T_GEM)   col = col_gem[third];   /* colour per third */
            else                   col = col_text[third];
            msx_fill_vram((uint16_t)(colbase + ((uint16_t)i << 3)), 8, col);
        }
    }
}

/* ── GAME LOGIC (clay — reshape freely) — name-table drawing helpers ────────
 * Screen 2 VRAM writes are safe at any point in the frame at C speed: the
 * TMS9918 needs ~29 Z80 cycles between VRAM accesses during active display,
 * and SDCC-compiled loops are slower than that. (Hand-tuned asm OTIR bursts
 * are the thing that outruns the VDP — see TROUBLESHOOTING.) */
static void put_tile(uint8_t col, uint8_t row, uint8_t tile) {
    msx_vram_write((uint16_t)(VRAM_NAME + (uint16_t)row * 32 + col), &tile, 1);
}

static void draw_text(uint8_t col, uint8_t row, const char *s) {
    uint8_t buf[32];
    uint8_t n = 0;
    while (*s && n < 32) {
        char c = *s++;
        if      (c >= 'A' && c <= 'Z') buf[n] = (uint8_t)(T_A + c - 'A');
        else if (c >= '0' && c <= '9') buf[n] = (uint8_t)(T_0 + c - '0');
        else if (c == '-')             buf[n] = T_DASH;
        else                           buf[n] = T_SPACE;
        n++;
    }
    msx_vram_write((uint16_t)(VRAM_NAME + (uint16_t)row * 32 + col), buf, n);
}

static void draw_num4(uint8_t col, uint8_t row, uint16_t v) {
    uint8_t buf[4];
    buf[0] = (uint8_t)(T_0 + (v / 1000) % 10);
    buf[1] = (uint8_t)(T_0 + (v / 100) % 10);
    buf[2] = (uint8_t)(T_0 + (v / 10) % 10);
    buf[3] = (uint8_t)(T_0 + v % 10);
    msx_vram_write((uint16_t)(VRAM_NAME + (uint16_t)row * 32 + col), buf, 4);
}

/* ── GAME LOGIC (clay — reshape freely) — game state ─────────────────────────
 * Boards are plain static arrays. The falling trio is drawn with SPRITES (so
 * it floats over the well tiles without disturbing them); locked gems are
 * name-table tiles. */
static uint8_t  grid[2][GRID_H][GRID_W];   /* the two wells (well 1 unused in 1P) */
static int8_t   piece_x[2];                /* falling trio: column 0..5           */
static int8_t   piece_y[2];                /* row of its TOP cell (<0 above rim)  */
static uint8_t  piece_col[2][3];           /* trio colours, top to bottom         */
static uint8_t  fall_t[2];                 /* frames until next gravity step      */
static uint16_t score[2];
static uint16_t hiscore;         /* SESSION-ONLY: plain RAM. The bundled
                                  * bluemsx build exposes no SAVE_RAM region,
                                  * so there is nothing battery-backed to
                                  * write — survives title↔game cycles, not a
                                  * power cycle (honest, not faked). */
static uint8_t  level;           /* 1P: 1..9, speeds up the fall              */
static uint16_t cleared_total;   /* 1P: gems cleared, drives the level        */
static uint8_t  well_lx[2];      /* left interior name-table col per well     */
static uint8_t  two_player;      /* mode chosen on the title screen           */
static uint16_t rng;

#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;
static uint8_t over_loser;       /* 2P: which well topped out (P that LOST)   */
static uint8_t prev_t1, prev_t2; /* title/over trigger edge detection         */
/* per-player edge memory for in-play input (move/rotate/drop) */
static uint8_t prev_dir[2], prev_a[2], prev_b[2];

#define FALL_VS   24             /* 2P: fixed gravity (frames per row)        */
#define GARBAGE_CAP 4            /* max garbage rows per attack               */

/* xorshift16 PRNG — a few dozen cycles, no tables. */
static uint8_t next_rand(void) {
    rng ^= (uint16_t)(rng << 7);
    rng ^= (uint16_t)(rng >> 9);
    rng ^= (uint16_t)(rng << 8);
    return (uint8_t)(rng & 0xFF);
}

/* ── GAME LOGIC (clay — reshape freely) — music + SFX on the AY-3-8910 ──────
 * Channel plan: A = move/rotate/clear blips, B = lock/garbage noise, C =
 * music. The PSG has 3 tone channels + ONE shared noise generator, mixed
 * per-channel in reg 7. All register traffic goes through msx_psg_tone/noise/
 * off — they wrap the PSGADDR/PSGWRITE pair in DI/EI because the BIOS KEYINT
 * ISR clobbers the PSG address latch every frame (the bug that once silenced
 * every MSX scaffold — see msx_vdp.c).
 *
 * The tune: one period entry per half-beat, 0 = rest. AY period =
 * 1789773 / (16 * freq) — e.g. A4 (440Hz) -> 254. Ticked once per frame; a
 * note advances every 8 frames. The lib's built-in demo loop (msx_music_tick)
 * also uses channel C, so we switch it OFF in main() and run THIS table
 * instead — edit this table to rescore. */
static const uint16_t tune[32] = {
    339, 0, 285, 339, 427, 0, 339, 285,   /* E4 G4 E4 C4 E4 G4  (steady groove)   */
    254, 0, 285, 339, 285, 0,   0,   0,   /* A4 G4 E4 G4 rest                     */
    380, 0, 339, 285, 254, 0, 285, 339,   /* D4 E4 G4 A4 G4 E4                     */
    427, 0, 339, 285, 339, 0,   0,   0,   /* C4 E4 G4 E4 rest                     */
};
static uint8_t music_step, music_timer;
static uint8_t sfx_a_t, sfx_b_t;          /* frames left on the A/B SFX channels */

static void music_tick(void) {
    if (music_timer == 0) {
        uint16_t p = tune[music_step & 31];
        if (p) msx_psg_tone(2, p, 9);
        else   msx_psg_off(2);
        music_step++;
    }
    music_timer++;
    if (music_timer >= 8) music_timer = 0;
}

static void sfx_tick(void) {
    if (sfx_a_t) { sfx_a_t--; if (!sfx_a_t) msx_psg_off(0); }
    if (sfx_b_t) { sfx_b_t--; if (!sfx_b_t) msx_psg_noise(1, 0, 0); }
}

static void sfx_move(void)  { msx_psg_tone(0, 0x300, 8);  sfx_a_t = 2; }
static void sfx_rotate(void){ msx_psg_tone(0, 0x200, 9);  sfx_a_t = 3; }
static void sfx_clear(uint8_t chain) {
    /* pitch rises with chain depth (smaller period = higher note) */
    uint16_t p = (uint16_t)(0x180 - ((uint16_t)chain << 5));
    msx_psg_tone(0, p, 12); sfx_a_t = 6;
}
static void sfx_lock(void)  { msx_psg_tone(1, 0x040, 10); sfx_b_t = 3; }
static void sfx_garbage(void){ msx_psg_noise(1, 16, 13);  sfx_b_t = 8; }
static void sfx_over(void)  { msx_psg_noise(1, 28, 14);   sfx_b_t = 22; }

/* ── GAME LOGIC (clay — reshape freely) — well row→third gem colour ──────────
 * The screen-2 thirds idiom means a gem's COLOUR is decided by which screen
 * third (name-table row band) its cell lands in. The well spans name-table
 * rows WELL_TOP..WELL_TOP+11 (6..17), which straddles two thirds:
 *   rows 6,7        → third 0 → ruby
 *   rows 8..15      → third 1 → emerald
 *   rows 16,17      → third 2 → sapphire
 * That is a fixed visual banding of the SHARED T_GEM tile, NOT the logical
 * gem colour (the logical colour lives in grid[]). For a forked game that
 * wants logical colour == shown colour at every cell, give each colour its own
 * tile index and upload three patterns instead — costs 2 extra tiles. Here we
 * keep the one-tile trick and accept the painterly banding; matches still run
 * on the LOGICAL grid[] colours, so play is unaffected. */
static uint8_t well_row(uint8_t r) { return (uint8_t)(WELL_TOP + r); }

/* draw one well interior cell (logical grid[p][r][c]) into the name table */
static void draw_cell(uint8_t p, uint8_t r, uint8_t c) {
    uint8_t tile = grid[p][r][c] ? T_GEM : T_FIELD;
    put_tile((uint8_t)(well_lx[p] + c), well_row(r), tile);
}

/* repaint a full well interior from grid[] (used after a lock/cascade) */
static void draw_well(uint8_t p) {
    uint8_t r, c;
    for (r = 0; r < GRID_H; r++)
        for (c = 0; c < GRID_W; c++) draw_cell(p, r, c);
}

/* paint a well's gray frame (top/bottom/sides) + the ember seam under it */
static void paint_frame(uint8_t p) {
    uint8_t r, lx = well_lx[p];
    uint8_t top = (uint8_t)(WELL_TOP - 1), bot = (uint8_t)(WELL_TOP + GRID_H);
    uint8_t c;
    for (c = 0; c < GRID_W + 2; c++) {
        put_tile((uint8_t)(lx - 1 + c), top, T_FRAME);
        put_tile((uint8_t)(lx - 1 + c), bot, T_FRAME);
    }
    for (r = 0; r < GRID_H; r++) {
        put_tile((uint8_t)(lx - 1), well_row(r), T_FRAME);
        put_tile((uint8_t)(lx + GRID_W), well_row(r), T_FRAME);
    }
    /* ember seam: the gradient tile row directly beneath the well frame */
    for (c = 0; c < GRID_W + 2; c++)
        put_tile((uint8_t)(lx - 1 + c), (uint8_t)(bot + 1), T_EMBER);
}

/* ── GAME LOGIC (clay — reshape freely) — sprites: the falling trio ──────────
 * 8x8 one-color hardware sprites — 3 per player (the three gems of the active
 * trio). Plane layout: 0-2 = P1 trio, 3-5 = P2 trio. Locked gems are tiles,
 * not sprites, so the well never needs more than 6 sprite planes. */
static const uint8_t spr_gem[8] = {0x3C,0x7E,0xFF,0xFF,0xFF,0xFF,0x7E,0x3C};
#define PAT_GEM 0
/* sprite colour per logical gem colour 1..3 (matches the tile banding intent) */
static const uint8_t spr_col[4] = { 15, 9, 12, 5 }; /* [0] unused; ruby/emerald/sapphire */

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Sprite limits + the Y=208 terminator:
 *   - A sprite Y of 0xD0 (208) tells the TMS9918 to STOP SCANNING the
 *     attribute table — every higher-numbered plane vanishes, not just that
 *     one. (msx_clear_sprites parks ALL planes at 0xD0, which is fine at the
 *     END of the list.) To hide ONE sprite mid-list, park it OFFSCREEN at
 *     PARK_Y (192 = first line below the display) — never at 0xD0.
 *     (On MSX2's V9938 sprite mode 2 the terminator moves to 0xD8 and 0xD0
 *     is "just offscreen" — code that leans on that breaks on MSX1.)
 *   - Per scanline the TMS9918 draws only 4 sprites (V9938: 8). The two trios
 *     never share a scanline (the wells are side by side), and one trio is 3
 *     vertically-stacked gems = 3 sprites on different rows, so a row pileup
 *     can't exceed 1-2 here. */
#define PARK_Y 192

/* cell (col,row in a well) → screen pixel position of its sprite */
static uint8_t cell_px(uint8_t p, int8_t c) { return (uint8_t)((well_lx[p] + c) * 8); }
static uint8_t cell_py(int8_t r)            { return (uint8_t)((WELL_TOP + r) * 8); }

/* Push the two trios to their sprite planes. A gem above the rim (row < 0) or
 * an inactive well parks offscreen at PARK_Y, NEVER 0xD0 — see the idiom. */
static void push_sprites(void) {
    uint8_t p, i, plane;
    for (p = 0; p < 2; p++) {
        uint8_t active = (state == ST_PLAY) && (p == 0 || two_player);
        for (i = 0; i < 3; i++) {
            int8_t r = (int8_t)(piece_y[p] + (int8_t)i);
            plane = (uint8_t)(p * 3 + i);
            if (active && r >= 0 && r < GRID_H)
                msx_set_sprite(plane, cell_px(p, piece_x[p]), cell_py(r),
                               PAT_GEM, spr_col[piece_col[p][i]]);
            else
                msx_set_sprite(plane, cell_px(p, piece_x[p]), PARK_Y,
                               PAT_GEM, spr_col[piece_col[p][i]]);
        }
    }
}

/* ── GAME LOGIC (clay — reshape freely) — HUD ──────────────────────────────
 * Row 0 = the HUD band (third 0's text colors make it a distinct strip).
 * 1P: SC=score, HI=hi-score, LV=level. 2P: P1 score, HI, P2 score. */
static void draw_hud_labels(void) {
    if (two_player) {
        draw_text(1, 0, "P1");
        draw_text(13, 0, "HI");
        draw_text(25, 0, "P2");
    } else {
        draw_text(1, 0, "SC");
        draw_text(13, 0, "HI");
        draw_text(25, 0, "LV");
    }
}
static void draw_scores(void) {
    if (two_player) { draw_num4(4, 0, score[0]); draw_num4(28, 0, score[1]); }
    else            { draw_num4(4, 0, score[0]); }
}
static void draw_hi(void)    { draw_num4(16, 0, hiscore); }
static void draw_level(void) { if (!two_player) put_tile(28, 0, (uint8_t)(T_0 + level)); }

/* ── GAME LOGIC (clay — reshape freely) — match scan ────────────────────────
 * Mark every straight run of 3+ same-coloured gems in all 4 directions (a
 * cell can belong to several runs — the mask de-dupes), and return how many
 * cells matched. Runs on the LOGICAL grid[] colours (independent of the
 * thirds tile banding). */
static uint8_t matched[GRID_H][GRID_W];
static const int8_t DIRS4[4][2] = { {0,1}, {1,0}, {1,1}, {1,-1} };

static uint8_t mark_and_count(uint8_t p) {
    uint8_t r, c, d, len, k, cnt, col;
    int8_t dr, dc;
    int16_t sr, sc;
    cnt = 0;
    for (r = 0; r < GRID_H; r++)
        for (c = 0; c < GRID_W; c++) matched[r][c] = 0;
    for (r = 0; r < GRID_H; r++) {
        for (c = 0; c < GRID_W; c++) {
            col = grid[p][r][c];
            if (col == EMPTY) continue;
            for (d = 0; d < 4; d++) {
                dr = DIRS4[d][0]; dc = DIRS4[d][1];
                sr = (int16_t)r - dr; sc = (int16_t)c - dc;
                if (sr >= 0 && sr < GRID_H && sc >= 0 && sc < GRID_W
                    && grid[p][sr][sc] == col) continue;   /* not the run's start */
                len = 1;
                sr = (int16_t)r + dr; sc = (int16_t)c + dc;
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
static void apply_gravity(uint8_t p) {
    uint8_t c;
    int8_t r, w;
    for (c = 0; c < GRID_W; c++) {
        w = GRID_H - 1;
        for (r = GRID_H - 1; r >= 0; r--) {
            if (grid[p][r][c] != EMPTY) { grid[p][w][c] = grid[p][r][c]; w--; }
        }
        for (; w >= 0; w--) grid[p][w][c] = EMPTY;
    }
}

/* forward decls for the clear→attack→end chain */
static void game_over(uint8_t loser);
static void garbage_insert(uint8_t v, uint8_t nrows);
static void spawn_piece(uint8_t p);

/* ── GAME LOGIC (clay — reshape freely) — clear matches, drop survivors,
 * chain cascades. Returns the chain depth (0 = the lock matched nothing). ── */
static uint8_t resolve_board(uint8_t p) {
    uint8_t n, r, c, chain;
    uint16_t amt;
    chain = 0;
    for (;;) {
        n = mark_and_count(p);
        if (n == 0) break;
        ++chain;
        for (r = 0; r < GRID_H; r++)
            for (c = 0; c < GRID_W; c++)
                if (matched[r][c]) grid[p][r][c] = EMPTY;
        amt = (uint16_t)n * 10;
        if (chain > 1) amt = (uint16_t)(amt * chain);    /* cascades pay more */
        if (score[p] < 9999) {
            score[p] = (uint16_t)(score[p] + amt);
            if (score[p] > 9999) score[p] = 9999;
        }
        sfx_clear(chain);
        apply_gravity(p);
        if (!two_player) {
            cleared_total += n;
            while (level < 9 && cleared_total >= (uint16_t)level * 10) {
                ++level;
                draw_level();
            }
        }
        draw_scores();
    }
    return chain;
}

/* Can the trio occupy column x, rows y..y+2? Cells above the rim are fine
 * (pieces enter from above); below the floor or on a gem is not. */
static uint8_t can_place(uint8_t p, int8_t x, int8_t y) {
    int8_t i, cy;
    if (x < 0 || x >= GRID_W) return 0;
    for (i = 0; i < 3; i++) {
        cy = (int8_t)(y + i);
        if (cy < 0) continue;
        if (cy >= GRID_H) return 0;
        if (grid[p][cy][x] != EMPTY) return 0;
    }
    return 1;
}

static void spawn_piece(uint8_t p) {
    piece_x[p] = GRID_W / 2;
    piece_y[p] = -2;
    piece_col[p][0] = (uint8_t)(1 + next_rand() % 3);
    piece_col[p][1] = (uint8_t)(1 + next_rand() % 3);
    piece_col[p][2] = (uint8_t)(1 + next_rand() % 3);
    prev_a[p] = prev_b[p] = 1;     /* swallow the drop button that just locked */
    if (!can_place(p, piece_x[p], piece_y[p])) game_over(p);
}

/* ── GAME LOGIC (clay — reshape freely) — land the trio, resolve, attack,
 * respawn. ── */
static void lock_piece(uint8_t p) {
    int8_t i, y;
    uint8_t chain;
    for (i = 0; i < 3; i++) {
        y = (int8_t)(piece_y[p] + i);
        if (y >= 0) grid[p][y][piece_x[p]] = piece_col[p][i];
    }
    sfx_lock();
    if (piece_y[p] < 0) { draw_well(p); game_over(p); return; } /* locked above rim */
    chain = resolve_board(p);
    draw_well(p);
    if (state != ST_PLAY) return;
    if (chain && two_player) {
        garbage_insert((uint8_t)(p ^ 1), chain > GARBAGE_CAP ? GARBAGE_CAP : chain);
        if (state != ST_PLAY) return;             /* garbage topped them out  */
    }
    spawn_piece(p);
}

/* ── GAME LOGIC (clay — reshape freely) — VERSUS attack: garbage rows rise
 * from the bottom of the victim's well (random gems with one gap — matchable,
 * so a skilled victim digs out). If the top row is already occupied the victim
 * tops out and loses. ── */
static void garbage_insert(uint8_t v, uint8_t nrows) {
    uint8_t k, c, gap;
    int8_t r;
    sfx_garbage();
    for (k = 0; k < nrows; k++) {
        for (c = 0; c < GRID_W; c++)
            if (grid[v][0][c] != EMPTY) { draw_well(v); game_over(v); return; }
        for (r = 0; r < GRID_H - 1; r++)
            for (c = 0; c < GRID_W; c++)
                grid[v][r][c] = grid[v][r + 1][c];
        gap = (uint8_t)(next_rand() % GRID_W);
        for (c = 0; c < GRID_W; c++)
            grid[v][GRID_H - 1][c] = (c == gap) ? EMPTY : (uint8_t)(1 + next_rand() % 3);
        if (piece_y[v] > -3) --piece_y[v];        /* keep the trio aligned    */
    }
    draw_well(v);
}

/* ── GAME LOGIC (clay — reshape freely) — per-player input + gravity ─────────
 * P0 reads JOYSTICK PORT 1 (keyboard cursors fall back); P1 reads PORT 2.
 * Edge-triggered moves (one cell per press), held DOWN soft-drops, trigger A
 * cycles the trio's colours, trigger B hard-drops. */
static void update_player(uint8_t p) {
    uint8_t dir, a, b, fd, soft, moved_l, moved_r, t;
    if (p == 0) {
        dir = msx_read_joystick(1);
        if (dir == STICK_CENTER) dir = msx_read_joystick(0);
        a = (uint8_t)(gttrig(1) || gttrig(0));   /* trig A or SPACE           */
        b = gttrig(3);                            /* port-1 button 2          */
    } else {
        dir = msx_read_joystick(2);
        a = gttrig(2);                            /* port-2 trigger A         */
        b = gttrig(4);                            /* port-2 button 2          */
    }

    moved_l = (uint8_t)(dir == STICK_LEFT  || dir == STICK_UL || dir == STICK_DL);
    moved_r = (uint8_t)(dir == STICK_RIGHT || dir == STICK_UR || dir == STICK_DR);
    soft    = (uint8_t)(dir == STICK_DOWN  || dir == STICK_DL || dir == STICK_DR);

    if (moved_l && !(prev_dir[p] & 1) && can_place(p, (int8_t)(piece_x[p] - 1), piece_y[p])) {
        --piece_x[p]; sfx_move();
    }
    if (moved_r && !(prev_dir[p] & 2) && can_place(p, (int8_t)(piece_x[p] + 1), piece_y[p])) {
        ++piece_x[p]; sfx_move();
    }
    prev_dir[p] = (uint8_t)((moved_l ? 1 : 0) | (moved_r ? 2 : 0));

    if (a && !prev_a[p]) {                         /* cycle colours downward   */
        t = piece_col[p][2];
        piece_col[p][2] = piece_col[p][1];
        piece_col[p][1] = piece_col[p][0];
        piece_col[p][0] = t;
        sfx_rotate();
    }
    prev_a[p] = a;

    if (b && !prev_b[p]) {                          /* hard drop                */
        prev_b[p] = b;
        while (can_place(p, piece_x[p], (int8_t)(piece_y[p] + 1))) ++piece_y[p];
        lock_piece(p);                              /* may end the game         */
        return;
    }
    prev_b[p] = b;

    /* gravity: soft-drop adds extra ticks; level/mode set the base rate */
    fd = two_player ? FALL_VS : (uint8_t)(32 - ((level << 1) + level));   /* 29..5 */
    fall_t[p] = (uint8_t)(fall_t[p] + (soft ? 4 : 1));
    if (fall_t[p] >= fd) {
        fall_t[p] = 0;
        if (can_place(p, piece_x[p], (int8_t)(piece_y[p] + 1)))
            ++piece_y[p];
        else
            lock_piece(p);                          /* may end the game         */
    }
}

/* ── GAME LOGIC (clay — reshape freely) — screens ──────────────────────────
 * Title rows land in third 1 / third 2 — recolored for free by the thirds
 * idiom. A clean name table behind the text. */
static void clear_field(void) { msx_fill_vram(VRAM_NAME, 32u * 24u, T_SPACE); }

static void paint_title(void) {
    uint8_t len = 0, col;
    const char *p = GAME_TITLE;
    while (*p++) len++;
    col = (uint8_t)((32 - len) / 2);
    clear_field();
    draw_text(col, 6, GAME_TITLE);
    draw_text(7, 11, "1P START - FIRE A");
    draw_text(7, 13, "2P VERSUS - FIRE B");
    draw_text(12, 18, "HI 0000");      /* the space blanks the cell between */
    draw_num4(15, 18, hiscore);
}

static void paint_play(void) {
    clear_field();
    paint_frame(0);
    draw_well(0);
    if (two_player) {
        paint_frame(1);
        draw_well(1);
        draw_text(15, 12, "VS");
    }
    draw_hud_labels();
    draw_scores();
    draw_hi();
    draw_level();
}

static void start_game(uint8_t versus) {
    uint8_t p, r, c;
    two_player = versus;
    well_lx[0] = versus ? WELL_VS_LX0 : WELL_1P_LX;
    well_lx[1] = WELL_VS_LX1;
    for (p = 0; p < 2; p++) {
        for (r = 0; r < GRID_H; r++)
            for (c = 0; c < GRID_W; c++) grid[p][r][c] = EMPTY;
        fall_t[p] = 0;
        score[p] = 0;
        piece_x[p] = GRID_W / 2;
        piece_y[p] = -2;
        prev_dir[p] = 0;
        prev_a[p] = prev_b[p] = 1;     /* swallow the button that started us */
    }
    cleared_total = 0;
    level = 1;
    state = ST_PLAY;
    paint_play();
    spawn_piece(0);
    if (versus) spawn_piece(1);
}

static void game_over(uint8_t loser) {
    uint16_t best = score[0];
    if (two_player && score[1] > best) best = score[1];
    if (best > hiscore) { hiscore = best; }
    over_loser = loser;
    sfx_over();
    state = ST_OVER;
    clear_field();
    if (two_player) draw_text(11, 7, loser ? "P1 WINS" : "P2 WINS");
    else            draw_text(11, 7, "GAME OVER");
    draw_text(9, 10, "P1"); draw_num4(13, 10, score[0]);
    if (two_player) { draw_text(9, 12, "P2"); draw_num4(13, 12, score[1]); }
    draw_text(11, 14, "HI"); draw_num4(15, 14, hiscore);
    draw_text(8, 17, "FIRE FOR TITLE");
    prev_t1 = prev_t2 = 1;             /* swallow a fire still held from play */
}

void main(void) {
    uint8_t i, t1, t2;

    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * Init order: set the video mode FIRST (INIGRP also clears VRAM — any
     * upload done before it is wiped), then tiles, then sprites. The crt0's
     * INIT contract means main() must NEVER return — the BIOS has nothing
     * sane to fall back to — hence the for(;;) below. */
    msx_set_screen2();
    msx_clear_sprites();
    load_tiles();
    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_GEM * 8), spr_gem, 8);

    msx_music(0);            /* the lib's demo loop also owns channel C —
                             * hand the channel to OUR tune table instead    */
    hiscore = 0;             /* session hi-score (no SAVE_RAM on this core)  */
    rng = 0xACE1;
    music_step = music_timer = 0;
    sfx_a_t = sfx_b_t = 0;
    for (i = 0; i < 2; i++) { prev_dir[i] = 0; prev_a[i] = prev_b[i] = 1; }
    prev_t1 = prev_t2 = 1;   /* swallow a held trigger across state changes  */
    two_player = 0;
    state = ST_TITLE;
    paint_title();

    for (;;) {
        vsync();
        music_tick();
        sfx_tick();

        if (state == ST_TITLE) {
            /* ── GAME LOGIC (clay) — title: trig A = 1P; trig B = 2P versus. */
            t1 = (uint8_t)(gttrig(1) || gttrig(0));
            t2 = (uint8_t)(gttrig(3) || gttrig(2));
            if (t2 && !prev_t2)      start_game(1);
            else if (t1 && !prev_t1) start_game(0);
            prev_t1 = t1; prev_t2 = t2;
            push_sprites();
            continue;
        }

        if (state == ST_OVER) {
            /* Freeze the final frame; any fire button returns to the title. */
            t1 = (uint8_t)(gttrig(1) || gttrig(0) || gttrig(2));
            if (t1 && !prev_t1) {
                state = ST_TITLE;
                msx_clear_sprites();
                two_player = 0;
                paint_title();
            }
            prev_t1 = t1; prev_t2 = t1;
            push_sprites();
            continue;
        }

        /* ── ST_PLAY — GAME LOGIC (clay) — both players update EVERY frame
         * (simultaneous versus, not alternating turns). Any update can end
         * the game, so re-check state between them. */
        update_player(0);
        if (two_player && state == ST_PLAY) update_player(1);

        push_sprites();
    }
}
