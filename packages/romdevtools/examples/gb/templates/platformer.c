/* ── platformer.c — Game Boy side-scrolling platformer (complete example game)
 *
 * GULLY GALLOP — a COMPLETE, working game: title screen, gravity + jump
 * physics with sub-pixel precision, one-way platforms, pits and spikes,
 * coins + distance scoring, persistent hi-score (battery cart RAM), music
 * + SFX, and the Game Boy's signature WINDOW-LAYER HUD: a fixed score/
 * lives strip that the SCX-scrolling level slides beneath, with zero
 * mid-frame raster tricks.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented GB footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — level layout, physics tuning, scoring, art: reshape
 *     freely.
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
 * The level: a 256-px-wide COLUMN MAP (ground height + one-way platforms +
 * pits) painted once into the wrapping 32-wide BG map, so the uint8 SCX
 * scroll wraps PERFECTLY seamless — an endless looping run of pits,
 * platforms, coins and spikes. Coins/spikes are sprites that drift with
 * the scroll (world-anchored while on screen, respawning at the right
 * edge). The camera is one-way (the classic runner camera): past the
 * scroll wall the world scrolls instead of the player.
 *
 * Frame budget (59.7 fps, ~17 556 machine cycles/frame, vblank = 10 of 154
 * lines ≈ 1 140 cycles): everything VRAM/OAM-touching below happens in the
 * vblank slice (OAM DMA ~165 cycles + ≤ 11 queued HUD/map bytes + one SCX
 * write); game logic (player physics, a two-column landing probe, 3 coins
 * + 2 spikes of AABB, staging 6 OAM slots) runs in the other 144 lines.
 * Comfortable.
 */

#include "gb_hardware.h"
#include "gb_runtime.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "GULLY GALLOP"

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile inventory. GB tiles are 16 bytes: 8 rows × [low-plane byte,
 * high-plane byte]. Pixel colour index = (hi_bit << 1) | lo_bit.
 *   lo only  = colour 1     hi only = colour 2     both = colour 3
 * With BGP = $E4 below the BG reads 0 = white (sky), 1 = light grey,
 * 2 = dark grey (dirt), 3 = black (text/grass tops). */
static const uint8_t tile_blank[16] = { 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0 };
static const uint8_t tile_player[16] = {         /* round body + legs */
    0x3C,0x00, 0x7E,0x24, 0xFF,0x24, 0xFF,0x00,  /* body c1, eyes c3  */
    0xFF,0x00, 0x7E,0x00, 0x66,0x00, 0x66,0x00,
};
static const uint8_t tile_player_jump[16] = {    /* arms up           */
    0x18,0x00, 0x7E,0x24, 0xFF,0x24, 0xFF,0x00,
    0xE7,0x00, 0xC3,0x00, 0x81,0x00, 0x00,0x00,
};
static const uint8_t tile_coin[16] = {           /* disc c1, ring c3  */
    0x3C,0x00, 0x7E,0x3C, 0xFF,0x66, 0xFF,0x5A,
    0xFF,0x5A, 0xFF,0x66, 0x7E,0x3C, 0x3C,0x00,
};
static const uint8_t tile_spike[16] = {          /* solid c3 spike    */
    0x00,0x00, 0x18,0x18, 0x18,0x18, 0x3C,0x3C,
    0x3C,0x3C, 0x7E,0x7E, 0x7E,0x7E, 0xFF,0xFF,
};
/* Backdrop tiles. tile_sky carries two colour-1 dot pixels so even "empty"
 * sky is never one flat colour (the render-health floor every example
 * keeps), and the dots make horizontal scroll motion visible everywhere. */
