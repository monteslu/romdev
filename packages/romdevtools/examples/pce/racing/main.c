/* ── main.c — PC Engine top-down road racer (complete example game) ───────────
 *
 * PINION PURSUIT — a COMPLETE, working game: title screen, 1P endless race with
 * speed control, 2P simultaneous SPLIT-LANE VERSUS (both cars on screen at once,
 * P2 on the TurboTap's second pad), a vertically-scrolling road done the PC
 * Engine way (hardware BG Y-scroll via the VDC's BYR register), streamed
 * roadside scenery as the road wraps, crash/lives rules, in-session best
 * distance (a bare HuCard can't save — see the best-distance note), PSG music + SFX.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented PCE footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — traffic patterns, speeds, tuning, art: reshape freely.
 *
 * What depends on what:
 *   pce_hw.h / pce_video.c / pce_input.c / pce_sound.c — the helper lib
 *     (VDC/VCE/PSG register dances + joypad). The HARDWARE IDIOM markers in
 *     pce_video.c say which parts are load-bearing.
 *   cc65's pce crt0 + pce.lib are auto-linked; the 'rom32k' linker preset
 *     (applied automatically to example projects) gives a 32KB HuCard.
 *
 * THE DESIGN (read before reshaping):
 *   Scrolling — the road is the BACKGROUND, scrolled DOWN by INCREMENTING the
 *     VDC's BYR register each frame (driving up = the road slides toward you).
 *     The PCE wins here: its BAT is a 32x32 (256px-tall) virtual map and the
 *     VDC masks BYR to the plane IN HARDWARE, so `road_scroll += speed` on a
 *     plain u8 is the whole idiom — 256 wraps seamlessly forever. Compare the
 *     NES racing template (examples/nes/templates/racing.c): there a nametable
 *     is only 240px tall, scroll_y 240-255 fetches attribute bytes as garbage
 *     tiles, and EVERY scroll change must run through a 240-wrap helper. The
 *     SMS (examples/sms/templates/racing.c) wraps at 224. On the PCE there is
 *     no wrap math at all. Cars/traffic are hardware sprites with their own Y.
 *   Streamed scenery — see the BYR idiom below: as the road wraps, the BAT row
 *     re-entering at the top gets restamped with fresh random roadside so the
 *     256-px loop never shows the same scenery twice. The swap hides under the
 *     HUD band (the PCE's curtain — same trick the Genesis window HUD plays).
 *   HUD — the PCE has no hardware window plane and this minimal lib does no
 *     raster split, so (like the platformer template's painted-band HUD) the
 *     status row is BAT tiles at the top. Because BYR scrolls the WHOLE BG, we
 *     keep the HUD readable by parking it in BAT rows the scroll never exposes:
 *     the road only ever occupies the play band, and the top 2 BAT rows hold a
 *     fixed HUD band repainted with each scenery stream so it reads continuous.
 *   2P VERSUS — ONE VDC means ONE road scroll, so both players share one road
 *     at a fixed speed and only STEER (the same constraint the NES/Genesis
 *     versions explain): solid center divider, P1 (cyan, port 0) owns the left
 *     two lanes, P2 (amber, TurboTap port 1) the right two. Each starts with 3
 *     crashes; first to use them all LOSES.
 *   1P RACE — all four lanes, UP/I accelerates, DOWN/II brakes (speed 1-4);
 *     3 crashes end the run. Persistent stat: best DISTANCE (u16, one unit =
 *     16 scrolled pixels ≈ one car length); in-session only (see the note below).
 *
 * 2P, honestly: the stock PC Engine has ONE controller port; 2P needs a
 * TurboTap. The geargrafx core implements the TurboTap and the romdev host
 * force-ENABLES it (PLATFORM_CORE_OPTIONS pce: geargrafx_turbotap), so a second
 * pad's input reaches the game on pad slot 2 — verified by driving port-1 input
 * and seeing car 2 move. So this game ships REAL simultaneous 2P versus. (On
 * real hardware the player plugs a TurboTap and a second pad.)
 *
 * Frame budget (NTSC, 60fps, 7.16MHz 65C02-class CPU): 4 traffic + 2 cars AABB,
 * one BAT row restamp at most every other frame, an 8-entry SATB copy in
 * vblank — a tiny fraction of a frame. Hardware BYR scroll is one register.
 */
