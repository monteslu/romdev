/* ── main.c — PC Engine side-scrolling platformer (complete example game) ─────
 *
 * A COMPLETE, working game — title screen, 1P mode and 2P ALTERNATING-TURNS
 * mode (arcade-classic: players swap on death; each player has their own
 * score and own 3 lives; player 2 plays on the SECOND pad), coins + distance
 * scoring, in-session hi-score (a bare HuCard can't save — see the hi-score
 * note below), music + SFX, and TWO of
 * the PC Engine's signature features working together:
 *   - HARDWARE BG SCROLL: a world wider than one screen scrolled with the
 *     VDC's BXR register (zero per-frame tilemap rewrites once a column is
 *     painted) — the smoothest, cheapest scroll of any 8-bit machine.
 *   - LARGE MULTI-CELL SPRITES: the hero is a 32x32 HuC6270 sprite from ONE
 *     SATB entry (four 16x16 cells, 4-aligned pattern) — the kind of big,
 *     readable character the NES needs 4+ hardware sprites to draw.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented PCE footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — level layout, physics tuning, scoring, art: reshape
 *     freely.
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
 * port-1 input and seeing P2 move. So this game ships REAL 2P alternating
 * turns. (On real hardware the player plugs a TurboTap and a second pad.)
 *
 * Frame budget (NTSC, 60fps, 7.16MHz 65C02-class CPU): player physics + a
 * two-column ground probe + (3 coins + 2 spikes) of AABB + a 256-word SATB
 * copy in vblank + at most one streamed BAT column fit comfortably in one
 * frame. Hardware scroll (BXR) is free; rewriting the whole tilemap per frame
 * would NOT fit — column streaming is why this scrolls smoothly.
 */
#include <pce.h>
#include <stdint.h>   /* int16_t/int32_t for sub-pixel physics + camera */
#include <joystick.h> /* JOY_2 + joy_read for the 2nd pad (TurboTap port 1) */
#include "pce_hw.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "GLADE DASH"

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * VRAM map (WORD addresses — the VDC is a 16-bit-word machine; an 8x8 tile is
 * 16 words, a 16x16 sprite cell is 64). Sprites and BG tiles share one 64KB
 * VRAM, so lay it out ONCE and keep the SATB out of pattern space:
 *   $0000  BAT (32x32 background map — matches vdc_init's VDC_MWR setting)
 *   $1000  font glyphs (38 tiles: blank, 0-9, A-Z, dash)
 *   $1400  BG scenery tiles (sky, dirt, grass, slab, hud band)
 *   $1800  16x16 sprite cells: coin, spike
 *   $1900  PLAYER pattern cells — 4-ALIGNED cell index (32x32 large sprite)
 *   $7F00  shadow SATB destination (satb_dma copies it here, VDC reads it) */
#define BAT_VRAM      0x0000
#define FONT_VRAM     0x1000
#define SKY_VRAM      0x1400   /* solid colour 1 — sky                       */
#define DIRT_VRAM     0x1410   /* solid colour 2 — ground body               */
#define GRASS_VRAM    0x1420   /* colour-3 lip over colour-2 body            */
#define SLAB_VRAM     0x1430   /* colour-3 thin one-way platform             */
#define HUDBAND_VRAM  0x1440   /* solid colour 2 — band behind the HUD text  */
#define COIN_VRAM     0x1800   /* 16x16 sprite cell                          */
#define SPIKE_VRAM    0x1840   /* 16x16 sprite cell                          */
#define PLAYER_VRAM   0x1900   /* 4 cells (TL,TR,BL,BR) — 4-aligned (see idiom) */

#define BAT_ENTRY(pal, vram)  ((u16)(((pal) << 12) | ((vram) >> 4)))

/* Sprite pattern codes = VRAM >> 6 (the 16x16 cell index). */
#define COIN_PAT     (COIN_VRAM >> 6)
#define SPIKE_PAT    (SPIKE_VRAM >> 6)
#define PLAYER_PAT   (PLAYER_VRAM >> 6)         /* 0x64 — multiple of 4        */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * SATB slot plan (slot order is also priority: LOWER slot wins overlaps on
 * the HuC6270):
 *   0      player (a 32x32 large sprite — ONE SATB entry)
 *   1-3    coins
 *   4-5    spikes
 * Everything else stays parked off-screen. */
#define SLOT_PLAYER  0
#define SLOT_COIN    1
#define SLOT_SPIKE   4
#define NUM_COINS    3
#define NUM_SPIKES   2
#define OFFSCREEN_Y  0x1F0     /* park unused sprites below the display       */

#define PAL_PLAYER   0
#define PAL_COIN     1
#define PAL_SPIKE    2

/* ── GAME LOGIC (clay) — the world ───────────────────────────────────────────
 * A 96-cell (768px) world, wider than the 256px screen. The BAT is a 32x32
 * virtual map that WRAPS at 256px, so a wider world needs COLUMN STREAMING:
 * each time the camera crosses an 8px boundary we rewrite the BAT column about
 * to scroll into view with the next world column's tiles. Rows are 8px:
 *   ground_row[c] — BAT row of the grass top, 0xFF = pit.
 *   plat_row[c]   — BAT row of a one-way slab, 0 = none.
 * Playfield rows are 3..27 (rows 0-2 sit under the HUD). */
