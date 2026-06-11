/* ── racing.c — Game Boy Advance top-down road racer (complete game) ──────────
 *
 * VERGE PILOT — a COMPLETE, working game: press-start title, a 1P endless
 * top-down road race, music + SFX, vivid 15-bit colour, and a persistent BEST
 * DISTANCE in cartridge SRAM. The GBA signature on show is the console's
 * "Mode-7" trick: the ROAD is an AFFINE BACKGROUND (BG2, Mode 1) that the PPU
 * rotates and scales per frame for free — so the road SCROLLS toward you
 * (recedes), SCALES with your speed (faster = the road rushes up bigger), and
 * BANKS as you steer (the whole strip tilts into the turn). That receding,
 * banking affine road is the natural GBA racer showcase — the handheld cousin
 * of the SNES Mode-7 racer, done with GBA affine BG hardware.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented GBA footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — road art, traffic, speeds, tuning: reshape freely.
 *
 * What depends on what:
 *   gba_sfx.{h,c} — PSG sound: sfx_tone/sfx_noise one-shots + the music loop
 *     (sfx_music_tick once per frame — forget it and the game is silent).
 *   libtonc (the build links it) — VBlankIntrWait/key_poll/TTE/lu_sin/lu_cos/
 *     tonccpy and the affine-BG matrix registers (REG_BG2PA..PD, BG2X/Y).
 *
 * HANDHELD, SO SINGLE-PLAYER ONLY (honest note): 2P versus on the GBA means a
 * link cable between two units — a second emulator instance this environment
 * can't provide. So VERGE PILOT is a 1P ENDLESS racer chasing your own best
 * distance, not split-screen versus. (Contrast the NES/Genesis racing
 * templates, which ARE 2P versus — two controllers on one machine.)
 *
 * THE AFFINE CHOICE (read before reshaping): a FULL per-scanline perspective
 * floor (a true Mode-7 "ground plane" where each screen row samples the road
 * at a different scale) needs an HBlank-IRQ table that rewrites the matrix 160
 * times a frame — powerful but heavy, and a distraction in a starter. VERGE
 * PILOT takes the HONEST, lighter showcase: ONE affine matrix per frame that
 * (1) scrolls the road texture downward (it recedes toward the horizon as you
 * drive), (2) scales it with your speed, and (3) rotates/banks it as you
 * steer. The matrix is provably non-identity and the scale+bank are visible on
 * screen — the affine hardware is genuinely doing the work. Want the full
 * floor later? Drive road_apply() from an HBlank handler with a per-row scale.
 */

#include <tonc.h>
#include "gba_sfx.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "VERGE PILOT"

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Road / car geometry + race tuning. The road is an affine BG2 strip; the
 * player car and traffic are sprites that live in SCREEN space over it. */
#define SCREEN_W   240
#define SCREEN_H   160
#define ROAD_X0     56          /* left edge of the asphalt (screen px)      */
#define ROAD_X1    184          /* right edge of the asphalt                 */
#define CAR_Y      128          /* player car's fixed screen Y (near bottom) */
#define CAR_SLOTS    5          /* discrete lanes the car steers between     */
#define MAX_TRAFFIC  4          /* obstacle cars on the road at once         */
#define SPEED_MIN    1          /* road px/frame                             */
#define SPEED_MAX    6
#define START_SPEED  2

/* Sprite slot discipline (128 OAM entries; we use 5):
 *   0       → player car
 *   1..4    → traffic                                                       */
#define SLOT_CAR     0
#define SLOT_TRAFFIC 1

#define TILE_CAR     1          /* OBJ tile 1 = player car (4bpp 8x8)        */
#define TILE_RIVAL   2          /* OBJ tile 2 = oncoming/rival car           */

/* 4bpp sprite tiles (8 rows × 32 bits; each nibble is a palette index within
 * the sprite's palbank. Index 0 = transparent). */