static const uint8_t tile_sky[16] = {            /* white + c1 specks */
    0x00,0x00, 0x20,0x00, 0x00,0x00, 0x00,0x00,
    0x02,0x00, 0x00,0x00, 0x08,0x00, 0x00,0x00,
};
static const uint8_t tile_cloud[16] = {          /* c1 puff           */
    0x00,0x00, 0x18,0x00, 0x3C,0x00, 0x7E,0x00,
    0x7E,0x00, 0x00,0x00, 0x00,0x00, 0x00,0x00,
};
static const uint8_t tile_dirt[16] = {           /* c2 fill, c0 pores */
    0x00,0xFF, 0x00,0xEF, 0x00,0xFF, 0x00,0xFE,
    0x00,0xFF, 0x00,0xDF, 0x00,0xFF, 0x00,0xFB,
};
static const uint8_t tile_grass[16] = {          /* c3 turf over dirt */
    0xFF,0xFF, 0xFF,0xFF, 0x00,0xFF, 0x00,0xEF,
    0x00,0xFF, 0x00,0xFE, 0x00,0xFF, 0x00,0xFF,
};
static const uint8_t tile_plat[16] = {           /* one-way slab      */
    0xFF,0xFF, 0xFF,0xFF, 0x00,0xFF, 0x00,0xDB,
    0x00,0xFF, 0x00,0x00, 0x00,0x00, 0x00,0x00,
};
static const uint8_t tile_hudbar[16] = {         /* solid colour 2    */
    0x00,0xFF, 0x00,0xFF, 0x00,0xFF, 0x00,0xFF,
    0x00,0xFF, 0x00,0xFF, 0x00,0xFF, 0x00,0xFF,
};

/* Tile indices ($8000 unsigned addressing — LCDC bit 4 set below). Sprites
 * and BG share the $8000 table in this layout, so one upload serves both. */
