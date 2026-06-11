/* ── sports.c — CAROM COAST: Game Boy versus court game (complete example) ──
 *
 * A COMPLETE, working game — press-start title, 1P vs a beatable CPU on a
 * seaside court (Pong lineage), first-to-5 match flow into a result screen,
 * a PRNG rally "spin" so an idle match provably ENDS, GB APU music + SFX, a
 * window-layer fixed HUD, and a persistent RECORD in battery cart RAM (the
 * longest win streak vs the CPU — the stat a returning player chases).
 *
 * THE GAME: your paddle (left) moves UP/DOWN; the ball "caroms" — it
 * ricochets off the rails and deflects off your paddle by where it strikes
 * (centre = flat, edge = steep). The CPU paddle (right) chases the ball at
 * half your top speed, so a steep edge-deflection outruns it — that's
 * exactly how you beat it. Win the point when the ball passes the far
 * paddle; first to 5 takes the match. Win the match and your streak grows;
 * lose and it dies. The longest streak survives a power cycle.
 *
 * MONOCHROME, on purpose: the DMG has FOUR shades of grey, no colour. The
 * two paddles are told apart by SHADE — your paddle is solid black (OBP0),
 * the CPU's is a lighter block (OBP1) — the honest handheld take on the
 * GBA version's blue-team / red-team palettes. The court reads as a court
 * (rails, a dashed net, a dithered surface) so it's never sprites on flat
 * black.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented GB footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — court art, ball physics, CPU skill, scoring rules:
 *     reshape freely.
 *
 * SINGLE-PLAYER, honestly: the Game Boy's "player 2" is a LINK CABLE, which
 * one emulator instance cannot provide — a single instance cannot emulate
 * the second Game Boy on the other end of that cable. So handheld examples
 * ship a press-start title and a 1P-vs-CPU match instead of faking a 2P mode
 * the platform cannot deliver. (The NES/Genesis sports templates ARE 2P
 * versus — two controllers on ONE machine — and a 1P-vs-CPU mode too.)
 *
 * WHY THE PRNG MATTERS (a teaching point shared with the NES/GBA sports
 * templates): the Game Boy is fully deterministic. Without a noise source,
 * the CPU's fixed ball-chase and the fixed rail/paddle bounces lock into an
 * identical rally cycle that NEVER ends — the ball orbits the court forever
 * and no point is ever scored. random8() adds a ±1 "spin" to every paddle
 * return, so rallies always drift, break symmetry, and an idle match reaches
 * 5-0 on its own.
 *
 * What depends on what:
 *   gb_hardware.h — register names (LCDC/WX/WY/BGP/OBP/NRxx/...) + bit masks.
 *   gb_runtime.{h,c} — vblank wait (HALT-driven), joypad, shadow OAM + the
 *     OAM-DMA-from-HRAM routine, VRAM-safe memcpy, APU helpers.
 *   gb_crt0.s — boot + interrupt vectors + the cartridge header window. It
 *     DECLARES the cart as MBC1+RAM+BATTERY ($0147=$03, $0149=$02): that
 *     header is what makes the SRAM record persist (the GB equivalent of
 *     the NES iNES BATTERY bit).
 *   (No font.h — the 1bpp glyphs are embedded below, so this template builds
 *    with exactly the same includes as the platformer/puzzle/shmup.)
 *
 * RENDERING — the hard-won architecture (details at each routine below):
 *  - The two paddles and the ball are OBJ sprites (OAM), not BG tiles, so
 *    moving them is just an OAM rewrite — no per-frame BG writes.
 *  - The court is BG tiles, painted once with the LCD off at match start.
 *  - The HUD (your score / CPU score / streak) lives on the WINDOW layer —
 *    a fixed strip at the bottom of the screen, immune to BG scrolling. The
 *    score digits + result text go through a small vblank COMMIT queue (one
 *    item/frame).
 *  - We NEVER toggle the LCD in-game. LCD-off is used only for the
 *    full-screen title <-> court transitions.
 */
#include "gb_hardware.h"
#include "gb_runtime.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "CAROM COAST"

