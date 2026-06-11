/* ── puzzle.c — SHALE WELL: Game Boy falling-stone matcher (complete example game) ──
 *
 * A COMPLETE, working game — title screen, persistent battery hi-score
 * (MBC1+RAM+BATTERY SRAM), APU music + SFX, level progression, cascades,
 * and the Game Boy's signature WINDOW-LAYER HUD: a fixed score/hi/level
 * strip pinned to the bottom of the screen.
 *
 * THE GAME: a vertical column of 3 stones falls into an 8-wide x 15-tall
 * well. Move it left/right (D-pad), soft-drop (Down), hard-drop (Start),
 * and CYCLE the three stones (A rolls up, B rolls down). Line up 3+ of one
 * KIND in a row — horizontally, vertically, or diagonally — to clear them;
 * gravity pulls survivors down, which can CHAIN into cascades for bonus
 * score. Every 18th piece is a MAGIC stone that clears every stone of the
 * kind it lands on. SELECT toggles the music. Levels rise as you clear,
 * and each level drops the column faster. This is a 1P marathon: survive,
 * climb the levels, beat the battery-backed record.
 *
 * MONOCHROME, on purpose: the DMG has FOUR shades of grey, no color. The
 * five stone KINDS are five distinct 2bpp TILE SHAPES (a stripe, a checker,
 * a ring, a brick, a diamond) read through the one DMG background palette —
 * the honest handheld take on the GBC's six-color version. You tell stones
 * apart by their PATTERN, the way the great DMG puzzlers did.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented GB footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — board rules, scoring, tuning, art: reshape freely.
 *
 * SINGLE-PLAYER, honestly: the Game Boy's "player 2" is a LINK CABLE, which
 * one emulator instance cannot provide — a single instance cannot emulate
 * the second Game Boy on the other end of that cable. So handheld examples
 * ship a press-start title and a 1P marathon instead of faking a 2P mode
 * the platform cannot deliver. (Consoles' examples have real 2P.)
 *
 * What depends on what:
 *   gb_hardware.h — register names (LCDC/WX/WY/BGP/OBP/NRxx/...) + bit masks.
 *   gb_runtime.{h,c} — vblank wait (HALT-driven), joypad, shadow OAM + the
 *     OAM-DMA-from-HRAM routine, VRAM-safe memcpy, APU helpers.
 *   gb_crt0.s — boot + interrupt vectors + the cartridge header window. It
 *     DECLARES the cart as MBC1+RAM+BATTERY ($0147=$03, $0149=$02): that
 *     header is what makes the SRAM hi-score persist (the GB equivalent of
 *     the NES iNES BATTERY bit).
 *   (No font.h — the 1bpp glyphs are embedded below, so this template
 *    builds with exactly the same includes as the platformer/shmup.)
 *
 * RENDERING — the hard-won architecture (details at each routine below):
 *  - The FALLING column and the NEXT preview are OBJ sprites (OAM), not BG
 *    tiles, so moving them is just an OAM rewrite — no per-frame BG writes.
 *  - The LOCKED well is BG tiles, updated through a COLLECT/FLUSH queue:
 *    collect_well() decides what to write (RAM only); flush_well() writes a
 *    few cells to VRAM as the very first thing in vblank. The whole
 *    per-frame job (OAM DMA + flush) MUST finish inside the ~10-line vblank
 *    window — overrunning into active display silently DROPS writes on this
 *    core. An idle "scrub" continuously repaints the well from the grid so
 *    nothing can drift (the "3 stones that won't clear" bug heals itself).
 *  - The HUD (score / hi-score / level) lives on the WINDOW layer — a fixed
 *    strip at the bottom of the screen, immune to BG scrolling.
 *  - We NEVER toggle the LCD in-game. LCD-off is used only for the
 *    full-screen title <-> game transitions.
 */
#include "gb_hardware.h"
#include "gb_runtime.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "SHALE WELL"

/* ── GAME LOGIC (clay — reshape freely) ── board geometry */
#define COLS      8
#define ROWS      15         /* rows 0-14; floor at map row 15; window HUD rows 16-17 */
#define NCELL     (ROWS * COLS)
#define NKINDS    5          /* stone kinds 1..5 — one tile SHAPE each */

/* BG map cell of interior grid cell (0,0) — the well's top-left corner.
 * Open at the top (row 0); walls one cell outside left/right, floor below. */
#define WELL_MX   1
#define WELL_MY   0

/* BG map column where the right-hand panel (NEXT preview label) starts. */
#define HUD_X     12

#define G(r,c)    grid[((r) * COLS) + (c)]
#define M(r,c)    matched[((r) * COLS) + (c)]

/* Tile slots in the $8000 table. Stones 1..5 are tiles 1..5; T_WALL/T_EMPTY
 * frame the well; T_MAGIC is the magic stone; explosions burst on a clear;
 * FONT_BASE..FONT_BASE+36 are the 0-9 A-Z '-' glyphs (uploaded at boot). */
#define T_EMPTY   0
#define T_S1      1     /* stripe   */
#define T_S2      2     /* checker  */
#define T_S3      3     /* ring     */
#define T_S4      4     /* brick    */
#define T_S5      5     /* diamond  */
#define T_WALL    6
#define T_MAGIC   7
#define T_EXP0    8     /* explosion frames: a stone bursting apart */
#define T_EXP1    9
#define T_EXP2    10
#define FONT_BASE 16    /* 0-9 → 16..25, A-Z → 26..51, '-' → 52 */

#define MAGIC     6     /* grid value of a magic stone in the falling column */

#define ST_TITLE  0
#define ST_PLAY   1
#define ST_OVER   2

/* VRAM tile maps. BG playfield = $9800; the window HUD = $9C00 (offset
 * $400 in the same VRAM pointer — see the WINDOW HUD idiom below). */
#define VRAM ((volatile uint8_t *)0x9800)
#define WIN_OFF   0x400

/* ── GAME LOGIC (clay — reshape freely) ── tile pixel data (2bpp).
 * Each 8x8 tile = 16 bytes, 2 bytes per row (low plane then high plane); a
 * pixel's 2-bit value = (hi<<1)|lo indexes the DMG palette BGP (BG) or
 * OBP0/OBP1 (OBJ). With BGP=$E4 below: 0=white, 1=light grey, 2=dark grey,
 * 3=black. The five stone KINDS are five distinct SHAPES — that's how a
 * 4-shade screen carries five readable "colors". */
