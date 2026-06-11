/* ── sports/main.c — MSX head-to-head court sports (complete example game) ────
 *
 * SPARK SWAT — a COMPLETE, working game: title screen, 1P VS a beatable CPU
 * and 2P SIMULTANEOUS VERSUS (P2 on JOYSTICK PORT 2), first-to-5 match flow
 * into a result screen, a longest-win-streak record, music + SFX on the
 * AY-3-8910 PSG, and the MSX's signature SCREEN-2 PER-ROW COLOR: the court
 * floor, the two rails, the centre net and the HUD band all come ENTIRELY
 * from the three independent screen-2 color thirds plus a one-tile vertical
 * "pulse" gradient down the net — costing zero extra tiles.
 *
 * The game (Pong lineage): a ball rallies between two paddles on a netted
 * court. UP/DOWN move your paddle; where the ball strikes the paddle sets the
 * return angle (centre = flat, edges = steep). Steep edge returns outrun the
 * half-speed CPU — that is exactly how a human beats it. First side to 5 wins.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented MSX footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — court art, ball physics, CPU skill, scoring rules:
 *     reshape freely.
 *
 * What depends on what:
 *   msx_hw.h / msx_vdp.c — VDP + PSG + joystick helpers (direct Z80 ports;
 *     the PSG functions carry a DI/EI guard against the BIOS KEYINT race —
 *     read msx_vdp.c before adding your own PSG pokes).
 *   msx_crt0.s — the $4000 "AB" cart header + static-init copy. Load-bearing;
 *     INIT must NEVER return, so main() ends in for(;;).
 *
 * A TEACHING POINT vs the Genesis version of this game
 * (examples/genesis/templates/sports.c): the Genesis hangs its HUD on a
 * hardware WINDOW plane (a fixed status bar at zero per-frame cost) and paints
 * the court ONCE into plane B. The MSX has no window plane and no DMA — but
 * screen 2 gives us three independent COLOR thirds for free, so our HUD band,
 * court floor and rails are all one tilemap differentiated purely by which
 * third (row band) they sit in. Same genre, a different "free" hardware gift.
 *
 * Controls: JOYSTICK PORT 1 (or keyboard cursors) UP/DOWN moves the left
 *   paddle. In 2P versus, JOYSTICK PORT 2 UP/DOWN moves the right paddle. On
 *   the title screen trigger A (or SPACE) starts 1P vs CPU; trigger B starts
 *   2P versus. On the result screen any fire returns to the title.
 *
 * Record honesty: the bundled bluemsx core build exposes NO battery save path
 *   (retro_get_memory(SAVE_RAM) is unimplemented for MSX carts), so BEST (the
 *   longest 1P-vs-CPU win streak) lives in plain RAM: it survives title↔match
 *   cycles but NOT a power cycle / hardReset. Never fake persistence — if you
 *   need real saves, that's a future core round (ASCII8-SRAM mapper carts
 *   exist; the core just doesn't surface their RAM yet). The Genesis/NES/SMS
 *   versions of this game DO persist the same streak to cartridge SRAM.
 */
#include "msx_hw.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "SPARK SWAT"

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
 * Tile font: index 0 = space, 1-26 = A-Z, 27-36 = 0-9, 37 = dash, then the
 * court tiles. One 8x8 pattern = 8 bytes, one bit per pixel; set bits draw in
 * the tile's FOREGROUND color, clear bits in its BACKGROUND color (both come
 * from the screen-2 color table — see the per-row-color idiom below). */