#define WORLD_COLS   96
#define WORLD_W      (WORLD_COLS * 8)
#define SCREEN_W     256
#define VIS_ROWS     28           /* 224-line display = 28 rows               */
#define NO_GROUND    0xFF
#define GROUND_R     25           /* default ground surface row (y = 200)     */
#define HUD_ROWS     3            /* rows 0-2 reserved for HUD (drawn fixed)   */

static const u8 ground_row[WORLD_COLS] = {
    25,25,25,25,25,25,25,25,                       /* start runway           */
    25,25,25,25, NO_GROUND,NO_GROUND, 25,25,        /* pit 1 (16px)           */
    25,25,25,25,25,25,25,25,
    25,25, NO_GROUND,NO_GROUND,NO_GROUND, 25,25,25,  /* pit 2 (24px)           */
    25,25,25,25,25,25,25,25,
    25,25,25, NO_GROUND,NO_GROUND, 25,25,25,         /* pit 3 (16px)           */
    25,25,25,25,25,25,25,25,
    25, NO_GROUND,NO_GROUND,NO_GROUND, 25,25,25,25,  /* pit 4 (24px)           */
    25,25,25,25,25,25,25,25,
    25,25,25,25, NO_GROUND,NO_GROUND, 25,25,         /* pit 5 (16px)           */
    25,25,25,25,25,25,25,25,
    25,25,25,25,25,25,25,25,                        /* run-out to the loop    */
};
static const u8 plat_row[WORLD_COLS] = {
    0,0,0,0, 21,21,21, 0,                          /* warm-up slab            */
    0,0, 19,19,19, 0,0,0,                          /* bridge over pit 1       */
    0,0,0, 18,18, 0,0,0,
    0, 20,20, 0,0,0, 0,0,                          /* hop near pit 2          */
    0,0,0, 17,17,17, 0,0,                          /* high ledge             */
    0,0, 19,19, 0,0,0,0,                           /* over pit 3             */
    21,21, 0,0,0, 19,19, 0,
    0, 18,18,18, 0,0,0,0,                          /* over pit 4             */
    0,0,0, 20,20, 0,0,0,
    0,0, 19,19, 0,0,0,0,                           /* over pit 5             */
    0, 21,21,21, 0,0,0,0,
    0,0,0,0,0,0,0,0,
};

typedef struct { int16_t x, y; u8 alive; } Obj;

/* ── GAME LOGIC (clay) — physics + tuning (Q4.4 fixed point: 16 = 1 px) ── */
#define GRAVITY      10
#define JUMP_VEL   (-104)         /* ~36px apex (~4.5 tiles) — clears a pit  */
#define MAX_VY       64           /* terminal 4 px/frame — MUST stay under 5:
                                   * the landing probe's +4 window can't      *
                                   * catch a faster fall (tunnelling)         */
#define MOVE         34           /* px/16 per frame walk + scroll speed     */
#define SCROLL_WALL 120           /* px: past this the world scrolls, not you */
#define GROUND_TOP  (GROUND_R * 8)
#define SPIKE_Y     192
#define START_LIVES  3

static int16_t px;                /* player screen x (px)                     */
static int16_t py_q44;            /* player y, Q4.4 — gravity adds <1 px/frame
                                   * near the apex; integer y would stick     */
static int16_t vy_q44;
static u8      on_ground;
static int16_t camX, lastCamCol;  /* world scroll (px) + last streamed column */
static u8      dist_sub;          /* sub-counter: 64 px scrolled = +1 point   */
static Obj     coins[NUM_COINS];
static Obj     spikes[NUM_SPIKES];

/* Players: index 0 = P1 (pad 1), 1 = P2 (pad 2 — alternating turns). Each has
 * own score + own lives; the HUD shows the CURRENT player's numbers. */
static u8  two_player;
static u8  cur_player;
static u8  p_lives[2];
static u16 p_score[2];
static u16 hiscore;
static u8  turn_pause;            /* freeze frames after a turn change        */
static u16 rng = 0xC0DE;

static u8  pad, prev_pad;         /* CURRENT-player pad this frame            */
static u8  sfx_timer;
static u8  hud_dirty;
static u8  anim_frame;            /* player walk-cycle phase                  */

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static u8 state;

static u16 tile_buf[16];          /* scratch for one 8x8 tile                 */
static u16 spr_buf[64];           /* scratch for one 16x16 sprite cell        */

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

/* ── GAME LOGIC (clay) — the 32x32 hero, two walk frames (32 rows × 32 bits).
 * Two u16 per row (cols 0-15, cols 16-31). body = colour 1 (plane0), the
 * face/cap accents = colour 3 (planes 0+1, a subset of body). A round forest
 * sprite (think a bounding critter) — big and readable, the PCE's strength. */