#define T_PLAYER  1
#define T_JUMP    2
#define T_COIN    3
#define T_SPIKE   4
#define T_SKY     5
#define T_CLOUD   6
#define T_DIRT    7
#define T_GRASS   8
#define T_PLAT    9
#define T_HUDBAR  10
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
 * three register writes). This game scrolls SCX (horizontal runner); the
 * shmup example scrolls SCY — same idiom, either axis.
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
 * line 128 sits ON the HUD. Gameplay keeps every object above PLAY_H
 * (spikes stand on the ground, coins float, and a player falling into a
 * pit dies at PLAY_H-8 — the frame before the sprite would touch the HUD).
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
 * The level — a 32-column map; world x = (screen x + scroll_x) mod 256.
 *   ground_row[c] — BG-map row of the ground's grass top, 0xFF = pit.
 *   plat_row[c]   — row of a one-way floating platform, 0 = none.
 * Rows are BG-map rows (y = row*8). The playfield is rows 0..15 (128 px,
 * everything below is under the window HUD). Pits are 4+ columns wide on
 * purpose: at this gravity a 2 px/frame run skims anything narrower (the
 * landing probe's +4 px catch window forgives small sink — see land_top). */
#define NO_GROUND 0xFF
#define GROUND 13                           /* grass-top row, y = 104     */
static const uint8_t ground_row[32] = {
  GROUND, GROUND, GROUND, GROUND, GROUND, GROUND, GROUND, GROUND, /* runway */
  NO_GROUND, NO_GROUND, NO_GROUND, NO_GROUND,                     /* pit 1  */
  GROUND, GROUND, GROUND, GROUND, GROUND, GROUND, GROUND,
  NO_GROUND, NO_GROUND, NO_GROUND, NO_GROUND,                     /* pit 2  */
  GROUND, GROUND, GROUND, GROUND, GROUND, GROUND, GROUND, GROUND, GROUND,
};
static const uint8_t plat_row[32] = {
  0, 0, 0, 0, 10, 10, 10, 0,                /* slab on the runway          */
  0, 9, 9, 0, 0, 0, 10, 10,                 /* stepping stone over pit 1   */
  10, 0, 0, 0, 9, 9, 0, 0,                  /* stone over pit 2            */
  0, 0, 10, 10, 10, 0, 0, 0,                /* slab before the loop seam   */
};

/* ── GAME LOGIC (clay) — physics + tuning (Q4.4 fixed point) ── */
#define GRAVITY_Q44    2    /* +1/8 px per frame per frame                 */
#define JUMP_VEL_Q44 (-52)  /* launch vy → ~42 px apex (~5 tile rows)      */
#define MAX_VY_Q44    80    /* terminal velocity, 5 px/frame — MUST stay   *
                             * under 6: the landing probe's 6-px window    *
                             * can't catch a faster fall (tunnelling)      */
#define MOVE_SPEED     2    /* px/frame walk + scroll speed                */
#define SCROLL_WALL   72    /* px: past this the world scrolls, not you    */
#define GROUND_TOP   104    /* GROUND row * 8                              */
#define SPIKE_Y       96    /* spikes stand on the ground                  */
#define NUM_COINS      3
#define NUM_SPIKES     2
#define START_LIVES    3

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
static uint8_t  lives;
static uint16_t score;
static uint16_t hiscore;          /* live HUD readout: max(score, record) */
static uint16_t record;           /* what the battery SRAM actually holds */
static uint8_t  respawn_pause;    /* freeze + blink frames after a death  */
static uint8_t  prev_pad;
static uint8_t  hud_dirty;        /* queue VRAM writes; vblank commits them */
static uint8_t  msg_stage;        /* game-over text: 2 = line 1 pending, 1 = line 2 */
static uint8_t  msg_col;          /* BG map col for GAME OVER (scroll-aware) */

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

static uint8_t dist8(uint8_t a, uint8_t b) {
  return (a > b) ? (uint8_t)(a - b) : (uint8_t)(b - a);
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
      *dst++ = bits;          /* low plane  ─┐ both set → colour 3 (black) */
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
 * software % costs ~700 cycles a call). Repeated power-of-ten subtraction
 * caps at 36 SUBs for any u16. */
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
 * the shmup example's first cut called draw_text from the vblank slice and
 * gambatte faithfully dropped the writes that slid into mode 3 (half the
 * GAME OVER text simply missing — see the commit_vram budget note). */
static uint8_t msg_q[20];                /* 9 "GAME OVER" + 11 "PRESS START" */
static void stage_text(const char *s, uint8_t *out) {
  while (*s) *out++ = char_tile(*s++);
}

/* ── GAME LOGIC (clay) — screen painters (LCD off = free VRAM access) ────────
 * Paints the level scene from the column map into BG rows 0..17 (the SCY=0
 * screen window; this game never scrolls vertically, so rows 18-31 stay
 * untouched). Clouds use a running divide-free pattern counter — the sm83
 * has no divide instruction; treat every / and % in a loop as a red flag
 * (SDCC's software modulo is ~700 cycles a call). */
static void paint_scene(uint8_t with_plats) {
  uint8_t *p = BG_MAP_0;
  uint8_t r, c, t, g;
  uint8_t cl = 0;                        /* (r*7 + c*5) mod 13, incremental */
  uint8_t clr = 0;
  for (r = 0; r < 18; r++) {
    cl = clr;
    for (c = 0; c < 32; c++) {
      g = ground_row[c];
      t = T_SKY;
      if (with_plats && r == plat_row[c]) t = T_PLAT;
      else if (g != NO_GROUND) {
        if (r == g) t = T_GRASS;
        else if (r > g) t = T_DIRT;
      } else if (r >= 16) {
        t = T_DIRT;                      /* pit walls below the playfield */
      }
      if (t == T_SKY && r >= 2 && r <= 6 && cl == 0) t = T_CLOUD;
      *p++ = t;
      cl += 5; if (cl >= 13) cl -= 13;
    }
    clr += 7; if (clr >= 13) clr -= 13;
  }
}

static void paint_title(void) {
  paint_scene(0);                        /* plain scene — text owns the sky */
  draw_text(BG_MAP_0, 3, (uint8_t)((20 - (sizeof(GAME_TITLE) - 1)) / 2), GAME_TITLE);
  draw_text(BG_MAP_0, 6, 4, "PRESS START");
  draw_text(BG_MAP_0, 8, 6, "HI");
  draw_u16(BG_MAP_0, 8, 9, hiscore);
  draw_text(BG_MAP_0, 11, 6, "1P ONLY");       /* see header: no link 2P */
  SCX = 0; SCY = 0;
  scroll_x = 0;
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
 * LCD-off repaints. Bulk VRAM rewrites (full title/level repaints) happen
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
    paint_scene(1);
    paint_hud();
    LCDC = LCDC_PLAY;           /* window ON below WY — the HUD appears */
  }
}

/* ── GAME LOGIC (clay) — sound: frame-ticked tune + jump/coin/death SFX ──────
 * Channel plan keeps SFX from cutting the music: ch2 = music (one
 * sound_play_tone trigger per note, the APU sustains it), ch1 = jump and
 * coin blips, ch4 = noise for deaths. music_tick() runs once per frame
 * from the main loop; the APU needs no other upkeep. Periods are the
 * 11-bit GB frequency code: 2048 - (131072 / Hz). 0 = rest. */
