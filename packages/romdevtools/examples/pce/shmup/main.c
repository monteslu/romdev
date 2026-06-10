/* ── main.c — PC Engine vertical shooter (complete example game) ─────────────
 *
 * A COMPLETE, working game — title screen, lives, score + persistent hi-score
 * (BRAM backup memory), music + SFX, enemy waves, and the PCE's signature
 * hardware feature: LARGE MULTI-SPRITE OBJECTS. The boss is a 64x32 war
 * machine built from two 32x32 HuC6270 sprites that move as one unit — the
 * kind of object that needs 8+ hardware sprites on the NES and exactly TWO
 * SATB entries here.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented PCE footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — enemy patterns, scoring, tuning, art: reshape freely.
 *
 * What depends on what:
 *   pce_hw.h / pce_video.c / pce_input.c / pce_sound.c — the helper lib
 *     (VDC/VCE/PSG register dances + joypad). The HARDWARE IDIOM markers in
 *     pce_video.c say which parts are load-bearing.
 *   cc65's pce crt0 + pce.lib are auto-linked; the 'rom32k' linker preset
 *     (applied automatically to example projects) gives a 32KB HuCard.
 *
 * SINGLE PLAYER, honestly: the stock PC Engine has ONE controller port;
 * 2P needs a TurboTap. The geargrafx core implements the TurboTap but ships
 * with it disabled (a core option, no headless override today), so a second
 * pad's input never reaches the game — verified by scanning all 5 multitap
 * slots while driving port-1 input. This game is therefore 1P by design.
 *
 * Frame budget (NTSC, 60fps, 7.16MHz 65C02-class CPU): the whole update
 * (6 bullets × 6 enemies + 6 × boss AABB ≈ 42 checks worst case, plus a
 * 256-word SATB copy in vblank) fits comfortably inside one frame.
 */
#include <pce.h>
#include "pce_hw.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "ORBIT SIEGE"

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * VRAM map (WORD addresses — the VDC is a 16-bit-word machine; a tile is 16
 * words, a 16x16 sprite cell is 64). Sprites and BG tiles share one 64KB
 * VRAM, so lay it out ONCE and keep the SATB out of pattern space:
 *   $0000  BAT (32x32 background map — matches vdc_init's VDC_MWR setting)
 *   $1000  font glyphs (38 tiles: blank, 0-9, A-Z, dash)
 *   $1400  starfield BG tiles
 *   $1800  16x16 sprite cells: ship, bullet, enemy
 *   $1900  BOSS pattern cells — 4-ALIGNED cell index (see the boss idiom)
 *   $7F00  shadow SATB destination (satb_dma copies it here, VDC reads it) */
#define BAT_VRAM     0x0000
#define FONT_VRAM    0x1000
#define STAR0_VRAM   0x1400   /* deep-space band tile (solid colour 1)       */
#define STAR1_VRAM   0x1410   /* lighter band tile    (solid colour 2)       */
#define STAR2_VRAM   0x1420   /* band tile + a twinkling star pixel          */
#define SHIP_VRAM    0x1800
#define BULLET_VRAM  0x1840
#define ENEMY_VRAM   0x1880
#define BOSS_VRAM    0x1900   /* 8 cells: left half TL,TR,BL,BR + right half */

#define BAT_ENTRY(pal, vram)  ((u16)(((pal) << 12) | ((vram) >> 4)))

/* Sprite pattern codes = VRAM >> 6 (the 16x16 cell index). */
#define SHIP_PAT    (SHIP_VRAM >> 6)
#define BULLET_PAT  (BULLET_VRAM >> 6)
#define ENEMY_PAT   (ENEMY_VRAM >> 6)
#define BOSSL_PAT   (BOSS_VRAM >> 6)          /* 0x64 — multiple of 4        */
#define BOSSR_PAT   ((BOSS_VRAM >> 6) + 4)    /* 0x68 — multiple of 4        */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Object pools — fixed slots, no allocation. SATB slot plan (slot order is
 * also priority: LOWER slot wins overlaps on the HuC6270):
 *   0      player ship
 *   1-6    bullets
 *   7-12   enemies (waves + boss drones share the pool)
 *   14,15  the boss's two 32x32 halves
 * Everything else stays parked off-screen. */
