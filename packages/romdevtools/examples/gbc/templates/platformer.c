/* ── platformer.c — SPECTRA BOUND: Game Boy Color side-scrolling platformer ──
 *
 * A COMPLETE, working game — title screen, gravity + jump physics with
 * sub-pixel precision, one-way platforms, pits and spikes, coins + distance
 * scoring, persistent battery hi-score (MBC1+RAM+BATTERY SRAM), music + SFX,
 * the Game Boy's signature WINDOW-layer fixed HUD over an SCX-scrolling
 * looping level — and the GBC's signature feature on top of all of it:
 * TRUE per-tile color. Sky, grass, dirt, platforms and hazards are FIVE
 * REAL CGB palettes (15-bit BGR, loaded through BCPS/BCPD), assigned per BG
 * cell through the VRAM bank-1 attribute map, and the player / coins / spikes
 * are their own OBJ palettes through OCPS — not a colorized monochrome game.
 *
 * THE GAME: an endless one-way runner. Hold RIGHT to gallop; the world
 * scrolls past a scroll wall (the classic runner camera). A=jump (with
 * coyote-free, grounded-only launch). Hop the lethal pits and the drifting
 * spikes, scoop coins, and the longer you survive the higher your distance
 * score climbs. Three lives; the battery remembers your best run forever.
 * SELECT toggles the music.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented GB/GBC footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — level layout, physics tuning, scoring, art: reshape
 *     freely.
 *
 * SINGLE-PLAYER, honestly: the Game Boy's "player 2" is a LINK CABLE, which
 * one emulator instance cannot provide — so handheld examples ship a
 * press-start title and no 2P mode instead of faking one.
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
 * The level is a 256-px-wide COLUMN MAP painted ONCE into the wrapping
 * 32-wide BG map (bank-0 tiles + bank-1 palette attributes), so the uint8
 * SCX scroll wraps PERFECTLY seamless — an endless looping run. The color
 * travels with the tiles: each cell's bank-1 attribute byte scrolls along
 * with its tile, so a grass cell stays green wherever it slides on screen.
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
#define GAME_TITLE "SPECTRA BOUND"

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile inventory. GB/GBC tiles are 16 bytes: 8 rows × [low-plane byte,
 * high-plane byte]. Pixel colour index = (hi_bit << 1) | lo_bit (0..3); on
 * CGB that index selects a colour WITHIN whichever CGB palette the cell's
 * bank-1 attribute (BG) or the sprite's OAM attr (OBJ) chose. So one grass
 * tile reads green or any other palette purely by its attribute byte. */
static const uint8_t tile_blank[16] = { 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0 };
static const uint8_t tile_player[16] = {         /* round body + face       */
    0x3C,0x00, 0x7E,0x24, 0xFF,0x24, 0xFF,0x00,
    0xFF,0x00, 0x7E,0x00, 0x66,0x00, 0x66,0x00,
};
static const uint8_t tile_player_jump[16] = {    /* arms up, mid-leap        */
    0x18,0x00, 0x7E,0x24, 0xFF,0x24, 0xFF,0x00,
    0xE7,0x00, 0xC3,0x00, 0x81,0x00, 0x00,0x00,
};
static const uint8_t tile_coin[16] = {           /* faceted gem disc         */
    0x00,0x3C, 0x30,0x4E, 0x60,0x9F, 0x40,0xBF,
    0x02,0xFF, 0x06,0xFF, 0x1C,0x7E, 0x00,0x3C,
};
static const uint8_t tile_spike[16] = {          /* solid spike (value 3)    */
    0x00,0x00, 0x18,0x18, 0x18,0x18, 0x3C,0x3C,
    0x3C,0x3C, 0x7E,0x7E, 0x7E,0x7E, 0xFF,0xFF,
};
/* Backdrop tiles. tile_sky carries two value-1 dot pixels so even "empty"
 * sky is never one flat colour (the render-health floor every example
 * keeps), and the dots make horizontal scroll motion visible everywhere. */