#define T_SPACE  0
#define T_A      1           /* 'A'..'Z' = T_A + (c - 'A')                  */
#define T_0      27          /* '0'..'9' = T_0 + (c - '0')                  */
#define T_DASH   37
#define T_FLOOR  38          /* the court surface (faint speckle)               */
#define T_RAIL   39          /* solid top/bottom court rail                     */
#define T_NET    40          /* dashed centre net (its COLOR carries the pulse) */
#define NUM_TILES 41

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
    /* 38 FLOOR (sparse speckle so the arena reads as a court, not a void) */
               {0x00,0x00,0x10,0x00,0x00,0x00,0x01,0x00},
    /* 39 RAIL  (solid border)  */ {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF},
    /* 40 NET   (dashed bar — solid pixels so the COLOR pulse below shows) */
               {0x18,0x18,0x18,0x18,0x18,0x18,0x18,0x18},
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
 *      exploit exactly that to make a single FLOOR/RAIL/NET tile set read as a
 *      depth-shaded court: third 0 (the HUD band + top rail) gets its own
 *      bright text colors; the play thirds get a cooler court palette; the
 *      bottom third deepens toward the foreground. One tile set, three bands,
 *      zero extra tiles — the sports-genre twin of the shmup's depth starfield.
 *
 *   2. Within a tile, the color table holds EIGHT bytes — one per 8x1 pixel
 *      row — each packing (foreground<<4)|background from the fixed TMS9918
 *      palette. So one tile can carry an 8-color vertical gradient: T_NET's
 *      whole "energy pulse" running down the centre net is a single tile,
 *      colors only.
 *
 * Requires: the screen-2 table layout set by msx_set_screen2() (R3=0xFF,
 *   R4=0x03 — the "thirds" configuration), and pattern + color uploads to
 *   EVERY third a tile is used in. Tile N's slot is pattern[N*8] / color[N*8].
 *
 * TMS9918 fixed palette used here: 1 black, 4 dark blue, 5 light blue,
 * 6 dark red, 7 cyan, 8 medium red, 11 light yellow, 12 green, 13 light green,
 * 14 gray, 15 white (high nibble = fg, low nibble = bg of each row byte). */
static const uint8_t col_text[3]  = { 0xF4, 0xF1, 0xF1 }; /* HUD white-on-blue; play/title white-on-black */
/* The court FLOOR speckle, banded by third: cyan-ish near the HUD, deeper blue
 * mid-court, light-blue close — pure per-third recolor of one tile. */
static const uint8_t col_floor[3] = { 0x71, 0x41, 0x51 };
/* The court RAILS, banded so the top rail (third 0) reads bright and the
 * bottom rail (third 2) reads cooler — same solid tile, three colors. */
static const uint8_t col_rail[3]  = { 0xF1, 0xE1, 0xD1 };
/* T_NET: 8 DIFFERENT color bytes inside ONE tile = an 8-pixel-row "energy
 * pulse" down the net (black → dark blue → cyan → white and back). The net
 * pattern is a solid 2px bar so only the fg nibbles show. Drawn down the
 * centre column; recolored again per third for free. */
static const uint8_t col_net[8]   = { 0x11,0x41,0x71,0xF1,0xF1,0x71,0x41,0x11 };

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
            if (i == T_NET) {              /* the one per-pixel-row gradient   */
                msx_vram_write((uint16_t)(colbase + ((uint16_t)i << 3)), col_net, 8);
                continue;
            }
            if      (i == T_FLOOR) col = col_floor[third];
            else if (i == T_RAIL)  col = col_rail[third];
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

/* ── GAME LOGIC (clay — reshape freely) — court geometry + match rules ───────
 * The court fills the 32x24 screen-2 name table. Rails on name-table rows 2
 * and 22; COURT_TOP/BOT keep the ball between them (pixels). Net down column
 * 16. Row 0 is the HUD band (third 0's text colors make it a distinct strip). */
#define NET_COL    16
#define RAIL_TOP_ROW 2
#define RAIL_BOT_ROW 22
#define COURT_TOP  24            /* first pixel row below the top rail        */
#define COURT_BOT  176           /* first pixel row of the bottom rail        */
#define PADDLE_H   24            /* 3 stacked 8x8 sprites                      */
#define PADDLE_X1  16            /* P1 — left side                            */
#define PADDLE_X2  232           /* P2/CPU — right side                       */
#define BALL_W     8
#define BALL_H     8
#define WIN_SCORE  5             /* first to 5 takes the match                */
#define P_SPEED    3             /* px/frame — both humans move at this       */
#define CPU_SPEED  1             /* px/frame — HALF the ball's 2px/frame      *
                                  * horizontal speed: it cannot always reach  *
                                  * a steep edge return, so a human who aims   *
                                  * edge hits beats it (verified). Raise this  *
                                  * toward P_SPEED to make the CPU tougher.    */

