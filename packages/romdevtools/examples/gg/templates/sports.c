/* ── sports.c — Game Gear head-to-head court sports game (complete example) ──
 *
 * BAFFLE BOUNCE — a COMPLETE, working game: a title screen with a 1P-vs-CPU /
 * 2P-versus pick, a beatable CPU opponent, 2P SIMULTANEOUS versus (P2 on
 * PORT B), first-to-5 match flow into a result screen, PSG music + SFX, and a
 * persistent record (longest 1P win streak vs the CPU) in Sega-mapper cart
 * RAM. The court renders under the GG/SMS signature LINE-INTERRUPT split: a
 * fixed HUD strip over the playfield, timed by the VDP's programmable line
 * counter — but EVERYTHING is fit to the GG's 160×144 visible window.
 *
 * The game: Pong's lineage — two paddles, a bouncing ball, a netted court.
 * UP/DOWN move your paddle; deflect the ball back, score when it passes the
 * far paddle, first to 5 wins the match. The deflection angle depends on
 * WHERE the ball hits the paddle — a "baffle" is literally a deflecting plate,
 * which is exactly what the paddle is: centre = flat, edges = steep. A steep
 * edge hit is how a human out-angles the 1px/frame CPU.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented GG footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — court art, ball physics, CPU skill, scoring rules:
 *     reshape freely.
 *
 * THE #1 GG FOOTGUN — THE VISIBLE WINDOW: the GG VDP is the SMS VDP. It
 * renders a full 256×192 frame; the LCD shows only the CENTERED 160×144 of
 * it. Hardware coordinates (sprite OAM, tilemap rows/cols, scanline counts)
 * are all in the FULL 256×192 frame — content placed outside the centered
 * window renders "correctly" and is simply never shown. Every SMS habit ports
 * over EXCEPT placement: this whole file is written against the VIS_* block
 * below. The DEUCE DASH (SMS) court was 32 cols wide on fixed paddle X 16/232;
 * here the court is the 20-col window and the paddles sit at the window edges.
 *
 * 2P IS LEGIT HERE (vs the GG shmup's honest 1P note): a real Game Gear has
 * one controller port on the unit, but its I/O chip is the SMS's and gpgx
 * wires the SMS's full split-across-$DC/$DD second-controller layout for GG
 * too — so a SECOND PAD drives PORT B in the emulator (and on an SMS-pad
 * adapter). Two paddles facing each other is the textbook simultaneous-versus
 * shape, so this example keeps the SMS sports' 2P mode (gg_joypad_read_p2).
 *
 * What depends on what:
 *   gg_hw.h / vdp_init.c / load_palette.c / load_tiles.c / sprite_table.c /
 *     joypad_read.c — the bundled VDP + input runtime (this file's externs).
 *   gg_sfx.{h,c} + gg_music.{h,c} — SN76489 PSG sound layers.
 *   gg_crt0.s — boot + vector table. Its $0038 IM-1 handler is the OTHER
 *     HALF of the line-interrupt idiom below: it acks the VDP (one status
 *     read clears BOTH the frame and line IRQ flags) and returns with
 *     ei/reti. Load-bearing; edit with TROUBLESHOOTING open.
 *
 * THE VERSUS LESSON (shared with the SMS/NES/Genesis sports examples): the GG
 * is fully deterministic. Two fixed strategies — say, an idle player and a
 * ball-chasing CPU — lock into an INFINITE rally loop (the exact same cycle,
 * forever; the match never ends). A versus game NEEDS a noise source: a ±1
 * random "spin" on every paddle return, ticked once per play frame, so two
 * identical game states a few seconds apart diverge and SOMEONE eventually
 * reaches 5. The verify harness proves this: an idle 1P-vs-CPU match must
 * provably END. (See deflect() + the random8() tick in the play loop.)
 *
 * SDCC FOOTGUN (bites every fork): uint8 loop bounds silently wrap —
 * `for (uint8_t i = 0; i < 24 * 32; i++)` is an INFINITE loop (768 > 255;
 * SDCC even warns "comparison is always true"). Treat that warning as an
 * error: widen the counter to uint16_t or keep loops nested per-row like the
 * painters below.
 */
#include "gg_hw.h"
#include "gg_sfx.h"
#include "gg_music.h"
#include <stdint.h>

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "BAFFLE BOUNCE"

extern void    gg_vdp_init(void);
extern void    gg_vdp_write_reg(uint8_t reg, uint8_t value);
extern void    gg_vdp_display_on(void);
extern void    gg_vdp_display_off(void);
extern void    gg_vdp_set_addr(uint16_t addr, uint8_t prefix);
extern void    gg_load_palette(const uint8_t *palette);
extern void    gg_load_tiles(uint16_t vram_dest, const uint8_t *src, uint16_t byte_count);
extern void    gg_set_tilemap_cell(uint8_t row, uint8_t col, uint8_t tile_idx, uint8_t attr);
extern uint8_t gg_joypad_read(void);
extern uint8_t gg_joypad_read_p2(void);
extern void    gg_sprite_init(void);
extern void    gg_sprite_set(uint8_t slot, uint8_t x, uint8_t y, uint8_t tile);
extern void    gg_sat_upload(void);

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * THE GG VISIBLE WINDOW. The VDP frame is 256×192; the LCD shows the
 * centered 160×144. In FULL-FRAME hardware units the window is:
 *
 *   pixels:  x ∈ [48..207]   y ∈ [24..167]    (sprite coords, scanlines)
 *   tilemap: col ∈ [6..25]   row ∈ [3..20]    (20×18 visible cells)
 *
 * EVERYTHING the hardware takes is full-frame: gg_sprite_set x/y, tilemap
 * row/col, and — easy to forget — the LINE COUNTER (VDP R10) counts
 * full-frame scanlines from the top of the 192-line active area, NOT from
 * the top of the LCD. The window's first visible scanline is 24.
 *
 * Requires: nothing — these are constants of the machine. Everything below
 * (HUD placement, split line, court geometry, paddle X, text columns) is
 * derived from them; if you reshape the layout, derive from VIS_*, never
 * hardcode SMS-frame numbers. */