/* ── GAME LOGIC (clay — reshape freely) ── court geometry + match rules.
 * Pixel coords. The court interior is bounded top/bottom by rail tiles; the
 * paddles + ball stay between COURT_TOP and COURT_BOT. */
#define COURT_TOP   24           /* first pixel row below the top rail        */
#define COURT_BOT   128          /* first pixel row of the bottom rail        */
#define PADDLE_H    24           /* 3 stacked 8x8 sprites                      */
#define PADDLE_X1   16           /* P1 — left side (you)                      */
#define PADDLE_X2   136          /* CPU — right side                         */
#define BALL_SIZE   8
#define SCREEN_W    160
#define WIN_SCORE   5            /* first to 5 takes the match                */

/* Tile slots in the $8000 table. Sprites + BG share the table.
 *   T_BALL/T_PADDLE are OBJ; the paddles' SHADE comes from OBP0 vs OBP1.
 *   T_FLOOR/T_RAIL/T_NET dress the court; FONT_BASE.. are the glyphs. */
#define T_EMPTY    0
#define T_PADDLE   1
#define T_BALL     2
#define T_FLOOR    3
#define T_RAIL     4
#define T_NET      5
#define FONT_BASE  16    /* 0-9 → 16..25, A-Z → 26..51, '-' → 52 */

#define ST_TITLE   0
#define ST_PLAY    1
#define ST_OVER    2

/* VRAM tile maps. BG playfield = $9800; the window HUD = $9C00 (offset
 * $400 in the same VRAM pointer — see the WINDOW HUD idiom below). */
#define VRAM ((volatile uint8_t *)0x9800)
#define WIN_OFF   0x400

/* ── GAME LOGIC (clay — reshape freely) ── tile pixel data (2bpp).
 * Each 8x8 tile = 16 bytes, 2 bytes per row (low plane then high plane); a
 * pixel's 2-bit value = (hi<<1)|lo indexes the DMG palette BGP (BG) or
 * OBP0/OBP1 (OBJ). With BGP=$E4 below: 0=white, 1=light, 2=dark, 3=black. */
static const uint8_t tile_paddle[16] = {     /* solid block; OBP picks shade */
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
};
static const uint8_t tile_ball[16] = {       /* round pip, bright core      */
    0x3C,0x3C, 0x7E,0x42, 0xFF,0x81, 0xFF,0x81,
    0xFF,0x81, 0xFF,0x81, 0x7E,0x42, 0x3C,0x3C,
};
static const uint8_t tile_floor[16] = {      /* faint dither (never flat)   */
    0x00,0x00, 0x22,0x00, 0x00,0x00, 0x88,0x00,
    0x00,0x00, 0x22,0x00, 0x00,0x00, 0x88,0x00,
};
static const uint8_t tile_rail[16] = {       /* solid rail (top/bottom)     */
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
};
static const uint8_t tile_net[16] = {        /* dashed vertical net segment */
    0x18,0x18, 0x18,0x18, 0x00,0x00, 0x00,0x00,
    0x18,0x18, 0x18,0x18, 0x00,0x00, 0x00,0x00,
};

