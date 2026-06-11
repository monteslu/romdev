/* ── sports.c — Game Boy Advance versus court game (complete game) ────────────
 *
 * RALLY ROVER — a COMPLETE, working game: press-start title, 1P vs a beatable
 * CPU on a netted court (Pong lineage), first-to-5 match flow with a result
 * screen, a PRNG rally "spin" so an idle match provably ENDS, music + SFX, and
 * a persistent RECORD in cartridge SRAM (longest win streak vs the CPU). The
 * court and sprites are VIVID — the GBA's 15-bit palette gives 32768 colours,
 * so the two paddles read as a blue team and a red team over a green court
 * with a bright dashed net, not flat blocks on black.
 *
 * The game: your paddle (left, blue) moves UP/DOWN; the CPU paddle (right, red)
 * chases the ball at half your top speed, so a steep edge-deflection outruns
 * it — that's exactly how you beat it. Win a point when the ball passes the
 * far paddle; first to 5 takes the match. Win without losing and your streak
 * grows; the longest streak persists across power cycles.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented GBA footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — court art, ball physics, CPU skill, scoring: reshape
 *     freely.
 *
 * What depends on what:
 *   gba_sfx.{h,c} — PSG sound: sfx_tone/sfx_noise one-shots + the music loop
 *     (sfx_music_tick once per frame — forget it and the game is silent).
 *   libtonc (the build links it) — VBlankIntrWait/key_poll/TTE/tonccpy.
 *
 * HANDHELD, SO SINGLE-PLAYER ONLY (honest note): 2P versus on the GBA means a
 * link cable between two units — a second emulator instance this environment
 * can't provide. So RALLY ROVER is 1P vs a beatable CPU, not split-screen
 * versus. (Contrast the NES/Genesis sports templates, which ARE 2P versus —
 * two controllers on one machine — AND a 1P-vs-CPU mode.)
 *
 * WHY THE PRNG MATTERS (a teaching point shared with the NES sports template):
 * the GBA is fully deterministic. Without a noise source, the CPU's fixed
 * ball-chase and the fixed wall/paddle bounces lock into an identical rally
 * cycle that NEVER ends — the ball orbits the court forever and no point is
 * ever scored. random8() adds a ±1 "spin" to every paddle return, so rallies
 * always drift, break symmetry, and an idle match reaches 5-0 on its own.
 */

#include <tonc.h>
#include "gba_sfx.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "RALLY ROVER"

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Court geometry + match rules. The court interior is bounded top/bottom by
 * rail tiles; paddles and the ball stay between COURT_TOP and COURT_BOT (pixel
 * rows). Paddles are 24 px tall (3 stacked 8x8 sprites), 8 px wide. */
#define COURT_TOP   16           /* first pixel row below the top rail        */
#define COURT_BOT   144          /* first pixel row of the bottom rail        */
#define PADDLE_H    24           /* 3 stacked 8x8 sprites                      */
#define PADDLE_X1   16           /* P1 — left side (you)                      */
#define PADDLE_X2   216          /* CPU — right side                         */
#define BALL_SIZE   8
#define COURT_W     240
#define WIN_SCORE   5            /* first to 5 takes the match                */
#define P1_PAL      0            /* OBJ palbank 0 = blue (you)                */
#define CPU_PAL     1            /* OBJ palbank 1 = red (CPU)                 */
#define BALL_PAL    2            /* OBJ palbank 2 = white ball                */

/* Sprite slot discipline (128 OAM entries; we use 8):
 *   0..2 → P1 paddle (3 stacked 8x8)
 *   3..5 → CPU paddle
 *   6    → ball                                                            */
#define SLOT_P1   0
#define SLOT_CPU  3
#define SLOT_BALL 6

#define TILE_PADDLE 1            /* OBJ tile 1 = solid paddle block (4bpp 8x8) */
#define TILE_BALL   2            /* OBJ tile 2 = round ball (4bpp 8x8)        */

