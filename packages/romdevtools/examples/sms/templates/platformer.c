/* ── platformer.c — SMS side-scrolling platformer (complete example game) ────
 *
 * GULLY VAULT — a COMPLETE, working game: title screen, 1P mode and 2P
 * ALTERNATING-TURNS mode (arcade-classic: players swap on death; each player
 * has their own score and own 3 lives; player 2 plays on PORT B), coins +
 * distance scoring, persistent hi-score (Sega-mapper cart RAM — see the
 * honesty note at hiscore_save), PSG music + SFX, and the SMS's signature
 * LINE-INTERRUPT split: a fixed HUD strip over a horizontally scrolling
 * level, timed by the VDP's programmable line counter.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented SMS footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — level layout, physics tuning, scoring, art: reshape
 *     freely.
 *
 * What depends on what:
 *   sms_hw.h / vdp_init.c / load_tiles.c / load_palette.c / sprite_table.c /
 *     joypad_read.c — the bundled VDP + input runtime (this file's externs).
 *   sms_sfx.{h,c} + sms_music.{h,c} — SN76489 PSG sound layers.
 *   sms_crt0.s — boot + vector table. Its $0038 IM-1 handler is the OTHER
 *     HALF of the line-interrupt idiom below: it acks the VDP (one status
 *     read clears BOTH the frame and line IRQ flags) and returns with
 *     ei/reti. Load-bearing; edit with TROUBLESHOOTING open.
 *
 * The level: a 32-column map (ground height + one-way platforms + pits).
 * Here the SMS does the NES one better: the SMS name table is EXACTLY 32
 * cells = 256 px wide and wraps in hardware, so a 256-px-periodic level
 * paints ONCE and the uint8 scroll wraps perfectly seamless — no second
 * nametable, no column streaming. An endless looping run of pits,
 * platforms, coins and spikes. Coins/spikes are sprites that drift with
 * the scroll (world-anchored while on screen, respawning at the right).
 *
 * Frame budget (NTSC, 60fps): SAT upload (192 OUTs) fits in vblank + the
 * 24-line HUD strip; player physics + a two-column tile probe + (3 coins +
 * 2 spikes) of AABB run in the active frame with room to spare. The HUD
 * redraw (10 software 16-bit divisions) is gated by a dirty flag — see the
 * BUDGET FOOTGUN at the main loop.
 *
 * SDCC FOOTGUN (bites every fork): uint8 loop bounds silently wrap —
 * `for (uint8_t i = 0; i < 24 * 32; i++)` is an INFINITE loop (768 > 255;
 * SDCC even warns "comparison is always true"). Treat that warning as an
 * error: widen the counter to uint16_t or keep loops nested per-row like
 * the painters below.
 */
#include "sms_hw.h"
#include "sms_sfx.h"
#include "sms_music.h"
#include <stdint.h>

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "GULLY VAULT"

extern void    sms_vdp_init(void);
extern void    sms_vdp_write_reg(uint8_t reg, uint8_t value);
extern void    sms_vdp_display_on(void);
extern void    sms_vdp_display_off(void);
extern void    sms_vdp_set_addr(uint16_t addr, uint8_t prefix);
extern void    sms_load_palette(const uint8_t *palette);
extern void    sms_load_tiles(uint16_t vram_dest, const uint8_t *src, uint16_t byte_count);
extern void    sms_set_tilemap_cell(uint8_t row, uint8_t col, uint8_t tile_idx, uint8_t attr);
extern uint8_t sms_joypad_read(void);
extern uint8_t sms_joypad_read_p2(void);
extern void    sms_sprite_init(void);
extern void    sms_sprite_set(uint8_t slot, uint8_t x, uint8_t y, uint8_t tile);
extern void    sms_sat_upload(void);

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Palettes. SMS CRAM is 2-2-2 BGR (--BBGGRR): R bits 0-1, G bits 2-3,
 * B bits 4-5. White = 0x3F. BG colour 0 doubles as the backdrop/border. */
static const uint8_t palette[32] = {
  /* BG: 0 = sky blue, 1 = dirt brown, 2 = grass green, 3 = white (text +
   * clouds), 4 = HUD-bar navy */
  0x39, 0x06, 0x0C, 0x3F, 0x10, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  /* Sprites: 1 = red (player), 2 = gold (coin), 3 = orange (spike).
   * One shared sprite palette on SMS — per-"sprite" colour means per-TILE
   * colour indices, not per-sprite palettes. */
  0x00, 0x03, 0x0F, 0x07, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};

/* ── GAME LOGIC (clay) — BG tile inventory (BG bank $0000) ───────────────────
 * tile 0          = blank sky (colour 0)
 * tiles 1..37     = font: digits 0-9, A-Z, '-'  (uploaded 1bpp→4bpp below)
 * tile 38         = grass surface (green lip over dirt)
 * tile 39         = dirt fill (solid colour 1)
 * tile 40         = solid HUD bar (colour 4) — the split seam hides in it
 * tile 41         = cloud puff (colour 3) */
