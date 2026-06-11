/* ── shmup.c — Game Gear vertical shooter (complete example game) ────────────
 *
 * A COMPLETE, working game — title screen (press START), lives, score +
 * hi-score (cart-RAM save code included — see the honesty note at
 * hiscore_save), PSG music + SFX, and the GG/SMS signature LINE INTERRUPT
 * split: a fixed HUD strip over a drifting starfield, with the scroll change
 * timed by the VDP's programmable line counter.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented GG footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — enemy patterns, scoring, tuning, art: reshape freely.
 *
 * SINGLE-PLAYER BY DESIGN (honest note): the Game Gear has ONE controller —
 * its 2P story is the Gear-to-Gear link cable on the EXT port, which needs a
 * second console and can't be emulated in a single emulator instance. So
 * this game is honestly 1P; the console examples (SMS/NES/Genesis/…) carry
 * the 2P modes.
 *
 * THE #1 GG FOOTGUN — THE VISIBLE WINDOW: the GG VDP is the SMS VDP. It
 * renders a full 256×192 frame; the LCD shows only the CENTERED 160×144 of
 * it. Hardware coordinates (sprite OAM, tilemap rows/cols, scanline counts)
 * are all in the FULL 256×192 frame — content placed outside the centered
 * window is rendered "correctly" and is simply never shown. Every SMS habit
 * ports over EXCEPT placement: see the VIS_* block below, which this whole
 * file is written against. (The emulator screenshot is the 160×144 visible
 * crop — "my sprite is at y=10 but invisible" means it's parked in the
 * unseen border, not a render bug.)
 *
 * What depends on what:
 *   gg_hw.h / vdp_init.c / load_tiles.c / load_palette.c / sprite_table.c /
 *     joypad_read.c — the bundled VDP + input runtime (this file's externs).
 *   gg_sfx.{h,c} + gg_music.{h,c} — SN76489 PSG sound layers (music owns
 *     PSG ch 2; sfx use ch 0/1 + noise ch 3 — no arbitration needed).
 *   gg_crt0.s — boot + vector table. Its $0038 IM-1 handler is the OTHER
 *     HALF of the line-interrupt idiom below: it acks the VDP (one status
 *     read clears BOTH the frame and line IRQ flags) and returns with
 *     ei/reti. Load-bearing; edit with TROUBLESHOOTING open.
 *
 * Frame budget (60fps): SAT upload (192 OUTs) + HUD redraw fit easily in
 * vblank (70 lines) + the 47 scanlines above the split; the whole update
 * (6 bullets × 6 enemies AABB ≈ 36 checks worst case) fits in one frame
 * with room to spare.
 */
#include "gg_hw.h"
#include "gg_sfx.h"
#include "gg_music.h"
#include <stdint.h>

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "PRISM PATROL"

extern void    gg_vdp_init(void);
extern void    gg_vdp_write_reg(uint8_t reg, uint8_t value);
extern void    gg_vdp_display_on(void);
extern void    gg_vdp_display_off(void);
extern void    gg_vdp_set_addr(uint16_t addr, uint8_t prefix);
extern void    gg_load_palette(const uint8_t *palette);
extern void    gg_load_tiles(uint16_t vram_dest, const uint8_t *src, uint16_t byte_count);
extern void    gg_set_tilemap_cell(uint8_t row, uint8_t col, uint8_t tile_idx, uint8_t attr);
extern uint8_t gg_joypad_read(void);
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
 * (HUD placement, split line, spawn ranges, movement clamps, text columns)
 * is derived from them; if you reshape the layout, derive from VIS_*, never
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
 * Palette. THE GG's HEADLINE UPGRADE over the SMS: CRAM holds 12-bit
 * 4-4-4 BGR colour (4096 colours) instead of the SMS's 6-bit 2-2-2 (64).
 * The WRITE FORMAT differs too — that's the #2 GG footgun:
 *
 *   SMS: 32 entries × 1 byte   --BBGGRR
 *   GG:  32 entries × 2 bytes  little-endian: low byte = GGGGRRRR
 *                                             high byte = ----BBBB
 *
 * So a GG palette array is 64 bytes (entries 0-15 BG, 16-31 sprite). Feeding
 * gg_load_palette a 32-byte SMS-style table reads past the array — the
 * sprite palette loads garbage and every sprite renders invisible (this
 * exact bug shipped in an earlier GG scaffold round). Pack an entry with:
 * low = (g << 4) | r, high = b, each channel 0..15. Most colours below
 * (15-step mints, ambers, duskpinks) have NO 2-2-2 SMS equivalent — that's
 * the 4096-colour panel earning its keep. */