#define MAX_BULLETS 6
#define MAX_ENEMIES 6
#define SLOT_SHIP   0
#define SLOT_BULLET 1
#define SLOT_ENEMY  7
#define SLOT_BOSS_L 14
#define SLOT_BOSS_R 15

#define PAL_SHIP    0
#define PAL_BULLET  1
#define PAL_ENEMY   2
#define PAL_BOSS    3

#define START_LIVES 3
#define SHIP_MIN_Y  80    /* keeps the ship out of the boss's altitude       */
#define OFFSCREEN_Y 0x1F0 /* park unused sprites below the display           */

typedef struct { u16 x, y; u8 alive; } Obj;

static Obj player;
static Obj bullets[MAX_BULLETS];
static Obj enemies[MAX_ENEMIES];
static u16 score, hiscore;
static u8  lives;
static u8  level;          /* +1 per boss defeated — feeds speed/HP          */
static u8  kills;          /* kills since the last boss — triggers the next  */
static u8  invuln;         /* post-hit mercy frames (ship flickers)          */
static u8  fire_cd;
static u8  spawn_timer;
static u8  twinkle_timer;
static u16 rng;
static u8  pad, prev_pad;
static u8  sfx_timer;
static u8  hud_dirty;

/* Boss state: ONE logical object that happens to be two hardware sprites. */
static u8  boss_active;
static u16 boss_x, boss_y;
static u8  boss_dir;
static u8  boss_hp;
static u8  boss_flash;     /* hit feedback: swap palette for a few frames    */
static u8  boss_shot_timer;

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static u8 state;

static u16 tile_buf[16];   /* scratch for one 8x8 tile                       */
static u16 spr_buf[64];    /* scratch for one 16x16 sprite cell              */

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

/* ── GAME LOGIC (clay) — sprite masks (16 rows × 16 bits, bit15 leftmost) ── */
static const u16 ship_mask[16] = {
    0x0180, 0x0180, 0x03C0, 0x03C0, 0x07E0, 0x07E0, 0x0FF0, 0x0FF0,
    0x1FF8, 0x1FF8, 0x3FFC, 0x7FFE, 0xFFFF, 0xE187, 0xC003, 0x8001
};
static const u16 bullet_mask[16] = {
    0x0000, 0x0180, 0x03C0, 0x03C0, 0x07E0, 0x07E0, 0x07E0, 0x07E0,
    0x07E0, 0x07E0, 0x03C0, 0x03C0, 0x0180, 0x0000, 0x0000, 0x0000
};
static const u16 enemy_mask[16] = {
    0x0000, 0x4002, 0x6006, 0x7FFE, 0x7FFE, 0xFDBF, 0xFFFF, 0xFFFF,
    0xFFFF, 0x7FFE, 0x3FFC, 0x1FF8, 0x300C, 0x6006, 0x4002, 0x0000
};

/* ── GAME LOGIC (clay) — the boss's LEFT half (32x32). 2 u16 per row
 * (cols 0-15, cols 16-31). The right half is this art MIRRORED at upload
 * time — symmetric bosses cost half the data. body = hull (colour 1);
 * core = the glowing eye + cannon tips (colour 3, a subset of body). */