#define VIS_X0    48          /* left edge of the LCD window (hardware X)  */
#define VIS_Y0    24          /* top edge (hardware Y / scanline)          */
#define VIS_X1    207         /* right edge:  48 + 160 - 1                 */
#define VIS_Y1    167         /* bottom edge: 24 + 144 - 1                 */
#define VIS_W     160
#define VIS_H     144
#define VIS_COL0  6           /* first visible tilemap column (48 / 8)     */
#define VIS_ROW0  3           /* first visible tilemap row    (24 / 8)     */
#define VIS_COLS  20          /* 160 / 8 */
#define VIS_ROWS  18          /* 144 / 8 */
/* Think in window space (0..19 cols, 0..17 rows), convert at the call: */
#define VROW(r)   ((uint8_t)((r) + VIS_ROW0))
#define VCOL(c)   ((uint8_t)((c) + VIS_COL0))

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Palette. THE GG's HEADLINE UPGRADE over the SMS: CRAM holds 12-bit 4-4-4
 * BGR colour (4096 colours) instead of the SMS's 6-bit 2-2-2 (64). The WRITE
 * FORMAT differs too — that's the #2 GG footgun:
 *
 *   SMS: 32 entries × 1 byte   --BBGGRR
 *   GG:  32 entries × 2 bytes  little-endian: low byte = GGGGRRRR
 *                                             high byte = ----BBBB
 *
 * So a GG palette array is 64 bytes (entries 0-15 BG, 16-31 sprite). Feeding
 * gg_load_palette a 32-byte SMS-style table reads past the array — the sprite
 * palette loads garbage and every sprite renders invisible (this exact bug
 * shipped in an earlier GG scaffold round). Pack an entry with:
 * low = (g << 4) | r, high = b, each channel 0..15. The court greens, the
 * steel HUD bar, and the cyan/red paddles below all use the 4096-colour panel
 * (the DEUCE DASH SMS palette only had 64 to choose from). */
static const uint8_t palette[64] = {
  /* BG 0-15: 0 = court deep-navy (backdrop/border), 1 = court grass-green,
   * 2 = white (lines + net + text), 3 = HUD-bar steel-blue */
  0x20,0x02, 0x82,0x01, 0xFF,0x0F, 0x86,0x06,
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
  /* SPRITE 16-31: 16 = transparent, 17 = P1 cyan, 18 = P2/CPU red,
   * 19 = white ball. One shared sprite palette on GG/SMS: per-"sprite" colour
   * means per-TILE colour indices, not per-sprite palettes. */
  0,0, 0xF8,0x0E, 0x21,0x0D, 0xFF,0x0F,
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
};

/* ── GAME LOGIC (clay) — BG tile inventory (BG bank $0000) ───────────────────
 * tile 0          = blank court (colour 0)
 * tiles 1..37     = font: digits 0-9, A-Z, '-'  (uploaded 1bpp→4bpp below)
 * tile 38         = court field (solid colour 1 green)
 * tile 39         = court line / sideline (solid colour 2 white)
 * tile 40         = dashed net (colour 2 stripe on green)
 * tile 41         = solid HUD bar (colour 3) — the split seam hides in it */
#define FONT_BASE  1
#define BG_FIELD   38
#define BG_LINE    39
#define BG_NET     40
#define BG_HUDBAR  41

/* 1bpp font (same glyph set as the SMS/NES/GB examples — 0-9, A-Z, '-').
 * Stored 8 bytes/glyph; expanded to the VDP's 32-byte 4bpp tiles at upload
 * (see load_font below), so the ROM carries 296 bytes instead of 1184. */
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

/* Expand 1bpp glyphs into 4bpp tiles as colour 2 (plane 1 set → white).
 * GG/SMS tile rows are 4 bytes: plane0, plane1, plane2, plane3. */
static void load_font(void) {
  uint8_t g, r, bits;
  gg_vdp_set_addr((uint16_t)(FONT_BASE * 32), VDP_VRAM_WRITE);
  for (g = 0; g < 37; g++) {
    for (r = 0; r < 8; r++) {
      bits = font8[g][r];
      PORT_VDP_DATA = 0;      /* plane 0 */
      PORT_VDP_DATA = bits;   /* plane 1 → colour index 2 (white) */
      PORT_VDP_DATA = 0;      /* plane 2 */
      PORT_VDP_DATA = 0;      /* plane 3 */
    }
  }
}

/* ── GAME LOGIC (clay) — court furniture tiles (4bpp, 32 bytes each). The
 * paddles + ball are SPRITES (they move every frame); the court is BG tiles.
 *   BG_FIELD = solid green (colour 1 = plane 0)
 *   BG_LINE  = solid white (colour 2 = plane 1): rails + sidelines
 *   BG_NET   = a centred white stripe over green (the net column)
 *   BG_HUDBAR= solid steel (colour 3 = planes 0+1): the split seam hides here */