static const uint8_t palette[64] = {
  /* BG 0-15: 0 = deep-space violet (backdrop/border), 1 = HUD-bar teal,
   * 2 = dim star lavender, 3 = white (text), 4 = nebula dusk-magenta,
   * 5 = nebula indigo */
  0x01,0x04, 0x50,0x08, 0x78,0x0C, 0xFF,0x0F, 0x17,0x06, 0x22,0x08,
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
  /* SPRITE 16-31: 16 = transparent, 17 = ice-mint (ship), 18 = amber
   * (bullet), 19 = magenta / 20 = cyan / 21 = lime — the three enemy
   * "prism" hues. One shared sprite palette on GG/SMS: per-sprite colour
   * means per-TILE colour indices, not per-sprite palettes. */
  0,0, 0xFB,0x0C, 0xAF,0x01, 0x2E,0x0B, 0xC1,0x0E, 0xE8,0x02,
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
};

/* ── GAME LOGIC (clay) — BG tile inventory (BG bank $0000) ───────────────────
 * tile 0          = blank space (colour 0)
 * tiles 1..37     = font: digits 0-9, A-Z, '-'  (uploaded 1bpp→4bpp below)
 * tile 38         = dim star   (one colour-2 pixel)
 * tile 39         = bright star(one colour-3 pixel + glow)
 * tile 40         = solid HUD bar (colour 1) — the split seam hides in it
 * tile 41         = nebula band A (solid colour 4)
 * tile 42         = nebula band B (solid colour 5) — two band hues keep the
 *                   field colourful AND off the render-health blank floor */
#define FONT_BASE  1
#define BG_STAR    38
#define BG_BRITE   39
#define BG_HUDBAR  40
#define BG_BANDA   41
#define BG_BANDB   42

/* 1bpp font (same glyph set as the NES/SMS/GB examples — 0-9, A-Z, '-').
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

/* Expand 1bpp glyphs into 4bpp tiles as colour 3 (planes 0+1 set).
 * GG/SMS tile rows are 4 bytes: plane0, plane1, plane2, plane3. */
