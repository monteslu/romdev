/* ── shmup.c — PHOTON DRIFT: Game Boy Color vertical shooter (complete example game) ──
 *
 * A COMPLETE, working game — title screen, lives, score + persistent
 * battery hi-score (MBC1+RAM+BATTERY SRAM), GB APU music + SFX, the Game
 * Boy's signature WINDOW-LAYER fixed HUD over a scrolling starfield — and
 * the GBC's signature feature on top of all of it: TRUE per-tile color.
 * The ship, its bullets, the enemies and the starfield are each REAL CGB
 * palettes (15-bit BGR, loaded through BCPS/BCPD + OCPS/OCPD): the field is
 * three DEPTH-BANDED blue palettes selected per BG cell through the VRAM
 * bank-1 attribute map, and the ship (cyan), bullets (gold) and enemies
 * (red) are their own OBJ palettes through OCPS — not a colorized
 * monochrome game.
 *
 * THE GAME: a one-stick vertical shooter. The d-pad flies your ship around
 * the lower playfield, A fires (a six-deep bullet pool), and waves of
 * enemies drift down a parallax-banded starfield. Shoot them for points;
 * one that reaches your ship costs a life. Three lives; the battery
 * remembers your best run forever. SELECT toggles the music.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented GB/GBC footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — enemy patterns, scoring, tuning, art: reshape freely.
 *
 * SINGLE-PLAYER, honestly: the Game Boy's "player 2" is a LINK CABLE, which
 * one emulator instance cannot provide — so handheld examples ship a
 * press-start title and no 2P mode instead of faking one. (Consoles' shmup
 * examples have real co-op 2P.)
 *
 * What depends on what:
 *   gb_hardware.h — register names (LCDC/WX/WY/VBK/BCPS/NRxx/...) + masks.
 *   gb_runtime.{h,c} — vblank wait (HALT-driven), joypad, shadow OAM + the
 *     OAM-DMA-from-HRAM routine, VRAM-safe memcpy, APU helpers (shared GB).
 *   gb_crt0.s — boot + interrupt vectors + the cartridge header window. It
 *     DECLARES the cart as MBC1+RAM+BATTERY ($0147=$03, $0149=$02): that
 *     header is what makes the SRAM hi-score persist (the GB equivalent of
 *     the NES BATTERY bit). Load-bearing; edit with TROUBLESHOOTING open.
 *   font.h — 0-9 A-Z 2bpp glyphs for all text.
 *
 * The starfield fills the FULL 32-row BG map (not just the visible 18)
 * because the uint8 SCY scroll wraps through all 32 — a part-filled map
 * scrolls garbage into view. The color travels with the tiles: each cell's
 * bank-1 attribute byte scrolls along with its tile, so a "far" depth band
 * stays its dim blue wherever it slides under the screen.
 *
 * WRAM NOTE: build with dataLoc:0xC200 so our statics sit ABOVE shadow_oam
 * ($C100) — else oam_clear() would zero our state. The project recipe sets
 * that automatically.
 */

#include "gb_hardware.h"
#include "gb_runtime.h"
#include "font.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "PHOTON DRIFT"

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile inventory. GB/GBC tiles are 16 bytes: 8 rows × [low-plane byte,
 * high-plane byte]. Pixel colour index = (hi_bit << 1) | lo_bit (0..3); on
 * CGB that index selects a colour WITHIN whichever CGB palette the cell's
 * bank-1 attribute (BG) or the sprite's OAM attr (OBJ) chose. So one ship
 * tile reads cyan or any other palette purely by its attribute byte. */
static const uint8_t tile_blank[16] = { 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0 };
static const uint8_t tile_ship[16] = {           /* arrowhead fighter        */
    0x18,0x18, 0x18,0x18, 0x3C,0x24, 0x3C,0x24,
    0x7E,0x5A, 0xFF,0xDB, 0xFF,0xA5, 0x66,0x66,
};
static const uint8_t tile_bullet[16] = {         /* bright bolt (value 3)    */
    0x00,0x00, 0x18,0x18, 0x3C,0x3C, 0x3C,0x3C,
    0x3C,0x3C, 0x3C,0x3C, 0x18,0x18, 0x00,0x00,
};
static const uint8_t tile_enemy[16] = {          /* spiky drone (value 3)    */
    0x81,0x81, 0x42,0x5A, 0x24,0x3C, 0xFF,0xFF,
    0xFF,0xFF, 0x24,0x3C, 0x42,0x5A, 0x81,0x81,
};
/* Starfield BG tiles. tile_space carries two value-1 specks so even "empty"
 * space is never one flat colour (the render-health floor every example
 * keeps), and the specks make vertical scroll motion visible everywhere. */