static const uint8_t court_tiles[32 * 4] = {
  /* BG_FIELD — solid colour 1 (plane 0) */
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  /* BG_LINE — solid colour 2 (plane 1 = white) */
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  /* BG_NET — centre column white (colour 2), rest green (colour 1) */
  0xFF,0x18,0x00,0x00, 0xFF,0x18,0x00,0x00, 0xFF,0x18,0x00,0x00, 0xFF,0x18,0x00,0x00,
  0xFF,0x18,0x00,0x00, 0xFF,0x18,0x00,0x00, 0xFF,0x18,0x00,0x00, 0xFF,0x18,0x00,0x00,
  /* BG_HUDBAR — solid colour 3 (planes 0+1 = steel); seam hides here */
  0xFF,0xFF,0x00,0x00, 0xFF,0xFF,0x00,0x00, 0xFF,0xFF,0x00,0x00, 0xFF,0xFF,0x00,0x00,
  0xFF,0xFF,0x00,0x00, 0xFF,0xFF,0x00,0x00, 0xFF,0xFF,0x00,0x00, 0xFF,0xFF,0x00,0x00,
};

/* Sprite tiles (sprite bank $2000 — vdp_init's R6=0xFF baseline reads sprite
 * patterns from $2000, so upload there, not $0000). The paddle is a solid 4px
 * column (players stack 3 of these = 24px tall); the ball is a small disc.
 * Each on its own sprite colour so P1/P2/ball read distinctly. */
static const uint8_t sprite_tiles[32 * 3] = {
  /* T_PADDLE+0 — paddle column, colour 1 (P1 cyan; recoloured per player by
   * choosing the tile index, see stage_sprites). Plane 0 = colour 1. */
  0x3C,0x00,0x00,0x00, 0x3C,0x00,0x00,0x00, 0x3C,0x00,0x00,0x00, 0x3C,0x00,0x00,0x00,
  0x3C,0x00,0x00,0x00, 0x3C,0x00,0x00,0x00, 0x3C,0x00,0x00,0x00, 0x3C,0x00,0x00,0x00,
  /* T_PADDLE+1 — paddle column, colour 2 (P2/CPU red). Plane 1 = colour 2. */
  0x00,0x3C,0x00,0x00, 0x00,0x3C,0x00,0x00, 0x00,0x3C,0x00,0x00, 0x00,0x3C,0x00,0x00,
  0x00,0x3C,0x00,0x00, 0x00,0x3C,0x00,0x00, 0x00,0x3C,0x00,0x00, 0x00,0x3C,0x00,0x00,
  /* T_BALL — disc, colour 3 (white = planes 0+1) */
  0x00,0x00,0x00,0x00, 0x3C,0x3C,0x00,0x00, 0x7E,0x7E,0x00,0x00, 0x7E,0x7E,0x00,0x00,
  0x7E,0x7E,0x00,0x00, 0x7E,0x7E,0x00,0x00, 0x3C,0x3C,0x00,0x00, 0x00,0x00,0x00,0x00,
};
#define T_PADDLE 0                     /* +0 = P1 (cyan), +1 = P2/CPU (red)   */
#define T_BALL   2

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Court geometry + match rules, ALL in full-frame hardware units derived from
 * VIS_*. The playfield sits below the 3-row HUD strip; COURT_TOP/BOT (pixels)
 * keep the ball between the top/bottom rails. The two paddles sit at fixed X
 * just inside the window's left/right edges; the ball is one 8x8 sprite. */
#define HUD_ROWS   3
#define HUD_PX     (HUD_ROWS * 8)
#define PADDLE_H   24                  /* 3 stacked 8px sprites               */
#define BALL_SIZE  8
#define PADDLE_X1  (VIS_X0 + 6)        /* P1 — just inside the left edge      */
#define PADDLE_X2  (VIS_X1 - 13)       /* P2/CPU — just inside the right edge */
#define COURT_TOP  (VIS_Y0 + HUD_PX + 8)   /* first ball pixel below top rail */
#define COURT_BOT  (VIS_Y1 - 9)        /* first pixel row of the bottom rail  */
#define WIN_SCORE  5                   /* first to 5 takes the match          */

/* ── GAME LOGIC (clay) — game state.
 * The hot ones are deliberately NON-static: they then appear in the sdld map
 * (build symbols) at $Cxxx in work RAM, so a headless agent can resolve them
 * by name and read/poke live state (parse the map → system_ram offset =
 * addr-0xC000). The GG has 8KB of work RAM ($C000-$DFFF), so these plain
 * variables cost nothing. */
int16_t  p1y, p2y;                     /* paddle top Y (int16: collision math)*/
int16_t  bx, by;                       /* ball position                       */
int8_t   bdx, bdy;                     /* ball velocity (px/frame)            */
uint8_t  score_p1, score_p2;
uint8_t  two_player;                   /* title pick: 0 = vs CPU, 1 = 2P      */
uint8_t  state;                        /* ST_TITLE / ST_PLAY / ST_OVER        */
uint16_t best_streak;                  /* persistent record — see end_match   */

static uint8_t  serve_timer;           /* freeze frames between points        */
static uint8_t  streak;                /* current 1P-vs-CPU win streak (RAM)  */
static uint8_t  new_record;            /* result screen shows NEW RECORD      */
static uint8_t  prev_pad;              /* edge-triggered title/result input   */
static uint8_t  hud_dirty;             /* score changed → redraw next vblank  */
static uint8_t  over_step;             /* results text, one piece per vblank  */
static uint16_t rng = 0xC0A7;

#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2