static void load_font(void) {
  uint8_t g, r, bits;
  gg_vdp_set_addr((uint16_t)(FONT_BASE * 32), VDP_VRAM_WRITE);
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

/* Star + HUD-bar + band tiles (4bpp, 32 bytes each — rows of plane0..3). */
static const uint8_t deco_tiles[160] = {
  /* BG_STAR: one colour-2 pixel */
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x10,0x00,0x00, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  /* BG_BRITE: colour-3 dot with colour-2 glow */
  0x00,0x00,0x00,0x00, 0x00,0x10,0x00,0x00, 0x10,0x28,0x10,0x00, 0x00,0x10,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  /* BG_HUDBAR: solid colour 1 — the split seam lands inside this row */
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  /* BG_BANDA: solid colour 4 (binary 100 → plane 2 only) */
  0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00,
  0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00,
  /* BG_BANDB: solid colour 5 (binary 101 → planes 0+2) */
  0xFF,0x00,0xFF,0x00, 0xFF,0x00,0xFF,0x00, 0xFF,0x00,0xFF,0x00, 0xFF,0x00,0xFF,0x00,
  0xFF,0x00,0xFF,0x00, 0xFF,0x00,0xFF,0x00, 0xFF,0x00,0xFF,0x00, 0xFF,0x00,0xFF,0x00,
};

/* Sprite tiles (sprite bank $2000 — vdp_init's R6=0xFF baseline reads
 * sprite patterns from $2000, so upload there, not $0000). The three enemy
 * tiles use colour indices 3/4/5 — three different prism hues from ONE
 * shared sprite palette. */
static const uint8_t sprite_tiles[32 * 5] = {
  /* T_SHIP — arrowhead, colour 1 (ice mint, plane 0) */
  0x18,0x00,0x00,0x00, 0x18,0x00,0x00,0x00, 0x3C,0x00,0x00,0x00, 0x3C,0x00,0x00,0x00,
  0x7E,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xDB,0x00,0x00,0x00, 0x81,0x00,0x00,0x00,
  /* T_BULLET — slug, colour 2 (amber, plane 1) */
  0x00,0x18,0x00,0x00, 0x00,0x3C,0x00,0x00, 0x00,0x3C,0x00,0x00, 0x00,0x3C,0x00,0x00,
  0x00,0x3C,0x00,0x00, 0x00,0x3C,0x00,0x00, 0x00,0x18,0x00,0x00, 0x00,0x00,0x00,0x00,
  /* T_ENEMY0 — X fighter, colour 3 (magenta, planes 0+1) */
  0x81,0x81,0x00,0x00, 0x42,0x42,0x00,0x00, 0x24,0x24,0x00,0x00, 0xFF,0xFF,0x00,0x00,
  0xFF,0xFF,0x00,0x00, 0x24,0x24,0x00,0x00, 0x42,0x42,0x00,0x00, 0x81,0x81,0x00,0x00,
  /* T_ENEMY1 — hollow diamond, colour 4 (cyan, plane 2) */
  0x00,0x00,0x18,0x00, 0x00,0x00,0x3C,0x00, 0x00,0x00,0x66,0x00, 0x00,0x00,0xC3,0x00,
  0x00,0x00,0xC3,0x00, 0x00,0x00,0x66,0x00, 0x00,0x00,0x3C,0x00, 0x00,0x00,0x18,0x00,
  /* T_ENEMY2 — beetle, colour 5 (lime, planes 0+2) */
  0x3C,0x00,0x3C,0x00, 0x7E,0x00,0x7E,0x00, 0xDB,0x00,0xDB,0x00, 0xFF,0x00,0xFF,0x00,
  0xFF,0x00,0xFF,0x00, 0xDB,0x00,0xDB,0x00, 0x7E,0x00,0x7E,0x00, 0x3C,0x00,0x3C,0x00,
};
#define T_SHIP    0
#define T_BULLET  1
#define T_ENEMY0  2   /* + kind (0..2) selects the hue */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Object pools — fixed slots, no allocation (3.58MHz Z80, 8KB WRAM: a heap
 * buys you nothing). SAT slot map: 0 = ship, 1-6 bullets, 7-12 enemies —
 * 13 of 64 slots; mind the 8-sprites-PER-SCANLINE limit when adding rows
 * of objects (the 9th sprite on a line silently vanishes). */
#define MAX_BULLETS 6
#define MAX_ENEMIES 6
#define START_LIVES 3
/* HUD layout, in WINDOW rows: row 0 = text (SC / HI / L), row 1 = blank,
 * row 2 = solid bar. The bar row is both the visual divider AND where the
 * split seam hides. HUD_PX is the strip height in scanlines. */
#define HUD_ROWS    3
#define HUD_PX      (HUD_ROWS * 8)
/* First playfield scanline / sprite Y below the HUD (full-frame units). */
#define FIELD_TOP   (VIS_Y0 + HUD_PX)

static uint8_t bullet_active[MAX_BULLETS];
static uint8_t bullet_x[MAX_BULLETS];
static uint8_t bullet_y[MAX_BULLETS];
static uint8_t enemy_active[MAX_ENEMIES];
static uint8_t enemy_x[MAX_ENEMIES];
static uint8_t enemy_y[MAX_ENEMIES];
static uint8_t enemy_kind[MAX_ENEMIES];   /* 0..2 → prism hue + tile */