/* 4bpp sprite tiles (8 rows × 32 bits; each nibble is a palette index within
 * the sprite's palbank. Index 0 = transparent). The paddle is a solid colour-1
 * block; its TEAM colour comes from the OBJ PALBANK at draw time (bank 0 = blue,
 * bank 1 = red), so ONE tile serves both paddles. */
static const u32 tile_paddle[8] = {
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
};
/* The ball: a round white pip with a soft glint (idx 2 highlight, idx 1 body). */
static const u32 tile_ball[8] = {
    0x00111100, 0x01122110, 0x11222111, 0x11221111,
    0x11111111, 0x11111111, 0x01111110, 0x00111100,
};

/* ── GAME LOGIC (clay) — BG court tiles (regular Mode-0 4bpp BG tiles).
 * Each 8x8 4bpp tile is 8 u32 rows; each nibble is a palette index within the
 * BG palbank we use (bank 0). Index 0 = transparent → shows the backdrop. */
#define BG_FLOOR 1   /* court surface (two-green dither so it isn't flat)    */
#define BG_RAIL  2   /* top/bottom court rails                              */
#define BG_NET   3   /* dashed centre net                                  */
#define BG_PIP   4   /* score pip (a lit cell — see the score-pip idiom)    */

static const u32 bg_tile_floor[8] = {   /* two-green checker, no flat colour  */
    0x11221122, 0x11221122, 0x22112211, 0x22112211,
    0x11221122, 0x11221122, 0x22112211, 0x22112211,
};
static const u32 bg_tile_rail[8] = {    /* solid bright rail                  */
    0x33333333, 0x33333333, 0x33333333, 0x33333333,
    0x33333333, 0x33333333, 0x33333333, 0x33333333,
};
static const u32 bg_tile_net[8] = {     /* dashed vertical net segment        */
    0x00033000, 0x00033000, 0x00000000, 0x00033000,
    0x00033000, 0x00000000, 0x00033000, 0x00033000,
};
static const u32 bg_tile_pip[8] = {     /* a lit score pip (filled diamond)   */
    0x00044000, 0x00444400, 0x04444440, 0x44444444,
    0x44444444, 0x04444440, 0x00444400, 0x00044000,
};

/* ── GAME LOGIC (clay — reshape freely) — game state (plain BSS; the GBA has
 * 256 KB of EWRAM + 32 KB of IWRAM).
 * NOTE for headless verification: unlike the Genesis template (whose work-RAM
 * globals are readable by symbol name), the GBA libretro core exposes NO
 * IWRAM/EWRAM region, so a headless agent reads game state from what's ON
 * HARDWARE — OAM (the paddles + ball), the BG0 tilemap (the court + the SCORE
 * PIPS, see the score-pip idiom), and save_ram (the record). Keep game globals
 * static and surface anything the harness must read onto hardware. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static u8 state;

static s16 p1y, cpuy;            /* paddle top Y (pixels)                     */
static s16 bx, by;              /* ball top-left position                    */
static s16 bdx, bdy;            /* ball velocity (px/frame)                  */
static u8  score_p1, score_cpu; /* 0..WIN_SCORE                              */
static u8  serve_timer;         /* freeze frames between points              */
static u8  streak;              /* current win streak vs CPU (RAM)           */
static u16 record;              /* battery-backed best streak — see SRAM idiom*/
static u8  new_record;          /* result screen shows NEW RECORD            */
static u8  win_who;             /* 1 = you took the match, 0 = CPU did       */

/* ── GAME LOGIC (clay) — xorshift16 PRNG (a handful of ARM instructions).
 * THE LOAD-BEARING DETAIL of a deterministic versus game: see the file header.
 * Ticked once per play frame so two identical board states a few frames apart
 * still diverge, and added as ±1 spin to every paddle return so rallies END. */