static int16_t p1y, p2y;         /* paddle top Y (pixels)                     */
static int16_t bx, by;           /* ball top-left (pixels)                    */
static int8_t  bdx, bdy;         /* ball velocity (px/frame)                  */
static uint8_t score_p1, score_p2;
static uint8_t serve_timer;      /* freeze frames between points              */
static uint8_t two_player;       /* title pick: 0 = vs CPU, 1 = 2P versus     */
static uint8_t streak;           /* current 1P-vs-CPU win streak (RAM)        */
static uint16_t best_streak;     /* SESSION-ONLY record — see end_match + the
                                  * record-honesty note at the top of file.
                                  * No SAVE_RAM on this core, so it lives in
                                  * plain RAM: survives title↔match cycles,
                                  * NOT a power cycle (honest, not faked).    */
static uint8_t new_record;       /* result screen shows NEW RECORD            */

#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;
static uint8_t prev_t1, prev_t2; /* title/over trigger edge detection         */

/* ── GAME LOGIC (clay — reshape freely) — xorshift16 PRNG.
 * A versus game NEEDS this: the MSX is fully deterministic, so without a noise
 * source two fixed strategies lock into an infinite rally loop (the exact same
 * cycle, forever — a match that NEVER ends). next_rand() is ticked once per
 * play frame so identical game states a few seconds apart still diverge, and
 * every paddle return adds a ±1 "spin" — so an idle 1P-vs-CPU match always
 * reaches 5 in bounded time. */
static uint16_t rng;
static uint8_t next_rand(void) {
    rng ^= (uint16_t)(rng << 7);
    rng ^= (uint16_t)(rng >> 9);
    rng ^= (uint16_t)(rng << 8);
    return (uint8_t)(rng & 0xFF);
}

/* ── GAME LOGIC (clay — reshape freely) — music + SFX on the AY-3-8910 ──────
 * Channel plan: A = paddle/score blips, B = rail bonk + whistle noise, C =
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
    285, 0, 339, 285, 254, 0, 285, 339,   /* G4 E4 G4 A4 G4 E4  (bright march)    */
    427, 0, 339, 254, 339, 0,   0,   0,   /* C4 E4 A4 E4 rest                     */
    320, 0, 285, 254, 214, 0, 254, 285,   /* F4 G4 A4 C5 A4 G4                     */
    339, 0, 285, 339, 427, 0,   0,   0,   /* E4 G4 E4 C4 rest                     */
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

static void sfx_hit(void)   { msx_psg_tone(0, 0x200, 11); sfx_a_t = 4; }
static void sfx_rail(void)  { msx_psg_tone(1, 0x300, 9);  sfx_b_t = 3; }
static void sfx_point(void) { msx_psg_noise(1, 14, 13);   sfx_b_t = 8; }
static void sfx_over(void)  { msx_psg_noise(1, 28, 14);   sfx_b_t = 22; }
static void sfx_start(void) { msx_psg_tone(0, 0x130, 12); sfx_a_t = 6; }

/* ── GAME LOGIC (clay — reshape freely) — HUD ──────────────────────────────
 * Row 0 = the HUD band (third 0's text colors make it a distinct strip).
 * P1 score | BEST (longest streak) | P2/CPU score. */
static void draw_hud_labels(void) {
    draw_text(1, 0, "P1");
    draw_text(12, 0, "BEST");
    draw_text(25, 0, two_player ? "P2" : "CPU");
}
static void draw_scores(void) {
    put_tile(4, 0, (uint8_t)(T_0 + score_p1));
    put_tile(29, 0, (uint8_t)(T_0 + score_p2));
}
static void draw_best(void) { draw_num4(17, 0, best_streak); }

/* ── GAME LOGIC (clay — reshape freely) — paint the court (name table) ──────
 * The whole 32x24 name table: HUD band on row 0, rails on rows 2 and 22, net
 * down column 16, floor everywhere else. The per-third color idiom shades it
 * into bands for free — this routine writes only TILE INDICES. */
static void clear_field(void) { msx_fill_vram(VRAM_NAME, 32u * 24u, T_SPACE); }

static void paint_court(void) {
    uint8_t row, col, t;
    for (row = 0; row < 24; row++) {
        for (col = 0; col < 32; col++) {
            if (row == 0)                       t = T_SPACE;  /* HUD band      */
            else if (row == RAIL_TOP_ROW
                  || row == RAIL_BOT_ROW)       t = T_RAIL;
            else if (row > RAIL_TOP_ROW
                  && row < RAIL_BOT_ROW
                  && col == NET_COL)            t = T_NET;
            else if (row > RAIL_TOP_ROW
                  && row < RAIL_BOT_ROW)        t = T_FLOOR;
            else                                t = T_SPACE;
            put_tile(col, row, t);
        }
    }
    draw_hud_labels();
    draw_scores();
    draw_best();
}

