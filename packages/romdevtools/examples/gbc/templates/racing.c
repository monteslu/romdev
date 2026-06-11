/* ── racing.c — TWILIGHT LANE: Game Boy Color top-down road racer (complete example game) ──
 *
 * A COMPLETE, working game — title screen, a vertically-scrolling road (the
 * real thing — BG scroll via SCY, not falling sprites), streamed roadside
 * scenery through the vblank queue, lane-steered car, overtaking traffic,
 * crash/lives rules, persistent best DISTANCE (MBC1+RAM+BATTERY cart RAM),
 * GB APU music + SFX, and the Game Boy's signature WINDOW-LAYER fixed HUD the
 * scrolling road slides beneath — and the GBC's signature feature on top of
 * all of it: TRUE per-tile color. The dusk-lit road, its lane markings, the
 * grass shoulders and the roadside trees are FIVE REAL CGB palettes (15-bit
 * BGR, loaded through BCPS/BCPD), assigned per BG cell through the VRAM bank-1
 * attribute map; the player car and the traffic are their own OBJ palettes
 * through OCPS — not a colorized monochrome game.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented GB/GBC footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — traffic patterns, speeds, tuning, art: reshape freely.
 *
 * SINGLE-PLAYER, honestly: the Game Boy's "player 2" is a LINK CABLE, which
 * one emulator instance cannot provide — so handheld examples ship a
 * press-start title and no 2P mode instead of faking one. (The console racing
 * examples have real split-lane 2P; the handheld is an honest 1P endless run.)
 *
 * What depends on what:
 *   gb_hardware.h — register names (LCDC/WX/WY/SCY/VBK/BCPS/NRxx/...) + masks.
 *   gb_runtime.{h,c} — vblank wait (HALT-driven), joypad, shadow OAM + the
 *     OAM-DMA-from-HRAM routine, VRAM-safe memcpy, APU helpers (shared GB).
 *   gb_crt0.s — boot + interrupt vectors + the cartridge header window. It
 *     DECLARES the cart as MBC1+RAM+BATTERY ($0147=$03, $0149=$02): that
 *     header is what makes the SRAM best-distance persist (the GB equivalent
 *     of the NES BATTERY bit). Load-bearing; edit with TROUBLESHOOTING open.
 *   font.h — 0-9 A-Z 2bpp glyphs for all text.
 *
 * THE DESIGN (read before reshaping):
 *   Scrolling — the road is the BACKGROUND, scrolled down by INCREASING SCY
 *     each frame (raising SCY slides the BG map up under the screen = the
 *     road rushes DOWN toward the player). Cars/traffic are sprites with
 *     their own screen Y. See the SCY-WRAP idiom below: the GB BG map is 256
 *     px tall and SCY is a plain uint8 that wraps at 256 — which lines up
 *     EXACTLY with one 32-row map loop, so the road tiles a seamless ribbon
 *     with no wrap helper at all. (Contrast: NES vertical scroll wraps at
 *     240 not 256 — values 240-255 fetch attribute bytes as garbage tiles,
 *     so the NES racing game needs a wrap helper; SMS wraps at 224 the same
 *     way; the Genesis plane is a full 256 and masks in hardware. The GB's
 *     uint8-SCY-into-256px-map is the friendliest of the four.) The COLOR
 *     travels with the tiles: each cell's bank-1 attribute byte scrolls along
 *     with its tile, so a grass cell stays green wherever it slides on screen.
 *   HUD — the WINDOW layer: a fixed strip the scrolling road can't move (see
 *     the window idiom). The platformer/shmup templates scroll the world under
 *     this same HUD on the OTHER axis (SCX); this game scrolls SCY.
 *   1P RACE — four lanes, A/UP accelerate, B/DOWN brake (speed 1-4); LEFT/
 *     RIGHT tilt the car between lanes. 3 crashes end the run. Persistent
 *     stat: best DISTANCE (uint16, 1 unit = 16 scrolled px ≈ one car length)
 *     via best_load/save to battery SRAM.
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
#define GAME_TITLE "TWILIGHT LANE"

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile inventory. GB/GBC tiles are 16 bytes: 8 rows × [low-plane byte,
 * high-plane byte]. Pixel colour index = (hi_bit << 1) | lo_bit (0..3); on
 * CGB that index selects a colour WITHIN whichever CGB palette the cell's
 * bank-1 attribute (BG) or the sprite's OAM attr (OBJ) chose. So one grass
 * tile reads green or any other palette purely by its attribute byte. */