static uint8_t ship_x, ship_y, ship_alive, fire_cd;
static uint8_t lives;
static uint16_t score;
static uint16_t hiscore;
static uint8_t spawn_timer;
static uint8_t spawn_seq;        /* cycles 0,1,2 → every hue shows up */
static uint8_t scroll_x;         /* starfield drift (split-scrolled below HUD) */
static uint8_t over_pending;     /* defer GAME OVER text to the next vblank */
static uint8_t hud_dirty;        /* score/lives changed → redraw next vblank */
static uint16_t rng = 0xACE1;

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * LINE-INTERRUPT SPLIT SCROLL — the GG/SMS VDP's signature trick (fixed
 * status bar over a moving field, palette splits, water effects). The VDP
 * has ONE scroll register pair for the whole frame; to keep the HUD fixed
 * while the starfield drifts you change the scroll MID-FRAME. Where the NES
 * needs the sprite-0-hit HACK (park a sprite, busy-poll a status bit, burn
 * scanlines spinning), this VDP has a real, PROGRAMMABLE line interrupt:
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
 * 0..23 are rendered and never shown; they ride along with the HUD's
 * unscrolled region for free.
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
 *   wait_split():   sleep until the line IRQ at scanline 47 (the last line
 *                   of the solid bar row — any single-line tear from the
 *                   mid-row write hides inside solid colour) → write
 *                   R8 = scroll_x; everything below drifts.
 *
 * FOOTGUN — you cannot poll once IRQs are on: gg_vblank_wait() spins on
 * the same status port the ISR reads. The ISR always wins the race (the
 * IRQ fires the instant the flag sets), eats the flag, and the poll loop
 * hangs forever. HALT + V-counter is the IRQ-era replacement.
 *
 * FOOTGUN — why the field drifts HORIZONTALLY: the Y-scroll register (R9)
 * is LATCHED ONCE PER FRAME by the VDP; mid-frame R9 writes do nothing
 * until the next frame, so a "vertical scroll below the HUD" split is
 * impossible on this chip. X-scroll (R8) is sampled per line — that's the
 * one you can change mid-frame. (Vertical motion: animate the star tiles
 * or stream the name table instead.)
 *
 * Requires: R10 programmed, IE1 + IE0 enabled, EI executed once after
 * display-on, the crt0's ack-only ISR, and wait_vblank/wait_split called
 * EVERY frame in this order. R10 reloads after each underflow, so the line
 * IRQ re-fires every HUD_PX+VIS_Y0 lines down the frame (here: 47, 95,
 * 143, 191) — the later wakes harmlessly interrupt game logic (the ISR
 * acks them) and re-halt inside the NEXT wait_vblank(). */
#define SPLIT_LINE (VIS_Y0 + HUD_PX - 1)

static void wait_vblank(void) {
  /* check-first: if game logic overran into vblank, don't sleep a frame */
  while (PORT_V_COUNTER < 0xC0) { __asm__("halt"); }
  gg_vdp_write_reg(8, 0);           /* HUD strip renders with X scroll 0 */
}

static void wait_split(void) {
  /* halt-first: vblank work always ends inside vblank (V ≥ 0xC0), and the
   * first wake at V < 0xC0 is the line IRQ at SPLIT_LINE */
  do { __asm__("halt"); } while (PORT_V_COUNTER >= 0xC0);
  gg_vdp_write_reg(8, scroll_x);    /* field below the bar drifts */
}

/* ── HARDWARE IDIOM (load-bearing) — hi-score in Sega-mapper cart RAM ────────
 * Same cartridge mapper as the SMS. The control register at $FFFC: bit 3
 * maps the cart's 8KB battery RAM into $8000-$BFFF (bank slot 2). Map →
 * copy → unmap; keep the window short so stray pointer bugs can't shred
 * the save. The block is magic + value + checksum so a never-written cart
 * (all $FF) reads back as "no save" instead of a garbage hi-score.
 *
 * NOTE the $FFFC address: it's IN the WRAM mirror ($C000-$DFFF mirrors at
 * $E000-$FFFF), so this write also lands in WRAM at $DFFC — the mapper
 * just snoops the bus. That's why the crt0 parks SP at $DFF0: the bytes
 * above it ($DFFC-$FFFF) belong to the mapper registers' shadow.
 *
 * HONESTY (verified 2026-06-10 against the bundled gpgx core, same finding
 * as the SMS example): gpgx only instantiates the Sega mapper for ROMs
 * LARGER than 48KB, and this build pipeline emits 32KB ROMs — so
 * in-emulator the $8000 window stays open-bus (reads $FF), the magic check
 * fails, and the game falls back to the WRAM hi-score (in-session only).
 * The code below is still the correct real-hardware idiom and lights up
 * unchanged on a >48KB build or a cart with battery RAM: the load path is
 * self-falsifying, never wrong. (The verify harness proves it end-to-end
 * by padding this exact ROM to 64KB.) */
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