/* ── GAME LOGIC (clay — reshape freely) — sprites: paddles + ball ───────────
 * 8x8 one-color hardware sprites. Plane layout: 0-2 = P1 paddle (3 stacked
 * cells), 3-5 = P2 paddle, 6 = ball. Locked court art is tiles, not sprites,
 * so the list never needs more than 7 planes. */
static const uint8_t spr_block[8] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};
static const uint8_t spr_ball[8]  = {0x3C,0x7E,0xFF,0xFF,0xFF,0xFF,0x7E,0x3C};
#define PAT_PADDLE 0
#define PAT_BALL   1
#define COL_P1   15   /* white       */
#define COL_P2   8    /* medium red  */
#define COL_BALL 11   /* light yellow — distinct from the white paddles */

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Sprite limits + the Y=208 terminator:
 *   - A sprite Y of 0xD0 (208) tells the TMS9918 to STOP SCANNING the
 *     attribute table — every higher-numbered plane vanishes, not just that
 *     one. (msx_clear_sprites parks ALL planes at 0xD0, which is fine at the
 *     END of the list.) To hide ONE sprite mid-list, park it OFFSCREEN at
 *     PARK_Y (192 = first line below the display) — never at 0xD0.
 *     (On MSX2's V9938 sprite mode 2 the terminator moves to 0xD8 and 0xD0
 *     is "just offscreen" — code that leans on that breaks on MSX1.)
 *   - Per scanline the TMS9918 draws only 4 sprites (V9938: 8). The two
 *     paddles sit at opposite screen edges and the ball rallies between them,
 *     so a single scanline never carries more than 2 of our 7 planes. */
#define PARK_Y 192

/* Push the two paddles + ball to their planes. Paddles freeze (but stay
 * visible) on the result screen; the ball parks offscreen there and on the
 * title. Never park at 0xD0 mid-list — see the idiom. */
static void push_sprites(void) {
    uint8_t i;
    uint8_t actors  = (state != ST_TITLE);   /* paddles show in play + result */
    uint8_t ball_on = (state == ST_PLAY);    /* ball only lives during a rally*/
    for (i = 0; i < PADDLE_H / 8; i++) {
        msx_set_sprite((uint8_t)(0 + i), PADDLE_X1,
                       actors ? (uint8_t)(p1y + i * 8) : PARK_Y, PAT_PADDLE, COL_P1);
        msx_set_sprite((uint8_t)(3 + i), PADDLE_X2,
                       actors ? (uint8_t)(p2y + i * 8) : PARK_Y, PAT_PADDLE, COL_P2);
    }
    msx_set_sprite(6, (uint8_t)bx, ball_on ? (uint8_t)by : PARK_Y, PAT_BALL, COL_BALL);
}

/* ── GAME LOGIC (clay — reshape freely) — serve: ball to centre, toward the
 * chosen side. The serve angle takes a PRNG bit (not a fixed alternation) —
 * one more place determinism is broken so idle matches can't settle. */
static void serve_ball(uint8_t to_left) {
    bx = 124;
    by = (COURT_TOP + COURT_BOT) / 2;
    bdx = to_left ? -2 : 2;
    bdy = (next_rand() & 1) ? -1 : 1;
    serve_timer = 30;                /* half-second breather */
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
    draw_text(7, 11, "1P VS CPU - FIRE A");
    draw_text(7, 13, "2P VERSUS - FIRE B");
    draw_text(11, 16, "FIRST TO 5");
    draw_text(11, 19, "BEST 0000");        /* the space blanks the cell between */
    draw_num4(16, 19, best_streak);
}