static const uint8_t tile_space[16] = {          /* faint specks (value 1)   */
    0x00,0x00, 0x08,0x00, 0x00,0x00, 0x00,0x00,
    0x40,0x00, 0x00,0x00, 0x02,0x00, 0x00,0x00,
};
static const uint8_t tile_star[16] = {           /* value-2 dot              */
    0x00,0x00, 0x00,0x00, 0x18,0x00, 0x3C,0x00,
    0x3C,0x00, 0x18,0x00, 0x00,0x00, 0x00,0x00,
};
static const uint8_t tile_brite[16] = {          /* value-3 "+" twinkle      */
    0x00,0x00, 0x18,0x18, 0x18,0x18, 0x7E,0x7E,
    0x7E,0x7E, 0x18,0x18, 0x18,0x18, 0x00,0x00,
};
static const uint8_t tile_hudbar[16] = {         /* solid value-3 divider    */
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
};

/* Tile indices ($8000 unsigned addressing — LCDC bit 4 set below). Sprites
 * and BG share the $8000 table in this layout, so one upload serves both.
 * Font glyphs follow at FONT_BASE (digits 0-9, then A-Z). */
#define T_BLANK   0
#define T_SHIP    1
#define T_BULLET  2
#define T_ENEMY   3
#define T_SPACE   4
#define T_STAR    5
#define T_BRITE   6
#define T_HUDBAR  7
#define FONT_BASE 16     /* digit d = 16+d, letter L = 16+10+idx (see font.h) */

/* ── GAME LOGIC (clay — reshape freely) ── the CGB palette TABLE (the colours
 * themselves are art; the LOADER below is the hardware idiom).
 * 15-bit BGR: 5 bits each, blue in the high bits — RGB() packs it. Colour 0
 * of a BG palette is the cell's "background" shade; for OBJ palettes colour 0
 * is transparent (the scene shows through). */
#define RGB(r,g,b) ((uint16_t)(((uint16_t)(b)<<10)|((uint16_t)(g)<<5)|(r)))

/* BG palette slots (bank-1 attribute byte bits 0-2 select one of these).
 * The three depth bands give the parallax starfield real distance — and they
 * are genuinely DIFFERENT HUES (deep indigo far, teal-cyan mid, magenta-violet
 * near), not three shades of one blue. So the field reads as a colourful
 * nebula band, and a wide-area hue census sees several distinct colours — the
 * proof the cart is doing per-tile CGB colour, not 4-shade-green DMG. */
#define PAL_FAR   0      /* deep blue distance               */
#define PAL_MID   1      /* teal mid band                    */
#define PAL_GRN   2      /* green inner band                 */
#define PAL_NEAR  4      /* magenta-violet foreground band   */
#define PAL_HUD   3      /* HUD bar + all text               */

static const uint16_t bg_palettes[8][4] = {
    /* 0 far  */ { RGB(2,3,14),   RGB(5,8,24),   RGB(8,12,30),  RGB(18,20,31) },
    /* 1 mid  */ { RGB(1,8,9),    RGB(3,20,22),  RGB(6,30,30),  RGB(20,31,31) },
    /* 2 grn  */ { RGB(2,9,3),    RGB(6,22,7),   RGB(10,31,12), RGB(22,31,20) },
    /* 3 hud  */ { RGB(2,2,6),    RGB(8,9,16),   RGB(2,2,6),    RGB(31,31,31) },
    /* 4 near */ { RGB(12,1,12),  RGB(26,3,24),  RGB(31,8,26),  RGB(31,22,31) },
    /* 5 spare*/ { RGB(0,0,0),    RGB(10,10,10), RGB(20,20,20), RGB(31,31,31) },
    /* 6 spare*/ { RGB(0,0,0),    RGB(10,10,10), RGB(20,20,20), RGB(31,31,31) },
    /* 7 spare*/ { RGB(0,0,0),    RGB(10,10,10), RGB(20,20,20), RGB(31,31,31) },
};

/* OBJ palette slots (OAM attr bits 0-2 select one of these). Colour 0 is
 * always transparent. */
#define OPAL_SHIP   0    /* cyan hero        */
#define OPAL_BULLET 1    /* gold bolt        */
#define OPAL_ENEMY  2    /* danger red drone */