static const uint8_t tile_sky[16] = {            /* faint specks (value 1)   */
    0x20,0x00, 0x00,0x00, 0x00,0x00, 0x02,0x00,
    0x00,0x00, 0x08,0x00, 0x00,0x00, 0x40,0x00,
};
static const uint8_t tile_cloud[16] = {          /* value-3 puff             */
    0x00,0x00, 0x18,0x18, 0x3C,0x3C, 0x7E,0x7E,
    0x7E,0x7E, 0x00,0x00, 0x00,0x00, 0x00,0x00,
};
static const uint8_t tile_dirt[16] = {           /* value-2 fill, value-1 grit*/
    0x00,0xFF, 0x20,0xDF, 0x00,0xFF, 0x04,0xFB,
    0x00,0xFF, 0x80,0x7F, 0x00,0xFF, 0x08,0xF7,
};
static const uint8_t tile_grass[16] = {          /* value-3 turf over dirt   */
    0xFF,0xFF, 0xFF,0xFF, 0x00,0xFF, 0x20,0xDF,
    0x00,0xFF, 0x04,0xFB, 0x00,0xFF, 0x00,0xFF,
};
static const uint8_t tile_plat[16] = {           /* one-way slab top edge    */
    0xFF,0xFF, 0xFF,0xFF, 0x00,0xFF, 0x00,0xDB,
    0x00,0xFF, 0x00,0x00, 0x00,0x00, 0x00,0x00,
};
static const uint8_t tile_hudbar[16] = {         /* solid value-3 divider    */
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
};

/* Tile indices ($8000 unsigned addressing — LCDC bit 4 set below). Sprites
 * and BG share the $8000 table in this layout, so one upload serves both.
 * Font glyphs follow at FONT_BASE (digits 0-9, then A-Z). */
#define T_BLANK   0
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
#define FONT_BASE 16     /* digit d = 16+d, letter L = 16+10+idx (see font.h) */

/* ── GAME LOGIC (clay — reshape freely) ── the CGB palette TABLE (the colours
 * themselves are art; the LOADER below is the hardware idiom).
 * 15-bit BGR: 5 bits each, blue in the high bits — RGB() packs it. Colour 0
 * of a BG palette is the cell's "background" shade; for OBJ palettes colour 0
 * is transparent (the scene shows through). */
#define RGB(r,g,b) ((uint16_t)(((uint16_t)(b)<<10)|((uint16_t)(g)<<5)|(r)))

/* BG palette slots (bank-1 attribute byte bits 0-2 select one of these). */
#define PAL_SKY   0      /* daytime sky + clouds   */
#define PAL_GRASS 1      /* grass turf top         */
#define PAL_DIRT  2      /* dirt fill / pit walls  */
#define PAL_PLAT  3      /* floating slabs         */
#define PAL_HUD   4      /* HUD bar + all text     */

static const uint16_t bg_palettes[8][4] = {
    /* 0 sky   */ { RGB(18,26,31), RGB(28,31,31), RGB(10,18,28), RGB(31,31,31) },
    /* 1 grass */ { RGB(6,18,8),   RGB(12,28,10), RGB(3,12,4),   RGB(20,31,16) },
    /* 2 dirt  */ { RGB(10,7,4),   RGB(18,12,6),  RGB(6,4,2),    RGB(24,17,9)  },
    /* 3 plat  */ { RGB(14,8,20),  RGB(24,16,31), RGB(8,3,14),   RGB(30,24,31) },
    /* 4 hud   */ { RGB(2,2,6),    RGB(8,9,16),   RGB(2,2,6),    RGB(31,31,31) },
    /* 5 spare */ { RGB(0,0,0),    RGB(10,10,10), RGB(20,20,20), RGB(31,31,31) },
    /* 6 spare */ { RGB(0,0,0),    RGB(10,10,10), RGB(20,20,20), RGB(31,31,31) },
    /* 7 spare */ { RGB(0,0,0),    RGB(10,10,10), RGB(20,20,20), RGB(31,31,31) },
};

/* OBJ palette slots (OAM attr bits 0-2 select one of these). Colour 0 is
 * always transparent. */
#define OPAL_PLAYER 0    /* sky-blue hero, white face */
#define OPAL_COIN   1    /* golden gem                */
#define OPAL_SPIKE  2    /* danger red                */

