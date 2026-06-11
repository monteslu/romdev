/* ── platformer.c — Game Boy Advance side-scrolling platformer (complete game) ─
 *
 * GEAR GROTTO — a COMPLETE, working game: title screen, score + persistent
 * hi-score (cartridge SRAM), music + SFX, gravity/jump physics over a
 * scrolling tile level, coins + distance scoring, and the GBA's signature
 * affine hardware shown where it actually fits a platformer:
 *   - a spinning GEAR HAZARD: a 32x32 OBJ that continuously rotates (and
 *     scale-pulses) via an OAM affine matrix (8.8 fixed point, affine slot 0,
 *     double-size flag). Touch it and you lose a life. The classic
 *     spinning-saw/gear obstacle, done the hardware-honest way.
 *
 * The level is a regular (text/tiled) Mode-0 BG: a 64x32 map = a 512-px run
 * of pits, platforms, ground and coins, scrolled by REG_BG0HOFS as the camera
 * follows the player. The 64x32 map WRAPS in hardware at 512 px, so writing
 * (cam & 511) to REG_BG0HOFS and looking up world columns with (& 63) makes
 * the run LOOP SEAMLESSLY — an endless runner with no streaming. The HUD
 * lives on a SECOND regular BG (TTE) that we never scroll.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented GBA footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — level layout, physics tuning, scoring, art: reshape
 *     freely.
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
 * Frame budget: ARM7TDMI at 16.78MHz with this object count (player + 3 coins
 * + the gear) doesn't come close to a full frame; the affine math is a handful
 * of multiplies per frame, not per pixel — the PPU does the per-pixel work.
 */

#include <tonc.h>
#include "gba_sfx.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "GEAR GROTTO"

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Object pools — fixed slots, no allocation. Sprite slot discipline (128 OAM
 * entries total, we use 5):
 *   slot 0      → player
 *   slot 1..3   → coins
 *   slot 4      → gear hazard (AFFINE — uses OAM affine parameter slot 0; see
 *                 the affine-sprite idiom below for why slot CHOICE matters)
 */
#define SLOT_PLAYER 0
#define SLOT_COIN   1
#define NUM_COINS   3
#define SLOT_GEAR   4

#define TILE_PLAYER 1    /* sprite tile 1, 8x8 4bpp */
#define TILE_COIN   2
#define TILE_GEAR   16   /* 32x32 4bpp = 16 tiles, ids 16..31 */

#define START_LIVES 3

/* World geometry — a 512-px level in a BG0 64x32 map (whole world, no stream).
 * Physics runs in WORLD pixels; sprites draw at SCREEN = world - camera. */
#define WORLD_W   512
#define SCREEN_W  240
#define SCREEN_H  160

/* 4bpp sprite tiles (8 rows × 32 bits each = 32 bytes). Each nibble is a
 * palette index within the sprite's palbank. Index 0 = transparent. */
static const u32 tile_player[8] = {
    0x00033000, 0x00333300, 0x03311330, 0x03333330,
    0x03333330, 0x03333330, 0x03300330, 0x03000030,
};
static const u32 tile_coin[8] = {
    0x00022000, 0x00222200, 0x02244220, 0x02422420,
    0x02422420, 0x02244220, 0x00222200, 0x00022000,
};

typedef struct { s32 x; s16 y; u8 alive; } Coin;

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

/* ── GAME LOGIC (clay) — player physics state ────────────────────────────────
 * Position is fixed-point: 1 px = 16 subpixel units (Q.4). Gravity adds well
 * under 1 px/frame near the jump apex, so sub-pixel Y is mandatory — integer
 * Y would stutter the arc. X stays integer (walking is whole-pixel). */
#define SUBPX        16        /* subpixels per pixel (Q.4)                 */
#define GRAVITY      12        /* +12/16 px per frame per frame             */
#define JUMP_VEL  (-200)       /* launch vy (Q.4) → ~6-tile apex            */
#define MAX_FALL     80        /* terminal velocity 5 px/frame — keep < 6:  *
                               * the landing window is 6 px, a faster fall  *
                               * would tunnel through a platform top        */