static const uint16_t obj_palettes[8][4] = {
    /* 0 ship   */ { 0, RGB(8,28,31),  RGB(2,16,28),  RGB(28,31,31) },
    /* 1 bullet */ { 0, RGB(31,28,6),  RGB(31,20,2),  RGB(31,31,20) },
    /* 2 enemy  */ { 0, RGB(31,8,8),   RGB(20,2,2),   RGB(31,24,16) },
    /* 3 spare  */ { 0, RGB(20,20,20), RGB(31,31,31), RGB(10,10,10) },
    /* 4 spare  */ { 0, RGB(20,20,20), RGB(31,31,31), RGB(10,10,10) },
    /* 5 spare  */ { 0, RGB(20,20,20), RGB(31,31,31), RGB(10,10,10) },
    /* 6 spare  */ { 0, RGB(20,20,20), RGB(31,31,31), RGB(10,10,10) },
    /* 7 spare  */ { 0, RGB(20,20,20), RGB(31,31,31), RGB(10,10,10) },
};

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * THE WINDOW-LAYER HUD — the Game Boy's signature "fixed HUD over a
 * scrolling world" technique. The window is a second BG plane with its own
 * 32×32 tile map and NO scroll registers: it always draws its map from
 * (0,0), pinned to the screen, on top of the BG. So the HUD lives in the
 * window and the playfield lives in the BG — SCY scrolls the starfield all
 * it likes and the HUD never moves. No raster splits, no IRQ timing (the NES
 * needs a sprite-0 polling dance for this exact effect; on GB it's three
 * register writes). On CGB the window cells take bank-1 palette attributes
 * exactly like the BG (set_wcell writes both banks).
 *
 * The three registers, and their two famous footguns:
 *   WY ($FF4A) — first screen LINE the window covers. We use 128: lines
 *     0-127 are playfield, 128-143 (two tile rows) are the HUD strip.
 *   WX ($FF4B) — screen column PLUS SEVEN. WX=7 means "left edge". The -7
 *     offset is hardware fact: WX=0..6 glitches, WX≥167 is off-screen.
 *   LCDC bit 5 — window enable; bit 6 — which map it reads ($9800/$9C00).
 *
 * FOOTGUN 1 — "the window ate the bottom of my screen": once the window
 * starts on a line it covers EVERY line from there DOWN, full width. There
 * is no window height register. That is why GB HUDs sit at the BOTTOM of the
 * screen. A TOP HUD needs a STAT-interrupt LYC trick — a different, fragile
 * idiom; don't drift into it by accident by setting WY=0.
 *
 * FOOTGUN 2 — sprites are NOT clipped by the window. OBJs draw over it, so a
 * sprite below line 128 sits ON the HUD. Gameplay despawns every enemy and
 * clamps the ship above PLAY_H, so nothing overlaps the HUD strip.
 *
 * Requires: window map at $9C00 (LCDC bit 6), tile data at $8000 (bit 4),
 * WX=7, WY=PLAY_H, LCDC bit 5 set during play (title turns the window off). */
#define PLAY_H   128                       /* first HUD line = window top */
#define LCDC_TITLE (LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO)
#define LCDC_PLAY  (LCDC_TITLE | LCDC_WINDOW_ON | LCDC_WINDOW_MAP_HI)

#define VRAM ((volatile uint8_t *)0x9800)  /* BG map $9800 base */
#define WIN_OFF   0x400                    /* window map $9C00 = $9800 + $400 */

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * BATTERY SRAM — persistent hi-score. MBC1 cart RAM is 8KB at $A000-$BFFF,
 * but it boots DISABLED and writes to a disabled bank are silently
 * discarded (reads float). The gate is the MBC's RAM-enable register: any
 * WRITE to ROM space $0000-$1FFF with $0A in the low nibble enables the RAM;
 * writing $00 disables it again. (Writing "into ROM" feels wrong the first
 * time — ROM-area writes never touch ROM, they talk to the mapper chip.)
 * Leaving RAM enabled all the time "works" in emulators but on real hardware
 * risks corruption at power-off — battery carts since forever do
 * enable → touch → disable, so we do too.
 *
 * First boot is GARBAGE, not zeros: battery RAM holds whatever the silicon
 * woke up with. The magic 'H','S' + checksum is how the load path tells "my
 * save" from "factory noise" — without it a fresh cart shows a junk hi-score.
 *
 * Save block at $A000: 'H' 'S'  lo hi  (lo^hi^$A5)
 *
 * Requires: gb_crt0.s declaring $0147=$03 (MBC1+RAM+BATTERY) + $0149=$02
 * (8KB) — those header bytes are how the emulator knows to allocate and
 * persist SAVE_RAM. Verify headlessly: play, game over, then
 * memory({op:'read', region:'save_ram'}) shows the block, and the hi-score
 * survives host.hardReset(). */
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
 * slots, we use 13): 0 = ship, 1-6 bullets, 7-12 enemies. Sub-10 sprites on
 * any one scanline keeps us clear of the 10-OBJ/line hardware drop. */
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

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * CGB palette RAM — the BCPS/BCPD (BG) and OCPS/OCPD (OBJ) port pairs.
 * requires: a .gbc build (CGB flag $0143 set — the build pipeline does it);
 *   on a DMG build these registers are dead and you get 4-shade green.
 *
 * Palette RAM is NOT memory-mapped: it's 64 bytes (8 palettes × 4 colours ×
 * 2 bytes, little-endian 15-bit BGR) behind an index/data port pair.
 *   BCPS = 0x80 | index   — set write index; bit 7 = AUTO-INCREMENT, so a
 *                           burst of BCPD writes walks the whole 64 bytes.
 *   BCPD = low byte; BCPD = high byte;  ... 32 times = all 8 palettes.
 *
 * TIMING FOOTGUN: palette RAM belongs to the PPU. Writes during active
 * display (mode 3) are IGNORED on real hardware — same constraint as VRAM.
 * Load palettes with the LCD OFF (boot / transitions, as here) or inside
 * vblank. A palette "fade" = a few BCPD writes per vblank, never a mid-frame
 * burst. */