static const u32 tile_car[8] = {       /* your car, nose up, bright cockpit  */
    0x00133100, 0x01333310, 0x13322331, 0x13333331,
    0x13333331, 0x13311331, 0x13000031, 0x01000010,
};
static const u32 tile_rival[8] = {     /* traffic, tail up (you overtake it) */
    0x01000010, 0x13000031, 0x13311331, 0x13333331,
    0x13333331, 0x13322331, 0x01333310, 0x00133100,
};

/* ── GAME LOGIC (clay — reshape freely) — game state (plain BSS).
 * NOTE for headless verification: unlike the Genesis template (whose work-RAM
 * globals are readable by symbol name), the GBA libretro core exposes NO
 * IWRAM/EWRAM region, so a headless agent reads game state from what's ON
 * HARDWARE — OAM (the cars), the BG2 affine matrix registers (the road), TTE
 * ink pixels (the screen/HUD), and save_ram (the record). Keep game globals
 * static and surface anything the harness must read onto hardware. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static u8 state;

static s16 car_slot;            /* 0..CAR_SLOTS-1, the player's lane          */
static s16 car_x;               /* eased screen-x of the car (smooth steer)   */
static u8  speed;               /* road px/frame, SPEED_MIN..SPEED_MAX        */
static u8  lives;               /* crashes left                               */
static u8  invuln;              /* post-crash blink / no-collide frames       */
static u16 dist;                /* distance travelled (the score)             */
static u16 dist_sub;            /* subcounter: 16 scrolled px = +1 distance   */
static u16 best;                /* battery-backed best distance — SRAM idiom  */
static u8  new_best;            /* result screen shows NEW BEST               */
static u16 road_scroll;         /* BG2 texture Y offset (drives the recede)   */
static s16 bank;                /* current road bank angle bias (steer lean)  */

/* Traffic pool — fixed slots, no allocation. Each car has a lane + a SCREEN y
 * that grows downward (it approaches from the top of the road and slides past
 * the player), and an `alive` flag. */
static u8  tr_alive[MAX_TRAFFIC];
static u8  tr_slot[MAX_TRAFFIC];
static s16 tr_y[MAX_TRAFFIC];
static u8  spawn_timer;

#define START_LIVES 3

/* ── GAME LOGIC (clay) — xorshift16 PRNG. The GBA is deterministic; without a
 * noise source the traffic would spawn in a fixed lockstep pattern that an
 * idle run could memorise. The PRNG scatters spawn lanes/timing so each run is
 * fresh. ── */
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
 * Layout: 'V' 'X' best-lo best-hi checksum (xor ^ 0xA5) — magic+checksum so a
 * fresh (0xFF-filled) cart reads as "no record" instead of garbage.
 * PERSISTENCE CHOICE: an endless racer's natural chase-stat is the longest
 * DISTANCE survived — exactly what a returning player tries to beat.
 * requires: nothing else — self-contained; safe to transplant whole. */
#define SRAM_BYTE ((volatile u8 *)0x0E000000)
__attribute__((used, aligned(4))) static const char sram_type_marker[] = "SRAM_V113";

static u16 best_load(void) {
    u8 lo, hi;
    if (SRAM_BYTE[0] != 'V' || SRAM_BYTE[1] != 'X') return 0;
    lo = SRAM_BYTE[2];
    hi = SRAM_BYTE[3];
    if (SRAM_BYTE[4] != (u8)(lo ^ hi ^ 0xA5)) return 0;
    return (u16)(lo | (hi << 8));
}

static void best_save(u16 v) {
    SRAM_BYTE[0] = 'V';
    SRAM_BYTE[1] = 'X';
    SRAM_BYTE[2] = (u8)v;
    SRAM_BYTE[3] = (u8)(v >> 8);
    SRAM_BYTE[4] = (u8)((u8)v ^ (u8)(v >> 8) ^ 0xA5);
}