#define MOVE_SPEED    2        /* px/frame walk + scroll speed              */
#define SCROLL_WALL  96        /* px: past this the world scrolls, not you  */

static s32 px;                 /* player WORLD x, whole px (left edge) —     *
                               * s32: the endless camera grows without bound*/
static s32 py_q4;              /* player WORLD y, Q.4 (top edge)            */
static s16 vy_q4;              /* vertical velocity, Q.4                    */
static u8  on_ground;
static s32 cam_x;              /* camera world-x (BG0 scroll, ever-growing) */
static u16 dist_sub;           /* sub-counter: 64 px walked = +1 point      */

static Coin coins[NUM_COINS];
static u16  score, hiscore;
static u8   lives;
static u16  frame;             /* free-running frame counter (drives gear)  */

/* Gear hazard state — the affine sprite showcase. WORLD-anchored; it drifts
 * left with the camera like the level does. */
static s32 gear_wx, gear_wy;   /* CENTER of the gear, WORLD pixels          */
static u16 gear_theta;         /* rotation angle: full circle = 0x10000     */
static u16 gear_pulse;         /* scale-pulse phase                         */

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
 * AFFINE SPRITE (the gear hazard) — the 8.8 screen→texture matrix stored in
 * OAM affine slot 0 (see the slot-layout idiom at obj_aff_buffer). Three
 * OBJ-specific footguns this block dodges:
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
 *      the hide bit. To hide the gear, drop attr0 back to a REGULAR hidden
 *      object (ATTR0_HIDE alone).
 * The MATRIX (8.8 fixed point, 256 == 1.0) maps SCREEN pixels → TEXTURE
 * pixels (the INVERSE of "how the image is transformed"), so to SHOW the
 * texture rotated by θ and zoomed by z you write the matrix of -θ and 1/z:
 *   inv = 65536/z                 (8.8 reciprocal: 1/z)
 *   pa =  cos·inv>>8   pb = -sin·inv>>8
 *   pc =  sin·inv>>8   pd =  cos·inv>>8
 * lu_sin/lu_cos take a u16 angle (full circle = 0x10000) and return 4.12
 * fixed → >>4 converts to 8.8.
 * requires: OAM affine slot 0 free (sprites 0..3's fill words — fine here,
 *   they're regular objects whose fill is untouched), obj_buffer committed
 *   by oam_copy() every frame, gear tiles at OBJ tile 16 (4bpp 32x32, 1D). */
static void gear_stage(s16 screen_cx, s16 screen_cy) {
    OBJ_ATTR *o = &obj_buffer[SLOT_GEAR];
    /* zoom pulse: 1.0 ± 0.20 from the sine LUT (4.12 → ±~50 in 8.8). A
     * pure rotation is readable, but the gentle breathing makes the affine
     * scaling visible too — both halves of the idiom on screen at once. */
    u32 zoom = (u32)(256 + (lu_sin(gear_pulse) >> 7));
    s32 inv  = (s32)(65536u / zoom);
    s32 cc   = ((lu_cos(gear_theta) >> 4) * inv) >> 8;
    s32 ss   = ((lu_sin(gear_theta) >> 4) * inv) >> 8;
    obj_aff_buffer[0].pa = (s16)cc;  obj_aff_buffer[0].pb = (s16)-ss;
    obj_aff_buffer[0].pc = (s16)ss;  obj_aff_buffer[0].pd = (s16)cc;

    o->attr0 = (u16)(ATTR0_AFF_DBL | ATTR0_SQUARE | ATTR0_4BPP
                     | ((screen_cy - 32) & 0x00FF));         /* window top  */
    o->attr1 = (u16)(ATTR1_SIZE_32 | ATTR1_AFF_ID(0)
                     | ((screen_cx - 32) & 0x01FF));         /* window left */
    o->attr2 = (u16)(ATTR2_PALBANK(3) | TILE_GEAR);
}

/* ── GAME LOGIC (clay) — gear ART: a toothed disc with ONE bright tooth (the
 * asymmetry makes the spin readable; a symmetric disc looks static).
 * Drawn procedurally into a 32x32 4bpp staging buffer laid out exactly as
 * OBJ VRAM wants it in 1D mapping: 16 consecutive 8x8 tiles, row-major
 * within the sprite, 2 pixels per byte (low nibble = left pixel). */
static void gear_build_tiles(void) {
    static u32 tiles[16][8];
    int x, y;
    for (y = 0; y < 32; y++)
        for (x = 0; x < 32; x++) {
            int dx = x - 16, dy = y - 16;
            int r2 = dx * dx + dy * dy;
            int c = 0;
            if (r2 < 25) c = 3;                                   /* hub bore */
            else if (r2 < 64) c = 1;                              /* hub      */
            else if (r2 < 144) c = 2;                             /* gear body*/
            /* eight square teeth around the rim (one per 45°) */
            if (r2 >= 144 && r2 < 225) {
                if ((dx >= -2 && dx <= 2) || (dy >= -2 && dy <= 2)
                    || (dx - dy >= -3 && dx - dy <= 3)
                    || (dx + dy >= -3 && dx + dy <= 3)) c = 2;
            }
            if (dx >= -2 && dx <= 2 && dy > 8 && dy < 16) c = 4;  /* BRIGHT tooth ↓ (spin marker) */
            if (c) {
                int t = (y / 8) * 4 + (x / 8);
                tiles[t][y % 8] |= (u32)c << (4 * (x % 8));
            }
        }
    tonccpy(&tile_mem[4][TILE_GEAR], tiles, sizeof(tiles));
    pal_obj_bank[3][1] = RGB15(20, 20, 22);  /* hub steel    */
    pal_obj_bank[3][2] = RGB15(13, 13, 16);  /* gear body    */
    pal_obj_bank[3][3] = RGB15(28, 26, 10);  /* bore brass   */
    pal_obj_bank[3][4] = RGB15(31, 12, 6);   /* THE hot tooth (spin marker) */
}

/* ── GAME LOGIC (clay — reshape freely) ─────────────────────────────────── */
static u8 rng_state = 0xA5;
static u8 rand8(void) {  /* Galois LFSR, period 255 */
    u8 lsb = (u8)(rng_state & 1);
    rng_state >>= 1;
    if (lsb) rng_state ^= 0xB8;
    return rng_state;
}

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * The level — a 64-column world (512 px). For each column:
 *   ground_row[c] — map row of the ground's grass top, NO_GROUND = a pit.
 *   plat_row[c]   — row of a one-way floating platform, 0 = none.
 * Rows are map rows (y = row*8). Map is 32 rows tall (256 px); the playfield
 * sits in rows 3..19, ground around row 18 (y=144). Identical layout repeats
 * are fine — this is a fixed hand-authored run, not a procedural loop. */
#define NO_GROUND 0xFF
#define GROUND_ROW 18           /* y = 144 — the main floor                  */
#define MAP_COLS   64
static const u8 ground_row[MAP_COLS] = {
  18,18,18,18,18,18,18,18,                              /* long start runway */
  18,18,18,18,18,18,18,18,                              /* (lets it scroll   */
  18,18,18,18,NO_GROUND,NO_GROUND,18,18,                /* pit 1 (cols 20-21)*/
  18,18,18,18,18,18,18,18,
  18,18,NO_GROUND,NO_GROUND,NO_GROUND,18,18,18,         /* pit 2 wide (34-36)*/
  18,18,18,18,18,18,18,18,
  18,18,18,NO_GROUND,NO_GROUND,18,18,18,                /* pit 3 (51-52)     */
  18,18,18,18,18,18,18,18,                              /* finish runway     */
};
static const u8 plat_row[MAP_COLS] = {
  0,0,0,0,0,0,12,12,                                    /* warm-up slab      */
  12,0,0,0,0,0,0,0,
  0,0,11,11,11,0,0,0,                                   /* slab over pit 1   */
  0,0,0,10,10,10,0,0,                                   /* high slab         */
  0,11,11,11,11,0,0,0,                                  /* slab over pit 2   */
  0,0,0,0,9,9,0,0,                                      /* high slab         */
  0,0,12,12,12,0,0,0,                                   /* slab over pit 3   */
  0,0,0,0,13,13,13,0,                                   /* finish slab       */
};

#define BG_BLANK  0
#define BG_GRASS  1   /* ground surface + floating slabs                     */
#define BG_DIRT   2   /* ground body                                         */
#define BG_BRICK  3   /* backdrop accent                                     */

/* ── GAME LOGIC (clay) — BG tile art (regular Mode-0 4bpp BG tiles).
 * Each 8x8 4bpp tile is 8 u32 rows; each nibble a palette index in the BG
 * palbank we use (bank 0 — regular BGs carry a 4-bit palbank per map entry,
 * unlike affine BGs). Index 0 transparent. */
static const u32 bg_tile_grass[8] = {
    0x11111111, 0x11111111, 0x21212121, 0x22222222,
    0x22222222, 0x22222222, 0x22222222, 0x22222222,
};
static const u32 bg_tile_dirt[8] = {
    0x22222222, 0x22322222, 0x22222222, 0x22222232,
    0x22222222, 0x23222222, 0x22222222, 0x22222223,
};
static const u32 bg_tile_brick[8] = {
    0x33333333, 0x30303030, 0x33333333, 0x03030303,
    0x33333333, 0x30303030, 0x33333333, 0x03030303,
};

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * SCROLLING TILE BG (BG0, Mode 0) — a REGULAR text BG, the bread-and-butter
 * GBA background. A 64x32 map (BG_REG_64x32) is exactly the 512-px world, so
 * the whole level fits and we never stream: the camera just writes
 * REG_BG0HOFS each frame. Footguns this block dodges:
 *   - A 64-wide regular map is TWO 32x32 screenblocks SIDE BY SIDE (SBB n =
 *     left 32 cols, SBB n+1 = right 32 cols). A flat (col,row) write must
 *     route col<32 to the left block and col>=32 to the right — MAP_SET
 *     below does that. (libtonc's se_mem[] indexes one screenblock.)
 *   - Each map entry is a u16: tile id (10 bits) + hflip/vflip + a 4-bit
 *     PALBANK. SE_BUILD(tile, palbank, hflip, vflip) packs it. (Regular BGs
 *     carry a palbank per tile; affine BGs do NOT — that's the other idiom.)
 *   - VRAM ignores byte writes (a u8 store duplicates the byte into both
 *     halves of the 16-bit lane). We only ever write whole u16 SE entries
 *     and tonccpy() tile data, both VRAM-safe.
 * requires: DCNT_MODE0 + DCNT_BG0, BG0CNT pointing CBB 0 / SBB 28 (so 28+29
 *   hold the 64-wide map), REG_BG0HOFS written every frame, BG1 (TTE) kept
 *   clear of SBB 28/29. */
static SCR_ENTRY *const sbbL = se_mem[28];   /* left  32 cols */
static SCR_ENTRY *const sbbR = se_mem[29];   /* right 32 cols */
#define MAP_SET(tx, ty, se) do {                              \
        if ((tx) < 32) sbbL[(ty) * 32 + (tx)] = (se);         \
        else           sbbR[(ty) * 32 + ((tx) - 32)] = (se);  \
    } while (0)

static void build_level(void) {
    int tx, ty;
    u8 g, pr;

    pal_bg_mem[0]  = RGB15(2, 3, 8);      /* cave backdrop (BG backdrop)  */
    pal_bg_mem[1]  = RGB15(10, 24, 8);    /* grass green                  */
    pal_bg_mem[2]  = RGB15(14, 9, 4);     /* dirt brown                   */
    pal_bg_mem[3]  = RGB15(6, 7, 13);     /* brick slate                  */

    tonccpy(&tile_mem[0][BG_GRASS], bg_tile_grass, sizeof(bg_tile_grass));
    tonccpy(&tile_mem[0][BG_DIRT],  bg_tile_dirt,  sizeof(bg_tile_dirt));
    tonccpy(&tile_mem[0][BG_BRICK], bg_tile_brick, sizeof(bg_tile_brick));

    for (ty = 0; ty < 32; ty++)
        for (tx = 0; tx < MAP_COLS; tx++) {
            u16 se = SE_BUILD(BG_BLANK, 0, 0, 0);
            g  = ground_row[tx];
            pr = plat_row[tx];
            if (pr && ty == pr) se = SE_BUILD(BG_GRASS, 0, 0, 0);   /* slab      */
            else if (g != NO_GROUND && ty == g) se = SE_BUILD(BG_GRASS, 0, 0, 0);
            else if (g != NO_GROUND && ty > g)  se = SE_BUILD(BG_DIRT, 0, 0, 0);
            else if (ty < 8 && ((tx * 5 + ty * 7) & 7) == 0)
                se = SE_BUILD(BG_BRICK, 0, 0, 0);                   /* backdrop  */
            MAP_SET(tx, ty, se);
        }
    REG_BG0CNT = BG_CBB(0) | BG_SBB(28) | BG_REG_64x32 | BG_4BPP | BG_PRIO(2);
}

/* ── GAME LOGIC (clay) — landing probe against the column map ──────────────
 * One-way platforms: catch the player only while FALLING through a narrow
 * window at a surface top. Window is feet in [top-1 .. top+5] so a 5px/frame
 * terminal fall can't step over it (tunnelling). Columns are WORLD columns. */
static s16 land_top(int wcol, s16 feet) {
    u8 r;
    s16 top;
    wcol &= (MAP_COLS - 1);        /* wrap: the 64-col map loops endlessly */
    r = plat_row[wcol];
    if (r) {
        top = (s16)(r << 3);
        if (feet + 1 >= top && feet <= top + 5) return top;
    }
    r = ground_row[wcol];
    if (r != NO_GROUND) {
        top = (s16)(r << 3);
        if (feet + 1 >= top && feet <= top + 5) return top;
    }
    return -1;
}

/* ── GAME LOGIC (clay) — coins (world-anchored sprite objects) ── */
static const s16 coin_heights[4] = { 88, 72, 104, 56 };
static void place_coin(u8 i, s32 wx) {
    coins[i].x = wx;
    coins[i].y = coin_heights[rand8() & 3];
    coins[i].alive = 1;
}

/* Box overlap in WORLD coords. s32 so it stays correct as the endless camera
 * grows past 16 bits — overlapping objects always have a small difference. */
static int aabb(s32 ax, s32 ay, s32 bx, s32 by, s32 r) {
    s32 dx = ax - bx, dy = ay - by;
    if (dx < 0) dx = -dx;
    if (dy < 0) dy = -dy;
    return dx < r && dy < r;
}

/* ── GAME LOGIC (clay) — HUD / screens (TTE on BG1, priority 0) ── */
static void draw_hud_labels(void) {
    tte_erase_screen();
    tte_write("#{P:8,4}SC");
    tte_write("#{P:96,4}HI");
    tte_write("#{P:200,4}x");
}

static void draw_hud_numbers(void) {
    tte_erase_rect(28, 4, 70, 12);   draw_num(28, 4, score, 5);
    tte_erase_rect(116, 4, 158, 12); draw_num(116, 4, hiscore, 5);
    tte_erase_rect(210, 4, 220, 12); draw_num(210, 4, lives, 1);
}

static void enter_title(void) {
    state = ST_TITLE;
    tte_erase_screen();
    tte_write("#{P:60,40}" GAME_TITLE);
    tte_write("#{P:76,80}PRESS START");
    tte_write("#{P:88,100}HI");
    draw_num(112, 100, hiscore, 5);
    tte_write("#{P:40,128}DPAD MOVE - A JUMP");
}

static void enter_play(void) {
    int i;
    state = ST_PLAY;
    px = 24; py_q4 = (s32)(112 << 4); vy_q4 = 0; on_ground = 1;
    cam_x = 0; dist_sub = 0;
    score = 0; lives = START_LIVES; frame = 0;
    for (i = 0; i < NUM_COINS; i++)
        place_coin((u8)i, (s16)(80 + i * 130));
    gear_wx = 384; gear_wy = 116;          /* hovers over the mid-level run  */
    gear_theta = 0; gear_pulse = 0;
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

static void lose_life(void) {
    sfx_noise(14);
    if (lives > 0) lives--;
    draw_hud_numbers();
    /* respawn at the player's fixed screen lane, on the ground (the camera is
     * one-way and never resets — the run keeps moving forward). */
    px = (s16)(cam_x + SCROLL_WALL);
    py_q4 = (s32)((GROUND_ROW * 8 - 8) << 4);
    vy_q4 = 0; on_ground = 1;
    /* shove the gear far ahead so we don't respawn straight onto it */
    gear_wx = (s16)(cam_x + SCREEN_W + 120);
    if (lives == 0) enter_over();
}

/* ── GAME LOGIC (clay) — one ST_PLAY tick ── */
static void update_play(void) {
    int i;
    s16 ipy, feet, npy, top;

    /* Horizontal: the player walks up to SCROLL_WALL (screen x), then holds
     * that lane while the WORLD scrolls under them — a one-way endless runner.
     * cam_x grows without bound; only the BG register and column lookups wrap
     * (mod 512 / mod 64), so the 64x32 map loops seamlessly. */
    if (key_held(KEY_LEFT)  && px > cam_x + 8) px -= MOVE_SPEED;
    if (key_held(KEY_RIGHT)) {
        s16 screen_x = (s16)(px - cam_x);
        px += MOVE_SPEED;
        if (screen_x >= SCROLL_WALL) {
            cam_x += MOVE_SPEED;               /* world scrolls (camera leads) */
            dist_sub += MOVE_SPEED;
            if (dist_sub >= 64) { dist_sub -= 64; if (score < 65000u) { score++; draw_hud_numbers(); } }
        }
    }

    /* Jump. */
    if (key_hit(KEY_A) && on_ground) {
        vy_q4 = JUMP_VEL;
        on_ground = 0;
        sfx_tone(1, 1500, 6);                  /* boing */
    }

    /* Gravity + sub-pixel Y. */
    if (vy_q4 < MAX_FALL) vy_q4 += GRAVITY;
    ipy = (s16)(py_q4 >> 4);
    npy = (s16)((py_q4 + vy_q4) >> 4);

    /* Fell into a pit (below the playfield) → lose a life. */
    if (npy > SCREEN_H + 8) { lose_life(); return; }

    /* Landing: probe the world columns under the player's feet, while falling.
     * land_top wraps the column (& 63), so the loop's pits/slabs keep coming. */
    if (vy_q4 >= 0) {
        feet = (s16)(npy + 8);
        top = land_top(px >> 3, feet);
        if (top < 0) top = land_top((px + 7) >> 3, feet);
        if (top >= 0 && ipy + 8 <= top + 6) {
            py_q4 = (s32)((top - 8) << 4);
            if (!on_ground) sfx_tone(2, 800, 3);   /* landing thud */
            vy_q4 = 0; on_ground = 1;
        } else {
            py_q4 += vy_q4;
            on_ground = 0;
        }
    } else {
        py_q4 += vy_q4;            /* rising */
    }

    /* Gear hazard: spin + pulse, world-anchored (drifts with the scroll). The
     * collision is the UNROTATED box around the gear center — honest
     * simplification; a rotating hitbox buys little for a round gear. Once it
     * slides off the left, recycle it ahead at a fresh height. */
    gear_theta = (u16)(gear_theta + 0x0300);   /* ~4.2°/frame */
    gear_pulse = (u16)(gear_pulse + 0x0180);
    if (gear_wx < cam_x - 40) {
        gear_wx = (s16)(cam_x + SCREEN_W + 40 + (rand8() & 63));
        gear_wy = (s16)(96 + (rand8() & 31));
    }
    {
        s32 plx = px, ply = (py_q4 >> 4);
        if (aabb(plx + 4, ply + 4, gear_wx, gear_wy, 16)) {
            lose_life();
            if (state != ST_PLAY) return;
        }
    }

    /* Coins: collect on overlap, recycle ahead of the camera. */
    {
        s32 plx = px, ply = (py_q4 >> 4);
        for (i = 0; i < NUM_COINS; i++) {
            if (!coins[i].alive) continue;
            if (aabb(plx + 4, ply + 4, coins[i].x + 4, coins[i].y + 4, 8)) {
                coins[i].alive = 0;
                if (score < 65000u) score += 10;
                draw_hud_numbers();
                sfx_tone(1, 1900, 4);                 /* coin ping */
            }
            /* recycle a coin once it's well behind the camera */
            if (coins[i].x < cam_x - 16)
                place_coin((u8)i, (s16)(cam_x + SCREEN_W + (rand8() & 63)));
        }
    }
}

/* ── GAME LOGIC (clay) — stage the regular sprites (the gear has its own
 * idiom block). Off-screen objects park at y=200; either works for REGULAR
 * sprites. The gear is staged in SCREEN space = world - camera. ── */
static void stage_sprites(void) {
    int i;
    int playing = (state == ST_PLAY);
    s16 sx = (s16)(px - cam_x), sy = (s16)(py_q4 >> 4);

    obj_set_attr(&obj_buffer[SLOT_PLAYER], ATTR0_SQUARE, ATTR1_SIZE_8,
                 ATTR2_PALBANK(0) | TILE_PLAYER);
    obj_set_pos(&obj_buffer[SLOT_PLAYER], playing ? sx : 250, playing ? sy : 200);

    for (i = 0; i < NUM_COINS; i++) {
        obj_set_attr(&obj_buffer[SLOT_COIN + i], ATTR0_SQUARE, ATTR1_SIZE_8,
                     ATTR2_PALBANK(1) | TILE_COIN);
        obj_set_pos(&obj_buffer[SLOT_COIN + i],
                    (playing && coins[i].alive) ? (s16)(coins[i].x - cam_x) : 250,
                    (playing && coins[i].alive) ? coins[i].y : 200);
    }

    if (playing) {
        gear_stage((s16)(gear_wx - cam_x), gear_wy);
    } else {
        obj_buffer[SLOT_GEAR].attr0 = ATTR0_HIDE;   /* REGULAR + hide (footgun 3) */
    }
}

int main(void) {
    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * Init order: tiles/palettes → oam_init → irq_init + II_VBLANK →
     * TTE init → DISPCNT last. VBlankIntrWait() HANGS FOREVER without the
     * vblank IRQ registered (the #1 "frozen on frame 1" cause), and
     * enabling DISPCNT layers before their tiles/maps exist flashes garbage.
     * TTE owns BG1 (CBB 2 / SBB 30) — keep other layers off those blocks.
     * requires: nothing prior; this IS the boot. */
    tonccpy(&tile_mem[4][TILE_PLAYER], tile_player, sizeof(tile_player));
    tonccpy(&tile_mem[4][TILE_COIN],   tile_coin,   sizeof(tile_coin));
    gear_build_tiles();
    pal_obj_bank[0][1] = RGB15(31, 31, 31);   /* player eyes white   */
    pal_obj_bank[0][3] = RGB15(28, 8, 8);     /* player red          */
    pal_obj_bank[1][2] = RGB15(28, 24, 6);    /* coin gold           */
    pal_obj_bank[1][4] = RGB15(31, 31, 18);   /* coin shine          */

    build_level();                     /* regular BG0: tiles + 64x32 map      */
    oam_init(obj_buffer, 128);         /* hides all 128, matrices = identity  */

    irq_init(NULL);
    irq_add(II_VBLANK, NULL);

    sfx_init();                        /* APU on; music loop ticks below      */

    /* TTE text on BG1 (4bpp char block 2, screenblock 30), priority 0 so
     * text draws over everything. Mode 0 = all four BGs regular/tiled. */
    tte_init_chr4c_default(1, BG_CBB(2) | BG_SBB(30));
    REG_BG1CNT |= BG_PRIO(0);
    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0 | DCNT_BG1 | DCNT_OBJ | DCNT_OBJ_1D;

    hiscore = hiscore_load();          /* cartridge SRAM — 0 on first boot    */
    enter_title();

    while (1) {
        /* Idiomatic Tonc heartbeat: wait vblank, poll keys, update, then
         * commit OAM + affine slot while still inside vblank (the whole
         * update is far quicker than the 4.9ms vblank window). */
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

        /* The 64x32 map is exactly 512 px wide and WRAPS in hardware, so
         * masking cam_x to 9 bits makes the level loop seamlessly under an
         * ever-growing camera. */
        if (state == ST_PLAY) REG_BG0HOFS = (u16)(cam_x & 511);
        else                  REG_BG0HOFS = 0;

        stage_sprites();
        oam_copy(oam_mem, obj_buffer, 128);  /* sprites AND affine slot 0 */
    }
    return 0;
}
