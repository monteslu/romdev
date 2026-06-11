/* ── racing/main.c — MSX top-down road racer (complete example game) ─────────
 *
 * TURBO TANGLE — a COMPLETE, working game: title screen, 1P endless race with
 * speed control + a best-distance record, 2P SIMULTANEOUS VERSUS (P2 on
 * JOYSTICK PORT 2) on one shared road, crash/lives rules into a result screen,
 * music + SFX on the AY-3-8910 PSG, and the MSX's signature SCREEN-2 PER-ROW
 * COLOR: the asphalt, the grass shoulders, the centre divider and the HUD band
 * are all ONE tile set differentiated purely by which screen-2 color third they
 * sit in — plus a one-tile vertical "shimmer" gradient down the divider — at
 * zero extra tiles.
 *
 * The game (top-down vertical racer): a four-lane road scrolls toward you; you
 * steer LEFT/RIGHT between lanes to weave through slower traffic. In 1P,
 * UP/A accelerates and DOWN/B brakes (speed 1-4) and the run banks DISTANCE;
 * 3 crashes end it. In 2P, both cars share one road at a fixed speed — P1 owns
 * the left two lanes, P2 (port 2) the right two — and the first driver to burn
 * all 3 crashes LOSES.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented MSX footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — traffic patterns, speeds, scoring, art: reshape freely.
 *
 * What depends on what:
 *   msx_hw.h / msx_vdp.c — VDP + PSG + joystick helpers (direct Z80 ports;
 *     the PSG functions carry a DI/EI guard against the BIOS KEYINT race —
 *     read msx_vdp.c before adding your own PSG pokes).
 *   msx_crt0.s — the $4000 "AB" cart header + static-init copy. Load-bearing;
 *     INIT must NEVER return, so main() ends in for(;;).
 *
 * A TEACHING POINT vs the NES version of this game
 * (examples/nes/templates/racing.c): the NES scrolls the road as the
 * BACKGROUND — it decrements the PPU's hardware scroll_y every frame and the
 * whole nametable slides for free. The MSX SCREEN 2 has NO HARDWARE SCROLL at
 * all (see the idiom below), so TURBO TANGLE fakes the motion by REDRAWING the
 * road's dashes + shoulder texture one phase further down the name table each
 * frame: a moving-stripe pattern, recomputed from a single scrolling offset.
 * Same genre, the opposite hardware reality — and the honest way to teach it.
 *
 * Controls: JOYSTICK PORT 1 (or keyboard cursors) LEFT/RIGHT steers; UP/trigger
 *   A accelerates, DOWN/trigger B brakes (1P only). In 2P versus, JOYSTICK
 *   PORT 2 LEFT/RIGHT steers player 2. On the title screen trigger A starts the
 *   1P race; trigger B starts 2P versus. On the result screen any fire returns
 *   to the title.
 *
 * Record honesty: the bundled bluemsx core build exposes NO battery save path
 *   (retro_get_memory(SAVE_RAM) is unimplemented for MSX carts), so BEST (the
 *   best 1P distance) lives in plain RAM: it survives title↔race cycles but NOT
 *   a power cycle / hardReset. Never fake persistence — if you need real saves,
 *   that's a future core round (ASCII8-SRAM mapper carts exist; the core just
 *   doesn't surface their RAM yet). The Genesis/NES/SMS versions of this game
 *   DO persist the same best distance to cartridge SRAM.
 */