static const u16 boss_body[64] = {
    0x0000,0x0000, 0x0000,0x001F, 0x0000,0x007F, 0x0000,0x00FF,
    0x0000,0x01FF, 0x0000,0x7FFF, 0x0003,0xFFFF, 0x001F,0xFFFF,
    0x007F,0xFFFF, 0x01FF,0xFFFF, 0x07FF,0xFFFF, 0x0FFF,0xFFFF,
    0x1FFF,0xFFFF, 0x1FFF,0xFFFF, 0x3FFF,0xFFFF, 0x3FFF,0xFFFF,
    0x3FFF,0xFFFF, 0x3FFF,0xFFFF, 0x3FFF,0xFFFF, 0x3FFF,0xFFFF,
    0x3FFF,0xFFFF, 0x3FFF,0xFFFF, 0x3FFF,0xFFFF, 0x1FFF,0xFFFF,
    0x1FFF,0xEFFF, 0x0FF3,0xEFFF, 0x07E0,0x6FFF, 0x0000,0x01FF,
    0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000,
};
static const u16 boss_core[64] = {
    0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000,
    0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000,
    0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000, 0x0000,0x000F,
    0x0000,0x001F, 0x0000,0x003F, 0x0000,0x003F, 0x0000,0x003F,
    0x0000,0x003F, 0x0000,0x003F, 0x03C0,0x003F, 0x03C0,0x001F,
    0x07E0,0x000F, 0x03C0,0x0000, 0x03C0,0x0000, 0x0000,0x0000,
    0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000,
    0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000, 0x0000,0x0000,
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

/* mirror a 16-bit row (bit15 <-> bit0) for the boss's right half */
static u16 rev16(u16 v) {
    u16 out = 0;
    u8 i;
    for (i = 0; i < 16; ++i) {
        out <<= 1;
        if (v & 1) out |= 1;
        v >>= 1;
    }
    return out;
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * LARGE-SPRITE PATTERN LAYOUT — the half of the boss trick that lives in
 * VRAM. A 32x32 HuC6270 sprite is FOUR 16x16 cells (64 words each) stored
 * consecutively in TL, TR, BL, BR order, and its SATB pattern code must be
 * 4-ALIGNED (the hardware ignores the low 2 bits and adds them back as
 * column/row). Get the order wrong and the boss renders scrambled — four
 * recognizable quarters in the wrong places. The other half of the trick
 * (the SATB attribute bits) is in push_sprites() below.
 *
 * requires: BOSS_VRAM >> 6 a multiple of 4; 8 consecutive free cells
 *           (512 words) at BOSS_VRAM; set_sprite_ex() from pce_video.c. */
static void upload_boss(void) {
    u8 half, cr, cc, row;
    u16 body_bits, core_bits;
    u16 vram = BOSS_VRAM;
    for (half = 0; half < 2; ++half) {            /* 0 = left, 1 = right     */
        for (cr = 0; cr < 2; ++cr) {              /* cell row (top/bottom)   */
            for (cc = 0; cc < 2; ++cc) {          /* cell col (left/right)   */
                for (row = 0; row < 64; ++row) spr_buf[row] = 0;
                for (row = 0; row < 16; ++row) {
                    u8 y = (u8)(cr * 16 + row);
                    if (half == 0) {              /* left half: stored art   */
                        body_bits = boss_body[y * 2 + cc];
                        core_bits = boss_core[y * 2 + cc];
                    } else {                      /* right half: mirrored    */
                        body_bits = rev16(boss_body[y * 2 + (1 - cc)]);
                        core_bits = rev16(boss_core[y * 2 + (1 - cc)]);
                    }
                    /* hull pixels = colour 1 (plane0), eye/cannon core =
                     * colour 3 (planes 0+1) — core is a subset of body.   */
                    spr_buf[row]      = body_bits;
                    spr_buf[row + 16] = core_bits;
                }
                load_tiles(vram, spr_buf, 64);
                vram += 64;                       /* next cell: TL,TR,BL,BR  */
            }
        }
    }
}

static void upload_art(void) {
    upload_font();
    make_solid_tile(tile_buf, 1); load_tiles(STAR0_VRAM, tile_buf, 16);
    make_solid_tile(tile_buf, 2); load_tiles(STAR1_VRAM, tile_buf, 16);
    make_solid_tile(tile_buf, 1); tile_buf[2] |= 0x0010; tile_buf[2 + 8] = 0x0010;
    load_tiles(STAR2_VRAM, tile_buf, 16);         /* band + colour-3 star px */
    make_sprite16(SHIP_VRAM,   ship_mask,   1);
    make_sprite16(BULLET_VRAM, bullet_mask, 1);
    make_sprite16(ENEMY_VRAM,  enemy_mask,  1);
    upload_boss();
}

/* ── GAME LOGIC (clay) — BAT text + starfield ─────────────────────────────── */
static void put_glyph(u8 col, u8 row, u8 glyph) {
    u16 e = BAT_ENTRY(1, (u16)(FONT_VRAM + glyph * 16));  /* pal 1 = white   */
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

/* banded starfield over the whole 32x32 BAT (two band colours + sparse
 * twinkle tiles — the bands keep the screen from being one flat colour) */
static void draw_starfield(void) {
    u8 r, c;
    u16 e0 = BAT_ENTRY(0, STAR0_VRAM);
    u16 e1 = BAT_ENTRY(0, STAR1_VRAM);
    u16 e2 = BAT_ENTRY(0, STAR2_VRAM);
    u16 e;
    for (r = 0; r < 32; ++r) {
        vram_set_write_addr((u16)(BAT_VRAM + r * 32));
        for (c = 0; c < 32; ++c) {
            e = (r & 2) ? e1 : e0;
            if (((r * 7 + c * 5) & 7) == 0) e = e2;
            VDC_DATA_LO = (u8)(e & 0xFF);
            VDC_DATA_HI = (u8)(e >> 8);
        }
    }
}

/* HUD: row 1 = "SC 00000  HI 00000  SH 3" */
static void draw_hud_labels(void) {
    draw_text(1, 1, "SC");
    draw_text(12, 1, "HI");
    draw_text(23, 1, "SH");
}

static void draw_hud_numbers(void) {
    draw_num5(4, 1, score);
    draw_num5(15, 1, hiscore);
    put_glyph(26, 1, (u8)(G_DIGIT + lives));
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * BRAM hi-score persistence. The PCE's battery save is the 2KB "backup RAM"
 * at BANK $F7 (the Tennokoe / CD-interface memory) — geargrafx exposes it as
 * the libretro save_ram region, so it persists across power cycles. Two
 * dances are required, and both are footguns:
 *
 *   1. BANK MAPPING. BRAM is not in the CPU's address space until you TAM
 *      bank $F7 into a free MPR slot. cc65's inline asm() only knows 6502
 *      mnemonics — TAM/TMA are HuC6280-only and it REJECTS them — so the two
 *      5-byte mapper thunks below are hand-assembled machine code in RAM
 *      arrays, called through a function pointer:
 *        A9 F7   LDA #$F7
 *        53 04   TAM #%00000100   ; MPR2: $4000-$5FFF = bank $F7 (BRAM)
 *        60      RTS
 *      (MPR2 is free here: cc65's crt0 only assigns MPR0/1/4-7.)
 *   2. THE WRITE LOCK. BRAM powers up WRITE-PROTECTED. Writes are silently
 *      discarded until you store $80 to $1807; store $00 to re-lock after.
 *      Forgetting the unlock is the classic "my save never sticks" bug.
 *
 * Real BRAM is SHARED by every CD-era game and managed by the System Card
 * BIOS as a directory ('HUBM' header + per-game entries). A HuCard homebrew
 * has no BIOS to call, so this example keeps one fixed checksummed record at
 * a fixed offset instead — honest and verifiable, but DON'T ship that scheme
 * on real hardware next to CD saves you care about.
 *
 * requires: nothing else touches MPR2; record layout below.              */
static unsigned char bram_map_thunk[5]   = { 0xA9, 0xF7, 0x53, 0x04, 0x60 };
static unsigned char bram_unmap_thunk[5] = { 0xA9, 0xF8, 0x53, 0x04, 0x60 };

#define BRAM_LOCK_REG (*(volatile u8 *)0x1807)
#define BRAM_BASE     ((volatile u8 *)0x4000)
/* record: offset 16 = 'O','S', score lo, score hi, checksum (lo^hi^0xA5) */
#define HS_OFF 16

static void bram_map(void)   { ((void (*)(void))bram_map_thunk)(); }
static void bram_unmap(void) { ((void (*)(void))bram_unmap_thunk)(); }

static u16 hiscore_load(void) {
    u16 v = 0;
    bram_map();
    if (BRAM_BASE[HS_OFF] == 'O' && BRAM_BASE[HS_OFF + 1] == 'S' &&
        BRAM_BASE[HS_OFF + 4] == (u8)(BRAM_BASE[HS_OFF + 2] ^ BRAM_BASE[HS_OFF + 3] ^ 0xA5)) {
        v = (u16)(BRAM_BASE[HS_OFF + 2] | (BRAM_BASE[HS_OFF + 3] << 8));
    }
    bram_unmap();
    return v;
}

static void hiscore_save(u16 v) {
    bram_map();
    BRAM_LOCK_REG = 0x80;                  /* unlock writes — see footgun #2 */
    BRAM_BASE[HS_OFF]     = 'O';
    BRAM_BASE[HS_OFF + 1] = 'S';
    BRAM_BASE[HS_OFF + 2] = (u8)(v & 0xFF);
    BRAM_BASE[HS_OFF + 3] = (u8)(v >> 8);
    BRAM_BASE[HS_OFF + 4] = (u8)((v & 0xFF) ^ (v >> 8) ^ 0xA5);
    BRAM_LOCK_REG = 0x00;                  /* re-lock                        */
    bram_unmap();
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
static const u8 MEL_TITLE[16] = { C4,E4,G4,C5, B4,G4,E4,G4, A3,C4,E4,A4, G4,E4,D4,B3 };
static const u8 BAS_TITLE[8]  = { C3,C3, A2N,A2N, F3,F3, G3,G3 };
static const u8 MEL_PLAY[16]  = { E4,R,E4,G4, A4,G4,E4,D4, C4,D4,E4,G4, E4,D4,C4,R  };
static const u8 BAS_PLAY[8]   = { A2N,A2N, F3,F3, C3,C3, G3,G3 };
static const u8 MEL_OVER[16]  = { C5,R,B4,R, A4,R,G4,R, E4,R,D4,R, C4,R,R,R };

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
    if (music_timer >= 8) music_timer = 0;
}

/* ── GAME LOGIC (clay) — helpers ──────────────────────────────────────────── */
static u16 next_rand(void) {
    rng = (u16)(rng * 25173u + 13849u);
    return rng;
}

static u8 aabb(u16 ax, u16 ay, u16 aw, u16 ah, u16 bx, u16 by, u16 bw, u16 bh) {
    return (u8)(ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by);
}

static void fire(void) {
    u8 i;
    for (i = 0; i < MAX_BULLETS; ++i) {
        if (!bullets[i].alive) {
            bullets[i].x = player.x;
            bullets[i].y = (u16)(player.y - 10);
            bullets[i].alive = 1;
            psg_tone(2, 0x180, 31);
            sfx_timer = 4;
            return;
        }
    }
}

static void spawn_enemy(u16 x, u16 y) {
    u8 i;
    for (i = 0; i < MAX_ENEMIES; ++i) {
        if (!enemies[i].alive) {
            enemies[i].x = x;
            enemies[i].y = y;
            enemies[i].alive = 1;
            return;
        }
    }
}

/* ── GAME LOGIC (clay) — screen painters (full repaint per state change) ── */
static void paint_title(void) {
    draw_starfield();
    draw_text((u8)((32 - (sizeof(GAME_TITLE) - 1)) / 2), 8, GAME_TITLE);
    draw_text(10, 14, "PRESS RUN");
    draw_text(11, 18, "HI");
    draw_num5(14, 18, hiscore);
    draw_text(7, 22, "BOSS EVERY 10 KILLS");
}

static void paint_field(void) {
    draw_starfield();
    draw_hud_labels();
    draw_hud_numbers();
}

static void start_game(void) {
    u8 i;
    for (i = 0; i < MAX_BULLETS; ++i) bullets[i].alive = 0;
    for (i = 0; i < MAX_ENEMIES; ++i) enemies[i].alive = 0;
    player.x = 120; player.y = 192; player.alive = 1;
    lives = START_LIVES;
    score = 0;
    level = 0;
    kills = 0;
    invuln = 0;
    fire_cd = 0;
    spawn_timer = 0;
    boss_active = 0;
    boss_flash = 0;
    paint_field();
    music_set(ST_PLAY);
    state = ST_PLAY;
}

static void game_over(void) {
    if (score > hiscore) {
        hiscore = score;
        hiscore_save(hiscore);             /* BRAM — survives a power cycle  */
    }
    draw_text(11, 12, "GAME OVER");
    draw_text(10, 14, "PRESS RUN");
    music_set(ST_OVER);
    state = ST_OVER;
}

static void boss_enter(void) {
    boss_active = 1;
    boss_x = 96;
    boss_y = 24;
    boss_dir = 1;
    boss_hp = (u8)(10 + level * 4);
    if (boss_hp > 30) boss_hp = 30;
    boss_shot_timer = 0;
}

static void boss_die(void) {
    boss_active = 0;
    boss_flash = 0;
    if (score < 60000) score += 500;
    ++level;
    kills = 0;
    hud_dirty = 1;
    psg_tone(3, 0x600, 31);                /* low rumble                     */
    sfx_timer = 24;
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
 * THE BOSS (the PCE signature): one logical object, TWO SATB entries. Each
 * half is a 32x32 sprite — SPR_CGX_32|SPR_CGY_32 in the attribute word —
 * placed at (boss_x, boss_y) and (boss_x+32, boss_y). They move as one unit
 * because ONE pair of variables drives both entries; nothing else keeps
 * them glued. A 64x32 boss this way costs 2 sprites of the 64-sprite budget
 * (and 4 of the 16-sprites-per-scanline budget) — the same object on a
 * 8x8/8x16-sprite machine costs 16+. CGY goes to 64 if you want a 32x64
 * tower from a SINGLE entry (SPR_CGY_64, 8-aligned pattern).
 *
 * requires: set_sprite_ex() + the 4-aligned boss cells from upload_boss(). */
static void push_sprites(void) {
    u8 i;
    /* ship (slot 0) — flickers while invulnerable by parking on odd frames */
    if (player.alive && !(invuln & 2)) set_sprite(SLOT_SHIP, player.x, player.y, SHIP_PAT, PAL_SHIP);
    else set_sprite(SLOT_SHIP, player.x, OFFSCREEN_Y, SHIP_PAT, PAL_SHIP);
    for (i = 0; i < MAX_BULLETS; ++i)
        set_sprite((u8)(SLOT_BULLET + i), bullets[i].x,
                   bullets[i].alive ? bullets[i].y : OFFSCREEN_Y, BULLET_PAT, PAL_BULLET);
    for (i = 0; i < MAX_ENEMIES; ++i)
        set_sprite((u8)(SLOT_ENEMY + i), enemies[i].x,
                   enemies[i].alive ? enemies[i].y : OFFSCREEN_Y, ENEMY_PAT, PAL_ENEMY);
    if (boss_active) {
        u8 pal = boss_flash ? PAL_ENEMY : PAL_BOSS;   /* hit = red flash     */
        set_sprite_ex(SLOT_BOSS_L, boss_x, boss_y, BOSSL_PAT, pal,
                      SPR_CGX_32 | SPR_CGY_32);
        set_sprite_ex(SLOT_BOSS_R, (u16)(boss_x + 32), boss_y, BOSSR_PAT, pal,
                      SPR_CGX_32 | SPR_CGY_32);
    } else {
        set_sprite_ex(SLOT_BOSS_L, 0, OFFSCREEN_Y, BOSSL_PAT, PAL_BOSS, SPR_CGX_32 | SPR_CGY_32);
        set_sprite_ex(SLOT_BOSS_R, 0, OFFSCREEN_Y, BOSSR_PAT, PAL_BOSS, SPR_CGX_32 | SPR_CGY_32);
    }
}

/* twinkle: rewrite the star tile's pixel row every 16 frames — animation
 * without touching the BAT (one 16-word upload in vblank) */
static void twinkle(void) {
    u8 phase;
    ++twinkle_timer;
    if ((twinkle_timer & 15) != 0) return;
    phase = (u8)((twinkle_timer >> 4) & 3);
    make_solid_tile(tile_buf, 1);
    tile_buf[phase * 2] |= 0x0010;
    tile_buf[phase * 2 + 8] = 0x0010;
    load_tiles(STAR2_VRAM, tile_buf, 16);
}

/* ── GAME LOGIC (clay) — the per-state updates ────────────────────────────── */
static void hit_ship(void) {
    if (invuln) return;
    psg_tone(3, 0x500, 31);
    sfx_timer = 16;
    if (lives > 0) --lives;
    hud_dirty = 1;
    if (lives == 0) {
        game_over();
        return;
    }
    invuln = 90;
    player.x = 120;
    player.y = 192;
}

static void update_play(void) {
    u8 i, j;

    /* ship */
    if (pad & PCE_JOY_LEFT)  { if (player.x > 2)         player.x -= 3; }
    if (pad & PCE_JOY_RIGHT) { if (player.x < 238)       player.x += 3; }
    if (pad & PCE_JOY_UP)    { if (player.y > SHIP_MIN_Y) player.y -= 2; }
    if (pad & PCE_JOY_DOWN)  { if (player.y < 200)       player.y += 2; }
    if ((pad & PCE_JOY_I) && fire_cd == 0) { fire(); fire_cd = 8; }
    if (fire_cd) --fire_cd;
    if (invuln) --invuln;

    /* bullets */
    for (i = 0; i < MAX_BULLETS; ++i) {
        if (!bullets[i].alive) continue;
        if (bullets[i].y < 14) { bullets[i].alive = 0; continue; }
        bullets[i].y -= 5;
    }

    /* enemies: drift down, faster each level */
    for (i = 0; i < MAX_ENEMIES; ++i) {
        if (!enemies[i].alive) continue;
        enemies[i].y += (u16)(1 + (level >> 1));
        if (enemies[i].y >= 224) enemies[i].alive = 0;
    }

    if (boss_active) {
        /* the boss sways as ONE unit; drones spawn from its eye */
        boss_x += boss_dir ? 1 : -1;
        if (boss_x >= 184) boss_dir = 0;
        if (boss_x <= 8)   boss_dir = 1;
        if (boss_flash) --boss_flash;
        ++boss_shot_timer;
        if (boss_shot_timer >= (u8)(70 - level * 8)) {
            boss_shot_timer = 0;
            spawn_enemy((u16)(boss_x + 24), (u16)(boss_y + 28));
        }
    } else {
        ++spawn_timer;
        if (spawn_timer >= (u8)(40 - level * 4)) {
            spawn_timer = 0;
            spawn_enemy((u16)(8 + (next_rand() >> 8) % 224), 16);
        }
    }

    /* bullets vs enemies + boss */
    for (i = 0; i < MAX_BULLETS; ++i) {
        if (!bullets[i].alive) continue;
        for (j = 0; j < MAX_ENEMIES; ++j) {
            if (!enemies[j].alive) continue;
            if (aabb(bullets[i].x, bullets[i].y, 14, 14,
                     enemies[j].x, enemies[j].y, 14, 14)) {
                bullets[i].alive = 0;
                enemies[j].alive = 0;
                if (score < 60000) score += 10;
                ++kills;
                hud_dirty = 1;
                psg_tone(3, 0x040, 31);
                sfx_timer = 6;
                break;
            }
        }
        if (!bullets[i].alive) continue;
        if (boss_active &&
            aabb(bullets[i].x, bullets[i].y, 14, 14, boss_x, boss_y, 64, 30)) {
            bullets[i].alive = 0;
            boss_flash = 4;
            psg_tone(3, 0x090, 29);
            sfx_timer = 4;
            if (--boss_hp == 0) boss_die();
        }
    }

    /* enemies vs ship */
    for (i = 0; i < MAX_ENEMIES; ++i) {
        if (!enemies[i].alive) continue;
        if (aabb(enemies[i].x, enemies[i].y, 14, 14, player.x, player.y, 14, 14)) {
            enemies[i].alive = 0;
            hit_ship();
            if (state != ST_PLAY) return;
        }
    }

    /* the next boss */
    if (!boss_active && kills >= 10) boss_enter();
}

void main(void) {
    u8 newpad;

    _pce_keep[0] = 0;   /* see the EMPTY-BSS TRAP note in pce_hw.h */

    /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
     * Init order: palette → VRAM uploads → BAT paint → joypad → display ON.
     * disp_enable() also sets the VBlank IRQ bit — without it waitvsync()
     * never returns and the game freezes on its first frame. */
    /* BG sub-pal 0: starfield. BG sub-pal 1: HUD/text (white on band). */
    vce_set_color(0,   PCE_RGB(0, 0, 1));   /* backdrop: near-black blue     */
    vce_set_color(1,   PCE_RGB(0, 0, 3));   /* band A: deep space            */
    vce_set_color(2,   PCE_RGB(1, 1, 4));   /* band B: lighter space         */
    vce_set_color(3,   PCE_RGB(7, 7, 7));   /* star pixel: white             */
    vce_set_color(17,  PCE_RGB(7, 7, 7));   /* text: white                   */
    /* sprite sub-palettes (256 + pal*16 + index) */
    vce_set_color(257, PCE_RGB(2, 6, 7));   /* pal0 c1: ship cyan            */
    vce_set_color(273, PCE_RGB(7, 7, 0));   /* pal1 c1: bullet yellow        */
    vce_set_color(289, PCE_RGB(7, 1, 1));   /* pal2 c1: enemy red            */
    vce_set_color(290, PCE_RGB(7, 1, 1));
    vce_set_color(291, PCE_RGB(7, 5, 2));   /* pal2 c3: red-flash highlight  */
    vce_set_color(305, PCE_RGB(4, 2, 7));   /* pal3 c1: boss hull violet     */
    vce_set_color(307, PCE_RGB(7, 6, 1));   /* pal3 c3: boss eye amber       */

    upload_art();

    hiscore = hiscore_load();   /* BRAM — 0 on first boot / bad checksum     */
    state = ST_TITLE;
    paint_title();
    music_set(ST_TITLE);

    pce_joy_init();
    disp_enable();

    for (;;) {
        waitvsync();

        /* vblank work first: sprites + SATB DMA + queued BAT/VRAM writes */
        push_sprites();
        satb_dma();
        if (hud_dirty && state != ST_TITLE) { draw_hud_numbers(); hud_dirty = 0; }
        twinkle();

        music_tick();
        if (sfx_timer) {
            --sfx_timer;
            if (sfx_timer == 0) { psg_off(2); psg_off(3); }
        }

        pad = pce_joy_read();
        newpad = (u8)(pad & ~prev_pad);
        prev_pad = pad;

        if (state == ST_TITLE) {
            if (newpad & (PCE_JOY_RUN | PCE_JOY_I)) start_game();
            continue;
        }
        if (state == ST_OVER) {
            /* freeze the final frame; RUN (or I) returns to the title */
            if (newpad & (PCE_JOY_RUN | PCE_JOY_I)) {
                state = ST_TITLE;
                paint_title();
                music_set(ST_TITLE);
            }
            continue;
        }
        update_play();
    }
}
