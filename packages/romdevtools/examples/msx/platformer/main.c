/* ── platformer/main.c — MSX side-scrolling platformer (complete example game) ─
 *
 * MESA HOPPER — a COMPLETE, working game: title screen, 1P mode and 2P
 * ALTERNATING-TURNS mode (arcade-classic: players swap on death; each player
 * has its OWN score and OWN 3 lives; player 2 plays on JOYSTICK PORT 2),
 * coins + traversal scoring, session hi-score, music + SFX on the AY-3-8910
 * PSG, gravity/jump/one-way-platform physics — and the MSX's signature
 * SCREEN-2 PER-ROW COLOR: the level's depth bands (far sky, mid air, near
 * ground) and the title recolor come ENTIRELY from the three independent
 * color thirds + a one-tile vertical gradient, costing zero extra tiles.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented MSX footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — level layout, physics tuning, scoring, art: reshape
 *     freely.
 *
 * What depends on what:
 *   msx_hw.h / msx_vdp.c — VDP + PSG + joystick helpers (direct Z80 ports;
 *     the PSG functions carry a DI/EI guard against the BIOS KEYINT race —
 *     read msx_vdp.c before adding your own PSG pokes).
 *   msx_crt0.s — the $4000 "AB" cart header + static-init copy. Load-bearing;
 *     INIT must NEVER return, so main() ends in for(;;).
 *
 * The level: a FIXED 32-cell-wide screen-2 arena (NOT a scroller — see the
 * "no hardware scroll" idiom below). The column map gives every screen column
 * a ground height + an optional one-way platform; pits (gaps in the ground)
 * are instant death, spikes patrol the ground, a coin floats over a platform.
 * The player walks the full width of the screen, hops platforms, and banks
 * coins + a traversal "distance" tick. A run ends when all of the current
 * player's lives are gone.
 *
 * Controls: JOYSTICK PORT 1 (or keyboard cursors) LEFT/RIGHT walks, trigger A
 *   jumps (only when grounded). In 2P alternating-turns mode, player 2 plays
 *   on JOYSTICK PORT 2 when it is their turn. On the title screen trigger A
 *   starts 1P; trigger B (port-1 button 2) starts 2P turns.
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
#define GAME_TITLE "MESA HOPPER"

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

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * NO HARDWARE SCROLL ON SCREEN 2. The TMS9918 GRAPHIC-II mode has no smooth
 * pixel-scroll register at all (the V9938's R23 is a whole-screen vertical
 * line shift, not a per-layer camera, and MSX1 lacks even that). The ONLY way
 * to "scroll" is to rewrite the name table column-by-column every 8-px step —
 * a heavy per-frame VRAM burst that ALSO fights the per-row color idiom below
 * (each scrolled column needs its color third re-evaluated).
 *
 * So this platformer uses a FIXED single-screen arena: the camera never moves,
 * the whole level is one 32-cell painting, and the player traverses it left to
 * right. That keeps the screen-2 per-row color signature CHEAP (the color
 * tables upload ONCE) and the frame budget roomy. If you want a true scroller,
 * budget a column-streaming routine and re-upload the affected third's color
 * slice as columns enter — see TROUBLESHOOTING; it is the single biggest MSX
 * platformer footgun. */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile font: index 0 = space, 1-26 = A-Z, 27-36 = 0-9, 37 = dash, then the
 * level tiles. One 8x8 pattern = 8 bytes, one bit per pixel; set bits draw in
 * the tile's FOREGROUND color, clear bits in its BACKGROUND color (both come
 * from the screen-2 color table — see the per-row-color idiom below). */