#include <pce.h>
#include <stdint.h>   /* int16_t for the per-frame speed step                  */
#include <joystick.h> /* JOY_2 + joy_read for the 2nd pad (TurboTap port 1)    */
#include "pce_hw.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "PINION PURSUIT"

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * VRAM map (WORD addresses — the VDC is a 16-bit-word machine; an 8x8 tile is
 * 16 words, a 16x16 sprite cell is 64). Sprites and BG tiles share one 64KB
 * VRAM, so lay it out ONCE and keep the SATB out of pattern space:
 *   $0000  BAT (32x32 background map — matches vdc_init's VDC_MWR setting)
 *   $1000  font glyphs (38 tiles: blank, 0-9, A-Z, dash) — BG text only
 *   $1400  road furniture tiles (grass, asphalt, dash, edge, divider, band)
 *   $1800  16x16 sprite cells: player car, traffic car
 *   $1900  16x16 sprite DIGIT cells (0-9) for the SPRITE HUD (see HUD idiom) */
#define BAT_VRAM      0x0000
#define FONT_VRAM     0x1000
#define GRASS_VRAM    0x1400   /* roadside grass (BG colour 1)                 */
#define ROAD_VRAM     0x1410   /* asphalt (BG colour 2)                        */
#define DASH_VRAM     0x1420   /* asphalt + a colour-3 lane dash              */
#define EDGE_VRAM     0x1430   /* solid colour-3 shoulder / centre divider    */
#define BAND_VRAM     0x1440   /* flat band behind the title/result text      */
#define PLAYER_VRAM   0x1800   /* 16x16 player car                            */
#define ENEMY_VRAM    0x1840   /* 16x16 traffic car                           */
#define SDIGIT_VRAM   0x1900   /* 10 consecutive 16x16 digit cells (0..9)     */

#define BAT_ENTRY(pal, vram)  ((u16)(((pal) << 12) | ((vram) >> 4)))

/* Sprite pattern codes = VRAM >> 6 (the 16x16 cell index). */
#define PLAYER_PAT  (PLAYER_VRAM >> 6)
#define ENEMY_PAT   (ENEMY_VRAM >> 6)
#define SDIGIT_PAT  (SDIGIT_VRAM >> 6)   /* digit d → SDIGIT_PAT + d (cells are *4 words apart = +1 pattern code) */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Road geometry. Four 4-cell-wide lanes between shoulders, a solid centre
 * divider (it's also the 2P territory line). BAT columns (cells):
 *   8  = left shoulder, 12/20 = dashed lane lines, 16 = centre divider,
 *   24 = right shoulder; grass outside. The BAT is 32 cells (256px) wide. */
#define COL_EDGE_L   8
#define COL_DASH_1   12
#define COL_DIVIDER  16
#define COL_DASH_2   20
#define COL_EDGE_R   24
/* Lane centre X for the 16px-wide car sprite (lane i spans 32 px). */
static const u16 lane_x[4] = { 80, 112, 144, 176 };

#define MAX_TRAFFIC  4         /* sprite slots 2-5 (0=P1, 1=P2)               */
#define CAR_Y        176       /* both players' fixed screen Y                */
#define SPAWN_Y      28        /* traffic entry Y — BELOW the sprite HUD line  */
#define HUD_Y        8         /* sprite HUD scanline (digits live here)       */
#define DESPAWN_Y    216       /* traffic exits past the player                */
#define START_LIVES  3         /* crashes per run / per player                 */
#define SPAWN_PERIOD 40        /* frames between traffic spawns — traffic moves
                                * at road speed, so per-meter density stays
                                * constant whatever the player does            */
#define SPEED_2P     2         /* fixed road speed in versus (one VDC = one
                                * scroll = one shared speed; see the design)   */
#define MAX_SPEED    4         /* px/frame — MUST stay under 8: the row
                                * streamer restamps one row per 8px crossing
                                * and a >8px step could skip a row             */

/* SATB slot plan (slot order = priority): 0 = P1, 1 = P2, 2-5 = traffic,
 * 6-11 = the 6 sprite-HUD digits (see the HUD idiom). PAL plan: cars on their
 * own sprite sub-palettes so P1/P2/traffic read as three liveries; digits on
 * the HUD palette. */
#define SLOT_P1     0
#define SLOT_P2     1
#define SLOT_TRAFFIC 2
#define SLOT_HUD    6          /* slots 6..11: crash digit + 5 distance digits  */
#define PAL_P1      0
#define PAL_P2      1
#define PAL_TRAFFIC 2
#define PAL_HUD     3
#define OFFSCREEN_Y 0x1F0      /* park hidden sprites below the display        */

/* ── GAME LOGIC (clay — reshape freely) ── game state ── */
/* Players: index 0 = P1 (port 0), 1 = P2 (TurboTap port 1, versus only). */
static u8  car_lane[2];
static u8  car_active[2];
static u8  crashes_left[2];
static u8  invuln[2];           /* post-crash blink/no-collide frames          */
static u8  lane_cd[2];          /* steer cooldown frames (latency-robust)      */
static u8  prev_pads[2];
static u8  lane_min[2], lane_max[2];   /* 2P: split territories                */
static u8  two_player;
static u8  winner;              /* versus result: 0 = P1, 1 = P2               */

typedef struct { u16 x, y; u8 alive; } Car;
static Car traffic[MAX_TRAFFIC];

static u8  speed;               /* road px/frame, 1..MAX_SPEED                  */
static u16 dist;                /* 1P distance, 1 unit = 16 scrolled px         */
static u8  dist_frac;
static u16 best;                /* persisted best 1P distance                   */
static u8  spawn_timer;
static u8  road_scroll;         /* BG Y scroll. NEVER wrapped by hand: the BAT
                                 * is 256px tall, the VDC masks BYR to the
                                 * plane, and 256 wrapping a u8 is seamless —
                                 * see the BYR idiom (the NES needs a 240-wrap
                                 * helper here, the SMS a 224-wrap).            */
static u8  prev_top_row;        /* last restamped BAT row                       */
static u8  start_pause;         /* green-light freeze frames                    */
static u8  sfx_timer;
static u8  state;               /* ST_TITLE / ST_PLAY / ST_OVER                 */

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2

static u16 tile_buf[16];        /* scratch for one 8x8 tile                     */
static u16 spr_buf[64];         /* scratch for one 16x16 sprite cell            */

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

/* ── GAME LOGIC (clay) — 16x16 car sprite mask (16 rows × 16 bits, bit15 left).
 * A blocky top-down car: cabin, windows, wheels. Colour is the PALETTE, not the
 * bits (one shape, three sub-palettes → P1 cyan, P2 amber, traffic red). */
static const u16 car_mask[16] = {
    0x0660, 0x0660, 0x3FFC, 0x7FFE, 0x7FFE, 0x7FFE, 0x6FF6, 0x6FF6,
    0x7FFE, 0x7FFE, 0x6FF6, 0x6FF6, 0x7FFE, 0x3FFC, 0x6006, 0x6006
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

/* speckled grass: colour-1 body with a few colour-2 specks so the vertical
 * scroll reads (a flat colour shifted N px looks identical to itself). */
static void make_grass_tile(u16 *t) {
    make_solid_tile(t, 1);              /* body = colour 1 (plane0)            */
    t[1] |= 0x1000;                     /* row 1: one plane1 speck → colour 3  */
    t[5] |= 0x0400;                     /* row 5: another speck                */
}

/* asphalt: colour-2 body with a sparse colour-3 speck for the same reason. */
static void make_road_tile(u16 *t) {
    make_solid_tile(t, 2);              /* body = colour 2 (plane1)            */
    t[3] |= 0x0008;                     /* a single colour-3 speck             */
}

/* road tile with a centred colour-3 lane dash on the top 4 rows. */
static void make_dash_tile(u16 *t) {
    u8 r;
    make_road_tile(t);
    for (r = 0; r < 4; ++r) t[r] |= 0x0018;   /* centre 2px → colour 3 (dash)  */
}

/* one-colour 16x16 sprite cell from a 16-row mask (colour = plane0 → index 1) */
static void make_sprite16(u16 vram, const u16 *mask) {
    u8 r;
    for (r = 0; r < 64; ++r) spr_buf[r] = 0;
    for (r = 0; r < 16; ++r) spr_buf[r] = mask[r];   /* plane 0 → colour 1 */
    load_tiles(vram, spr_buf, 64);
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

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * SPRITE HUD digits. The PCE has NO hardware window plane and this minimal lib
 * does no raster split, so a BAT-tile HUD would scroll WITH the road under BYR
 * (and the road-row STREAMER below restamps every BAT row in turn, wiping any
 * tile HUD outright). The honest fix — the same one the NES racing template
 * uses — is a SPRITE HUD: sprites are positioned in SCREEN space and never move
 * with a BG scroll. We build 10 digit cells here and stage them at HUD_Y every
 * frame. Traffic spawns BELOW HUD_Y so the HuC6270's 16-sprites-per-scanline
 * limit is never hit (6 HUD digits + 0 traffic share the line).
 * requires: digit cells consecutive from SDIGIT_VRAM; stage_hud() each frame. */
static void upload_sprite_digits(void) {
    u8 d, row, bits, px;
    for (d = 0; d < 10; ++d) {
        for (row = 0; row < 64; ++row) spr_buf[row] = 0;
        /* reuse the 5x7 glyph for digit d (G_DIGIT + d), centred in the cell */
        for (row = 0; row < 7; ++row) {
            bits = FONT5x7[G_DIGIT + d][row];
            px = 0;
            if (bits & 0x10) px |= 0x40;
            if (bits & 0x08) px |= 0x20;
            if (bits & 0x04) px |= 0x10;
            if (bits & 0x02) px |= 0x08;
            if (bits & 0x01) px |= 0x04;
            spr_buf[row] = (u16)px;        /* plane 0 → colour 1 (white)        */
        }
        load_tiles((u16)(SDIGIT_VRAM + d * 64), spr_buf, 64);
    }
}

static void upload_art(void) {
    upload_font();
    make_grass_tile(tile_buf); load_tiles(GRASS_VRAM, tile_buf, 16);
    make_road_tile(tile_buf);  load_tiles(ROAD_VRAM,  tile_buf, 16);
    make_dash_tile(tile_buf);  load_tiles(DASH_VRAM,  tile_buf, 16);
    make_solid_tile(tile_buf, 3); load_tiles(EDGE_VRAM, tile_buf, 16);
    make_solid_tile(tile_buf, 2); load_tiles(BAND_VRAM, tile_buf, 16);
    make_sprite16(PLAYER_VRAM, car_mask);
    make_sprite16(ENEMY_VRAM,  car_mask);
    upload_sprite_digits();
}

/* ── GAME LOGIC (clay) — BAT text helpers ────────────────────────────────── */
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

/* ── GAME LOGIC (clay) — xorshift16 PRNG ───────────────────────────────────── */
static u16 rng = 0xBEEF;
static u8 random8(void) {
    u16 r = rng;
    r ^= r << 7;
    r ^= r >> 9;
    r ^= r << 8;
    rng = r;
    return (u8)r;
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * HARDWARE BG Y-SCROLL via BYR + STREAMED ROWS — the PCE's road. The BAT is a
 * 32x32 (256px-tall) virtual map and the VDC's R8 (BYR) shifts the whole
 * background vertically with ZERO CPU per pixel. Screen line y shows plane line
 * (BYR + y) & 255, so DECREMENTING road_scroll slides the road DOWN — the
 * driving-up illusion — for one register write per frame. The BAT is 256px tall
 * and the VDC masks BYR to it IN HARDWARE, so a plain u8 wraps at 256 seamlessly
 * forever — the NES racing template (examples/nes/templates/racing.c) needs a
 * 240-wrap helper here (a nametable is 240px tall; scroll_y 240-255 fetches
 * attribute bytes as garbage tiles), and the SMS a 224-wrap. On the PCE there
 * is no wrap math at all.
 *
 * The 32 BAT rows recycle as road_scroll moves: the row crossing into the top
 * of the screen is BAT row (road_scroll >> 3) & 31. The moment it changes we
 * restamp that ONE row with fresh random roadside, so the 256-px loop never
 * shows the same scenery twice. Two rules:
 *   1. Restamp with the address latch armed by vram_set_write_addr() — a row
 *      is 32 contiguous BAT words, so one latch + 32 word writes does it.
 *   2. Road speed stays under 8 px/frame (MAX_SPEED) so a frame never skips a
 *      whole row crossing (the streamer restamps one row per crossing).
 * The HUD is SPRITES (see upload_sprite_digits), so unlike the NES (overscan
 * band) or Genesis (window plane) there's no BG "curtain" to hide a restamp —
 * the restamp lands at the very top edge and the dashes/edges are identical
 * tiles row to row, so the only thing that changes is the random grass speckle,
 * which reads as roadside texture, not a pop.
 *
 * requires: BYR written every frame (we do, in the loop); each BAT row painted
 *   when it enters; the BAT 32x32 (vdc_init's MWR). */
static u16 road_cell(u8 c) {
    if (c == COL_EDGE_L || c == COL_EDGE_R || c == COL_DIVIDER)
        return BAT_ENTRY(0, EDGE_VRAM);                  /* shoulders + divider */
    if (c == COL_DASH_1 || c == COL_DASH_2)
        return BAT_ENTRY(0, DASH_VRAM);                  /* dashed lane lines   */
    if (c > COL_EDGE_L && c < COL_EDGE_R)
        return BAT_ENTRY(0, ROAD_VRAM);                  /* asphalt             */
    return BAT_ENTRY(0, GRASS_VRAM);                     /* roadside grass      */
}

/* Restamp one BAT row with fresh roadside (the dashes/edges are fixed; only the
 * grass speckle phase changes per row via the road_cell tiles themselves). */
static void paint_road_row(u8 row) {
    u8 c;
    vram_set_write_addr((u16)(BAT_VRAM + row * 32));
    for (c = 0; c < 32; ++c) {
        u16 e = road_cell(c);
        VDC_DATA_LO = (u8)(e & 0xFF);
        VDC_DATA_HI = (u8)(e >> 8);
    }
}

/* Initial full road paint (all 32 rows) — used on (re)entering the race. */
static void paint_road(void) {
    u8 r;
    for (r = 0; r < 32; ++r) paint_road_row(r);
}

/* Advance the road by `px` pixels: one BYR write + at most one row restamp.
 * DECREMENT so the road slides DOWN (driving up); the u8 wraps at 256 — idiom. */
static void advance_road(u8 px) {
    u8 top_row;
    road_scroll = (u8)(road_scroll - px);    /* hardware wraps at 256 — idiom  */
    vdc_set_reg(VDC_BYR, (u16)road_scroll);
    top_row = (u8)((road_scroll >> 3) & 31);
    if (top_row != prev_top_row) {
        prev_top_row = top_row;
        paint_road_row(top_row);
    }
}

/* ── HARDWARE TRUTH: a bare HuCard CANNOT save the best distance (in-session) ──
 * This was researched and corrected: earlier versions wrote the best distance
 * to BRAM ("backup RAM", bank $F7) and claimed it persisted across power
 * cycles. That is NOT honest for a HuCard game. On REAL hardware a plain HuCard
 * plugged into a base PC Engine / TurboGrafx-16 has NO backup RAM at all — BRAM
 * exists ONLY when a peripheral is attached: the CD-ROM² System (2KB kept by a
 * supercapacitor), the Tennokoe Bank HuCard, or the Memory Base 128. No
 * commercial HuCard self-saved; they used PASSWORDS. (The often-cited Populous
 * "ROMRAM" SRAM was the game's own working RAM, not a battery save.) An
 * emulator like geargrafx exposes BRAM unconditionally, so the old code
 * "worked" in emulation in a way the real machine never would.
 *
 * So this game keeps an IN-SESSION best only (like the honest 2600/Lynx
 * examples) — it survives across runs within a power-on, resets to 0 on a cold
 * boot. To ACTUALLY persist on real hardware you would target a peripheral
 * (BRAM behind a detect, or a CD-ROM² build) — a real-hardware feature, not a
 * property of the cartridge.                                              */
static u16 best_load(void) {
    return 0;          /* cold boot: no persistence on a bare HuCard */
}

static void best_save(u16 v) {
    (void)v;           /* in-session only — nowhere to persist on real HW */
}

static void best_init(void) {
    best = best_load();   /* always 0 — in-session best starts fresh each boot */
}

/* ── GAME LOGIC (clay) — music: a 2-channel tune ticked once per frame ──────
 * PSG channel plan: 5 = melody, 4 = bass, 0-3 = SFX (tones cut by sfx_timer).
 * PCE frequency regs are DIVIDERS: pitch ≈ 3.58MHz / (32 × value), so a
 * BIGGER number is a LOWER note. Note indices into NOTE_DIV below. */
enum { R = 0, A2N, C3, F3, G3, A3, B3, C4, D4, E4, F4, G4, A4, B4, C5, D5, E5 };
static const u16 NOTE_DIV[17] = {
    0, 1017, 854, 641, 571, 508, 453, 427, 381, 339, 320, 285, 254, 226, 214, 190, 170
};
/* 16 melody steps + 8 bass steps (one bass note per 2 melody steps) */
static const u8 MEL_TITLE[16] = { C4,E4,G4,C5, B4,G4,E4,G4, A4,C5,E5,C5, D5,B4,G4,E4 };
static const u8 BAS_TITLE[8]  = { C3,C3, G3,G3, A2N,A2N, G3,G3 };
static const u8 MEL_PLAY[16]  = { E4,G4,A4,G4, E4,D4,E4,G4, C5,B4,A4,G4, A4,G4,E4,R  };
static const u8 BAS_PLAY[8]   = { A2N,A2N, C3,C3, G3,G3, F3,F3 };
static const u8 MEL_OVER[16]  = { C5,R,G4,R, E4,R,D4,R, C4,R,A2N,R, A2N,R,R,R };

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
        if (music_song != ST_OVER) {       /* the wreck jingle has no bass     */
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

/* short SFX on channels 0-3, auto-cut by sfx_timer */
static void sfx(u8 chan, u16 freq, u8 frames) {
    psg_tone(chan, freq, 31);
    if (frames > sfx_timer) sfx_timer = frames;
}

/* ── GAME LOGIC (clay) — AABB, both boxes 14x14 (16px cars, slight slack). ── */
static u8 hits(u16 ax, u16 ay, u16 bx, u16 by) {
    return (u8)(ax < bx + 14 && ax + 14 > bx && ay < by + 14 && ay + 14 > by);
}

/* ── GAME LOGIC (clay) — traffic pool (fixed slots, no allocation) ── */
static void spawn_traffic(void) {
    u8 i;
    for (i = 0; i < MAX_TRAFFIC; ++i) {
        if (!traffic[i].alive) {
            traffic[i].x = lane_x[random8() & 3];
            traffic[i].y = SPAWN_Y;
            traffic[i].alive = 1;
            return;
        }
    }
}

/* ── GAME LOGIC (clay) — stage the SPRITE HUD digits at HUD_Y ────────────────
 * 1P: crashes-left digit (left) + 5-digit distance (right) = 6 sprites on the
 * HUD scanline. 2P: one crashes-left digit per player = 2 sprites. Unused HUD
 * slots park off-screen. Sprites are SCREEN-space, so the HUD holds steady over
 * the scrolling road (see the SPRITE-HUD idiom on upload_sprite_digits). */
static void put_digit(u8 slot, u16 x, u8 d) {
    set_sprite(slot, x, (u16)HUD_Y, (u16)(SDIGIT_PAT + d), PAL_HUD);
}
static void hide_hud_slot(u8 slot) {
    set_sprite(slot, 0, OFFSCREEN_Y, SDIGIT_PAT, PAL_HUD);
}
static void stage_hud(void) {
    u8 i;
    if (state != ST_PLAY) { for (i = 0; i < 6; ++i) hide_hud_slot((u8)(SLOT_HUD + i)); return; }
    if (two_player) {
        put_digit((u8)(SLOT_HUD + 0), 24,  crashes_left[0]);    /* P1 left   */
        put_digit((u8)(SLOT_HUD + 1), 216, crashes_left[1]);    /* P2 right  */
        for (i = 2; i < 6; ++i) hide_hud_slot((u8)(SLOT_HUD + i));
        return;
    }
    put_digit((u8)(SLOT_HUD + 0), 16, crashes_left[0]);         /* crashes   */
    {                                                           /* distance  */
        u16 v = dist;
        u8 d[5];
        for (i = 0; i < 5; ++i) { d[i] = (u8)(v % 10); v /= 10; }
        for (i = 0; i < 5; ++i) put_digit((u8)(SLOT_HUD + 1 + i), (u16)(176 + i * 14), d[4 - i]);
    }
}

/* ── GAME LOGIC (clay) — flat band behind title/result text (BAT tiles) ──────
 * The title and result screens DON'T scroll (BYR held at 0, no streaming), so
 * their text safely lives in the BAT. A dark band sits behind the text rows. */
static void paint_band_rows(u8 r0, u8 r1) {
    u8 c, r;
    for (r = r0; r <= r1; ++r)
        for (c = 0; c < 32; ++c) put_tile(c, r, BAT_ENTRY(0, BAND_VRAM));
}

/* ── GAME LOGIC (clay) — screen painters (full BAT repaint per state change) ──
 * Title/result paint the road as a STATIC backdrop (so the scene reads as a
 * road, not a blank card) then lay text over a dark band. Only ST_PLAY scrolls. */
static void paint_title(void) {
    paint_road();
    paint_band_rows(6, 23);
    draw_text((u8)((32 - (sizeof(GAME_TITLE) - 1)) / 2), 8, GAME_TITLE);
    draw_text(10, 13, "1P RACE - I");
    draw_text(10, 15, "2P VERSUS - II");
    draw_text(11, 18, "BEST");
    draw_num5(16, 18, best);
    draw_text(4, 22, "STEER L R - GAS I - BRAKE II");
}

static void paint_play(void) {
    paint_road();                  /* fresh 32-row road; the sprite HUD floats  */
}

static void paint_over(void) {
    paint_road();
    paint_band_rows(7, 22);
    if (two_player) {
        draw_text(13, 8, winner ? "P2 WINS" : "P1 WINS");
        draw_text(10, 11, "RIVAL WRECKED");
    } else {
        draw_text(13, 8, "WRECKED");
        draw_text(11, 11, "DIST");
        draw_num5(16, 11, dist);
        draw_text(11, 13, "BEST");
        draw_num5(16, 13, best);
    }
    draw_text(9, 21, "RUN - TITLE");
}

/* ── GAME LOGIC (clay) — start a run ── */
static void start_game(u8 versus) {
    u8 i;
    two_player = versus;
    for (i = 0; i < MAX_TRAFFIC; ++i) traffic[i].alive = 0;
    for (i = 0; i < 2; ++i) {
        crashes_left[i] = START_LIVES;
        invuln[i] = 0;
        lane_cd[i] = 0;
        /* prev_pads = the CURRENTLY-held pad so a button held across the
         * title→play transition (the start press) isn't read as a fresh edge,
         * WITHOUT swallowing the player's first deliberate steer. (0xFF here
         * would mask the first press of every direction until released once.) */
        prev_pads[i] = 0;
    }
    prev_pads[0] = pce_joy_read();    /* swallow the held start button (pad 1) */
    if (versus) {
        car_active[0] = 1; car_active[1] = 1;
        lane_min[0] = 0; lane_max[0] = 1; car_lane[0] = 0;   /* P1: left half  */
        lane_min[1] = 2; lane_max[1] = 3; car_lane[1] = 3;   /* P2: right half */
        speed = SPEED_2P;             /* shared road, fixed speed (see design) */
    } else {
        car_active[0] = 1; car_active[1] = 0;
        lane_min[0] = 0; lane_max[0] = 3; car_lane[0] = 1;   /* whole road     */
        speed = 1;
    }
    dist = 0; dist_frac = 0;
    spawn_timer = 0;
    start_pause = 30;                 /* green-light breather                  */
    road_scroll = 0;
    prev_top_row = 0;
    state = ST_PLAY;
    paint_play();
    vdc_set_reg(VDC_BYR, 0);
    music_set(ST_PLAY);
    sfx(2, 0x180, 6);                 /* start blip                           */
}

static void game_over(void) {
    if (!two_player && dist > best) {
        best = dist;
        best_save(best);              /* in-session only (no save on a bare HuCard) */
    }
    state = ST_OVER;
    prev_pads[0] = pce_joy_read();    /* swallow only the held button, not the
                                       * player's next deliberate press         */
    road_scroll = 0;
    vdc_set_reg(VDC_BYR, 0);
    paint_over();
    music_set(ST_OVER);
    sfx(3, 0x500, 16);               /* wreck rumble                          */
}

/* ── GAME LOGIC (clay) — crash rules ── */
static void crash(u8 p) {
    sfx(3, 0x080, 16);               /* crash buzz                            */
    invuln[p] = 60;                  /* blink + no-collide grace              */
    if (!two_player) speed = 1;      /* a wreck kills your momentum           */
    if (crashes_left[p] > 0) --crashes_left[p];
    if (crashes_left[p] == 0) {
        winner = (u8)(1 - p);        /* versus: the OTHER player wins         */
        game_over();
    }
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

/* ── GAME LOGIC (clay) — per-player input ───────────────────────────────────
 * LEFT/RIGHT steer between lanes; UP/I accelerate, DOWN/II brake (1P only).
 *
 * Steering uses a short COOLDOWN (lane_cd) rather than pure rising-edge: a held
 * direction steps one lane, then can't step again until lane_cd reaches 0
 * (~9 frames). This still prevents machine-gun lane spam from a held d-pad, but
 * unlike strict `pad & ~prev` edge detection it does NOT depend on catching the
 * exact frame the button transitions — robust against input sampling latency
 * (a tap that spans only a couple of frames still lands). Speed changes stay
 * rising-edge (a held gas shouldn't ramp to max in 4 frames). */
static void update_player(u8 p, u8 pad) {
    u8 pressed = (u8)(pad & ~prev_pads[p]);
    prev_pads[p] = pad;
    if (!car_active[p]) return;
    if (lane_cd[p]) --lane_cd[p];
    if (!lane_cd[p]) {
        if ((pad & PCE_JOY_LEFT) && car_lane[p] > lane_min[p]) {
            --car_lane[p]; lane_cd[p] = 9; sfx(2, 0x2C0, 4);   /* lane tick */
        } else if ((pad & PCE_JOY_RIGHT) && car_lane[p] < lane_max[p]) {
            ++car_lane[p]; lane_cd[p] = 9; sfx(2, 0x2C0, 4);
        }
    }
    if (!two_player) {
        if ((pressed & (PCE_JOY_UP | PCE_JOY_I)) && speed < MAX_SPEED) {
            ++speed;
            sfx(1, (u16)(0x300 - speed * 0x60), 6);        /* engine rev    */
        }
        if ((pressed & (PCE_JOY_DOWN | PCE_JOY_II)) && speed > 1) {
            --speed;
            sfx(1, 0x3C0, 5);                              /* brake blip    */
        }
    }
    if (invuln[p] > 0) --invuln[p];
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * SPRITE STAGING + THE SATB DMA. The VDC never reads your RAM: sprites live in
 * its INTERNAL sprite attribute table, refreshed by a DMA you schedule by
 * writing R19 (satb_dma() does the copy + the R19 write; the transfer happens
 * at the next vblank). So the per-frame contract is:
 *   waitvsync() → restage EVERY slot → satb_dma()
 * Stage during vblank — satb_dma() also streams words through the VWR port, and
 * doing that mid-display tears sprite pattern fetches. Hidden slots park below
 * the display at OFFSCREEN_Y. ── */
static void stage_sprites(void) {
    u8 i, p;
    for (p = 0; p < 2; ++p) {
        u8 vis = (state == ST_PLAY) && car_active[p] && !(invuln[p] & 2);
        set_sprite((u8)(SLOT_P1 + p), lane_x[car_lane[p]],
                   vis ? (u16)CAR_Y : OFFSCREEN_Y, PLAYER_PAT, p ? PAL_P2 : PAL_P1);
    }
    for (i = 0; i < MAX_TRAFFIC; ++i) {
        u8 vis = (state == ST_PLAY) && traffic[i].alive;
        set_sprite((u8)(SLOT_TRAFFIC + i), traffic[i].x,
                   vis ? traffic[i].y : OFFSCREEN_Y, ENEMY_PAT, PAL_TRAFFIC);
    }
}

void main(void) {
    u8 pad1, pad2, newpad;

    _pce_keep[0] = 0;   /* see the EMPTY-BSS TRAP note in pce_hw.h */

    /* BRAM first — before any VDC work, so the save file exists within the
     * game's first frames (a headless host sees a non-empty save_ram region
     * as early as possible; see the BRAM idiom). */
    best_init();

    /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
     * Init order: palette → VRAM uploads → BAT paint → joypad → display ON.
     * disp_enable() also sets the VBlank IRQ bit — without it waitvsync()
     * never returns and the game freezes on its first frame. */
    /* BG sub-pal 0: road scene. BG sub-pal 1: HUD/text white. */
    vce_set_color(0,   PCE_RGB(0, 1, 0));   /* backdrop: dark green           */
    vce_set_color(1,   PCE_RGB(1, 5, 1));   /* BG c1: roadside grass green     */
    vce_set_color(2,   PCE_RGB(2, 2, 2));   /* BG c2: asphalt grey             */
    vce_set_color(3,   PCE_RGB(7, 7, 1));   /* BG c3: yellow markings/specks   */
    vce_set_color(17,  PCE_RGB(7, 7, 7));   /* pal1 text: white                */
    /* sprite sub-palettes (256 + pal*16 + index) — P1 cyan, P2 amber, traffic
     * red, each on its own sub-palette so the cars read as three liveries. */
    vce_set_color(256 + 0 * 16 + 1, PCE_RGB(2, 6, 7));  /* spr pal0 c1: P1 cyan    */
    vce_set_color(256 + 1 * 16 + 1, PCE_RGB(7, 5, 0));  /* spr pal1 c1: P2 amber   */
    vce_set_color(256 + 2 * 16 + 1, PCE_RGB(7, 1, 1));  /* spr pal2 c1: traffic red*/

    upload_art();

    state = ST_TITLE;
    paint_title();
    music_set(ST_TITLE);

    pce_joy_init();
    disp_enable();

    for (;;) {
        waitvsync();

        /* ── vblank work first: cars + sprite HUD + SATB DMA ── */
        stage_sprites();
        stage_hud();
        satb_dma();

        music_tick();
        if (sfx_timer) {
            --sfx_timer;
            if (sfx_timer == 0) { psg_off(0); psg_off(1); psg_off(2); psg_off(3); }
        }

        /* ── input: pad 1 always; pad 2 only in 2P play (TurboTap port 1). ── */
        pad1 = pce_joy_read();
        pad2 = (state == ST_PLAY && two_player) ? read_pad2() : 0;

        if (state == ST_TITLE) {
            /* The title road is a STATIC backdrop: with no hardware window and
             * no raster split, BYR would scroll the BG title text off-screen
             * (and the row-streamer would wipe it). So the title doesn't scroll
             * — the play state is where the road comes alive. */
            newpad = (u8)(pad1 & ~prev_pads[0]);
            prev_pads[0] = pad1;
            if (newpad & (PCE_JOY_RUN | PCE_JOY_I)) start_game(0);
            else if (newpad & PCE_JOY_II) start_game(1);
            continue;
        }
        if (state == ST_OVER) {
            newpad = (u8)(pad1 & ~prev_pads[0]);
            prev_pads[0] = pad1;
            if (newpad & (PCE_JOY_RUN | PCE_JOY_I)) {
                state = ST_TITLE;
                road_scroll = 0;
                vdc_set_reg(VDC_BYR, 0);
                paint_title();
                music_set(ST_TITLE);
            }
            continue;
        }

        /* ── ST_PLAY ──────────────────────────────────────────────────────── */
        if (start_pause) { --start_pause; continue; }   /* green-light freeze  */

        advance_road(speed);

        update_player(0, pad1);
        if (two_player) update_player(1, pad2);
        if (state != ST_PLAY) continue;     /* a crash may have ended the game */

        /* Distance (1P stat): 1 unit per 16 scrolled pixels. A chime every 256
         * units marks a checkpoint. */
        if (!two_player) {
            dist_frac = (u8)(dist_frac + speed);
            if (dist_frac >= 16) {
                dist_frac = (u8)(dist_frac - 16);
                if (dist < 65535u) ++dist;
                if (dist != 0 && (dist & 0xFF) == 0)
                    sfx(0, 0x0D6, 8);       /* checkpoint chime (C6)           */
            }
        }

        /* Traffic flows down at road speed (it reads as slower cars you're
         * overtaking); despawn past the player with a little pass tick. */
        {
            u8 i, p;
            for (i = 0; i < MAX_TRAFFIC; ++i) {
                if (!traffic[i].alive) continue;
                traffic[i].y = (u16)(traffic[i].y + speed);
                if (traffic[i].y > DESPAWN_Y) {
                    traffic[i].alive = 0;
                    sfx(1, 0x0C0, 2);
                }
            }
            if (++spawn_timer >= SPAWN_PERIOD) { spawn_timer = 0; spawn_traffic(); }

            /* Traffic ↔ cars. Crash grace: a just-wrecked car blinks and can't
             * collide for 60 frames. */
            for (i = 0; i < MAX_TRAFFIC && state == ST_PLAY; ++i) {
                if (!traffic[i].alive) continue;
                for (p = 0; p < 2; ++p) {
                    if (!car_active[p] || invuln[p]) continue;
                    if (hits(traffic[i].x, traffic[i].y, lane_x[car_lane[p]], CAR_Y)) {
                        traffic[i].alive = 0;
                        crash(p);
                        break;
                    }
                }
            }
        }
    }
}