/* ── GAME LOGIC (clay) — HUD: SC sssss  HI hhhhh  Ln on window row 0.
 * Only 20 columns are visible — the layout below uses 18 of them. An SMS
 * HUD string laid out for 32 columns gets its ends cut off by the border. */
static void draw_hud_labels(void) {
  text_draw(0, 0, "SC");
  text_draw(0, 8, "HI");
  text_draw(0, 16, "L");
}

static void draw_hud(void) {
  draw_u16(0, 2, score);
  draw_u16(0, 10, hiscore);
  gg_set_tilemap_cell(VROW(0), VCOL(17), (uint8_t)(FONT_BASE + (lives > 9 ? 9 : lives)), 0);
}

/* ── GAME LOGIC (clay) — screen painters ─────────────────────────────────────
 * Full-screen repaints happen with the DISPLAY OFF (free VRAM access, and a
 * clean cut instead of a visible wipe). While the display is off the frame
 * IRQ doesn't fire — so no halt-based waits in here, or you hang forever.
 *
 * IRQ-RACE FOOTGUN (cost this file a letter of its own title): repaints also
 * run with INTERRUPTS OFF — the di/ei bracket below. Display-off stops the
 * FRAME IRQ but NOT the LINE IRQ (R0's IE1 stays set; the line counter runs
 * every scanline regardless of blanking). The crt0's ISR acks by READING the
 * control port ($BF) — and that read also resets the VDP's two-byte
 * address-latch state machine. If the line IRQ fires between the two bytes
 * of a gg_vdp_set_addr() control-port pair, the second byte is taken as a
 * new first byte, the VRAM address de-syncs, and one cell of your repaint
 * lands somewhere else ("PRISM ATROL"). Per-frame writes inside wait_vblank
 * don't need the bracket: vblank has no line IRQs and the frame IRQ was
 * already consumed by the halt that woke us. */
/* PERF FOOTGUN (inherited from the SMS example, found the slow way): the
 * obvious per-cell version of this — set_tilemap_cell(r, c, (r*7+c*5) % 11
 * ? ... ) — costs ~35 FRAMES: SDCC's 16-bit `%` is a software-division call
 * and set_tilemap_cell redoes the 4-OUT address setup for every cell. So:
 * set the VRAM address ONCE per row (the data port autoincrements through
 * the row's 64 bytes) and keep the star pattern in add/compare counters.
 * Paints in ~1 frame. We paint all 32 columns (not just the visible 20):
 * the off-window cells scroll INTO view as R8 drifts the field. */
static void paint_starfield(uint8_t from_row) {
  uint8_t r, c, t, s, q;
  for (r = from_row; r < 24; r++) {
    gg_vdp_set_addr((uint16_t)(0x3800 + (uint16_t)r * 64), VDP_VRAM_WRITE);
    /* s = (r*7) mod 11, q = (r*3) mod 29 — then walk +5 mod 11 / +13 mod 29
     * across the columns (same field as the % expressions, no division). */
    s = (uint8_t)(r * 7); while (s >= 11) s -= 11;
    q = (uint8_t)(r * 3); while (q >= 29) q -= 29;
    for (c = 0; c < 32; c++) {
      /* nebula bands every 4th row, alternating the two hues */
      t = ((r & 3) == 2) ? ((r & 4) ? BG_BANDA : BG_BANDB) : 0;
      if (s == 0) t = BG_STAR;
      if (q == 0) t = BG_BRITE;
      PORT_VDP_DATA = t;                  /* name-table entry low byte: tile */
      PORT_VDP_DATA = 0;                  /* high byte: flips/palette/priority */
      s += 5;  if (s >= 11) s -= 11;
      q += 13; if (q >= 29) q -= 29;
    }
  }
}