static void load_bg_palettes(void) {
  uint8_t p, i;
  BCPS = 0x80;                       /* index 0, auto-increment on */
  for (p = 0; p < 8; p++)
    for (i = 0; i < 4; i++) {
      BCPD = (uint8_t)(bg_palettes[p][i] & 0xFF);
      BCPD = (uint8_t)((bg_palettes[p][i] >> 8) & 0xFF);
    }
}

static void load_obj_palettes(void) {
  uint8_t p, i;
  OCPS = 0x80;
  for (p = 0; p < 8; p++)
    for (i = 0; i < 4; i++) {
      OCPD = (uint8_t)(obj_palettes[p][i] & 0xFF);
      OCPD = (uint8_t)((obj_palettes[p][i] >> 8) & 0xFF);
    }
}

/* ── GAME LOGIC (clay) — VRAM upload + text helpers ──────────────────────────
 * All of these write VRAM, so they run with the LCD OFF (boot/repaints) or
 * inside vblank (the HUD digit commit). memcpy_vram walks a pointer
 * (*dst++ = v) — never index dst[i] through a VRAM pointer (SDCC's sm83 port
 * miscompiles indexed stores through VRAM-pointing pointers). */
static void upload_tile(uint8_t slot, const uint8_t *src) {
  memcpy_vram((uint8_t *)(0x8000 + (uint16_t)slot * 16), src, 16);
}

static void upload_font(void) {
  uint8_t g;
  /* font.h glyphs are already 2bpp (16 bytes each) — straight copy. */
  for (g = 0; g < FONT_GLYPHS; g++)
    memcpy_vram((uint8_t *)(0x8000 + (uint16_t)(FONT_BASE + g) * 16),
                &font_data[g * 16], 16);
}

static uint8_t char_tile(char ch) {
  if (ch >= '0' && ch <= '9') return (uint8_t)(FONT_BASE + (ch - '0'));
  if (ch >= 'A' && ch <= 'Z') return (uint8_t)(FONT_BASE + 10 + (ch - 'A'));
  return T_BLANK;                              /* space / unknown → blank */
}

/* Pre-convert a string to tile indices at full-frame time, so the vblank
 * commit (commit_bg_text) is a dumb byte copy — see game_over(). */