static const uint16_t obj_palettes[8][4] = {
    /* 0 player */ { 0, RGB(10,20,31), RGB(31,31,31), RGB(2,6,16)  },
    /* 1 coin   */ { 0, RGB(31,28,6),  RGB(31,20,2),  RGB(20,12,0) },
    /* 2 spike  */ { 0, RGB(31,8,8),   RGB(20,2,2),   RGB(31,24,16) },
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
 * window and the playfield lives in the BG — SCX scrolls the world all it
 * likes and the HUD never moves. No raster splits, no IRQ timing (the NES
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
 * sprite below line 128 sits ON the HUD. Gameplay keeps every object above
 * PLAY_H (spikes stand on the ground; a player falling into a pit dies at
 * PLAY_H-8, the frame before its sprite would touch the HUD).
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
 * The level — a 32-column map; world x = (screen x + scroll_x) mod 256.
 *   ground_row[c] — BG-map row of the ground's grass top, 0xFF = pit.
 *   plat_row[c]   — row of a one-way floating platform, 0 = none.
 * Rows are BG-map rows (y = row*8). The playfield is rows 0..15 (128 px,
 * everything below is under the window HUD). Pits are 4 columns wide on
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

/* ── GAME LOGIC (clay) — screen painters (LCD off = free VRAM access) ─────────
 * Paint the level scene into BG rows 0..17 (the SCY=0 screen window; this
 * game never scrolls vertically). For EACH cell we write the tile (bank 0)
 * AND its palette attribute (bank 1) — that pairing is the whole CGB colour
 * story. Clouds use a running divide-free pattern counter (the sm83 has no
 * divide; treat every / and % in a loop as a red flag). */
static uint8_t tile_pal(uint8_t t) {
  if (t == T_GRASS) return PAL_GRASS;
  if (t == T_DIRT)  return PAL_DIRT;
  if (t == T_PLAT)  return PAL_PLAT;
  return PAL_SKY;                              /* sky + clouds */
}

static void paint_scene(uint8_t with_plats) {
  uint8_t r, c, t, g;
  uint8_t cl, clr = 0;
  uint16_t off;
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
        t = T_DIRT;                            /* pit walls below the playfield */
      }
      if (t == T_SKY && r >= 2 && r <= 6 && cl == 0) t = T_CLOUD;
      off = (uint16_t)r * 32 + c;
      VBK = 0; VRAM[off] = t;
      VBK = 1; VRAM[off] = tile_pal(t);
      VBK = 0;
      cl += 5; if (cl >= 13) cl -= 13;
    }
    clr += 7; if (clr >= 13) clr -= 13;
  }
}

static void paint_title(void) {
  paint_scene(0);                              /* plain scene — text owns the sky */
  draw_text((uint8_t)((20 - (sizeof(GAME_TITLE) - 1)) / 2), 3, GAME_TITLE);
  draw_text(4, 6, "PRESS START");
  draw_text(6, 8, "HI");
  {
    uint8_t d[5], i;
    u16_to_tiles(hiscore, d);
    for (i = 0; i < 5; i++) set_cell((uint8_t)(9 + i), 8, d[i], PAL_HUD);
  }
  draw_text(6, 11, "1P ONLY");                 /* see header: no link 2P */
  SCX = 0; SCY = 0;
  scroll_x = 0;
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
 * LCD-off repaints. Bulk VRAM rewrites (full title/level repaints) happen
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
    paint_scene(1);
    paint_hud();
    LCDC = LCDC_PLAY;           /* window ON below WY — the HUD appears */
  }
}

/* ── GAME LOGIC (clay) — sound: frame-ticked tune + jump/coin/death SFX ───────
 * Channel plan keeps SFX from cutting the music: ch2 = music (one
 * sound_play_tone trigger per note, the APU sustains it), ch1 = jump and
 * coin blips, ch4 = noise for deaths. music_tick() runs once per frame from
 * the main loop; the APU needs no other upkeep. Periods are the 11-bit GB
 * frequency code: 2048 - (131072 / Hz). 0 = rest. SELECT toggles it. */
static const uint16_t tune[16] = {
  1714, 0, 1750, 0, 1783, 0, 1798, 0,     /* G4 A4 B4 C5 */
  1825, 0, 1798, 0, 1783, 0, 1750, 0,     /* D5 C5 B4 A4 */
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

/* ── GAME LOGIC (clay) — coins + spikes (sprite objects in the world) ─────────
 * Both live in SCREEN coords and drift left with the scroll delta (world-
 * anchored while visible). Coins respawn at the right edge at a random
 * height; spikes only spawn when the level column entering at the right edge
 * has ground under it (never floating over a pit). */
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

/* ── GAME LOGIC (clay) — landing probe against the column map ──────────────────
 * One-way platforms, classic style: only catch the player while FALLING
 * through a narrow window at the surface. The window is 6 px tall — top-1
 * (the standing snap parks feet at top, and gravity's sub-pixel trickle
 * doesn't move the integer Y every frame; without the -1 slack the player
 * "stands" with on_ground=0 most frames, so jumps only register on lucky
 * frames and the idle/jump sprite flickers) through top+4 (so a 5 px/frame
 * terminal-velocity fall can't step over it). */
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
  hud_dirty = 1;          /* restage hud digits — a stale game-over stage
                           * queued before the repaint would overwrite the
                           * fresh zeros next vblank otherwise */
  begin_life();
  state = ST_PLAY;
  repaint_with_lcd_off(0);
  sound_play_tone(1, 1798, 8);             /* start jingle (C5) */
}

