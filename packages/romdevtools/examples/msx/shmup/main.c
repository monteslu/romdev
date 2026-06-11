/* ── shmup/main.c — MSX vertical shooter (complete example game) ─────────────
 *
 * A COMPLETE, working game — title screen, 1P and 2P co-op modes (MSX has two
 * joystick ports), lives, score + session hi-score, music + SFX on the
 * AY-3-8910 PSG, and the MSX's signature trick: SCREEN-2 PER-ROW COLOR
 * (the color table gives every 8x1 pixel row of every tile its own
 * foreground/background pair, in THREE independent screen thirds — used here
 * for a depth-banded starfield, a HUD band in its own colors, and an 8-color
 * gradient inside a single tile).
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented MSX footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — enemy patterns, scoring, tuning, art: reshape freely.
 *
 * What depends on what:
 *   msx_hw.h / msx_vdp.c — VDP + PSG + joystick helpers (direct Z80 ports;
 *     the PSG functions carry a DI/EI guard against the BIOS KEYINT race —
 *     read msx_vdp.c before adding your own PSG pokes).
 *   msx_crt0.s — the $4000 "AB" cart header + static-init copy. Load-bearing;
 *     INIT must never return, so main() ends in for(;;).
 *
 * Controls: joystick PORT 1 (or keyboard cursors+space) flies ship 1,
 *   trigger A fires. PORT 2 flies ship 2 in co-op. On the title screen
 *   trigger A starts 1P; trigger B (or player 2's trigger) starts 2P co-op.
 *
 * Hi-score honesty: the bundled bluemsx core build does NOT expose a battery
 *   save path (retro_get_memory(SAVE_RAM) is unimplemented for MSX carts), so
 *   the hi-score lives in plain RAM: it survives title↔game cycles but NOT a
 *   power cycle. Never fake persistence — if you need real saves, that's a
 *   future core round (SRAM-mapper cart types like ASCII8-SRAM exist; the
 *   core just doesn't surface their RAM yet).
 */
#include "msx_hw.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "NEBULA WARDEN"

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

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile font: index 0 = space, 1-26 = A-Z, 27-36 = 0-9, 37 = dash, then the
 * starfield tiles. One 8x8 pattern = 8 bytes, one bit per pixel; set bits
 * draw in the tile's FOREGROUND color, clear bits in its BACKGROUND color
 * (both come from the screen-2 color table — see the idiom block below). */