static const u16 hero_body_a[64] = {
    0x0000,0x0000, 0x0000,0x0000, 0x0007,0xE000, 0x001F,0xF800,
    0x003F,0xFC00, 0x007F,0xFE00, 0x00FF,0xFF00, 0x01FF,0xFF80,
    0x01FF,0xFF80, 0x03FF,0xFFC0, 0x03FF,0xFFC0, 0x03FF,0xFFC0,
    0x07FF,0xFFE0, 0x07FF,0xFFE0, 0x07FF,0xFFE0, 0x07FF,0xFFE0,
    0x07FF,0xFFE0, 0x07FF,0xFFE0, 0x03FF,0xFFC0, 0x03FF,0xFFC0,
    0x01FF,0xFF80, 0x01FF,0xFF80, 0x00FF,0xFF00, 0x007F,0xFE00,
    0x003F,0xFC00, 0x003C,0x3C00, 0x0078,0x1E00, 0x0070,0x0E00,
    0x00E0,0x0700, 0x01C0,0x0380, 0x0380,0x01C0, 0x0700,0x00E0,
};
static const u16 hero_body_b[64] = {
    0x0000,0x0000, 0x0000,0x0000, 0x0007,0xE000, 0x001F,0xF800,
    0x003F,0xFC00, 0x007F,0xFE00, 0x00FF,0xFF00, 0x01FF,0xFF80,
    0x01FF,0xFF80, 0x03FF,0xFFC0, 0x03FF,0xFFC0, 0x03FF,0xFFC0,
    0x07FF,0xFFE0, 0x07FF,0xFFE0, 0x07FF,0xFFE0, 0x07FF,0xFFE0,
    0x07FF,0xFFE0, 0x07FF,0xFFE0, 0x03FF,0xFFC0, 0x03FF,0xFFC0,
    0x01FF,0xFF80, 0x01FF,0xFF80, 0x00FF,0xFF00, 0x007F,0xFE00,
    0x003F,0xFC00, 0x001F,0xF800, 0x003C,0x3C00, 0x0038,0x1C00,
    0x0070,0x0E00, 0x00E0,0x0700, 0x01C0,0x0380, 0x0380,0x01C0,
};
/* eyes/cap accent (colour 3) — same for both frames, near the top of the head */
static const u16 hero_face[64] = {
    0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000,
    0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000, 0x0030,0x0C00,
    0x0078,0x1E00, 0x0078,0x1E00, 0x0030,0x0C00, 0x0000,0x0000,
    0x0000,0x0000, 0x0000,0x0000, 0x00C0,0x0300, 0x00C0,0x0300,
    0x0070,0x0E00, 0x003F,0xFC00, 0x0000,0x0000, 0x0000,0x0000,
    0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000,
    0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000,
    0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000,
};