#define FONT_BASE  1
#define BG_GRASS   38
#define BG_DIRT    39
#define BG_HUDBAR  40
#define BG_CLOUD   41

/* 1bpp font (same glyph set as the NES/GB examples — 0-9, A-Z, '-').
 * Stored 8 bytes/glyph; expanded to the SMS's 32-byte 4bpp tiles at upload
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

/* Expand 1bpp glyphs into 4bpp SMS tiles as colour 3 (planes 0+1 set).
 * SMS tile rows are 4 bytes: plane0, plane1, plane2, plane3. */
static void load_font(void) {
  uint8_t g, r, bits;
  sms_vdp_set_addr((uint16_t)(FONT_BASE * 32), VDP_VRAM_WRITE);
  for (g = 0; g < 37; g++) {
    for (r = 0; r < 8; r++) {
      bits = font8[g][r];
      PORT_VDP_DATA = bits;   /* plane 0 */
      PORT_VDP_DATA = bits;   /* plane 1 → colour index 3 */
      PORT_VDP_DATA = 0;      /* plane 2 */
      PORT_VDP_DATA = 0;      /* plane 3 */
    }
  }
}

/* Grass/dirt/HUD-bar/cloud tiles (4bpp, 32 bytes each — rows of plane0..3). */
static const uint8_t deco_tiles[128] = {
  /* BG_GRASS: 2 rows of grass (colour 2 = plane 1) over dirt (colour 1) */
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  /* BG_DIRT: solid colour 1 */
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  /* BG_HUDBAR: solid colour 4 (binary 100 → plane 2 only) — the split
   * seam lands inside this row */
  0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00,
  0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00,
  /* BG_CLOUD: white puff (colour 3 = planes 0+1) */
  0x00,0x00,0x00,0x00, 0x3C,0x3C,0x00,0x00, 0x7E,0x7E,0x00,0x00, 0xFF,0xFF,0x00,0x00,
  0x7E,0x7E,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
};

/* Sprite tiles (sprite bank $2000 — vdp_init's R6=0xFF baseline reads
 * sprite patterns from $2000, so upload there, not $0000). */
static const uint8_t sprite_tiles[32 * 4] = {
  /* T_PLAYER_IDLE — round body + legs, colour 1 (red) */
  0x3C,0x00,0x00,0x00, 0x7E,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0x7E,0x00,0x00,0x00, 0x66,0x00,0x00,0x00, 0x66,0x00,0x00,0x00,
  /* T_PLAYER_JUMP — arms up, colour 1 */
  0x18,0x00,0x00,0x00, 0x7E,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xE7,0x00,0x00,0x00, 0xC3,0x00,0x00,0x00, 0x81,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  /* T_COIN — disc, colour 2 (gold, plane 1) */
  0x00,0x3C,0x00,0x00, 0x00,0x7E,0x00,0x00, 0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00, 0x00,0x7E,0x00,0x00, 0x00,0x3C,0x00,0x00,
  /* T_SPIKE — ground spike, colour 3 (orange, planes 0+1) */
  0x00,0x00,0x00,0x00, 0x18,0x18,0x00,0x00, 0x18,0x18,0x00,0x00, 0x3C,0x3C,0x00,0x00,
  0x3C,0x3C,0x00,0x00, 0x7E,0x7E,0x00,0x00, 0xFF,0xFF,0x00,0x00, 0xFF,0xFF,0x00,0x00,
};
#define T_PLAYER_IDLE 0
#define T_PLAYER_JUMP 1
#define T_COIN        2
#define T_SPIKE       3

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * The level — a 32-column map; world x = (screen x + scroll) mod 256, and
 * 32 columns × 8 px = EXACTLY the name table width, so the map paints once
 * and wraps seamlessly (the NES version of this game needs two mirrored
 * nametables for the same trick; the SMS gets it free).
 *   ground_row[c] — name-table row of the ground's grass top, 0xFF = pit.
 *   plat_row[c]   — row of a one-way floating platform, 0 = none.
 * Rows are name-table rows (y = row*8). Playfield rows are 3..23. */
#define NO_GROUND 0xFF
static const uint8_t ground_row[32] = {
  21, 21, 21, 21, 21, 21, 21, 21,                  /* start runway        */
  21, NO_GROUND, NO_GROUND, 21, 21, 21, 21, 21,    /* pit 1 (16 px)       */
  21, 21, 21, 21, NO_GROUND, NO_GROUND, NO_GROUND, /* pit 2 (24 px)       */
  21, 21, 21, 21, 21, 21, 21, 21, 21,
};
static const uint8_t plat_row[32] = {
  0, 0, 0, 0, 16, 16, 16, 0,                       /* slab before pit 1   */
  0, 0, 0, 0, 0, 0, 15, 15,                        /* slab mid-level      */
  15, 0, 0, 0, 0, 0, 0, 0,
  0, 16, 16, 16, 0, 0, 0, 0,                       /* slab near the loop  */
};