#define T_SPACE  0
#define T_A      1           /* 'A'..'Z' = T_A + (c - 'A')                  */
#define T_0      27          /* '0'..'9' = T_0 + (c - '0')                  */
#define T_DASH   37
#define T_FIELD  38          /* empty space cell (pattern all 0 = all bg)   */
#define T_STAR1  39          /* faint single-pixel star                     */
#define T_STAR2  40          /* bright cross star                           */
#define T_NEBULA 41          /* the per-8x1-row gradient tile (see below)   */
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
    /* 38 FIELD  (all bg)     */ {0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00},
    /* 39 STAR1  (one pixel)  */ {0x00,0x00,0x00,0x10,0x00,0x00,0x00,0x00},
    /* 40 STAR2  (cross)      */ {0x00,0x10,0x10,0x7C,0x10,0x10,0x00,0x00},
    /* 41 NEBULA (solid fg — its COLOR bytes paint the gradient) */
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
 *      we exploit exactly that for the depth-banded starfield below.
 *
 *   2. Within a tile, the color table holds EIGHT bytes — one per 8x1 pixel
 *      row — each packing (foreground<<4)|background from the fixed TMS9918
 *      palette. So one tile can carry an 8-color vertical gradient
 *      (T_NEBULA's whole "glow horizon" is a single tile, colors only).
 *
 * Requires: the screen-2 table layout set by msx_set_screen2() (R3=0xFF,
 *   R4=0x03 — the "thirds" configuration; some games set R3/R4 so all thirds
 *   SHARE one slice, which saves VRAM but kills this trick), and pattern +
 *   color uploads to EVERY third a tile is used in. Upload with the display
 *   idle or accept a partial frame: tile N's slot is pattern[N*8] / color[N*8].
 *
 * Depth scheme taught here (TMS9918 fixed palette: 1 black, 4 dark blue,
 * 5 light blue, 7 cyan, 11 light yellow, 14 gray, 15 white):
 *   third 0 (top)    = deep space:  black field, gray stars   — far, dim
 *   third 1 (middle) = mid space:   dark blue,   yellow stars — closer
 *   third 2 (bottom) = near space:  light blue,  white stars  — closest
 *   ...and the HUD text band (row 0, third 0) gets its OWN colors, distinct
 *   from everything below it, without costing any extra tiles. */
static const uint8_t col_text[3]  = { 0xF4, 0xB4, 0x15 }; /* HUD white-on-blue; title yellow-on-blue; bottom black-on-lightblue */
static const uint8_t col_field[3] = { 0x11, 0x44, 0x55 }; /* the three depth bands (bg shows: pattern is all 0) */
static const uint8_t col_star1[3] = { 0xE1, 0xB4, 0xF5 }; /* faint star per band: gray/yellow/white on its band bg */
static const uint8_t col_star2[3] = { 0xF1, 0xF4, 0xB5 }; /* bright star per band */
/* T_NEBULA: 8 DIFFERENT color bytes inside ONE tile = an 8-pixel-row glow
 * gradient (dark blue → light blue → cyan → white and back down to black).
 * The pattern is solid 0xFF so only the fg nibbles show. */
static const uint8_t col_nebula[8] = { 0x45,0x55,0x75,0xF5,0x75,0x55,0x45,0x15 };

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
            if (i == T_NEBULA) {           /* the one per-pixel-row gradient */
                msx_vram_write((uint16_t)(colbase + ((uint16_t)i << 3)), col_nebula, 8);
                continue;
            }
            if      (i == T_FIELD) col = col_field[third];
            else if (i == T_STAR1) col = col_star1[third];
            else if (i == T_STAR2) col = col_star2[third];
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

/* Paint the full 32x24 starfield. The TILE INDICES are the same everywhere —
 * the three depth bands come ENTIRELY from the per-third color tables (the
 * screen-2 idiom above). Row 0 is the HUD band; row 23 is the one-tile
 * nebula gradient. */
static void paint_starfield(void) {
    uint8_t row, col, h;
    uint8_t buf[32];
    msx_fill_vram(VRAM_NAME, 32, T_SPACE);              /* row 0: HUD band   */
    for (row = 1; row < 23; row++) {
        for (col = 0; col < 32; col++) {
            h = (uint8_t)((row * 7 + col * 5) & 15);    /* cheap static hash */
            if      (h == 0) buf[col] = T_STAR1;
            else if (h == 8) buf[col] = T_STAR2;
            else             buf[col] = T_FIELD;
        }
        msx_vram_write((uint16_t)(VRAM_NAME + (uint16_t)row * 32), buf, 32);
    }
    msx_fill_vram((uint16_t)(VRAM_NAME + 23u * 32), 32, T_NEBULA);
}

/* ── GAME LOGIC (clay — reshape freely) — sprites ────────────────────────────
 * 8x8 one-color hardware sprites. Plane layout (lower plane = on top):
 *   0-1 ships, 2-7 bullets, 8-12 enemies. */
static const uint8_t spr_ship[8]   = {0x18,0x3C,0x7E,0x7E,0xFF,0xFF,0xDB,0x81};
static const uint8_t spr_bullet[8] = {0x18,0x3C,0x3C,0x3C,0x3C,0x3C,0x18,0x00};
static const uint8_t spr_enemy[8]  = {0x81,0x42,0x24,0x18,0x18,0x24,0x42,0x81};
#define PAT_SHIP   0
#define PAT_BULLET 1
#define PAT_ENEMY  2
#define COL_SHIP1  15  /* white       */
#define COL_SHIP2  3   /* light green */
#define COL_BULLET 11  /* light yellow*/
#define COL_ENEMY  9   /* light red   */

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
 *     out for that line. Pools here are sized so a worst-case pileup is rare;
 *     if you raise MAX_* counts, expect flicker on crowded rows. */
#define PARK_Y 192

#define MAX_BULLETS 6
#define MAX_ENEMIES 5

/* ── GAME LOGIC (clay — reshape freely) — game state ─────────────────────── */
typedef struct { uint8_t x, y, alive; } Obj;

static Obj      ships[2];
static uint8_t  fire_cd[2];
static Obj      bullets[MAX_BULLETS];
static Obj      enemies[MAX_ENEMIES];
static uint8_t  two_player;      /* mode chosen on the title screen          */
static uint8_t  lives;           /* shared pool in co-op (arcade style)      */
static uint16_t score;
static uint16_t hiscore;         /* SESSION-ONLY: plain RAM. The bundled
                                  * bluemsx build exposes no SAVE_RAM region,
                                  * so there is nothing battery-backed to
                                  * write — survives title↔game cycles, not a
                                  * power cycle (honest, not faked). */
static uint8_t  spawn_timer;
static uint16_t rng;

#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;
static uint8_t prev_t1, prev_t2;  /* trigger edge detection across states   */

/* xorshift16 PRNG — a few dozen cycles, no tables. */
static uint8_t next_rand(void) {
    rng ^= (uint16_t)(rng << 7);
    rng ^= (uint16_t)(rng >> 9);
    rng ^= (uint16_t)(rng << 8);
    return (uint8_t)(rng & 0xFF);
}

/* ── GAME LOGIC (clay — reshape freely) — music + SFX on the AY-3-8910 ──────
 * Channel plan: A = fire blip, B = explosion noise, C = music. The PSG has 3
 * tone channels + ONE shared noise generator, mixed per-channel in reg 7.
 * All register traffic goes through msx_psg_tone/noise/off — they wrap the
 * PSGADDR/PSGWRITE pair in DI/EI because the BIOS KEYINT ISR clobbers the
 * PSG address latch every frame (the bug that once silenced every MSX
 * scaffold — see msx_vdp.c).
 *
 * The tune: one period entry per half-beat, 0 = rest. AY period =
 * 1789773 / (16 * freq) — e.g. A4 (440Hz) -> 254. Ticked once per frame from
 * the main loop; a note advances every 7 frames (~8.5 notes/sec). The lib's
 * built-in demo loop (msx_music_tick) also uses channel C, so we switch it
 * OFF in main() and run this table instead — edit THIS table to rescore. */
static const uint16_t tune[32] = {
    254, 0, 285, 254, 339, 0, 285, 339,   /* A4 G4 A4 E4 G4 E4  (A-minor riff) */
    427, 0, 339, 427, 508, 0,   0,   0,   /* C4 E4 C4 A3 rest                  */
    380, 0, 427, 380, 320, 0, 380, 427,   /* D4 C4 D4 F4 D4 C4                 */
    508, 0, 427, 339, 285, 0,   0,   0,   /* A3 C4 E4 G4 rest                  */
};
static uint8_t music_step, music_timer;
static uint8_t sfx_fire_t, sfx_boom_t;    /* frames left on each SFX channel  */

static void music_tick(void) {
    if (music_timer == 0) {
        uint16_t p = tune[music_step & 31];
        if (p) msx_psg_tone(2, p, 10);
        else   msx_psg_off(2);
        music_step++;
    }
    music_timer++;
    if (music_timer >= 7) music_timer = 0;
}

static void sfx_tick(void) {
    if (sfx_fire_t) { sfx_fire_t--; if (!sfx_fire_t) msx_psg_off(0); }
    if (sfx_boom_t) { sfx_boom_t--; if (!sfx_boom_t) msx_psg_noise(1, 0, 0); }
}

/* ── GAME LOGIC (clay — reshape freely) — HUD ──────────────────────────────
 * Row 0 = the HUD band (third 0's text colors make it a distinct strip).
 * SC=score, HI=hi-score, SH=ships(lives). */
static void draw_hud_labels(void) {
    draw_text(1, 0, "SC");
    draw_text(11, 0, "HI");
    draw_text(21, 0, "SH");
}
static void draw_score(void)  { draw_num4(4, 0, score); }
static void draw_hi(void)     { draw_num4(14, 0, hiscore); }
static void draw_lives(void)  { put_tile(24, 0, (uint8_t)(T_0 + lives)); }

/* ── GAME LOGIC (clay — reshape freely) — screens ──────────────────────────
 * Title rows land in third 1 (yellow-on-blue) and third 2 (the HI line) —
 * the same glyph tiles as the HUD, recolored for free by the thirds idiom. */
static void paint_title(void) {
    uint8_t len = 0, col;
    const char *p = GAME_TITLE;
    while (*p++) len++;
    col = (uint8_t)((32 - len) / 2);
    paint_starfield();
    draw_text(col, 8, GAME_TITLE);
    draw_text(7, 12, "1P START - FIRE A");
    draw_text(7, 14, "2P CO-OP - FIRE B");
    draw_text(12, 19, "HI 0000");      /* the space blanks the cell between */
    draw_num4(15, 19, hiscore);
}

static void start_game(uint8_t players) {
    uint8_t i;
    two_player = players;
    for (i = 0; i < MAX_BULLETS; i++) bullets[i].alive = 0;
    for (i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = 0;
    ships[0].x = two_player ? 96 : 120; ships[0].y = 160; ships[0].alive = 1;
    ships[1].x = 144;                   ships[1].y = 160; ships[1].alive = two_player;
    fire_cd[0] = fire_cd[1] = 0;
    lives = 3;
    score = 0;
    spawn_timer = 0;
    paint_starfield();
    draw_hud_labels();
    draw_score(); draw_hi(); draw_lives();
    state = ST_PLAY;
}

static void game_over(void) {
    if (score > hiscore) { hiscore = score; draw_hi(); }
    draw_text(11, 11, "GAME OVER");
    draw_text(8, 13, "FIRE FOR TITLE");
    prev_t1 = prev_t2 = 1;   /* swallow a fire button still held from play   */
    state = ST_OVER;
}

/* ── GAME LOGIC (clay — reshape freely) — combat ─────────────────────────── */
static uint8_t aabb(Obj *a, Obj *b) {
    return a->x < b->x + 8 && a->x + 8 > b->x
        && a->y < b->y + 8 && a->y + 8 > b->y;
}

static void fire(uint8_t p) {
    uint8_t i;
    for (i = 0; i < MAX_BULLETS; i++) {
        if (!bullets[i].alive) {
            bullets[i].x = ships[p].x;
            bullets[i].y = (uint8_t)(ships[p].y - 8);
            bullets[i].alive = 1;
            msx_psg_tone(0, 0x080, 12);          /* high blip on channel A   */
            sfx_fire_t = 4;
            return;
        }
    }
}

static void spawn_enemy(void) {
    uint8_t i;
    for (i = 0; i < MAX_ENEMIES; i++) {
        if (!enemies[i].alive) {
            enemies[i].x = (uint8_t)(8 + (next_rand() % 232));
            enemies[i].y = 12;
            enemies[i].alive = 1;
            return;
        }
    }
}

/* Per-player input + movement. Stick mapping: P1 = joystick port 1 with the
 * keyboard cursors (stick 0) as fallback; P2 = joystick port 2. GTSTCK
 * returns 0=center then 1-8 clockwise from up. */
static void update_ship(uint8_t p) {
    uint8_t dir, trig;
    if (!ships[p].alive) return;
    if (p == 0) {
        dir = msx_read_joystick(1);
        if (dir == STICK_CENTER) dir = msx_read_joystick(0);
        trig = (uint8_t)(gttrig(1) || gttrig(0));   /* port-1 trig A or SPACE */
    } else {
        dir = msx_read_joystick(2);
        trig = gttrig(2);                            /* port-2 trigger A      */
    }
    if ((dir == STICK_LEFT || dir == STICK_UL || dir == STICK_DL)
        && ships[p].x > 4)   ships[p].x = (uint8_t)(ships[p].x - 2);
    if ((dir == STICK_RIGHT || dir == STICK_UR || dir == STICK_DR)
        && ships[p].x < 248) ships[p].x = (uint8_t)(ships[p].x + 2);
    if ((dir == STICK_UP || dir == STICK_UL || dir == STICK_UR)
        && ships[p].y > 24)  ships[p].y = (uint8_t)(ships[p].y - 2);
    if ((dir == STICK_DOWN || dir == STICK_DL || dir == STICK_DR)
        && ships[p].y < 168) ships[p].y = (uint8_t)(ships[p].y + 2);
    if (trig && fire_cd[p] == 0) { fire(p); fire_cd[p] = 10; }
    if (fire_cd[p]) fire_cd[p]--;
}

/* Push every object to its sprite plane. Dead objects park at PARK_Y
 * (offscreen), NEVER 0xD0 — see the sprite idiom block above. */
static void push_sprites(void) {
    uint8_t i;
    msx_set_sprite(0, ships[0].x, ships[0].alive ? ships[0].y : PARK_Y,
                   PAT_SHIP, COL_SHIP1);
    msx_set_sprite(1, ships[1].x, ships[1].alive ? ships[1].y : PARK_Y,
                   PAT_SHIP, COL_SHIP2);
    for (i = 0; i < MAX_BULLETS; i++)
        msx_set_sprite((uint8_t)(2 + i), bullets[i].x,
                       bullets[i].alive ? bullets[i].y : PARK_Y,
                       PAT_BULLET, COL_BULLET);
    for (i = 0; i < MAX_ENEMIES; i++)
        msx_set_sprite((uint8_t)(8 + i), enemies[i].x,
                       enemies[i].alive ? enemies[i].y : PARK_Y,
                       PAT_ENEMY, COL_ENEMY);
}

void main(void) {
    uint8_t i, j, t1, t2;

    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * Init order: set the video mode FIRST (INIGRP also clears VRAM — any
     * upload done before it is wiped), then tiles, then sprites. The crt0's
     * INIT contract means main() must NEVER return — the BIOS has nothing
     * sane to fall back to — hence the for(;;) below. */
    msx_set_screen2();
    msx_clear_sprites();
    load_tiles();
    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_SHIP   * 8), spr_ship,   8);
    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_BULLET * 8), spr_bullet, 8);
    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_ENEMY  * 8), spr_enemy,  8);

    msx_music(0);            /* the lib's demo loop also owns channel C —
                              * hand the channel to OUR tune table instead   */
    hiscore = 0;             /* session hi-score (no SAVE_RAM on this core)  */
    rng = 0xACE1;
    music_step = music_timer = 0;
    sfx_fire_t = sfx_boom_t = 0;
    prev_t1 = prev_t2 = 1;   /* swallow a held trigger across state changes  */
    state = ST_TITLE;
    paint_title();

    for (;;) {
        vsync();
        music_tick();
        sfx_tick();

        if (state == ST_TITLE) {
            /* ── GAME LOGIC (clay) — title: trig A = 1P; trig B (port-1
             * button 2, gttrig 3) OR player 2's trigger = 2P co-op. */
            t1 = (uint8_t)(gttrig(1) || gttrig(0));
            t2 = (uint8_t)(gttrig(3) || gttrig(2));
            if (t2 && !prev_t2)      start_game(1);
            else if (t1 && !prev_t1) start_game(0);
            prev_t1 = t1; prev_t2 = t2;
            continue;
        }

        if (state == ST_OVER) {
            /* Freeze the final frame; any fire button returns to the title. */
            t1 = (uint8_t)(gttrig(1) || gttrig(0) || gttrig(2));
            if (t1 && !prev_t1) {
                state = ST_TITLE;
                msx_clear_sprites();
                paint_title();
            }
            prev_t1 = t1; prev_t2 = t1;
            continue;
        }

        /* ── ST_PLAY — GAME LOGIC (clay) from here down ─────────────────── */
        update_ship(0);
        if (two_player) update_ship(1);

        for (i = 0; i < MAX_BULLETS; i++) {
            if (!bullets[i].alive) continue;
            if (bullets[i].y < 14) { bullets[i].alive = 0; continue; }
            bullets[i].y = (uint8_t)(bullets[i].y - 4);
        }
        for (i = 0; i < MAX_ENEMIES; i++) {
            if (!enemies[i].alive) continue;
            enemies[i].y = (uint8_t)(enemies[i].y + 1);
            if (enemies[i].y >= 184) enemies[i].alive = 0;
        }
        spawn_timer++;
        if (spawn_timer >= 28) { spawn_timer = 0; spawn_enemy(); }

        /* bullets ↔ enemies */
        for (i = 0; i < MAX_BULLETS; i++) {
            if (!bullets[i].alive) continue;
            for (j = 0; j < MAX_ENEMIES; j++) {
                if (!enemies[j].alive) continue;
                if (aabb(&bullets[i], &enemies[j])) {
                    bullets[i].alive = 0;
                    enemies[j].alive = 0;
                    if (score < 9999) score++;
                    draw_score();
                    msx_psg_noise(1, 12, 13);    /* explosion: shared noise  */
                    sfx_boom_t = 8;
                    break;
                }
            }
        }

        /* enemies ↔ ships: shared life pool (arcade co-op) */
        for (j = 0; j < MAX_ENEMIES; j++) {
            if (!enemies[j].alive) continue;
            for (i = 0; i < 2; i++) {
                if (!ships[i].alive) continue;
                if (aabb(&enemies[j], &ships[i])) {
                    enemies[j].alive = 0;
                    msx_psg_noise(1, 28, 14);    /* deeper, longer crunch    */
                    sfx_boom_t = 20;
                    if (lives) lives--;
                    draw_lives();
                    if (lives == 0) {
                        game_over();
                    } else {
                        ships[i].y = 160;        /* respawn knockback        */
                        ships[i].x = i ? 144 : (two_player ? 96 : 120);
                    }
                }
            }
        }

        push_sprites();
    }
}
