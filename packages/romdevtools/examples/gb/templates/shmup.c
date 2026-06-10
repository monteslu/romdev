/* ── shmup.c — Game Boy vertical shooter (complete example game) ─────────────
 *
 * A COMPLETE, working game — title screen, lives, score + persistent
 * hi-score (battery cart RAM), music + SFX, and the Game Boy's signature
 * WINDOW-LAYER HUD: a fixed score/lives strip that the scrolling starfield
 * slides beneath, with zero mid-frame raster tricks.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented GB footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — enemy patterns, scoring, tuning, art: reshape freely.
 *
 * SINGLE-PLAYER BY DESIGN (the honest handheld story): the Game Boy has ONE
 * controller. Multiplayer on real hardware means the link cable, and a
 * single emulator instance cannot emulate a second Game Boy on the other
 * end of that cable — so this game ships 1P only instead of faking a 2P
 * mode the platform can't deliver. (Consoles' examples have real 2P.)
 *
 * What depends on what:
 *   gb_hardware.h — register names (LCDC/WX/WY/NRxx/...) + LCDC bit masks.
 *   gb_runtime.{h,c} — vblank wait (HALT-driven), joypad, shadow OAM +
 *     the OAM-DMA-from-HRAM routine, VRAM-safe memcpy, APU helpers.
 *   gb_crt0.s — boot + interrupt vectors + the cartridge header window.
 *     It DECLARES the cart as MBC1+RAM+BATTERY ($0147=$03, $0149=$02) —
 *     that declaration is what makes hiscore_save() below persist (the
 *     emulator sizes battery SAVE_RAM from those two header bytes).
 *     Load-bearing; edit with TROUBLESHOOTING open.
 *
 * Frame budget (59.7 fps, ~17 556 machine cycles/frame, vblank = 10 of 154
 * lines ≈ 1 140 cycles): everything VRAM/OAM-touching below happens in the
 * vblank slice (OAM DMA ~165 cycles + ≤ 16 HUD map bytes + one SCY write);
 * game logic (1 ship × 6 bullets × 6 enemies AABB ≈ 36 checks + staging
 * 13 OAM slots) runs in the other 144 lines. Comfortable.
 */

#include "gb_hardware.h"
#include "gb_runtime.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "METEOR MILITIA"

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile inventory. GB tiles are 16 bytes: 8 rows × [low-plane byte,
 * high-plane byte]. Pixel colour index = (hi_bit << 1) | lo_bit.
 *   lo only  = colour 1     hi only = colour 2     both = colour 3
 * With the BGP/OBP palettes set below: 0 = black (backdrop), 1 = dark
 * grey, 2 = light grey, 3 = white. */
static const uint8_t tile_blank[16] = { 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0 };
static const uint8_t tile_ship[16] = {           /* colour 3 (white) */
    0x18,0x18, 0x3C,0x3C, 0x7E,0x7E, 0xFF,0xFF,
    0xFF,0xFF, 0x7E,0x7E, 0x3C,0x3C, 0x18,0x18,
};
static const uint8_t tile_bullet[16] = {         /* colour 3 (white) */
    0x00,0x00, 0x18,0x18, 0x3C,0x3C, 0x3C,0x3C,
    0x3C,0x3C, 0x3C,0x3C, 0x18,0x18, 0x00,0x00,
};
static const uint8_t tile_enemy[16] = {          /* colour 3 via OBP1 → light */
    0x81,0x81, 0x42,0x42, 0x24,0x24, 0xFF,0xFF,
    0xFF,0xFF, 0x24,0x24, 0x42,0x42, 0x81,0x81,
};
/* Starfield BG tiles. tile_space is a 50/50 dither of colours 0+1 so even
 * "empty" sky mixes two shades — the screen can never read as one flat
 * colour (the render-health floor every example keeps). */
static const uint8_t tile_space[16] = {          /* colours 0+1 dither */
    0x55,0x00, 0xAA,0x00, 0x55,0x00, 0xAA,0x00,
    0x55,0x00, 0xAA,0x00, 0x55,0x00, 0xAA,0x00,
};
static const uint8_t tile_star[16] = {           /* one colour-2 dot */
    0x00,0x00, 0x00,0x00, 0x00,0x10, 0x00,0x38,
    0x00,0x10, 0x00,0x00, 0x00,0x00, 0x00,0x00,
};
static const uint8_t tile_brite[16] = {          /* colour-3 "+" twinkle */
    0x00,0x00, 0x10,0x10, 0x10,0x10, 0x7C,0x7C,
    0x10,0x10, 0x10,0x10, 0x00,0x00, 0x00,0x00,
};
static const uint8_t tile_hudbar[16] = {         /* solid colour 2 */
    0x00,0xFF, 0x00,0xFF, 0x00,0xFF, 0x00,0xFF,
    0x00,0xFF, 0x00,0xFF, 0x00,0xFF, 0x00,0xFF,
};