/* HUD layout: row 0 = text (P# / lives / SC / HI), row 1 = blank, row 2 =
 * solid bar. The bar row is both the visual divider AND where the split
 * seam hides. NOTE vdp_init's R0=0x36 baseline blanks the LEFTMOST 8-px
 * column (bit 5 — it masks the scroll seam at the screen edge), so screen
 * column 0 is invisible: HUD text starts at column 1.
 * (R0 bit 6 — "lock the top 2 rows against H-scroll" — looks like a free
 * HUD, but it's 2 rows max and all-or-nothing; the line-IRQ split below
 * is the general technique, any height, and also does palette/water
 * effects. We teach the split.) */
#define HUD_ROWS    3
#define HUD_PX      (HUD_ROWS * 8)
#define START_LIVES 3

/* ── GAME LOGIC (clay) — physics + tuning ── */
#define GRAVITY_Q44    1    /* +1/16 px per frame per frame                */
#define JUMP_VEL_Q44 (-40)  /* launch vy (Q4.4) → ~50 px / ~6 tile apex    */
#define MAX_VY_Q44    80    /* terminal velocity, 5 px/frame — MUST stay   *
                             * under 6: the landing probe's 6-px window    *
                             * can't catch a faster fall (tunnelling)      */
#define MOVE_SPEED     2    /* px/frame walk + scroll speed                */
#define SCROLL_WALL  112    /* px: past this the world scrolls, not you    */
#define GROUND_ROW    21    /* see ground_row[]                            */
#define GROUND_TOP   168    /* GROUND_ROW * 8                              */
#define SPIKE_Y      160    /* spikes stand on the ground                  */
#define PIT_KILL_Y   200    /* fell below the 192-line screen → dead. Keep *
                             * this BELOW 0xD0=208: a sprite staged with   *
                             * Y=$D0 is the SAT TERMINATOR — the VDP stops *
                             * scanning and every later slot vanishes      */
#define NUM_COINS      3
#define NUM_SPIKES     2

static uint8_t  px;                 /* player screen x                     */
static uint16_t py_q44;             /* player y, Q4.4 fixed point — gravity
                                     * adds <1 px/frame near the jump apex,
                                     * so we need sub-pixel precision      */
static int8_t   vy_q44;
static uint8_t  on_ground;
static uint8_t  scroll_x;           /* level scroll — uint8 wraps at 256 = *
                                     * exactly one level loop (seamless)   */
static uint8_t  dist_sub;           /* sub-counter: 64 px scrolled = +1 pt */
static uint8_t  coin_x[NUM_COINS], coin_y[NUM_COINS];
static uint8_t  spike_x[NUM_SPIKES], spike_active[NUM_SPIKES];

/* Players: index 0 = P1 (port A), 1 = P2 (port B — alternating turns,
 * arcade-classic style). Each has own score + own lives; the HUD shows the
 * CURRENT player's numbers. */
