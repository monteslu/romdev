/* ── shmup.c — Game Boy Advance vertical shooter (complete example game) ─────
 *
 * A COMPLETE, working game — title screen, score + persistent hi-score
 * (cartridge SRAM), music + SFX, waves of enemies, and the GBA's signature
 * hardware feature shown BOTH ways it exists:
 *   - an AFFINE BACKGROUND: the playfield backdrop is a vortex on BG2 that
 *     rotates and pulses (Mode 1, REG_BG2PA..PD matrix + BG2X/Y reference)
 *   - an AFFINE SPRITE: the wave boss is a 32x32 OBJ that spins and
 *     scale-pulses as it attacks (OAM affine parameter slot 0, double-size)
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented GBA footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — enemy patterns, scoring, tuning, art: reshape freely.
 *
 * What depends on what:
 *   gba_sfx.{h,c} — PSG sound: sfx_tone/sfx_noise one-shots + the music loop
 *     (sfx_music_tick once per frame — forget it and the game is silent).
 *   libtonc (the build links it) — VBlankIntrWait/key_poll/OAM/TTE.
 *
 * HANDHELD, SO SINGLE-PLAYER ONLY (honest note): 2P on GBA means a link
 * cable between two units — a second emulator instance this environment
 * can't provide. Title is press-start, no mode select.
 *
 * Frame budget: ARM7TDMI at 16.78MHz with this object count (1+6+6+boss)
 * doesn't come close to a full frame; the affine math is a handful of
 * multiplies per frame, not per pixel — the PPU does the per-pixel work.
 */

#include <tonc.h>
#include "gba_sfx.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "GYRE GUNNER"

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Object pools — fixed slots, no allocation. Sprite slot discipline (128 OAM
 * entries total, we use 14):
 *   slot 0      → player
 *   slot 1..6   → bullets
 *   slot 7..12  → enemies
 *   slot 13     → boss (AFFINE — uses OAM affine parameter slot 0; see the
 *                 affine-sprite idiom below for why slot CHOICE matters)
 */
#define MAX_BULLETS 6
#define MAX_ENEMIES 6
#define SLOT_PLAYER 0
#define SLOT_BULLET 1
#define SLOT_ENEMY  7
#define SLOT_BOSS   13

#define TILE_SHIP   1
#define TILE_BULLET 2
#define TILE_ENEMY  3
#define TILE_BOSS   16   /* 32x32 4bpp = 16 tiles, ids 16..31 */

#define START_LIVES 3
#define WAVE_KILLS  10   /* kills before the wave boss appears */

/* 4bpp sprite tiles (8 rows × 32 bits each = 32 bytes). Each nibble is a
 * palette index within the sprite's palbank. Index 0 = transparent. */
static const u32 tile_ship[8] = {
    0x00011000, 0x00011000, 0x00111100, 0x00111100,
    0x01111110, 0x01111110, 0x11111111, 0x11000011,
};
static const u32 tile_bullet[8] = {
    0x00022000, 0x00022000, 0x00222200, 0x00222200,
    0x00222200, 0x00222200, 0x00022000, 0x00022000,
};
static const u32 tile_enemy[8] = {
    0x33000033, 0x03333330, 0x33333333, 0x33033033,
    0x33333333, 0x03333330, 0x30000003, 0x03000030,
};

typedef struct { s16 x, y; u16 alive; } Obj;

static OBJ_ATTR obj_buffer[128];
/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * OAM AFFINE SLOT LAYOUT. There is no separate affine-matrix memory: the 32
 * OBJ_AFFINE parameter sets live INTERLEAVED inside OAM itself, in the
 * 16-bit "fill" field of every OBJ_ATTR (4 sprites × 8 bytes carry one
 * 8-byte matrix between them — pa in sprite 4n, pb in 4n+1, pc in 4n+2,
 * pd in 4n+3). Casting the shadow-OAM buffer to OBJ_AFFINE* is the whole
 * trick: obj_aff_buffer[k] aliases the fill words of sprites 4k..4k+3, and
 * one oam_copy() of the full buffer commits sprites AND matrices together.
 * Consequences you must respect:
 *   - oam_init() already set all 32 matrices to identity (pa=pd=0x0100).
 *   - NEVER memset OBJ_ATTRs to 0 — that zeroes the interleaved matrices
 *     (pa=0 means "scale by infinity": every affine sprite vanishes).
 *   - Matrix slot k is INDEPENDENT of which sprite uses it (attr1 AFF_ID
 *     picks any of the 32) — but the bytes live under sprites 4k..4k+3.
 * requires: obj_buffer staged with oam_init(), committed with oam_copy(). */