static void paint_over(void) {
    clear_field();
    if (score_p1 >= WIN_SCORE)
        draw_text(11, 7, two_player ? "P1 WINS" : "YOU WIN");
    else
        draw_text(11, 7, two_player ? "P2 WINS" : "CPU WINS");
    draw_text(13, 10, "P1"); put_tile(16, 10, (uint8_t)(T_0 + score_p1));
    put_tile(17, 10, T_DASH);
    put_tile(18, 10, (uint8_t)(T_0 + score_p2)); draw_text(20, 10, two_player ? "P2" : "CPU");
    if (new_record) draw_text(11, 13, "NEW RECORD");
    draw_text(11, 14, "BEST"); draw_num4(16, 14, best_streak);
    draw_text(8, 17, "FIRE FOR TITLE");
    prev_t1 = prev_t2 = 1;             /* swallow a fire still held from play  */
}

/* ── GAME LOGIC (clay — reshape freely) — start a match ── */
static void start_match(uint8_t versus) {
    two_player = versus;
    p1y = (COURT_TOP + COURT_BOT) / 2 - PADDLE_H / 2;
    p2y = p1y;
    score_p1 = 0;
    score_p2 = 0;
    new_record = 0;
    serve_ball(0);
    paint_court();
    sfx_start();
    state = ST_PLAY;
}

/* ── GAME LOGIC (clay — reshape freely) — match over: result + record.
 * Persistence choice: for a VERSUS sports game a raw hi-score is meaningless
 * (every match ends 5-x), so we track the longest 1P win streak against the
 * CPU — the stat a returning player actually chases. 2P matches never touch it
 * (humans beating each other isn't a record). On THIS core the record is
 * session-only RAM (no SAVE_RAM — see the file header); the Genesis/NES/SMS
 * builds of this game persist the identical streak to cartridge SRAM. ── */
static void end_match(void) {
    if (score_p1 >= WIN_SCORE && !two_player) {
        ++streak;
        if (streak > best_streak) { best_streak = streak; new_record = 1; }
    } else if (!two_player) {
        streak = 0;                    /* the streak dies with the loss */
    }
    sfx_over();
    paint_over();
    state = ST_OVER;
}

/* ── GAME LOGIC (clay — reshape freely) — one point scored ── */
static void score_point(uint8_t for_p1) {
    if (for_p1) ++score_p1; else ++score_p2;
    sfx_point();
    draw_scores();
    if (score_p1 >= WIN_SCORE || score_p2 >= WIN_SCORE) end_match();
    else serve_ball(for_p1);           /* winner of the point receives */
}

/* ── GAME LOGIC (clay — reshape freely) — paddle hit: deflect by where the
 * ball struck. Centre = flat-ish, edges = steep. Max |bdy| is 2 — the CPU
 * moves at 1 (half the ball's horizontal speed), so a steep edge return slips
 * past it: that is exactly how a human beats the CPU. A ±1 random "spin" on
 * every return keeps rallies from repeating (see the PRNG note above). */
static void deflect(int16_t paddle_y) {
    int16_t rel = (by + BALL_H / 2) - (paddle_y + PADDLE_H / 2);
    bdy = (int8_t)(rel >> 3);
    bdy += (int8_t)((next_rand() & 2) - 1);   /* spin: -1 or +1 */
    if (bdy > 2) bdy = 2;
    if (bdy < -2) bdy = -2;
    if (bdy == 0) bdy = (rel < 0) ? -1 : 1;   /* never return a flat ball */
    sfx_hit();
}

/* ── GAME LOGIC (clay — reshape freely) — per-player paddle input ───────────
 * P0 reads JOYSTICK PORT 1 (keyboard cursors fall back); P1 reads PORT 2. */
static void update_player(uint8_t p) {
    uint8_t dir;
    int16_t *py = (p == 0) ? &p1y : &p2y;
    if (p == 0) {
        dir = msx_read_joystick(1);
        if (dir == STICK_CENTER) dir = msx_read_joystick(0);
    } else {
        dir = msx_read_joystick(2);
    }
    if ((dir == STICK_UP || dir == STICK_UL || dir == STICK_UR)
        && *py > COURT_TOP)            *py -= P_SPEED;
    if ((dir == STICK_DOWN || dir == STICK_DL || dir == STICK_DR)
        && *py < COURT_BOT - PADDLE_H) *py += P_SPEED;
}