static uint8_t  two_player;
static uint8_t  cur_player;
static uint8_t  p_lives[2];
static uint16_t p_score[2];
static uint16_t hiscore;
static uint8_t  turn_pause;         /* freeze frames after a turn change   */
static uint8_t  hud_dirty;          /* score/lives changed → redraw next vblank */
static uint8_t  over_step;          /* game-over text, one piece per vblank */
static uint8_t  prev_pad;
static uint16_t rng = 0xC0DE;

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * LINE-INTERRUPT SPLIT SCROLL — the SMS's signature trick (fixed status bar
 * over a moving field, palette splits, water effects). The VDP has ONE
 * scroll register pair for the whole frame; to keep the HUD fixed while the
 * level scrolls you change the scroll MID-FRAME. Where the NES needs the
 * sprite-0-hit HACK (park a sprite, busy-poll a status bit, burn scanlines
 * spinning), the SMS has a real, PROGRAMMABLE line interrupt:
 *
 *   R10 = N        line counter: a down-counter reloaded with N every line
 *                  outside the active area; underflow → IRQ at line N.
 *   R0 bit 4 (IE1) line-IRQ enable (already set in vdp_init's 0x36 baseline).
 *   R1 bit 5 (IE0) frame(vblank)-IRQ enable (set by sms_vdp_display_on's 0xE0).
 *
 * Both IRQs land on the Z80's IM-1 vector at $0038. The crt0's handler does
 * the canonical minimal handshake:  push af / in a,($BF) / pop af / ei / reti
 * — reading the status port ACKS the VDP (clears BOTH pending flags; skip
 * the read and the IRQ line stays asserted = interrupt storm), and EI must
 * precede RETI or interrupts stay off forever after the first one.
 *
 * Because the handler does no work, the MAIN loop synchronizes with HALT:
 * the Z80 sleeps until the next interrupt, then we read the V-counter (port
 * $7E) to learn WHICH one woke us — line IRQs only fire during the active
 * area (V < 0xC0 here), the frame IRQ fires at vblank (V ≥ 0xC0).
 *
 *   wait_vblank():  sleep until the frame IRQ  → do per-frame VRAM work,
 *                   write R8 = 0 so the HUD strip renders unscrolled.
 *   wait_split():   sleep until the line IRQ at line 23 (R10 = HUD_PX-1,
 *                   the last line of the solid bar row — any single-line
 *                   tear from the mid-row write hides inside solid colour)
 *                   → write R8 = -scroll_x; everything below scrolls.
 *
 * SCROLL DIRECTION — why R8 gets MINUS scroll_x: R8 shifts the whole plane
 * RIGHT as it grows (name-table column 0 appears at screen x = R8). To move
 * the WINDOW right through the world (level flows left as the player runs
 * right) you write the negation: R8 = -scroll_x, so screen pixel x shows
 * name-table pixel (x + scroll_x) & 0xFF. Get the sign wrong and the world
 * runs backwards under the player.
 *
 * FOOTGUN — you cannot poll once IRQs are on: sms_vblank_wait() spins on
 * the same status port the ISR reads. The ISR always wins the race (the
 * IRQ fires the instant the flag sets), eats the flag, and the poll loop
 * hangs forever. HALT + V-counter is the IRQ-era replacement.
 *
 * FOOTGUN — why this is a HORIZONTAL scroller: the Y-scroll register (R9)
 * is LATCHED ONCE PER FRAME by the VDP; mid-frame R9 writes do nothing
 * until the next frame, so a "vertical scroll below the HUD" split is
 * impossible on this chip. X-scroll (R8) is sampled per line — that's the
 * one you can change mid-frame. (A vertical or 4-way platformer needs
 * name-table streaming instead — see the MENTAL_MODEL doc.)
 *
 * Requires: R10 programmed, IE1 + IE0 enabled, EI executed once after
 * display-on, the crt0's ack-only ISR, and wait_vblank/wait_split called
 * EVERY frame in this order. R10 reloads after each underflow, so the line
 * IRQ re-fires every HUD_PX lines all the way down the frame — the later
 * wakes harmlessly interrupt game logic (the ISR acks them) and re-halt
 * inside the NEXT wait_vblank(). */
#define SPLIT_LINE (HUD_PX - 1)

static void wait_vblank(void) {
  /* check-first: if game logic overran into vblank, don't sleep a frame */
  while (PORT_V_COUNTER < 0xC0) { __asm__("halt"); }
  sms_vdp_write_reg(8, 0);          /* HUD strip renders with X scroll 0 */
}

static void wait_split(void) {
  /* halt-first: vblank work always ends inside vblank (V ≥ 0xC0), and the
   * first wake at V < 0xC0 is the line IRQ at SPLIT_LINE */
  do { __asm__("halt"); } while (PORT_V_COUNTER >= 0xC0);
  sms_vdp_write_reg(8, (uint8_t)(0 - scroll_x));  /* level below the bar */
}

/* ── HARDWARE IDIOM (load-bearing) — hi-score in Sega-mapper cart RAM ────────
 * The Sega mapper's control register at $FFFC: bit 3 maps the cart's 8KB
 * battery RAM into $8000-$BFFF (bank slot 2). Map → copy → unmap; keep the
 * window short so stray pointer bugs can't shred the save. The block is
 * magic + value + checksum so a never-written cart (all $FF) reads back as
 * "no save" instead of a garbage hi-score.
 *
 * NOTE the $FFFC address: it's IN the WRAM mirror ($C000-$DFFF mirrors at
 * $E000-$FFFF), so this write also lands in WRAM at $DFFC — the mapper
 * just snoops the bus. That's why the crt0 parks SP at $DFF0: the bytes
 * above it ($DFFC-$FFFF) belong to the mapper registers' shadow.
 *
 * HONESTY (verified 2026-06-10 against the bundled gpgx core): gpgx only
 * instantiates the Sega mapper for ROMs LARGER than 48KB, and this build
 * pipeline emits 32KB ROMs — so in-emulator the $8000 window stays open-bus
 * (reads $FF), the magic check fails, and the game falls back to the WRAM
 * hi-score (in-session only). The code below is still the correct
 * real-hardware idiom and lights up unchanged on a >48KB build or a cart
 * with battery RAM: the load path is self-falsifying, never wrong. */
#define MAPPER_CTRL (*(volatile uint8_t *)0xFFFC)
#define CART_RAM    ((volatile uint8_t *)0x8000)

static void hiscore_save(uint16_t v) {
  uint8_t lo = (uint8_t)(v & 0xFF), hi = (uint8_t)(v >> 8);
  MAPPER_CTRL = 0x08;               /* map cart RAM at $8000 */
  CART_RAM[0] = 0x48;               /* 'H' */
  CART_RAM[1] = 0x53;               /* 'S' */
  CART_RAM[2] = lo;
  CART_RAM[3] = hi;
  CART_RAM[4] = (uint8_t)(lo ^ hi ^ 0xA5);
  MAPPER_CTRL = 0x00;               /* back to ROM in slot 2 */
}

static uint16_t hiscore_load(void) {
  uint16_t v = 0;
  MAPPER_CTRL = 0x08;
  if (CART_RAM[0] == 0x48 && CART_RAM[1] == 0x53 &&
      CART_RAM[4] == (uint8_t)(CART_RAM[2] ^ CART_RAM[3] ^ 0xA5)) {
    v = (uint16_t)(CART_RAM[2] | ((uint16_t)CART_RAM[3] << 8));
  }
  MAPPER_CTRL = 0x00;
  return v;
}

/* ── GAME LOGIC (clay) — xorshift16 PRNG (~tens of cycles per call) ── */
static uint8_t random8(void) {
  uint16_t r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (uint8_t)r;
}

static uint8_t dist8(uint8_t a, uint8_t b) {
  return (a > b) ? (uint8_t)(a - b) : (uint8_t)(b - a);
}

/* ── GAME LOGIC (clay) — text via the font tiles ─────────────────────────────
 * These write the name table directly, so call them only during vblank (or
 * with the display off): VRAM access during active display races the VDP's
 * own fetches and drops/garbles bytes on real hardware. */
static uint8_t font_tile(char ch) {
  if (ch >= '0' && ch <= '9') return (uint8_t)(FONT_BASE + (ch - '0'));
  if (ch >= 'A' && ch <= 'Z') return (uint8_t)(FONT_BASE + 10 + (ch - 'A'));
  if (ch == '-') return (uint8_t)(FONT_BASE + 36);
  return 0;                         /* space → blank tile */
}

static void text_draw(uint8_t row, uint8_t col, const char *s) {
  while (*s) sms_set_tilemap_cell(row, col++, font_tile(*s++), 0);
}

static void draw_u16(uint8_t row, uint8_t col, uint16_t v) {
  uint8_t d[5], i;
  for (i = 0; i < 5; i++) { d[i] = (uint8_t)(v % 10); v /= 10; }
  for (i = 0; i < 5; i++)
    sms_set_tilemap_cell(row, (uint8_t)(col + i), (uint8_t)(FONT_BASE + d[4 - i]), 0);
}

/* ── GAME LOGIC (clay) — HUD: P# lives SC sssss HI hhhhh on row 0 ──
 * (columns start at 1 — the R0 left-column blank hides column 0) */
static void draw_hud_labels(void) {
  text_draw(0, 1, "P");
  text_draw(0, 6, "SC");
  text_draw(0, 16, "HI");
}

static void draw_hud(void) {
  sms_set_tilemap_cell(0, 2, (uint8_t)(FONT_BASE + 1 + cur_player), 0);  /* '1'/'2' */
  sms_set_tilemap_cell(0, 4, (uint8_t)(FONT_BASE + (p_lives[cur_player] > 9 ? 9 : p_lives[cur_player])), 0);
  draw_u16(0, 9, p_score[cur_player]);
  draw_u16(0, 19, hiscore);
}

/* ── GAME LOGIC (clay) — screen painters ─────────────────────────────────────
 * Full-screen repaints happen with the DISPLAY OFF (free VRAM access, and a
 * clean cut instead of a visible wipe). While the display is off the frame
 * IRQ doesn't fire — so no halt-based waits in here, or you hang forever. */
/* PERF FOOTGUN (inherited from the shmup, found the slow way): per-cell
 * sms_set_tilemap_cell redoes the 4-OUT address setup for every cell — over
 * a full screen that's seconds of black. Set the VRAM address ONCE per row
 * (the data port autoincrements through the row's 64 bytes) and stream. */
static uint8_t field_tile(uint8_t r, uint8_t c) {
  uint8_t g = ground_row[c];
  if (r == plat_row[c]) return BG_GRASS;        /* one-way floating slab  */
  if (g != NO_GROUND) {
    if (r == g) return BG_GRASS;                /* ground surface         */
    if (r > g) return BG_DIRT;                  /* ground body            */
  }
  /* sparse clouds in the sky band — add/compare counters, no division */
  if (r >= 4 && r <= 8 && ((uint8_t)(r * 7 + c * 5) & 15) == 0) return BG_CLOUD;
  return 0;                                     /* sky                    */
}

static void paint_rows(uint8_t from_row) {
  uint8_t r, c;
  for (r = from_row; r < 24; r++) {
    sms_vdp_set_addr((uint16_t)(0x3800 + (uint16_t)r * 64), VDP_VRAM_WRITE);
    for (c = 0; c < 32; c++) {
      PORT_VDP_DATA = field_tile(r, c);   /* name-table entry low byte */
      PORT_VDP_DATA = 0;                  /* high byte: flips/palette/priority */
    }
  }
}

static void paint_title(void) {
  sms_vdp_display_off();
  paint_rows(0);                    /* the level itself is the backdrop */
  text_draw(6, (uint8_t)((32 - (sizeof(GAME_TITLE) - 1)) / 2), GAME_TITLE);
  text_draw(11, 10, "1P START - 1");
  text_draw(13, 10, "2P TURNS - 2");
  text_draw(17, 12, "HI");
  draw_u16(17, 15, hiscore);
  sms_sprite_init();                /* park every sprite off-screen */
  sms_sat_upload();
  sms_vdp_write_reg(8, 0);
  sms_vdp_display_on();             /* re-enables the frame IRQ too */
}

static void paint_field(void) {
  uint8_t c;
  sms_vdp_display_off();
  for (c = 0; c < 32; c++) {
    sms_set_tilemap_cell(0, c, 0, 0);          /* row 0: HUD text row */
    sms_set_tilemap_cell(1, c, 0, 0);          /* row 1: breathing room */
    sms_set_tilemap_cell(2, c, BG_HUDBAR, 0);  /* row 2: bar = divider + seam */
  }
  paint_rows(HUD_ROWS);
  draw_hud_labels();
  draw_hud();
  sms_sprite_init();
  sms_sat_upload();
  sms_vdp_write_reg(8, 0);
  sms_vdp_display_on();
}

/* ── GAME LOGIC (clay) — coins + spikes (sprite objects in the world) ── */
static const uint8_t coin_heights[4] = { 144, 120, 88, 112 };
static void respawn_coin(uint8_t i) {
  coin_x[i] = (uint8_t)(232 + (random8() & 15));   /* enter at the right  */
  coin_y[i] = coin_heights[random8() & 3];
}

static void try_spawn_spike(uint8_t i) {
  /* Anchor only over ground: an inactive spike rolls a low per-frame
   * chance, and only spawns if the level column entering at the right
   * edge has ground under it (never floats over a pit). */
  uint8_t c = (uint8_t)(248 + scroll_x) >> 3;
  if (ground_row[c] == NO_GROUND) return;
  if (random8() > 4) return;
  spike_x[i] = 248;
  spike_active[i] = 1;
}

/* ── GAME LOGIC (clay) — start a turn / a run / end a run ── */
static void begin_turn(void) {
  /* NO direct VRAM writes here — this runs mid-frame from kill_player()
   * (active display). The HUD change goes through hud_dirty and lands in
   * the next vblank; the level needs no repaint (it's 256-px periodic and
   * scroll_x=0 just snaps the window back to the start). */
  px = 24;
  py_q44 = (uint16_t)(GROUND_TOP - 8) << 4;
  vy_q44 = 0;
  on_ground = 1;
  scroll_x = 0;
  dist_sub = 0;
  coin_x[0] =  88; coin_y[0] = 144;
  coin_x[1] = 152; coin_y[1] = 120;
  coin_x[2] = 216; coin_y[2] =  88;
  spike_x[0] = 136; spike_active[0] = 1;   /* both anchored on ground at  */
  spike_x[1] = 224; spike_active[1] = 1;   /* scroll 0 — see ground_row   */
  turn_pause = 48;                         /* "P1/P2 ready" breather      */
  prev_pad = 0xFF;                         /* swallow held buttons across *
                                            * the turn change             */
  hud_dirty = 1;                           /* shows the new P#/lives      */
}

static void start_game(uint8_t players) {
  two_player = players;
  cur_player = 0;
  p_score[0] = p_score[1] = 0;
  p_lives[0] = START_LIVES;
  p_lives[1] = players ? START_LIVES : 0;
  paint_field();                           /* display-off repaint — safe  */
  begin_turn();
  sfx_tone(2, 254, 8);                     /* start jingle (A4)           */
  state = ST_PLAY;
}

static void game_over(void) {
  uint16_t best = p_score[0];
  if (two_player && p_score[1] > best) best = p_score[1];
  if (best > hiscore) {
    hiscore = best;
    hiscore_save(hiscore);  /* cart RAM (real hardware); WRAM copy is live */
  }
  sfx_noise(20);
  state = ST_OVER;
  over_step = 4;             /* results text, one piece per vblank — each
                              * draw_u16 is 5 software divisions, and the
                              * vblank→split budget only fits one (see the
                              * BUDGET FOOTGUN at the main loop) */
}

/* ── GAME LOGIC (clay) — death + alternating-turn handoff ── */
static void kill_player(void) {
  uint8_t other;
  sfx_noise(14);
  if (p_lives[cur_player] > 0) --p_lives[cur_player];
  if (two_player) {
    other = cur_player ^ 1;
    if (p_lives[other] > 0) cur_player = other;          /* swap turns   */
    else if (p_lives[cur_player] == 0) { game_over(); return; }
  } else if (p_lives[0] == 0) {
    game_over();
    return;
  }
  begin_turn();
}

/* ── GAME LOGIC (clay) — landing probe against the column map ──────────────
 * One-way platforms, classic style: only catch the player while FALLING
 * through a narrow window at the surface. The window is 6 px tall —
 * top-1 (the standing snap parks feet at top, and gravity's sub-pixel
 * trickle doesn't move the integer Y every frame; without the -1 slack the
 * player "stands" with on_ground=0 most frames, so jumps only register on
 * lucky frames and the idle/jump sprite flickers) through top+4 (so a
 * 5 px/frame terminal-velocity fall can't step over it). */
static uint8_t land_top(uint8_t c, uint8_t feet) {
  uint8_t r, top;
  r = plat_row[c];
  if (r) {
    top = (uint8_t)(r << 3);
    if ((uint8_t)(feet + 1) >= top && feet <= (uint8_t)(top + 4)) return top;
  }
  r = ground_row[c];
  if (r != NO_GROUND) {
    top = (uint8_t)(r << 3);
    if ((uint8_t)(feet + 1) >= top && feet <= (uint8_t)(top + 4)) return top;
  }
  return 0;
}

/* Stage the SAT shadow for this frame. Inactive slots park at Y=$E0 (below
 * the 192-line area). NEVER park at Y=$D0 — that's the SAT terminator: the
 * VDP stops scanning at the first $D0 and every later slot vanishes.
 * Slot map: 0 = player, 1-3 coins, 4-5 spikes — 6 of 64 slots; mind the
 * 8-sprites-PER-SCANLINE limit when adding rows of objects (the 9th sprite
 * on a line silently vanishes). */
static void stage_sprites(void) {
  uint8_t i, y8 = (uint8_t)(py_q44 >> 4);
  /* Blink the player during the turn-change breather. */
  uint8_t show = (turn_pause == 0 || (turn_pause & 4));
  sms_sprite_set(0, px, show ? y8 : 0xE0,
                 on_ground ? T_PLAYER_IDLE : T_PLAYER_JUMP);
  for (i = 0; i < NUM_COINS; i++)
    sms_sprite_set((uint8_t)(1 + i), coin_x[i], coin_y[i], T_COIN);
  for (i = 0; i < NUM_SPIKES; i++)
    sms_sprite_set((uint8_t)(4 + i), spike_x[i], spike_active[i] ? SPIKE_Y : 0xE0, T_SPIKE);
}

void main(void) {
  uint8_t i, pad, delta, y8, feet, c0, c1, top, killed;

  /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
   * Init order: VDP regs (display off) → palette → tiles → name table →
   * SAT → R10 → display on (which also enables the frame IRQ) → EI. The
   * one hard rule: EI comes LAST, after every register is in place — the
   * crt0 boots with DI and the FIRST halt would hang forever if interrupts
   * were never enabled. */
  sms_vdp_init();                    /* R0=0x36 already has IE1 (line IRQ) set */
  sms_load_palette(palette);
  load_font();
  sms_load_tiles((uint16_t)(BG_GRASS * 32), deco_tiles, 128);
  sms_load_tiles(0x2000, sprite_tiles, 32 * 4);
  sms_sprite_init();
  sfx_init();
  music_init();
  music_play(0);

  /* R10 = SPLIT_LINE arms the line counter: IRQ at the last bar line. Set
   * once — it reloads itself every underflow. */
  sms_vdp_write_reg(10, SPLIT_LINE);

  hiscore = hiscore_load();          /* cart RAM if present — else 0 */
  state = ST_TITLE;
  paint_title();
  __asm__("ei");                     /* interrupts live from here on */

  for (;;) {
    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: button 1 = 1P, button 2 = 2P turns ── */
      wait_vblank();
      sfx_update();
      music_update();
      pad = sms_joypad_read();
      if ((pad & JOY_B1) && !(prev_pad & JOY_B1)) start_game(0);
      else if ((pad & JOY_B2) && !(prev_pad & JOY_B2)) start_game(1);
      prev_pad = pad;
      continue;
    }

    if (state == ST_OVER) {
      /* Freeze the final frame; button 1 or 2 returns to the title. */
      wait_vblank();
      if (over_step) {               /* deferred draws — one per vblank   */
        if (over_step == 4) text_draw(11, 11, "GAME OVER");
        else if (over_step == 3) { text_draw(13, 9, "P1"); draw_u16(13, 13, p_score[0]); }
        else if (over_step == 2) { if (two_player) { text_draw(15, 9, "P2"); draw_u16(15, 13, p_score[1]); } }
        else draw_hud();             /* show the (possibly new) hi-score  */
        over_step--;
      }
      wait_split();                  /* keep the HUD/field split alive */
      sfx_update();
      music_update();
      pad = sms_joypad_read();
      if ((pad & (JOY_B1 | JOY_B2)) && !(prev_pad & (JOY_B1 | JOY_B2))) {
        state = ST_TITLE;
        paint_title();
      }
      prev_pad = pad;
      continue;
    }

    /* ── ST_PLAY ─────────────────────────────────────────────────────────
     * Frame shape: [vblank: SAT + HUD writes, R8=0] → [line IRQ at the bar:
     * R8=-scroll] → [rest of frame: game logic]. VRAM traffic stays inside
     * vblank; logic runs while the VDP draws the field.
     *
     * BUDGET FOOTGUN (inherited from the shmup, which found it the hard
     * way): everything between wait_vblank() and wait_split() must finish
     * before the line IRQ at line 23 — vblank (70 lines) + the HUD strip
     * (23) ≈ 21k cycles. The SAT upload eats ~7k of that. An unconditional
     * draw_hud() here (10 software 16-bit divisions for the digits) blows
     * the budget EVERY frame: the seam slips to a later reload of the line
     * counter and the top of the level renders unscrolled in jittery
     * stripes. Hence the dirty flag — the HUD only redraws on the frame
     * after the score/lives/player actually changed. */
    wait_vblank();
    sms_sat_upload();                /* shadow SAT staged at end of last frame */
    if (hud_dirty) {
      hud_dirty = 0;
      draw_hud();
    }
    sfx_update();
    music_update();
    wait_split();                    /* the line-interrupt split — every frame */

    if (turn_pause) {                /* freeze gameplay, keep the frame honest */
      --turn_pause;
      stage_sprites();               /* blink runs; SAT stays fresh */
      continue;
    }

    /* ── GAME LOGIC (clay) from here down ──────────────────────────────
     * Input — the CURRENT player's pad (alternating turns: P2 is on port
     * B). Past SCROLL_WALL the world scrolls instead of the player (the
     * camera never scrolls back — the classic one-way camera). */
    pad = cur_player ? sms_joypad_read_p2() : sms_joypad_read();
    delta = 0;
    if (pad & JOY_RIGHT) {
      if (px < SCROLL_WALL) px = (uint8_t)(px + MOVE_SPEED);
      else { scroll_x = (uint8_t)(scroll_x + MOVE_SPEED); delta = MOVE_SPEED; }
    }
    if ((pad & JOY_LEFT) && px > 8) px = (uint8_t)(px - MOVE_SPEED);
    if ((pad & JOY_B1) && !(prev_pad & JOY_B1) && on_ground) {
      vy_q44 = JUMP_VEL_Q44;
      on_ground = 0;
      /* Voice 2 doubles as the SFX channel: the whoop steals the bass for
       * a few frames, then sfx_update() silences it and the tracker
       * re-tones it on its next step — classic "sfx wins" arbitration. */
      sfx_tone(2, 220, 6);
    }
    prev_pad = pad;

    /* World objects drift left as the level scrolls (world-anchored). */
    if (delta) {
      dist_sub = (uint8_t)(dist_sub + delta);
      if (dist_sub >= 64) {                              /* distance pay  */
        dist_sub -= 64;
        ++p_score[cur_player];
        hud_dirty = 1;
      }
      for (i = 0; i < NUM_COINS; i++) {
        if (coin_x[i] < 16 + delta) respawn_coin(i);
        else coin_x[i] = (uint8_t)(coin_x[i] - delta);
      }
      for (i = 0; i < NUM_SPIKES; i++) {
        if (!spike_active[i]) continue;
        if (spike_x[i] < 16 + delta) spike_active[i] = 0;
        else spike_x[i] = (uint8_t)(spike_x[i] - delta);
      }
    }
    for (i = 0; i < NUM_SPIKES; i++)
      if (!spike_active[i]) try_spawn_spike(i);

    /* Physics: gravity + sub-pixel Y. */
    if (vy_q44 < MAX_VY_Q44) vy_q44 += GRAVITY_Q44;
    py_q44 = (uint16_t)(py_q44 + (int16_t)vy_q44);
    y8 = (uint8_t)(py_q44 >> 4);

    /* Fell into a pit (below the 192-line screen) → lose the turn. */
    if (y8 >= PIT_KILL_Y) {
      kill_player();
      continue;
    }

    /* Landing — probe the two level columns under the player's feet. */
    if (vy_q44 >= 0) {
      feet = (uint8_t)(y8 + 8);
      c0 = (uint8_t)(px + scroll_x) >> 3;
      c1 = (uint8_t)(px + scroll_x + 7) >> 3;
      top = land_top(c0, feet);
      if (top == 0) top = land_top(c1, feet);
      if (top) {
        py_q44 = (uint16_t)(top - 8) << 4;
        vy_q44 = 0;
        if (!on_ground) sfx_tone(2, 400, 2);             /* landing thud  */
        on_ground = 1;
      } else {
        on_ground = 0;                                   /* walked off    */
      }
    }

    /* Coins (collect) + spikes (death). */
    for (i = 0; i < NUM_COINS; i++) {
      if (dist8(coin_x[i], px) < 8 && dist8(coin_y[i], y8) < 8) {
        p_score[cur_player] += 10;
        sfx_tone(2, 140, 4);                             /* coin ping     */
        hud_dirty = 1;
        respawn_coin(i);
      }
    }
    killed = 0;
    for (i = 0; i < NUM_SPIKES; i++) {
      if (!spike_active[i]) continue;
      if (dist8(spike_x[i], px) < 7 && dist8(SPIKE_Y, y8) < 7) {
        killed = 1;
        break;
      }
    }
    if (killed) kill_player();

    /* Stage the SAT shadow NOW (RAM only — cheap, any time); the actual
     * VRAM upload waits for the next vblank at the top of the loop. */
    stage_sprites();
  }
}