static const uint8_t tile_empty[16] = {      /* faint dither (never flat) */
    0x00,0x00, 0x22,0x00, 0x00,0x00, 0x88,0x00,
    0x00,0x00, 0x22,0x00, 0x00,0x00, 0x88,0x00,
};
static const uint8_t tile_s1[16] = {         /* stripe — bold horizontal bars */
    0xFF,0xFF, 0xFF,0xFF, 0x00,0x00, 0x00,0x00,
    0xFF,0xFF, 0xFF,0xFF, 0x00,0x00, 0x00,0x00,
};
static const uint8_t tile_s2[16] = {         /* checker — alternating dark blocks */
    0xCC,0xCC, 0xCC,0xCC, 0x33,0x33, 0x33,0x33,
    0xCC,0xCC, 0xCC,0xCC, 0x33,0x33, 0x33,0x33,
};
static const uint8_t tile_s3[16] = {         /* ring — hollow circle, light fill */
    0x3C,0x3C, 0x42,0x7E, 0x42,0x7E, 0x42,0x7E,
    0x42,0x7E, 0x42,0x7E, 0x42,0x7E, 0x3C,0x3C,
};
static const uint8_t tile_s4[16] = {         /* brick — mortar grid */
    0xFF,0xFF, 0x88,0x88, 0x88,0x88, 0xFF,0xFF,
    0x22,0x22, 0x22,0x22, 0xFF,0xFF, 0x88,0x88,
};
static const uint8_t tile_s5[16] = {         /* diamond — solid lozenge */
    0x18,0x18, 0x3C,0x3C, 0x7E,0x7E, 0xFF,0xFF,
    0xFF,0xFF, 0x7E,0x7E, 0x3C,0x3C, 0x18,0x18,
};
static const uint8_t tile_wall[16] = {       /* solid frame */
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
};
static const uint8_t tile_magic[16] = {      /* star — clears its target kind */
    0x18,0x18, 0x18,0x3C, 0xDB,0xFF, 0x7E,0x7E,
    0x3C,0x3C, 0x7E,0x66, 0xC3,0xC3, 0x81,0x81,
};
/* explosion frames: the stone bursts into a star, fragments fly outward,
 * then sparks, then gone. Shown ONCE, expanding — no blinking. */
static const uint8_t tile_exp0[16] = {
    0x99,0x99, 0x5A,0x5A, 0x3C,0x3C, 0xFF,0xFF,
    0xFF,0xFF, 0x3C,0x3C, 0x5A,0x5A, 0x99,0x99,
};
static const uint8_t tile_exp1[16] = {
    0x81,0x81, 0x42,0x42, 0x24,0x24, 0x18,0x18,
    0x18,0x18, 0x24,0x24, 0x42,0x42, 0x81,0x81,
};
static const uint8_t tile_exp2[16] = {
    0x81,0x81, 0x00,0x00, 0x00,0x00, 0x00,0x00,
    0x00,0x00, 0x00,0x00, 0x00,0x00, 0x81,0x81,
};

/* ── GAME LOGIC (clay — reshape freely) ── 1bpp font (same glyph set as the
 * platformer/shmup — 0-9, A-Z, '-'). Stored 8 bytes/glyph and expanded to
 * 2bpp shade 3 (black) at upload time, so the ROM carries 296 bytes of font
 * instead of 592. */
static const uint8_t font8[37][8] = {
  /* 0-9 */
  {0x3C,0x66,0x6E,0x76,0x66,0x66,0x3C,0x00}, {0x18,0x38,0x18,0x18,0x18,0x18,0x7E,0x00},
  {0x3C,0x66,0x06,0x0C,0x18,0x30,0x7E,0x00}, {0x3C,0x66,0x06,0x1C,0x06,0x66,0x3C,0x00},
  {0x0C,0x1C,0x3C,0x6C,0x7E,0x0C,0x0C,0x00}, {0x7E,0x60,0x7C,0x06,0x06,0x66,0x3C,0x00},
  {0x1C,0x30,0x60,0x7C,0x66,0x66,0x3C,0x00}, {0x7E,0x06,0x0C,0x18,0x30,0x30,0x30,0x00},
  {0x3C,0x66,0x66,0x3C,0x66,0x66,0x3C,0x00}, {0x3C,0x66,0x66,0x3E,0x06,0x0C,0x38,0x00},
  /* A-Z */
  {0x18,0x3C,0x66,0x66,0x7E,0x66,0x66,0x00}, {0x7C,0x66,0x66,0x7C,0x66,0x66,0x7C,0x00},
  {0x3C,0x66,0x60,0x60,0x60,0x66,0x3C,0x00}, {0x78,0x6C,0x66,0x66,0x66,0x6C,0x78,0x00},
  {0x7E,0x60,0x60,0x7C,0x60,0x60,0x7E,0x00}, {0x7E,0x60,0x60,0x7C,0x60,0x60,0x60,0x00},
  {0x3C,0x66,0x60,0x6E,0x66,0x66,0x3E,0x00}, {0x66,0x66,0x66,0x7E,0x66,0x66,0x66,0x00},
  {0x7E,0x18,0x18,0x18,0x18,0x18,0x7E,0x00}, {0x06,0x06,0x06,0x06,0x66,0x66,0x3C,0x00},
  {0x66,0x6C,0x78,0x70,0x78,0x6C,0x66,0x00}, {0x60,0x60,0x60,0x60,0x60,0x60,0x7E,0x00},
  {0x63,0x77,0x7F,0x6B,0x63,0x63,0x63,0x00}, {0x66,0x76,0x7E,0x7E,0x6E,0x66,0x66,0x00},
  {0x3C,0x66,0x66,0x66,0x66,0x66,0x3C,0x00}, {0x7C,0x66,0x66,0x7C,0x60,0x60,0x60,0x00},
  {0x3C,0x66,0x66,0x66,0x6A,0x6C,0x36,0x00}, {0x7C,0x66,0x66,0x7C,0x6C,0x66,0x66,0x00},
  {0x3C,0x66,0x60,0x3C,0x06,0x66,0x3C,0x00}, {0x7E,0x18,0x18,0x18,0x18,0x18,0x18,0x00},
  {0x66,0x66,0x66,0x66,0x66,0x66,0x3C,0x00}, {0x66,0x66,0x66,0x66,0x66,0x3C,0x18,0x00},
  {0x63,0x63,0x63,0x6B,0x7F,0x77,0x63,0x00}, {0x66,0x66,0x3C,0x18,0x3C,0x66,0x66,0x00},
  {0x66,0x66,0x66,0x3C,0x18,0x18,0x18,0x00}, {0x7E,0x06,0x0C,0x18,0x30,0x60,0x7E,0x00},
  /* '-' */
  {0x00,0x00,0x00,0x7E,0x00,0x00,0x00,0x00},
};

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * WRAM layout — keep big board state ABOVE the shadow-OAM page.
 * The OAM-DMA shadow buffer is pinned by the runtime at $C100 (one page,
 * $C100-$C19F). oam_clear() zeros that whole page every... no — oam_clear
 * zeros the 160-byte shadow_oam — but more to the point, the DMA source
 * lives there. SDCC allocates ordinary statics upward from $C000; with the
 * board's three 120-byte arrays that segment would run straight THROUGH
 * $C100 and collide with shadow_oam — the build links fine and then the
 * grid and the sprite table silently corrupt each other at runtime.
 *
 * The fix used here: pin the three big arrays at FIXED addresses ABOVE the
 * shadow-OAM page with `__at`, so the auto-allocated _DATA segment stays a
 * handful of bytes at $C000 and never reaches $C100. (The GBC sister
 * example instead passes dataLoc:0xC200 to its build recipe — same goal,
 * pushing statics above the page. `__at` keeps the choice IN the source so
 * a fork can't lose it to a forgotten build flag, and so this template
 * builds with the plain default-dataLoc recipe the test harness uses.)
 * If you ADD large arrays, place them at $C2xx+ too, or you'll re-introduce
 * the collision. $C200-$DFFF is free work RAM. */
static __at(0xC200) uint8_t grid[NCELL];        /* the well: 0=empty, 1..NKINDS=stone */
static __at(0xC280) uint8_t shadow[NCELL];      /* what's on the BG now (diff redraw) */
static __at(0xC300) uint8_t matched[NCELL];     /* scratch: cells flagged for clearing */