#include "msx_hw.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "TURBO TANGLE"

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
 * LINE shift, not a per-layer camera, and MSX1 lacks even that). So a vertical
 * road racer cannot just "scroll the background down" the way the NES version
 * does — there is no register to turn.
 *
 * TURBO TANGLE fakes the scroll the only cheap way screen 2 allows: it keeps a
 * single 0-7 "road phase" that advances with the car's speed, and each frame it
 * REDRAWS just the road's moving parts — the dashed lane markers and a sparse
 * shoulder speckle — one phase-step further DOWN the name table. The static
 * parts (asphalt fill, solid shoulders, centre divider) are painted ONCE and
 * never touched. Redrawing only ~2 columns of dashes + a speckle column per
 * frame keeps the per-frame VRAM burst tiny, so it never fights the per-row
 * color idiom below (the color tables still upload ONCE). The eye reads the
 * marching dashes as forward motion — exactly the trick fixed-screen arcade
 * racers used before hardware scroll was common.
 *
 * If you want REAL smooth scroll on MSX2, that is an R23 line-shift routine
 * plus re-streaming the name + color tables as rows enter — the single biggest
 * MSX scroller footgun; see TROUBLESHOOTING before attempting it. */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile font: index 0 = space, 1-26 = A-Z, 27-36 = 0-9, 37 = dash, then the
 * road tiles. One 8x8 pattern = 8 bytes, one bit per pixel; set bits draw in
 * the tile's FOREGROUND color, clear bits in its BACKGROUND color (both come
 * from the screen-2 color table — see the per-row-color idiom below). */