static void paint_title(void) {
  __asm__("di");                    /* see IRQ-RACE FOOTGUN above */
  gg_vdp_display_off();
  paint_starfield(0);
  text_draw(4, (uint8_t)((VIS_COLS - (sizeof(GAME_TITLE) - 1)) / 2), GAME_TITLE);
  text_draw(8, 4, "PRESS START");
  text_draw(12, 6, "HI");
  draw_u16(12, 9, hiscore);
  gg_sprite_init();                 /* park every sprite off-screen */
  gg_sat_upload();
  gg_vdp_write_reg(8, 0);
  gg_vdp_display_on();              /* re-enables the frame IRQ too */
  __asm__("ei");                    /* interrupts back on LAST — regs are set */
}

static void paint_field(void) {
  uint8_t c;
  __asm__("di");                    /* see IRQ-RACE FOOTGUN above */
  gg_vdp_display_off();
  for (c = 0; c < 32; c++) {
    gg_set_tilemap_cell(VROW(0), c, 0, 0);          /* HUD text row */
    gg_set_tilemap_cell(VROW(1), c, 0, 0);          /* breathing room */
    gg_set_tilemap_cell(VROW(2), c, BG_HUDBAR, 0);  /* bar = divider + seam */
  }
  paint_starfield(VIS_ROW0 + HUD_ROWS);
  draw_hud_labels();
  draw_hud();
  gg_sprite_init();
  gg_sat_upload();
  gg_vdp_write_reg(8, 0);
  gg_vdp_display_on();
  __asm__("ei");
}

/* ── GAME LOGIC (clay) — pools ── */
static void fire_bullet(void) {
  uint8_t i;
  for (i = 0; i < MAX_BULLETS; i++) {
    if (!bullet_active[i]) {
      bullet_active[i] = 1;
      bullet_x[i] = ship_x;
      bullet_y[i] = (uint8_t)(ship_y - 8);
      /* PSG ch 0 — gg_music owns ch 2, so sfx and music never collide. */
      sfx_tone(0, 180, 3);
      return;
    }
  }
}

static void spawn_enemy(void) {
  uint8_t i;
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemy_active[i]) {
      enemy_active[i] = 1;
      /* Spawn across the VISIBLE width only: VIS_X0 + (0..127) + (0..15)
       * lands in [48..190] — inside the window, never in the unseen
       * margin (an SMS-style 16..240 spawn range hides a third of the
       * enemies in the border). */
      enemy_x[i] = (uint8_t)(VIS_X0 + (random8() & 0x7F) + (random8() & 0x0F));
      enemy_y[i] = FIELD_TOP + 8;    /* just below the HUD bar */
      enemy_kind[i] = spawn_seq;     /* cycle the three prism hues */
      spawn_seq++;
      if (spawn_seq >= 3) spawn_seq = 0;
      return;
    }
  }
}

/* AABB, both boxes 8x8. */
static uint8_t hits(uint8_t ax, uint8_t ay, uint8_t bx, uint8_t by) {
  uint8_t dx = (ax > bx) ? (uint8_t)(ax - bx) : (uint8_t)(bx - ax);
  uint8_t dy = (ay > by) ? (uint8_t)(ay - by) : (uint8_t)(by - ay);
  return (uint8_t)((dx < 8) && (dy < 8));
}

/* ── GAME LOGIC (clay) — start a run / end a run ── */
static void start_game(void) {
  uint8_t i;
  for (i = 0; i < MAX_BULLETS; i++) bullet_active[i] = 0;
  for (i = 0; i < MAX_ENEMIES; i++) enemy_active[i] = 0;
  ship_x = VIS_X0 + VIS_W / 2 - 4;
  ship_y = VIS_Y1 - 23;
  ship_alive = 1;
  fire_cd = 0;
  lives = START_LIVES;
  score = 0;
  spawn_timer = 0;
  spawn_seq = 0;
  scroll_x = 0;
  over_pending = 0;
  paint_field();
  state = ST_PLAY;
}