/* ── GAME LOGIC (clay — reshape freely) ── game state (small — auto _DATA) */
static uint8_t piece[3];            /* the 3 falling kinds, top→bottom */
static uint8_t nextp[3];            /* the previewed next column */
static uint8_t piece_x, piece_y;    /* well coords of the falling column's top */
static uint8_t piece_active;        /* a column is currently falling */
static uint8_t piece_magic;         /* the falling column is a MAGIC piece */
static uint8_t next_dirty;          /* NEXT-preview sprites need re-writing */
static uint8_t piece_counter;       /* pieces since last magic (→ magic every 18) */
static uint8_t fall_timer;          /* frames since the column last stepped down */
static uint8_t cur_fall_rate;       /* frames per downward step (lower = faster) */
static uint16_t total_cleared;      /* stones cleared this game (drives level) */
static uint8_t level;
static uint8_t score_d[6];          /* 6-digit BCD score, most significant first */
static uint8_t hi_d[6];             /* 6-digit BCD hi-score (battery SRAM) */
static uint8_t state;               /* ST_TITLE / ST_PLAY / ST_OVER */
static uint8_t chain;               /* cascade depth of the current resolve */
static uint16_t rng = 0xACE1;       /* xorshift PRNG state */

/* the 4 line directions we scan for matches: horizontal, vertical, and the
 * two diagonals (we only walk each line once, from its lowest cell). */
static const int8_t DIRS[4][2] = { {0,1}, {1,0}, {1,1}, {1,-1} };

/* 16-bit xorshift PRNG — kept 16-bit on purpose (sm83 has no fast 32-bit
 * shifts; a wider generator there degenerates toward one value). */
static uint8_t xorshift(void) {
    rng ^= rng << 7;
    rng ^= rng >> 9;
    rng ^= rng << 8;
    return (uint8_t)(rng >> 8);
}

/* fill a 3-stone column with random kinds 1..NKINDS */
static void roll(uint8_t *p) {
    p[0] = 1 + (uint8_t)(xorshift() % NKINDS);
    p[1] = 1 + (uint8_t)(xorshift() % NKINDS);
    p[2] = 1 + (uint8_t)(xorshift() % NKINDS);
}

/* map a stone kind (1..NKINDS, or MAGIC) to its tile slot */
static uint8_t tile_for(uint8_t kind) {
    if (kind == 0) return T_EMPTY;
    if (kind == MAGIC) return T_MAGIC;
    return (uint8_t)(T_S1 + (kind - 1));   /* 1→T_S1 .. 5→T_S5 */
}

/* add to the 6-digit BCD score (score_d[0] = most significant), with carry */
static void add_score(uint16_t amt) {
    uint8_t k, idx;
    uint16_t carry = amt;
    for (k = 0; k < 6; k++) {
        if (carry == 0) break;
        idx = 5 - k;
        carry += score_d[idx];
        score_d[idx] = (uint8_t)(carry % 10);
        carry = carry / 10;
    }
}