static const uint8_t tile_blank[16] = { 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0 };
static const uint8_t tile_car[16] = {            /* player car, nose up    */
    0x18,0x00, 0x7E,0x18, 0xFF,0x3C, 0xDB,0x00,
    0xFF,0x3C, 0xFF,0x00, 0x7E,0x18, 0x66,0x00,
};
static const uint8_t tile_traffic[16] = {        /* rival car, tail up      */
    0x66,0x00, 0x7E,0x18, 0xFF,0x00, 0xFF,0x3C,
    0xDB,0x00, 0xFF,0x3C, 0x7E,0x18, 0x18,0x00,
};
/* Road-surface tiles. tile_road carries two value-1 specks so even bare
 * asphalt is never one flat colour (the render-health floor every example
 * keeps) and the specks make the vertical scroll motion visible everywhere. */
static const uint8_t tile_road[16] = {           /* asphalt + faint specks  */
    0x00,0xFF, 0x20,0xDF, 0x00,0xFF, 0x00,0xFF,
    0x00,0xFF, 0x04,0xFB, 0x00,0xFF, 0x00,0xFF,
};
static const uint8_t tile_edge[16] = {           /* solid shoulder line v3  */
    0x18,0x18, 0x18,0x18, 0x18,0x18, 0x18,0x18,
    0x18,0x18, 0x18,0x18, 0x18,0x18, 0x18,0x18,
};
static const uint8_t tile_dash[16] = {           /* lane dash: 4 on 4 off   */
    0x18,0x18, 0x18,0x18, 0x18,0x18, 0x18,0x18,
    0x00,0x00, 0x00,0x00, 0x00,0x00, 0x00,0x00,
};
static const uint8_t tile_grass[16] = {          /* roadside hatch v3 / v2  */
    0xFF,0xFF, 0xBB,0xFF, 0xFF,0xFF, 0xEE,0xFF,
    0xFF,0xFF, 0xBB,0xFF, 0xFF,0xFF, 0xEE,0xFF,
};
static const uint8_t tile_tree[16] = {           /* roadside bush v3 over v2*/
    0x18,0xFF, 0x3C,0xFF, 0x7E,0xFF, 0x7E,0xFF,
    0x3C,0xFF, 0x18,0xFF, 0x18,0xFF, 0x00,0xFF,
};
static const uint8_t tile_hudbar[16] = {         /* solid value-3 divider   */
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
};

/* Tile indices ($8000 unsigned addressing — LCDC bit 4 set below). Sprites
 * and BG share the $8000 table in this layout, so one upload serves both.
 * Font glyphs follow at FONT_BASE (digits 0-9, then A-Z). */
#define T_BLANK   0
#define T_CAR     1
#define T_TRAFFIC 2
#define T_ROAD    3
#define T_EDGE    4
#define T_DASH    5
#define T_GRASS   6
#define T_TREE    7
#define T_HUDBAR  8
#define FONT_BASE 16     /* digit d = 16+d, letter L = 16+10+idx (see font.h) */

/* ── GAME LOGIC (clay — reshape freely) ── the CGB palette TABLE (the colours
 * themselves are art; the LOADER below is the hardware idiom).
 * 15-bit BGR: 5 bits each, blue in the high bits — RGB() packs it. Colour 0
 * of a BG palette is the cell's "background" shade; for OBJ palettes colour 0
 * is transparent (the scene shows through).
 *
 * TWILIGHT LANE leans into the GBC's colour: a warm dusk-lit highway. The road
 * is a violet-grey asphalt, the lane markings glow amber, the shoulders are a
 * deep evening green and the trees a cooler pine — genuinely DIFFERENT HUES,
 * not four shades of one grey, so a wide hue census sees several distinct
 * colours (the proof the cart is doing per-tile CGB colour, not DMG). */
#define RGB(r,g,b) ((uint16_t)(((uint16_t)(b)<<10)|((uint16_t)(g)<<5)|(r)))

/* BG palette slots (bank-1 attribute byte bits 0-2 select one of these). */
#define PAL_ROAD  0      /* dusk asphalt + amber lane markings */
#define PAL_GRASS 1      /* evening-green shoulder             */
#define PAL_TREE  2      /* cooler pine roadside trees         */
#define PAL_EDGE  3      /* glowing shoulder + divider lines   */
#define PAL_HUD   4      /* HUD bar + all text                 */

static const uint16_t bg_palettes[8][4] = {
    /* 0 road  */ { RGB(11,4,16),  RGB(18,7,24),  RGB(8,3,12),   RGB(31,24,4)  },
    /* 1 grass */ { RGB(4,13,5),   RGB(7,22,8),   RGB(3,10,4),   RGB(13,28,10) },
    /* 2 tree  */ { RGB(2,9,7),    RGB(4,18,14),  RGB(1,6,5),    RGB(8,24,18)  },
    /* 3 edge  */ { RGB(11,4,16),  RGB(18,7,24),  RGB(8,3,12),   RGB(6,28,31)  },
    /* 4 hud   */ { RGB(2,2,6),    RGB(8,9,16),   RGB(2,2,6),    RGB(31,31,31) },
    /* 5 spare */ { RGB(0,0,0),    RGB(10,10,10), RGB(20,20,20), RGB(31,31,31) },
    /* 6 spare */ { RGB(0,0,0),    RGB(10,10,10), RGB(20,20,20), RGB(31,31,31) },
    /* 7 spare */ { RGB(0,0,0),    RGB(10,10,10), RGB(20,20,20), RGB(31,31,31) },
};