static u16 rng = 0xC0A7;
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
 * Layout: 'V' 'X' record-lo record-hi checksum (xor ^ 0xA5) — magic+checksum
 * so a fresh (0xFF-filled) cart reads as "no record" instead of garbage.
 * PERSISTENCE CHOICE: a raw hi-score is meaningless for a versus game (every
 * match ends 5-x), so we persist the LONGEST WIN STREAK vs the CPU — the stat
 * a returning player actually chases.
 * requires: nothing else — self-contained; safe to transplant whole. */
#define SRAM_BYTE ((volatile u8 *)0x0E000000)
__attribute__((used, aligned(4))) static const char sram_type_marker[] = "SRAM_V113";

static u16 record_load(void) {
    u8 lo, hi;
    if (SRAM_BYTE[0] != 'V' || SRAM_BYTE[1] != 'X') return 0;
    lo = SRAM_BYTE[2];
    hi = SRAM_BYTE[3];
    if (SRAM_BYTE[4] != (u8)(lo ^ hi ^ 0xA5)) return 0;
    return (u16)(lo | (hi << 8));
}

static void record_save(u16 v) {
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
 * THE COURT IS BACKGROUND TILES on BG0 (Mode 0, a REGULAR text BG). A 32x32
 * map (BG_REG_32x32) is one screenblock; each map entry is a u16: tile id
 * (10 bits) + hflip/vflip + a 4-bit palbank. SE_BUILD(tile, palbank, hf, vf)
 * packs it. Footguns this dodges:
 *   - VRAM IGNORES BYTE WRITES (a u8 store duplicates the byte into both
 *     halves of the 16-bit lane). We only ever write whole u16 SE entries
 *     (via set_cell) and tonccpy() tile data — both VRAM-safe.
 *   - TTE owns BG1 (CBB 2 / SBB 30). Keep this map (SBB 28) and our tile
 *     graphics (CBB 0) clear of those blocks or text and court corrupt each
 *     other.
 * requires: REG_BG0CNT → CBB 0 / SBB 28 (set in main), DCNT_BG0 enabled. */
static SCR_ENTRY *const court_map = se_mem[28];
static void set_cell(int tx, int ty, u16 tile) {
    court_map[ty * 32 + tx] = SE_BUILD(tile, 0, 0, 0);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * SCORE PIPS — the headless-readable score. GBA C globals are NOT host-readable
 * (the libretro core exposes no IWRAM/EWRAM region), so a verify harness can't
 * read score_p1/score_cpu by symbol. To keep the score machine-checkable WITHOUT
 * a symbol map, each point is ALSO surfaced onto hardware as a BG "pip" tile in
 * a fixed HUD row: P1's pips grow left-to-right from tx=4, the CPU's grow
 * right-to-left from tx=27. A harness counts BG_PIP tiles (id 4) in row 0 of
 * screenblock 28 to read the exact score — no globals needed. This is the same
 * "decode state from what's on hardware, not from a symbol" discipline the GBA
 * puzzle/platformer templates use for the board and the falling piece.
 * requires: court_map (BG0 SBB 28), BG_PIP tile uploaded, called on every
 *   score change and on court paint. */
#define PIP_ROW   0              /* HUD tile row holding the score pips        */
#define PIP_P1_TX 4              /* P1 pips grow rightward from here           */
#define PIP_CPU_TX 27            /* CPU pips grow leftward from here           */
static void paint_pips(void) {
    int i;
    for (i = 0; i < WIN_SCORE; i++) {
        set_cell(PIP_P1_TX + i,  PIP_ROW, (i < score_p1)  ? BG_PIP : BG_FLOOR);
        set_cell(PIP_CPU_TX - i, PIP_ROW, (i < score_cpu) ? BG_PIP : BG_FLOOR);
    }
}

/* Paint the static court: floor everywhere, a HUD band on rows 0-1, top/bottom
 * rails, and the centre net. Done once per match start; the pips + sprites then
 * update over it. The HUD band (rows 0-1) is FLOOR tiles so the score pips and
 * TTE labels read clearly above the play area. */
static void paint_court(void) {
    int r, c;
    for (r = 0; r < 32; r++)
        for (c = 0; c < 32; c++) {
            u16 t = BG_FLOOR;
            if (r == 2 || r == 18) t = BG_RAIL;          /* court rails       */
            else if (r > 2 && r < 18 && c == 15) t = BG_NET;
            set_cell(c, r, t);
        }
    paint_pips();
}

/* ── GAME LOGIC (clay) — serve: ball to centre, toward the chosen side ── */
static void serve_ball(u8 to_left) {
    bx = COURT_W / 2 - BALL_SIZE / 2;
    by = (COURT_TOP + COURT_BOT) / 2 - BALL_SIZE / 2;
    bdx = to_left ? -2 : 2;
    bdy = ((score_p1 + score_cpu) & 1) ? -1 : 1;   /* alternate the angle */
    serve_timer = 30;                              /* half-second breather */
}

/* ── GAME LOGIC (clay) — HUD / screens (TTE on BG1, priority 0) ── */
static void draw_hud_labels(void) {
    tte_erase_screen();
    tte_write("#{P:8,1}YOU");
    tte_write("#{P:200,1}CPU");
}

static void enter_title(void) {
    state = ST_TITLE;
    paint_court();
    tte_erase_screen();
    tte_write("#{P:64,40}" GAME_TITLE);
    tte_write("#{P:76,72}PRESS START");
    tte_write("#{P:80,92}RECORD");
    draw_num(132, 92, record, 3);
    tte_write("#{P:24,116}UP DOWN MOVE - 1P VS CPU");
    tte_write("#{P:36,128}NO LINK CABLE 2P");
}

static void enter_play(void) {
    state = ST_PLAY;
    p1y = (COURT_TOP + COURT_BOT) / 2 - PADDLE_H / 2;
    cpuy = p1y;
    score_p1 = 0; score_cpu = 0;
    new_record = 0;
    /* Stir the PRNG with time-on-title so each run differs. */
    rng ^= (u16)REG_VCOUNT ^ ((u16)REG_VCOUNT << 7);
    if (rng == 0) rng = 0xC0A7;
    paint_court();
    draw_hud_labels();
    serve_ball(0);
}

static void enter_over(void) {
    state = ST_OVER;
    if (win_who) {                       /* you took the match                */
        ++streak;
        if (streak > record) {
            record = streak;
            new_record = 1;
            record_save(record);         /* byte-wise SRAM write — see idiom   */
        }
        tte_write("#{P:84,56}YOU WIN");
    } else {                             /* CPU took the match                */
        streak = 0;                      /* the streak dies with the loss     */
        tte_write("#{P:84,56}CPU WINS");
    }
    if (new_record) tte_write("#{P:72,72}NEW RECORD");
    tte_write("#{P:76,92}PRESS START");
    /* End-of-match whistle: two quick tones (won = rising, lost = falling). */
    sfx_tone(1, win_who ? 1500 : 1100, 10);
    sfx_tone(2, win_who ? 1750 :  900, 12);
}

/* ── GAME LOGIC (clay) — one point scored ── */
static void score_point(u8 for_p1) {
    if (for_p1) ++score_p1; else ++score_cpu;
    sfx_noise(8);
    paint_pips();                        /* surface the new score on hardware  */
    if (score_p1 >= WIN_SCORE)  { win_who = 1; enter_over(); return; }
    if (score_cpu >= WIN_SCORE) { win_who = 0; enter_over(); return; }
    serve_ball(for_p1);                  /* loser of the point serves outward  */
}

/* ── GAME LOGIC (clay) — paddle hit: deflect by where the ball struck.
 * Centre = flat-ish, edges = steep. Max |bdy| is 2; the CPU moves at 1, so an
 * edge hit is exactly how a human beats it. A ±1 random "spin" on every return
 * keeps rallies from repeating and guarantees an idle match ENDS (see header). */
static void deflect(s16 paddle_y) {
    s16 rel = (by + BALL_SIZE / 2) - (paddle_y + PADDLE_H / 2);
    bdy = (s16)(rel >> 3);
    bdy += (s16)((random8() & 2) - 1);   /* spin: -1 or +1 */
    if (bdy > 2) bdy = 2;
    if (bdy < -2) bdy = -2;
    if (bdy == 0) bdy = (rel < 0) ? -1 : 1;   /* never return a flat ball */
    sfx_tone(1, 1500, 3);
}

/* ── GAME LOGIC (clay) — one ST_PLAY tick. Edge cases handled: the ball is
 * frozen during the post-point serve pause; the CPU moves at half the player's
 * top speed with a dead zone so it's beatable; collisions are direction-gated
 * so the ball can't double-hit a paddle. May end the match (point → first-to-5).
 */
static void update_play(void) {
    s16 target;

    random8();                           /* tick the noise source every frame  */

    /* You — UP/DOWN, 3 px/frame (key_held = continuous hold). */
    if (key_held(KEY_UP)   && p1y > COURT_TOP)            p1y -= 3;
    if (key_held(KEY_DOWN) && p1y < COURT_BOT - PADDLE_H) p1y += 3;

    /* CPU — chases the ball centre at 1 px/frame (a third of your speed) with a
     * small dead zone. Beatable by design: steep deflections outrun it. */
    target = by + BALL_SIZE / 2 - PADDLE_H / 2;
    if (cpuy + 2 < target && cpuy < COURT_BOT - PADDLE_H) cpuy += 1;
    else if (cpuy > target + 2 && cpuy > COURT_TOP)       cpuy -= 1;

    /* Ball update (frozen during the post-point serve pause). */
    if (serve_timer > 0) { --serve_timer; return; }
    bx += bdx;
    by += bdy;

    /* Rail bounce. */
    if (by < COURT_TOP)                  { by = COURT_TOP;              bdy = -bdy; sfx_tone(2, 1100, 2); }
    if (by + BALL_SIZE > COURT_BOT)      { by = COURT_BOT - BALL_SIZE;  bdy = -bdy; sfx_tone(2, 1100, 2); }

    /* Paddle collisions (direction-gated so the ball can't double-hit). */
    if (bdx < 0
        && bx <= PADDLE_X1 + 8 && bx + BALL_SIZE >= PADDLE_X1
        && by + BALL_SIZE > p1y && by < p1y + PADDLE_H) {
        bdx = -bdx;
        bx = PADDLE_X1 + 8;
        deflect(p1y);
    }
    if (bdx > 0
        && bx + BALL_SIZE >= PADDLE_X2 && bx <= PADDLE_X2 + 8
        && by + BALL_SIZE > cpuy && by < cpuy + PADDLE_H) {
        bdx = -bdx;
        bx = PADDLE_X2 - BALL_SIZE;
        deflect(cpuy);
    }

    /* Off either side → point (loser serves outward). */
    if (bx + BALL_SIZE < 4)   score_point(0);   /* past you → CPU scores       */
    if (bx > COURT_W - 4)     score_point(1);   /* past CPU → you score        */
}

/* ── GAME LOGIC (clay) — stage the sprites: 3+3 paddle tiles + the ball.
 * Off-screen / inactive slots park at y=200. The paddles carry their TEAM
 * colour via the OBJ PALBANK (bank 0 = blue you, bank 1 = red CPU) — one tile,
 * two coloured paddles. ── */
static OBJ_ATTR obj_buffer[128];
static void stage_sprites(void) {
    int i;
    int playing = (state == ST_PLAY || state == ST_OVER);
    for (i = 0; i < PADDLE_H / 8; i++) {
        obj_set_attr(&obj_buffer[SLOT_P1 + i], ATTR0_SQUARE, ATTR1_SIZE_8,
                     (u16)(ATTR2_PALBANK(P1_PAL) | TILE_PADDLE));
        obj_set_pos(&obj_buffer[SLOT_P1 + i], playing ? PADDLE_X1 : 250, playing ? (p1y + i * 8) : 200);
        obj_set_attr(&obj_buffer[SLOT_CPU + i], ATTR0_SQUARE, ATTR1_SIZE_8,
                     (u16)(ATTR2_PALBANK(CPU_PAL) | TILE_PADDLE));
        obj_set_pos(&obj_buffer[SLOT_CPU + i], playing ? PADDLE_X2 : 250, playing ? (cpuy + i * 8) : 200);
    }
    obj_set_attr(&obj_buffer[SLOT_BALL], ATTR0_SQUARE, ATTR1_SIZE_8,
                 (u16)(ATTR2_PALBANK(BALL_PAL) | TILE_BALL));
    /* The ball hides on the title and during the result freeze. */
    obj_set_pos(&obj_buffer[SLOT_BALL], (state == ST_PLAY) ? bx : 250, (state == ST_PLAY) ? by : 200);
}

int main(void) {
    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * Init order: tiles/palettes → oam_init → irq_init + II_VBLANK → TTE init
     * → DISPCNT last. VBlankIntrWait() HANGS FOREVER without the vblank IRQ
     * registered (the #1 "frozen on frame 1" cause), and enabling DISPCNT
     * layers before their tiles/maps exist flashes garbage. TTE owns BG1
     * (CBB 2 / SBB 30) — keep other layers off those blocks.
     * requires: nothing prior; this IS the boot. */

    /* BG palette (bank 0). Vivid court: two greens for the floor dither, a
     * bright rail, a white net, a hot-gold score pip. The GBA's 15-bit RGB
     * gives saturated colours the GB/NES can only hint at. */
    pal_bg_mem[0] = RGB15(1, 4, 2);      /* backdrop / transparent base       */
    pal_bg_mem[1] = RGB15(4, 18, 6);     /* court green (light)               */
    pal_bg_mem[2] = RGB15(2, 11, 4);     /* court green (dark)                */
    pal_bg_mem[3] = RGB15(28, 30, 31);   /* rail + net (near-white)           */
    pal_bg_mem[4] = RGB15(31, 26, 6);    /* score pip (hot gold)              */

    /* BG tile graphics → char-block 0 (TTE uses CBB 2 — kept clear). */
    tonccpy(&tile_mem[0][BG_FLOOR], bg_tile_floor, sizeof(bg_tile_floor));
    tonccpy(&tile_mem[0][BG_RAIL],  bg_tile_rail,  sizeof(bg_tile_rail));
    tonccpy(&tile_mem[0][BG_NET],   bg_tile_net,   sizeof(bg_tile_net));
    tonccpy(&tile_mem[0][BG_PIP],   bg_tile_pip,   sizeof(bg_tile_pip));

    /* Sprite tiles → OBJ char base (tile_mem[4]). */
    tonccpy(&tile_mem[4][TILE_PADDLE], tile_paddle, sizeof(tile_paddle));
    tonccpy(&tile_mem[4][TILE_BALL],   tile_ball,   sizeof(tile_ball));

    /* OBJ palettes: bank 0 = blue (you), bank 1 = red (CPU), bank 2 = white
     * ball with a pale-blue glint. One paddle tile, two team colours. */
    pal_obj_bank[P1_PAL][1]  = RGB15(8, 14, 31);    /* your paddle blue        */
    pal_obj_bank[CPU_PAL][1] = RGB15(31, 8, 8);     /* CPU paddle red          */
    pal_obj_bank[BALL_PAL][1] = RGB15(30, 30, 31);  /* ball body white         */
    pal_obj_bank[BALL_PAL][2] = RGB15(20, 26, 31);  /* ball glint pale-blue    */

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

    record = record_load();            /* cartridge SRAM — 0 on first boot     */
    streak = 0;
    enter_title();

    while (1) {
        /* Idiomatic Tonc heartbeat: wait vblank, poll keys, update, then commit
         * OAM while still inside vblank (the update is far quicker than the
         * 4.9ms vblank window). */
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