static OBJ_AFFINE *const obj_aff_buffer = (OBJ_AFFINE *)obj_buffer;

static Obj player;
static Obj bullets[MAX_BULLETS];
static Obj enemies[MAX_ENEMIES];
static u16 score, hiscore;
static u8  lives;
static u8  wave;            /* 1-based; bumps each boss defeat */
static u8  kills;           /* kills this wave (boss gate) */
static u16 spawn_timer;
static u16 frame;           /* free-running frame counter (drives the vortex) */

/* Boss state — the affine sprite showcase. */
static u8  boss_active;
static s16 boss_x, boss_y;  /* CENTER of the boss, in screen pixels */
static u8  boss_hp;
static u16 boss_theta;      /* rotation angle: full circle = 0x10000 */
static u16 boss_pulse;      /* scale-pulse phase */

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static u8 state;

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
 * Layout: 'V' 'X' score-lo score-hi checksum (xor ^ 0xA5) — magic+checksum
 * so a fresh (0xFF-filled) cart reads as "no record" instead of garbage.
 * requires: nothing else — self-contained; safe to transplant whole. */
#define SRAM_BYTE ((volatile u8 *)0x0E000000)
__attribute__((used, aligned(4))) static const char sram_type_marker[] = "SRAM_V113";

static u16 hiscore_load(void) {
    u8 lo, hi;
    if (SRAM_BYTE[0] != 'V' || SRAM_BYTE[1] != 'X') return 0;
    lo = SRAM_BYTE[2];
    hi = SRAM_BYTE[3];
    if (SRAM_BYTE[4] != (u8)(lo ^ hi ^ 0xA5)) return 0;
    return (u16)(lo | (hi << 8));
}