/* Tile indices ($8000 unsigned addressing — LCDC bit 4 set below). Sprites
 * and BG share the $8000 table in this layout, so one upload serves both. */
#define T_SHIP    1
#define T_BULLET  2
#define T_ENEMY   3
#define T_SPACE   4
#define T_STAR    5
#define T_BRITE   6
#define T_HUDBAR  7
/* Font: '0'-'9' → 16..25, 'A'-'Z' → 26..51, '-' → 52 (see char_tile). */
#define T_DIGIT0  16
#define T_ALPHA   26
#define T_DASH    52

/* 1bpp font (same glyph set as the NES/SMS examples — 0-9, A-Z, '-').
 * Stored 8 bytes/glyph and expanded to 2bpp colour 3 at upload time, so
 * the ROM carries 296 bytes of font instead of 592. */
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
 * THE WINDOW-LAYER HUD — the Game Boy's signature "fixed HUD over a
 * scrolling world" technique. The window is a second BG plane with its own
 * 32×32 tile map and NO scroll registers: it always draws its map from
 * (0,0), pinned to the screen, on top of the BG. So the HUD lives in the
 * window and the playfield lives in the BG — SCY/SCX scroll the world all
 * they like and the HUD never moves. No raster splits, no IRQ timing (the
 * NES needs a sprite-0 polling dance for this exact effect; on GB it's
 * three register writes).
 *
 * The three registers, and their two famous footguns:
 *   WY ($FF4A) — first screen LINE the window covers. We use 128: lines
 *     0-127 are playfield, 128-143 (two tile rows) are HUD.
 *   WX ($FF4B) — screen column PLUS SEVEN. WX=7 means "left edge". The
 *     -7 offset is hardware fact, not a library quirk: WX=0..6 glitches
 *     (real DMG pixel pipeline artifacts), WX≥167 pushes it off-screen.
 *   LCDC bit 5 — window enable; bit 6 — which map it reads ($9800/$9C00).
 *
 * FOOTGUN 1 — "the window ate the bottom of my screen": once the window
 * starts on a line it covers EVERY line from there DOWN, full width from
 * WX to the right edge. There is no window height register. That is why
 * GB HUDs sit at the BOTTOM of the screen (this game, and most of the
 * classic library). A TOP HUD needs a mid-frame trick — STAT-interrupt on
 * LYC, flip LCDC bit 5 off after the HUD rows — which is a different,
 * fragile idiom; don't drift into it by accident by setting WY=0.
 *
 * FOOTGUN 2 — sprites are NOT clipped by the window. OBJs draw on top of
 * it (priority bits notwithstanding), so a sprite that wanders below
 * line 128 sits ON the HUD. Gameplay despawns everything before PLAY_H.
 *
 * Requires: window map at $9C00 (LCDC bit 6 set — keeps it separate from
 * the BG's $9800 map), tile data at $8000 (LCDC bit 4), WX=7, WY=PLAY_H,
 * LCDC bit 5 set during play (title turns the window off — LCDC bit
 * discipline lives in the two LCDC_* values below, poke those, not LCDC). */
#define PLAY_H   128                       /* first HUD line = window top */
#define WIN_MAP  ((uint8_t *)0x9C00)       /* window's 32×32 tile map */
#define LCDC_TITLE (LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO)
#define LCDC_PLAY  (LCDC_TITLE | LCDC_WINDOW_ON | LCDC_WINDOW_MAP_HI)

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * BATTERY SRAM — persistent hi-score. MBC1 cart RAM is 8KB at $A000-$BFFF,
 * but it boots DISABLED and writes to a disabled bank are silently
 * discarded (reads float). The gate is the MBC's RAM-enable register: any
 * WRITE to ROM space $0000-$1FFF with $0A in the low nibble enables the
 * RAM; writing $00 disables it again. (Writing "into ROM" feels wrong the
 * first time — ROM-area writes never touch ROM, they're how you talk to
 * the mapper chip.) Leaving RAM enabled all the time "works" in emulators
 * but on real hardware risks corruption at power-off — battery carts since
 * forever do enable → touch → disable, so we do too.
 *
 * The record is magic 'H','S' + score lo,hi + a checksum byte, so a
 * first-boot cart full of $FF garbage reads as "no record" instead of a
 * 65535 hi-score.
 *
 * Requires: gb_crt0.s declaring $0147=$03 (MBC1+RAM+BATTERY) + $0149=$02
 * (8KB) — those header bytes are how the emulator knows to allocate and
 * persist SAVE_RAM. Verify headlessly: play, game over, then
 * memory({op:'read', region:'save_ram'}) shows the block, and the
 * hi-score survives host.hardReset(). */
#define MBC_RAM_ENABLE  (*(volatile uint8_t *)0x0000)
#define SRAM            ((volatile uint8_t *)0xA000)

static uint16_t hiscore_load(void) {
  uint16_t v = 0;
  MBC_RAM_ENABLE = 0x0A;                       /* unlock cart RAM */
  if (SRAM[0] == 'H' && SRAM[1] == 'S' &&
      SRAM[4] == (uint8_t)(SRAM[2] ^ SRAM[3] ^ 0xA5)) {
    v = (uint16_t)(SRAM[2] | ((uint16_t)SRAM[3] << 8));
  }
  MBC_RAM_ENABLE = 0x00;                       /* re-lock (battery hygiene) */
  return v;
}

static void hiscore_save(uint16_t v) {
  uint8_t lo = (uint8_t)(v & 0xFF), hi = (uint8_t)(v >> 8);
  MBC_RAM_ENABLE = 0x0A;
  SRAM[0] = 'H'; SRAM[1] = 'S';
  SRAM[2] = lo;  SRAM[3] = hi;
  SRAM[4] = (uint8_t)(lo ^ hi ^ 0xA5);
  MBC_RAM_ENABLE = 0x00;
}

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Object pools — fixed slots, no allocation. OAM slot plan (40 hardware
 * slots, we use 13): 0 = ship, 1-6 bullets, 7-12 enemies. Sub-10 sprites
 * on any one scanline keeps us clear of the 10-OBJ/line hardware drop. */
#define MAX_BULLETS 6
#define MAX_ENEMIES 6
#define START_LIVES 3

typedef struct { uint8_t x, y, alive; } Obj;   /* screen coords (not OAM) */

static Obj ship;
static Obj bullets[MAX_BULLETS];
static Obj enemies[MAX_ENEMIES];
static uint8_t lives;
static uint16_t score;
static uint16_t hiscore;          /* live HUD readout: max(score, record) */
static uint16_t record;           /* what the battery SRAM actually holds */
static uint8_t fire_cd;
static uint8_t spawn_timer;
static uint8_t scroll_y;          /* starfield drift, committed to SCY */
static uint8_t prev_pad;
static uint8_t hud_dirty;         /* queue VRAM writes; vblank commits them */
static uint8_t msg_stage;         /* game-over text: 2 = line 1 pending, 1 = line 2 */
static uint8_t msg_row;           /* BG map row for GAME OVER (scroll-aware) */

/* Game states — the shell every example shares: title → play → game over.
 * (Handheld adaptation: title is press-start; consoles add a 1P/2P pick.) */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;

/* ── GAME LOGIC (clay) — Galois LFSR (taps $B8), period 255 ── */
static uint8_t rng_state = 0xA5;
static uint8_t rand8(void) {
  uint8_t lsb = (uint8_t)(rng_state & 1);
  rng_state >>= 1;
  if (lsb) rng_state ^= 0xB8;
  return rng_state;
}

/* ── GAME LOGIC (clay) — VRAM upload + text helpers ──────────────────────────
 * All of these write VRAM, so they run with the LCD OFF (boot/repaints) or
 * inside vblank (the HUD digit commits). Note every loop walks a pointer
 * (*dst++ = v) instead of indexing dst[i] — SDCC's sm83 port miscompiles
 * indexed stores through VRAM-pointing pointers (the documented
 * memcpy_vram footgun; see gb_runtime.c). */
static void upload_tile(uint8_t slot, const uint8_t *src) {
  memcpy_vram((uint8_t *)(0x8000 + (uint16_t)slot * 16), src, 16);
}

static void upload_font(void) {
  uint8_t *dst = (uint8_t *)(0x8000 + (uint16_t)T_DIGIT0 * 16);
  uint8_t g, r, bits;
  for (g = 0; g < 37; g++) {
    for (r = 0; r < 8; r++) {
      bits = font8[g][r];
      *dst++ = bits;          /* low plane  ─┐ both set → colour 3 (white) */
      *dst++ = bits;          /* high plane ─┘ */
    }
  }
}

static uint8_t char_tile(char ch) {
  if (ch >= '0' && ch <= '9') return (uint8_t)(T_DIGIT0 + (ch - '0'));
  if (ch >= 'A' && ch <= 'Z') return (uint8_t)(T_ALPHA + (ch - 'A'));
  if (ch == '-') return T_DASH;
  return 0;                                    /* space → blank tile */
}

/* Both 32×32 maps (BG $9800, window $9C00) take the same row/col math. */
static void draw_text(uint8_t *map, uint8_t row, uint8_t col, const char *s) {
  uint8_t *p = map + (uint16_t)row * 32 + col;
  while (*s) *p++ = char_tile(*s++);
}

/* Decimal digits WITHOUT divide/modulo (the sm83 has neither — SDCC's
 * software % costs ~700 cycles a call; see paint_starfield). Repeated
 * power-of-ten subtraction caps at 36 SUBs for any u16. */
static void u16_to_tiles(uint16_t v, uint8_t *out5) {
  static const uint16_t pow10[4] = { 10000, 1000, 100, 10 };
  uint8_t i, d;
  for (i = 0; i < 4; i++) {
    d = 0;
    while (v >= pow10[i]) { v -= pow10[i]; ++d; }
    *out5++ = (uint8_t)(T_DIGIT0 + d);
  }
  *out5 = (uint8_t)(T_DIGIT0 + (uint8_t)v);
}

static void draw_u16(uint8_t *map, uint8_t row, uint8_t col, uint16_t v) {
  uint8_t d[5];
  uint8_t i, *p = map + (uint16_t)row * 32 + col;
  u16_to_tiles(v, d);
  for (i = 0; i < 5; i++) *p++ = d[i];
}

/* Pre-convert a string to tile indices (full-frame time) so the vblank
 * commit is a dumb byte copy. char_tile's compare chain per character is
 * exactly the kind of work that blows the ~1140-cycle vblank budget —
 * the first cut of this file called draw_text from the vblank slice and
 * gambatte faithfully dropped the writes that slid into mode 3 (half the
 * GAME OVER text simply missing — see the commit_vram budget note). */
static uint8_t msg_q[20];                /* 9 "GAME OVER" + 11 "PRESS START" */
static void stage_text(const char *s, uint8_t *out) {
  while (*s) *out++ = char_tile(*s++);
}

/* ── GAME LOGIC (clay) — screen painters (LCD off = free VRAM access) ────────
 * Starfield fills the FULL 32-row map (not just the visible 18) because
 * SCY scrolling wraps through all 32 — a part-filled map scrolls garbage
 * into view. The star pattern has no 8px vertical symmetry, so scroll
 * motion is visible everywhere.
 *
 * PERF FOOTGUN (measured, not theoretical): the obvious pattern formula
 * `(r*7 + c*5) % 11` calls SDCC's software modulo (~700 cycles) — 2048
 * times over a 32×32 map ≈ 1.5 MILLION cycles ≈ a 1.5-second frozen boot.
 * The fix is the classic 8-bit move: keep running counters and subtract
 * on overflow (a is (r*7+c*5) mod 11, b is (r*3+c*13) mod 29, maintained
 * incrementally — zero divisions). The sm83 has no divide instruction;
 * treat every  / and %  in a loop as a red flag. */
static void paint_starfield(void) {
  uint8_t *p = BG_MAP_0;
  uint8_t r, c, t;
  uint8_t ar = 0, br = 0;       /* row seeds: (r*7) mod 11, (r*3) mod 29 */
  uint8_t a, b;
  for (r = 0; r < 32; r++) {
    a = ar; b = br;
    for (c = 0; c < 32; c++) {
      t = T_SPACE;
      if (a == 0) t = T_STAR;
      if (b == 0) t = T_BRITE;
      *p++ = t;
      a += 5;  if (a >= 11) a -= 11;     /* +5 ≡ c step, mod 11 */
      b += 13; if (b >= 29) b -= 29;     /* +13 ≡ c step, mod 29 */
    }
    ar += 7; if (ar >= 11) ar -= 11;     /* +7 ≡ r step, mod 11 */
    br += 3; if (br >= 29) br -= 29;     /* +3 ≡ r step, mod 29 */
  }
}

static void paint_title(void) {
  paint_starfield();
  draw_text(BG_MAP_0, 3, (uint8_t)((20 - (sizeof(GAME_TITLE) - 1)) / 2), GAME_TITLE);
  draw_text(BG_MAP_0, 8, 4, "PRESS START");
  draw_text(BG_MAP_0, 11, 6, "HI");
  draw_u16(BG_MAP_0, 11, 9, hiscore);
  draw_text(BG_MAP_0, 14, 6, "1P ONLY");        /* see header: no link 2P */
  SCY = 0; SCX = 0;
  scroll_y = 0;
}

/* HUD strip = window rows 0-1: a solid divider bar, then the text row.
 * Columns 0-19 are the visible 20 (WX=7 pins map col 0 to screen x 0). */
static void paint_hud(void) {
  uint8_t *p = WIN_MAP;
  uint8_t c;
  for (c = 0; c < 20; c++) *p++ = T_HUDBAR;
  draw_text(WIN_MAP, 1, 0, "SC");
  draw_u16(WIN_MAP, 1, 3, score);
  draw_text(WIN_MAP, 1, 9, "HI");
  draw_u16(WIN_MAP, 1, 12, hiscore);
  draw_text(WIN_MAP, 1, 18, "L");
  *(WIN_MAP + 32 + 19) = (uint8_t)(T_DIGIT0 + lives);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * LCD-off repaints. Bulk VRAM rewrites (full title/field repaints) happen
 * with the LCD OFF — free access, no per-byte timing worries. The rule:
 * only flip LCDC bit 7 to 0 DURING VBLANK. Killing the LCD mid-scanline
 * is the classic "damages real DMG hardware" move; emulators shrug, real
 * units can be permanently marked. wait_vblank() first, always.
 * Requires: enable_vblank_irq() already called (wait_vblank HALT path);
 * lcd_off-safe runtime (gb_runtime's wait_vblank bails if LCD is off). */
static void repaint_with_lcd_off(uint8_t to_title) {
  msg_stage = 0;                /* a queued game-over line must not land on
                                 * the freshly painted screen a frame later */
  wait_vblank();                /* never cut the LCD outside vblank */
  LCDC = 0;
  if (to_title) {
    paint_title();
    oam_clear();                /* hide every sprite slot before re-enable */
    LCDC = LCDC_TITLE;          /* window OFF on the title */
  } else {
    paint_starfield();
    paint_hud();
    LCDC = LCDC_PLAY;           /* window ON below WY — the HUD appears */
  }
}

/* ── GAME LOGIC (clay) — sound: frame-ticked tune + fire/boom SFX ────────────
 * Channel plan keeps SFX from cutting the music: ch2 = music (one
 * sound_play_tone trigger per note, the APU sustains it), ch1 = fire blip,
 * ch4 = noise explosions. music_tick() runs once per frame from the main
 * loop; the APU needs no other upkeep. Periods are the 11-bit GB frequency
 * code: 2048 - (131072 / Hz). 0 = rest. */
static const uint16_t tune[16] = {
  1547, 0, 1650, 0, 1714, 0, 1798, 0,     /* C4 E4 G4 C5 */
  1714, 0, 1650, 0, 1602, 0, 1650, 0,     /* G4 E4 D4 E4 */
};
static uint8_t music_pos, music_timer;
static void music_tick(void) {
  uint16_t n;
  if (++music_timer < 14) return;
  music_timer = 0;
  n = tune[music_pos];
  music_pos = (uint8_t)((music_pos + 1) & 15);
  if (n) sound_play_tone(2, n, 12);
}

/* ── GAME LOGIC (clay) — spawning, firing, collision ── */
static void fire_bullet(void) {
  uint8_t i;
  for (i = 0; i < MAX_BULLETS; i++) {
    if (!bullets[i].alive) {
      bullets[i].x = ship.x;
      bullets[i].y = (uint8_t)(ship.y - 8);
      bullets[i].alive = 1;
      sound_play_tone(1, 1900, 4);             /* ch1 blip — music keeps ch2 */
      return;
    }
  }
}

static void spawn_enemy(void) {
  uint8_t i;
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemies[i].alive) {
      /* One software-% per spawn (every ~32 frames) is fine — the
       * divide-free rule (see paint_starfield) is about per-cell/per-
       * frame loops, not superstition. */
      enemies[i].x = (uint8_t)(rand8() % 145 + 4);
      enemies[i].y = 0;
      enemies[i].alive = 1;
      return;
    }
  }
}

static uint8_t hits(Obj *a, Obj *b) {          /* AABB, both 8×8 */
  uint8_t dx = (uint8_t)((a->x > b->x) ? (a->x - b->x) : (b->x - a->x));
  uint8_t dy = (uint8_t)((a->y > b->y) ? (a->y - b->y) : (b->y - a->y));
  return (uint8_t)((dx < 8) && (dy < 8));
}

/* ── GAME LOGIC (clay) — state transitions ── */
static void start_game(void) {
  uint8_t i;
  ship.x = 76; ship.y = 104; ship.alive = 1;
  for (i = 0; i < MAX_BULLETS; i++) bullets[i].alive = 0;
  for (i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = 0;
  lives = START_LIVES;
  score = 0;
  fire_cd = 0;
  spawn_timer = 0;
  hud_dirty = 1;          /* restage hud_q — a stale game-over stage queued
                           * before the repaint would overwrite the fresh
                           * zeros next vblank otherwise */
  state = ST_PLAY;
  repaint_with_lcd_off(0);
}

static void game_over(void) {
  /* Compare against the SAVED record, not the live `hiscore` readout —
   * the kill handler already raised `hiscore` to track the run, so
   * testing `score > hiscore` here would never fire (a bug this file
   * shipped with for about an hour; verified-by-harness is the cure). */
  if (score > record) {
    record = score;
    hiscore_save(record);       /* battery write — survives power-off */
  }
  state = ST_OVER;
  /* The BG has scrolled: map row 0 is no longer screen row 0. Anchor the
   * text relative to the CURRENT scroll so it lands mid-playfield
   * on-screen ((SCY/8 + screen_row) & 31 = the map row under that screen
   * row). Convert the strings to tile indices HERE (full-frame time) and
   * queue them — commit_vram() copies one line per vblank. */
  msg_row = (uint8_t)(((scroll_y >> 3) + 6) & 31);
  stage_text("GAME OVER", msg_q);
  stage_text("PRESS START", msg_q + 9);
  msg_stage = 2;
}

/* ── GAME LOGIC (clay) — per-state update (runs OUTSIDE vblank) ── */
static void update_play(uint8_t pad) {
  uint8_t i, j;

  if ((pad & PAD_LEFT)  && ship.x > 0)         ship.x -= 2;
  if ((pad & PAD_RIGHT) && ship.x < 160 - 8)   ship.x += 2;
  if ((pad & PAD_UP)    && ship.y > 8)         ship.y -= 2;
  if ((pad & PAD_DOWN)  && ship.y < PLAY_H - 24) ship.y += 2;
  if ((pad & PAD_A) && fire_cd == 0) { fire_bullet(); fire_cd = 8; }
  if (fire_cd) --fire_cd;

  /* Starfield drift — the window HUD makes this free (no split timing). */
  if ((spawn_timer & 1) == 0) --scroll_y;

  for (i = 0; i < MAX_BULLETS; i++) {
    if (!bullets[i].alive) continue;
    if (bullets[i].y < 4) { bullets[i].alive = 0; continue; }
    bullets[i].y -= 4;
  }

  /* Enemies despawn BEFORE the HUD line — sprites draw OVER the window
   * (footgun 2 above), so nothing may drift past PLAY_H. */
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemies[i].alive) continue;
    enemies[i].y += 1;
    if (enemies[i].y >= PLAY_H - 12) enemies[i].alive = 0;
  }

  if (++spawn_timer >= 32) { spawn_timer = 0; spawn_enemy(); }

  /* Bullets ↔ enemies. */
  for (i = 0; i < MAX_BULLETS; i++) {
    if (!bullets[i].alive) continue;
    for (j = 0; j < MAX_ENEMIES; j++) {
      if (!enemies[j].alive) continue;
      if (hits(&bullets[i], &enemies[j])) {
        bullets[i].alive = 0;
        enemies[j].alive = 0;
        if (score <= 65525u) score += 10;
        if (score > hiscore) hiscore = score;   /* live HI readout; SRAM
                                                 * write waits for game over */
        sound_play_noise(8);
        hud_dirty = 1;
        break;
      }
    }
  }

  /* Enemies ↔ ship. */
  for (j = 0; j < MAX_ENEMIES; j++) {
    if (!enemies[j].alive) continue;
    if (hits(&enemies[j], &ship)) {
      enemies[j].alive = 0;
      sound_play_noise(24);
      if (lives) --lives;
      hud_dirty = 1;
      if (lives == 0) { game_over(); return; }
      ship.x = 76; ship.y = 104;                /* respawn knockback */
    }
  }
}