/* OBJ palette slots (OAM attr bits 0-2 select one of these). Colour 0 is
 * always transparent. */
#define OPAL_CAR     0   /* the player's cyan racer       */
#define OPAL_TRAFFIC 1   /* danger-red rival traffic      */

static const uint16_t obj_palettes[8][4] = {
    /* 0 car     */ { 0, RGB(8,28,31),  RGB(2,16,28),  RGB(28,31,31) },
    /* 1 traffic */ { 0, RGB(31,8,8),   RGB(20,2,2),   RGB(31,24,16) },
    /* 2 spare   */ { 0, RGB(20,20,20), RGB(31,31,31), RGB(10,10,10) },
    /* 3 spare   */ { 0, RGB(20,20,20), RGB(31,31,31), RGB(10,10,10) },
    /* 4 spare   */ { 0, RGB(20,20,20), RGB(31,31,31), RGB(10,10,10) },
    /* 5 spare   */ { 0, RGB(20,20,20), RGB(31,31,31), RGB(10,10,10) },
    /* 6 spare   */ { 0, RGB(20,20,20), RGB(31,31,31), RGB(10,10,10) },
    /* 7 spare   */ { 0, RGB(20,20,20), RGB(31,31,31), RGB(10,10,10) },
};

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * THE WINDOW-LAYER HUD — the Game Boy's signature "fixed HUD over a
 * scrolling world" technique. The window is a second BG plane with its own
 * 32×32 tile map and NO scroll registers: it always draws its map from
 * (0,0), pinned to the screen, on top of the BG. So the HUD lives in the
 * window and the road lives in the BG — SCY scrolls the world all it likes
 * and the HUD never moves. No raster splits, no IRQ timing (the NES needs a
 * sprite-0 polling dance for this exact effect; on GB it's three register
 * writes). This game scrolls SCY (vertical road); the platformer scrolls SCX —
 * same idiom, either axis. On CGB the window cells take bank-1 palette
 * attributes exactly like the BG (set_wcell writes both banks).
 *
 * The three registers, and their two famous footguns:
 *   WY ($FF4A) — first screen LINE the window covers. We use 128: lines
 *     0-127 are road, 128-143 (two tile rows) are the HUD strip.
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
 * sprite below line 128 sits ON the HUD. The car sits at fixed CAR_Y and
 * traffic despawns before PLAY_H, so no object ever touches the HUD rows.
 *
 * Requires: window map at $9C00 (LCDC bit 6), tile data at $8000 (bit 4),
 * WX=7, WY=PLAY_H, LCDC bit 5 set during play (title turns the window off). */
#define PLAY_H   128                       /* first HUD line = window top */
#define LCDC_TITLE (LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO)
#define LCDC_PLAY  (LCDC_TITLE | LCDC_WINDOW_ON | LCDC_WINDOW_MAP_HI)

#define VRAM ((volatile uint8_t *)0x9800)  /* BG map $9800 base */
#define WIN_OFF   0x400                    /* window map $9C00 = $9800 + $400 */

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * BATTERY SRAM — persistent best distance. MBC1 cart RAM is 8KB at
 * $A000-$BFFF, but it boots DISABLED and writes to a disabled bank are
 * silently discarded (reads float). The gate is the MBC's RAM-enable
 * register: any WRITE to ROM space $0000-$1FFF with $0A in the low nibble
 * enables the RAM; writing $00 disables it again. (Writing "into ROM" feels
 * wrong the first time — ROM-area writes never touch ROM, they talk to the
 * mapper chip.) Leaving RAM enabled all the time "works" in emulators but on
 * real hardware risks corruption at power-off — battery carts since forever
 * do enable → touch → disable, so we do too.
 *
 * First boot is GARBAGE, not zeros: battery RAM holds whatever the silicon
 * woke up with. The magic 'B','D' + checksum is how the load path tells "my
 * save" from "factory noise" — without it a fresh cart shows a junk best.
 *
 * Save block at $A000: 'B' 'D'  lo hi  (lo^hi^$A5)
 *
 * Requires: gb_crt0.s declaring $0147=$03 (MBC1+RAM+BATTERY) + $0149=$02
 * (8KB) — those header bytes are how the emulator knows to allocate and
 * persist SAVE_RAM. Verify headlessly: race, crash out, then
 * memory({op:'read', region:'save_ram'}) shows the block, and the best
 * survives host.hardReset(). */