static void game_over(void) {
  if (score > hiscore) {
    hiscore = score;
    hiscore_save(hiscore);  /* cart RAM (real hardware); WRAM copy is live */
  }
  sfx_noise(20);
  state = ST_OVER;
  over_pending = 1;          /* text is drawn next vblank — not mid-frame */
}

/* ── GAME LOGIC (clay) — ship update. Movement clamps to the VISIBLE box:
 * the hardware happily renders a ship at x=10, the LCD just never shows it. */
static void update_ship(uint8_t pad) {
  if (!ship_alive) return;
  if ((pad & JOY_LEFT)  && ship_x > VIS_X0)            ship_x = (uint8_t)(ship_x - 2);
  if ((pad & JOY_RIGHT) && ship_x < (VIS_X1 - 7))      ship_x = (uint8_t)(ship_x + 2);
  if ((pad & JOY_UP)    && ship_y > (FIELD_TOP + 8))   ship_y = (uint8_t)(ship_y - 2);
  if ((pad & JOY_DOWN)  && ship_y < (VIS_Y1 - 7))      ship_y = (uint8_t)(ship_y + 2);
  if ((pad & JOY_B1) && fire_cd == 0) {
    fire_bullet();
    fire_cd = 8;
  }
  if (fire_cd > 0) fire_cd--;
}

/* Stage the SAT shadow for this frame. Inactive slots park at Y=$E0 (below
 * the 192-line area AND below the LCD window). NEVER park at Y=$D0 — that's
 * the SAT terminator: the VDP stops scanning at the first $D0 and every
 * later slot vanishes. */
static void stage_sprites(void) {
  uint8_t i;
  gg_sprite_set(0, ship_x, ship_alive ? ship_y : 0xE0, T_SHIP);
  for (i = 0; i < MAX_BULLETS; i++)
    gg_sprite_set((uint8_t)(1 + i), bullet_x[i], bullet_active[i] ? bullet_y[i] : 0xE0, T_BULLET);
  for (i = 0; i < MAX_ENEMIES; i++)
    gg_sprite_set((uint8_t)(7 + i), enemy_x[i], enemy_active[i] ? enemy_y[i] : 0xE0,
                  (uint8_t)(T_ENEMY0 + enemy_kind[i]));
}