static void game_over(void) {
  /* Compare against the SAVED record, not the live `hiscore` readout — the
   * scoring path already raised `hiscore` to track the run, so testing
   * `score > hiscore` here would never fire. */
  if (score > record) {
    record = score;
    hiscore_save(record);       /* battery write — survives power-off */
  }
  state = ST_OVER;
  /* The BG has scrolled: map col 0 is no longer screen col 0. Anchor the
   * text relative to the CURRENT scroll so it lands mid-screen. Pre-convert
   * the strings to tile indices HERE (full-frame time) into msg_q — the
   * vblank commit is then a DUMB byte copy. char_tile's per-char compare
   * chain is exactly the work that blows the ~1140-cycle vblank budget; doing
   * it inside the commit dropped the middle of the 11-char PRESS START line
   * (verified). Stage out here, copy in there. */
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

/* ── GAME LOGIC (clay) — stage the shadow OAM for THIS frame ──────────────────
 * Pure WRAM writes (shadow_oam at $C100) — safe any time; only the DMA flush
 * is vblank-sensitive. OAM coords are hardware coords: +16 on Y, +8 on X.
 * A sprite's CGB palette = OAM attr bits 0-2 — that's the whole "color this
 * sprite" story. Slot plan (40 hardware slots, we use 6): 0 = player,
 * 1-3 coins, 4-5 spikes — well under the 10-OBJ/line hardware drop. */
static void stage_sprites(void) {
  uint8_t i, y8;
  oam_clear();
  if (state == ST_TITLE) {
    /* Guaranteed-visible sprite from the first title frame — proof the OAM
     * pipeline (shadow → HRAM DMA stub → OAM) is alive before any gameplay
     * complicates the picture. */
    oam_set(0, 96 + 16, 76 + 8, T_PLAYER, OPAL_PLAYER);
    return;
  }
  y8 = (uint8_t)(py_q44 >> 4);
  if (respawn_pause == 0 || (respawn_pause & 4))     /* ready-blink */
    oam_set(0, (uint8_t)(y8 + 16), (uint8_t)(px + 8),
            on_ground ? T_PLAYER : T_JUMP, OPAL_PLAYER);
  for (i = 0; i < NUM_COINS; i++)
    oam_set((uint8_t)(1 + i), (uint8_t)(coin_y[i] + 16),
            (uint8_t)(coin_x[i] + 8), T_COIN, OPAL_COIN);
  for (i = 0; i < NUM_SPIKES; i++)
    if (spike_active[i])
      oam_set((uint8_t)(4 + i), SPIKE_Y + 16,
              (uint8_t)(spike_x[i] + 8), T_SPIKE, OPAL_SPIKE);
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
 * tail writes (the lives digit at col 19 vanished — verified). The fix: the
 * window HUD cells' bank-1 ATTRIBUTE bytes are constant PAL_HUD (painted once
 * by paint_hud at LCD-off and never changed), so the per-frame commit only
 * needs to rewrite bank-0 TILE bytes. We set VBK=0 ONCE and pointer-walk the
 * digit cells — a tight write that fits vblank with room to spare. (Pointer
 * walk, not map[i] indexing — the SDCC VRAM footgun.) */
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
 * toggling. We DELIBERATELY leave the cells' bank-1 attribute alone: the scene
 * painted them PAL_SKY, whose colour-3 (the font ink value) is white — so the
 * text reads white-on-sky with ZERO attribute writes. That halves the vblank
 * cost: an 11-char line as tile+attr pairs overran mode 3 and dropped its
 * middle (verified); tile-only fits with room to spare. col wraps at the
 * 32-col map seam (the text is scroll-anchored, so it can straddle the wrap). */
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
    commit_bg_text(5, msg_col, msg_q, 9);
    return;
  }
  if (msg_stage == 1) {                       /* item 3: PRESS START line */
    msg_stage = 0;
    commit_bg_text(7, (uint8_t)((msg_col + 31) & 31), msg_q + 9, 11);
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

  load_bg_palettes();           /* the CGB BG palettes — sky/grass/dirt/... */
  load_obj_palettes();          /* player / coin / spike OBJ palettes      */

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
     *     inside vblank; pushing it later (after VRAM writes that grow over
     *     time) slides it into active display, where the PPU is reading OAM
     *     = one frame of torn/invisible sprites, intermittent and miserable
     *     to debug.
     *   commit_vram() second — the few queued HUD/map bytes (one item/frame).
     *   SCX last — scroll latches per-scanline, so writing it during vblank
     *     (before line 0 renders) moves the WHOLE next frame consistently;
     *     the window ignores it by design (the HUD idiom).
     * Game logic above NEVER touches VRAM directly — it sets the dirty flags
     * and shadow OAM, and this slice commits them. Keep that split. */
    wait_vblank();
    oam_dma_flush();
    commit_vram();
    SCX = scroll_x;             /* title resets scroll_x to 0; over freezes it */
    music_tick();
  }
}