#define MBC_RAM_ENABLE  (*(volatile uint8_t *)0x0000)
#define SRAM            ((volatile uint8_t *)0xA000)

static uint16_t best_load(void) {
  uint16_t v = 0;
  MBC_RAM_ENABLE = 0x0A;                        /* unlock cart RAM */
  if (SRAM[0] == 'B' && SRAM[1] == 'D' &&
      SRAM[4] == (uint8_t)(SRAM[2] ^ SRAM[3] ^ 0xA5)) {
    v = (uint16_t)(SRAM[2] | ((uint16_t)SRAM[3] << 8));
  }
  MBC_RAM_ENABLE = 0x00;                        /* re-lock (battery hygiene) */
  return v;
}

static void best_save(uint16_t v) {
  uint8_t lo = (uint8_t)(v & 0xFF), hi = (uint8_t)(v >> 8);
  MBC_RAM_ENABLE = 0x0A;
  SRAM[0] = 'B'; SRAM[1] = 'D';
  SRAM[2] = lo;  SRAM[3] = hi;
  SRAM[4] = (uint8_t)(lo ^ hi ^ 0xA5);
  MBC_RAM_ENABLE = 0x00;
}

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Road geometry. Four 4-px-wide lanes between shoulders, painted ONCE into
 * the BG map (cols below); the scroll moves them with the road for free. The
 * BG map is 32 cols; the visible 20 sit at cols 0..19 (SCX stays 0).
 *   col 1 = left shoulder, 6/14 = dashed lane lines, 10 = center divider,
 *   19 = right shoulder; grass/trees outside cols 1..19. */
#define COL_EDGE_L   1
#define COL_DASH_1   6
#define COL_DIVIDER  10
#define COL_DASH_2   14
#define COL_EDGE_R   19
/* Lane centre screen X for the 8px car sprite (each lane spans ~32 px). */
static const uint8_t lane_x[4] = { 28, 60, 92, 124 };

#define NUM_TRAFFIC   6
#define CAR_Y        96        /* player's fixed screen Y (well above PLAY_H)  */
#define SPAWN_Y       8        /* traffic entry Y                              */
#define DESPAWN_Y    120       /* traffic gone before it reaches the HUD       */
#define START_LIVES   3        /* crashes per run                              */
#define SPAWN_PERIOD 36        /* frames between traffic spawns                */

static uint8_t  car_lane;            /* 0..3 */
static uint8_t  speed;               /* road px/frame, 1..4 */
static uint8_t  scy;                 /* BG scroll Y — uint8 wraps at 256 =     *
                                      * exactly one 32-row map loop (seamless) */
static uint16_t dist;                /* 1 unit = 16 scrolled px ≈ one car len  */
static uint8_t  dist_frac;
static uint16_t best;                /* live HUD readout: max(dist, record)    */
static uint16_t record;              /* what the battery SRAM actually holds   */
static uint8_t  lives;
static uint8_t  invuln;              /* post-crash blink + no-collide frames   */
static uint8_t  prev_pad;
static uint8_t  spawn_timer;
static uint8_t  prev_top_row;        /* last streamed BG-map row               */
static uint8_t  hud_dirty;           /* queue VRAM writes; vblank commits them */
static uint8_t  msg_stage;           /* game-over text: 2 = line 1, 1 = line 2 */

static uint8_t  traffic_active[NUM_TRAFFIC];
static uint8_t  traffic_lane[NUM_TRAFFIC];
static uint8_t  traffic_y[NUM_TRAFFIC];

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

/* ── GAME LOGIC (clay) — screen painters (LCD off = free VRAM access) ────────
 * Paint the road into the FULL 32-row BG map. Because SCY wraps at 256 (one
 * full map height), the visible window can sit anywhere in the map and always
 * shows a valid road ribbon — so we paint all 32 rows, not just the visible
 * 18, and the scroll loops forever with no wrap helper. For EACH cell we write
 * the tile (bank 0) AND its palette attribute (bank 1) — that pairing is the
 * whole CGB colour story. The dashed lane lines alternate per row (drawn on
 * even rows only); the scroll animates them for free. Roadside trees use a
 * divide-free running pattern counter (the sm83 has no divide — treat every /
 * and % in a loop as a red flag, ~700 cycles each). */