/* ── GAME LOGIC (clay) — stage the shadow OAM for THIS frame ─────────────────
 * Pure WRAM writes (shadow_oam at $C100) — safe any time; only the DMA
 * flush is vblank-sensitive. OAM coords are hardware coords: +16 on Y,
 * +8 on X (Y=0/X=0 park a sprite off-screen, which is what oam_clear's
 * zero-fill does for every unused slot). */
static void stage_sprites(void) {
  uint8_t i;
  oam_clear();
  if (state == ST_TITLE) {
    /* Guaranteed-visible sprite from the first title frame — proof the
     * whole OAM pipeline (shadow → HRAM DMA stub → OAM) is alive before
     * any gameplay complicates the picture. */
    oam_set(0, 96 + 16, 76 + 8, T_SHIP, 0);
    return;
  }
  if (ship.alive)
    oam_set(0, (uint8_t)(ship.y + 16), (uint8_t)(ship.x + 8), T_SHIP, 0);
  for (i = 0; i < MAX_BULLETS; i++)
    if (bullets[i].alive)
      oam_set((uint8_t)(1 + i), (uint8_t)(bullets[i].y + 16),
              (uint8_t)(bullets[i].x + 8), T_BULLET, 0);
  for (i = 0; i < MAX_ENEMIES; i++)
    if (enemies[i].alive)
      oam_set((uint8_t)(7 + i), (uint8_t)(enemies[i].y + 16),
              (uint8_t)(enemies[i].x + 8), T_ENEMY, 0x10); /* attr $10 → OBP1 */
}