void main(void) {
  uint8_t i, pad, prev_pad = 0;

  /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
   * Init order: VDP regs (display off) → palette → tiles → name table →
   * SAT → R10 → display on (which also enables the frame IRQ) → EI. The
   * one hard rule: EI comes LAST, after every register is in place — the
   * crt0 boots with DI and the FIRST halt would hang forever if interrupts
   * were never enabled. (paint_title's trailing __asm__("ei") IS that final
   * step here — every repaint ends by re-arming interrupts.) */
  gg_vdp_init();                     /* R0=0x36 already has IE1 (line IRQ) set */
  gg_load_palette(palette);
  load_font();
  gg_load_tiles((uint16_t)(BG_STAR * 32), deco_tiles, 160);
  gg_load_tiles(0x2000, sprite_tiles, 32 * 5);
  gg_sprite_init();
  sfx_init();
  music_init();
  music_play(0);

  /* R10 = SPLIT_LINE arms the line counter: IRQ at the last bar line —
   * scanline 47 in FULL-FRAME terms (window top 24 + HUD 24 - 1). Set
   * once — it reloads itself every underflow. */
  gg_vdp_write_reg(10, SPLIT_LINE);

  hiscore = hiscore_load();          /* cart RAM if present — else 0 */
  state = ST_TITLE;
  paint_title();                     /* …ends with EI: interrupts live now */

  for (;;) {
    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: START begins a run. START is a
       * GG-only input: it lives on port $00 bit 7 (gg_joypad_read merges
       * it into bit 7 of the pad byte), NOT on the SMS pad port $DC. ── */
      wait_vblank();
      sfx_update();
      music_update();
      pad = gg_joypad_read();
      if ((pad & JOY_START) && !(prev_pad & JOY_START)) start_game();
      prev_pad = pad;
      continue;
    }

    if (state == ST_OVER) {
      /* Freeze the final frame; START returns to the title. */
      wait_vblank();
      if (over_pending) {            /* deferred draw — now we're in vblank */
        over_pending = 0;
        text_draw(8, 5, "GAME OVER");
        draw_hud();                  /* show the (possibly new) hi-score */
      }
      wait_split();                  /* keep the HUD/field split alive */
      sfx_update();
      music_update();
      pad = gg_joypad_read();
      if ((pad & JOY_START) && !(prev_pad & JOY_START)) {
        state = ST_TITLE;
        paint_title();
      }
      prev_pad = pad;
      continue;
    }

    /* ── ST_PLAY ─────────────────────────────────────────────────────────
     * Frame shape: [vblank: SAT + HUD writes, R8=0] → [line IRQ at the bar:
     * R8=scroll] → [rest of frame: game logic]. VRAM traffic stays inside
     * vblank; logic runs while the VDP draws the field.
     *
     * BUDGET FOOTGUN: everything between wait_vblank() and wait_split()
     * must finish before the line IRQ at scanline 47 — vblank (70 lines) +
     * the 47 lines above the split ≈ 27k cycles. (The GG split budget is
     * BIGGER than the SMS's: the 24 never-shown border lines are free
     * cycles.) The SAT upload eats ~7k of that. An unconditional draw_hud()
     * here (10 software 16-bit divisions for the digits) is the classic
     * budget-blower: miss the line and the seam slips to a later reload of
     * the line counter, and the top of the starfield renders unscrolled in
     * jittery stripes. Hence the dirty flag — the HUD only redraws on the
     * frame after the score/lives actually changed. */
    wait_vblank();
    gg_sat_upload();                 /* shadow SAT staged at end of last frame */
    if (hud_dirty) {
      hud_dirty = 0;
      draw_hud();
    }
    sfx_update();
    music_update();
    wait_split();                    /* the line-interrupt split — every frame */

    /* ── GAME LOGIC (clay) from here down ── */
    pad = gg_joypad_read();
    update_ship(pad);

    /* Starfield drift (the split keeps the HUD strip out of it). */
    spawn_timer++;
    if ((spawn_timer & 3) == 0) scroll_x++;

    for (i = 0; i < MAX_BULLETS; i++) {
      if (!bullet_active[i]) continue;
      if (bullet_y[i] < FIELD_TOP + 4) bullet_active[i] = 0;
      else bullet_y[i] = (uint8_t)(bullet_y[i] - 4);
    }

    for (i = 0; i < MAX_ENEMIES; i++) {
      if (!enemy_active[i]) continue;
      if (enemy_y[i] >= VIS_Y1 - 7) enemy_active[i] = 0;  /* off the window bottom */
      else enemy_y[i]++;
    }

    /* Bullets ↔ enemies. */
    {
      uint8_t b, e;
      for (b = 0; b < MAX_BULLETS; b++) {
        if (!bullet_active[b]) continue;
        for (e = 0; e < MAX_ENEMIES; e++) {
          if (!enemy_active[e]) continue;
          if (hits(bullet_x[b], bullet_y[b], enemy_x[e], enemy_y[e])) {
            bullet_active[b] = 0;
            enemy_active[e] = 0;
            score++;
            hud_dirty = 1;
            sfx_noise(6);
            break;
          }
        }
      }
    }

    /* Enemies ↔ ship. */
    {
      uint8_t e;
      for (e = 0; e < MAX_ENEMIES; e++) {
        if (!enemy_active[e]) continue;
        if (ship_alive && hits(enemy_x[e], enemy_y[e], ship_x, ship_y)) {
          enemy_active[e] = 0;
          sfx_noise(14);
          if (lives > 0) lives--;
          hud_dirty = 1;
          if (lives == 0) {
            game_over();
          } else {
            /* respawn knockback */
            ship_x = VIS_X0 + VIS_W / 2 - 4;
            ship_y = VIS_Y1 - 23;
          }
        }
      }
    }

    if (spawn_timer >= 32) {
      spawn_timer = 0;
      spawn_enemy();
    }

    /* Stage the SAT shadow NOW (RAM only — cheap, any time); the actual
     * VRAM upload waits for the next vblank at the top of the loop. */
    stage_sprites();
  }
}