/* ── GAME LOGIC (clay) — xorshift16 PRNG (~tens of cycles per call).
 * A versus game NEEDS this: see THE VERSUS LESSON in the file header. Ticked
 * once per play frame so identical states a few seconds apart still diverge,
 * and used for the ±1 deflection spin so rallies never repeat. */
static uint8_t random8(void) {
  uint16_t r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (uint8_t)r;
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * LINE-INTERRUPT SPLIT — the GG/SMS VDP's signature trick (fixed status bar
 * over the playfield, palette splits, water effects). The VDP has ONE scroll
 * register pair for the whole frame; to keep the HUD strip pinned at the top
 * while the court renders below it we DON'T scroll here (a court doesn't
 * scroll) — but we still take the line IRQ at the bar so the idiom is wired
 * and ready, and so the per-frame timing (vblank → line IRQ → game logic)
 * matches the GG platformer/shmup exactly. Where the NES needs the
 * sprite-0-hit HACK (park a sprite, busy-poll a status bit, burn scanlines),
 * this VDP has a real, PROGRAMMABLE line interrupt:
 *
 *   R10 = N        line counter: a down-counter reloaded with N every line
 *                  outside the active area; underflow → IRQ at scanline N.
 *   R0 bit 4 (IE1) line-IRQ enable (already set in vdp_init's 0x36 baseline).
 *   R1 bit 5 (IE0) frame(vblank)-IRQ enable (set by gg_vdp_display_on's 0xE0).
 *
 * GG WINDOW CONTRAST (the part SMS habits get wrong): R10 counts FULL-FRAME
 * scanlines — line 0 is the top of the 192-line active area, which is 24
 * lines ABOVE the LCD. The HUD strip starts at the window top (scanline
 * VIS_Y0 = 24) and its last line is VIS_Y0 + HUD_PX - 1 = 47, so SPLIT_LINE
 * is 47 — NOT 23 as it would be on an SMS with the same 3-row HUD. Lines
 * 0..23 are rendered and never shown; they ride along with the HUD's region.
 *
 * Both IRQs land on the Z80's IM-1 vector at $0038. The crt0's handler does
 * the canonical minimal handshake:  push af / in a,($BF) / pop af / ei / reti
 * — reading the status port ACKS the VDP (clears BOTH pending flags; skip the
 * read and the IRQ line stays asserted = interrupt storm), and EI must
 * precede RETI or interrupts stay off forever after the first one.
 *
 * Because the handler does no work, the MAIN loop synchronizes with HALT: the
 * Z80 sleeps until the next interrupt, then reads the V-counter (port $7E) to
 * learn WHICH one woke us — line IRQs fire during the active area (V < 0xC0),
 * the frame IRQ fires at vblank (V ≥ 0xC0).
 *
 *   wait_vblank():  sleep until the frame IRQ → do per-frame VRAM work.
 *   wait_split():   sleep until the line IRQ at scanline 47 (the last bar
 *                   line) → past it, the court renders. (If you ADD a
 *                   scrolling background, this is where you'd write R8 — see
 *                   the GG platformer/shmup templates.)
 *
 * FOOTGUN — you cannot poll once IRQs are on: a status-port poll spins on the
 * same port the ISR reads. The ISR always wins the race, eats the flag, and
 * the poll loop hangs forever. HALT + V-counter is the IRQ-era replacement.
 *
 * Requires: R10 programmed, IE1 + IE0 enabled, EI executed once after
 * display-on, the crt0's ack-only ISR, and wait_vblank/wait_split called
 * EVERY frame in this order. R10 reloads after each underflow, so the line
 * IRQ re-fires every HUD_PX+VIS_Y0 lines down the frame (47, 95, 143, 191) —
 * the later wakes harmlessly interrupt game logic (the ISR acks them) and we
 * re-halt inside the NEXT wait_vblank(). */
#define SPLIT_LINE (VIS_Y0 + HUD_PX - 1)

static void wait_vblank(void) {
  /* check-first: if game logic overran into vblank, don't sleep a frame */
  while (PORT_V_COUNTER < 0xC0) { __asm__("halt"); }
}

static void wait_split(void) {
  /* halt-first: vblank work always ends inside vblank (V ≥ 0xC0), and the
   * first wake at V < 0xC0 is the line IRQ at SPLIT_LINE */
  do { __asm__("halt"); } while (PORT_V_COUNTER >= 0xC0);
}

/* ── HARDWARE IDIOM (load-bearing) — record in Sega-mapper cart RAM ──────────
 * Same cartridge mapper as the SMS. The control register at $FFFC: bit 3 maps
 * the cart's 8KB battery RAM into $8000-$BFFF (bank slot 2). Map → copy →
 * unmap; keep the window short so stray pointer bugs can't shred the save.
 * The block is magic + value + checksum so a never-written cart (all $FF)
 * reads back as "no save" instead of a garbage record.
 *
 * NOTE the $FFFC address: it's IN the WRAM mirror ($C000-$DFFF mirrors at
 * $E000-$FFFF), so this write also lands in WRAM at $DFFC — the mapper just
 * snoops the bus. That's why the crt0 parks SP at $DFF0: the bytes above it
 * ($DFFC-$FFFF) belong to the mapper registers' shadow.
 *
 * HONESTY (verified 2026-06-10 against the bundled gpgx core, same finding as
 * the GG shmup/platformer): gpgx only instantiates the Sega mapper for ROMs
 * LARGER than 48KB, and this build pipeline emits 32KB ROMs — so in-emulator
 * the $8000 window stays open-bus (reads $FF), the magic check fails, and the
 * game falls back to the WRAM record (in-session only). The code below is
 * still the correct real-hardware idiom and lights up unchanged on a >48KB
 * build or a cart with battery RAM: the load path is self-falsifying, never
 * wrong. (The verify harness pads this ROM to 64KB to exercise the cart-RAM
 * path for real, including across power-cycle.) */
#define MAPPER_CTRL (*(volatile uint8_t *)0xFFFC)
#define CART_RAM    ((volatile uint8_t *)0x8000)

static void record_save(uint16_t v) {
  uint8_t lo = (uint8_t)(v & 0xFF), hi = (uint8_t)(v >> 8);
  MAPPER_CTRL = 0x08;               /* map cart RAM at $8000 */
  CART_RAM[0] = 0x48;               /* 'H' */
  CART_RAM[1] = 0x53;               /* 'S' */
  CART_RAM[2] = lo;
  CART_RAM[3] = hi;
  CART_RAM[4] = (uint8_t)(lo ^ hi ^ 0xA5);
  MAPPER_CTRL = 0x00;               /* back to ROM in slot 2 */
}

static uint16_t record_load(void) {
  uint16_t v = 0;
  MAPPER_CTRL = 0x08;
  if (CART_RAM[0] == 0x48 && CART_RAM[1] == 0x53 &&
      CART_RAM[4] == (uint8_t)(CART_RAM[2] ^ CART_RAM[3] ^ 0xA5)) {
    v = (uint16_t)(CART_RAM[2] | ((uint16_t)CART_RAM[3] << 8));
  }
  MAPPER_CTRL = 0x00;
  return v;
}

/* ── GAME LOGIC (clay) — text via the font tiles ─────────────────────────────
 * These write the name table directly, so call them only during vblank (or
 * with the display off): VRAM access during active display races the VDP's
 * own fetches and drops/garbles bytes on real hardware. Rows/cols here are
 * WINDOW coordinates (0..17 / 0..19) — VROW/VCOL add the border offset, so
 * text can never accidentally land in the unseen 256×192 margin. */
static uint8_t font_tile(char ch) {
  if (ch >= '0' && ch <= '9') return (uint8_t)(FONT_BASE + (ch - '0'));
  if (ch >= 'A' && ch <= 'Z') return (uint8_t)(FONT_BASE + 10 + (ch - 'A'));
  if (ch == '-') return (uint8_t)(FONT_BASE + 36);
  return 0;                         /* space → blank tile */
}

static void text_draw(uint8_t vrow, uint8_t vcol, const char *s) {
  uint8_t col = VCOL(vcol);
  while (*s) gg_set_tilemap_cell(VROW(vrow), col++, font_tile(*s++), 0);
}

static void draw_u16(uint8_t vrow, uint8_t vcol, uint16_t v) {
  uint8_t d[5], i;
  for (i = 0; i < 5; i++) { d[i] = (uint8_t)(v % 10); v /= 10; }
  for (i = 0; i < 5; i++)
    gg_set_tilemap_cell(VROW(vrow), (uint8_t)(VCOL(vcol) + i),
                        (uint8_t)(FONT_BASE + d[4 - i]), 0);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Split the HUD into STATIC labels (drawn ONCE, display off) and DYNAMIC
 * scores (a handful of cells, gated behind hud_dirty during play). WHY: the
 * vblank window has a finite VRAM budget — the SAT upload alone is 192 OUTs.
 * A clear-the-whole-row + re-letter-everything redraw EVERY frame overruns
 * that budget; the writes that land after the line IRQ get dropped, and a
 * glyph silently vanishes from the bar (it bit the SMS template: the 'S' of
 * BEST disappeared). So the labels go in with the display off and only the
 * few digit cells change in-band. Same discipline the GG platformer/shmup
 * templates use. Layout uses 18 of the 20 visible columns. ── */
static void draw_hud_labels(void) {
  text_draw(0, 0, "P1");
  text_draw(0, 7, "BEST");
  if (two_player) text_draw(0, 17, "P2");
  else            text_draw(0, 16, "CPU");
}

static void draw_hud_scores(void) {
  gg_set_tilemap_cell(VROW(0), VCOL(3), (uint8_t)(FONT_BASE + (score_p1 > 9 ? 9 : score_p1)), 0);
  draw_u16(0, 11, best_streak);
  gg_set_tilemap_cell(VROW(0), VCOL(19), (uint8_t)(FONT_BASE + (score_p2 > 9 ? 9 : score_p2)), 0);
}

/* ── GAME LOGIC (clay) — screen painters (DISPLAY OFF: free VRAM access, clean
 * cut). While the display is off the frame IRQ doesn't fire — so no halt-based
 * waits in here, or you hang forever.
 *
 * IRQ-RACE FOOTGUN (cost the GG shmup a letter of its own title): repaints
 * also run with INTERRUPTS OFF — the di/ei bracket. Display-off stops the
 * FRAME IRQ but NOT the LINE IRQ (R0's IE1 stays set; the line counter runs
 * every scanline regardless of blanking). The crt0's ISR acks by READING the
 * control port ($BF) — and that read also resets the VDP's two-byte
 * address-latch state machine. If the line IRQ fires between the two bytes of
 * a gg_vdp_set_addr() control-port pair, the second byte is taken as a new
 * first byte, the VRAM address de-syncs, and one cell of your repaint lands
 * somewhere else. Per-frame writes inside wait_vblank don't need the bracket:
 * vblank has no line IRQs and the frame IRQ was already consumed by the halt
 * that woke us.
 *
 * PERF FOOTGUN (inherited from the GG shmup/SMS sports, found the slow way):
 * per-cell gg_set_tilemap_cell redoes the 4-OUT address setup for every cell —
 * over a full screen that's seconds of black. Set the VRAM address ONCE per
 * row (the data port autoincrements through the row's 64 bytes) and stream. */
static uint8_t court_tile(uint8_t r, uint8_t c) {
  /* r,c are FULL-FRAME hardware rows/cols. The court fills the visible window
   * (rows VIS_ROW0..VIS_ROW0+VIS_ROWS-1, cols VIS_COL0..VIS_COL0+VIS_COLS-1);
   * the unseen margin around it stays blank (colour 0). */
  uint8_t wr, wc;
  if (r < VIS_ROW0 || r >= (uint8_t)(VIS_ROW0 + VIS_ROWS)) return 0;
  if (c < VIS_COL0 || c >= (uint8_t)(VIS_COL0 + VIS_COLS)) return 0;
  wr = (uint8_t)(r - VIS_ROW0);     /* 0..17 window row */
  wc = (uint8_t)(c - VIS_COL0);     /* 0..19 window col */
  if (wr == 2) return BG_HUDBAR;                        /* HUD bar (split seam) */
  if (wr < 3) return 0;                                 /* HUD text + breather  */
  if (wr == 3 || wr == 17) return BG_LINE;              /* top + bottom rails   */
  if (wc == 0 || wc == 19) return BG_LINE;              /* side lines           */
  if (wc == 10) return BG_NET;                          /* centre net           */
  return BG_FIELD;                                      /* green field          */
}

static void paint_court_field(void) {
  uint8_t r, c;
  for (r = 0; r < 24; r++) {
    gg_vdp_set_addr((uint16_t)(0x3800 + (uint16_t)r * 64), VDP_VRAM_WRITE);
    for (c = 0; c < 32; c++) {
      PORT_VDP_DATA = court_tile(r, c);   /* name-table entry low byte    */
      PORT_VDP_DATA = 0;                  /* high byte: flips/pal/priority */
    }
  }
}

static void paint_blank_field(void) {
  uint8_t r, c;
  for (r = 0; r < 24; r++) {
    gg_vdp_set_addr((uint16_t)(0x3800 + (uint16_t)r * 64), VDP_VRAM_WRITE);
    for (c = 0; c < 32; c++) {
      /* window row 2 (HW row VIS_ROW0+2) gets the HUD bar; rest blank */
      uint8_t t = (r == (uint8_t)(VIS_ROW0 + 2)) ? BG_HUDBAR : 0;
      PORT_VDP_DATA = t;                  /* name-table entry low byte    */
      PORT_VDP_DATA = 0;                  /* high byte: flips/pal/priority */
    }
  }
}

static void paint_title(void) {
  __asm__("di");                    /* see IRQ-RACE FOOTGUN above */
  gg_vdp_display_off();
  paint_blank_field();
  text_draw(5, (uint8_t)((VIS_COLS - (sizeof(GAME_TITLE) - 1)) / 2), GAME_TITLE);
  text_draw(9, 3, "1P VS CPU - 1");
  text_draw(11, 3, "2P VERSUS - 2");
  text_draw(15, 4, "BEST STREAK");
  draw_u16(15, 15, best_streak);
  gg_sprite_init();                 /* park every sprite off-screen */
  gg_sat_upload();
  gg_vdp_display_on();              /* re-enables the frame IRQ too */
  __asm__("ei");                    /* interrupts back on LAST — regs are set */
}

static void paint_play(void) {
  __asm__("di");                    /* see IRQ-RACE FOOTGUN above */
  gg_vdp_display_off();
  paint_court_field();
  draw_hud_labels();                /* static — drawn once with the display off */
  draw_hud_scores();
  gg_sprite_init();
  gg_sat_upload();
  gg_vdp_display_on();
  __asm__("ei");
}

/* ── GAME LOGIC (clay) — serve: ball to centre, toward the chosen side ── */
static void serve_ball(uint8_t to_left) {
  bx = (VIS_X0 + VIS_X1) / 2 - BALL_SIZE / 2;
  by = (COURT_TOP + COURT_BOT) / 2;
  bdx = to_left ? -2 : 2;
  bdy = ((score_p1 + score_p2) & 1) ? -1 : 1;   /* alternate the angle */
  serve_timer = 30;                             /* half-second breather */
}

/* ── GAME LOGIC (clay) — start a match ── */
static void start_match(uint8_t players) {
  two_player = players;
  p1y = (COURT_TOP + COURT_BOT) / 2 - PADDLE_H / 2;
  p2y = p1y;
  score_p1 = 0; score_p2 = 0;
  new_record = 0;
  /* Stir the PRNG with time-spent-on-title so matches differ. */
  rng ^= (uint16_t)((uint16_t)PORT_V_COUNTER << 3);
  if (rng == 0) rng = 0xC0A7;
  serve_ball(0);
  state = ST_PLAY;
  paint_play();
  prev_pad = 0xFF;                  /* the button that started shouldn't move */
  sfx_tone(0, 200, 10);             /* start jingle */
}

/* ── GAME LOGIC (clay) — match over: result + record bookkeeping.
 * Persistence choice (shared with the SMS/NES/Genesis sports examples): for a
 * VERSUS game a raw hi-score is meaningless (every match ends 5-x), so we
 * persist the longest 1P win streak against the CPU — the stat a returning
 * player actually chases. 2P matches never touch it (humans beating each
 * other isn't a record). One piece of result text per vblank (over_step)
 * because each draw_u16 is 5 software divisions — see the BUDGET FOOTGUN. ── */
static void end_match(void) {
  uint8_t p1_won = (uint8_t)(score_p1 >= WIN_SCORE);
  if (p1_won && !two_player) {
    ++streak;
    if (streak > best_streak) {
      best_streak = streak;
      new_record = 1;
      record_save(best_streak);     /* cart RAM (real hardware); WRAM copy live */
    }
  } else if (!p1_won && !two_player) {
    streak = 0;                     /* the streak dies with the loss */
  }
  /* End-of-match whistle: two quick descending tones. */
  sfx_tone(0, 220, 10);
  sfx_tone(1, 320, 12);
  state = ST_OVER;
  prev_pad = 0xFF;                  /* require a fresh press to leave */
  over_step = 4;                    /* deferred result draws, one per vblank */
}

/* ── GAME LOGIC (clay) — one point scored ── */
static void score_point(uint8_t for_p1) {
  if (for_p1) { if (score_p1 < 99) ++score_p1; }
  else        { if (score_p2 < 99) ++score_p2; }
  sfx_noise(8);
  hud_dirty = 1;
  if (score_p1 >= WIN_SCORE || score_p2 >= WIN_SCORE) end_match();
  else serve_ball(for_p1);          /* loser of the point serves toward winner */
}

/* ── GAME LOGIC (clay) — paddle hit: deflect by where the ball struck.
 * Centre = flat-ish, edges = steep — the "baffle" of the title. Max |bdy| is
 * 2 — the CPU moves at 1, so an edge hit is exactly how a human beats it. A
 * ±1 random "spin" on every return keeps rallies from repeating (see THE
 * VERSUS LESSON). ── */
static void deflect(int16_t paddle_y) {
  int16_t rel = (by + BALL_SIZE / 2) - (paddle_y + PADDLE_H / 2);
  bdy = (int8_t)(rel >> 3);
  bdy += (int8_t)((random8() & 2) - 1);     /* spin: -1 or +1 */
  if (bdy > 2) bdy = 2;
  if (bdy < -2) bdy = -2;
  if (bdy == 0) bdy = (rel < 0) ? -1 : 1;   /* never return a flat ball */
  sfx_tone(0, 250, 4);
}

/* ── GAME LOGIC (clay) — stage this frame's sprites. Paddles + ball are the
 * only sprites: slots 0-2 = P1 paddle, 3-5 = P2/CPU paddle, 6 = ball. Inactive
 * (title) slots park at Y=$E0 (below the 192-line area AND below the LCD
 * window). NEVER park at Y=$D0 — that's the SAT terminator: the VDP stops
 * scanning at the first $D0 and every later slot vanishes. ── */
static void stage_sprites(void) {
  uint8_t i;
  if (state == ST_TITLE) { gg_sprite_init(); return; }
  for (i = 0; i < PADDLE_H / 8; i++)
    gg_sprite_set((uint8_t)(0 + i), PADDLE_X1,
                  (uint8_t)((int16_t)p1y + (int16_t)i * 8), T_PADDLE + 0);
  for (i = 0; i < PADDLE_H / 8; i++)
    gg_sprite_set((uint8_t)(3 + i), PADDLE_X2,
                  (uint8_t)((int16_t)p2y + (int16_t)i * 8), T_PADDLE + 1);
  gg_sprite_set(6, (uint8_t)bx, (uint8_t)by, T_BALL);
}

void main(void) {
  uint8_t pad, pad2, fresh;
  int16_t target;

  /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
   * Init order: VDP regs (display off) → palette → tiles → name table → SAT →
   * R10 → display on (which also enables the frame IRQ) → EI. The one hard
   * rule: EI comes LAST, after every register is in place — the crt0 boots
   * with DI and the FIRST halt would hang forever if interrupts were never
   * enabled. (paint_title's trailing __asm__("ei") IS that final step here.) */
  gg_vdp_init();                     /* R0=0x36 already has IE1 (line IRQ) set */
  gg_load_palette(palette);
  load_font();
  gg_load_tiles((uint16_t)(BG_FIELD * 32), court_tiles, 32 * 4);
  gg_load_tiles(0x2000, sprite_tiles, 32 * 3);
  gg_sprite_init();
  sfx_init();
  music_init();
  music_play(0);

  /* R10 = SPLIT_LINE arms the line counter: IRQ at the last bar line —
   * scanline 47 in FULL-FRAME terms (window top 24 + HUD 24 - 1). Set
   * once — it reloads itself every underflow. */
  gg_vdp_write_reg(10, SPLIT_LINE);

  best_streak = record_load();       /* cart RAM if present — else 0 */
  streak = 0;
  state = ST_TITLE;
  prev_pad = 0xFF;
  paint_title();                     /* …ends with EI: interrupts live now */

  for (;;) {
    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: button 1 = 1P vs CPU, 2 = 2P versus ── */
      wait_vblank();
      sfx_update();
      music_update();
      wait_split();
      pad = gg_joypad_read();
      fresh = (uint8_t)(pad & ~prev_pad);
      prev_pad = pad;
      if (fresh & JOY_B1) start_match(0);
      else if (fresh & JOY_B2) start_match(1);
      continue;
    }

    if (state == ST_OVER) {
      /* Freeze the court; button 1 or 2 returns to the title. */
      wait_vblank();
      if (over_step) {                 /* deferred result draws — one/vblank */
        if (over_step == 4) {
          for (pad = 0; pad < VIS_COLS; pad++) gg_set_tilemap_cell(VROW(6), VCOL(pad), 0, 0);
          text_draw(6, 6, two_player ? (score_p1 >= WIN_SCORE ? "P1 WINS" : "P2 WINS")
                                     : (score_p1 >= WIN_SCORE ? "P1 WINS" : "CPU WINS"));
        } else if (over_step == 3) {
          text_draw(9, 7, "SCORE");
          gg_set_tilemap_cell(VROW(9), VCOL(13), (uint8_t)(FONT_BASE + (score_p1 > 9 ? 9 : score_p1)), 0);
          gg_set_tilemap_cell(VROW(9), VCOL(14), FONT_BASE + 36, 0);   /* '-' */
          gg_set_tilemap_cell(VROW(9), VCOL(15), (uint8_t)(FONT_BASE + (score_p2 > 9 ? 9 : score_p2)), 0);
        } else if (over_step == 2) {
          if (new_record) text_draw(11, 5, "NEW RECORD");
        } else {
          text_draw(14, 5, "START - 1");
        }
        over_step--;
      }
      wait_split();
      sfx_update();
      music_update();
      pad = gg_joypad_read();
      fresh = (uint8_t)(pad & ~prev_pad);
      prev_pad = pad;
      if (fresh & (JOY_B1 | JOY_B2)) {
        state = ST_TITLE;
        prev_pad = 0xFF;
        paint_title();
      }
      stage_sprites();               /* keep the frozen paddles staged */
      continue;
    }

    /* ── ST_PLAY ─────────────────────────────────────────────────────────
     * Frame shape: [vblank: SAT upload + gated HUD writes] → [line IRQ at the
     * bar] → [rest of frame: game logic]. VRAM traffic stays inside vblank;
     * logic runs while the VDP draws the court.
     *
     * BUDGET FOOTGUN (inherited from the GG shmup, which found it the hard
     * way): everything between wait_vblank() and wait_split() must finish
     * before the line IRQ at scanline 47 — vblank (70 lines) + the 47 lines
     * above the split ≈ 27k cycles (BIGGER than the SMS's: the 24 never-shown
     * border lines are free). The SAT upload eats ~7k of that. An
     * unconditional HUD redraw (a draw_u16 = 5 software 16-bit divisions) is
     * fine alone, but we still GATE it behind hud_dirty so it only fires on a
     * scored point, never every frame — the discipline all the GG/SMS
     * templates share. */
    wait_vblank();
    gg_sat_upload();                 /* shadow SAT staged at end of last frame */
    if (hud_dirty) { hud_dirty = 0; draw_hud_scores(); }
    sfx_update();
    music_update();
    wait_split();                    /* the line-interrupt split — every frame */

    /* ── GAME LOGIC (clay — reshape freely) from here down ── */
    random8();                       /* tick the noise source every play frame */

    /* P1 — port 0, up/down, 2px/frame. */
    pad = gg_joypad_read();
    if ((pad & JOY_UP)   && p1y > COURT_TOP)            p1y -= 2;
    if ((pad & JOY_DOWN) && p1y < COURT_BOT - PADDLE_H) p1y += 2;

    if (two_player) {
      /* P2 — PORT B (gg_joypad_read_p2 reassembles the split $DC/$DD bits),
       * same speed: a fair simultaneous-versus match. gpgx wires the SMS
       * second-controller layout for GG too (see the file header). */
      pad2 = gg_joypad_read_p2();
      if ((pad2 & JOY_UP)   && p2y > COURT_TOP)            p2y -= 2;
      if ((pad2 & JOY_DOWN) && p2y < COURT_BOT - PADDLE_H) p2y += 2;
    } else {
      /* CPU — chases the ball centre at 1px/frame (half player speed) with a
       * small dead zone. Beatable by design: steep deflections outrun it. */
      target = by + BALL_SIZE / 2 - PADDLE_H / 2;
      if (p2y + 2 < target && p2y < COURT_BOT - PADDLE_H) p2y += 1;
      else if (p2y > target + 2 && p2y > COURT_TOP)       p2y -= 1;
    }

    /* Ball update (frozen during the post-point serve pause). */
    if (serve_timer > 0) {
      --serve_timer;
    } else {
      bx = (int16_t)(bx + bdx);
      by = (int16_t)(by + bdy);

      /* Rail bounce. */
      if (by < COURT_TOP)              { by = COURT_TOP;             bdy = (int8_t)(-bdy); sfx_tone(1, 300, 2); }
      if (by + BALL_SIZE > COURT_BOT)  { by = COURT_BOT - BALL_SIZE; bdy = (int8_t)(-bdy); sfx_tone(1, 300, 2); }

      /* Paddle collisions (direction-gated so the ball can't double-hit). */
      if (bdx < 0
          && bx <= PADDLE_X1 + 8 && bx + BALL_SIZE >= PADDLE_X1
          && by + BALL_SIZE > p1y && by < p1y + PADDLE_H) {
        bdx = (int8_t)(-bdx);
        bx = PADDLE_X1 + 8;
        deflect(p1y);
      }
      if (bdx > 0
          && bx + BALL_SIZE >= PADDLE_X2 && bx <= PADDLE_X2 + 8
          && by + BALL_SIZE > p2y && by < p2y + PADDLE_H) {
        bdx = (int8_t)(-bdx);
        bx = PADDLE_X2 - BALL_SIZE;
        deflect(p2y);
      }

      /* Off either side of the window → point. */
      if (bx < VIS_X0 - 4)       score_point(0);    /* past P1 → P2/CPU scores */
      if (bx > VIS_X1 - 3)       score_point(1);    /* past P2 → P1 scores     */
    }

    /* Stage the SAT shadow NOW (RAM only — cheap, any time); the actual VRAM
     * upload waits for the next vblank at the top of the loop. */
    stage_sprites();
  }
}