/* ── GAME LOGIC (clay) — queued VRAM commits ─────────────────────────────────
 * Two-phase update, mirroring the shadow-OAM discipline: game logic only
 * sets hud_dirty / msg_stage. stage_hud() (full-frame time) does the digit
 * math into hud_q; commit_vram() (vblank time) copies bytes — and commits
 * AT MOST ONE queued item per vblank. The budget after the OAM DMA
 * (~165 cycles of the ~1140) fits one item comfortably; committing
 * everything at once on a busy frame (game over = lives digit + two text
 * lines) overruns into mode 3, where the PPU locks VRAM and the writes
 * are silently discarded — the harness caught exactly that as
 * half-missing GAME OVER text. One item per frame = zero dropped bytes,
 * and a frame of HUD latency nobody can see. */
static uint8_t hud_q[11];       /* 5 score digits, 5 hi digits, lives tile */
static uint8_t hud_ready;

static void stage_hud(void) {
  if (!hud_dirty) return;
  hud_dirty = 0;
  u16_to_tiles(score, hud_q);
  u16_to_tiles(hiscore, hud_q + 5);
  hud_q[10] = (uint8_t)(T_DIGIT0 + lives);
  hud_ready = 1;
}

static void commit_vram(void) {
  uint8_t i;
  uint8_t *p;
  const uint8_t *q;
  if (hud_ready) {                            /* item 1: HUD digits */
    hud_ready = 0;
    p = WIN_MAP + 32 + 3;  q = hud_q;      for (i = 0; i < 5; i++) *p++ = *q++;
    p = WIN_MAP + 32 + 12; q = hud_q + 5;  for (i = 0; i < 5; i++) *p++ = *q++;
    *(WIN_MAP + 32 + 19) = hud_q[10];
    return;
  }
  if (msg_stage == 2) {                       /* item 2: GAME OVER line */
    msg_stage = 1;
    p = BG_MAP_0 + (uint16_t)msg_row * 32 + 5;
    q = msg_q;
    for (i = 0; i < 9; i++) *p++ = *q++;
    return;
  }
  if (msg_stage == 1) {                       /* item 3: PRESS START line */
    msg_stage = 0;
    p = BG_MAP_0 + (uint16_t)((msg_row + 2) & 31) * 32 + 4;
    q = msg_q + 9;
    for (i = 0; i < 11; i++) *p++ = *q++;
  }
}