static uint8_t msg_q[20];                /* 9 "GAME OVER" + 11 "PRESS START" */
static void stage_text(const char *s, uint8_t *out) {
  while (*s) *out++ = char_tile(*s++);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Per-tile color — the VRAM bank-1 attribute map (VBK register).
 * requires: CGB mode (see the palette idiom above); writes in a VRAM-safe
 *   window (LCD off, or a bounded vblank batch).
 *
 * VRAM is TWO 8KB banks behind the same $8000-$9FFF window; VBK ($FF4F)
 * selects which one the CPU sees. Bank 0 holds what the DMG had: tile pixels
 * + the tile-index maps. Bank 1 at the SAME map address holds one ATTRIBUTE
 * byte per cell:
 *   bits 0-2  palette 0-7   ← this game's whole color system
 *   bit 3     tile VRAM bank
 *   bit 5/6   H/V flip
 *   bit 7     BG-over-OBJ priority
 * So coloring a cell is a write PAIR: tile index with VBK=0, attribute with
 * VBK=1, at the SAME offset.
 *
 * FOOTGUN: VBK is global state. Forget to restore VBK=0 and every later
 * "tile" write lands in the attribute map — the screen turns into garbage
 * colors while the tile data you wrote is simply gone. Always end VBK=0
 * (every routine here does). */
static void set_cell(uint8_t mx, uint8_t my, uint8_t tile, uint8_t pal) {
  uint16_t off = (uint16_t)my * 32 + mx;
  VBK = 0;
  VRAM[off] = tile;
  VBK = 1;
  VRAM[off] = pal;
  VBK = 0;
}

/* same write-pair, into the WINDOW's map at $9C00 (window HUD idiom) */
static void set_wcell(uint8_t wx, uint8_t wy, uint8_t tile, uint8_t pal) {
  uint16_t off = WIN_OFF + (uint16_t)wy * 32 + wx;
  VBK = 0;
  VRAM[off] = tile;
  VBK = 1;
  VRAM[off] = pal;
  VBK = 0;
}

/* draw a NUL-terminated string into the BG map (palette PAL_HUD = readable). */
static void draw_text(uint8_t col, uint8_t row, const char *s) {
  uint8_t i;
  for (i = 0; s[i] != 0; i++)
    set_cell((uint8_t)(col + i), row, char_tile(s[i]), PAL_HUD);
}

/* draw a NUL-terminated string into the WINDOW map. */
static void draw_wtext(uint8_t col, uint8_t row, const char *s) {
  uint8_t i;
  for (i = 0; s[i] != 0; i++)
    set_wcell((uint8_t)(col + i), row, char_tile(s[i]), PAL_HUD);
}

/* Decimal digits WITHOUT divide/modulo (the sm83 has neither — SDCC's
 * software % costs ~700 cycles a call). Repeated power-of-ten subtraction
 * caps at 36 SUBs for any u16. Writes 5 tile slots into out5. */
static void u16_to_tiles(uint16_t v, uint8_t *out5) {
  static const uint16_t pow10[4] = { 10000, 1000, 100, 10 };
  uint8_t i, d;
  for (i = 0; i < 4; i++) {
    d = 0;
    while (v >= pow10[i]) { v -= pow10[i]; ++d; }
    *out5++ = (uint8_t)(FONT_BASE + d);
  }
  *out5 = (uint8_t)(FONT_BASE + (uint8_t)v);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * The PARALLAX-BANDED starfield — the game's CGB colour proof in the BG.
 * The field fills the FULL 32-row map; SCY scrolling wraps through all 32,
 * so a part-filled map would scroll garbage into view. Each cell takes a
 * tile (bank 0) AND a depth-band palette attribute (bank 1) — that pairing
 * is the whole CGB colour story.
 *
 * PERF FOOTGUN (measured, not theoretical): the obvious pattern formula
 * `(r*7 + c*5) % 11` calls SDCC's software modulo (~700 cycles) — 1024 times
 * over a 32×32 map ≈ a multi-frame frozen boot. The fix is the classic 8-bit
 * move: keep running counters and subtract on overflow (zero divisions). The
 * sm83 has no divide instruction; treat every / and % in a loop as a red flag.
 *
 * The DEPTH BAND is chosen by the map ROW in a repeating 4-row cycle
 * (blue, teal, green, magenta) so FOUR distinct nebula hues are ALWAYS on
 * screen at once — the field reads as a banded nebula and a wide hue census
 * sees several distinct colours regardless of where SCY has scrolled. As the
 * field scrolls the bands scroll with it (the attribute byte rides the tile).
 * 32 rows IS a multiple of 4, so the band cycle wraps seamlessly at the map
 * seam too. */
static const uint8_t band_cycle[4] = { PAL_FAR, PAL_MID, PAL_GRN, PAL_NEAR };
static uint8_t band_for_row(uint8_t r) {
  return band_cycle[r & 3];                    /* r mod 4 — divide-free */
}

static void paint_starfield(void) {
  uint8_t r, c, t, pal;
  uint8_t ar = 0, br = 0;       /* row seeds: (r*7) mod 11, (r*3) mod 29 */
  uint8_t a, b;
  for (r = 0; r < 32; r++) {
    a = ar; b = br;
    pal = band_for_row(r);
    for (c = 0; c < 32; c++) {
      t = T_SPACE;
      if (a == 0) t = T_STAR;
      if (b == 0) t = T_BRITE;
      VBK = 0; VRAM[(uint16_t)r * 32 + c] = t;
      VBK = 1; VRAM[(uint16_t)r * 32 + c] = pal;
      a += 5;  if (a >= 11) a -= 11;     /* +5 ≡ c step, mod 11 */
      b += 13; if (b >= 29) b -= 29;     /* +13 ≡ c step, mod 29 */
    }
    ar += 7; if (ar >= 11) ar -= 11;     /* +7 ≡ r step, mod 11 */
    br += 3; if (br >= 29) br -= 29;     /* +3 ≡ r step, mod 29 */
  }
  VBK = 0;
}

static void paint_title(void) {
  paint_starfield();                           /* banded field — text owns the top */
  draw_text((uint8_t)((20 - (sizeof(GAME_TITLE) - 1)) / 2), 3, GAME_TITLE);
  draw_text(4, 8, "PRESS START");
  draw_text(6, 11, "HI");
  {
    uint8_t d[5], i;
    u16_to_tiles(hiscore, d);
    for (i = 0; i < 5; i++) set_cell((uint8_t)(9 + i), 11, d[i], PAL_HUD);
  }
  draw_text(6, 14, "1P ONLY");                 /* see header: no link 2P */
  SCY = 0; SCX = 0;
  scroll_y = 0;
}

/* HUD strip = window rows 0-1: a solid divider bar, then the text row.
 * Columns 0-19 are the visible 20 (WX=7 pins map col 0 to screen x 0). */
static void paint_hud(void) {
  uint8_t c, d[5], i;
  for (c = 0; c < 20; c++) set_wcell(c, 0, T_HUDBAR, PAL_HUD);
  for (c = 0; c < 20; c++) set_wcell(c, 1, T_BLANK, PAL_HUD);
  draw_wtext(0, 1, "SC");
  u16_to_tiles(score, d);
  for (i = 0; i < 5; i++) set_wcell((uint8_t)(3 + i), 1, d[i], PAL_HUD);
  draw_wtext(9, 1, "HI");
  u16_to_tiles(hiscore, d);
  for (i = 0; i < 5; i++) set_wcell((uint8_t)(12 + i), 1, d[i], PAL_HUD);
  draw_wtext(18, 1, "L");
  set_wcell(19, 1, (uint8_t)(FONT_BASE + lives), PAL_HUD);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * LCD-off repaints. Bulk VRAM rewrites (full title/field repaints) happen
 * with the LCD OFF — free access, no per-byte timing worries. The rule:
 * only flip LCDC bit 7 to 0 DURING VBLANK. Killing the LCD mid-scanline is
 * the classic "damages real DMG hardware" move; emulators shrug, real units
 * can be permanently marked. wait_vblank() first, always.
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

/* ── GAME LOGIC (clay) — sound: frame-ticked tune + fire/boom SFX ─────────────
 * Channel plan keeps SFX from cutting the music: ch2 = music (one
 * sound_play_tone trigger per note, the APU sustains it), ch1 = fire blips,
 * ch4 = noise for explosions. music_tick() runs once per frame from the main
 * loop; the APU needs no other upkeep. Periods are the 11-bit GB frequency
 * code: 2048 - (131072 / Hz). 0 = rest. SELECT toggles it. */
static const uint16_t tune[16] = {
  1547, 0, 1650, 0, 1714, 0, 1798, 0,     /* C4 E4 G4 C5 */
  1714, 0, 1650, 0, 1602, 0, 1650, 0,     /* G4 E4 D4 E4 */
};
static uint8_t music_on = 1, music_pos, music_timer;
static void music_tick(void) {
  uint16_t n;
  if (!music_on) return;
  if (++music_timer < 14) return;
  music_timer = 0;
  n = tune[music_pos];
  music_pos = (uint8_t)((music_pos + 1) & 15);
  if (n) sound_play_tone(2, n, 12);
}
static void music_toggle(void) {
  music_on = (uint8_t)(!music_on);
  if (!music_on) { NR21 = 0x00; NR22 = 0x00; NR24 = 0x80; }   /* silence ch2 */
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
       * divide-free rule (see paint_starfield) is about per-cell/per-frame
       * loops, not superstition. */
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
  /* Compare against the SAVED record, not the live `hiscore` readout — the
   * kill handler already raised `hiscore` to track the run, so testing
   * `score > hiscore` here would never fire. */
  if (score > record) {
    record = score;
    hiscore_save(record);       /* battery write — survives power-off */
  }
  state = ST_OVER;
  /* The BG has scrolled: map row 0 is no longer screen row 0. Anchor the
   * text relative to the CURRENT scroll so it lands mid-playfield on-screen
   * ((SCY/8 + screen_row) & 31 = the map row under that screen row). Convert
   * the strings to tile indices HERE (full-frame time) into msg_q — the
   * vblank commit is then a DUMB byte copy. char_tile's per-char compare
   * chain is exactly the work that blows the ~1140-cycle vblank budget; doing
   * it inside the commit dropped the middle of the 11-char PRESS START line
   * (verified on the GB original). Stage out here, copy in there. */
  msg_row = (uint8_t)(((scroll_y >> 3) + 6) & 31);
  stage_text("GAME OVER", msg_q);
  stage_text("PRESS START", msg_q + 9);
  msg_stage = 2;
}

/* ── GAME LOGIC (clay) — per-state update (runs OUTSIDE vblank) ── */
static void update_play(uint8_t pad) {
  uint8_t i, j;

  if ((pad & PAD_LEFT)  && ship.x > 0)            ship.x -= 2;
  if ((pad & PAD_RIGHT) && ship.x < 160 - 8)      ship.x += 2;
  if ((pad & PAD_UP)    && ship.y > 8)            ship.y -= 2;
  if ((pad & PAD_DOWN)  && ship.y < PLAY_H - 24)  ship.y += 2;
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

/* ── GAME LOGIC (clay) — stage the shadow OAM for THIS frame ──────────────────
 * Pure WRAM writes (shadow_oam at $C100) — safe any time; only the DMA flush
 * is vblank-sensitive. OAM coords are hardware coords: +16 on Y, +8 on X.
 * A sprite's CGB palette = OAM attr bits 0-2 — that's the whole "color this
 * sprite" story. Slot plan (40 hardware slots, we use 13): 0 = ship,
 * 1-6 bullets, 7-12 enemies — well under the 10-OBJ/line hardware drop. */
static void stage_sprites(void) {
  uint8_t i;
  oam_clear();
  if (state == ST_TITLE) {
    /* Guaranteed-visible sprite from the first title frame — proof the OAM
     * pipeline (shadow → HRAM DMA stub → OAM) is alive before any gameplay
     * complicates the picture. */
    oam_set(0, 96 + 16, 76 + 8, T_SHIP, OPAL_SHIP);
    return;
  }
  if (ship.alive)
    oam_set(0, (uint8_t)(ship.y + 16), (uint8_t)(ship.x + 8), T_SHIP, OPAL_SHIP);
  for (i = 0; i < MAX_BULLETS; i++)
    if (bullets[i].alive)
      oam_set((uint8_t)(1 + i), (uint8_t)(bullets[i].y + 16),
              (uint8_t)(bullets[i].x + 8), T_BULLET, OPAL_BULLET);
  for (i = 0; i < MAX_ENEMIES; i++)
    if (enemies[i].alive)
      oam_set((uint8_t)(7 + i), (uint8_t)(enemies[i].y + 16),
              (uint8_t)(enemies[i].x + 8), T_ENEMY, OPAL_ENEMY);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Queued VRAM commits — and the bank-0-only HUD write. Two-phase update,
 * mirroring the shadow-OAM discipline: game logic only sets hud_dirty /
 * msg_stage. stage_hud() (full-frame time) does the digit math into hud_q;
 * commit_vram() (vblank time) writes bytes — AT MOST ONE queued item/vblank.
 *
 * THE CGB TWIST (load-bearing): a naive set_wcell() per HUD cell toggles VBK
 * twice + writes two banks PER cell — for 11 HUD cells that's ~33 VBK writes
 * in one vblank, which OVERRUNS the ~1140-cycle window and silently drops the
 * tail writes (the lives digit at col 19 vanished — verified on the GBC
 * platformer). The fix: the window HUD cells' bank-1 ATTRIBUTE bytes are
 * constant PAL_HUD (painted once by paint_hud at LCD-off and never changed),
 * so the per-frame commit only needs to rewrite bank-0 TILE bytes. We set
 * VBK=0 ONCE and pointer-walk the digit cells — a tight write that fits
 * vblank with room to spare. (Pointer walk, not map[i] indexing — the SDCC
 * VRAM footgun.)
 *
 * The game-over text on the BG goes the same way: pre-staged tiles, written
 * one line per vblank, and we DELIBERATELY leave the cells' bank-1 attribute
 * alone — the field painted them a depth-band palette whose colour-3 (the
 * font ink value) is bright, so the text reads on top with ZERO attribute
 * writes. That halves the vblank cost. */
static uint8_t hud_q[11];       /* 5 score digits, 5 hi digits, lives tile */
static uint8_t hud_ready;
#define WIN_TILE ((volatile uint8_t *)0x9C00)   /* window map, bank 0 */

static void stage_hud(void) {
  if (!hud_dirty) return;
  hud_dirty = 0;
  u16_to_tiles(score, hud_q);
  u16_to_tiles(hiscore, hud_q + 5);
  hud_q[10] = (uint8_t)(FONT_BASE + lives);
  hud_ready = 1;
}

/* Write a scroll-anchored, pre-staged BG-map line (msg_q tiles) as a single
 * BANK-0 tile copy — a dumb byte walk, no char_tile work and no per-cell VBK
 * toggling. col wraps at the 32-col map seam (the text is scroll-anchored, so
 * it can straddle the wrap). */
static void commit_bg_text(uint8_t row, uint8_t col, const uint8_t *q, uint8_t len) {
  volatile uint8_t *base = VRAM + (uint16_t)row * 32;
  volatile uint8_t *p = base + col;
  uint8_t n = (uint8_t)(32 - col);
  VBK = 0;
  if (n > len) n = len;                        /* run 1: up to the map seam   */
  len -= n;
  while (n--) *p++ = *q++;
  p = base;                                    /* run 2: wrapped remainder    */
  while (len--) *p++ = *q++;
}

static void commit_vram(void) {
  uint8_t i;
  if (hud_ready) {                            /* item 1: HUD digits (bank 0) */
    hud_ready = 0;
    VBK = 0;                                  /* attributes already PAL_HUD */
    for (i = 0; i < 5; i++) WIN_TILE[32 + 3 + i]  = hud_q[i];      /* score */
    for (i = 0; i < 5; i++) WIN_TILE[32 + 12 + i] = hud_q[5 + i];  /* hi    */
    WIN_TILE[32 + 19] = hud_q[10];                                 /* lives */
    return;
  }
  if (msg_stage == 2) {                       /* item 2: GAME OVER line */
    msg_stage = 1;
    commit_bg_text(msg_row, 5, msg_q, 9);
    return;
  }
  if (msg_stage == 1) {                       /* item 3: PRESS START line */
    msg_stage = 0;
    commit_bg_text((uint8_t)((msg_row + 2) & 31), 4, msg_q + 9, 11);
  }
}

void main(void) {
  uint8_t pad;

  /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
   * Boot order. Three load-bearing calls, in this order:
   *   1. lcd_init_default() — sane LCD state AND it installs the OAM-DMA stub
   *      into HRAM ($FF80). During OAM DMA the CPU can only fetch from HRAM;
   *      the broken alternative (spinning in ROM) fetches $FF = rst $38 and
   *      corrupts the stack — the classic "sprites never show / game dies
   *      after a while" GB death. Every oam_dma_flush() depends on this stub.
   *   2. enable_vblank_irq() — flips wait_vblank() from LY-polling to
   *      HALT-until-vblank-IRQ. The polling fallback runs at ~1/30 speed on
   *      the WASM emulator; the HALT path is full speed everywhere.
   *   3. LCD off (inside vblank) for the bulk VRAM uploads — tiles, font,
   *      palettes, first screen — then back on. Tile/palette/map uploads
   *      REQUIRE a VRAM-safe window; boot does them all at once, so LCD-off
   *      is the only sane choice here. */
  lcd_init_default();
  enable_vblank_irq();
  sound_init();

  wait_vblank();
  LCDC = 0;                     /* LCD off — free VRAM access from here */

  upload_tile(T_BLANK,  tile_blank);
  upload_tile(T_SHIP,   tile_ship);
  upload_tile(T_BULLET, tile_bullet);
  upload_tile(T_ENEMY,  tile_enemy);
  upload_tile(T_SPACE,  tile_space);
  upload_tile(T_STAR,   tile_star);
  upload_tile(T_BRITE,  tile_brite);
  upload_tile(T_HUDBAR, tile_hudbar);
  upload_font();

  load_bg_palettes();           /* the CGB BG palettes — depth bands + HUD */
  load_obj_palettes();          /* ship / bullet / enemy OBJ palettes      */

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

    /* SELECT toggles the background music, in any state. */
    if ((pad & PAD_SELECT) && !(prev_pad & PAD_SELECT)) music_toggle();

    if (state == ST_TITLE) {
      if ((pad & (PAD_START | PAD_A)) && !(prev_pad & (PAD_START | PAD_A))) start_game();
      prev_pad = pad;
    } else if (state == ST_PLAY) {
      update_play(pad);
      prev_pad = pad;
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
     *     inside vblank; pushing it later (after VRAM writes that grow over
     *     time) slides it into active display, where the PPU is reading OAM
     *     = one frame of torn/invisible sprites, intermittent and miserable
     *     to debug.
     *   commit_vram() second — the few queued HUD/map bytes (one item/frame).
     *   SCY last — scroll latches per-scanline, so writing it during vblank
     *     (before line 0 renders) moves the WHOLE next frame consistently;
     *     the window ignores it by design (the HUD idiom).
     * Game logic above NEVER touches VRAM directly — it sets the dirty flags
     * and shadow OAM, and this slice commits them. Keep that split. */
    wait_vblank();
    oam_dma_flush();
    commit_vram();
    SCY = scroll_y;             /* title resets scroll_y to 0; over freezes it */
    music_tick();
  }
}