#define T_SPACE   0
#define T_A       1          /* 'A'..'Z' = T_A + (c - 'A')                  */
#define T_0       27         /* '0'..'9' = T_0 + (c - '0')                  */
#define T_DASH    37
#define T_ASPHALT 38         /* plain road surface (faint tarmac speck)     */
#define T_GRASS   39         /* roadside shoulder (hatch texture)           */
#define T_LANE    40         /* the marching dashed lane marker (scrolls)   */
#define T_DIVIDER 41         /* solid centre divider — its COLOR shimmers   */
#define T_TUFT    42         /* roadside scenery tuft (rides the speckle)   */
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
    /* 38 ASPHALT (sparse tarmac speck so the road isn't a flat void) */
               {0x00,0x00,0x00,0x10,0x00,0x00,0x02,0x00},
    /* 39 GRASS  (roadside hatch texture) */
               {0xAA,0x55,0xAA,0x55,0xAA,0x55,0xAA,0x55},
    /* 40 LANE   (a vertical dash segment — half on, half off; phase-shifted
     *            by which name-table row it lands on for the marching look) */
               {0x18,0x18,0x18,0x18,0x00,0x00,0x00,0x00},
    /* 41 DIVIDER(solid bar — its 8 COLOR bytes carry the shimmer gradient) */
               {0x3C,0x3C,0x3C,0x3C,0x3C,0x3C,0x3C,0x3C},
    /* 42 TUFT   (a little roadside bush over the grass) */
               {0x00,0x18,0x3C,0x7E,0xFF,0x7E,0x3C,0x00},
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
 *      The SAME tile index can look completely different in each third. We
 *      exploit exactly that to make ONE road tile set read as a depth-shaded
 *      track: the HUD band (third 0) gets bright text colors; the asphalt cools
 *      from a hazy distance grey at the top toward a darker near-road grey at
 *      the bottom, and the grass deepens the same way — one tile set, three
 *      bands, zero extra tiles (the racing twin of the shmup's depth starfield).
 *
 *   2. Within a tile, the color table holds EIGHT bytes — one per 8x1 pixel
 *      row — each packing (foreground<<4)|background from the fixed TMS9918
 *      palette. So one tile can carry an 8-color vertical gradient: T_DIVIDER's
 *      whole "shimmer" running down the centre divider is a single tile,
 *      colors only.
 *
 * Requires: the screen-2 table layout set by msx_set_screen2() (R3=0xFF,
 *   R4=0x03 — the "thirds" configuration), and pattern + color uploads to
 *   EVERY third a tile is used in. Tile N's slot is pattern[N*8] / color[N*8].
 *
 * TMS9918 fixed palette used here: 1 black, 4 dark blue, 6 dark red, 8 medium
 * red, 12 dark green, 13 light green, 14 gray, 15 white, 10 dark yellow,
 * 11 light yellow (high nibble = fg, low nibble = bg of each row byte). */
static const uint8_t col_text[3]    = { 0xF1, 0xF1, 0xF1 }; /* white-on-black text everywhere       */
/* The asphalt speck, banded by third: hazy light-grey far off, mid grey, dark
 * near-road grey close — pure per-third recolor of one tile (bg = the road). */
static const uint8_t col_asphalt[3] = { 0xE4, 0xE1, 0x1E };
/* The grass shoulders, banded so distant grass reads cooler/darker and near
 * grass brightens — same hatch tile, three colors. */
static const uint8_t col_grass[3]   = { 0xC1, 0xD1, 0xD1 };
/* The marching lane dashes: bright yellow on the road bg, banded subtly. */
static const uint8_t col_lane[3]    = { 0xB1, 0xB4, 0xB1 };
/* Roadside scenery tuft: green bush over the grass band. */
static const uint8_t col_tuft[3]    = { 0xC1, 0xC1, 0xD1 };
/* T_DIVIDER: 8 DIFFERENT color bytes inside ONE tile = an 8-pixel-row shimmer
 * down the centre divider (black → grey → white and back). The divider pattern
 * is a solid 4px bar so the fg nibbles show. Recolored again per third free. */
static const uint8_t col_div[8]     = { 0x11,0xE1,0xF1,0xF1,0xF1,0xF1,0xE1,0x11 };

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
            if (i == T_DIVIDER) {           /* the one per-pixel-row gradient  */
                msx_vram_write((uint16_t)(colbase + ((uint16_t)i << 3)), col_div, 8);
                continue;
            }
            if      (i == T_ASPHALT) col = col_asphalt[third];
            else if (i == T_GRASS)   col = col_grass[third];
            else if (i == T_LANE)    col = col_lane[third];
            else if (i == T_TUFT)    col = col_tuft[third];
            else                     col = col_text[third];
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

/* ── GAME LOGIC (clay — reshape freely) — road geometry + race rules ─────────
 * The road fills the 32x24 screen-2 name table. Four 2-cell lanes sit between
 * grass shoulders, with a solid divider down the middle (it is also the 2P
 * territory line). Tile columns:
 *   COL_EDGE_L/R   — solid grass-edge shoulders bounding the asphalt
 *   COL_LANE_1/2   — the two dashed inner lane lines
 *   COL_DIVIDER    — the solid centre divider
 * Row 0 is the HUD band (third 0's text colors make it a distinct strip). */
#define COL_EDGE_L   8
#define COL_LANE_1   12
#define COL_DIVIDER  16
#define COL_LANE_2   20
#define COL_EDGE_R   24
/* Lane centre X for the 8px-wide car sprite (4 lanes across the asphalt). */
static const uint8_t lane_x[4] = { 80, 112, 136, 168 };

#define MAX_TRAFFIC  5
#define CAR_Y       168         /* both cars' fixed screen Y (near the bottom) */
#define SPAWN_Y      16         /* traffic entry Y (just under the HUD band)   */
#define DESPAWN_Y   184         /* traffic leaves the road past here           */
#define START_LIVES  3          /* crashes per run / per player                */
#define SPAWN_PERIOD 40         /* frames between traffic spawns               */
#define SPEED_2P     2          /* fixed shared road speed in versus           */

/* Players: index 0 = P1 (port 1 + keyboard), 1 = P2 (port 2, versus only). */
static uint8_t car_lane[2];      /* 0..3                                       */
static uint8_t car_active[2];
static uint8_t crashes_left[2];
static uint8_t invuln[2];        /* post-crash blink / no-collide frames       */
static uint8_t lane_min[2], lane_max[2];  /* 2P: split territories             */
static uint8_t prev_dir[2];      /* per-player steer edge detection            */
static uint8_t prev_acc;         /* 1P accel/brake edge detection              */
static uint8_t two_player;
static uint8_t winner;           /* versus result: 0 = P1 wins, 1 = P2 wins    */

static uint8_t traffic_alive[MAX_TRAFFIC];
static uint8_t traffic_lane[MAX_TRAFFIC];
static uint8_t traffic_y[MAX_TRAFFIC];

static uint8_t  speed;           /* road px/frame, 1-4                         */
static uint16_t dist;            /* 1P distance, 1 unit = 16 scrolled px        */
static uint8_t  dist_frac;
static uint16_t best;            /* SESSION-ONLY best 1P distance — see header.
                                  * No SAVE_RAM on this core, so it lives in
                                  * plain RAM: survives title↔race cycles, NOT
                                  * a power cycle (honest, not faked).         */
static uint8_t  spawn_timer;
static uint8_t  road_phase;      /* 0..7 — the faked-scroll offset (idiom)     */

#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;
static uint8_t prev_t1, prev_t2; /* title/over trigger edge detection          */

/* ── GAME LOGIC (clay — reshape freely) — xorshift16 PRNG.
 * Traffic lanes + spawn timing read from this so two runs never play the same;
 * ticked once per play frame so identical states a few seconds apart diverge. */
static uint16_t rng;
static uint8_t next_rand(void) {
    rng ^= (uint16_t)(rng << 7);
    rng ^= (uint16_t)(rng >> 9);
    rng ^= (uint16_t)(rng << 8);
    return (uint8_t)(rng & 0xFF);
}

/* ── GAME LOGIC (clay — reshape freely) — music + SFX on the AY-3-8910 ──────
 * Channel plan: A = lane-tick / engine blips, B = crash + brake noise, C =
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
    254, 0, 254, 214, 254, 0, 285, 254,   /* A4 A4 C5 A4 G4 A4  (driving riff)   */
    214, 0, 254, 285, 254, 0,   0,   0,   /* C5 A4 G4 A4 rest                     */
    190, 0, 214, 254, 190, 0, 214, 190,   /* D5 C5 A4 D5 C5 D5                     */
    254, 0, 285, 254, 214, 0,   0,   0,   /* A4 G4 A4 C5 rest                     */
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

static void sfx_lane(void)  { msx_psg_tone(0, 0x180, 10); sfx_a_t = 3; }
static void sfx_accel(void) { msx_psg_tone(0, 0x110, 11); sfx_a_t = 5; }
static void sfx_brake(void) { msx_psg_noise(1, 18, 9);    sfx_b_t = 5; }
static void sfx_pass(void)  { msx_psg_tone(0, 0x0C0, 8);  sfx_a_t = 2; }
static void sfx_crash(void) { msx_psg_noise(1, 28, 15);   sfx_b_t = 20; }
static void sfx_start(void) { msx_psg_tone(0, 0x130, 12); sfx_a_t = 6; }

/* ── GAME LOGIC (clay — reshape freely) — HUD ──────────────────────────────
 * Row 0 = the HUD band (third 0's text colors make it a distinct strip).
 * 1P: LIVES left, DIST right. 2P: P1 crashes-left | VS | P2 crashes-left. */
static void draw_hud_labels(void) {
    if (two_player) {
        draw_text(1, 0, "P1");
        draw_text(14, 0, "VS");
        draw_text(26, 0, "P2");
    } else {
        draw_text(1, 0, "LIVES");
        draw_text(20, 0, "DIST");
    }
}
static void draw_lives(void) {
    if (two_player) {
        put_tile(4, 0, (uint8_t)(T_0 + crashes_left[0]));
        put_tile(29, 0, (uint8_t)(T_0 + crashes_left[1]));
    } else {
        put_tile(7, 0, (uint8_t)(T_0 + crashes_left[0]));
    }
}
static void draw_dist(void) { if (!two_player) draw_num4(25, 0, dist); }

/* ── GAME LOGIC (clay — reshape freely) — paint the road (name table) ───────
 * The whole 32x24 name table: HUD band on row 0, grass shoulders outside the
 * asphalt, solid edges + centre divider, asphalt fill between. The marching
 * lane dashes and roadside speckle are NOT written here — restripe_road()
 * redraws those each frame to fake the scroll (see the no-hw-scroll idiom).
 * The per-third color idiom shades the whole thing into depth bands for free. */
static void clear_field(void) { msx_fill_vram(VRAM_NAME, 32u * 24u, T_SPACE); }

static void paint_road(void) {
    uint8_t row, col, t;
    for (row = 0; row < 24; row++) {
        for (col = 0; col < 32; col++) {
            if (row == 0)                            t = T_SPACE;  /* HUD band */
            else if (col < COL_EDGE_L || col > COL_EDGE_R) t = T_GRASS;
            else if (col == COL_EDGE_L || col == COL_EDGE_R) t = T_GRASS; /* shoulder */
            else if (col == COL_DIVIDER)             t = T_DIVIDER;
            else                                     t = T_ASPHALT;
            put_tile(col, row, t);
        }
    }
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * The faked vertical scroll. Because screen 2 has no scroll register (see the
 * idiom above), we redraw only the MOVING cells each frame from road_phase:
 *   - The two dashed lane lines: a cell shows a dash when (row+phase) is in the
 *     "on" half of an 8-row cycle, asphalt otherwise — so the dash pattern
 *     marches DOWN one row per phase step, reading as forward motion.
 *   - One roadside speckle column: a tuft drops down the grass with the phase,
 *     giving the shoulder a sense of speed too.
 * Only ~3 columns × 23 rows are touched (well inside the frame's VRAM budget),
 * and the static asphalt/edges/divider painted by paint_road() are left alone. */
static void restripe_road(uint8_t phase) {
    uint8_t row, on, t;
    for (row = 1; row < 24; row++) {
        on = (uint8_t)(((row + phase) & 7) < 4);         /* dash on/off cycle  */
        t = on ? T_LANE : T_ASPHALT;
        put_tile(COL_LANE_1, row, t);
        put_tile(COL_LANE_2, row, t);
        /* a single roadside tuft riding down the left grass band */
        put_tile(2, row, (((row + phase) & 7) == 0) ? T_TUFT : T_GRASS);
        put_tile(29, row, (((row + phase + 4) & 7) == 0) ? T_TUFT : T_GRASS);
    }
}

/* ── GAME LOGIC (clay — reshape freely) — sprites: cars + traffic ───────────
 * 8x8 one-color hardware sprites. Plane layout: 0 = P1 car, 1 = P2 car,
 * 2..2+MAX_TRAFFIC-1 = traffic. Road art is tiles, not sprites, so the list
 * never exceeds 2 + MAX_TRAFFIC planes. */
static const uint8_t spr_car[8]     = {0x18,0x3C,0x5A,0x7E,0x3C,0x7E,0x5A,0x66};
static const uint8_t spr_traffic[8] = {0x66,0x5A,0x7E,0x3C,0x7E,0x5A,0x3C,0x18};
#define PAT_CAR     0
#define PAT_TRAFFIC 1
#define COL_P1      15   /* white        */
#define COL_P2      13   /* light green  */
#define COL_TRAFFIC 8    /* medium red   */

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Sprite limits + the Y=208 terminator:
 *   - A sprite Y of 0xD0 (208) tells the TMS9918 to STOP SCANNING the
 *     attribute table — every higher-numbered plane vanishes, not just that
 *     one. (msx_clear_sprites parks ALL planes at 0xD0, which is fine at the
 *     END of the list.) To hide ONE sprite mid-list, park it OFFSCREEN at
 *     PARK_Y (192 = first line below the display) — never at 0xD0.
 *     (On MSX2's V9938 sprite mode 2 the terminator moves to 0xD8 and 0xD0
 *     is "just offscreen" — code that leans on that breaks on MSX1.)
 *   - Per scanline the TMS9918 draws only 4 sprites (V9938: 8). Traffic is
 *     spread across 4 lanes and four screen-Y bands, so a single scanline
 *     almost never carries more than 2-3 of our planes; if you raise
 *     MAX_TRAFFIC, watch for 4-on-a-line flicker. */
#define PARK_Y 192

static void push_sprites(void) {
    uint8_t i, plane = 0;
    uint8_t actors = (state == ST_PLAY);
    /* P1 car — blink while invulnerable after a crash (skip on odd frames). */
    msx_set_sprite(plane++, lane_x[car_lane[0]],
        (actors && car_active[0] && !(invuln[0] & 2)) ? CAR_Y : PARK_Y,
        PAT_CAR, COL_P1);
    /* P2 car. */
    msx_set_sprite(plane++, lane_x[car_lane[1]],
        (actors && car_active[1] && !(invuln[1] & 2)) ? CAR_Y : PARK_Y,
        PAT_CAR, COL_P2);
    for (i = 0; i < MAX_TRAFFIC; i++)
        msx_set_sprite(plane++, lane_x[traffic_lane[i]],
            (actors && traffic_alive[i]) ? traffic_y[i] : PARK_Y,
            PAT_TRAFFIC, COL_TRAFFIC);
}

/* ── GAME LOGIC (clay — reshape freely) — traffic pool (fixed slots) ── */
static void spawn_traffic(void) {
    uint8_t i;
    for (i = 0; i < MAX_TRAFFIC; i++) {
        if (!traffic_alive[i]) {
            traffic_alive[i] = 1;
            traffic_lane[i] = (uint8_t)(next_rand() & 3);
            traffic_y[i] = SPAWN_Y;
            return;
        }
    }
}

/* AABB, both boxes 8x8. */
static uint8_t hits(uint8_t ax, uint8_t ay, uint8_t bx, uint8_t by) {
    uint8_t dx = (ax > bx) ? (uint8_t)(ax - bx) : (uint8_t)(bx - ax);
    uint8_t dy = (ay > by) ? (uint8_t)(ay - by) : (uint8_t)(by - ay);
    return (dx < 8) && (dy < 8);
}

/* ── GAME LOGIC (clay — reshape freely) — the screens ──────────────────────
 * Title rows land across the play thirds — recolored for free by the thirds
 * idiom. A clean name table behind the text. */
static void paint_title(void) {
    uint8_t len = 0, col;
    const char *p = GAME_TITLE;
    while (*p++) len++;
    col = (uint8_t)((32 - len) / 2);
    clear_field();
    draw_text(col, 6, GAME_TITLE);
    draw_text(7, 11, "1P RACE - FIRE A");
    draw_text(7, 13, "2P VERSUS - FIRE B");
    draw_text(11, 16, "STEER L-R");
    draw_text(11, 19, "BEST 0000");        /* the space blanks the cell between */
    draw_num4(16, 19, best);
}

static void paint_over(void) {
    clear_field();
    if (two_player) {
        draw_text(11, 7, winner ? "P2 WINS" : "P1 WINS");
        draw_text(8, 10, "RIVAL CRASHED OUT");
    } else {
        draw_text(11, 7, "WRECKED");
        draw_text(11, 10, "DIST"); draw_num4(16, 10, dist);
        draw_text(11, 13, "BEST"); draw_num4(16, 13, best);
    }
    draw_text(8, 17, "FIRE FOR TITLE");
    prev_t1 = prev_t2 = 1;             /* swallow a fire still held from play  */
}

/* ── GAME LOGIC (clay — reshape freely) — start a run ── */
static void start_game(uint8_t versus) {
    uint8_t i;
    two_player = versus;
    for (i = 0; i < MAX_TRAFFIC; i++) traffic_alive[i] = 0;
    for (i = 0; i < 2; i++) { crashes_left[i] = START_LIVES; invuln[i] = 0; prev_dir[i] = 0; }
    if (versus) {
        car_active[0] = 1; car_active[1] = 1;
        lane_min[0] = 0; lane_max[0] = 1; car_lane[0] = 0;   /* P1: left half  */
        lane_min[1] = 2; lane_max[1] = 3; car_lane[1] = 3;   /* P2: right half */
        speed = SPEED_2P;                 /* one road, fixed shared speed       */
    } else {
        car_active[0] = 1; car_active[1] = 0;
        lane_min[0] = 0; lane_max[0] = 3; car_lane[0] = 1;   /* whole road      */
        speed = 1;
    }
    dist = 0; dist_frac = 0;
    spawn_timer = 0;
    road_phase = 0;
    prev_acc = 1;
    paint_road();
    restripe_road(road_phase);
    draw_hud_labels();
    draw_lives();
    draw_dist();
    sfx_start();
    state = ST_PLAY;
}

/* ── GAME LOGIC (clay — reshape freely) — run over: result + record.
 * Persistence choice: a 1P run banks its DISTANCE; the best is the stat a
 * returning player chases. 2P matches never touch it (humans beating each
 * other isn't a record). On THIS core the best is session-only RAM (no
 * SAVE_RAM — see the file header); the Genesis/NES/SMS builds persist the
 * identical best distance to cartridge SRAM. ── */
static void end_run(void) {
    if (!two_player && dist > best) best = dist;
    sfx_crash();
    paint_over();
    state = ST_OVER;
}

/* ── GAME LOGIC (clay — reshape freely) — a crash ── */
static void crash(uint8_t p) {
    sfx_crash();
    invuln[p] = 60;                       /* blink + no-collide grace          */
    if (!two_player) speed = 1;           /* a wreck kills your momentum       */
    if (crashes_left[p] > 0) --crashes_left[p];
    draw_lives();
    if (crashes_left[p] == 0) {
        winner = (uint8_t)(1 - p);        /* versus: the OTHER player wins     */
        end_run();
    }
}

/* ── GAME LOGIC (clay — reshape freely) — per-player input ───────────────────
 * P0 reads JOYSTICK PORT 1 (keyboard cursors fall back); P1 reads PORT 2.
 * LEFT/RIGHT steer between lanes (edge-detected — a held stick must NOT
 * machine-gun across the road). 1P only: UP/A accelerate, DOWN/B brake. */
static void update_player(uint8_t p) {
    uint8_t dir, left, right;
    if (p == 0) {
        dir = msx_read_joystick(1);
        if (dir == STICK_CENTER) dir = msx_read_joystick(0);
    } else {
        dir = msx_read_joystick(2);
    }
    left  = (dir == STICK_LEFT  || dir == STICK_UL || dir == STICK_DL);
    right = (dir == STICK_RIGHT || dir == STICK_UR || dir == STICK_DR);
    {
        uint8_t pl = prev_dir[p];
        uint8_t prev_left  = (pl == STICK_LEFT  || pl == STICK_UL || pl == STICK_DL);
        uint8_t prev_right = (pl == STICK_RIGHT || pl == STICK_UR || pl == STICK_DR);
        if (left && !prev_left && car_lane[p] > lane_min[p]) { --car_lane[p]; sfx_lane(); }
        if (right && !prev_right && car_lane[p] < lane_max[p]) { ++car_lane[p]; sfx_lane(); }
    }
    prev_dir[p] = dir;

    if (!two_player) {                    /* speed is shared — only 1P gets it */
        uint8_t up   = (dir == STICK_UP   || dir == STICK_UL || dir == STICK_UR) || gttrig(1) || gttrig(0);
        uint8_t down = (dir == STICK_DOWN || dir == STICK_DL || dir == STICK_DR);
        uint8_t acc  = (uint8_t)(up ? 1 : (down ? 2 : 0));
        if (acc && acc != prev_acc) {
            if (up && speed < 4)   { ++speed; sfx_accel(); }
            if (down && speed > 1) { --speed; sfx_brake(); }
        }
        prev_acc = acc;
    }
    if (invuln[p] > 0) --invuln[p];
}

void main(void) {
    uint8_t i, p, t1, t2;

    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * Init order: set the video mode FIRST (INIGRP also clears VRAM — any
     * upload done before it is wiped), then tiles, then sprites. The crt0's
     * INIT contract means main() must NEVER return — the BIOS has nothing
     * sane to fall back to — hence the for(;;) below. */
    msx_set_screen2();
    msx_clear_sprites();
    load_tiles();
    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_CAR     * 8), spr_car,     8);
    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_TRAFFIC * 8), spr_traffic, 8);

    msx_music(0);            /* the lib's demo loop also owns channel C —
                             * hand the channel to OUR tune table instead    */
    best = 0;                /* session record (no SAVE_RAM on this core)    */
    rng = 0xACE1;
    music_step = music_timer = 0;
    sfx_a_t = sfx_b_t = 0;
    prev_t1 = prev_t2 = 1;   /* swallow a held trigger across state changes  */
    two_player = 0;
    car_lane[0] = car_lane[1] = 1;
    state = ST_TITLE;
    paint_title();

    for (;;) {
        vsync();
        music_tick();
        sfx_tick();

        if (state == ST_TITLE) {
            /* ── GAME LOGIC (clay) — title: trig A = 1P race; trig B = 2P. */
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

        /* ── ST_PLAY — GAME LOGIC (clay) ────────────────────────────────────
         * Both players (or just P1) update EVERY frame — a simultaneous
         * versus race, not alternating turns. */
        next_rand();                 /* tick the noise source every play frame */

        update_player(0);
        if (two_player) update_player(1);

        /* Advance the faked scroll by the current speed, then restripe only
         * the moving cells (see the no-hw-scroll idiom). */
        road_phase = (uint8_t)((road_phase + speed) & 7);
        restripe_road(road_phase);

        /* 1P distance: 1 unit per 16 scrolled pixels. */
        if (!two_player) {
            dist_frac = (uint8_t)(dist_frac + speed);
            if (dist_frac >= 16) {
                dist_frac = (uint8_t)(dist_frac - 16);
                if (dist < 9999u) ++dist;
                draw_dist();
            }
        }

        /* Traffic flows DOWN the road at road speed (reads as slower cars you
         * overtake); despawn past the bottom with a little pass tick. */
        for (i = 0; i < MAX_TRAFFIC; i++) {
            if (!traffic_alive[i]) continue;
            if (traffic_y[i] >= (uint8_t)(DESPAWN_Y - speed)) {
                traffic_alive[i] = 0;
                sfx_pass();
            } else {
                traffic_y[i] = (uint8_t)(traffic_y[i] + speed);
            }
        }
        if (++spawn_timer >= SPAWN_PERIOD) { spawn_timer = 0; spawn_traffic(); }

        /* Traffic ↔ cars. A just-wrecked car blinks + can't collide for 60f. */
        for (i = 0; i < MAX_TRAFFIC; i++) {
            if (!traffic_alive[i]) continue;
            for (p = 0; p < 2; p++) {
                if (!car_active[p] || invuln[p]) continue;
                if (hits(lane_x[traffic_lane[i]], traffic_y[i], lane_x[car_lane[p]], CAR_Y)) {
                    traffic_alive[i] = 0;
                    crash(p);
                    break;
                }
            }
            if (state != ST_PLAY) break;     /* a crash may have ended the run */
        }
        if (state != ST_PLAY) continue;

        push_sprites();
    }
}