/* ── GAME LOGIC (clay — reshape freely) — CPU paddle: chase the ball centre at
 * CPU_SPEED, but ONLY while the ball is heading toward it (bdx > 0), and with a
 * generous DEAD ZONE. Beatable by design, three ways stacked:
 *   - it does not start tracking back until the ball turns toward it, so a
 *     steep return aimed at the far rail clears the paddle before it reacts;
 *   - CPU_SPEED (1) is half the ball's horizontal speed (2), so on a steep
 *     return it simply can't cover the vertical distance in time;
 *   - the ±CPU_DEAD dead zone leaves a gap at the paddle edges.
 * Raise CPU_SPEED toward P_SPEED, shrink CPU_DEAD, or drop the bdx>0 gate to
 * make the CPU tougher. ── */
#define CPU_DEAD 6
static void update_cpu(void) {
    int16_t target;
    if (bdx <= 0) return;            /* ball moving away — CPU rests          */
    target = by + BALL_H / 2 - PADDLE_H / 2;
    if (p2y + CPU_DEAD < target && p2y < COURT_BOT - PADDLE_H) p2y += CPU_SPEED;
    else if (p2y > target + CPU_DEAD && p2y > COURT_TOP)       p2y -= CPU_SPEED;
}

void main(void) {
    uint8_t t1, t2;

    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * Init order: set the video mode FIRST (INIGRP also clears VRAM — any
     * upload done before it is wiped), then tiles, then sprites. The crt0's
     * INIT contract means main() must NEVER return — the BIOS has nothing
     * sane to fall back to — hence the for(;;) below. */
    msx_set_screen2();
    msx_clear_sprites();
    load_tiles();
    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_PADDLE * 8), spr_block, 8);
    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_BALL   * 8), spr_ball,  8);

    msx_music(0);            /* the lib's demo loop also owns channel C —
                             * hand the channel to OUR tune table instead    */
    best_streak = 0;         /* session record (no SAVE_RAM on this core)    */
    streak = 0;
    rng = 0xACE1;
    music_step = music_timer = 0;
    sfx_a_t = sfx_b_t = 0;
    prev_t1 = prev_t2 = 1;   /* swallow a held trigger across state changes  */
    two_player = 0;
    bx = 124; by = (COURT_TOP + COURT_BOT) / 2;
    state = ST_TITLE;
    paint_title();

    for (;;) {
        vsync();
        music_tick();
        sfx_tick();

        if (state == ST_TITLE) {
            /* ── GAME LOGIC (clay) — title: trig A = 1P vs CPU; trig B = 2P. */
            t1 = (uint8_t)(gttrig(1) || gttrig(0));
            t2 = (uint8_t)(gttrig(3) || gttrig(2));
            if (t2 && !prev_t2)      start_match(1);
            else if (t1 && !prev_t1) start_match(0);
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
         * Both players (or P1 + CPU) update EVERY frame — a simultaneous
         * versus match, not alternating turns. */
        next_rand();                 /* tick the noise source every play frame */

        update_player(0);
        if (two_player) update_player(1);
        else            update_cpu();

        /* Ball update (frozen during the post-point serve pause). */
        if (serve_timer > 0) {
            --serve_timer;
            push_sprites();
            continue;
        }
        bx = (int16_t)(bx + bdx);
        by = (int16_t)(by + bdy);

        /* Rail bounce. */
        if (by < COURT_TOP)          { by = COURT_TOP;              bdy = (int8_t)(-bdy); sfx_rail(); }
        if (by + BALL_H > COURT_BOT) { by = COURT_BOT - BALL_H;     bdy = (int8_t)(-bdy); sfx_rail(); }

        /* Paddle collisions (direction-gated so the ball can't double-hit). */
        if (bdx < 0
            && bx <= PADDLE_X1 + 8 && bx + BALL_W >= PADDLE_X1
            && by + BALL_H > p1y && by < p1y + PADDLE_H) {
            bdx = (int8_t)(-bdx);
            bx = PADDLE_X1 + 8;
            deflect(p1y);
        }
        if (bdx > 0
            && bx + BALL_W >= PADDLE_X2 && bx <= PADDLE_X2 + 8
            && by + BALL_H > p2y && by < p2y + PADDLE_H) {
            bdx = (int8_t)(-bdx);
            bx = (int16_t)(PADDLE_X2 - BALL_W);
            deflect(p2y);
        }

        /* Off either side → point. */
        if (bx < 4)   score_point(0);   /* past P1 → right side (P2/CPU) scores */
        if (bx > 252) score_point(1);   /* past P2/CPU → P1 scores              */

        push_sprites();
    }
}
