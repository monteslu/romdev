/* ── main.c — PC Engine versus court game (complete example game) ────────────
 *
 * SPIKE SURGE — a COMPLETE, working head-to-head court game (Pong lineage):
 * title screen, 1P vs a beatable CPU and 2P SIMULTANEOUS VERSUS (P1 on the
 * stock pad, P2 on the TurboTap's second pad), first-to-5 match flow with a
 * result screen, PSG music + SFX, and a persistent record (your longest win
 * streak vs the CPU) in BRAM backup memory — survives a power cycle.
 *
 * The game: two paddles, one "pulse" bouncing between them. UP/DOWN move your
 * paddle; the pulse deflects off paddles (steeper the further from centre you
 * parry it) and the top/bottom court rails. A pulse past either edge scores
 * for the other side and re-serves. First to 5 takes the match.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented PCE footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — court art, pulse physics, CPU skill, scoring rules:
 *     reshape freely.
 *
 * What depends on what:
 *   pce_hw.h / pce_video.c / pce_input.c / pce_sound.c — the helper lib
 *     (VDC/VCE/PSG register dances + joypad). The HARDWARE IDIOM markers in
 *     pce_video.c say which parts are load-bearing.
 *   cc65's pce crt0 + pce.lib are auto-linked; the 'rom32k' linker preset
 *     (applied automatically to example projects) gives a 32KB HuCard.
 *
 * 2P, honestly: the stock PC Engine has ONE controller port; 2P needs a
 * TurboTap. The geargrafx core implements the TurboTap and the romdev host
 * now force-ENABLES it (PLATFORM_CORE_OPTIONS pce: geargrafx_turbotap), so a
 * second pad's input reaches the game on pad slot 2 — verified by driving
 * port-1 input and seeing P2's paddle move. So this game ships REAL
 * simultaneous 2P versus. (On real hardware the player plugs a TurboTap and a
 * second pad.) The CPU opponent only exists in 1P mode.
 *
 * Frame budget (NTSC, 60fps, 7.16MHz 65C02-class CPU): 2 paddles + 1 pulse +
 * 2 paddle AABB tests + a 7-entry SATB copy in vblank — a tiny fraction of a
 * frame. Plenty of headroom for fancier physics.
 */
#include <pce.h>
#include <joystick.h>   /* JOY_2 + joy_read for the 2nd pad (TurboTap port 1) */
#include "pce_hw.h"

/* pce_hw.h gives us u8/u16; the pulse position + deflection math need signed
 * types (the pulse can sit above the rim mid-bounce). cc65's int is 16-bit. */