/* ── GAME LOGIC (clay) — TTE text helpers ────────────────────────────────────
 * Draw right-aligned decimal digits at pixel (x,y) WITHOUT tte_printf. The
 * bundled libtonc's tte_printf with a %d conversion is broken (it routes
 * through a vsnprintf path that isn't wired in this build — it garbles output
 * AND wedges the loop when called per-frame, GBA-1). We build the string
 * ourselves and use tte_write, which processes the #{P:x,y} position command
 * but does NO format conversion → safe every frame. */
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
 * AFFINE ROAD (BG2, Mode 1) — the GBA's "Mode 7": one background the PPU
 * rotates/scales per frame for free. THIS is the racer's whole visual hook.
 * Four matrix registers + one reference point do the work:
 *
 *   REG_BG2PA..PD — a 2x2 matrix in 8.8 FIXED POINT (256 == 1.0) that maps
 *     SCREEN pixels → TEXTURE pixels:  tex = P · (screen - origin) + ref.
 *     Because it maps screen→texture (the INVERSE of "how is the image
 *     transformed"), a matrix that SAMPLES 2 texture-px per screen-px makes
 *     the image look HALF size: bigger pa = smaller image. To zoom IN by z
 *     write 1/z; to rotate the image one way, write the matrix of the other.
 *   REG_BG2X/Y — the texture point sampled at screen pixel (0,0), 20.8 fixed.
 *     We ADVANCE BG2Y by the scroll each frame so the road texture slides
 *     downward → the road RECEDES toward the horizon as you drive. To pivot
 *     the rotation/scale around the screen centre (cx,cy)=(120,120, near the
 *     car) anchored at texture point (tx,ty): BG2X = (tx<<8) - (pa*cx+pb*cy)
 *     (same shape for Y with pc/pd) — "walk back from the anchor by half a
 *     screen through the matrix".
 *
 * The math (libtonc's bg_aff_rotscale does the same). lu_sin/lu_cos take a u16
 * angle (full circle = 0x10000), return 4.12 fixed → >>4 to 8.8. For bank θ
 * and zoom z (8.8):
 *     inv = 65536/z                  (8.8 reciprocal: 1/z)
 *     pa =  cos·inv>>8   pb = -sin·inv>>8
 *     pc =  sin·inv>>8   pd =  cos·inv>>8
 *
 * Footguns this block already dodges:
 *   - These 6 registers are WRITE-ONLY. You cannot read-modify-update; keep
 *     your angle/zoom in variables (bank/road_scroll) and rewrite ALL of them
 *     every frame.
 *   - Affine BGs are ALWAYS 8bpp, and the map is 1 BYTE per tile (no flip
 *     bits, no palbank — plain tile index), unlike regular BGs' u16 entries.
 *   - VRAM IGNORES BYTE WRITES (a u8 store writes the byte TWICE into the
 *     16-bit lane). Build tiles/map in a work-RAM buffer and tonccpy() it —
 *     tonccpy is VRAM-safe.
 *   - BG_WRAP makes the 256x256 texture tile forever; without it the road
 *     runs out and everything past the edge renders as tile 0.
 * requires: DCNT_MODE1 (BG2 affine there), BG2CNT → CBB 1 / SBB 26,
 *   road_apply() called every frame, BG palette indices 224..230 (bank 14 —
 *   bank 15 belongs to TTE; see the palette footgun at road_build). */
static void road_apply(u16 theta, u32 zoom_q8, u16 scroll_y) {
    s32 inv = (s32)(65536u / zoom_q8);          /* 8.8 ── 1/zoom            */
    s32 cc  = ((lu_cos(theta) >> 4) * inv) >> 8; /* 8.8 ── cosθ/zoom        */
    s32 ss  = ((lu_sin(theta) >> 4) * inv) >> 8; /* 8.8 ── sinθ/zoom        */
    REG_BG2PA = (s16)cc;  REG_BG2PB = (s16)-ss;
    REG_BG2PC = (s16)ss;  REG_BG2PD = (s16)cc;
    /* Pivot around (120,120) — under the car — anchored at texture (128, ty).
     * ty advances with scroll_y so the road slides toward the player. */
    {
        s32 ty = (s32)scroll_y;
        REG_BG2X = (128 << 8) - (cc * 120 + (-ss) * 120);
        REG_BG2Y = ((128 + ty) << 8) - (ss * 120 + cc * 120);
    }
}

/* ── GAME LOGIC (clay) — the road ART (the idiom above is the machinery; this
 * is just what the texture looks like — replace at will).
 * 8bpp tiles are 64 bytes, 1 byte per pixel, row-major. We stage 6 tiles + the
 * 32x32 one-byte-per-entry map in work RAM, then tonccpy to VRAM (CBB 1 tiles,
 * SBB 26 map) per the byte-write footgun above. The texture needs VERTICAL
 * content (lane dashes that run up the strip, a centre line) so the scroll
 * reads as forward motion, plus LATERAL structure (shoulders, grass) so the
 * bank-rotation reads as a tilt.
 * PALETTE FOOTGUN: an 8bpp BG indexes the FULL 256-color BG palette, and
 * tte_init_chr4c_default OWNS BANK 15 (240-255: ink 241 = yellow). Park 8bpp
 * road colours in bank 14 (224..) or the road turns ink-yellow the moment TTE
 * initialises. */
#define RC 224   /* road colours live at 224..230 — clear of TTE's bank 15 */
#define T_GRASS    0
#define T_SHOULDER 1
#define T_ASPHALT  2
#define T_DASH     3
#define T_CENTER   4
#define T_SPECK    5
static void road_build(void) {
    static u8 tiles[6][64];
    static u8 rmap[1024];
    int x, y, tx, ty;

    pal_bg_mem[RC + 0] = RGB15(3, 14, 5);    /* grass green (vivid)        */
    pal_bg_mem[RC + 1] = RGB15(6, 20, 8);    /* grass highlight            */
    pal_bg_mem[RC + 2] = RGB15(7, 7, 9);     /* asphalt dark               */
    pal_bg_mem[RC + 3] = RGB15(11, 11, 13);  /* asphalt light (dither)     */
    pal_bg_mem[RC + 4] = RGB15(31, 31, 22);  /* lane dash (warm white)     */
    pal_bg_mem[RC + 5] = RGB15(31, 18, 4);   /* centre line (hot amber)    */
    pal_bg_mem[RC + 6] = RGB15(28, 30, 31);  /* shoulder (near-white)      */

    for (y = 0; y < 8; y++)
        for (x = 0; x < 8; x++) {
            tiles[T_GRASS][y * 8 + x]    = (u8)(((x + y) & 3) ? RC : RC + 1);
            tiles[T_SHOULDER][y * 8 + x] = (u8)(RC + 6);
            tiles[T_ASPHALT][y * 8 + x]  = (u8)(((x * 3 + y * 5) % 7) ? RC + 2 : RC + 3);
            /* dash: a fat vertical stripe, dashed every other tile-row band */
            tiles[T_DASH][y * 8 + x]     = (u8)((x >= 3 && x <= 4 && y < 5) ? RC + 4 : RC + 2);
            tiles[T_CENTER][y * 8 + x]   = (u8)((x >= 3 && x <= 4) ? RC + 5 : RC + 2);
            tiles[T_SPECK][y * 8 + x]    = (u8)(((x == 2 && y == 5) || (x == 6 && y == 2)) ? RC + 3 : RC + 2);
        }

    /* Map: a 32x32 (256x256) road texture. A central asphalt band (cols 9..22)
     * with grass shoulders outside, a hot centre line down the middle, and
     * dashed lane lines either side of centre — VERTICAL content so the
     * downward scroll reads as forward motion, lateral content so the bank
     * rotation reads as a tilt. WRAP makes it an endless road. */
    for (ty = 0; ty < 32; ty++)
        for (tx = 0; tx < 32; tx++) {
            u8 t;
            if (tx < 9 || tx > 22)            t = T_GRASS;            /* grass shoulders */
            else if (tx == 9 || tx == 22)     t = T_SHOULDER;        /* white shoulders */
            else if (tx == 15 || tx == 16)    t = T_CENTER;          /* centre line     */
            else if (tx == 12 || tx == 19)    t = (ty & 1) ? T_DASH : T_ASPHALT; /* dashes */
            else                              t = ((tx * 5 + ty * 3) % 13 == 0) ? T_SPECK : T_ASPHALT;
            rmap[ty * 32 + tx] = t;
        }

    tonccpy(&tile8_mem[1][0], tiles, sizeof(tiles)); /* tiles → charblock 1 */
    tonccpy(se_mem[26], rmap, sizeof(rmap));         /* map  → screenblock 26 */
    REG_BG2CNT = BG_CBB(1) | BG_SBB(26) | BG_AFF_32x32 | BG_WRAP | BG_PRIO(3);
}

/* Map a discrete lane slot to a target screen-x for the player car. The car
 * eases toward this so steering feels like a turn, not a teleport. */
static s16 slot_x(s16 slot) {
    return (s16)(ROAD_X0 + 8 + slot * ((ROAD_X1 - ROAD_X0 - 16) / (CAR_SLOTS - 1)));
}

/* ── GAME LOGIC (clay) — HUD / screens (TTE on BG1, priority 0) ── */
static void draw_hud_labels(void) {
    tte_erase_screen();
    tte_write("#{P:8,4}DIST");
    tte_write("#{P:150,4}LIFE");
}

static void draw_hud_numbers(void) {
    tte_erase_rect(48, 4, 100, 12);  draw_num(48, 4, dist, 5);
    tte_erase_rect(196, 4, 210, 12); draw_num(196, 4, lives, 1);
}

static void enter_title(void) {
    state = ST_TITLE;
    tte_erase_screen();
    tte_write("#{P:64,40}" GAME_TITLE);
    tte_write("#{P:76,72}PRESS START");
    tte_write("#{P:84,92}BEST");
    draw_num(128, 92, best, 5);
    tte_write("#{P:20,116}LEFT RIGHT STEER - A B SPEED");
    tte_write("#{P:44,128}1P ENDLESS - NO LINK 2P");
}

static void enter_play(void) {
    int i;
    state = ST_PLAY;
    car_slot = CAR_SLOTS / 2;
    car_x = slot_x(car_slot);
    speed = START_SPEED;
    lives = START_LIVES;
    invuln = 0;
    dist = 0; dist_sub = 0;
    new_best = 0;
    road_scroll = 0;
    bank = 0;
    for (i = 0; i < MAX_TRAFFIC; i++) tr_alive[i] = 0;
    spawn_timer = 0;
    /* Stir the PRNG with time-on-title so each run differs. */
    rng ^= (u16)REG_VCOUNT ^ ((u16)REG_VCOUNT << 7);
    if (rng == 0) rng = 0xC0A7;
    draw_hud_labels();
    draw_hud_numbers();
}

static void enter_over(void) {
    state = ST_OVER;
    if (dist > best) {
        best = dist;
        new_best = 1;
        best_save(best);             /* byte-wise SRAM write — see SRAM idiom */
    }
    tte_write("#{P:84,56}WRECKED");
    tte_write("#{P:84,72}DIST");
    draw_num(140, 72, dist, 5);
    if (new_best) tte_write("#{P:72,88}NEW BEST");
    tte_write("#{P:76,108}PRESS START");
    sfx_tone(1, 1100, 12);
    sfx_tone(2, 900, 14);
}

/* ── GAME LOGIC (clay) — spawn traffic into a free slot ── */
static void spawn_traffic(void) {
    int i;
    for (i = 0; i < MAX_TRAFFIC; i++)
        if (!tr_alive[i]) {
            tr_alive[i] = 1;
            tr_slot[i] = random8() % CAR_SLOTS;
            tr_y[i] = -8;                /* enters from the top of the road   */
            return;
        }
}

/* AABB, both boxes ~12 px (cars are 8px sprites; a slightly fat box makes the
 * crash feel fair at speed). */
static u8 hits(s16 ax, s16 ay, s16 bx, s16 by) {
    s16 dx = (s16)(ax > bx ? ax - bx : bx - ax);
    s16 dy = (s16)(ay > by ? ay - by : by - ay);
    return (u8)(dx < 12 && dy < 12);
}

static void crash(void) {
    sfx_noise(14);
    invuln = 60;
    if (speed > SPEED_MIN) speed--;     /* a wreck kills your momentum       */
    if (lives > 0) lives--;
    draw_hud_numbers();
    if (lives == 0) enter_over();
}

/* ── GAME LOGIC (clay) — one ST_PLAY tick. The road is the affine BG2; the car
 * and traffic are sprites over it. Edge cases handled: the car eases toward its
 * lane (no teleport); a just-crashed car blinks and can't collide for 60
 * frames; traffic flows down at road speed and despawns past the bottom. ── */
static void update_play(void) {
    int i;
    s16 target_x;

    random8();                          /* tick the noise source every frame */

    /* Steer: LEFT/RIGHT move between discrete lanes (edge-triggered so a held
     * d-pad doesn't machine-gun across the road). The road BANKS toward the
     * turn — bank eases back to 0 when you're straight. */
    if (key_hit(KEY_LEFT)  && car_slot > 0)             { car_slot--; sfx_tone(1, 1400, 3); }
    if (key_hit(KEY_RIGHT) && car_slot < CAR_SLOTS - 1) { car_slot++; sfx_tone(1, 1400, 3); }
    target_x = slot_x(car_slot);
    if (car_x < target_x) { car_x += 3; if (car_x > target_x) car_x = target_x; }
    if (car_x > target_x) { car_x -= 3; if (car_x < target_x) car_x = target_x; }
    /* bank = how far the car is from screen centre → tilt the whole road */
    {
        s16 want = (s16)((car_x - 120) * 6);   /* ±~0x0180-ish lean          */
        if (bank < want) bank += 24;
        if (bank > want) bank -= 24;
    }

    /* Throttle: A/UP faster, B/DOWN slower. */
    if (key_hit(KEY_A | KEY_UP)   && speed < SPEED_MAX) { speed++; sfx_tone(2, (u16)(900 + speed * 90), 4); }
    if (key_hit(KEY_B | KEY_DOWN) && speed > SPEED_MIN) { speed--; sfx_tone(2, 1500, 3); }

    /* Recede: advance the road texture downward by `speed`. */
    road_scroll = (u16)(road_scroll + speed);

    /* Distance (the score): 1 unit per 16 scrolled px. A chime every 256. */
    dist_sub = (u16)(dist_sub + speed);
    if (dist_sub >= 16) {
        dist_sub -= 16;
        if (dist < 65000u) dist++;
        if (dist != 0 && (dist & 0xFF) == 0) sfx_tone(1, 1800, 8);  /* checkpoint */
        draw_hud_numbers();
    }

    /* Traffic flows down at road speed (reads as cars you overtake). */
    for (i = 0; i < MAX_TRAFFIC; i++) {
        if (!tr_alive[i]) continue;
        tr_y[i] = (s16)(tr_y[i] + speed + 1);   /* a touch faster than scroll */
        if (tr_y[i] > SCREEN_H) { tr_alive[i] = 0; sfx_tone(2, 700, 2); }
    }
    if (++spawn_timer >= (u8)(28 - speed * 2)) {   /* denser at higher speed  */
        spawn_timer = 0;
        spawn_traffic();
    }

    /* Crash check: traffic ↔ player. Grace window after a crash. */
    if (invuln > 0) invuln--;
    if (!invuln) {
        for (i = 0; i < MAX_TRAFFIC; i++) {
            if (!tr_alive[i]) continue;
            if (hits((s16)(slot_x(tr_slot[i]) + 4), (s16)(tr_y[i] + 4), (s16)(car_x + 4), CAR_Y + 4)) {
                tr_alive[i] = 0;
                crash();
                if (state != ST_PLAY) return;
            }
        }
    }
}

/* ── GAME LOGIC (clay) — stage the sprites: player car + traffic. Off-screen /
 * inactive slots park at y=200. ── */
static OBJ_ATTR obj_buffer[128];
static void stage_sprites(void) {
    int i;
    int playing = (state == ST_PLAY);
    /* player car (blinks during the post-crash grace) */
    obj_set_attr(&obj_buffer[SLOT_CAR], ATTR0_SQUARE, ATTR1_SIZE_8,
                 (u16)(ATTR2_PALBANK(0) | TILE_CAR));
    {
        int hide = !playing || (invuln && (invuln & 2));
        obj_set_pos(&obj_buffer[SLOT_CAR], hide ? 250 : car_x, hide ? 200 : CAR_Y);
    }
    for (i = 0; i < MAX_TRAFFIC; i++) {
        int on = playing && tr_alive[i];
        obj_set_attr(&obj_buffer[SLOT_TRAFFIC + i], ATTR0_SQUARE, ATTR1_SIZE_8,
                     (u16)(ATTR2_PALBANK(1) | TILE_RIVAL));
        obj_set_pos(&obj_buffer[SLOT_TRAFFIC + i],
                    on ? slot_x(tr_slot[i]) : 250, on ? tr_y[i] : 200);
    }
}

int main(void) {
    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * Init order: tiles/palettes → oam_init → irq_init + II_VBLANK → TTE init
     * → DISPCNT last. VBlankIntrWait() HANGS FOREVER without the vblank IRQ
     * registered (the #1 "frozen on frame 1" cause), and enabling DISPCNT
     * layers before their tiles/maps exist flashes garbage. Mode 1 = BG0/BG1
     * regular, BG2 AFFINE. TTE owns BG1 (CBB 2 / SBB 30) — keep other layers
     * off those blocks.
     * requires: nothing prior; this IS the boot. */

    /* Sprite tiles → OBJ char base (tile_mem[4]). */
    tonccpy(&tile_mem[4][TILE_CAR],   tile_car,   sizeof(tile_car));
    tonccpy(&tile_mem[4][TILE_RIVAL], tile_rival, sizeof(tile_rival));

    /* OBJ palettes: bank 0 = your car (cyan body, hot cockpit), bank 1 = rival
     * (red). The GBA's 15-bit RGB gives saturated colours the GB/NES can only
     * hint at. */
    pal_obj_bank[0][1] = RGB15(6, 20, 31);    /* your car body cyan          */
    pal_obj_bank[0][2] = RGB15(31, 31, 24);   /* cockpit glint near-white    */
    pal_obj_bank[0][3] = RGB15(4, 10, 22);    /* car outline deep blue       */
    pal_obj_bank[1][1] = RGB15(31, 7, 7);     /* rival body red              */
    pal_obj_bank[1][2] = RGB15(31, 24, 10);   /* rival windshield amber      */
    pal_obj_bank[1][3] = RGB15(16, 2, 2);     /* rival outline maroon        */

    road_build();                      /* affine BG2: tiles + map + BG2CNT     */

    oam_init(obj_buffer, 128);         /* hides all 128, matrices = identity   */

    irq_init(NULL);
    irq_add(II_VBLANK, NULL);

    sfx_init();                        /* APU on; music loop ticks below       */

    /* TTE text on BG1 (4bpp char block 2, screenblock 30), priority 0 so text
     * draws over everything. Mode 1 = BG0/BG1 regular, BG2 affine. */
    tte_init_chr4c_default(1, BG_CBB(2) | BG_SBB(30));
    REG_BG1CNT |= BG_PRIO(0);
    REG_DISPCNT = DCNT_MODE1 | DCNT_BG1 | DCNT_BG2 | DCNT_OBJ | DCNT_OBJ_1D;

    best = best_load();                /* cartridge SRAM — 0 on first boot     */
    enter_title();

    while (1) {
        /* Idiomatic Tonc heartbeat: wait vblank, poll keys, update, then commit
         * OAM + the affine matrix while still inside vblank (the update is far
         * quicker than the 4.9ms vblank window). */
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

        /* Apply the affine road every frame. On the title/result we still spin
         * a slow, gently-banking road so the screen is never a blank card and
         * the affine hardware is visibly alive. In play, zoom pulses with
         * speed: faster = the road scales UP and rushes toward you. */
        if (state == ST_PLAY) {
            u32 zoom = (u32)(220 + speed * 14);     /* 0.86..1.19 (8.8)        */
            road_apply((u16)bank, zoom, road_scroll);
        } else {
            road_scroll = (u16)(road_scroll + 1);
            road_apply((u16)(road_scroll << 6), 256, road_scroll);
        }

        stage_sprites();
        oam_copy(oam_mem, obj_buffer, 128);
    }
    return 0;
}