static void hiscore_save(u16 v) {
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
 * AFFINE BACKGROUND (BG2, Mode 1) — the GBA's "Mode 7": one background the
 * PPU rotates/scales per frame for free. This block owns four matrix
 * registers and one reference point:
 *
 *   REG_BG2PA..PD — a 2x2 matrix in 8.8 FIXED POINT (256 == 1.0) that maps
 *     SCREEN pixels → TEXTURE pixels:  tex = P · (screen - origin) + ref.
 *     Because it maps screen→texture (the INVERSE of "how is the image
 *     transformed"), a matrix that SAMPLES texture 2px per screen px makes
 *     the image look HALF size: bigger pa = smaller image. To zoom IN by z,
 *     write 1/z; to rotate the image one way, write the matrix of the other.
 *   REG_BG2X/Y — the texture point sampled at screen pixel (0,0), in 20.8
 *     fixed point. Without compensation the bg rotates around the screen's
 *     TOP-LEFT. To pivot around screen center (cx,cy)=(120,80) anchored at
 *     texture point (tx,ty): BG2X = (tx<<8) - (pa*cx + pb*cy)  (same shape
 *     for Y with pc/pd) — i.e. "walk back from the anchor by half a screen
 *     through the matrix".
 *
 * The math, spelled out (libtonc's bg_aff_rotscale does the same):
 *   lu_sin/lu_cos take a u16 angle (full circle = 0x10000) and return 4.12
 *   fixed → >>4 converts to 8.8. For rotation θ and zoom z (8.8):
 *     inv = 65536/z                  (8.8 reciprocal: 1/z)
 *     pa =  cos·inv>>8   pb = -sin·inv>>8
 *     pc =  sin·inv>>8   pd =  cos·inv>>8
 *
 * Footguns this block already dodges:
 *   - These 6 registers are WRITE-ONLY. You cannot read-modify-update;
 *     keep your angle/zoom in variables (boss_theta-style) and rewrite ALL
 *     of them every frame.
 *   - Affine BGs are ALWAYS 8bpp, and the map is 1 BYTE per tile (no flip
 *     bits, no palbank — plain tile index), unlike regular BGs' u16 entries.
 *   - VRAM IGNORES BYTE WRITES (a u8 store writes the byte TWICE into the
 *     16-bit lane). Building tiles/map in a work-RAM staging buffer and
 *     tonccpy()ing them over is the idiom — tonccpy is VRAM-safe.
 *   - BG_WRAP makes the 256x256 texture tile forever; without it everything
 *     outside the map edge renders as tile 0.
 * requires: DCNT_MODE1 (BG2 affine there), BG2CNT pointing CBB 1 / SBB 26,
 *   vortex_apply() called every frame, BG palette indices 224..228 (bank 14
 *   — bank 15 belongs to TTE; see the palette footgun at vortex_build). */
static void vortex_apply(u16 theta, u32 zoom_q8) {
    s32 inv = (s32)(65536u / zoom_q8);          /* 8.8 ── 1/zoom        */
    s32 cc  = ((lu_cos(theta) >> 4) * inv) >> 8; /* 8.8 ── cosθ/zoom    */
    s32 ss  = ((lu_sin(theta) >> 4) * inv) >> 8; /* 8.8 ── sinθ/zoom    */
    REG_BG2PA = (s16)cc;  REG_BG2PB = (s16)-ss;
    REG_BG2PC = (s16)ss;  REG_BG2PD = (s16)cc;
    /* Pivot: texture center (128,128) shows at screen center (120,80). */
    REG_BG2X = (128 << 8) - (cc * 120 + (-ss) * 80);
    REG_BG2Y = (128 << 8) - (ss * 120 +   cc  * 80);
}

/* ── GAME LOGIC (clay) — the vortex ART (the idiom above is the machinery;
 * this is just what the texture looks like — replace at will).
 * 8bpp tiles are 64 bytes, 1 byte per pixel, row-major. We stage 5 tiles +
 * the 32x32 one-byte-per-entry map in work RAM, then tonccpy to VRAM
 * (CBB 1 tiles, SBB 26 map) per the byte-write footgun above. The texture
 * needs ANGULAR content (spiral arms) or rotation is invisible, and RADIAL
 * content (rings) or the zoom pulse is invisible.
 * PALETTE FOOTGUN: an 8bpp BG indexes the FULL 256-color BG palette, and
 * tte_init_chr4c_default OWNS BANK 15 (indices 240-255: ink 241 = yellow,
 * shadow 242 = orange). Park 8bpp art colors in bank 14 (224..) or your
 * backdrop turns ink-yellow the moment TTE initialises. */
#define VC 224   /* vortex colors live at 224..228 — clear of TTE's bank 15 */
static void vortex_build(void) {
    static u8 tiles[5][64];
    static u8 vmap[1024];
    int x, y, t;

    pal_bg_mem[VC + 0] = RGB15(2, 2, 8);     /* deep blue   */
    pal_bg_mem[VC + 1] = RGB15(4, 3, 12);    /* indigo      */
    pal_bg_mem[VC + 2] = RGB15(8, 18, 26);   /* cyan glow   */
    pal_bg_mem[VC + 3] = RGB15(13, 5, 22);   /* violet      */
    pal_bg_mem[VC + 4] = RGB15(26, 28, 31);  /* star white  */

    for (y = 0; y < 8; y++)
        for (x = 0; x < 8; x++) {
            tiles[0][y * 8 + x] = 0;                                  /* void  */
            tiles[1][y * 8 + x] = (u8)(((x * 3 + y * 5) % 11) ? VC : VC + 1);     /* band A */
            tiles[2][y * 8 + x] = (u8)(((x + y * 3) % 9) ? VC + 1 : VC + 3);      /* band B */
            tiles[3][y * 8 + x] = (u8)(((x - 4) * (x - 4) + (y - 4) * (y - 4) < 9) ? VC + 2 : VC + 3); /* arm blob */
            tiles[4][y * 8 + x] = (u8)((x == 4 || y == 4) && (x + y > 5 && x + y < 12) ? VC + 4 : VC); /* star */
        }

    /* Map: concentric rings of bands A/B (radial content for the pulse)... */
    for (y = 0; y < 32; y++)
        for (x = 0; x < 32; x++) {
            int dx = 2 * (x - 16) + 1, dy = 2 * (y - 16) + 1;   /* center-ish */
            int r2 = dx * dx + dy * dy;                          /* 2..2048 */
            u8 tile = (u8)(((r2 >> 7) & 1) ? 1 : 2);
            if (((x * 7 + y * 13) % 29) == 0) tile = 4;          /* stars */
            vmap[y * 32 + x] = tile;
        }
    /* ...plus two trailing spiral arms (angular content for the rotation). */
    for (t = 0; t < 56; t++) {
        u16 th  = (u16)(t * 1400);            /* ~1.2 turns over the arm  */
        s32 rq8 = 512 + t * 60;               /* radius 2.0→15 tiles, 8.8 */
        s32 ax  = 16 + ((rq8 * (lu_cos(th) >> 4)) >> 16);
        s32 ay  = 16 + ((rq8 * (lu_sin(th) >> 4)) >> 16);
        if (ax >= 0 && ax < 32 && ay >= 0 && ay < 32) vmap[ay * 32 + ax] = 3;
        ax = 16 + ((rq8 * (lu_cos((u16)(th + 0x8000)) >> 4)) >> 16);
        ay = 16 + ((rq8 * (lu_sin((u16)(th + 0x8000)) >> 4)) >> 16);
        if (ax >= 0 && ax < 32 && ay >= 0 && ay < 32) vmap[ay * 32 + ax] = 3;
    }

    tonccpy(&tile8_mem[1][0], tiles, sizeof(tiles)); /* tiles → charblock 1 */
    tonccpy(se_mem[26], vmap, sizeof(vmap));         /* map  → screenblock 26 */
    REG_BG2CNT = BG_CBB(1) | BG_SBB(26) | BG_AFF_32x32 | BG_WRAP | BG_PRIO(3);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * AFFINE SPRITE (the boss) — same 8.8 screen→texture matrix as the affine
 * BG, but stored in OAM affine slot 0 (see the slot-layout idiom at
 * obj_aff_buffer). Three OBJ-specific footguns this block dodges:
 *   1. attr0 mode bits: ATTR0_AFF (01) turns affine ON; ATTR0_AFF_DBL (11)
 *      is affine + DOUBLE-SIZE. Without double-size the sprite is clipped
 *      to its original WxH box — a rotated 32x32 has its corners CUT OFF
 *      (≈29% of the diagonal) and a zoomed-up one is cropped to 32x32.
 *      Double-size renders into a 64x64 window so rotation/zoom≤2x fits.
 *   2. Double-size MOVES THE SPRITE: attr0/attr1 x/y are the top-left of
 *      the RENDER WINDOW, so the visual center sits at (x+32, y+32) for a
 *      32x32 sprite — position it by center and subtract 32 (a plain
 *      sprite would subtract 16). Forks that toggle DBL must re-anchor.
 *   3. ATTR0_HIDE does NOT hide an affine sprite — mode bits 01/11 reuse
 *      the hide bit. To hide the boss, drop attr0 back to a REGULAR hidden
 *      object (ATTR0_HIDE alone), as boss_stage() does below.
 * requires: OAM affine slot 0 free (sprites 0..3's fill words — fine here,
 *   they're regular objects whose fill is untouched), obj_buffer committed
 *   by oam_copy() every frame, boss tiles at OBJ tile 16 (4bpp 32x32, 1D). */
static void boss_stage(void) {
    OBJ_ATTR *o = &obj_buffer[SLOT_BOSS];
    if (!boss_active) {
        o->attr0 = ATTR0_HIDE;     /* REGULAR mode + hide (footgun 3) */
        return;
    }
    /* zoom pulse: 1.0 ± 0.45 from the sine LUT (4.12 → ±~115 in 8.8) */
    u32 zoom = (u32)(256 + (lu_sin(boss_pulse) >> 5));
    s32 inv  = (s32)(65536u / zoom);
    s32 cc   = ((lu_cos(boss_theta) >> 4) * inv) >> 8;
    s32 ss   = ((lu_sin(boss_theta) >> 4) * inv) >> 8;
    obj_aff_buffer[0].pa = (s16)cc;  obj_aff_buffer[0].pb = (s16)-ss;
    obj_aff_buffer[0].pc = (s16)ss;  obj_aff_buffer[0].pd = (s16)cc;

    o->attr0 = (u16)(ATTR0_AFF_DBL | ATTR0_SQUARE | ATTR0_4BPP
                     | ((boss_y - 32) & 0x00FF));            /* window top  */
    o->attr1 = (u16)(ATTR1_SIZE_32 | ATTR1_AFF_ID(0)
                     | ((boss_x - 32) & 0x01FF));            /* window left */
    o->attr2 = (u16)(ATTR2_PALBANK(4) | TILE_BOSS);
}

/* ── GAME LOGIC (clay) — boss ART: a spiked disc with ONE cyan spike (the
 * asymmetry makes the spin readable; a symmetric disc looks static).
 * Drawn procedurally into a 32x32 4bpp staging buffer laid out exactly as
 * OBJ VRAM wants it in 1D mapping: 16 consecutive 8x8 tiles, row-major
 * within the sprite, 2 pixels per byte (low nibble = left pixel). */
static void boss_build_tiles(void) {
    static u32 tiles[16][8];
    int x, y;
    for (y = 0; y < 32; y++)
        for (x = 0; x < 32; x++) {
            int dx = x - 16, dy = y - 16;
            int r2 = dx * dx + dy * dy;
            int c = 0;
            if (r2 < 16) c = 3;                                  /* core   */
            else if (r2 < 100) c = (r2 >= 49 && r2 < 81) ? 2 : 1; /* body+ring */
            if (dy >= -2 && dy <= 2 && dx > 8 && dx < 16)  c = 4; /* CYAN spike → */
            if (dy >= -2 && dy <= 2 && dx < -8 && dx > -16) c = 2;
            if (dx >= -2 && dx <= 2 && (dy > 8 ? dy < 16 : dy > -16 && dy < -8)) c = 2;
            if (c) {
                int t = (y / 8) * 4 + (x / 8);
                tiles[t][y % 8] |= (u32)c << (4 * (x % 8));
            }
        }
    tonccpy(&tile_mem[4][TILE_BOSS], tiles, sizeof(tiles));
    pal_obj_bank[4][1] = RGB15(16, 6, 26);   /* violet body  */
    pal_obj_bank[4][2] = RGB15(28, 10, 8);   /* ember spikes */
    pal_obj_bank[4][3] = RGB15(31, 30, 24);  /* hot core     */
    pal_obj_bank[4][4] = RGB15(8, 30, 30);   /* THE cyan spike (spin marker) */
}

/* ── GAME LOGIC (clay — reshape freely) ─────────────────────────────────── */
static u8 rng_state = 0xA5;
static u8 rand8(void) {  /* Galois LFSR, period 255 */
    u8 lsb = (u8)(rng_state & 1);
    rng_state >>= 1;
    if (lsb) rng_state ^= 0xB8;
    return rng_state;
}

static void fire_bullet(void) {
    int i;
    for (i = 0; i < MAX_BULLETS; i++)
        if (!bullets[i].alive) {
            bullets[i].x = player.x;
            bullets[i].y = player.y - 8;
            bullets[i].alive = 1;
            sfx_tone(1, 1900, 4);             /* pew (ch1; music owns ch2) */
            return;
        }
}

static void spawn_enemy(void) {
    int i;
    for (i = 0; i < MAX_ENEMIES; i++)
        if (!enemies[i].alive) {
            enemies[i].x = rand8() % (240 - 16) + 8;
            enemies[i].y = -8;
            enemies[i].alive = 1;
            return;
        }
}

static int aabb_hit(const Obj *a, const Obj *b) {
    return (a->x < b->x + 8) && (a->x + 8 > b->x)
        && (a->y < b->y + 8) && (a->y + 8 > b->y);
}

/* ── GAME LOGIC (clay) — HUD / screens (TTE on BG1, priority 0) ── */
static void draw_hud_labels(void) {
    tte_erase_screen();
    tte_write("#{P:8,4}SC");
    tte_write("#{P:96,4}HI");
    tte_write("#{P:168,4}W");
    tte_write("#{P:208,4}x");
}

static void draw_hud_numbers(void) {
    tte_erase_rect(28, 4, 70, 12);   draw_num(28, 4, score, 5);
    tte_erase_rect(116, 4, 158, 12); draw_num(116, 4, hiscore, 5);
    tte_erase_rect(178, 4, 196, 12); draw_num(178, 4, wave, 2);
    tte_erase_rect(218, 4, 228, 12); draw_num(218, 4, lives, 1);
}

static void enter_title(void) {
    state = ST_TITLE;
    tte_erase_screen();
    tte_write("#{P:60,40}" GAME_TITLE);
    tte_write("#{P:76,80}PRESS START");
    tte_write("#{P:88,100}HI");
    draw_num(112, 100, hiscore, 5);
    tte_write("#{P:48,128}DPAD MOVE - A FIRE");
}

static void enter_play(void) {
    int i;
    state = ST_PLAY;
    player.x = 116; player.y = 130; player.alive = 1;
    for (i = 0; i < MAX_BULLETS; i++) bullets[i].alive = 0;
    for (i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = 0;
    score = 0; lives = START_LIVES; wave = 1; kills = 0;
    spawn_timer = 0;
    boss_active = 0;
    draw_hud_labels();
    draw_hud_numbers();
}

static void enter_over(void) {
    state = ST_OVER;
    if (score > hiscore) {
        hiscore = score;
        hiscore_save(hiscore);   /* byte-wise SRAM write — see the idiom */
        draw_hud_numbers();
    }
    tte_write("#{P:84,64}GAME OVER");
    tte_write("#{P:76,84}PRESS START");
}

static void boss_enter(void) {
    boss_active = 1;
    boss_x = 120; boss_y = -20;            /* descends into view */
    boss_hp = (u8)(6 + wave * 2);
    if (boss_hp > 20) boss_hp = 20;
    boss_theta = 0; boss_pulse = 0;
    sfx_noise(30);
}

static void boss_defeat(void) {
    boss_active = 0;
    if (score < 65000u) score += 250;
    wave++; kills = 0;
    draw_hud_numbers();
    sfx_noise(24);
}

static void lose_life(void) {
    sfx_noise(12);
    if (lives > 0) lives--;
    draw_hud_numbers();
    player.x = 116; player.y = 130;
    if (lives == 0) enter_over();
}

/* ── GAME LOGIC (clay) — one ST_PLAY tick ── */
static void update_play(void) {
    int i, j;

    if (key_held(KEY_LEFT)  && player.x > 8)        player.x -= 2;
    if (key_held(KEY_RIGHT) && player.x < 240 - 16) player.x += 2;
    if (key_held(KEY_UP)    && player.y > 20)       player.y -= 2;
    if (key_held(KEY_DOWN)  && player.y < 160 - 16) player.y += 2;
    if (key_hit(KEY_A)) fire_bullet();

    for (i = 0; i < MAX_BULLETS; i++) {
        if (!bullets[i].alive) continue;
        bullets[i].y -= 4;
        if (bullets[i].y < -8) bullets[i].alive = 0;
    }
    for (i = 0; i < MAX_ENEMIES; i++) {
        if (!enemies[i].alive) continue;
        enemies[i].y += 1 + (wave >> 2);
        if (enemies[i].y > 160) enemies[i].alive = 0;
    }

    /* Spawner: steady waves; during a boss the boss is the spawner. */
    if (!boss_active) {
        u16 period = (u16)(28 > 12 + wave * 2 ? 28 - wave * 2 : 12);
        if (++spawn_timer >= period && kills < WAVE_KILLS) { spawn_timer = 0; spawn_enemy(); }
        if (kills >= WAVE_KILLS) {
            u8 field_clear = 1;
            for (i = 0; i < MAX_ENEMIES; i++) if (enemies[i].alive) field_clear = 0;
            if (field_clear) boss_enter();
        }
    } else {
        /* Boss attack pattern: spin faster than the backdrop, pulse scale,
         * strafe a sine path while drifting down, shed minions. */
        boss_theta = (u16)(boss_theta + 0x0140);     /* ~1.8°/frame */
        boss_pulse = (u16)(boss_pulse + 0x0120);
        if (boss_y < 56) boss_y++;                   /* entrance dive */
        else boss_x = (s16)(120 + ((76 * lu_sin((u16)(frame << 7))) >> 12));
        if (++spawn_timer >= 90) { spawn_timer = 0; spawn_enemy(); }

        /* Bullets vs boss: 28x28 box around the boss CENTER. Collision is
         * the UNROTATED box on purpose — honest simplification; rotating
         * hitboxes buys little for a round boss. */
        for (i = 0; i < MAX_BULLETS; i++) {
            if (!bullets[i].alive) continue;
            if (bullets[i].x + 4 > boss_x - 14 && bullets[i].x + 4 < boss_x + 14 &&
                bullets[i].y + 4 > boss_y - 14 && bullets[i].y + 4 < boss_y + 14) {
                bullets[i].alive = 0;
                sfx_tone(1, 900, 3);
                if (--boss_hp == 0) { boss_defeat(); break; }
            }
        }
        /* Boss vs player (same box vs the 8x8 ship). */
        if (boss_active &&
            player.x + 8 > boss_x - 14 && player.x < boss_x + 14 &&
            player.y + 8 > boss_y - 14 && player.y < boss_y + 14) {
            lose_life();
        }
    }

    /* Bullets vs enemies. */
    for (i = 0; i < MAX_BULLETS; i++) {
        if (!bullets[i].alive) continue;
        for (j = 0; j < MAX_ENEMIES; j++) {
            if (!enemies[j].alive) continue;
            if (aabb_hit(&bullets[i], &enemies[j])) {
                bullets[i].alive = 0;
                enemies[j].alive = 0;
                if (score < 65000u) score += 10;
                kills++;
                sfx_noise(6);
                draw_hud_numbers();
                break;
            }
        }
    }
    /* Enemies vs player. */
    for (j = 0; j < MAX_ENEMIES && state == ST_PLAY; j++) {
        if (!enemies[j].alive) continue;
        if (aabb_hit(&enemies[j], &player)) {
            enemies[j].alive = 0;
            lose_life();
        }
    }
}

/* ── GAME LOGIC (clay) — stage the regular sprites (boss has its own idiom
 * block). Inactive slots park offscreen (y=200) instead of HIDE so the loop
 * stays branch-light; either works for REGULAR sprites. ── */
static void stage_sprites(void) {
    int i;
    int px = (state == ST_PLAY) ? player.x : 250, py = (state == ST_PLAY) ? player.y : 200;
    obj_set_attr(&obj_buffer[SLOT_PLAYER], ATTR0_SQUARE, ATTR1_SIZE_8,
                 ATTR2_PALBANK(0) | TILE_SHIP);
    obj_set_pos(&obj_buffer[SLOT_PLAYER], px, py);
    for (i = 0; i < MAX_BULLETS; i++) {
        obj_set_attr(&obj_buffer[SLOT_BULLET + i], ATTR0_SQUARE, ATTR1_SIZE_8,
                     ATTR2_PALBANK(1) | TILE_BULLET);
        obj_set_pos(&obj_buffer[SLOT_BULLET + i], bullets[i].x,
                    (state == ST_PLAY && bullets[i].alive) ? bullets[i].y : 200);
    }
    for (i = 0; i < MAX_ENEMIES; i++) {
        obj_set_attr(&obj_buffer[SLOT_ENEMY + i], ATTR0_SQUARE, ATTR1_SIZE_8,
                     ATTR2_PALBANK(2) | TILE_ENEMY);
        obj_set_pos(&obj_buffer[SLOT_ENEMY + i], enemies[i].x,
                    (state == ST_PLAY && enemies[i].alive) ? enemies[i].y : 200);
    }
    boss_stage();
}

int main(void) {
    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * Init order: tiles/palettes → oam_init → irq_init + II_VBLANK →
     * TTE init → DISPCNT last. VBlankIntrWait() HANGS FOREVER without the
     * vblank IRQ registered (the #1 "frozen on frame 1" cause), and
     * enabling DISPCNT layers before their tiles/maps exist flashes
     * garbage. TTE owns BG1 (CBB 2 / SBB 30) — keep other layers off
     * those blocks. requires: nothing prior; this IS the boot. */
    tonccpy(&tile_mem[4][TILE_SHIP],   tile_ship,   sizeof(tile_ship));
    tonccpy(&tile_mem[4][TILE_BULLET], tile_bullet, sizeof(tile_bullet));
    tonccpy(&tile_mem[4][TILE_ENEMY],  tile_enemy,  sizeof(tile_enemy));
    boss_build_tiles();
    pal_obj_bank[0][1] = CLR_WHITE;    /* ship    */
    pal_obj_bank[1][2] = CLR_YELLOW;   /* bullets */
    pal_obj_bank[2][3] = CLR_RED;      /* enemies */
    pal_bg_mem[0] = CLR_BLACK;

    vortex_build();                    /* affine BG2: tiles+map+BG2CNT */
    oam_init(obj_buffer, 128);         /* hides all 128, matrices = identity */

    irq_init(NULL);
    irq_add(II_VBLANK, NULL);

    sfx_init();                        /* APU on; music loop ticks below */

    /* TTE text on BG1 (4bpp char block 2, screenblock 30), priority 0 so
     * text draws over everything. Mode 1 = BG0/BG1 regular, BG2 AFFINE. */
    tte_init_chr4c_default(1, BG_CBB(2) | BG_SBB(30));
    REG_BG1CNT |= BG_PRIO(0);
    REG_DISPCNT = DCNT_MODE1 | DCNT_BG1 | DCNT_BG2 | DCNT_OBJ | DCNT_OBJ_1D;

    hiscore = hiscore_load();          /* cartridge SRAM — 0 on first boot */
    enter_title();

    while (1) {
        /* Idiomatic Tonc heartbeat: wait vblank, poll keys, update, then
         * commit OAM + affine registers while still inside vblank (the
         * whole update is far quicker than the 4.9ms vblank window). */
        VBlankIntrWait();
        key_poll();
        sfx_music_tick();              /* forget this → silent game */
        frame++;

        if (state == ST_TITLE) {
            if (key_hit(KEY_START | KEY_A)) enter_play();
        } else if (state == ST_OVER) {
            if (key_hit(KEY_START)) enter_title();
        } else {
            update_play();
        }

        /* The vortex breathes with the game: gentle on the title, driving
         * during play, frantic while the boss is up. (Affine BG idiom —
         * rewrite ALL the write-only registers every frame.) */
        {
            u16 vth; u32 vzoom;
            if (state == ST_PLAY && boss_active) {
                vth   = (u16)(frame * 0x00C0);
                vzoom = (u32)(256 + (lu_sin((u16)(frame * 0x0180)) >> 5));
            } else if (state == ST_PLAY) {
                vth   = (u16)(frame * 0x0050);
                vzoom = (u32)(256 + (lu_sin((u16)(frame * 0x0060)) >> 6));
            } else {
                vth   = (u16)(frame * 0x0030);
                vzoom = (u32)(256 + (lu_sin((u16)(frame * 0x0040)) >> 6));
            }
            vortex_apply(vth, vzoom);
        }

        stage_sprites();
        oam_copy(oam_mem, obj_buffer, 128);  /* sprites AND affine slot 0 */
    }
    return 0;
}