static void paint_road(void) {
  uint8_t r, c, t, pal;
  uint8_t tc, tr = 0;                    /* (r*7 + c*5) mod 13, incremental */
  uint16_t off;
  for (r = 0; r < 32; r++) {
    tc = tr;
    for (c = 0; c < 32; c++) {
      if (c < COL_EDGE_L || c > COL_EDGE_R) {
        t = T_GRASS; pal = PAL_GRASS;
        if (tc == 0) { t = T_TREE; pal = PAL_TREE; }   /* sparse roadside */
      } else if (c == COL_EDGE_L || c == COL_EDGE_R || c == COL_DIVIDER) {
        t = T_EDGE; pal = PAL_EDGE;       /* shoulders + solid centre line */
      } else if (c == COL_DASH_1 || c == COL_DASH_2) {
        t = (r & 1) ? T_ROAD : T_DASH;    /* dashed lane lines */
        pal = PAL_ROAD;
      } else {
        t = T_ROAD; pal = PAL_ROAD;       /* asphalt */
      }
      off = (uint16_t)r * 32 + c;
      VBK = 0; VRAM[off] = t;
      VBK = 1; VRAM[off] = pal;
      VBK = 0;
      tc += 5; if (tc >= 13) tc -= 13;
    }
    tr += 7; if (tr >= 13) tr -= 13;
  }
}

static void paint_title(void) {
  paint_road();                           /* road backdrop — text owns lanes */
  draw_text((uint8_t)((20 - (sizeof(GAME_TITLE) - 1)) / 2), 3, GAME_TITLE);
  draw_text(5, 6, "PRESS START");
  draw_text(6, 9, "BEST");
  {
    uint8_t d[5], i;
    u16_to_tiles(best, d);
    for (i = 0; i < 5; i++) set_cell((uint8_t)(11 + i), 9, d[i], PAL_HUD);
  }
  draw_text(6, 12, "1P ONLY");                 /* see header: no link 2P */
  SCX = 0; SCY = 0;
  scy = 0;
}

/* HUD strip = window rows 0-1: a solid divider bar, then the text row.
 * Columns 0-19 are the visible 20 (WX=7 pins map col 0 to screen x 0). */
static void paint_hud(void) {
  uint8_t c, d[5], i;
  for (c = 0; c < 20; c++) set_wcell(c, 0, T_HUDBAR, PAL_HUD);
  for (c = 0; c < 20; c++) set_wcell(c, 1, T_BLANK, PAL_HUD);
  draw_wtext(0, 1, "DS");
  u16_to_tiles(dist, d);
  for (i = 0; i < 5; i++) set_wcell((uint8_t)(3 + i), 1, d[i], PAL_HUD);
  draw_wtext(9, 1, "BS");
  u16_to_tiles(best, d);
  for (i = 0; i < 5; i++) set_wcell((uint8_t)(12 + i), 1, d[i], PAL_HUD);
  draw_wtext(18, 1, "L");
  set_wcell(19, 1, (uint8_t)(FONT_BASE + lives), PAL_HUD);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * LCD-off repaints. Bulk VRAM rewrites (full title/road repaints) happen
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
    paint_road();
    paint_hud();
    LCDC = LCDC_PLAY;           /* window ON below WY — the HUD appears */
  }
}

/* ── GAME LOGIC (clay) — sound: frame-ticked tune + steer/crash SFX ──────────
 * Channel plan keeps SFX from cutting the music: ch2 = music (one
 * sound_play_tone trigger per note, the APU sustains it), ch1 = engine/
 * steer/checkpoint blips, ch4 = noise for crashes. music_tick() runs once
 * per frame from the main loop; the APU needs no other upkeep. Periods are
 * the 11-bit GB frequency code: 2048 - (131072 / Hz). 0 = rest. SELECT
 * toggles it. */