/* ── GAME LOGIC (clay) — 16x16 sprite masks (16 rows × 16 bits, bit15 left) ── */
static const u16 coin_mask[16] = {
    0x0000, 0x07E0, 0x1FF8, 0x3C3C, 0x381C, 0x73CE, 0x77EE, 0x77EE,
    0x77EE, 0x77EE, 0x73CE, 0x381C, 0x3C3C, 0x1FF8, 0x07E0, 0x0000
};
static const u16 spike_mask[16] = {
    0x0000, 0x0000, 0x0180, 0x0180, 0x03C0, 0x03C0, 0x07E0, 0x07E0,
    0x0FF0, 0x0FF0, 0x1FF8, 0x1FF8, 0x3FFC, 0x7FFE, 0xFFFF, 0xFFFF
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

/* grass: colour-2 body with a colour-3 lip on the top 2 rows */
static void make_grass_tile(u16 *t) {
    make_solid_tile(t, 2);            /* body = colour 2 (plane1)             */
    t[0] |= 0x00FF;                   /* rows 0,1: set plane0 too → colour 3  */
    t[1] |= 0x00FF;
}

/* one-way slab: a colour-3 bar on the TOP 4 rows only (you jump up through
 * the transparent bottom) */
static void make_slab_tile(u16 *t) {
    u8 r;
    for (r = 0; r < 16; ++r) t[r] = 0;
    for (r = 0; r < 4; ++r) { t[r] = 0x00FF; t[r + 8] = 0x00FF; }  /* colour 3 */
}

/* one-colour 16x16 sprite cell from a 16-row mask */
static void make_sprite16(u16 vram, const u16 *mask, u8 ci) {
    u8 r;
    for (r = 0; r < 64; ++r) spr_buf[r] = 0;
    for (r = 0; r < 16; ++r) {
        if (ci & 1) spr_buf[r]      = mask[r];   /* plane 0 */
        if (ci & 2) spr_buf[r + 16] = mask[r];   /* plane 1 */
    }
    load_tiles(vram, spr_buf, 64);
}

static void upload_font(void) {
    u8 g, row, bits, px2;
    for (g = 0; g < NUM_GLYPHS; ++g) {
        for (row = 0; row < 16; ++row) tile_buf[row] = 0;
        for (row = 0; row < 7; ++row) {
            bits = FONT5x7[g][row];
            px2 = 0;
            if (bits & 0x10) px2 |= 0x40;
            if (bits & 0x08) px2 |= 0x20;
            if (bits & 0x04) px2 |= 0x10;
            if (bits & 0x02) px2 |= 0x08;
            if (bits & 0x01) px2 |= 0x04;
            tile_buf[row] = (u16)px2;
        }
        load_tiles((u16)(FONT_VRAM + g * 16), tile_buf, 16);
    }
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * LARGE-SPRITE PATTERN LAYOUT — the half of the big-hero trick that lives in
 * VRAM. A 32x32 HuC6270 sprite is FOUR 16x16 cells (64 words each) stored
 * consecutively in TL, TR, BL, BR order, and its SATB pattern code must be
 * 4-ALIGNED (the hardware ignores the low 2 bits and adds them back as
 * column/row). Get the order wrong and the hero renders scrambled — four
 * recognizable quarters in the wrong places. The other half of the trick
 * (the SATB attribute bits) is in push_sprites() below.
 *
 * `body` selects the walk frame (hero_body_a / hero_body_b). `face` is the
 * colour-3 accent shared by both. We upload BOTH frames' worth of cells when
 * the walk phase flips — cheap (256 words) and only on phase change.
 *
 * requires: PLAYER_VRAM >> 6 a multiple of 4; 4 consecutive free cells
 *           (256 words) at PLAYER_VRAM; set_sprite_ex() from pce_video.c. */
static void upload_hero(const u16 *body) {
    u8 cr, cc, row;
    u16 body_bits, face_bits;
    u16 vram = PLAYER_VRAM;
    for (cr = 0; cr < 2; ++cr) {              /* cell row (top/bottom)        */
        for (cc = 0; cc < 2; ++cc) {          /* cell col (left/right)        */
            for (row = 0; row < 64; ++row) spr_buf[row] = 0;
            for (row = 0; row < 16; ++row) {
                u8 y = (u8)(cr * 16 + row);
                body_bits = body[y * 2 + cc];
                face_bits = hero_face[y * 2 + cc];
                /* body pixels = colour 1 (plane0); face accents = colour 3
                 * (planes 0+1) — the accent is a subset of the body.        */
                spr_buf[row]      = body_bits;
                spr_buf[row + 16] = face_bits;
            }
            load_tiles(vram, spr_buf, 64);
            vram += 64;                       /* next cell: TL,TR,BL,BR       */
        }
    }
}

static void upload_art(void) {
    upload_font();
    make_solid_tile(tile_buf, 1); load_tiles(SKY_VRAM, tile_buf, 16);
    make_solid_tile(tile_buf, 2); load_tiles(DIRT_VRAM, tile_buf, 16);
    make_grass_tile(tile_buf);    load_tiles(GRASS_VRAM, tile_buf, 16);
    make_slab_tile(tile_buf);     load_tiles(SLAB_VRAM, tile_buf, 16);
    make_solid_tile(tile_buf, 2); load_tiles(HUDBAND_VRAM, tile_buf, 16);
    make_sprite16(COIN_VRAM,  coin_mask,  1);
    make_sprite16(SPIKE_VRAM, spike_mask, 1);
    upload_hero(hero_body_a);
}

/* ── GAME LOGIC (clay) — BAT text + level paint ─────────────────────────────── */
static void put_glyph(u8 col, u8 row, u8 glyph) {
    u16 e = BAT_ENTRY(1, (u16)(FONT_VRAM + glyph * 16));  /* pal 1 = white    */
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
 * HARDWARE BG SCROLL via BXR + COLUMN STREAMING — the PCE's smoothest trick.
 * The BAT is a 32x32 (256px) virtual map that WRAPS, and the VDC's R7 (BXR)
 * shifts the whole background horizontally with ZERO CPU per pixel. For a
 * world WIDER than 256px we stream: as the camera advances, each BAT column
 * about to wrap into view is rewritten with the next world column's tiles.
 * Paint a column ONCE when it enters; from then on the scroll is free.
 *
 * THE HUD CAVEAT: BXR scrolls the ENTIRE background, including the top rows.
 * The PCE has no hardware "window" plane (the Genesis trick), and no built-in
 * raster split (the SMS/NES trick) in this minimal lib. So we keep the HUD
 * readable by drawing it into the BAT rows 0-2 EVERY column we stream — the
 * HUD text scrolls with the world, but because it's repainted into each fresh
 * column it appears continuous across the whole top of the screen. A fancier
 * fork can add a raster IRQ to reset BXR mid-frame for a truly fixed HUD; see
 * TROUBLESHOOTING. For a clean teaching scaffold this "painted band" HUD is
 * honest and flicker-free.
 *
 * requires: BXR written every frame (we do, in the loop); each world column
 *   painted exactly once as it enters; the BAT 32x32 (vdc_init's MWR). */
static u16 bat_entry_for(int16_t worldCol, u8 row) {
    u8 g = ground_row[worldCol];
    if (row < HUD_ROWS) return BAT_ENTRY(0, HUDBAND_VRAM);   /* HUD band      */
    if (row < VIS_ROWS) {
        if (plat_row[worldCol] && row == plat_row[worldCol])
            return BAT_ENTRY(0, SLAB_VRAM);                  /* one-way slab  */
        if (g != NO_GROUND) {
            if (row == g) return BAT_ENTRY(0, GRASS_VRAM);   /* grass top     */
            if (row > g)  return BAT_ENTRY(0, DIRT_VRAM);    /* ground body   */
        }
    }
    return BAT_ENTRY(0, SKY_VRAM);                           /* sky backdrop  */
}

/* Write one world column into its wrapped BAT column. */
static void paint_column(int16_t worldCol) {
    u8 ntCol, row;
    u16 e;
    if (worldCol < 0 || worldCol >= WORLD_COLS) return;
    ntCol = (u8)(worldCol & 31);
    for (row = 0; row < 32; ++row) {
        e = bat_entry_for(worldCol, row);
        vram_set_write_addr((u16)(BAT_VRAM + row * 32 + ntCol));
        VDC_DATA_LO = (u8)(e & 0xFF);
        VDC_DATA_HI = (u8)(e >> 8);
    }
}

/* Repaint the first 32 columns (one screen) from scratch — used when (re)entering
 * the level so the visible window is correct before the first scroll. */
static void paint_screen_from(int16_t firstCol) {
    int16_t c;
    for (c = firstCol; c < firstCol + 32; ++c)
        if (c >= 0 && c < WORLD_COLS) paint_column(c);
}

/* Fill the whole 32x32 BAT with sky (title / game-over backdrop). */
static void paint_flat_sky(void) {
    u8 r, c;
    u16 e = BAT_ENTRY(0, SKY_VRAM);
    for (r = 0; r < 32; ++r) {
        vram_set_write_addr((u16)(BAT_VRAM + r * 32));
        for (c = 0; c < 32; ++c) {
            VDC_DATA_LO = (u8)(e & 0xFF);
            VDC_DATA_HI = (u8)(e >> 8);
        }
    }
}

/* HUD: row 1 = "P1 x3 SC 00000 HI 00000". The HUD lives in the BAT band rows
 * (painted into every streamed column), so writing the numbers once at the
 * left of the BAT keeps them at screen-left while BXR scrolls (they reappear
 * via the band but the live digits are what the player reads). */
static void draw_hud_numbers(void) {
    put_glyph(1, 1, (u8)(G_ALPHA + ('P' - 'A')));
    put_glyph(2, 1, (u8)(G_DIGIT + 1 + cur_player));
    put_glyph(4, 1, (u8)(G_ALPHA + ('X' - 'A')));
    put_glyph(5, 1, (u8)(G_DIGIT + p_lives[cur_player]));
    draw_text(7, 1, "SC");
    draw_num5(10, 1, p_score[cur_player]);
    draw_text(17, 1, "HI");
    draw_num5(20, 1, hiscore);
}

/* ── HARDWARE TRUTH: a bare HuCard CANNOT save a hi-score (in-session only) ──
 * This was researched and corrected: earlier versions wrote the hi-score to
 * BRAM ("backup RAM", bank $F7) and claimed it persisted across power cycles.
 * That is NOT honest for a HuCard game. On REAL hardware a plain HuCard plugged
 * into a base PC Engine / TurboGrafx-16 has NO backup RAM at all — BRAM exists
 * ONLY when a peripheral is attached: the CD-ROM² System (2KB kept by a
 * supercapacitor), the Tennokoe Bank HuCard, or the Memory Base 128. No
 * commercial HuCard self-saved; they used PASSWORDS. (The often-cited Populous
 * "ROMRAM" SRAM was the game's own working RAM, not a battery save.) An
 * emulator like geargrafx exposes BRAM unconditionally, so the old code
 * "worked" in emulation in a way the real machine never would.
 *
 * So this game keeps an IN-SESSION hi-score only (like the honest 2600/Lynx
 * examples) — it survives game-overs within a power-on, resets to 0 on a cold
 * boot. To make it ACTUALLY persist on real hardware you would target a
 * peripheral: write to BRAM only after detecting one (and go through the System
 * Card BIOS's 'HUBM' directory for CD saves), or move the game to a CD-ROM²
 * build. Either is a real-hardware feature, not a property of the cartridge.  */
static u16 hiscore_load(void) {
    return 0;          /* cold boot: no persistence on a bare HuCard */
}

static void hiscore_save(u16 v) {
    (void)v;           /* in-session only — nowhere to persist on real HW */
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
static const u8 MEL_TITLE[16] = { G4,C5,E5,C5, A4,C5,G4,E4, F4,A4,C5,A4, G4,E4,D4,C4 };
static const u8 BAS_TITLE[8]  = { C3,C3, F3,F3, A2N,A2N, G3,G3 };
static const u8 MEL_PLAY[16]  = { C4,E4,G4,E4, F4,A4,G4,E4, D4,F4,A4,G4, E4,G4,C5,R  };
static const u8 BAS_PLAY[8]   = { C3,C3, F3,F3, A2N,A2N, G3,G3 };
static const u8 MEL_OVER[16]  = { C5,R,A4,R, G4,R,E4,R, D4,R,C4,R, A2N,R,R,R };

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

/* ── GAME LOGIC (clay) — helpers ──────────────────────────────────────────── */
static u8 random8(void) {
    u16 r = rng;
    r ^= r << 7;
    r ^= r >> 9;
    r ^= r << 8;
    rng = r;
    return (u8)r;
}

static u8 dist8(int16_t a, int16_t b) {
    int16_t d = (int16_t)(a - b);
    if (d < 0) d = (int16_t)-d;
    return (d > 255) ? 255 : (u8)d;
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * SPRITE STAGING + THE SATB DMA. The VDC never reads your RAM: sprites live
 * in its INTERNAL sprite attribute table, refreshed by a DMA you schedule by
 * writing R19 (satb_dma() does the copy + the R19 write; the transfer itself
 * happens at the next vblank). So the per-frame contract is:
 *   waitvsync() → restage EVERY slot → satb_dma()
 * Stage during vblank — satb_dma() also streams 256 words through the VWR
 * port, and doing that mid-display tears sprite pattern fetches.
 *
 * THE HERO (a PCE signature): ONE 32x32 SATB entry — SPR_CGX_32|SPR_CGY_32 in
 * the attribute word — for a big, readable character. CGX goes 32, CGY goes
 * 32 (or 64 for a 32x64 tower from a single entry). The NES needs 4 hardware
 * sprites (and the per-scanline budget) for the same thing.
 *
 * requires: set_sprite_ex() + the 4-aligned hero cells from upload_hero(). */
static void push_sprites(void) {
    u8 i;
    int16_t player_y = (int16_t)(py_q44 >> 4);
    int16_t sx = (int16_t)(px - 8);            /* center the 32-wide sprite   */
    /* hero (slot 0) — 32x32 large sprite; blink during the turn breather */
    if (state == ST_PLAY && (turn_pause == 0 || (turn_pause & 4)))
        set_sprite_ex(SLOT_PLAYER, (u16)sx, (u16)player_y, PLAYER_PAT, PAL_PLAYER,
                      SPR_CGX_32 | SPR_CGY_32);
    else
        set_sprite_ex(SLOT_PLAYER, 0, OFFSCREEN_Y, PLAYER_PAT, PAL_PLAYER,
                      SPR_CGX_32 | SPR_CGY_32);
    for (i = 0; i < NUM_COINS; ++i) {
        u8 vis = (state == ST_PLAY) && coins[i].alive &&
                 coins[i].x >= 0 && coins[i].x < SCREEN_W;
        set_sprite((u8)(SLOT_COIN + i), vis ? (u16)coins[i].x : 0,
                   vis ? (u16)coins[i].y : OFFSCREEN_Y, COIN_PAT, PAL_COIN);
    }
    for (i = 0; i < NUM_SPIKES; ++i) {
        u8 vis = (state == ST_PLAY) && spikes[i].alive &&
                 spikes[i].x >= 0 && spikes[i].x < SCREEN_W;
        set_sprite((u8)(SLOT_SPIKE + i), vis ? (u16)spikes[i].x : 0,
                   vis ? (u16)spikes[i].y : OFFSCREEN_Y, SPIKE_PAT, PAL_SPIKE);
    }
}

/* ── GAME LOGIC (clay) — coins + spikes (sprite objects in the world) ── */
static const int16_t coin_heights[4] = { 176, 152, 120, 144 };
static void respawn_coin(u8 i) {
    coins[i].x = (int16_t)(SCREEN_W + 8 + (random8() & 31));   /* enter right */
    coins[i].y = coin_heights[random8() & 3];
    coins[i].alive = 1;
}

static void try_spawn_spike(u8 i) {
    /* Anchor only over ground: an inactive spike rolls a low per-frame chance
     * and only spawns if the world column entering at the right edge has
     * ground under it (never floats over a pit). */
    int16_t c = (int16_t)(((camX + SCREEN_W + 8) >> 3));
    if (c < 0 || c >= WORLD_COLS) return;
    if (ground_row[c] == NO_GROUND) return;
    if (random8() > 4) return;
    spikes[i].x = (int16_t)(SCREEN_W + 8);
    spikes[i].y = SPIKE_Y;
    spikes[i].alive = 1;
}

/* ── GAME LOGIC (clay) — landing probe against the column map ──────────────
 * One-way platforms, arcade-classic style: only catch the player while
 * FALLING through a narrow window at the surface: top-1 (the standing snap
 * parks feet exactly at top, and gravity's sub-pixel trickle doesn't move the
 * integer y every frame — without the -1 slack the player "stands" with
 * on_ground=0 most frames, so jumps only register on lucky frames) through
 * top+4 (so a fast fall can't step over it). */
static int16_t land_top(int16_t c, int16_t feet) {
    u8 r;
    int16_t top;
    if (c < 0 || c >= WORLD_COLS) return 0;
    r = plat_row[c];
    if (r) {
        top = (int16_t)(r << 3);
        if (feet + 1 >= top && feet <= top + 4) return top;
    }
    r = ground_row[c];
    if (r != NO_GROUND) {
        top = (int16_t)(r << 3);
        if (feet + 1 >= top && feet <= top + 4) return top;
    }
    return 0;
}

/* ── GAME LOGIC (clay) — screen painters (full repaint per state change) ── */
static void paint_title(void) {
    paint_flat_sky();
    draw_text((u8)((32 - (sizeof(GAME_TITLE) - 1)) / 2), 7, GAME_TITLE);
    draw_text(10, 13, "1P RUN - I");
    draw_text(10, 15, "2P TURNS - II");
    draw_text(11, 19, "HI");
    draw_num5(14, 19, hiscore);
    draw_text(6, 23, "JUMP PITS GRAB COINS");
}

static void paint_over(void) {
    paint_flat_sky();
    draw_text(11, 9, "GAME OVER");
    draw_text(10, 12, "P1");
    draw_num5(14, 12, p_score[0]);
    if (two_player) {
        draw_text(10, 14, "P2");
        draw_num5(14, 14, p_score[1]);
    }
    draw_text(10, 17, "HI");
    draw_num5(14, 17, hiscore);
    draw_text(8, 21, "RUN - TITLE");
}

/* ── GAME LOGIC (clay) — start a turn / a run ── */
static void begin_turn(void) {
    u8 i;
    px = 24;
    py_q44 = (int16_t)((GROUND_TOP - 16) << 4);
    vy_q44 = 0;
    on_ground = 1;
    camX = 0;
    lastCamCol = 0;
    dist_sub = 0;
    coins[0].x = 120; coins[0].y = 176; coins[0].alive = 1;
    coins[1].x = 200; coins[1].y = 152; coins[1].alive = 1;
    coins[2].x = 248; coins[2].y = 120; coins[2].alive = 1;
    for (i = 0; i < NUM_SPIKES; ++i) spikes[i].alive = 0;
    spikes[0].x = 160; spikes[0].y = SPIKE_Y; spikes[0].alive = 1;
    spikes[1].x = 232; spikes[1].y = SPIKE_Y; spikes[1].alive = 1;
    turn_pause = 30;                         /* "P1/P2 ready" breather flash */
    prev_pad = 0xFF;                         /* swallow held buttons         */
    paint_screen_from(0);                    /* repaint the visible window   */
    draw_hud_numbers();
    vdc_set_reg(VDC_BXR, 0);
}

static void start_game(u8 players) {
    two_player = players;
    cur_player = 0;
    p_score[0] = p_score[1] = 0;
    p_lives[0] = START_LIVES;
    p_lives[1] = players ? START_LIVES : 0;
    begin_turn();
    music_set(ST_PLAY);
    psg_tone(2, 0x180, 28); sfx_timer = 6;   /* start blip                   */
    state = ST_PLAY;
}

static void game_over(void) {
    u16 best = p_score[0];
    if (two_player && p_score[1] > best) best = p_score[1];
    if (best > hiscore) {
        hiscore = best;
        hiscore_save(hiscore);               /* in-session only (no save on a bare HuCard) */
    }
    vdc_set_reg(VDC_BXR, 0);                  /* unscroll for the flat screen */
    paint_over();
    music_set(ST_OVER);
    state = ST_OVER;
}

/* ── GAME LOGIC (clay) — death + alternating-turn handoff ── */
static void kill_player(void) {
    u8 other;
    psg_tone(3, 0x500, 31);                   /* death rumble                 */
    sfx_timer = 16;
    if (p_lives[cur_player] > 0) --p_lives[cur_player];
    if (two_player) {
        other = (u8)(cur_player ^ 1);
        if (p_lives[other] > 0) cur_player = other;          /* swap turns   */
        else if (p_lives[cur_player] == 0) { game_over(); return; }
    } else if (p_lives[0] == 0) {
        game_over();
        return;
    }
    begin_turn();
}

/* ── GAME LOGIC (clay) — the per-frame play update ────────────────────────── */
static void update_play(void) {
    u8 i;
    int16_t delta, y8, feet, c0, c1, top, sx;
    int16_t camCol;
    int32_t np;

    if (turn_pause) { --turn_pause; return; }

    /* horizontal move; past SCROLL_WALL the world scrolls instead of the
     * player (the camera never scrolls back — the classic one-way camera). */
    delta = 0;
    if (pad & PCE_JOY_RIGHT) {
        if (px < SCROLL_WALL) px = (int16_t)(px + (MOVE >> 4) + 1);
        else {
            int16_t adv = (int16_t)((MOVE >> 4) + 1);
            if (camX + adv <= WORLD_W - SCREEN_W) { camX = (int16_t)(camX + adv); delta = adv; }
        }
    }
    if ((pad & PCE_JOY_LEFT) && px > 8) px = (int16_t)(px - ((MOVE >> 4) + 1));

    /* jump (button I), only when grounded */
    if ((pad & PCE_JOY_I) && !(prev_pad & PCE_JOY_I) && on_ground) {
        vy_q44 = JUMP_VEL;
        on_ground = 0;
        psg_tone(2, 0x200, 26); sfx_timer = 6;
    }

    /* stream the columns entering from the right as the camera advances */
    camCol = (int16_t)(camX >> 3);
    while (camCol > lastCamCol) { lastCamCol++; paint_column((int16_t)(lastCamCol + 31)); }

    /* smooth pixel scroll via the BG X register — the whole point */
    vdc_set_reg(VDC_BXR, (u16)camX);

    /* world objects drift left as the level scrolls (world-anchored) */
    if (delta) {
        dist_sub = (u8)(dist_sub + delta);
        if (dist_sub >= 64) {
            dist_sub = (u8)(dist_sub - 64);
            ++p_score[cur_player];
            hud_dirty = 1;
        }
        for (i = 0; i < NUM_COINS; ++i) {
            if (!coins[i].alive) continue;
            coins[i].x = (int16_t)(coins[i].x - delta);
            if (coins[i].x < -16) respawn_coin(i);
        }
        for (i = 0; i < NUM_SPIKES; ++i) {
            if (!spikes[i].alive) continue;
            spikes[i].x = (int16_t)(spikes[i].x - delta);
            if (spikes[i].x < -16) spikes[i].alive = 0;
        }
    }
    for (i = 0; i < NUM_SPIKES; ++i)
        if (!spikes[i].alive) try_spawn_spike(i);

    /* physics: gravity + sub-pixel y */
    vy_q44 = (int16_t)(vy_q44 + GRAVITY);
    if (vy_q44 > MAX_VY) vy_q44 = MAX_VY;
    np = (int32_t)py_q44 + (int32_t)vy_q44;
    py_q44 = (int16_t)np;
    y8 = (int16_t)(py_q44 >> 4);

    /* fell into a pit (below the screen) → lose the turn */
    if (y8 >= 216) { kill_player(); return; }

    /* landing — probe the two world columns under the player's feet (feet =
     * sprite bottom; the 32px sprite's feet are ~16px below its top y). */
    if (vy_q44 >= 0) {
        feet = (int16_t)(y8 + 16);
        c0 = (int16_t)((camX + px) >> 3);
        c1 = (int16_t)((camX + px + 7) >> 3);
        top = land_top(c0, feet);
        if (top == 0) top = land_top(c1, feet);
        if (top) {
            py_q44 = (int16_t)((top - 16) << 4);
            vy_q44 = 0;
            if (!on_ground) { psg_tone(3, 0x2A0, 22); sfx_timer = 3; }
            on_ground = 1;
        } else {
            on_ground = 0;
        }
    }

    /* coins (collect) + spikes (death). AABB around the player center. */
    sx = (int16_t)(px - 8);
    for (i = 0; i < NUM_COINS; ++i) {
        if (!coins[i].alive) continue;
        if (dist8(coins[i].x, sx) < 18 && dist8(coins[i].y, y8) < 18) {
            coins[i].alive = 0;
            p_score[cur_player] += 10;
            hud_dirty = 1;
            psg_tone(2, 0x0D6, 31); sfx_timer = 6;
            respawn_coin(i);
        }
    }
    for (i = 0; i < NUM_SPIKES; ++i) {
        if (!spikes[i].alive) continue;
        if (dist8(spikes[i].x, sx) < 14 && dist8(spikes[i].y, y8) < 16) {
            kill_player();
            return;
        }
    }

    /* walk-cycle animation: flip the hero frame every 8 px of camera/x travel */
    if (delta || (pad & (PCE_JOY_LEFT | PCE_JOY_RIGHT))) {
        ++anim_frame;
        if ((anim_frame & 7) == 0) upload_hero((anim_frame & 8) ? hero_body_b : hero_body_a);
    }
}

void main(void) {
    u8 newpad, raw1, raw2;

    _pce_keep[0] = 0;   /* see the EMPTY-BSS TRAP note in pce_hw.h */

    /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
     * Init order: palette → VRAM uploads → BAT paint → joypad → display ON.
     * disp_enable() also sets the VBlank IRQ bit — without it waitvsync()
     * never returns and the game freezes on its first frame. */
    /* BG sub-pal 0: scenery. BG sub-pal 1: HUD/text (white). */
    vce_set_color(0,   PCE_RGB(1, 2, 5));   /* backdrop: dusk blue            */
    vce_set_color(1,   PCE_RGB(2, 4, 7));   /* BG c1: sky                     */
    vce_set_color(2,   PCE_RGB(3, 2, 1));   /* BG c2: brown dirt              */
    vce_set_color(3,   PCE_RGB(1, 6, 1));   /* BG c3: grassy green            */
    vce_set_color(17,  PCE_RGB(7, 7, 7));   /* text: white                    */
    /* sprite sub-palettes (256 + pal*16 + index) */
    vce_set_color(257, PCE_RGB(7, 4, 1));   /* pal0 c1: hero orange body      */
    vce_set_color(259, PCE_RGB(7, 7, 4));   /* pal0 c3: hero face/cap accent  */
    vce_set_color(273, PCE_RGB(7, 7, 0));   /* pal1 c1: coin gold             */
    vce_set_color(289, PCE_RGB(7, 1, 1));   /* pal2 c1: spike danger red      */

    upload_art();

    hiscore = hiscore_load();   /* always 0 — no persistence on a bare HuCard */
    state = ST_TITLE;
    paint_title();
    music_set(ST_TITLE);

    pce_joy_init();
    disp_enable();

    for (;;) {
        waitvsync();

        /* vblank work first: sprites + SATB DMA + queued HUD writes */
        push_sprites();
        satb_dma();
        if (hud_dirty && state == ST_PLAY) { draw_hud_numbers(); hud_dirty = 0; }

        music_tick();
        if (sfx_timer) {
            --sfx_timer;
            if (sfx_timer == 0) { psg_off(2); psg_off(3); }
        }

        /* ── HARDWARE IDIOM (load-bearing) — 2P input via the TurboTap.
         * pce_joy_read() reads pad 1 (slot 0). For pad 2 we read cc65's
         * JOY_2 directly and translate it like pce_input.c does, so the
         * CURRENT player's pad drives the game during their alternating turn.
         * The host enables the TurboTap, so JOY_2 carries real port-1 input.
         * On the title screen we always read pad 1 (the menu pad). */
        raw1 = pce_joy_read();
        if (state == ST_PLAY && cur_player == 1) {
            raw2 = joy_read(JOY_2);           /* cc65 raw mask for pad 2      */
            pad = 0;                           /* translate like pce_input.c  */
            if (JOY_UP(raw2))    pad |= PCE_JOY_UP;
            if (JOY_DOWN(raw2))  pad |= PCE_JOY_DOWN;
            if (JOY_LEFT(raw2))  pad |= PCE_JOY_LEFT;
            if (JOY_RIGHT(raw2)) pad |= PCE_JOY_RIGHT;
            if (JOY_BTN_1(raw2)) pad |= PCE_JOY_I;
            if (JOY_BTN_2(raw2)) pad |= PCE_JOY_II;
            if (JOY_BTN_3(raw2)) pad |= PCE_JOY_SELECT;
            if (JOY_BTN_4(raw2)) pad |= PCE_JOY_RUN;
        } else {
            pad = raw1;
        }
        newpad = (u8)(pad & ~prev_pad);

        if (state == ST_TITLE) {
            prev_pad = pad;
            if (newpad & (PCE_JOY_RUN | PCE_JOY_I)) start_game(0);
            else if (newpad & PCE_JOY_II) start_game(1);
            continue;
        }
        if (state == ST_OVER) {
            prev_pad = pad;
            if (newpad & (PCE_JOY_RUN | PCE_JOY_I)) {
                state = ST_TITLE;
                vdc_set_reg(VDC_BXR, 0);
                paint_title();
                music_set(ST_TITLE);
            }
            continue;
        }

        update_play();
        prev_pad = pad;
    }
}