static const uint16_t tune[16] = {
  1714, 0, 1750, 0, 1783, 0, 1798, 0,     /* G4 A4 B4 C5 */
  1825, 0, 1798, 0, 1783, 0, 1750, 0,     /* D5 C5 B4 A4 */
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

/* ── GAME LOGIC (clay) — coins + spikes (sprite objects in the world) ────────
 * Both live in SCREEN coords and drift left with the scroll delta (world-
 * anchored while visible). Coins respawn at the right edge at a random
 * height; spikes only spawn when the level column entering at the right
 * edge has ground under it (never floating over a pit). */
static const uint8_t coin_heights[4] = { 80, 64, 48, 72 };
static void respawn_coin(uint8_t i) {
  coin_x[i] = (uint8_t)(144 + (rand8() & 15));     /* enter at the right  */
  coin_y[i] = coin_heights[rand8() & 3];
}

static void try_spawn_spike(uint8_t i) {
  uint8_t c = (uint8_t)((uint8_t)(scroll_x + 160) >> 3);
  if (ground_row[c] == NO_GROUND) return;
  if (rand8() > 4) return;                         /* ~2% per frame */
  spike_x[i] = 152;
  spike_active[i] = 1;
}

/* ── GAME LOGIC (clay) — landing probe against the column map ────────────────
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

/* ── GAME LOGIC (clay) — state transitions ── */
static void begin_life(void) {
  uint8_t i;
  px = 24;
  py_q44 = (uint16_t)(GROUND_TOP - 8) << 4;
  vy_q44 = 0;
  on_ground = 1;
  scroll_x = 0;
  dist_sub = 0;
  coin_x[0] =  88; coin_y[0] = 80;
  coin_x[1] = 120; coin_y[1] = 64;
  coin_x[2] = 144; coin_y[2] = 48;
  for (i = 0; i < NUM_SPIKES; i++) spike_active[i] = 0;
  respawn_pause = 48;            /* ready breather — player blinks */
  prev_pad = 0xFF;               /* swallow held buttons across the reset */
}

static void start_game(void) {
  lives = START_LIVES;
  score = 0;
  hud_dirty = 1;          /* restage hud_q — a stale game-over stage queued
                           * before the repaint would overwrite the fresh
                           * zeros next vblank otherwise */
  begin_life();
  state = ST_PLAY;
  repaint_with_lcd_off(0);
  sound_play_tone(1, 1798, 8);             /* start jingle (C5) */
}

static void game_over(void) {
  /* Compare against the SAVED record, not the live `hiscore` readout —
   * the scoring path already raised `hiscore` to track the run, so
   * testing `score > hiscore` here would never fire (a bug the shmup
   * example shipped with for an hour; verified-by-harness is the cure). */
  if (score > record) {
    record = score;
    hiscore_save(record);       /* battery write — survives power-off */
  }
  state = ST_OVER;
  /* The BG has scrolled: map col 0 is no longer screen col 0. Anchor the
   * text relative to the CURRENT scroll so it lands mid-screen
   * ((SCX/8 + screen_col) & 31 = the map col under that screen col; the
   * commit handles the map's 32-col wrap). Convert the strings to tile
   * indices HERE (full-frame time) and queue them — commit_vram() copies
   * one line per vblank. */
  msg_col = (uint8_t)(((scroll_x >> 3) + 5) & 31);
  stage_text("GAME OVER", msg_q);
  stage_text("PRESS START", msg_q + 9);
  msg_stage = 2;
}

static void kill_player(void) {
  sound_play_noise(20);
  if (lives) --lives;
  hud_dirty = 1;
  if (lives == 0) { game_over(); return; }
  begin_life();                  /* back to the runway, scroll rewinds */
}

/* ── GAME LOGIC (clay) — per-state update (runs OUTSIDE vblank) ── */
static void update_play(uint8_t pad) {
  uint8_t i, delta, y8, feet, c0, c1, top;

  delta = 0;
  if (pad & PAD_RIGHT) {
    /* One-way camera: walk until the scroll wall, then the world moves. */
    if (px < SCROLL_WALL) px += MOVE_SPEED;
    else { scroll_x += MOVE_SPEED; delta = MOVE_SPEED; }
  }
  if ((pad & PAD_LEFT) && px > 8) px -= MOVE_SPEED;
  if ((pad & PAD_A) && !(prev_pad & PAD_A) && on_ground) {
    vy_q44 = JUMP_VEL_Q44;
    on_ground = 0;
    sound_play_tone(1, 1849, 6);                     /* jump whoop (E5) */
  }

  /* World objects drift left as the level scrolls (world-anchored). */
  if (delta) {
    dist_sub += delta;
    if (dist_sub >= 64) {                            /* distance pay */
      dist_sub -= 64;
      if (score <= 65525u) ++score;
      if (score > hiscore) hiscore = score;   /* live HI readout; SRAM
                                               * write waits for game over */
      hud_dirty = 1;
    }
    for (i = 0; i < NUM_COINS; i++) {
      if (coin_x[i] < 8 + delta) respawn_coin(i);
      else coin_x[i] -= delta;
    }
    for (i = 0; i < NUM_SPIKES; i++) {
      if (!spike_active[i]) continue;
      if (spike_x[i] < 8 + delta) spike_active[i] = 0;
      else spike_x[i] -= delta;
    }
  }
  for (i = 0; i < NUM_SPIKES; i++)
    if (!spike_active[i]) try_spawn_spike(i);

  /* Physics: gravity + sub-pixel Y. */
  if (vy_q44 < MAX_VY_Q44) vy_q44 += GRAVITY_Q44;
  py_q44 += vy_q44;
  y8 = (uint8_t)(py_q44 >> 4);

  /* Fell into a pit — die at PLAY_H-8, the frame BEFORE the sprite would
   * overlap the window HUD (footgun 2 above: OBJs draw over the window). */
  if (y8 >= PLAY_H - 8) {
    kill_player();
    return;
  }

  /* Landing — probe the two level columns under the player's feet.
   * uint8 px+scroll_x wraps at 256 exactly like the level does. */
  if (vy_q44 >= 0) {
    feet = (uint8_t)(y8 + 8);
    c0 = (uint8_t)((uint8_t)(px + scroll_x) >> 3);
    c1 = (uint8_t)((uint8_t)(px + scroll_x + 7) >> 3);
    top = land_top(c0, feet);
    if (top == 0) top = land_top(c1, feet);
    if (top) {
      py_q44 = (uint16_t)(top - 8) << 4;
      vy_q44 = 0;
      if (!on_ground) sound_play_tone(1, 1602, 3);   /* landing thud */
      on_ground = 1;
    } else {
      on_ground = 0;                                 /* walked off an edge */
    }
  }

  /* Coins (collect) + spikes (death). */
  for (i = 0; i < NUM_COINS; i++) {
    if (dist8(coin_x[i], px) < 8 && dist8(coin_y[i], y8) < 8) {
      if (score <= 65525u) score += 10;
      if (score > hiscore) hiscore = score;
      sound_play_tone(1, 1923, 5);                   /* coin ping (C6) */
      hud_dirty = 1;
      respawn_coin(i);
    }
  }
  for (i = 0; i < NUM_SPIKES; i++) {
    if (!spike_active[i]) continue;
    if (dist8(spike_x[i], px) < 7 && dist8(SPIKE_Y, y8) < 7) {
      kill_player();
      return;
    }
  }
}

/* ── GAME LOGIC (clay) — stage the shadow OAM for THIS frame ─────────────────
 * Pure WRAM writes (shadow_oam at $C100) — safe any time; only the DMA
 * flush is vblank-sensitive. OAM coords are hardware coords: +16 on Y,
 * +8 on X (Y=0/X=0 park a sprite off-screen, which is what oam_clear's
 * zero-fill does for every unused slot). Slot plan (40 hardware slots, we
 * use 6): 0 = player, 1-3 coins, 4-5 spikes — well under the 10-OBJ/line
 * hardware drop. */
static void stage_sprites(void) {
  uint8_t i, y8;
  oam_clear();
  if (state == ST_TITLE) {
    /* Guaranteed-visible sprite from the first title frame — proof the
     * whole OAM pipeline (shadow → HRAM DMA stub → OAM) is alive before
     * any gameplay complicates the picture. */
    oam_set(0, 96 + 16, 76 + 8, T_PLAYER, 0);
    return;
  }
  y8 = (uint8_t)(py_q44 >> 4);
  if (respawn_pause == 0 || (respawn_pause & 4))     /* ready-blink */
    oam_set(0, (uint8_t)(y8 + 16), (uint8_t)(px + 8),
            on_ground ? T_PLAYER : T_JUMP, 0);
  for (i = 0; i < NUM_COINS; i++)
    oam_set((uint8_t)(1 + i), (uint8_t)(coin_y[i] + 16),
            (uint8_t)(coin_x[i] + 8), T_COIN, 0x10);  /* attr $10 → OBP1 */
  for (i = 0; i < NUM_SPIKES; i++)
    if (spike_active[i])
      oam_set((uint8_t)(4 + i), SPIKE_Y + 16,
              (uint8_t)(spike_x[i] + 8), T_SPIKE, 0x10);
}

/* ── GAME LOGIC (clay) — queued VRAM commits ─────────────────────────────────
 * Two-phase update, mirroring the shadow-OAM discipline: game logic only
 * sets hud_dirty / msg_stage. stage_hud() (full-frame time) does the digit
 * math into hud_q; commit_vram() (vblank time) copies bytes — and commits
 * AT MOST ONE queued item per vblank. The budget after the OAM DMA
 * (~165 cycles of the ~1140) fits one item comfortably; committing
 * everything at once on a busy frame (game over = lives digit + two text
 * lines) overruns into mode 3, where the PPU locks VRAM and the writes
 * are silently discarded — the shmup harness caught exactly that as
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

/* Copy `len` tiles into BG-map `row` starting at `col`, wrapping at the
 * map's 32-column seam (the game-over text is scroll-anchored, so it can
 * straddle the wrap). Two straight pointer-walk runs — no dst[i] indexing
 * through a VRAM pointer (the SDCC footgun, see the VRAM helpers note). */
static void commit_row_wrapped(uint8_t row, uint8_t col, const uint8_t *q, uint8_t len) {
  uint8_t *base = BG_MAP_0 + (uint16_t)row * 32;
  uint8_t *p = base + col;
  uint8_t n = (uint8_t)(32 - col);
  if (n > len) n = len;
  len -= n;
  while (n--) *p++ = *q++;
  p = base;
  while (len--) *p++ = *q++;
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
    commit_row_wrapped(5, msg_col, msg_q, 9);
    return;
  }
  if (msg_stage == 1) {                       /* item 3: PRESS START line */
    msg_stage = 0;
    commit_row_wrapped(7, (uint8_t)((msg_col + 31) & 31), msg_q + 9, 11);
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
  upload_tile(T_PLAYER, tile_player);
  upload_tile(T_JUMP,   tile_player_jump);
  upload_tile(T_COIN,   tile_coin);
  upload_tile(T_SPIKE,  tile_spike);
  upload_tile(T_SKY,    tile_sky);
  upload_tile(T_CLOUD,  tile_cloud);
  upload_tile(T_DIRT,   tile_dirt);
  upload_tile(T_GRASS,  tile_grass);
  upload_tile(T_PLAT,   tile_plat);
  upload_tile(T_HUDBAR, tile_hudbar);
  upload_font();

  /* DMG palettes (2 bits per colour index, low bits = index 0):
   * BGP $E4 → 0=white (sky) 1=light 2=dark (dirt) 3=black (text/turf).
   * OBP0 $1C → player: body black, eyes white.
   * OBP1 $C4 → coins light grey with black ring; spikes black. */
  BGP  = 0xE4;
  OBP0 = 0x1C;
  OBP1 = 0xC4;

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
      prev_pad = pad;
    } else if (state == ST_PLAY) {
      if (respawn_pause) {       /* ready-blink: freeze gameplay, stay honest */
        --respawn_pause;
        prev_pad = pad;
      } else {
        update_play(pad);
        prev_pad = pad;
      }
    } else { /* ST_OVER — freeze the field; START/A returns to title */
      if ((pad & (PAD_START | PAD_A)) && !(prev_pad & (PAD_START | PAD_A))) {
        state = ST_TITLE;
        repaint_with_lcd_off(1);
      }
      prev_pad = pad;
    }
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
     *   SCX last — scroll latches per-scanline, so writing it during
     *     vblank (before line 0 renders) moves the WHOLE next frame
     *     consistently; the window ignores it by design (the HUD idiom).
     * Game logic above NEVER touches VRAM directly — it sets the dirty
     * flags and shadow OAM, and this slice commits them. Keep that split
     * when you reshape the game. */
    wait_vblank();
    oam_dma_flush();
    commit_vram();
    SCX = scroll_x;             /* title resets scroll_x to 0; over freezes it */
    music_tick();
  }
}