static const uint16_t tune[16] = {
  1602, 0, 1602, 1714, 1750, 0, 1714, 0,     /* an engine-y ostinato */
  1602, 0, 1602, 1798, 1750, 0, 1602, 0,
};
static uint8_t music_on = 1, music_pos, music_timer;
static void music_tick(void) {
  uint16_t n;
  if (!music_on) return;
  if (++music_timer < 12) return;
  music_timer = 0;
  n = tune[music_pos];
  music_pos = (uint8_t)((music_pos + 1) & 15);
  if (n) sound_play_tone(2, n, 10);
}
static void music_toggle(void) {
  music_on = (uint8_t)(!music_on);
  if (!music_on) { NR21 = 0x00; NR22 = 0x00; NR24 = 0x80; }   /* silence ch2 */
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Streamed roadside through the VRAM commit QUEUE. As the road scrolls down
 * (SCY rising), BG-map rows re-enter at the TOP of the screen. The moment a
 * new top row appears we restamp its two roadside columns (grass/tree) with
 * fresh random tiles, so the wrap never shows the same 256-px loop twice.
 * Classic streaming-row technique, downward. On CGB we restamp the bank-0
 * tile AND its bank-1 palette attribute as a pair (a grass tile must read
 * PAL_GRASS, a tree PAL_TREE — else the new tile inherits whatever palette
 * the seam row last carried and the colour flickers).
 *
 * Two hard rules, mirroring the platformer/shmup VRAM discipline:
 *   1. QUEUED through commit_vram() (one item per vblank) — a raw mid-frame
 *      write that slides past vblank into mode 3 is silently dropped by the
 *      core (the shmup harness caught exactly that as half-missing text).
 *   2. The restamped row is two rows ABOVE the visible band (about to scroll
 *      on), so the swap lands before the player sees it.
 * road_dirty carries the row index to restamp; commit_vram() drains it. */
static uint8_t road_dirty;       /* 1 = a roadside row restamp is queued */
static uint8_t road_row;         /* BG-map row to restamp */
static uint8_t road_lt, road_rt; /* the two roadside tiles (left, right col) */
static uint8_t road_lp, road_rp; /* their palettes (PAL_GRASS / PAL_TREE)   */

static void roadside_pick(uint8_t *tile, uint8_t *pal) {
  if ((rand8() & 7) == 0) { *tile = T_TREE;  *pal = PAL_TREE;  }
  else                    { *tile = T_GRASS; *pal = PAL_GRASS; }
}

static void queue_roadside(uint8_t top_row) {
  /* Restamp the row two above the screen top (about to scroll in). */
  road_row = (uint8_t)((top_row + 30) & 31);
  roadside_pick(&road_lt, &road_lp);
  roadside_pick(&road_rt, &road_rp);
  road_dirty = 1;
}

/* ── GAME LOGIC (clay) — traffic pool (fixed slots, no allocation) ── */
static void spawn_traffic(void) {
  uint8_t i;
  for (i = 0; i < NUM_TRAFFIC; i++) {
    if (!traffic_active[i]) {
      traffic_active[i] = 1;
      traffic_lane[i] = (uint8_t)(rand8() & 3);
      traffic_y[i] = SPAWN_Y;
      return;
    }
  }
}

/* ── GAME LOGIC (clay) — state transitions ── */
static void begin_run(void) {
  uint8_t i;
  car_lane = 1;
  speed = 1;
  scy = 0;
  dist = 0;
  dist_frac = 0;
  prev_top_row = 0;
  spawn_timer = 0;
  invuln = 48;                   /* ready breather — car blinks */
  prev_pad = 0xFF;               /* swallow held buttons across the reset */
  for (i = 0; i < NUM_TRAFFIC; i++) traffic_active[i] = 0;
}

static void start_game(void) {
  lives = START_LIVES;
  begin_run();
  hud_dirty = 1;          /* restage hud_q — a stale game-over stage queued
                           * before the repaint would overwrite the fresh
                           * zeros next vblank otherwise */
  state = ST_PLAY;
  repaint_with_lcd_off(0);
  sound_play_tone(1, 1602, 8);             /* start rev */
}

static void game_over(void) {
  /* Compare against the SAVED record, not the live `best` readout — the
   * scoring path already raised `best` to track the run, so testing
   * `dist > best` here would never fire (the shmup example shipped exactly
   * that bug for an hour; verified-by-harness is the cure). */
  if (dist > record) {
    record = dist;
    best_save(record);          /* battery write — survives power-off */
  }
  state = ST_OVER;
  /* The BG scrolled vertically, but the game-over text is painted into fixed
   * BG rows (columns don't shift on a vertical scroll), so a plain row/col
   * anchor lands mid-screen. Convert the strings to tile indices HERE
   * (full-frame time) and queue them — commit_vram() copies one line per
   * vblank. We deliberately leave the cells' bank-1 attribute alone: the road
   * painted them PAL_ROAD, whose colour-3 (the font ink value) is amber, so
   * the text reads amber-on-asphalt with ZERO attribute writes (halves the
   * vblank cost — char_tile + attr pairs overran mode 3 on the GB original). */
  stage_text("GAME OVER", msg_q);
  stage_text("PRESS START", msg_q + 9);
  msg_stage = 2;
}

static void crash(void) {
  sound_play_noise(20);
  invuln = 60;                   /* blink + no-collide grace */
  speed = 1;                     /* a wreck kills your momentum */
  if (lives) --lives;
  hud_dirty = 1;
  if (lives == 0) game_over();
}

/* ── GAME LOGIC (clay) — per-state update (runs OUTSIDE vblank) ── */
static void update_play(uint8_t pad) {
  uint8_t i, pressed, ty;

  pressed = (uint8_t)(pad & ~prev_pad);

  /* Steer: LEFT/RIGHT tilt one lane (edge-detected — a held d-pad must not
   * machine-gun across the road). */
  if ((pressed & PAD_LEFT) && car_lane > 0) {
    --car_lane;
    sound_play_tone(1, 1750, 3);                     /* tilt tick */
  }
  if ((pressed & PAD_RIGHT) && car_lane < 3) {
    ++car_lane;
    sound_play_tone(1, 1750, 3);
  }
  /* Throttle: A/UP accelerate, B/DOWN brake. */
  if ((pressed & (PAD_A | PAD_UP)) && speed < 4) {
    ++speed;
    sound_play_tone(1, (uint16_t)(1500 + speed * 40), 6);   /* engine up */
  }
  if ((pressed & (PAD_B | PAD_DOWN)) && speed > 1) {
    --speed;
    sound_play_tone(1, 1850, 4);                     /* brake blip */
  }
  if (invuln) --invuln;

  /* Scroll the road down: SCY increases (BG slides up under the screen).
   * Plain uint8 — wraps at 256 = one full map loop, seamless (see idiom). */
  scy = (uint8_t)(scy + speed);

  /* Distance: 1 unit per 16 scrolled px. A chime every 256 units. */
  dist_frac = (uint8_t)(dist_frac + speed);
  if (dist_frac >= 16) {
    dist_frac -= 16;
    if (dist < 65535u) ++dist;
    if (dist > best) best = dist;                    /* live HUD readout */
    hud_dirty = 1;
    if (dist != 0 && (dist & 0xFF) == 0)
      sound_play_tone(1, 1923, 8);                   /* checkpoint chime */
  }

  /* Traffic flows DOWN at road speed (reads as slower cars you overtake);
   * despawn before the HUD band, spawn on a timer. */
  for (i = 0; i < NUM_TRAFFIC; i++) {
    if (!traffic_active[i]) continue;
    ty = (uint8_t)(traffic_y[i] + speed);
    if (ty >= DESPAWN_Y) { traffic_active[i] = 0; continue; }
    traffic_y[i] = ty;
  }
  if (++spawn_timer >= SPAWN_PERIOD) {
    spawn_timer = 0;
    spawn_traffic();
  }

  /* Traffic ↔ car (AABB, both 8x8). Crash grace: a just-wrecked car blinks
   * and can't collide for 60 frames. */
  if (!invuln) {
    for (i = 0; i < NUM_TRAFFIC; i++) {
      if (!traffic_active[i]) continue;
      if (dist8(lane_x[traffic_lane[i]], lane_x[car_lane]) < 8 &&
          dist8(traffic_y[i], CAR_Y) < 8) {
        traffic_active[i] = 0;
        crash();
        return;
      }
    }
  }
}

/* ── GAME LOGIC (clay) — stage the shadow OAM for THIS frame ─────────────────
 * Pure WRAM writes (shadow_oam at $C100) — safe any time; only the DMA flush
 * is vblank-sensitive. OAM coords are hardware coords: +16 on Y, +8 on X. A
 * sprite's CGB palette = OAM attr bits 0-2 — that's the whole "color this
 * sprite" story. Slot plan (40 hardware slots, we use 7): 0 = player car,
 * 1-6 traffic — well under the 10-OBJ/line hardware drop. */
static void stage_sprites(void) {
  uint8_t i;
  oam_clear();
  if (state == ST_TITLE) {
    /* Guaranteed-visible sprite from the first title frame — proof the whole
     * OAM pipeline (shadow → HRAM DMA stub → OAM) is alive before any
     * gameplay complicates the picture. */
    oam_set(0, 96 + 16, 76 + 8, T_CAR, OPAL_CAR);
    return;
  }
  if (invuln == 0 || (invuln & 4))                   /* crash/ready blink */
    oam_set(0, CAR_Y + 16, (uint8_t)(lane_x[car_lane] + 8), T_CAR, OPAL_CAR);
  for (i = 0; i < NUM_TRAFFIC; i++)
    if (traffic_active[i])
      oam_set((uint8_t)(1 + i), (uint8_t)(traffic_y[i] + 16),
              (uint8_t)(lane_x[traffic_lane[i]] + 8), T_TRAFFIC, OPAL_TRAFFIC);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Queued VRAM commits — and the bank-0-only HUD write. Two-phase update,
 * mirroring the shadow-OAM discipline: game logic only sets the dirty flags
 * (hud_dirty / road_dirty / msg_stage). stage_hud() (full-frame time) does the
 * digit math into hud_q; commit_vram() (vblank time) writes bytes — AT MOST
 * ONE queued item per vblank.
 *
 * THE CGB TWIST (load-bearing): a naive set_wcell() per HUD cell toggles VBK
 * twice + writes two banks PER cell — for 11 HUD cells that's ~33 VBK writes
 * in one vblank, which OVERRUNS the ~1140-cycle window and silently drops the
 * tail writes (the lives digit at col 19 vanished — verified on the GBC
 * platformer). The fix: the window HUD cells' bank-1 ATTRIBUTE bytes are
 * constant PAL_HUD (painted once by paint_hud at LCD-off and never changed),
 * so the per-frame commit only needs to rewrite bank-0 TILE bytes. We set
 * VBK=0 ONCE and pointer-walk the digit cells — a tight write that fits vblank
 * with room to spare. (Pointer walk, not map[i] indexing — the SDCC VRAM
 * footgun.)
 *
 * The roadside restamp + game-over text go the same way: pre-staged, written
 * one item per vblank. The roadside restamp DOES write both banks (a fresh
 * grass/tree tile needs its palette), but it's only two cells, well inside
 * budget; the game-over text leaves the bank-1 attribute alone (the road's
 * PAL_ROAD colour-3 is the amber ink). */
static uint8_t hud_q[11];       /* 5 dist digits, 5 best digits, lives tile */
static uint8_t hud_ready;
#define WIN_TILE ((volatile uint8_t *)0x9C00)   /* window map, bank 0 */

static void stage_hud(void) {
  if (!hud_dirty) return;
  hud_dirty = 0;
  u16_to_tiles(dist, hud_q);
  u16_to_tiles(best, hud_q + 5);
  hud_q[10] = (uint8_t)(FONT_BASE + lives);
  hud_ready = 1;
}

/* Write a pre-staged BG-map line (msg_q tiles) as a single BANK-0 tile copy —
 * a dumb byte walk, no char_tile work and no per-cell VBK toggling. */
static void commit_bg_text(uint8_t row, uint8_t col, const uint8_t *q, uint8_t len) {
  volatile uint8_t *p = VRAM + (uint16_t)row * 32 + col;
  VBK = 0;
  while (len--) *p++ = *q++;
}

static void commit_vram(void) {
  uint8_t i;
  if (hud_ready) {                            /* item 1: HUD digits (bank 0) */
    hud_ready = 0;
    VBK = 0;                                  /* attributes already PAL_HUD */
    for (i = 0; i < 5; i++) WIN_TILE[32 + 3 + i]  = hud_q[i];      /* dist  */
    for (i = 0; i < 5; i++) WIN_TILE[32 + 12 + i] = hud_q[5 + i];  /* best  */
    WIN_TILE[32 + 19] = hud_q[10];                                 /* lives */
    return;
  }
  if (road_dirty) {                           /* item 2: roadside row restamp */
    road_dirty = 0;
    {
      uint16_t off = (uint16_t)road_row * 32;
      VBK = 0; VRAM[off] = road_lt;           /* col 0 tile  (left roadside) */
      VBK = 1; VRAM[off] = road_lp;           /* col 0 palette               */
      VBK = 0; VRAM[off + 20] = road_rt;      /* col 20 tile (right roadside)*/
      VBK = 1; VRAM[off + 20] = road_rp;      /* col 20 palette              */
      VBK = 0;
    }
    return;
  }
  if (msg_stage == 2) {                        /* item 3: GAME OVER line */
    msg_stage = 1;
    commit_bg_text(5, 5, msg_q, 9);
    return;
  }
  if (msg_stage == 1) {                        /* item 4: PRESS START line */
    msg_stage = 0;
    commit_bg_text(7, 4, msg_q + 9, 11);
  }
}

void main(void) {
  uint8_t pad, top_row;

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

  upload_tile(T_BLANK,   tile_blank);
  upload_tile(T_CAR,     tile_car);
  upload_tile(T_TRAFFIC, tile_traffic);
  upload_tile(T_ROAD,    tile_road);
  upload_tile(T_EDGE,    tile_edge);
  upload_tile(T_DASH,    tile_dash);
  upload_tile(T_GRASS,   tile_grass);
  upload_tile(T_TREE,    tile_tree);
  upload_tile(T_HUDBAR,  tile_hudbar);
  upload_font();

  load_bg_palettes();           /* the CGB BG palettes — road/grass/tree/HUD */
  load_obj_palettes();          /* player car / traffic OBJ palettes         */

  /* Window position — set once; LCDC bit 5 decides if it shows. */
  WX = 7;                       /* the +7 quirk: 7 = screen left edge */
  WY = PLAY_H;                  /* HUD owns lines 128-143 */

  record = best_load();         /* battery SRAM — 0 on first boot */
  best = record;
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
      /* Stream a fresh roadside row as each new row scrolls on at the top. */
      top_row = (uint8_t)(scy >> 3);
      if (top_row != prev_top_row) {
        prev_top_row = top_row;
        if (!road_dirty) queue_roadside(top_row);
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
     *   commit_vram() second — the few queued HUD/roadside/text bytes (one
     *     item per frame).
     *   SCY last — scroll latches per-scanline, so writing it during vblank
     *     (before line 0 renders) moves the WHOLE next frame consistently;
     *     the window ignores it by design (the HUD idiom).
     * Game logic above NEVER touches VRAM directly — it sets the dirty flags
     * and shadow OAM, and this slice commits them. Keep that split. */
    wait_vblank();
    oam_dma_flush();
    commit_vram();
    SCY = scy;                  /* title resets scy to 0; over freezes it */
    music_tick();
  }
}