typedef signed char s8;
typedef int         s16;

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "SPIKE SURGE"

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * VRAM map (WORD addresses — the VDC is a 16-bit-word machine; an 8x8 tile is
 * 16 words, a 16x16 sprite cell is 64). Sprites and BG tiles share one 64KB
 * VRAM, so lay it out ONCE and keep the SATB out of pattern space:
 *   $0000  BAT (32x32 background map — matches vdc_init's VDC_MWR setting)
 *   $1000  font glyphs (38 tiles: blank, 0-9, A-Z, dash)
 *   $1400  court furniture tiles (floor, rail, net, HUD band)
 *   $1800  16x16 sprite cells: paddle, pulse */
#define BAT_VRAM      0x0000
#define FONT_VRAM     0x1000
#define FLOOR_VRAM    0x1400   /* court field (BG colour 1)                   */
#define RAIL_VRAM     0x1410   /* top/bottom rails + sidelines (BG colour 2)  */
#define NET_VRAM      0x1420   /* dashed centre net                           */
#define BAND_VRAM     0x1430   /* flat band behind the HUD text               */
#define PADDLE_VRAM   0x1800   /* 16x16 paddle segment                        */
#define PULSE_VRAM    0x1840   /* 16x16 pulse                                 */

#define BAT_ENTRY(pal, vram)  ((u16)(((pal) << 12) | ((vram) >> 4)))

/* Sprite pattern codes = VRAM >> 6 (the 16x16 cell index). */
#define PADDLE_PAT  (PADDLE_VRAM >> 6)
#define PULSE_PAT   (PULSE_VRAM >> 6)

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Court geometry + match rules. The 256x224 court is framed by rail tiles on
 * BAT rows 2 and 27; COURT_TOP/BOT keep the pulse between them. Rows 0-1 are
 * the HUD band. Paddles are 3 stacked 16px sprite segments (48px tall). */
#define COURT_TOP   24            /* first pixel row below the top rail        */
#define COURT_BOT   216           /* first pixel row of the bottom rail        */
#define PADDLE_H    48            /* 3 stacked 16px sprite segments            */
#define PADDLE_X1   16            /* P1 — left side                            */
#define PADDLE_X2   224           /* P2/CPU — right side                       */
#define PULSE_SIZE  12
#define WIN_SCORE   5             /* first to 5 takes the match                */
#define P1_SPEED    3             /* px/frame — both humans move at this       */
#define CPU_SPEED   1             /* px/frame — third speed: clearly beatable  */
#define BALL_VMAX   3             /* max |bdy| — exceeds CPU_SPEED so a steep  *
                                   * edge parry outruns the CPU (the win)      */

/* SATB slot plan (slot order = priority): 0-2 P1 paddle, 3-5 P2 paddle, 6
 * pulse. PAL plan: paddles on their own sprite sub-palettes so P1/P2 differ. */
#define SLOT_P1     0
#define SLOT_P2     3
#define SLOT_PULSE  6
#define PAL_P1      0
#define PAL_P2      1
#define PAL_PULSE   2
#define OFFSCREEN_Y 0x1F0         /* park hidden sprites below the display     */

/* ── GAME LOGIC (clay — reshape freely) ── game state ── */
static s16 p1y, p2y;              /* paddle top Y (signed: collision math)     */
static s16 bx, by;               /* pulse top-left, pixels                    */
static s8  bdx, bdy;             /* pulse velocity (px/frame)                 */
static u8  score_p1, score_p2;
static u8  serve_timer;          /* freeze frames between points              */
static u8  two_player;           /* title pick: 0 = vs CPU, 1 = 2P versus     */
static u8  streak;               /* current 1P-vs-CPU win streak (RAM)        */
static u16 best_streak;          /* persistent record — see end_match         */
static u8  new_record;           /* result screen shows NEW RECORD            */
static u8  state;                /* ST_TITLE / ST_PLAY / ST_OVER              */
static u8  prev_pad;             /* edge-triggered menu input                 */
static u8  sfx_timer;
static u8  hud_dirty;

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2

static u16 tile_buf[16];          /* scratch for one 8x8 tile                  */
static u16 spr_buf[64];           /* scratch for one 16x16 sprite cell         */

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

/* ── GAME LOGIC (clay) — sprite masks (16 rows × 16 bits, bit15 leftmost) ──
 * The paddle is a solid 8px-wide bar centred in the 16px cell; the pulse is a
 * round blip. Colour is the PALETTE, not the bits (one shape, three sub-pals). */
static const u16 paddle_mask[16] = {
    0x0FF0, 0x0FF0, 0x0FF0, 0x0FF0, 0x0FF0, 0x0FF0, 0x0FF0, 0x0FF0,
    0x0FF0, 0x0FF0, 0x0FF0, 0x0FF0, 0x0FF0, 0x0FF0, 0x0FF0, 0x0FF0
};
static const u16 pulse_mask[16] = {
    0x0000, 0x0000, 0x07E0, 0x0FF0, 0x1FF8, 0x1FF8, 0x3FFC, 0x3FFC,
    0x3FFC, 0x3FFC, 0x1FF8, 0x1FF8, 0x0FF0, 0x07E0, 0x0000, 0x0000
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

/* net tile: court floor (colour 1) with a colour-2 dashed centre column */
static void make_net_tile(u16 *t) {
    u8 r;
    for (r = 0; r < 8; ++r) {
        u8 dash = (r < 5);              /* dashed: top 5 rows of each tile     */
        u8 p1 = dash ? 0x18 : 0x00;     /* centre 2 px -> colour 2 (plane1)    */
        t[r]     = (u16)(0x00FF | (p1 << 8));   /* plane0 full (floor) + dash  */
        t[r + 8] = 0x0000;
    }
}

/* one-colour 16x16 sprite cell from a 16-row mask (colour = plane0 → index 1) */
static void make_sprite16(u16 vram, const u16 *mask) {
    u8 r;
    for (r = 0; r < 64; ++r) spr_buf[r] = 0;
    for (r = 0; r < 16; ++r) spr_buf[r] = mask[r];   /* plane 0 → colour 1 */
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

static void upload_art(void) {
    upload_font();
    make_solid_tile(tile_buf, 1); load_tiles(FLOOR_VRAM, tile_buf, 16);
    make_solid_tile(tile_buf, 2); load_tiles(RAIL_VRAM, tile_buf, 16);
    make_net_tile(tile_buf);      load_tiles(NET_VRAM, tile_buf, 16);
    make_solid_tile(tile_buf, 3); load_tiles(BAND_VRAM, tile_buf, 16);
    make_sprite16(PADDLE_VRAM, paddle_mask);
    make_sprite16(PULSE_VRAM,  pulse_mask);
}

/* ── GAME LOGIC (clay) — BAT text + court paint ──────────────────────────── */
static void put_glyph(u8 col, u8 row, u8 glyph) {
    u16 e = BAT_ENTRY(1, (u16)(FONT_VRAM + glyph * 16));  /* pal 1 = white   */
    vram_set_write_addr((u16)(BAT_VRAM + row * 32 + col));
    VDC_DATA_LO = (u8)(e & 0xFF);
    VDC_DATA_HI = (u8)(e >> 8);
}

static void put_tile(u8 col, u8 row, u16 e) {
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

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * WHOLE-SCREEN BAT PAINT — the PCE's bandwidth (the inverse of the NES vblank
 * famine; the puzzle template's match-3 board exploits the same thing). The
 * court is just BG tiles; when a screen changes we rewrite ALL 32x32 BAT
 * entries — 1024 word writes straight at the VDC's VWR port. The whole map
 * streams in well under a vblank, so this game NEVER touches the tilemap inside
 * the frame loop (only on a state change: title → play → result). Two rules:
 *   - do the streaming with the address latch armed by vram_set_write_addr(),
 *     which auto-increments as we feed VDC_DATA_LO/HI;
 *   - keep the SATB DMA (satb_dma) after the BAT writes — both share the VDC.
 *
 * requires: BAT 32x32 (vdc_init's MWR). */
static void paint_court(void) {
    u8 r, c;
    u16 floor = BAT_ENTRY(0, FLOOR_VRAM);
    u16 rail  = BAT_ENTRY(0, RAIL_VRAM);
    u16 net   = BAT_ENTRY(0, NET_VRAM);
    u16 band  = BAT_ENTRY(0, BAND_VRAM);
    u16 e;
    for (r = 0; r < 32; r++) {
        vram_set_write_addr((u16)(BAT_VRAM + r * 32));
        for (c = 0; c < 32; c++) {
            if (r < 2)                    e = band;   /* HUD band              */
            else if (r == 2 || r == 27)   e = rail;   /* top/bottom rails      */
            else if (c == 1 || c == 30)   e = rail;   /* sidelines             */
            else if (c == 16 && r > 2 && r < 27) e = net;  /* centre net       */
            else                          e = floor;  /* court surface         */
            VDC_DATA_LO = (u8)(e & 0xFF);
            VDC_DATA_HI = (u8)(e >> 8);
        }
    }
}

/* HUD (row 0): "P1 n   BEST nnnnn   CPU n" (or "P2" in 2P mode). */
static void draw_hud(void) {
    u8 i;
    /* clear the HUD text row before repainting (band tile under the glyphs) */
    for (i = 0; i < 32; i++) put_tile(i, 0, BAT_ENTRY(0, BAND_VRAM));
    if (state == ST_TITLE) {
        draw_text(11, 0, "BEST");
        draw_num5(16, 0, best_streak);
        return;
    }
    draw_text(1, 0, "P1");
    put_glyph(4, 0, (u8)(G_DIGIT + score_p1));
    draw_text(11, 0, "BEST");
    draw_num5(16, 0, best_streak);
    draw_text(24, 0, two_player ? "P2" : "CPU");
    put_glyph(28, 0, (u8)(G_DIGIT + score_p2));
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * BRAM record persistence. The PCE's battery save is the 2KB "backup RAM" at
 * BANK $F7 (the Tennokoe / CD-interface memory) — geargrafx exposes it as the
 * libretro save_ram region, so it persists across power cycles. Two dances are
 * required, and both are footguns:
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
 * Persistence choice: for a VERSUS sports game a raw hi-score is meaningless
 * (every match ends 5-x), so we persist the longest 1P win streak against the
 * CPU — the stat a returning player actually chases. 2P matches never touch it
 * (humans beating each other isn't a record).
 *
 * requires: nothing else touches MPR2; record layout below.              */
static unsigned char bram_map_thunk[5]   = { 0xA9, 0xF7, 0x53, 0x04, 0x60 };
static unsigned char bram_unmap_thunk[5] = { 0xA9, 0xF8, 0x53, 0x04, 0x60 };

#define BRAM_LOCK_REG (*(volatile u8 *)0x1807)
#define BRAM_BASE     ((volatile u8 *)0x4000)
/* record: offset 16 = 'O','S', streak lo, streak hi, checksum (lo^hi^0xA5) */
#define HS_OFF 16

static void bram_map(void)   { ((void (*)(void))bram_map_thunk)(); }
static void bram_unmap(void) { ((void (*)(void))bram_unmap_thunk)(); }

static u16 record_load(void) {
    u16 v = 0;
    bram_map();
    if (BRAM_BASE[HS_OFF] == 'O' && BRAM_BASE[HS_OFF + 1] == 'S' &&
        BRAM_BASE[HS_OFF + 4] == (u8)(BRAM_BASE[HS_OFF + 2] ^ BRAM_BASE[HS_OFF + 3] ^ 0xA5)) {
        v = (u16)(BRAM_BASE[HS_OFF + 2] | (BRAM_BASE[HS_OFF + 3] << 8));
    }
    bram_unmap();
    return v;
}

static void record_save(u16 v) {
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
static const u8 MEL_TITLE[16] = { G4,B4,D5,G4, E4,G4,B4,E4, A4,C5,E5,A4, D5,B4,G4,D4 };
static const u8 BAS_TITLE[8]  = { G3,G3, C3,C3, A2N,A2N, D4,D4 };
static const u8 MEL_PLAY[16]  = { E4,G4,E4,A4, G4,E4,D4,E4, C4,E4,G4,C5, B4,G4,E4,R  };
static const u8 BAS_PLAY[8]   = { A2N,A2N, C3,C3, G3,G3, A2N,A2N };
static const u8 MEL_OVER[16]  = { C5,R,G4,R, E4,R,C4,R, D4,R,E4,R, G4,R,R,R };

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
        if (music_song != ST_OVER) {       /* the result jingle has no bass    */
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
    if (music_timer >= 9) music_timer = 0;
}

/* short SFX on channels 2/3, auto-cut by sfx_timer */
static void sfx(u8 chan, u16 freq, u8 frames) {
    psg_tone(chan, freq, 31);
    if (frames > sfx_timer) sfx_timer = frames;
}

/* ── GAME LOGIC (clay) — xorshift16 PRNG ─────────────────────────────────────
 * A versus game NEEDS this: the PCE is fully deterministic, so without a noise
 * source two fixed strategies lock into an infinite rally loop (the exact same
 * cycle, forever — a match that never ends). random8() is ticked once per play
 * frame so identical game states a few seconds apart still diverge, and every
 * paddle return adds a ±1 "spin" (see deflect). This is what makes an idle
 * 1P-vs-CPU match provably END. */
static u16 rng = 0xC0A7;
static u8 random8(void) {
    u16 r = rng;
    r ^= r << 7;
    r ^= r >> 9;
    r ^= r << 8;
    rng = r;
    return (u8)r;
}

/* ── GAME LOGIC (clay) — serve: pulse to centre, toward the chosen side.
 * The serve angle takes a PRNG bit (not a fixed alternation) — one more place
 * determinism is broken so idle matches can't settle into a cycle. */
static void serve_ball(u8 to_left) {
    bx = 120;
    by = (COURT_TOP + COURT_BOT) / 2;
    bdx = to_left ? -2 : 2;
    bdy = (random8() & 1) ? -2 : 2;
    serve_timer = 40;                  /* breather between points */
}

/* ── GAME LOGIC (clay) — paddle hit: deflect by where the pulse struck.
 * Centre = flat-ish, edges = steep. Max |bdy| is 2 — the CPU moves at 2 too,
 * but the random spin + steep edge parries are exactly how a human beats it. */
static void deflect(s16 paddle_y) {
    s16 rel = (by + PULSE_SIZE / 2) - (paddle_y + PADDLE_H / 2);
    bdy = (s8)(rel >> 3);                  /* edge parry → steep (up to ±3) */
    bdy += (s8)((random8() & 2) - 1);     /* spin: -1 or +1 */
    if (bdy > BALL_VMAX) bdy = BALL_VMAX;
    if (bdy < -BALL_VMAX) bdy = -BALL_VMAX;
    if (bdy == 0) bdy = (rel < 0) ? -1 : 1;   /* never return a flat pulse */
    sfx(2, 0x200, 4);
}

/* ── GAME LOGIC (clay) — screen painters (full BAT repaint per state change) ── */
static void paint_title(void) {
    paint_court();
    draw_text((u8)((32 - (sizeof(GAME_TITLE) - 1)) / 2), 8, GAME_TITLE);
    draw_text(10, 13, "1P VS CPU - I");
    draw_text(10, 15, "2P VERSUS - II");
    draw_text(11, 19, "FIRST TO 5");
    draw_text(5, 22, "UP DOWN PARRY THE PULSE");
    draw_hud();
}

static void paint_play(void) {
    paint_court();
    draw_hud();
}

static void paint_over(void) {
    paint_court();
    if (score_p1 >= WIN_SCORE)
        draw_text(13, 8, "P1 WINS");
    else
        draw_text(12, 8, two_player ? "P2 WINS" : "CPU WINS");
    put_glyph(14, 11, (u8)(G_DIGIT + score_p1));
    draw_text(16, 11, "-");
    put_glyph(18, 11, (u8)(G_DIGIT + score_p2));
    if (new_record) draw_text(11, 14, "NEW RECORD");
    draw_text(8, 21, "RUN - TITLE");
    draw_hud();
}

/* ── GAME LOGIC (clay) — start a match ── */
static void start_match(u8 players) {
    two_player = players;
    p1y = (COURT_TOP + COURT_BOT) / 2 - PADDLE_H / 2;
    p2y = p1y;
    score_p1 = 0;
    score_p2 = 0;
    new_record = 0;
    serve_ball(0);
    state = ST_PLAY;
    paint_play();
    music_set(ST_PLAY);
    sfx(2, 0x180, 6);                  /* start blip */
}

/* ── GAME LOGIC (clay) — match over: result + record bookkeeping ── */
static void end_match(void) {
    if (score_p1 >= WIN_SCORE && !two_player) {
        ++streak;
        if (streak > best_streak) {
            best_streak = streak;
            new_record = 1;
            record_save(best_streak);  /* BRAM — survives a power cycle */
        }
    } else if (!two_player) {
        streak = 0;                    /* the streak dies with the loss */
    }
    state = ST_OVER;
    prev_pad = 0xFF;                   /* require a fresh press on the result */
    /* End-of-match whistle: two quick descending tones. */
    sfx(2, 0x300, 8);
    sfx(3, 0x500, 14);
    paint_over();
    music_set(ST_OVER);
}

/* ── GAME LOGIC (clay) — one point scored ── */
static void score_point(u8 for_p1) {
    if (for_p1) ++score_p1; else ++score_p2;
    sfx(3, 0x100, 8);
    hud_dirty = 1;
    if (score_p1 >= WIN_SCORE || score_p2 >= WIN_SCORE) end_match();
    else serve_ball(for_p1);           /* winner of the point receives */
}

/* ── GAME LOGIC (clay) — stage this frame's sprites ─────────────────────────
 * Fixed SATB slots: 0-2 P1 paddle, 3-5 P2 paddle, 6 pulse. Paddles freeze on
 * the result screen; the pulse only shows in play. Hidden slots park below the
 * display at OFFSCREEN_Y. */
static void push_sprites(void) {
    u8 i;
    u8 actors = (state != ST_TITLE);     /* paddles show in play + result     */
    u8 pulse_on = (state == ST_PLAY);
    for (i = 0; i < 3; i++) {
        set_sprite((u8)(SLOT_P1 + i), PADDLE_X1,
                   actors ? (u16)(p1y + (s16)(i * 16)) : OFFSCREEN_Y,
                   PADDLE_PAT, PAL_P1);
        set_sprite((u8)(SLOT_P2 + i), PADDLE_X2,
                   actors ? (u16)(p2y + (s16)(i * 16)) : OFFSCREEN_Y,
                   PADDLE_PAT, PAL_P2);
    }
    set_sprite(SLOT_PULSE, (u16)bx, pulse_on ? (u16)by : OFFSCREEN_Y,
               PULSE_PAT, PAL_PULSE);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * 2P INPUT via the TurboTap. pce_joy_read() reads pad 1 (slot 0). For pad 2 we
 * read cc65's JOY_2 directly and translate it to the same clean PCE bitmask
 * pce_input.c builds for pad 1. The host force-enables the TurboTap core
 * option, so JOY_2 carries real port-1 input; without that override port 1 is
 * dead and this would silently fall back to 1P. ── */
static u8 read_pad2(void) {
    u8 raw = joy_read(JOY_2);
    u8 m = 0;
    if (JOY_UP(raw))    m |= PCE_JOY_UP;
    if (JOY_DOWN(raw))  m |= PCE_JOY_DOWN;
    if (JOY_LEFT(raw))  m |= PCE_JOY_LEFT;
    if (JOY_RIGHT(raw)) m |= PCE_JOY_RIGHT;
    if (JOY_BTN_1(raw)) m |= PCE_JOY_I;
    if (JOY_BTN_2(raw)) m |= PCE_JOY_II;
    if (JOY_BTN_3(raw)) m |= PCE_JOY_SELECT;
    if (JOY_BTN_4(raw)) m |= PCE_JOY_RUN;
    return m;
}

void main(void) {
    u8 pad1, pad2, newpad;

    _pce_keep[0] = 0;   /* see the EMPTY-BSS TRAP note in pce_hw.h */

    /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
     * Init order: palette → VRAM uploads → BAT paint → joypad → display ON.
     * disp_enable() also sets the VBlank IRQ bit — without it waitvsync()
     * never returns and the game freezes on its first frame. */
    /* BG sub-pal 0: court (floor/rail/net/band). BG sub-pal 1: HUD/text white. */
    vce_set_color(0,   PCE_RGB(0, 1, 0));   /* backdrop: dark green          */
    vce_set_color(1,   PCE_RGB(0, 4, 1));   /* court floor green             */
    vce_set_color(2,   PCE_RGB(7, 7, 7));   /* rails / net: white            */
    vce_set_color(3,   PCE_RGB(1, 2, 1));   /* HUD band: dark green-grey     */
    vce_set_color(17,  PCE_RGB(7, 7, 7));   /* pal1 text: white              */
    /* sprite sub-palettes (256 + pal*16 + index) — P1 cyan, P2 red, pulse
     * yellow, each on its own sub-palette so the paddles read as two sides. */
    vce_set_color(256 + 0 * 16 + 1, PCE_RGB(2, 6, 7));  /* spr pal0 c1: P1 cyan   */
    vce_set_color(256 + 1 * 16 + 1, PCE_RGB(7, 1, 1));  /* spr pal1 c1: P2 red    */
    vce_set_color(256 + 2 * 16 + 1, PCE_RGB(7, 7, 0));  /* spr pal2 c1: pulse amber */

    upload_art();

    best_streak = record_load();   /* BRAM — 0 on first boot / bad checksum  */
    streak = 0;
    state = ST_TITLE;
    paint_title();
    music_set(ST_TITLE);

    pce_joy_init();
    disp_enable();

    for (;;) {
        waitvsync();

        /* ── vblank work first: queued HUD repaint + sprites + SATB DMA ── */
        if (hud_dirty) { draw_hud(); hud_dirty = 0; }
        push_sprites();
        satb_dma();

        music_tick();
        if (sfx_timer) {
            --sfx_timer;
            if (sfx_timer == 0) { psg_off(2); psg_off(3); }
        }

        /* ── 2P input via the TurboTap (see read_pad2's idiom note). In 2P
         * versus BOTH play simultaneously, so we read BOTH pads every frame;
         * on the menus only pad 1 matters. ── */
        pad1 = pce_joy_read();
        pad2 = (state == ST_PLAY && two_player) ? read_pad2() : 0;

        if (state == ST_TITLE) {
            newpad = (u8)(pad1 & ~prev_pad);
            prev_pad = pad1;
            if (newpad & (PCE_JOY_RUN | PCE_JOY_I)) start_match(0);
            else if (newpad & PCE_JOY_II) start_match(1);
            continue;
        }
        if (state == ST_OVER) {
            newpad = (u8)(pad1 & ~prev_pad);
            prev_pad = pad1;
            if (newpad & (PCE_JOY_RUN | PCE_JOY_I)) {
                state = ST_TITLE;
                paint_title();
                music_set(ST_TITLE);
            }
            continue;
        }

        /* ── ST_PLAY ────────────────────────────────────────────────────────
         * tick the noise source every play frame so idle matches diverge. */
        random8();

        /* P1 — pad 1 (port 0), UP/DOWN. */
        if ((pad1 & PCE_JOY_UP)   && p1y > COURT_TOP)            p1y -= P1_SPEED;
        if ((pad1 & PCE_JOY_DOWN) && p1y < COURT_BOT - PADDLE_H) p1y += P1_SPEED;

        if (two_player) {
            /* P2 — TurboTap pad 2 (port 1), same speed: a fair versus match. */
            if ((pad2 & PCE_JOY_UP)   && p2y > COURT_TOP)            p2y -= P1_SPEED;
            if ((pad2 & PCE_JOY_DOWN) && p2y < COURT_BOT - PADDLE_H) p2y += P1_SPEED;
        } else {
            /* CPU — chases the pulse centre at a third of the player speed
             * with a small dead zone. Beatable by design: a steep edge parry
             * (|bdy| up to 3) outruns the CPU's 1px/frame tracking. */
            s16 target = by + PULSE_SIZE / 2 - PADDLE_H / 2;
            if (p2y + 2 < target && p2y < COURT_BOT - PADDLE_H) p2y += CPU_SPEED;
            else if (p2y > target + 2 && p2y > COURT_TOP)       p2y -= CPU_SPEED;
        }

        /* Pulse update (frozen during the post-point serve pause). */
        if (serve_timer > 0) { --serve_timer; continue; }
        bx = (s16)(bx + bdx);
        by = (s16)(by + bdy);

        /* Rail bounce. */
        if (by < COURT_TOP)                 { by = COURT_TOP;                 bdy = (s8)(-bdy); sfx(3, 0x280, 4); }
        if (by + PULSE_SIZE > COURT_BOT)    { by = (s16)(COURT_BOT - PULSE_SIZE); bdy = (s8)(-bdy); sfx(3, 0x280, 4); }

        /* Paddle collisions (direction-gated so the pulse can't double-hit). */
        if (bdx < 0
            && bx <= PADDLE_X1 + 12 && bx + PULSE_SIZE >= PADDLE_X1
            && by + PULSE_SIZE > p1y && by < p1y + PADDLE_H) {
            bdx = (s8)(-bdx);
            bx = PADDLE_X1 + 12;
            deflect(p1y);
        }
        if (bdx > 0
            && bx + PULSE_SIZE >= PADDLE_X2 && bx <= PADDLE_X2 + 12
            && by + PULSE_SIZE > p2y && by < p2y + PADDLE_H) {
            bdx = (s8)(-bdx);
            bx = (s16)(PADDLE_X2 - PULSE_SIZE);
            deflect(p2y);
        }

        /* Off either side → point. */
        if (bx < 2)   score_point(0);   /* past P1 → right side scores */
        if (bx > 246) score_point(1);   /* past P2 → P1 scores         */
    }
}