/* most-significant-digit-first BCD compare: did this run beat the record? */
static uint8_t score_beats_hi(void) {
    uint8_t i;
    for (i = 0; i < 6; i++) {
        if (score_d[i] > hi_d[i]) return 1;
        if (score_d[i] < hi_d[i]) return 0;
    }
    return 0;
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * BATTERY SRAM hi-score — persistent saves on a Game Boy cart.
 * requires: gb_crt0.s declaring MBC1+RAM+BATTERY in the cartridge header
 *   ($0147=$03, $0149=$02 → 8KB at $A000-$BFFF). With a ROM-only header the
 *   $A000 region is OPEN BUS: writes vanish, reads return garbage, and
 *   nothing tells you why. The header is the save system.
 *
 * The MBC powers up with cart RAM DISABLED (protection against corrupting
 * the battery RAM with stray bus traffic while power rails settle). The
 * $0A-enable dance:
 *   1. write $0A to anywhere in $0000-$1FFF  → RAM enabled
 *   2. read/write $A000-$BFFF                → real battery RAM
 *   3. write $00 to $0000-$1FFF              → RAM disabled again
 * ALWAYS re-disable after access — that's what makes a yanked cartridge /
 * dying battery corrupt at most the bytes mid-write, not the whole save.
 *
 * First boot is GARBAGE, not zeros: battery RAM holds whatever the silicon
 * woke up with. The magic bytes + XOR checksum below are how the load path
 * tells "my save" from "factory noise" — without them a fresh cart shows a
 * junk hi-score like 974382.
 *
 * Save block at $A000: 'H' 'S'  d0 d1 d2 d3 d4 d5  ck
 *   (6 BCD digits, most significant first; ck = d0^..^d5^$A5)
 * No timing constraints — SRAM is not VRAM; access it any time. */
#define SRAM_BASE ((volatile uint8_t *)0xA000)
#define MBC_RAMG  (*(volatile uint8_t *)0x0000)   /* MBC1 RAM-gate register */

static void hiscore_load(void) {
    uint8_t i, ck;
    MBC_RAMG = 0x0A;                          /* enable cart RAM */
    ck = 0xA5;
    for (i = 0; i < 6; i++) ck ^= SRAM_BASE[2 + i];
    if (SRAM_BASE[0] == 'H' && SRAM_BASE[1] == 'S' && SRAM_BASE[8] == ck) {
        for (i = 0; i < 6; i++) {
            hi_d[i] = SRAM_BASE[2 + i];
            if (hi_d[i] > 9) hi_d[i] = 9;     /* belt + braces on a bad digit */
        }
    } else {
        for (i = 0; i < 6; i++) hi_d[i] = 0;  /* first boot / corrupt → 0 */
    }
    MBC_RAMG = 0x00;                          /* ALWAYS re-disable */
}

static void hiscore_save(void) {
    uint8_t i, ck;
    MBC_RAMG = 0x0A;
    SRAM_BASE[0] = 'H';
    SRAM_BASE[1] = 'S';
    ck = 0xA5;
    for (i = 0; i < 6; i++) {
        SRAM_BASE[2 + i] = hi_d[i];
        ck ^= hi_d[i];
    }
    SRAM_BASE[8] = ck;
    MBC_RAMG = 0x00;
}

/* ── GAME LOGIC (clay — reshape freely) ── sound effects.
 * A tiny note sequencer driving square channel 2 directly. Each note has a
 * real volume-decay envelope (NR22) so it fades instead of clicking off (a
 * hard NRx2=0 cut every note sounds like static). sfx_tick() advances one
 * step per frame; multi-note effects become little arpeggios. GB period
 * p ⇒ freq = 131072/(2048-p); higher p = higher note. */
#define P_C4  1548
#define P_G4  1714
#define P_A4  1750
#define P_C5  1797
#define P_E5  1849
#define P_G5  1881
#define P_A5  1899
#define P_C6  1923

/* NR21 duty: 0x40 = 25% (soft), 0x80 = 50% (full). NR22 vol/env byte:
 * (volume<<4)|(0=decay)|envPace — bigger pace = slower fade. */
#define SFX_STEPS 4
static uint16_t sfx_p[SFX_STEPS];
static uint8_t  sfx_v[SFX_STEPS];
static uint8_t  sfx_d[SFX_STEPS];
static uint8_t  sfx_f[SFX_STEPS];
static uint8_t  sfx_n, sfx_i, sfx_t;

static void sfx_tick(void) {
    if (sfx_i >= sfx_n) return;
    if (sfx_t != 0) { sfx_t--; return; }
    NR21 = sfx_d[sfx_i];
    NR22 = sfx_v[sfx_i];
    NR23 = (uint8_t)(sfx_p[sfx_i] & 0xFF);
    NR24 = (uint8_t)(0x80 | (sfx_p[sfx_i] >> 8));   /* trigger (let envelope end it) */
    sfx_t = sfx_f[sfx_i];
    sfx_i++;
}

static void sfx_go(uint8_t n) { sfx_n = n; sfx_i = 0; sfx_t = 0; sfx_tick(); }

static void sfx_move(void) {
    sfx_p[0] = P_A5; sfx_v[0] = 0x81; sfx_d[0] = 0x40; sfx_f[0] = 4;
    sfx_go(1);
}
static void sfx_rotate(void) {
    sfx_p[0] = P_C6; sfx_v[0] = 0x81; sfx_d[0] = 0x40; sfx_f[0] = 4;
    sfx_go(1);
}
static void sfx_drop(void) {
    sfx_p[0] = P_C5; sfx_v[0] = 0xC2; sfx_d[0] = 0x80; sfx_f[0] = 3;
    sfx_p[1] = P_C4; sfx_v[1] = 0xC3; sfx_d[1] = 0x80; sfx_f[1] = 8;
    sfx_go(2);
}
static void sfx_clear(void) {      /* bright ascending C-E-G */
    sfx_p[0] = P_C5; sfx_v[0] = 0xD2; sfx_d[0] = 0x80; sfx_f[0] = 4;
    sfx_p[1] = P_E5; sfx_v[1] = 0xD2; sfx_d[1] = 0x80; sfx_f[1] = 4;
    sfx_p[2] = P_G5; sfx_v[2] = 0xD3; sfx_d[2] = 0x80; sfx_f[2] = 8;
    sfx_go(3);
}
static void sfx_chain(uint8_t n) { /* arpeggio whose top note rises per chain */
    uint16_t top = (uint16_t)(P_C6 + (uint16_t)n * 6);
    if (top > 1980) top = 1980;
    sfx_p[0] = P_E5; sfx_v[0] = 0xD2; sfx_d[0] = 0x80; sfx_f[0] = 3;
    sfx_p[1] = P_G5; sfx_v[1] = 0xD2; sfx_d[1] = 0x80; sfx_f[1] = 3;
    sfx_p[2] = top;  sfx_v[2] = 0xD3; sfx_d[2] = 0x80; sfx_f[2] = 8;
    sfx_go(3);
}
static void sfx_over(void) {       /* slow descending */
    sfx_p[0] = P_A4; sfx_v[0] = 0xC3; sfx_d[0] = 0x80; sfx_f[0] = 10;
    sfx_p[1] = P_G4; sfx_v[1] = 0xC3; sfx_d[1] = 0x80; sfx_f[1] = 10;
    sfx_p[2] = P_C4; sfx_v[2] = 0xC5; sfx_d[2] = 0x80; sfx_f[2] = 24;
    sfx_go(3);
}

/* ── GAME LOGIC (clay — reshape freely) ── background music.
 * A looping square-wave lead on channel 1 (SFX live on channel 2, so they
 * mix and the effects cut through the music). music_tick() plays one melody
 * step every 12 frames, re-triggering ch1 at a steady volume. Toggle on/off
 * with SELECT — defaults ON.
 *
 * The melody is the GB 11-bit period split into low/high BYTE arrays (NR13 +
 * NR14 low 3 bits) — period p ⇒ freq 131072/(2048-p). hi == 0xFF marks a
 * rest. Arpeggios over a C - Am - F - G chord loop, 8 steps each. */
static const uint8_t mel_lo[32] = {
    0x06,0x39,0x59,0x83, 0x59,0x39,0x06,0x00,   /* C E G C6 G E C  - */
    0xD6,0x06,0x39,0x6B, 0x39,0x06,0xD6,0x00,   /* A C E A5 E C A  - */
    0x88,0xD6,0x06,0x44, 0x06,0xD6,0x88,0x00,   /* F A C F5 C A F  - */
    0xB2,0xF7,0x21,0x59, 0x21,0xF7,0xB2,0x00,   /* G B D G5 D B G  - */
};
static const uint8_t mel_hi[32] = {             /* high 3 bits; 0xFF = rest */
    0x07,0x07,0x07,0x07, 0x07,0x07,0x07,0xFF,
    0x06,0x07,0x07,0x07, 0x07,0x07,0x06,0xFF,
    0x06,0x06,0x07,0x07, 0x07,0x06,0x06,0xFF,
    0x06,0x06,0x07,0x07, 0x07,0x06,0x06,0xFF,
};
static uint8_t music_on;
static uint8_t music_idx;
static uint8_t music_timer;

static void music_note(uint8_t idx) {
    uint8_t hi = mel_hi[idx];
    if (hi == 0xFF) { NR12 = 0x00; NR14 = 0x80; return; }   /* rest: silence ch1 */
    NR10 = 0x00;                        /* no sweep */
    NR11 = 0x80;                        /* 50% duty, no length counter */
    NR12 = 0x90;                        /* volume 9, no envelope (steady lead) */
    NR13 = mel_lo[idx];
    NR14 = (uint8_t)(0x80 | hi);        /* trigger + freq high bits */
}

static void music_tick(void) {
    if (!music_on) return;
    if (music_timer == 0) {
        music_note(music_idx);
        music_timer = 12;
        if (++music_idx >= 32) music_idx = 0;
    }
    music_timer--;
}

static void music_toggle(void) {
    music_on = (uint8_t)(!music_on);
    music_idx = 0;
    music_timer = 0;
    if (!music_on) { NR12 = 0x00; NR14 = 0x80; }   /* kill the lead immediately */
}

/* ── GAME LOGIC (clay — reshape freely) ── board mechanics */

/* is grid cell (r,col) off the bottom or already filled? */
static uint8_t cell_blocked(uint8_t r, uint8_t col) {
    if (r >= ROWS) return 1;
    return grid[(uint8_t)(r * COLS + col)] ? 1 : 0;
}

/* would the 3-tall falling column collide if its top cell were at (col,topy)?
 * Checks are unrolled (not a loop) — short indexed-read loops can miscompile on
 * sm83, and this is the hottest correctness check in the game. */
static uint8_t collides(uint8_t col, uint8_t topy) {
    if (col >= COLS) return 1;
    if (cell_blocked(topy, col)) return 1;
    if (cell_blocked((uint8_t)(topy + 1), col)) return 1;
    if (cell_blocked((uint8_t)(topy + 2), col)) return 1;
    return 0;
}

static void game_over(void);

/* start a new falling column at the top-center. Every 18th piece is a MAGIC
 * column; otherwise take the previewed kinds and roll the next preview. If
 * it can't even appear, the well is full → game over. */
static void spawn(void) {
    rng ^= DIV;
    if (++piece_counter >= 18) {
        piece_counter = 0;
        piece_magic = 1;
        piece[0] = MAGIC; piece[1] = MAGIC; piece[2] = MAGIC;
    } else {
        piece_magic = 0;
        piece[0] = nextp[0]; piece[1] = nextp[1]; piece[2] = nextp[2];
        roll(nextp);
    }
    piece_x = COLS / 2 - 1;
    piece_y = 0;
    piece_active = 1;
    fall_timer = 0;
    next_dirty = 1;
    if (collides(piece_x, piece_y)) game_over();
}

/* Flag every stone that's part of a run of 3+ same-kind cells in any of the
 * 4 directions, into matched[]; return how many cells were flagged. Each line
 * is counted from its lowest end only (we skip a cell if its predecessor in
 * that direction is the same kind), so runs aren't double-walked. */
static uint8_t mark_and_count(void) {
    uint8_t r, c, d, len, cnt, col, k;
    int8_t dr, dc;
    int16_t sr, sc;

    for (r = 0; r < NCELL; r++) matched[r] = 0;

    for (r = 0; r < ROWS; r++) {
        for (c = 0; c < COLS; c++) {
            col = G(r, c);
            if (col == 0) continue;
            for (d = 0; d < 4; d++) {
                dr = DIRS[d][0];
                dc = DIRS[d][1];
                sr = (int16_t)r - dr;
                sc = (int16_t)c - dc;
                if (sr >= 0 && sr < ROWS && sc >= 0 && sc < COLS
                    && G(sr, sc) == col) continue;
                len = 1;
                sr = (int16_t)r + dr;
                sc = (int16_t)c + dc;
                while (sr >= 0 && sr < ROWS && sc >= 0 && sc < COLS
                       && G(sr, sc) == col) {
                    len++;
                    sr += dr;
                    sc += dc;
                }
                if (len >= 3) {
                    sr = (int16_t)r;
                    sc = (int16_t)c;
                    for (k = 0; k < len; k++) {
                        M(sr, sc) = 1;
                        sr += dr;
                        sc += dc;
                    }
                }
            }
        }
    }

    cnt = 0;
    for (r = 0; r < NCELL; r++) if (matched[r]) cnt++;
    return cnt;
}

/* empty every flagged cell */
static void clear_marked(void) {
    uint8_t i;
    for (i = 0; i < NCELL; i++) if (matched[i]) grid[i] = 0;
}

/* collapse each column so all stones rest on the floor with no gaps */
static void apply_gravity(void) {
    uint8_t c, r, n, w;
    uint8_t buf[ROWS];
    for (c = 0; c < COLS; c++) {
        n = 0;
        for (r = 0; r < ROWS; r++)
            if (G(r, c)) { buf[n] = G(r, c); n++; }
        for (r = 0; r < (uint8_t)(ROWS - n); r++) G(r, c) = 0;
        w = 0;
        for (r = (uint8_t)(ROWS - n); r < ROWS; r++) { G(r, c) = buf[w]; w++; }
    }
}

/* level rises every 15 cleared stones (capped at 13); each level shortens
 * the frames-per-row fall interval, so the column drops faster. */
static void update_level(void) {
    level = (uint8_t)(total_cleared / 15);
    if (level > 13) level = 13;
    cur_fall_rate = 32 - level * 2;
    if (cur_fall_rate < 4) cur_fall_rate = 4;
}

/* Matched stones burst apart before they clear — a one-shot expanding star
 * (no blinking, no LCD-off). Only ever runs on a real match. Direct vblank
 * writes (no contending OAM DMA, so plenty of room); blocks ~6 frames, which
 * is the satisfying beat. */
static void explode_matched(void) {
    uint8_t i, j, n, tile;
    uint16_t offs[8];
    uint8_t *o = (uint8_t *)0xC100;
    for (i = 0; i < 12; i++) *o++ = 0;             /* hide the falling-piece sprites */
    ((void (*)(uint8_t))0xFF80)(0xC1);
    n = 0;
    for (i = 0; i < NCELL && n < 8; i++) {
        if (matched[i]) {
            offs[n] = (uint16_t)(WELL_MY + (i >> 3)) * 32 + WELL_MX + (i & 7);
            n++;
        }
    }
    for (j = 0; j < 9; j++) {
        tile = (j < 3) ? T_EXP0 : (j < 6) ? T_EXP1 : T_EXP2;
        wait_vblank();
        sfx_tick();
        music_tick();
        for (i = 0; i < n; i++) VRAM[offs[i]] = tile;
    }
}

/* Settle the board after a lock: repeatedly find matches, burst+clear them,
 * score, and apply gravity — looping so cascades chain. Score per clear
 * scales with level and (for 2nd+ cascades) the chain depth. */
static void resolve_board(void) {
    uint8_t n;
    uint16_t amt, mult;
    chain = 0;
    while (1) {
        n = mark_and_count();
        if (n == 0) break;
        chain++;
        sfx_chain(chain);
        explode_matched();
        clear_marked();
        mult = (uint16_t)(10 + level * 2);
        amt = (uint16_t)n * mult;
        if (chain > 1) amt = amt * chain;
        if (amt > 60000) amt = 60000;
        add_score(amt);
        total_cleared += n;
        apply_gravity();
    }
    update_level();
}

/* MAGIC column: clears every stone sharing the kind of whatever it landed
 * on, then resolves any resulting cascades. */
static void magic_clear(void) {
    uint8_t below = (uint8_t)(piece_y + 3);
    uint8_t target, i;
    uint16_t cleared = 0;
    piece_active = 0;
    if (below < ROWS) {
        target = G(below, piece_x);
        if (target != 0 && target != MAGIC) {
            for (i = 0; i < NCELL; i++)
                if (grid[i] == target) { grid[i] = 0; cleared++; }
            if (cleared) {
                add_score((uint16_t)cleared * 20u);
                total_cleared += cleared;
                sfx_clear();
            }
            apply_gravity();
        }
    }
    resolve_board();
}

/* Stamp the falling column into the grid where it came to rest, then
 * resolve. A magic column takes its own path. */
static void lock_and_resolve(void) {
    uint8_t i, r;
    if (piece_magic) { magic_clear(); return; }
    for (i = 0; i < 3; i++) {
        r = (uint8_t)(piece_y + i);
        if (r < ROWS) G(r, piece_x) = piece[i];
    }
    piece_active = 0;
    resolve_board();
}

/* ── rendering ─────────────────────────────────────────────────────── */
/* copy one 16-byte 2bpp tile into VRAM tile slot `slot` ($8000 + slot*16) */
static void upload_tile(uint8_t slot, const uint8_t *src) {
    /* memcpy_vram (pointer-walk) — NOT an indexed dst[i]=src[i] loop, which
     * SDCC sm83 miscompiles when dst points into VRAM ($8000-$9FFF). */
    memcpy_vram((uint8_t *)(0x8000 + (uint16_t)slot * 16), src, 16);
}

/* expand the 1bpp font into VRAM as 2bpp shade-3 glyphs (both planes set) */
static void upload_font(void) {
    uint8_t *dst = (uint8_t *)(0x8000 + (uint16_t)FONT_BASE * 16);
    uint8_t g, r, bits;
    for (g = 0; g < 37; g++) {
        for (r = 0; r < 8; r++) {
            bits = font8[g][r];
            *dst++ = bits;          /* low plane  ─┐ both set → shade 3 (black) */
            *dst++ = bits;          /* high plane ─┘ */
        }
    }
}

/* The falling column = sprites 0-2; the NEXT preview = sprites 3-5. Then
 * flush OAM. MUST be the first VRAM/OAM work after wait_vblank: the OAM DMA
 * has to land in vblank, or sprites tear on a fixed scanline near the top. */
static void update_sprites(void) {
    /* Write shadow_oam ($C100) directly with a walking pointer — calling
     * oam_set() six times burns ~10 scanlines of vblank (SDCC call
     * overhead), starving the BG flush. Inlined it's ~2 lines. */
    uint8_t *o = (uint8_t *)0xC100;
    uint8_t i, t0, t1, t2, sx, sy;
    if (piece_active) {
        if (piece_magic) { t0 = t1 = t2 = T_MAGIC; }
        else { t0 = tile_for(piece[0]); t1 = tile_for(piece[1]); t2 = tile_for(piece[2]); }
        sx = (uint8_t)((WELL_MX + piece_x) * 8 + 8);
        sy = (uint8_t)((WELL_MY + piece_y) * 8 + 16);
        *o++ = sy;                 *o++ = sx; *o++ = t0; *o++ = 0;
        *o++ = (uint8_t)(sy + 8);  *o++ = sx; *o++ = t1; *o++ = 0;
        *o++ = (uint8_t)(sy + 16); *o++ = sx; *o++ = t2; *o++ = 0;
    } else {
        for (i = 0; i < 12; i++) *o++ = 0;
    }
    /* NEXT preview (sprites 3-5) only changes on a spawn — skip it most
     * frames to keep the OAM build short enough to leave the BG flush vblank. */
    if (next_dirty) {
        next_dirty = 0;
        o = (uint8_t *)0xC10C;             /* sprite slot 3 */
        if (state == ST_TITLE) {
            for (i = 0; i < 12; i++) *o++ = 0;
        } else {
            sx = (uint8_t)((HUD_X + 1) * 8 + 8);
            for (i = 0; i < 3; i++) {
                *o++ = (uint8_t)((3 + i) * 8 + 16);
                *o++ = sx;
                *o++ = tile_for(nextp[i]);
                *o++ = 0;
            }
        }
    }
    /* Trigger the OAM DMA via the HRAM stub directly (skip the oam_dma_flush
     * / oam_dma_copy wrappers). A = high byte of shadow_oam ($C100). */
    ((void (*)(uint8_t))0xFF80)(0xC1);
}

/* direct BG-map cell write — ONLY safe with the LCD off or in a bounded
 * vblank batch (the in-game path queues instead — see collect/flush). */
static void set_cell(uint8_t mx, uint8_t my, uint8_t tile) {
    VRAM[(uint16_t)my * 32 + mx] = tile;
}

/* same write into the WINDOW's map at $9C00 (see the window idiom) */
static void set_wcell(uint8_t wx, uint8_t wy, uint8_t tile) {
    VRAM[WIN_OFF + (uint16_t)wy * 32 + wx] = tile;
}

/* map an ASCII char to its font tile slot (digits, then A-Z, then '-') */
static uint8_t font_slot(char ch) {
    if (ch >= '0' && ch <= '9') return FONT_BASE + (uint8_t)(ch - '0');
    if (ch >= 'A' && ch <= 'Z') return FONT_BASE + 10 + (uint8_t)(ch - 'A');
    if (ch == '-') return FONT_BASE + 36;
    return T_EMPTY;
}

/* draw a NUL-terminated string into the BG map starting at (col,row) */
static void draw_text(uint8_t col, uint8_t row, const char *s) {
    uint8_t i;
    for (i = 0; s[i] != 0; i++)
        set_cell((uint8_t)(col + i), row, font_slot(s[i]));
}

/* draw a NUL-terminated string into the WINDOW map starting at (col,row) */
static void draw_wtext(uint8_t col, uint8_t row, const char *s) {
    uint8_t i;
    for (i = 0; s[i] != 0; i++)
        set_wcell((uint8_t)(col + i), row, font_slot(s[i]));
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * WINDOW-layer HUD — a fixed strip the BG scroll can never move.
 * requires: LCDC bits 5 (window on) + 6 (window map = $9C00), WX/WY set,
 *   and HUD text written to the $9C00 map (set_wcell), not the $9800 one.
 *
 * The window is the GB's second BG plane: same tile data, its OWN 32x32
 * map, drawn OVER the BG starting at screen position (WX-7, WY) and
 * extending to the bottom-right. It ignores SCX/SCY completely — that's
 * the point: scroll the playfield all you want, the HUD strip stays put.
 * Classic placements: a bottom status bar (this game: WY=128 → the last
 * 16 pixel rows) or a full-width top bar. It CANNOT be a floating box —
 * the window always runs to the screen's bottom-right corner.
 *
 * Gotchas:
 *  - WX is offset by 7: WX=7 is the left edge. WX<7 glitches on hardware.
 *  - The window has its OWN line counter: it renders ITS map from window
 *    row 0 downward, regardless of WY — our HUD lives at $9C00 rows 0-1.
 *  - This is DMG-era hardware — it transplants to the GBC example unchanged.
 *
 * Window HUD layout (window map rows 0-1):
 *   row 0:  SC dddddd  HI dddddd      row 1:  LV dd
 * Static labels drawn once at transitions; the digits go through the
 * vblank queue (see collect_well) so in-game updates never tear. */
#define WINY      128                  /* screen y where the strip starts */
#define HUD_SC_X  3                    /* score digits, window row 0 */
#define HUD_HI_X  13                   /* hi-score digits, window row 0 */
#define HUD_LV_X  3                    /* level digits, window row 1 */

/* paint the whole window strip: blank backdrop + labels (LCD off only) */
static void draw_window_static(void) {
    uint8_t x, y;
    for (y = 0; y < 2; y++)
        for (x = 0; x < 20; x++) set_wcell(x, y, T_EMPTY);
    draw_wtext(0, 0, "SC");
    draw_wtext(10, 0, "HI");
    draw_wtext(0, 1, "LV");
}

/* draw every dynamic HUD value directly (LCD off / transitions only —
 * in-game updates go through the queue) */
static void draw_hud_now(void) {
    uint8_t i;
    for (i = 0; i < 6; i++) {
        set_wcell((uint8_t)(HUD_SC_X + i), 0, FONT_BASE + score_d[i]);
        set_wcell((uint8_t)(HUD_HI_X + i), 0, FONT_BASE + hi_d[i]);
    }
    set_wcell(HUD_LV_X, 1, FONT_BASE + (uint8_t)(level / 10));
    set_wcell((uint8_t)(HUD_LV_X + 1), 1, FONT_BASE + (uint8_t)(level % 10));
}

/* Lay down the unchanging screen: clear the whole BG map, draw the well's
 * walls + floor, and the window HUD. Only called with the LCD off (it
 * writes entire maps at once). */
static void draw_static(void) {
    uint8_t x, y;
    for (y = 0; y < 18; y++)
        for (x = 0; x < 20; x++) set_cell(x, y, T_EMPTY);
    for (y = WELL_MY; y < (uint8_t)(WELL_MY + ROWS); y++) {
        set_cell((uint8_t)(WELL_MX - 1), y, T_WALL);
        set_cell((uint8_t)(WELL_MX + COLS), y, T_WALL);
    }
    for (x = (uint8_t)(WELL_MX - 1); x <= (uint8_t)(WELL_MX + COLS); x++)
        set_cell(x, (uint8_t)(WELL_MY + ROWS), T_WALL);
    draw_window_static();
}

/* Full LOCKED-well repaint from the grid (no piece — that's a sprite). Used
 * only with the LCD OFF (boot / title↔game transitions), where writing all
 * changed cells at once is safe. */
static void redraw_all(void) {
    uint8_t r, c, col;
    uint8_t i = 0;
    for (r = 0; r < ROWS; r++) {
        for (c = 0; c < COLS; c++) {
            col = grid[i];
            shadow[i] = col;
            set_cell((uint8_t)(WELL_MX + c), (uint8_t)(WELL_MY + r), tile_for(col));
            i++;
        }
    }
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Deferred well/HUD rendering — the vblank COLLECT/FLUSH queue.
 * requires: update_sprites + flush_well as the FIRST two things after
 *   wait_vblank (in that order), batches capped at WQ_MAX, and no LCDC
 *   bit-7 toggling in-game.
 *
 * This core silently DROPS a VRAM write that lands during active display —
 * and occasionally drops one even at the very start of vblank. So in-game
 * we never touch the LCD; instead:
 *   COLLECT — queue work (RAM only): changed cells after a lock, the HUD
 *             digits, and — when idle — a rolling SCRUB of the whole well.
 *   FLUSH   — write the queue to VRAM as the FIRST thing after wait_vblank.
 * The scrub re-writes well cells from the grid continuously, so any dropped
 * write self-corrects instead of becoming a permanent wrong shape (the "3
 * stones that won't clear" bug). Idempotent ⇒ invisible.
 * Batches are kept small so the whole flush fits in vblank AFTER the OAM
 * DMA — overrunning into active display drops writes.
 * Queue offsets are plain offsets from $9800, so the same queue serves the
 * BG map (well) and the window map at $9800+$400 (HUD digits). */
#define WQ_MAX        6             /* queue capacity (≤4 pushed per frame) */
#define REDRAW_BUDGET 4             /* changed well cells per frame (responsive) */
#define SCRUB_N       4             /* idle cells re-written per frame (self-heal) */
static uint8_t scanning, hud_pending, over_pending;
static uint8_t hud_phase, over_phase;   /* split big HUD/text writes across frames */
static uint8_t scan_i, scrub_i;

static uint8_t  wq_n;
static uint16_t wq_off[WQ_MAX];
static uint8_t  wq_tile[WQ_MAX];

static void start_redraw(void) { scanning = 1; scan_i = 0; }

static void wq_push(uint16_t off, uint8_t tile) {
    if (wq_n < WQ_MAX) { wq_off[wq_n] = off; wq_tile[wq_n] = tile; wq_n++; }
}

static void wq_text(uint8_t col, uint8_t row, const char *s) {
    uint8_t i;
    for (i = 0; s[i] != 0; i++)
        wq_push((uint16_t)row * 32 + col + i, font_slot(s[i]));
}

/* queue one window-HUD digit cell (window map = offset $400) */
static void wq_wdigit(uint8_t col, uint8_t row, uint8_t digit) {
    wq_push(WIN_OFF + (uint16_t)row * 32 + col, FONT_BASE + digit);
}

static uint16_t cell_off(uint8_t i) {
    return (uint16_t)(WELL_MY + (i >> 3)) * 32 + WELL_MX + (i & 7);
}

/* Fill the queue with the next batch of pending changes (RAM only).
 * Each branch pushes at most REDRAW_BUDGET cells, so the flush always fits
 * in vblank; the HUD digits and game-over text are split across frames. */
static void collect_well(void) {
    uint8_t col, k, i;
    wq_n = 0;
    if (scanning) {
        while (scan_i < NCELL && wq_n < REDRAW_BUDGET) {
            col = grid[scan_i];
            if (col != shadow[scan_i]) {
                shadow[scan_i] = col;
                wq_push(cell_off(scan_i), tile_for(col));
            }
            scan_i++;
        }
        if (scan_i >= NCELL) { scanning = 0; hud_pending = 1; hud_phase = 0; }
    } else if (hud_pending) {
        if (hud_phase == 0) {                       /* score digits 0-3 */
            for (i = 0; i < 4; i++) wq_wdigit((uint8_t)(HUD_SC_X + i), 0, score_d[i]);
            hud_phase = 1;
        } else if (hud_phase == 1) {                /* score 4-5 + level */
            wq_wdigit(HUD_SC_X + 4, 0, score_d[4]);
            wq_wdigit(HUD_SC_X + 5, 0, score_d[5]);
            wq_wdigit(HUD_LV_X, 1, (uint8_t)(level / 10));
            wq_wdigit(HUD_LV_X + 1, 1, (uint8_t)(level % 10));
            hud_phase = 2;
        } else if (hud_phase == 2) {                /* hi-score digits 0-3 */
            for (i = 0; i < 4; i++) wq_wdigit((uint8_t)(HUD_HI_X + i), 0, hi_d[i]);
            hud_phase = 3;
        } else {                                    /* hi-score digits 4-5 */
            wq_wdigit(HUD_HI_X + 4, 0, hi_d[4]);
            wq_wdigit(HUD_HI_X + 5, 0, hi_d[5]);
            hud_pending = 0;
            if (state == ST_OVER) { over_pending = 1; over_phase = 0; }
        }
    } else if (over_pending) {
        if (over_phase == 0) { wq_text(3, 6, "GAME"); over_phase = 1; }
        else { wq_text(3, 7, "OVER"); over_pending = 0; }
    } else if (state == ST_PLAY) {
        /* idle: rolling scrub of the well so any dropped write heals itself.
         * Only during play — would erase the title pile / game-over text. */
        for (k = 0; k < SCRUB_N; k++) {
            wq_push(cell_off(scrub_i), tile_for(grid[scrub_i]));
            scrub_i++;
            if (scrub_i >= NCELL) scrub_i = 0;
        }
    }
}

/* Write the queued cells to VRAM. MUST run first after wait_vblank (right
 * after the OAM DMA), and MUST finish inside the ~10-line vblank window or
 * writes drop. Pointer-walk (SDCC sm83 generates tighter code for *p++). */
static void flush_well(void) {
    uint8_t k = wq_n;
    uint16_t *op = wq_off;
    uint8_t *tp = wq_tile;
    while (k != 0) { VRAM[*op++] = *tp++; k--; }
    wq_n = 0;
}

/* ── GAME LOGIC (clay — reshape freely) ── title screen.
 * A jagged pile of all five stone kinds dresses the well — it doubles as
 * the "here are the five shapes you'll match" legend. */
static const uint8_t title_heights[COLS] = { 4, 6, 3, 7, 5, 6, 4, 5 };

static void draw_title(void) {
    uint8_t x, y, c, k, kind;
    /* clear the right panel (NEXT label from a previous game) */
    for (y = 0; y <= 15; y++)
        for (x = 10; x <= 19; x++) set_cell(x, y, T_EMPTY);
    /* decorative pile at the bottom of the well, cycling the five kinds */
    kind = 1;
    for (c = 0; c < COLS; c++) {
        for (k = 0; k < title_heights[c]; k++) {
            y = (uint8_t)(ROWS - 1 - k);
            set_cell((uint8_t)(WELL_MX + c), (uint8_t)(WELL_MY + y), tile_for(kind));
            kind++; if (kind > NKINDS) kind = 1;
        }
    }
    /* game name + prompt, centered across the full 20-column screen */
    draw_text((uint8_t)((20 - (sizeof(GAME_TITLE) - 1)) / 2), 2, GAME_TITLE);
    draw_text(4, 4, "PRESS START");
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * LCD-off transitions. Only flip LCDC bit 7 to 0 DURING VBLANK. Killing the
 * LCD mid-scanline is the classic "damages real DMG hardware" move;
 * emulators shrug, real units can be permanently marked. wait_vblank()
 * first, always. blit_on enables BG + OBJ + the WINDOW (map $9C00). NEVER
 * call these from the in-game loop (the off-frame blanks the whole screen —
 * a flash/strobe). */
static void blit_off(void) { wait_vblank(); LCDC = 0; }
static void blit_on(void)  {
    LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO
         | LCDC_WINDOW_ON | LCDC_WINDOW_MAP_HI;
}

/* zero the board and all run stats for a fresh game (shadow set to 0xFF so
 * the first redraw repaints every cell). Does not touch music_on or hi_d. */
static void reset_state(void) {
    uint8_t i;
    for (i = 0; i < NCELL; i++) grid[i] = 0;
    for (i = 0; i < NCELL; i++) shadow[i] = 0xFF;
    for (i = 0; i < 6; i++) score_d[i] = 0;
    total_cleared = 0;
    level = 0;
    cur_fall_rate = 32;
    fall_timer = 0;
    piece_counter = 0;
    piece_magic = 0;
}

/* leave the title and begin play: reset, seed the first piece + preview, and
 * rebuild the screen with the LCD off. */
static void start_game(void) {
    reset_state();
    state = ST_PLAY;
    roll(nextp);
    spawn();
    blit_off();
    draw_static();
    redraw_all();
    draw_text(HUD_X, 1, "NEXT");
    draw_hud_now();
    blit_on();
    update_sprites();
    scanning = 0; hud_pending = 0; over_pending = 0; wq_n = 0;
}

/* show the title screen (stone pile + name + PRESS START + persisted HI) */
static void go_title(void) {
    reset_state();
    piece_active = 0;
    state = ST_TITLE;
    blit_off();
    draw_static();
    redraw_all();
    draw_title();
    draw_hud_now();
    next_dirty = 1;
    blit_on();
    update_sprites();
    scanning = 0; hud_pending = 0; over_pending = 0; wq_n = 0;
}

/* the run is over: persist a new record, then let the queue paint GAME OVER
 * + the updated HI digits (hud_pending → over_pending chain). */
static void game_over(void) {
    piece_active = 0;
    state = ST_OVER;
    sfx_over();
    if (score_beats_hi()) {
        uint8_t i;
        for (i = 0; i < 6; i++) hi_d[i] = score_d[i];
        hiscore_save();          /* battery SRAM — survives power-off */
    }
}

void main(void) {
    uint8_t pad, prev = 0, t, rate;

    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * Boot order: LCD defaults (installs the OAM-DMA HRAM stub) → vblank IRQ
     * (so wait_vblank HALTs instead of busy-polling LY — the poll runs at
     * ~1/30 speed on this core) → APU on → LCD OFF → then all the bulk VRAM
     * work (tiles, font, maps). Tile/font/map uploads REQUIRE a VRAM-safe
     * window and boot does them all at once, so LCD-off is the only sane
     * choice here. The window position registers are plain I/O — set once,
     * they hold. */
    lcd_init_default();
    enable_vblank_irq();
    sound_init();
    oam_dma_init_hram();
    oam_clear();
    music_on = 1;          /* background music on by default (SELECT toggles) */
    LCDC = 0;
    WY = WINY;             /* window HUD strip: bottom 16 pixel rows */
    WX = 7;                /* WX is offset by 7 — this is the left edge */

    /* DMG palettes (2 bits/shade, low bits = index 0):
     * BGP $E4 → 0=white 1=light 2=dark 3=black (stones + walls + text).
     * OBP0 $E4 → falling/preview stones match their locked twins exactly. */
    BGP  = 0xE4;
    OBP0 = 0xE4;
    OBP1 = 0xE4;

    upload_tile(T_EMPTY, tile_empty);
    upload_tile(T_S1,    tile_s1);
    upload_tile(T_S2,    tile_s2);
    upload_tile(T_S3,    tile_s3);
    upload_tile(T_S4,    tile_s4);
    upload_tile(T_S5,    tile_s5);
    upload_tile(T_WALL,  tile_wall);
    upload_tile(T_MAGIC, tile_magic);
    upload_tile(T_EXP0,  tile_exp0);
    upload_tile(T_EXP1,  tile_exp1);
    upload_tile(T_EXP2,  tile_exp2);
    upload_font();

    hiscore_load();        /* battery SRAM — 0 on a fresh cart */
    go_title();

    /* Main loop, one pass per frame. The order is deliberate: the two VRAM/
     * OAM writers (sprites, then the bounded BG flush) run FIRST so they land
     * inside vblank; audio and game logic follow; the next frame's BG writes
     * are queued last (RAM only) for the following frame's flush. */
    while (1) {
        wait_vblank();
        update_sprites();  /* OAM DMA FIRST — must land in vblank (no tear) */
        flush_well();      /* then drain queued BG writes (≤4, fits vblank) */
        sfx_tick();
        music_tick();

        pad = joypad_read();

        /* SELECT toggles the background music, in any state */
        if ((pad & PAD_SELECT) && !(prev & PAD_SELECT)) music_toggle();

        if (state == ST_TITLE) {
            /* ── GAME LOGIC (clay — reshape freely) ── press-start title
             * (handheld: no 2P mode select — see the header note) */
            if ((pad & PAD_START) && !(prev & PAD_START)) start_game();
        } else if (state == ST_PLAY) {
            /* ── GAME LOGIC (clay — reshape freely) ── one frame of play */
            if ((pad & PAD_LEFT) && !(prev & PAD_LEFT)
                && !collides((uint8_t)(piece_x - 1), piece_y)) { piece_x--; sfx_move(); }
            if ((pad & PAD_RIGHT) && !(prev & PAD_RIGHT)
                && !collides((uint8_t)(piece_x + 1), piece_y)) { piece_x++; sfx_move(); }
            if ((pad & PAD_A) && !(prev & PAD_A) && !piece_magic) {
                t = piece[0]; piece[0] = piece[1]; piece[1] = piece[2]; piece[2] = t;
                sfx_rotate();
            }
            if ((pad & PAD_B) && !(prev & PAD_B) && !piece_magic) {
                t = piece[2]; piece[2] = piece[1]; piece[1] = piece[0]; piece[0] = t;
                sfx_rotate();
            }
            if ((pad & PAD_START) && !(prev & PAD_START)) {
                while (!collides(piece_x, (uint8_t)(piece_y + 1))) piece_y++;
                sfx_drop();
                lock_and_resolve();
                spawn();
                start_redraw();
            }

            rate = (pad & PAD_DOWN) ? 3 : cur_fall_rate;
            if (state == ST_PLAY && ++fall_timer >= rate) {
                fall_timer = 0;
                if (collides(piece_x, (uint8_t)(piece_y + 1))) {
                    sfx_drop();
                    lock_and_resolve();
                    spawn();
                    start_redraw();
                } else {
                    piece_y++;
                }
            }
        } else { /* ST_OVER — START returns to the title (shows the new HI) */
            if ((pad & PAD_START) && !(prev & PAD_START)) go_title();
        }

        collect_well();     /* queue next frame's VRAM writes (RAM only) */
        prev = pad;
    }
}