void main(void) {
  uint8_t pad;

  /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
   * Boot order. Three load-bearing calls, in this order:
   *   1. lcd_init_default() — sane LCD state AND it installs the OAM-DMA
   *      stub into HRAM ($FF80). During OAM DMA the CPU can only fetch
   *      from HRAM; the broken alternative (spinning in ROM) fetches $FF
   *      = rst $38 and corrupts the stack — the classic "sprites never
   *      show / game dies after a while" GB death. Every oam_dma_flush()
   *      below depends on this stub existing.
   *   2. enable_vblank_irq() — flips wait_vblank() from LY-polling to
   *      HALT-until-vblank-IRQ. The polling fallback runs at ~1/30 speed
   *      on the WASM emulator; the HALT path is full speed everywhere.
   *   3. LCD off (inside vblank) for the bulk VRAM uploads — tiles, font,
   *      first screen — then back on. VRAM is only freely writable with
   *      the LCD off or during vblank/hblank windows. */
  lcd_init_default();
  enable_vblank_irq();
  sound_init();

  wait_vblank();
  LCDC = 0;                     /* LCD off — free VRAM access from here */

  upload_tile(0, tile_blank);
  upload_tile(T_SHIP,   tile_ship);
  upload_tile(T_BULLET, tile_bullet);
  upload_tile(T_ENEMY,  tile_enemy);
  upload_tile(T_SPACE,  tile_space);
  upload_tile(T_STAR,   tile_star);
  upload_tile(T_BRITE,  tile_brite);
  upload_tile(T_HUDBAR, tile_hudbar);
  upload_font();

  /* DMG palettes (2 bits per colour index, low bits = index 0):
   * BGP $1B → 0=black 1=dark 2=light 3=white (dark sky, white text).
   * OBP0 $1B → ship/bullets white.  OBP1 $5B → enemies light grey. */
  BGP  = 0x1B;
  OBP0 = 0x1B;
  OBP1 = 0x5B;

  /* Window position — set once; LCDC bit 5 decides if it shows. */
  WX = 7;                       /* the +7 quirk: 7 = screen left edge */
  WY = PLAY_H;                  /* HUD owns lines 128-143 */

  record = hiscore_load();      /* battery SRAM — 0 on first boot */
  hiscore = record;
  state = ST_TITLE;
  paint_title();
  oam_clear();
  LCDC = LCDC_TITLE;

  for (;;) {
    /* ── full-frame work: input, game state, shadow-OAM staging ── */
    pad = joypad_read();

    if (state == ST_TITLE) {
      if ((pad & PAD_START) && !(prev_pad & PAD_START)) start_game();
      else if ((pad & PAD_A) && !(prev_pad & PAD_A))    start_game();
    } else if (state == ST_PLAY) {
      update_play(pad);
    } else { /* ST_OVER — freeze the field; START/A returns to title */
      if ((pad & (PAD_START | PAD_A)) && !(prev_pad & (PAD_START | PAD_A))) {
        state = ST_TITLE;
        repaint_with_lcd_off(1);
      }
    }
    prev_pad = pad;
    stage_sprites();
    stage_hud();                /* digit math out here, not in vblank */

    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * The vblank slice. wait_vblank() wakes at the START of vblank
     * (~1140 cycles of safe OAM/VRAM access). Order is everything:
     *   oam_dma_flush() FIRST — the DMA takes ~165 cycles and MUST finish
     *     inside vblank; pushing it later (after VRAM writes that grow
     *     over time) slides it into active display, where the PPU is
     *     reading OAM = one frame of torn/invisible sprites, intermittent
     *     and miserable to debug.
     *   commit_vram() second — the few queued HUD/map bytes.
     *   SCY last — scroll latches per-scanline, so writing it during
     *     vblank (before line 0 renders) moves the WHOLE next frame
     *     consistently; the window ignores it by design (the HUD idiom).
     * Game logic above NEVER touches VRAM directly — it sets the dirty
     * flags and shadow OAM, and this slice commits them. Keep that split
     * when you reshape the game. */
    wait_vblank();
    oam_dma_flush();
    commit_vram();
    SCY = scroll_y;             /* title resets scroll_y to 0; over freezes it */
    music_tick();
  }
}