#define T_SPACE   0
#define T_A       1          /* 'A'..'Z' = T_A + (c - 'A')                  */
#define T_0       27         /* '0'..'9' = T_0 + (c - '0')                  */
#define T_DASH    37
#define T_SKY     38         /* empty air cell (pattern all 0 = all bg)     */
#define T_CLOUD   39         /* faint cloud puff in the sky band            */
#define T_GRASS   40         /* platform / ground surface (grassy top)      */
#define T_DIRT    41         /* ground body below the surface               */
#define T_HORIZON 42         /* the per-8x1-row gradient strip (see below)  */
#define NUM_TILES 43

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
    /* 38 SKY    (all bg)      */ {0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00},
    /* 39 CLOUD  (soft puff)   */ {0x00,0x00,0x18,0x3C,0x7E,0x00,0x00,0x00},
    /* 40 GRASS  (grassy top)  */ {0xFF,0xFF,0x00,0x00,0x00,0x00,0x00,0x00},
    /* 41 DIRT   (solid body)  */ {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF},
    /* 42 HORIZON(solid fg — its COLOR bytes paint the gradient) */
               {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF},
};

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * SCREEN-2 PER-ROW COLOR — the MSX's signature background trick.
 *
 * Screen 2 (GRAPHIC II) is NOT "one color byte per tile" like most consoles:
 *
 *   1. The 256x192 screen is THREE INDEPENDENT THIRDS of 8 rows each
 *      (name-table rows 0-7, 8-15, 16-23). Each third has its OWN 2KB
 *      pattern table slice and its OWN 2KB color table slice:
 *        patterns: VRAM_PATTERN + third*0x800,  colors: VRAM_COLOR + third*0x800
 *      The SAME tile index can look completely different in each third —
 *      we exploit exactly that for the depth-banded level below.
 *
 *   2. Within a tile, the color table holds EIGHT bytes — one per 8x1 pixel
 *      row — each packing (foreground<<4)|background from the fixed TMS9918
 *      palette. So one tile can carry an 8-color vertical gradient
 *      (T_HORIZON's whole "glow horizon" line is a single tile, colors only).
 *
 * Requires: the screen-2 table layout set by msx_set_screen2() (R3=0xFF,
 *   R4=0x03 — the "thirds" configuration), and pattern + color uploads to
 *   EVERY third a tile is used in. Tile N's slot is pattern[N*8] / color[N*8].
 *
 * Depth scheme taught here (TMS9918 fixed palette: 1 black, 4 dark blue,
 * 5 light blue, 6 dark red, 8 cyan/medium-red, 12 dark green, 14 gray,
 * 15 white — the high nibble is fg, low nibble is bg of each row byte):
 *   third 0 (top)    = far sky:  light-blue field, white clouds — the HUD
 *                       text band (row 0) also lives here in its own colors.
 *   third 1 (middle) = mid air:  black field, gray clouds — the play space.
 *   third 2 (bottom) = near ground: green grass on brown dirt, the platforms
 *                       and the one-tile horizon gradient seam.
 * The HUD text band (row 0, third 0) gets white-on-blue, distinct from the
 * sky below it, WITHOUT costing any extra tiles. */
static const uint8_t col_text[3]  = { 0xF4, 0xF1, 0xF1 }; /* HUD/title white-on-blue; mid+near white-on-black */
static const uint8_t col_sky[3]   = { 0x55, 0x11, 0x18 }; /* the 3 depth bands (bg shows: pattern is all 0)   */
static const uint8_t col_cloud[3] = { 0xF5, 0xE1, 0x55 }; /* cloud puff per band: white/gray over its band bg */
static const uint8_t col_grass[3] = { 0xC5, 0xC1, 0xC6 }; /* grassy top: dark-green fg over band bg / over brown */
static const uint8_t col_dirt[3]  = { 0x66, 0x66, 0x66 }; /* solid dirt body: dark-red/brown everywhere        */
/* T_HORIZON: 8 DIFFERENT color bytes inside ONE tile = an 8-pixel-row glow
 * gradient (dark blue → light blue → cyan → white and back down). The pattern
 * is solid 0xFF so only the fg nibbles show. Drawn as the seam row between the
 * air thirds and the ground. */
static const uint8_t col_horizon[8] = { 0x44,0x55,0x88,0xF8,0x85,0x54,0x41,0x11 };

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
            if (i == T_HORIZON) {          /* the one per-pixel-row gradient */
                msx_vram_write((uint16_t)(colbase + ((uint16_t)i << 3)), col_horizon, 8);
                continue;
            }
            if      (i == T_SKY)   col = col_sky[third];
            else if (i == T_CLOUD) col = col_cloud[third];
            else if (i == T_GRASS) col = col_grass[third];
            else if (i == T_DIRT)  col = col_dirt[third];
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

/* ── GAME LOGIC (clay — reshape freely) — the level (a fixed 32-cell map) ───
 * One entry per screen column:
 *   ground_row[c] — name-table row of the ground's grassy top; NO_GROUND = a
 *                   bottomless pit (fall in = lose the turn).
 *   plat_row[c]   — row of a one-way floating platform, 0 = none.
 * Name-table rows: 0 = HUD band, 1..GROUND_ROW-1 = air, then ground.
 * The level is one fixed screen — reshape these two tables freely. */
#define NO_GROUND   0xFF
#define HORIZON_ROW 17                /* the one-tile gradient seam row       */
#define GROUND_ROW  20                /* default grassy ground top            */
static const uint8_t ground_row[32] = {
    20, 20, 20, 20, 20, 20,                       /* start ledge              */
    NO_GROUND, NO_GROUND, NO_GROUND,              /* pit 1 (24 px)            */
    20, 20, 20, 20, 20,                           /* mid ledge                */
    NO_GROUND, NO_GROUND,                         /* pit 2 (16 px)            */
    20, 20, 20, 20, 20, 20,                       /* long ledge               */
    NO_GROUND, NO_GROUND, NO_GROUND,              /* pit 3 (24 px)            */
    20, 20, 20, 20, 20, 20,                       /* finish ledge             */
};
static const uint8_t plat_row[32] = {
    0, 0, 0, 0, 0, 0,
    0, 14, 14,                                    /* slab spanning pit 1      */
    0, 0, 0, 0, 0,
    13, 13,                                       /* slab over pit 2          */
    0, 0, 0, 0, 0, 0,
    0, 14, 14,                                    /* slab over pit 3          */
    0, 0, 0, 0, 0, 0,
};

/* ── GAME LOGIC (clay — reshape freely) — sprites ────────────────────────────
 * 8x8 one-color hardware sprites. Plane layout (lower plane = on top):
 *   0 player, 1 coin, 2-3 spikes. */
static const uint8_t spr_player_idle[8] = {0x18,0x3C,0x7E,0x7E,0xFF,0xFF,0x66,0x66};
static const uint8_t spr_player_jump[8] = {0x18,0x7E,0xFF,0xE7,0xC3,0x81,0x42,0x24};
static const uint8_t spr_coin[8]        = {0x3C,0x7E,0xDB,0xFF,0xFF,0xDB,0x7E,0x3C};
static const uint8_t spr_spike[8]       = {0x10,0x10,0x38,0x38,0x7C,0x7C,0xFE,0xFE};
#define PAT_IDLE    0
#define PAT_JUMP    1
#define PAT_COIN    2
#define PAT_SPIKE   3
#define COL_PLAYER1 15  /* white       */
#define COL_PLAYER2 10  /* dark yellow */
#define COL_COIN    10  /* dark yellow (gold-ish) */
#define COL_SPIKE   9   /* light red   */

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Sprite limits + the Y=208 terminator:
 *   - A sprite Y of 0xD0 (208) tells the TMS9918 to STOP SCANNING the
 *     attribute table — every higher-numbered plane vanishes, not just that
 *     one. (msx_clear_sprites parks ALL planes at 0xD0, which is fine at the
 *     END of the list.) To hide ONE sprite mid-list, park it OFFSCREEN at
 *     PARK_Y (192 = first line below the display) — never at 0xD0.
 *     (On MSX2's V9938 sprite mode 2 the terminator moves to 0xD8 and 0xD0
 *     is "just offscreen" — code that leans on that breaks on MSX1.)
 *   - Per scanline the TMS9918 draws only 4 sprites (V9938: 8); the rest drop
 *     out for that line. This game peaks at 4 planes (player + coin + 2
 *     spikes) so a row pileup is rare. */
#define PARK_Y 192

#define NUM_SPIKES 2

/* ── GAME LOGIC (clay — reshape freely) — physics + tuning ──────────────────
 * Player position is screen-pixel X; Y is Q4.4 fixed point so gravity can add
 * <1 px/frame near the jump apex. */
#define GRAVITY_Q44     6   /* +6/16 px per frame per frame                  */
#define JUMP_VEL_Q44 (-56)  /* launch vy (Q4.4) → ~4-tile apex              */
#define MAX_VY_Q44     64   /* terminal velocity, 4 px/frame — MUST stay    *
                             * under 6: the landing probe's window can't    *
                             * catch a faster fall (tunnelling)             */
#define MOVE_SPEED      2   /* px/frame walk                                */
#define GROUND_TOP    (GROUND_ROW * 8)   /* 160: grassy top pixel row       */
#define PLAYER_LEFT     8   /* walk bounds                                  */
#define PLAYER_RIGHT  240

/* ── GAME LOGIC (clay — reshape freely) — game state ─────────────────────── */
static uint8_t  px;                 /* player screen x (pixels)             */
static uint16_t py_q44;             /* player y, Q4.4 fixed point           */
static int8_t   vy_q44;
static uint8_t  on_ground;
static uint8_t  coin_x, coin_y, coin_live;
static uint8_t  spike_x[NUM_SPIKES];
static int8_t   spike_vx[NUM_SPIKES];

/* Players: index 0 = P1 (joystick port 1), 1 = P2 (joystick port 2 —
 * alternating turns, arcade-classic style). Each has its own score + own
 * lives; the HUD shows the CURRENT player's numbers. */
static uint8_t  two_player;      /* mode chosen on the title screen          */
static uint8_t  cur_player;
static uint8_t  p_lives[2];
static uint16_t p_score[2];
static uint16_t hiscore;         /* SESSION-ONLY: plain RAM. The bundled
                                  * bluemsx build exposes no SAVE_RAM region,
                                  * so there is nothing battery-backed to
                                  * write — survives title↔game cycles, not a
                                  * power cycle (honest, not faked). */
static uint8_t  turn_pause;      /* freeze frames after a turn change        */
static uint8_t  dist_sub;        /* sub-counter: traversal pays a point      */
static uint16_t rng;

#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;
static uint8_t prev_t1, prev_t2;  /* trigger edge detection across states   */
static uint8_t prev_jump;         /* per-turn jump edge (cur_player's port)  */

/* xorshift16 PRNG — a few dozen cycles, no tables. */
static uint8_t next_rand(void) {
    rng ^= (uint16_t)(rng << 7);
    rng ^= (uint16_t)(rng >> 9);
    rng ^= (uint16_t)(rng << 8);
    return (uint8_t)(rng & 0xFF);
}

/* ── GAME LOGIC (clay — reshape freely) — music + SFX on the AY-3-8910 ──────
 * Channel plan: A = jump/coin/land blips, B = death noise, C = music. The PSG
 * has 3 tone channels + ONE shared noise generator, mixed per-channel in
 * reg 7. All register traffic goes through msx_psg_tone/noise/off — they wrap
 * the PSGADDR/PSGWRITE pair in DI/EI because the BIOS KEYINT ISR clobbers the
 * PSG address latch every frame (the bug that once silenced every MSX scaffold
 * — see msx_vdp.c).
 *
 * The tune: one period entry per half-beat, 0 = rest. AY period =
 * 1789773 / (16 * freq) — e.g. A4 (440Hz) -> 254. Ticked once per frame; a
 * note advances every 8 frames. The lib's built-in demo loop (msx_music_tick)
 * also uses channel C, so we switch it OFF in main() and run THIS table
 * instead — edit this table to rescore. */
static const uint16_t tune[32] = {
    427, 0, 339, 0, 285, 0, 339, 0,   /* C4 E4 G4 E4  (bright major bounce)   */
    254, 0, 285, 339, 285, 0,   0, 0, /* A4 G4 E4 G4 rest                     */
    320, 0, 285, 0, 254, 0, 285, 0,   /* F4 G4 A4 G4                          */
    339, 0, 285, 0, 427, 0,   0, 0,   /* E4 G4 C4 rest                        */
};
static uint8_t music_step, music_timer;
static uint8_t sfx_a_t, sfx_b_t;     /* frames left on the A/B SFX channels  */

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

static void sfx_jump(void) { msx_psg_tone(0, 0x110, 11); sfx_a_t = 4; }
static void sfx_coin(void) { msx_psg_tone(0, 0x090, 12); sfx_a_t = 6; }
static void sfx_land(void) { msx_psg_tone(0, 0x250, 8);  sfx_a_t = 3; }
static void sfx_die(void)  { msx_psg_noise(1, 24, 14);   sfx_b_t = 18; }

/* ── GAME LOGIC (clay — reshape freely) — HUD ──────────────────────────────
 * Row 0 = the HUD band (third 0's text colors make it a distinct strip).
 * P#=current player, SC=score, HI=hi-score, LV=lives. */
static void draw_hud_labels(void) {
    draw_text(1, 0, "P");
    draw_text(5, 0, "SC");
    draw_text(15, 0, "HI");
    draw_text(25, 0, "LV");
}
static void draw_player(void) { put_tile(2, 0, (uint8_t)(T_0 + 1 + cur_player)); }
static void draw_score(void)  { draw_num4(8, 0, p_score[cur_player]); }
static void draw_hi(void)     { draw_num4(18, 0, hiscore); }
static void draw_lives(void)  { put_tile(28, 0, (uint8_t)(T_0 + p_lives[cur_player])); }
static void draw_hud(void) { draw_player(); draw_score(); draw_hi(); draw_lives(); }

/* ── GAME LOGIC (clay — reshape freely) — paint the fixed level ─────────────
 * The whole arena is one 32x24 painting. Row 0 is the HUD band; the sky thirds
 * get scattered clouds; HORIZON_ROW is the one-tile gradient seam; the
 * ground/platforms come from the column map. The per-third color tables (set
 * once in load_tiles) give the depth bands for free. */
static void paint_field(void) {
    uint8_t row, col, t;
    uint8_t buf[32];
    msx_fill_vram(VRAM_NAME, 32, T_SPACE);              /* row 0: HUD band   */
    for (row = 1; row < 24; row++) {
        for (col = 0; col < 32; col++) {
            uint8_t g = ground_row[col];
            t = T_SKY;
            if (row == HORIZON_ROW)              t = T_HORIZON;
            else if (row == plat_row[col])       t = T_GRASS;   /* slab      */
            else if (g != NO_GROUND) {
                if      (row == g)               t = T_GRASS;   /* surface   */
                else if (row > g)                t = T_DIRT;    /* body      */
            }
            if (t == T_SKY && row < HORIZON_ROW) {              /* clouds    */
                if (((row * 7 + col * 5) & 15) == 0) t = T_CLOUD;
            }
            buf[col] = t;
        }
        msx_vram_write((uint16_t)(VRAM_NAME + (uint16_t)row * 32), buf, 32);
    }
}

/* ── GAME LOGIC (clay — reshape freely) — screens ──────────────────────────
 * Title rows land in third 1 (white-on-black) and third 2 — the same glyph
 * tiles as the HUD, recolored for free by the thirds idiom. */
static void paint_title(void) {
    uint8_t len = 0, col;
    const char *p = GAME_TITLE;
    while (*p++) len++;
    col = (uint8_t)((32 - len) / 2);
    paint_field();
    draw_text(col, 6, GAME_TITLE);
    draw_text(7, 10, "1P START - FIRE A");
    draw_text(7, 12, "2P TURNS - FIRE B");
    draw_text(12, 14, "HI 0000");      /* the space blanks the cell between */
    draw_num4(15, 14, hiscore);
}

/* ── GAME LOGIC (clay — reshape freely) — start a turn / a run ── */
static void begin_turn(void) {
    uint8_t i;
    px = 24;
    py_q44 = (uint16_t)((uint16_t)(GROUND_TOP - 8) << 4);
    vy_q44 = 0;
    on_ground = 1;
    coin_x = 120; coin_y = (uint8_t)(13 * 8); coin_live = 1;
    for (i = 0; i < NUM_SPIKES; i++) {
        spike_x[i] = (uint8_t)(64 + i * 96);
        spike_vx[i] = (i & 1) ? -1 : 1;
    }
    turn_pause = 24;            /* "P# ready" breather (blinks ~0.6-0.8s)    */
    prev_jump = 1;             /* swallow a held jump across the turn        */
    paint_field();
    draw_hud_labels();
    draw_hud();
}

static void start_game(uint8_t players) {
    two_player = players;
    cur_player = 0;
    p_score[0] = p_score[1] = 0;
    p_lives[0] = 3;
    p_lives[1] = players ? 3 : 0;
    dist_sub = 0;
    begin_turn();
    sfx_coin();                /* start chirp                               */
    state = ST_PLAY;
}

static void game_over(void) {
    uint16_t best = p_score[0];
    if (two_player && p_score[1] > best) best = p_score[1];
    if (best > hiscore) { hiscore = best; }
    draw_text(11, 9, "GAME OVER");
    draw_text(9, 11, "P1");   draw_num4(13, 11, p_score[0]);
    if (two_player) { draw_text(9, 13, "P2"); draw_num4(13, 13, p_score[1]); }
    draw_text(8, 15, "FIRE FOR TITLE");
    prev_t1 = prev_t2 = 1;     /* swallow a fire still held from play        */
    state = ST_OVER;
}

/* ── GAME LOGIC (clay — reshape freely) — death + alternating-turn handoff ── */
static void kill_player(void) {
    uint8_t other;
    sfx_die();
    if (p_lives[cur_player] > 0) --p_lives[cur_player];
    if (two_player) {
        other = (uint8_t)(cur_player ^ 1);
        if (p_lives[other] > 0)            cur_player = other;   /* swap turn */
        else if (p_lives[cur_player] == 0) { game_over(); return; }
    } else if (p_lives[0] == 0) {
        game_over();
        return;
    }
    begin_turn();
}

/* ── GAME LOGIC (clay — reshape freely) — landing probe against the map ─────
 * One-way platforms: only catch the player's feet while FALLING through a
 * narrow window at a surface top. Window is top-1..top+4 (the -1 slack keeps
 * on_ground stable while the sub-pixel gravity trickle hasn't moved integer Y
 * yet; the +4 stops a 4 px/frame fall stepping over a 1-row surface). */
static uint8_t land_top(uint8_t c, uint8_t feet) {
    uint8_t r, top;
    r = plat_row[c];
    if (r) {
        top = (uint8_t)(r << 3);
        if ((uint8_t)(feet + 1) >= top && feet <= (uint8_t)(top + 4)) return top;
    }
    r = ground_row[c];
    if (r != NO_GROUND) {
        top = (uint8_t)(r << 3);
        if ((uint8_t)(feet + 1) >= top && feet <= (uint8_t)(top + 4)) return top;
    }
    return 0;
}

/* ── GAME LOGIC (clay — reshape freely) — AABB ── */
static uint8_t aabb(uint8_t ax, uint8_t ay, uint8_t bx, uint8_t by) {
    return ax < (uint8_t)(bx + 8) && (uint8_t)(ax + 8) > bx
        && ay < (uint8_t)(by + 8) && (uint8_t)(ay + 8) > by;
}

/* Push every object to its sprite plane. A dead object parks at PARK_Y
 * (offscreen), NEVER 0xD0 — see the sprite idiom block above. */
static void push_sprites(uint8_t player_y) {
    uint8_t i;
    msx_set_sprite(0, px, player_y, on_ground ? PAT_IDLE : PAT_JUMP,
                   cur_player ? COL_PLAYER2 : COL_PLAYER1);
    msx_set_sprite(1, coin_x, coin_live ? coin_y : PARK_Y, PAT_COIN, COL_COIN);
    for (i = 0; i < NUM_SPIKES; i++)
        msx_set_sprite((uint8_t)(2 + i), spike_x[i],
                       (uint8_t)(GROUND_TOP - 8), PAT_SPIKE, COL_SPIKE);
}

void main(void) {
    uint8_t dir, jump, y8, feet, c0, c1, top, i;

    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * Init order: set the video mode FIRST (INIGRP also clears VRAM — any
     * upload done before it is wiped), then tiles, then sprites. The crt0's
     * INIT contract means main() must NEVER return — the BIOS has nothing
     * sane to fall back to — hence the for(;;) below. */
    msx_set_screen2();
    msx_clear_sprites();
    load_tiles();
    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_IDLE  * 8), spr_player_idle, 8);
    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_JUMP  * 8), spr_player_jump, 8);
    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_COIN  * 8), spr_coin,        8);
    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_SPIKE * 8), spr_spike,       8);

    msx_music(0);            /* the lib's demo loop also owns channel C —
                             * hand the channel to OUR tune table instead    */
    hiscore = 0;             /* session hi-score (no SAVE_RAM on this core)  */
    rng = 0xACE1;
    (void)next_rand;         /* PRNG kept for forks that add random spawns   */
    music_step = music_timer = 0;
    sfx_a_t = sfx_b_t = 0;
    prev_t1 = prev_t2 = 1;   /* swallow a held trigger across state changes  */
    state = ST_TITLE;
    paint_title();

    for (;;) {
        vsync();
        music_tick();
        sfx_tick();

        if (state == ST_TITLE) {
            /* ── GAME LOGIC (clay) — title: trig A = 1P; trig B (port-1
             * button 2, gttrig 3) = 2P alternating turns. */
            uint8_t t1 = (uint8_t)(gttrig(1) || gttrig(0));
            uint8_t t2 = gttrig(3);
            if (t2 && !prev_t2)      start_game(1);
            else if (t1 && !prev_t1) start_game(0);
            prev_t1 = t1; prev_t2 = t2;
            continue;
        }

        if (state == ST_OVER) {
            /* Freeze the final frame; any fire button returns to the title. */
            uint8_t t1 = (uint8_t)(gttrig(1) || gttrig(0) || gttrig(2));
            if (t1 && !prev_t1) {
                state = ST_TITLE;
                msx_clear_sprites();
                paint_title();
            }
            prev_t1 = t1; prev_t2 = t1;
            continue;
        }

        /* ── ST_PLAY — GAME LOGIC (clay) from here down ─────────────────── */
        y8 = (uint8_t)(py_q44 >> 4);

        if (turn_pause) {            /* "P# ready" breather: blink + freeze   */
            push_sprites((turn_pause & 4) ? y8 : PARK_Y);
            turn_pause--;
            continue;
        }

        /* Input — the CURRENT player's joystick (P1 port 1 + keyboard;
         * P2 port 2). GTSTCK returns 0=center then 1-8 clockwise from up. */
        if (cur_player == 0) {
            dir = msx_read_joystick(1);
            if (dir == STICK_CENTER) dir = msx_read_joystick(0);
            jump = (uint8_t)(gttrig(1) || gttrig(0));
        } else {
            dir = msx_read_joystick(2);
            jump = gttrig(2);
        }

        if ((dir == STICK_LEFT || dir == STICK_UL || dir == STICK_DL)
            && px > PLAYER_LEFT)  px = (uint8_t)(px - MOVE_SPEED);
        if ((dir == STICK_RIGHT || dir == STICK_UR || dir == STICK_DR)
            && px < PLAYER_RIGHT) px = (uint8_t)(px + MOVE_SPEED);
        if (jump && !prev_jump && on_ground) {
            vy_q44 = JUMP_VEL_Q44;
            on_ground = 0;
            sfx_jump();
        }
        prev_jump = jump;

        /* Traversal pays a point every few right-steps (cheap distance). */
        if (dir == STICK_RIGHT || dir == STICK_UR || dir == STICK_DR) {
            if (++dist_sub >= 24) {
                dist_sub = 0;
                if (p_score[cur_player] < 9999) p_score[cur_player]++;
                draw_score();
            }
        }

        /* Physics: gravity + sub-pixel Y. */
        if (vy_q44 < MAX_VY_Q44) vy_q44 = (int8_t)(vy_q44 + GRAVITY_Q44);
        py_q44 = (uint16_t)(py_q44 + (uint16_t)(int16_t)vy_q44);
        y8 = (uint8_t)(py_q44 >> 4);

        /* Fell into a pit (below the floor line) → lose the turn. */
        if (y8 >= GROUND_TOP + 16) {
            kill_player();
            continue;
        }

        /* Landing — probe the two columns under the player's feet. */
        if (vy_q44 >= 0) {
            feet = (uint8_t)(y8 + 8);
            c0 = (uint8_t)(px >> 3);
            c1 = (uint8_t)((px + 7) >> 3);
            top = land_top(c0, feet);
            if (top == 0) top = land_top(c1, feet);
            if (top) {
                py_q44 = (uint16_t)((uint16_t)(top - 8) << 4);
                vy_q44 = 0;
                if (!on_ground) sfx_land();
                on_ground = 1;
            } else {
                on_ground = 0;                       /* walked off an edge   */
            }
        }

        /* Coin (collect). */
        if (coin_live && aabb(px, y8, coin_x, coin_y)) {
            coin_live = 0;
            p_score[cur_player] += 10;
            sfx_coin();
            draw_score();
        }

        /* Spikes patrol the ground and kill on touch. */
        for (i = 0; i < NUM_SPIKES; i++) {
            spike_x[i] = (uint8_t)(spike_x[i] + spike_vx[i]);
            if (spike_x[i] <= PLAYER_LEFT)  spike_vx[i] = 1;
            if (spike_x[i] >= PLAYER_RIGHT) spike_vx[i] = -1;
            if (aabb(px, y8, spike_x[i], (uint8_t)(GROUND_TOP - 8))) {
                kill_player();
                break;
            }
        }
        if (state != ST_PLAY) continue;   /* kill_player may have ended it   */

        push_sprites(y8);
    }
}