/* ── GAME LOGIC (clay — reshape freely) ── 1bpp font (same glyph set as the
 * platformer/puzzle/shmup — 0-9, A-Z, '-'). Stored 8 bytes/glyph and
 * expanded to 2bpp shade 3 (black) at upload time, so the ROM carries 296
 * bytes of font instead of 592. */
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
 * WRAM layout — keep state ABOVE the shadow-OAM page.
 * The OAM-DMA shadow buffer is pinned by the runtime at $C100 (one page,
 * $C100-$C19F). SDCC allocates ordinary statics upward from $C000; this
 * game's globals are small, so the auto-allocated _DATA segment never
 * reaches $C100. If you ADD large arrays (a tilemap, a particle pool), pin
 * them at FIXED addresses ABOVE the shadow-OAM page with `__at($C200)` (the
 * puzzle template's board does exactly this), or pass dataLoc:0xC200 to the
 * build recipe — either keeps the auto-allocated segment from colliding with
 * shadow_oam. $C200-$DFFF is free work RAM. */

/* ── GAME LOGIC (clay — reshape freely) ── game state (small — auto _DATA) */
static uint8_t  state;           /* ST_TITLE / ST_PLAY / ST_OVER             */
static uint8_t  p1y, cpuy;       /* paddle top Y (pixels)                    */
static int16_t  bx, by;          /* ball top-left position (signed math)     */
static int8_t   bdx, bdy;        /* ball velocity (px/frame)                 */
static uint8_t  score_p1, score_cpu;   /* 0..WIN_SCORE                       */
static uint8_t  serve_timer;     /* freeze frames between points             */
static uint8_t  streak;          /* current 1P win streak vs CPU (RAM)       */
static uint16_t record;          /* battery-backed best streak — see SRAM    */
static uint8_t  new_record;      /* result screen shows NEW RECORD           */
static uint8_t  win_who;         /* 1 = you took the match, 0 = CPU did       */

/* ── GAME LOGIC (clay) — xorshift16 PRNG. THE LOAD-BEARING DETAIL of a
 * deterministic versus game (see the file header). Ticked once per play
 * frame so two identical board states a few frames apart still diverge, and
 * added as ±1 spin to every paddle return so rallies END. Kept 16-bit on
 * purpose — sm83 has no fast 32-bit shifts; a wider generator degenerates. */
static uint16_t rng = 0xC0A7;
static uint8_t random8(void) {
    rng ^= rng << 7;
    rng ^= rng >> 9;
    rng ^= rng << 8;
    return (uint8_t)(rng >> 8);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * BATTERY SRAM record — persistent saves on a Game Boy cart.
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
 * woke up with. The magic bytes + checksum below tell "my save" from
 * "factory noise" — without them a fresh cart shows a junk streak record.
 *
 * PERSISTENCE CHOICE: a raw hi-score is meaningless for a versus game (every
 * match ends 5-x), so we persist the LONGEST WIN STREAK vs the CPU.
 *
 * Save block at $A000: 'C' 'S'  rec-lo rec-hi  ck   (ck = lo^hi^$A5)
 * No timing constraints — SRAM is not VRAM; access it any time. */
#define SRAM_BASE ((volatile uint8_t *)0xA000)
#define MBC_RAMG  (*(volatile uint8_t *)0x0000)   /* MBC1 RAM-gate register */

static uint16_t record_load(void) {
    uint16_t v = 0;
    MBC_RAMG = 0x0A;                          /* enable cart RAM */
    if (SRAM_BASE[0] == 'C' && SRAM_BASE[1] == 'S'
        && SRAM_BASE[4] == (uint8_t)(SRAM_BASE[2] ^ SRAM_BASE[3] ^ 0xA5)) {
        v = (uint16_t)(SRAM_BASE[2] | ((uint16_t)SRAM_BASE[3] << 8));
    }
    MBC_RAMG = 0x00;                          /* ALWAYS re-disable */
    return v;
}

static void record_save(uint16_t v) {
    uint8_t lo = (uint8_t)(v & 0xFF), hi = (uint8_t)(v >> 8);
    MBC_RAMG = 0x0A;
    SRAM_BASE[0] = 'C';
    SRAM_BASE[1] = 'S';
    SRAM_BASE[2] = lo;
    SRAM_BASE[3] = hi;
    SRAM_BASE[4] = (uint8_t)(lo ^ hi ^ 0xA5);
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
#define P_C6  1923

#define SFX_STEPS 3
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
    NR24 = (uint8_t)(0x80 | (sfx_p[sfx_i] >> 8));   /* trigger (envelope ends it) */
    sfx_t = sfx_f[sfx_i];
    sfx_i++;
}

static void sfx_go(uint8_t n) { sfx_n = n; sfx_i = 0; sfx_t = 0; sfx_tick(); }

static void sfx_rail(void) {        /* short blip — ball off a rail */
    sfx_p[0] = P_A4; sfx_v[0] = 0xA1; sfx_d[0] = 0x40; sfx_f[0] = 3;
    sfx_go(1);
}
static void sfx_paddle(void) {      /* brighter blip — paddle return */
    sfx_p[0] = P_C6; sfx_v[0] = 0xC2; sfx_d[0] = 0x80; sfx_f[0] = 4;
    sfx_go(1);
}
static void sfx_point(void) {       /* two-note drop — a point scored */
    sfx_p[0] = P_C5; sfx_v[0] = 0xD2; sfx_d[0] = 0x80; sfx_f[0] = 4;
    sfx_p[1] = P_G4; sfx_v[1] = 0xD3; sfx_d[1] = 0x80; sfx_f[1] = 8;
    sfx_go(2);
}
static void sfx_win(void) {         /* rising fanfare — you took the match */
    sfx_p[0] = P_C5; sfx_v[0] = 0xD2; sfx_d[0] = 0x80; sfx_f[0] = 5;
    sfx_p[1] = P_E5; sfx_v[1] = 0xD2; sfx_d[1] = 0x80; sfx_f[1] = 5;
    sfx_p[2] = P_G5; sfx_v[2] = 0xD3; sfx_d[2] = 0x80; sfx_f[2] = 12;
    sfx_go(3);
}
static void sfx_lose(void) {        /* falling — CPU took the match */
    sfx_p[0] = P_G4; sfx_v[0] = 0xC3; sfx_d[0] = 0x80; sfx_f[0] = 8;
    sfx_p[1] = P_C4; sfx_v[1] = 0xC5; sfx_d[1] = 0x80; sfx_f[1] = 20;
    sfx_go(2);
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

/* map an ASCII char to its font tile slot (digits, then A-Z, then '-') */
static uint8_t font_slot(char ch) {
    if (ch >= '0' && ch <= '9') return FONT_BASE + (uint8_t)(ch - '0');
    if (ch >= 'A' && ch <= 'Z') return FONT_BASE + 10 + (uint8_t)(ch - 'A');
    if (ch == '-') return FONT_BASE + 36;
    return T_EMPTY;
}

/* direct BG-map cell write — ONLY safe with the LCD off or in a bounded
 * vblank batch (the in-game HUD path queues instead — see the commit queue). */
static void set_cell(uint8_t mx, uint8_t my, uint8_t tile) {
    VRAM[(uint16_t)my * 32 + mx] = tile;
}
/* same write into the WINDOW's map at $9C00 (see the window idiom) */
static void set_wcell(uint8_t wx, uint8_t wy, uint8_t tile) {
    VRAM[WIN_OFF + (uint16_t)wy * 32 + wx] = tile;
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
 * extending to the bottom-right. It ignores SCX/SCY completely — that's the
 * point: scroll the playfield all you want, the HUD strip stays put.
 * Classic placements: a bottom status bar (this game: WY=136 → the last
 * 8 pixel rows) or a full-width top bar.
 *
 * Gotchas:
 *  - WX is offset by 7: WX=7 is the left edge. WX<7 glitches on hardware.
 *  - The window has its OWN line counter: it renders ITS map from window
 *    row 0 downward, regardless of WY — our HUD lives at $9C00 row 0.
 *  - This is DMG-era hardware — it transplants to the GBC example unchanged.
 *
 * Window HUD layout (window map row 0):   YOU d  CPU d  REC ddd
 * Static labels drawn once at transitions; the digits go through the vblank
 * commit queue (one item/frame) so in-game updates never tear. */
#define WINY      136                  /* screen y where the strip starts */
#define HUD_YOU_X 4                    /* your score digit, window row 0 */
#define HUD_CPU_X 11                   /* CPU score digit, window row 0 */
#define HUD_REC_X 17                   /* streak record digits (3), window row 0 */

/* paint the whole window strip: blank backdrop + labels (LCD off only) */
static void draw_window_static(void) {
    uint8_t x;
    for (x = 0; x < 20; x++) set_wcell(x, 0, T_EMPTY);
    draw_wtext(0, 0, "YOU");
    draw_wtext(6, 0, "CPU");
    draw_wtext(13, 0, "REC");
}

/* draw every dynamic HUD value directly (LCD off / transitions only —
 * in-game updates go through the queue). REC is a 3-digit record. */
static void draw_hud_now(void) {
    uint16_t v = record;
    uint8_t d2 = (uint8_t)(v % 10); v /= 10;
    uint8_t d1 = (uint8_t)(v % 10); v /= 10;
    uint8_t d0 = (uint8_t)(v % 10);
    set_wcell(HUD_YOU_X, 0, FONT_BASE + score_p1);
    set_wcell(HUD_CPU_X, 0, FONT_BASE + score_cpu);
    set_wcell(HUD_REC_X,     0, FONT_BASE + d0);
    set_wcell(HUD_REC_X + 1, 0, FONT_BASE + d1);
    set_wcell(HUD_REC_X + 2, 0, FONT_BASE + d2);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Deferred HUD rendering — a small vblank COMMIT queue.
 * requires: update_sprites + hud_commit as the FIRST two things after
 *   wait_vblank (in that order), at most a few cells committed per frame,
 *   and no LCDC bit-7 toggling in-game.
 *
 * This core silently DROPS a VRAM write that lands during active display —
 * AND a too-LONG batch overruns the ~10-line vblank window and drops its
 * tail/middle cells even when it starts in vblank (an 11-cell "PRESS START"
 * line written all at once loses ~2 cells on this core). So in-game we never
 * touch the LCD or write the HUD directly; instead game logic sets a dirty
 * flag, and hud_commit() (the FIRST VRAM work after the OAM DMA, inside
 * vblank) drains a SMALL batch: the two score digits, then the result text a
 * few cells per frame. Pre-converting the result strings to tile indices at
 * full-frame time keeps the vblank commit a dumb byte copy (font_slot's
 * compare chain per char is exactly the work that blows the budget — the
 * platformer/shmup learned this as half-missing GAME OVER text). Offsets are
 * plain offsets from $9800, so the same path serves the window map at
 * $9800+$400 (HUD digits). */
#define MSG_BUDGET 5               /* result-text cells written per frame    */
static uint8_t hud_dirty;          /* score digits need re-committing        */
static uint8_t rec_dirty;          /* record digits need re-committing        */
static uint8_t msg_active;         /* result text is being drained           */
static uint8_t msg_i;              /* next result cell to write              */
static uint8_t msg_l1[12], msg_l2[12];  /* pre-converted result tile rows    */
#define MSG_L1_COL 5               /* result line 1 (winner) at BG (5,7)     */
#define MSG_L1_ROW 7
#define MSG_L2_COL 4               /* result line 2 (prompt) at BG (4,9)     */
#define MSG_L2_ROW 9

static void stage_msg(const char *s, uint8_t *out) {
    uint8_t i;
    for (i = 0; s[i] != 0; i++) out[i] = font_slot(s[i]);
    out[i] = 0xFF;                 /* terminator */
}

/* len of a 0xFF-terminated staged row */
static uint8_t msg_len(const uint8_t *q) {
    uint8_t i = 0;
    while (q[i] != 0xFF) i++;
    return i;
}

static void hud_commit(void) {
    uint8_t n, len1, j;
    if (hud_dirty) {                            /* the two score digits       */
        hud_dirty = 0;
        set_wcell(HUD_YOU_X, 0, FONT_BASE + score_p1);
        set_wcell(HUD_CPU_X, 0, FONT_BASE + score_cpu);
        return;
    }
    if (rec_dirty) {                            /* the 3 record digits (rare) */
        uint16_t v = record;
        uint8_t d2 = (uint8_t)(v % 10); v /= 10;
        uint8_t d1 = (uint8_t)(v % 10); v /= 10;
        uint8_t d0 = (uint8_t)(v % 10);
        rec_dirty = 0;
        set_wcell(HUD_REC_X,     0, FONT_BASE + d0);
        set_wcell(HUD_REC_X + 1, 0, FONT_BASE + d1);
        set_wcell(HUD_REC_X + 2, 0, FONT_BASE + d2);
        return;
    }
    if (!msg_active) return;
    /* Drain MSG_BUDGET cells per frame across BOTH result rows: msg_i runs
     * 0..len1-1 over line 1, then len1..len1+len2-1 over line 2. */
    len1 = msg_len(msg_l1);
    for (n = 0; n < MSG_BUDGET; n++) {
        j = msg_i;
        if (j < len1) {
            set_cell((uint8_t)(MSG_L1_COL + j), MSG_L1_ROW, msg_l1[j]);
        } else {
            j -= len1;
            if (msg_l2[j] == 0xFF) { msg_active = 0; break; }
            set_cell((uint8_t)(MSG_L2_COL + j), MSG_L2_ROW, msg_l2[j]);
        }
        msg_i++;
    }
}

/* begin draining the staged result text through the vblank queue */
static void start_msg(void) { msg_active = 1; msg_i = 0; }

/* The two paddles = sprites 0-5 (3 stacked each); the ball = sprite 6. Then
 * flush OAM. MUST be the first VRAM/OAM work after wait_vblank: the OAM DMA
 * has to land in vblank, or sprites tear on a fixed scanline near the top.
 * Your paddle uses OBP0 (attr bit 4 = 0 → solid black); the CPU's uses OBP1
 * (attr 0x10 → lighter shade) — one tile, two readable paddles. */
static void update_sprites(void) {
    /* Write shadow_oam ($C100) directly with a walking pointer — calling
     * oam_set() seven times burns vblank to SDCC call overhead; inlined
     * it's a couple of scanlines. */
    uint8_t *o = (uint8_t *)0xC100;
    uint8_t i, playing = (state == ST_PLAY || state == ST_OVER);
    if (playing) {
        for (i = 0; i < PADDLE_H / 8; i++) {     /* P1 paddle (you) — OBP0 */
            *o++ = (uint8_t)(p1y + i * 8 + 16);
            *o++ = (uint8_t)(PADDLE_X1 + 8);
            *o++ = T_PADDLE; *o++ = 0x00;
        }
        for (i = 0; i < PADDLE_H / 8; i++) {     /* CPU paddle — OBP1 */
            *o++ = (uint8_t)(cpuy + i * 8 + 16);
            *o++ = (uint8_t)(PADDLE_X2 + 8);
            *o++ = T_PADDLE; *o++ = 0x10;
        }
        if (state == ST_PLAY) {                  /* ball (hidden on result) */
            *o++ = (uint8_t)(by + 16);
            *o++ = (uint8_t)(bx + 8);
            *o++ = T_BALL; *o++ = 0x00;
        } else { *o++ = 0; *o++ = 0; *o++ = 0; *o++ = 0; }
    } else {
        for (i = 0; i < 28; i++) *o++ = 0;       /* title: hide all 7 slots */
    }
    /* Trigger the OAM DMA via the HRAM stub directly. A = high byte of
     * shadow_oam ($C100). */
    ((void (*)(uint8_t))0xFF80)(0xC1);
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

/* ── GAME LOGIC (clay — reshape freely) ── paint the static court (LCD off):
 * floor everywhere, top/bottom rails, a dashed centre net. Rows 0-16 are the
 * 136-px play area; the window HUD owns the bottom 8 px. */
static void draw_court(void) {
    uint8_t x, y;
    for (y = 0; y < 18; y++)
        for (x = 0; x < 20; x++) set_cell(x, y, T_FLOOR);
    for (x = 0; x < 20; x++) {
        set_cell(x, 2, T_RAIL);      /* top rail    (y = 16) */
        set_cell(x, 15, T_RAIL);     /* bottom rail (y = 120) */
    }
    for (y = 3; y < 15; y++)
        set_cell(10, y, T_NET);      /* centre net  (x = 80) */
}

/* ── GAME LOGIC (clay — reshape freely) ── title screen: court backdrop +
 * name + prompt + the honest no-2P note. */
static void draw_title(void) {
    draw_court();
    draw_text((uint8_t)((20 - (sizeof(GAME_TITLE) - 1)) / 2), 4, GAME_TITLE);
    draw_text(4, 6, "PRESS START");
    draw_text(5, 8, "1P VS CPU");
    draw_text(3, 10, "NO LINK 2P");
}

/* ── GAME LOGIC (clay — reshape freely) ── serve: ball to centre, toward
 * the chosen side; alternate the vertical angle each serve. */
static void serve_ball(uint8_t to_left) {
    bx = SCREEN_W / 2 - BALL_SIZE / 2;
    by = (COURT_TOP + COURT_BOT) / 2 - BALL_SIZE / 2;
    bdx = to_left ? -2 : 2;
    bdy = ((score_p1 + score_cpu) & 1) ? -1 : 1;
    serve_timer = 30;                            /* half-second breather */
}

/* ── GAME LOGIC (clay — reshape freely) ── paddle hit: deflect by where the
 * ball struck. Centre = flat-ish, edges = steep. Max |bdy| is 2; the CPU
 * moves at 1, so an edge hit outruns it — exactly how you beat it. A ±1
 * random "spin" on every return keeps rallies from repeating and guarantees
 * an idle match ENDS (see header). */
static void deflect(uint8_t paddle_y) {
    int16_t rel = (by + BALL_SIZE / 2) - (int16_t)(paddle_y + PADDLE_H / 2);
    bdy = (int8_t)(rel >> 3);
    bdy += (int8_t)((random8() & 2) - 1);     /* spin: -1 or +1 */
    if (bdy > 2) bdy = 2;
    if (bdy < -2) bdy = -2;
    if (bdy == 0) bdy = (rel < 0) ? -1 : 1;   /* never return a flat ball */
    sfx_paddle();
}

/* ── GAME LOGIC (clay — reshape freely) ── enter each state ── */
static void enter_title(void) {
    state = ST_TITLE;
    msg_active = 0;
    blit_off();
    draw_title();
    draw_window_static();
    draw_hud_now();
    blit_on();
    update_sprites();
}

static void enter_play(void) {
    state = ST_PLAY;
    p1y = (COURT_TOP + COURT_BOT) / 2 - PADDLE_H / 2;
    cpuy = p1y;
    score_p1 = 0; score_cpu = 0;
    new_record = 0;
    rng ^= DIV;                       /* stir from a free-running timer */
    if (rng == 0) rng = 0xC0A7;
    blit_off();
    draw_court();
    draw_window_static();
    draw_hud_now();
    blit_on();
    update_sprites();
    hud_dirty = 0; msg_active = 0;
    serve_ball(0);
}

static void enter_over(void) {
    state = ST_OVER;
    if (win_who) {                    /* you took the match */
        ++streak;
        if (streak > record) {
            record = streak;
            new_record = 1;
            record_save(record);      /* battery SRAM — survives power-off */
        }
        stage_msg("YOU WIN", msg_l1);
        sfx_win();
    } else {                          /* CPU took the match */
        streak = 0;                   /* the streak dies with the loss */
        stage_msg("CPU WINS", msg_l1);
        sfx_lose();
    }
    stage_msg(new_record ? "NEW RECORD" : "PRESS START", msg_l2);
    /* push the final score + (possibly new) record through the vblank queue —
     * direct window writes here land outside vblank and drop on this core. */
    hud_dirty = 1;
    rec_dirty = 1;
    start_msg();                       /* then drain the two result lines */
}

/* ── GAME LOGIC (clay — reshape freely) ── one point scored ── */
static void score_point(uint8_t for_p1) {
    if (for_p1) ++score_p1; else ++score_cpu;
    sfx_point();
    hud_dirty = 1;                    /* queued — safe while rendering */
    if (score_p1 >= WIN_SCORE)  { win_who = 1; enter_over(); return; }
    if (score_cpu >= WIN_SCORE) { win_who = 0; enter_over(); return; }
    serve_ball(for_p1);              /* loser of the point serves outward */
}

/* ── GAME LOGIC (clay — reshape freely) ── one ST_PLAY tick. The ball is
 * frozen during the post-point serve pause; the CPU moves at half the
 * player's top speed with a dead zone so it's beatable; collisions are
 * direction-gated so the ball can't double-hit a paddle. */
static void update_play(uint8_t pad) {
    int16_t target;

    random8();                       /* tick the noise source every frame */

    /* You — UP/DOWN, 2 px/frame (held, continuous). */
    if ((pad & PAD_UP)   && p1y > COURT_TOP)            p1y -= 2;
    if ((pad & PAD_DOWN) && p1y < COURT_BOT - PADDLE_H) p1y += 2;

    /* CPU — chases the ball centre at 1 px/frame with a small dead zone. */
    target = by + BALL_SIZE / 2 - PADDLE_H / 2;
    if ((int16_t)cpuy + 2 < target && cpuy < COURT_BOT - PADDLE_H) cpuy += 1;
    else if ((int16_t)cpuy > target + 2 && cpuy > COURT_TOP)       cpuy -= 1;

    /* Ball update (frozen during the serve pause). */
    if (serve_timer > 0) { --serve_timer; return; }
    bx += bdx;
    by += bdy;

    /* Rail bounce. */
    if (by < COURT_TOP)                 { by = COURT_TOP;             bdy = -bdy; sfx_rail(); }
    if (by + BALL_SIZE > COURT_BOT)     { by = COURT_BOT - BALL_SIZE; bdy = -bdy; sfx_rail(); }

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
    if (bx + BALL_SIZE < 4)    score_point(0);   /* past you → CPU scores */
    if (bx > SCREEN_W - 4)     score_point(1);   /* past CPU → you score  */
}

void main(void) {
    uint8_t pad, prev = 0;

    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * Boot order: LCD defaults (installs the OAM-DMA HRAM stub) → vblank IRQ
     * (so wait_vblank HALTs instead of busy-polling LY — the poll runs at
     * ~1/30 speed on this core) → APU on → LCD OFF → then all the bulk VRAM
     * work (tiles, font, court). Tile/font/map uploads REQUIRE a VRAM-safe
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
    WY = WINY;             /* window HUD strip: bottom 8 pixel rows */
    WX = 7;                /* WX is offset by 7 — this is the left edge */

    /* DMG palettes (2 bits/shade, low bits = index 0):
     * BGP $E4 → 0=white 1=light 2=dark 3=black (court + text).
     * OBP0 $E4 → your paddle + the ball draw shade 3 (black).
     * OBP1 $D8 → CPU paddle reads a lighter shade (index 3 → dark grey),
     *   so the two paddles are told apart by SHADE on the 4-grey DMG. */
    BGP  = 0xE4;
    OBP0 = 0xE4;
    OBP1 = 0xD8;

    upload_tile(T_PADDLE, tile_paddle);
    upload_tile(T_BALL,   tile_ball);
    upload_tile(T_FLOOR,  tile_floor);
    upload_tile(T_RAIL,   tile_rail);
    upload_tile(T_NET,    tile_net);
    upload_font();

    record = record_load();   /* battery SRAM — 0 on a fresh cart */
    streak = 0;
    enter_title();

    /* Main loop, one pass per frame. The order is deliberate: the two VRAM/
     * OAM writers (sprites, then the bounded HUD commit) run FIRST so they
     * land inside vblank; audio and game logic follow. */
    while (1) {
        wait_vblank();
        update_sprites();  /* OAM DMA FIRST — must land in vblank (no tear) */
        hud_commit();      /* then the few queued HUD/result writes */
        sfx_tick();
        music_tick();

        pad = joypad_read();

        /* SELECT toggles the background music, in any state */
        if ((pad & PAD_SELECT) && !(prev & PAD_SELECT)) music_toggle();

        if (state == ST_TITLE) {
            /* ── GAME LOGIC (clay) ── press-start title (handheld: no 2P
             * mode select — see the header note) */
            if (((pad & PAD_START) && !(prev & PAD_START))
                || ((pad & PAD_A) && !(prev & PAD_A))) enter_play();
        } else if (state == ST_PLAY) {
            update_play(pad);
        } else { /* ST_OVER — START/A returns to the title (shows the record) */
            if (((pad & PAD_START) && !(prev & PAD_START))
                || ((pad & PAD_A) && !(prev & PAD_A))) enter_title();
        }

        prev = pad;
    }
}
