/* ── racing.c — SMS top-down road racer (complete example game) ──────────────
 *
 * FENDER FURY — a COMPLETE, working game: title screen, 1P endless race with
 * speed control, 2P simultaneous SPLIT-LANE VERSUS (both cars on screen at
 * once — player 2 on PORT B), a vertically-scrolling road done the SMS way
 * (whole-plane R9 vertical scroll, latched once per frame), streamed roadside
 * scenery rows, crash/lives rules, persistent best DISTANCE (Sega-mapper cart
 * RAM — see the honesty note at best_save), PSG music + SFX, and the SMS's
 * signature LINE-INTERRUPT split holding a fixed HUD strip over the road.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented SMS footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — traffic patterns, speeds, tuning, art: reshape freely.
 *
 * What depends on what:
 *   sms_hw.h / vdp_init.c / load_tiles.c / load_palette.c / sprite_table.c /
 *     joypad_read.c — the bundled VDP + input runtime (this file's externs).
 *   sms_sfx.{h,c} + sms_music.{h,c} — SN76489 PSG sound layers.
 *   sms_crt0.s — boot + vector table. Its $0038 IM-1 handler is the OTHER
 *     HALF of the line-interrupt idiom below: one status-port read acks BOTH
 *     the frame and line IRQ flags, then ei/reti. Load-bearing; edit with
 *     TROUBLESHOOTING open.
 *
 * THE DESIGN (read before reshaping):
 *   Scrolling — the road is the BACKGROUND, scrolled DOWN by DECREMENTING the
 *     vertical-scroll register R9 each frame (the driving-up illusion). Cars
 *     and traffic are sprites with their own Y. Compare the Genesis version of
 *     this game (examples/genesis/templates/racing.c): there a single VSRAM
 *     value scrolls the whole plane and the VDP wraps it in hardware at 256.
 *     The SMS is the SAME idea — ONE register, whole-plane, single-plane — with
 *     two twists this file is built around: (1) R9 is LATCHED ONCE PER FRAME,
 *     not per scanline (so the road scrolls per-frame, never mid-frame — see
 *     the R9 idiom); (2) in 192-line mode the name table is 32x28 = 224 px
 *     tall, so R9 WRAPS AT 224, not 256 (the SMS analog of the NES's 240-wrap;
 *     plain uint8 math overruns it — see scroll_road_down).
 *   Streamed scenery — as the road scrolls, name-table rows re-enter at the
 *     TOP; the moment a row becomes the top road row we restamp its roadside
 *     cells with fresh random scenery, so the 224-px loop never shows the same
 *     scenery twice. The restamp lands UNDER the HUD strip, which hides it.
 *   HUD — the line-IRQ split. The road scrolls vertically (R9, whole plane),
 *     so the HUD strip's name-table rows scroll with it — a BG HUD over a
 *     vertical road would crawl. So HUD GLYPHS ARE SPRITES on the fixed top
 *     scanlines (immune to R9, exactly as the NES version uses sprite digits
 *     for the same reason). The line-IRQ split still earns its keep: it holds
 *     the top HUD band at horizontal scroll 0 while the road BELOW it SWAYS
 *     left/right per-strip (R8 — the one scroll axis you CAN change mid-frame),
 *     a gentle curve that reads as the road bending ahead. Fixed un-swayed HUD
 *     band on top, curving road below: a real line-IRQ fixed-HUD split.
 *   2P VERSUS — ONE VDP means ONE road scroll, so both players share one road
 *     at a fixed speed and only steer (the same constraint the NES/Genesis
 *     versions explain): solid center divider, P1 (white, port A) owns the left
 *     two lanes, P2 (red, port B) the right two. Each starts with 3 crashes;
 *     first to use them all LOSES.
 *   1P RACE — all four lanes, button 1/UP accelerates, button 2/DOWN brakes
 *     (speed 1-4); 3 crashes end the run. Persistent stat: best DISTANCE
 *     (uint16, one unit = 16 scrolled pixels ≈ one car length) via best_save.
 *
 * Frame budget (NTSC, 60fps): SAT upload (192 OUTs) + the HUD sprite stage fit
 * in vblank + the 24-line HUD strip; 6 traffic × 2 cars of AABB and one row
 * restamp at most every other frame run in the active frame with room to
 * spare. The sway table is 21 R8 writes scheduled off the line IRQ.
 *
 * SDCC FOOTGUN (bites every fork): uint8 loop bounds silently wrap —
 * `for (uint8_t i = 0; i < 24 * 32; i++)` is an INFINITE loop (768 > 255;
 * SDCC even warns "comparison is always true"). Treat that warning as an
 * error: widen the counter to uint16_t or keep loops nested per-row like the
 * painters below.
 */
#include "sms_hw.h"
#include "sms_sfx.h"
#include "sms_music.h"
#include <stdint.h>

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "FENDER FURY"

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
  /* BG: 0 = asphalt grey (backdrop = the road itself), 1 = grass green,
   * 2 = white (markings + clouds + text), 3 = dark speck, 4 = HUD navy */
  0x15, 0x08, 0x3F, 0x0A, 0x20, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  /* Sprites: 1 = white (P1 car + HUD digits), 2 = red (P2 car + traffic),
   * 3 = gold (checkpoint flash, unused-by-default). One shared sprite palette
   * on SMS — per-"car" colour means per-TILE colour indices. */
  0x00, 0x3F, 0x03, 0x0F, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};

/* ── GAME LOGIC (clay) — BG tile inventory (BG bank $0000) ───────────────────
 * tile 0          = blank (shows the colour-0 asphalt backdrop = the road)
 * tiles 1..37     = font: digits 0-9, A-Z, '-'  (uploaded 1bpp→4bpp below)
 * tile 38         = grass (colour 1)
 * tile 39         = tuft (grass + speck, colour 1/3)
 * tile 40         = solid HUD bar (colour 4) — the split seam hides in it
 * tile 41         = tarmac speck (colour 3 dot on asphalt)
 * tile 42         = solid shoulder/divider line (colour 2 = white)
 * tile 43         = dashed lane line (colour 2, 4 px on / 4 off) */
#define FONT_BASE  1
#define BG_GRASS   38
#define BG_TUFT    39
#define BG_HUDBAR  40
#define BG_SPECK   41
#define BG_EDGE    42
#define BG_DASH    43

/* 1bpp font (same glyph set as the platformer/shmup examples — 0-9, A-Z, '-').
 * Expanded to the SMS's 32-byte 4bpp tiles at upload (see load_font), so the
 * ROM carries 296 bytes instead of 1184. */
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

/* Expand 1bpp glyphs into 4bpp SMS tiles as colour 2 (plane 1 set).
 * SMS tile rows are 4 bytes: plane0, plane1, plane2, plane3. */
static void load_font(void) {
  uint8_t g, r, bits;
  sms_vdp_set_addr((uint16_t)(FONT_BASE * 32), VDP_VRAM_WRITE);
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

/* Road/roadside/HUD-bar tiles (4bpp, 32 bytes each — rows of plane0..3). */
static const uint8_t deco_tiles[192] = {
  /* BG_GRASS: solid colour 1 (plane 0) */
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  /* BG_TUFT: grass (colour 1) with a couple speck dots (colour 3 = planes 0+1) */
  0xFF,0x00,0x00,0x00, 0xFF,0x18,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x42,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x18,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  /* BG_HUDBAR: solid colour 4 (binary 100 → plane 2 only) — the split seam
   * lands inside this row */
  0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00,
  0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00,
  /* BG_SPECK: asphalt (colour 0) with a few colour-3 specks so the scroll is
   * readable on the otherwise-flat road (plane 0+1 dots) */
  0x00,0x00,0x00,0x00, 0x10,0x10,0x00,0x00, 0x00,0x00,0x00,0x00, 0x02,0x02,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x08,0x08,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  /* BG_EDGE: solid white vertical stripe (colour 2 = plane 1), 2 px wide */
  0x00,0x18,0x00,0x00, 0x00,0x18,0x00,0x00, 0x00,0x18,0x00,0x00, 0x00,0x18,0x00,0x00,
  0x00,0x18,0x00,0x00, 0x00,0x18,0x00,0x00, 0x00,0x18,0x00,0x00, 0x00,0x18,0x00,0x00,
  /* BG_DASH: dashed lane line — 4 px white (colour 2) on, 4 off, stacked */
  0x00,0x18,0x00,0x00, 0x00,0x18,0x00,0x00, 0x00,0x18,0x00,0x00, 0x00,0x18,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
};

/* Sprite tiles (sprite bank $2000 — vdp_init's R6=0xFF baseline reads sprite
 * patterns from $2000, so upload there, not $0000).
 *   T_CAR     — player car, nose up, colour 1 (white)
 *   T_TRAFFIC — slow traffic, tail up, colour 2 (red)
 *   T_DIGIT0  — 3x5 HUD digits 0-9 (sprites, colour 1) on the fixed top line */
static const uint8_t sprite_tiles[(2 + 10) * 32] = {
  /* T_CAR (white, plane 0) */
  0x18,0x00,0x00,0x00, 0x7E,0x00,0x00,0x00, 0x5A,0x00,0x00,0x00, 0x7E,0x00,0x00,0x00,
  0x3C,0x00,0x00,0x00, 0x7E,0x00,0x00,0x00, 0x5A,0x00,0x00,0x00, 0x66,0x00,0x00,0x00,
  /* T_TRAFFIC (red, plane 1) */
  0x00,0x66,0x00,0x00, 0x00,0x5A,0x00,0x00, 0x00,0x7E,0x00,0x00, 0x00,0x3C,0x00,0x00,
  0x00,0x7E,0x00,0x00, 0x00,0x5A,0x00,0x00, 0x00,0x7E,0x00,0x00, 0x00,0x18,0x00,0x00,
  /* T_DIGIT0..9 — compact 3x5 white digits (plane 0) on a fixed HUD scanline */
  /* 0 */ 0xE0,0,0,0, 0xA0,0,0,0, 0xA0,0,0,0, 0xA0,0,0,0, 0xE0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
  /* 1 */ 0x40,0,0,0, 0xC0,0,0,0, 0x40,0,0,0, 0x40,0,0,0, 0xE0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
  /* 2 */ 0xE0,0,0,0, 0x20,0,0,0, 0xE0,0,0,0, 0x80,0,0,0, 0xE0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
  /* 3 */ 0xE0,0,0,0, 0x20,0,0,0, 0xE0,0,0,0, 0x20,0,0,0, 0xE0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
  /* 4 */ 0xA0,0,0,0, 0xA0,0,0,0, 0xE0,0,0,0, 0x20,0,0,0, 0x20,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
  /* 5 */ 0xE0,0,0,0, 0x80,0,0,0, 0xE0,0,0,0, 0x20,0,0,0, 0xE0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
  /* 6 */ 0xE0,0,0,0, 0x80,0,0,0, 0xE0,0,0,0, 0xA0,0,0,0, 0xE0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
  /* 7 */ 0xE0,0,0,0, 0x20,0,0,0, 0x20,0,0,0, 0x40,0,0,0, 0x40,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
  /* 8 */ 0xE0,0,0,0, 0xA0,0,0,0, 0xE0,0,0,0, 0xA0,0,0,0, 0xE0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
  /* 9 */ 0xE0,0,0,0, 0xA0,0,0,0, 0xE0,0,0,0, 0x20,0,0,0, 0xE0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
};
#define T_CAR     0
#define T_TRAFFIC 1
#define T_DIGIT0  2          /* sprite tiles 2..11 = digits 0..9 */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Road geometry. Four 4-cell-wide lanes between shoulders, a solid center
 * divider (also the 2P territory line). Name-table columns (cells):
 *   8 = left shoulder, 12/20 = dashed lane lines, 16 = center divider,
 *   24 = right shoulder; grass outside. */
#define COL_EDGE_L   8
#define COL_DASH_1   12
#define COL_DIVIDER  16
#define COL_DASH_2   20
#define COL_EDGE_R   24
/* Lane center X for the 8px-wide car sprite (lane i spans 32 px). */
static const uint8_t lane_x[4] = { 76, 108, 140, 172 };

#define MAX_TRAFFIC  6
#define CAR_Y        160       /* both players' fixed screen Y                 */
#define SPAWN_Y      32        /* traffic entry Y — below the HUD strip        */
#define DESPAWN_Y    184       /* traffic exits past the player                */
#define START_LIVES  3         /* crashes per run / per player                 */
#define SPAWN_PERIOD 40        /* frames between traffic spawns — traffic moves
                                * at road speed, so per-meter density stays
                                * constant whatever the player does            */
#define SPEED_2P     2         /* fixed road speed in versus (one VDP =
                                * one scroll = one shared speed)               */
#define MAX_SPEED    4         /* px/frame — MUST stay under 8: the row
                                * streamer restamps one row per crossing and a
                                * >8 px step could skip a row                  */

/* HUD strip: rows 0-2 of the screen. Row 0 holds nothing in the BG (the
 * sprite digits ride there); row 2 is the solid bar where the split seam
 * hides. The 3-row strip is held un-swayed by the line-IRQ split. */
#define HUD_ROWS    3
#define HUD_PX      (HUD_ROWS * 8)
#define HUD_Y       1          /* sprite-HUD scanline (top of the fixed band)  */

/* Players: index 0 = P1 (port A), 1 = P2 (port B — versus only). */
static uint8_t car_lane[2];
static uint8_t car_active[2];
static uint8_t crashes_left[2];
static uint8_t invuln[2];          /* post-crash blink/no-collide frames       */
static uint8_t prev_pad[2];
static uint8_t lane_min[2], lane_max[2];   /* 2P: split territories            */
static uint8_t two_player;
static uint8_t winner;             /* versus result: 0 = P1, 1 = P2            */

static uint8_t  traffic_alive[MAX_TRAFFIC];
static uint8_t  traffic_lane[MAX_TRAFFIC];
static uint8_t  traffic_y[MAX_TRAFFIC];

static uint8_t  speed;             /* road px/frame, 1..MAX_SPEED              */
static uint16_t dist;              /* 1P distance, 1 unit = 16 scrolled px     */
static uint8_t  dist_frac;
static uint16_t best;              /* persisted best 1P distance               */
static uint8_t  spawn_timer;
static uint8_t  road_scroll;       /* R9 vertical scroll, ALWAYS kept 0..223   */
static uint8_t  prev_top_row;      /* last restamped name-table row            */
static uint8_t  start_pause;       /* freeze frames at green light             */
static uint8_t  hud_dirty;         /* lives/speed changed → restage sprite HUD */
static uint8_t  over_step;         /* result text, one piece per vblank        */
static uint16_t rng = 0xC0DE;

/* HUD digit cache — SDCC's 16-bit div/mod helpers cost hundreds of cycles
 * each; recompute the 5 distance digits only when dist actually changes. */
static uint8_t  hud_digits[5];
static uint16_t hud_cached = 0xFFFF;

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;

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

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * WHOLE-PLANE VERTICAL ROAD SCROLL — R9, the SMS road. The vertical-scroll
 * register R9 scrolls the ENTIRE name-table plane up/down; screen line y shows
 * plane line (y + R9) mod (plane height), so DECREMENTING R9 slides the road
 * DOWN — the driving-up illusion — for the cost of ONE register write per
 * frame. Zero tilemap writes for the motion itself (rewriting the tilemap in
 * the loop is the #1 "choppy movement" bug).
 *
 * TWO twists this game is built around (vs the Genesis donor's plain u16):
 *   1. R9 IS LATCHED ONCE PER FRAME. The VDP samples R9 at the start of the
 *      active display and ignores mid-frame writes until the next frame. So a
 *      vertical scroll is a per-FRAME whole-plane move — you cannot split it
 *      mid-screen the way you split X-scroll (R8). (That's why the fixed HUD
 *      below uses SPRITE glyphs + an R8 sway split, not a mid-frame R9 swap.)
 *      Always write R9 in vblank.
 *   2. R9 WRAPS AT 224, NOT 256. In 192-line mode the name table is 32x28 =
 *      224 px tall; R9 values 224-255 make the VDP fetch the unused rows 28-31
 *      (garbage). Plain uint8 math happily produces 224-255, so EVERY change
 *      to road_scroll goes through this helper. (The NES analog wraps at 240;
 *      the Genesis plane is 32x32 = 256 and wraps in hardware for free.)
 * Scrolling DOWN = the road slides toward the player = R9 DECREASES. */
#define PLANE_H 224
static void scroll_road_down(uint8_t px) {
  if (road_scroll >= px) road_scroll = (uint8_t)(road_scroll - px);
  else                   road_scroll = (uint8_t)(road_scroll + PLANE_H - px);
  sms_vdp_write_reg(9, road_scroll);   /* commit vertical scroll (vblank only) */
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * STREAMED ROADSIDE ROWS. As R9 shrinks, name-table rows recycle into the top
 * of the screen; the road row entering at the top is plane row (R9 >> 3) mod
 * 28. The moment it changes we restamp THAT ONE row's roadside cells with
 * fresh random scenery, so the 224-px loop never shows the same grass twice.
 * Three rules:
 *   1. Restamp in VBLANK only (this game's main loop calls it right after the
 *      vblank wait): raw VRAM writes during active display race the VDP's own
 *      fetches and drop/garble bytes on real hardware.
 *   2. The restamped row enters UNDER the HUD strip, which hides the swap.
 *      Restamp rows lower and the player sees tiles pop.
 *   3. Road speed stays under 8 px/frame (MAX_SPEED) so a frame never skips a
 *      whole row crossing. */
static void stream_road_row(uint8_t row) {
  uint8_t r;
  /* Left shoulder grass band (cols 2,5) + right shoulder (cols 27,30). */
  r = random8(); sms_set_tilemap_cell(row, 2,  (r & 7) == 0 ? BG_TUFT : BG_GRASS, 0);
  r = random8(); sms_set_tilemap_cell(row, 5,  (r & 7) == 0 ? BG_TUFT : BG_GRASS, 0);
  r = random8(); sms_set_tilemap_cell(row, 27, (r & 7) == 0 ? BG_TUFT : BG_GRASS, 0);
  r = random8(); sms_set_tilemap_cell(row, 30, (r & 7) == 0 ? BG_TUFT : BG_GRASS, 0);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * LINE-INTERRUPT FIXED-HUD SPLIT + per-strip road SWAY. The VDP has ONE scroll
 * register pair for the whole frame; the line interrupt lets you change the X
 * scroll (R8) MID-FRAME (R8 is sampled per line — R9 is NOT, see above). Where
 * the NES needs the sprite-0-hit HACK (park a sprite, busy-poll, burn
 * scanlines), the SMS has a real, PROGRAMMABLE line counter:
 *
 *   R10 = N        line counter: down-counter reloaded with N every line
 *                  outside the active area; underflow → IRQ at line N.
 *   R0 bit 4 (IE1) line-IRQ enable (already set in vdp_init's 0x36 baseline).
 *   R1 bit 5 (IE0) frame(vblank)-IRQ enable (set by sms_vdp_display_on's 0xE0).
 *
 * Both IRQs land on the Z80 IM-1 vector at $0038. The crt0 handler does the
 * minimal handshake: push af / in a,($BF) / pop af / ei / reti — the status
 * read ACKS the VDP (clears BOTH flags; skip it and the IRQ line stays
 * asserted = interrupt storm), and EI must precede RETI.
 *
 * The handler does no work, so the MAIN loop syncs with HALT: sleep until an
 * interrupt, then read the V-counter (port $7E) to learn WHICH one woke us —
 * line IRQs fire in the active area (V < 0xC0), the frame IRQ at vblank
 * (V ≥ 0xC0). Here the road scrolls VERTICALLY (R9, whole plane), so we cannot
 * keep the HUD's name-table rows still by splitting R9. Instead:
 *   - HUD GLYPHS ARE SPRITES on the fixed top scanline (immune to R9).
 *   - The split holds the top HUD band at R8 = 0 (un-swayed), then below the
 *     bar applies a per-strip horizontal SWAY so the road bends left/right
 *     ahead of the player — a real raster road-curve effect. Fixed HUD band
 *     on top, curving road below.
 *
 * wait_vblank(): sleep to the frame IRQ → R8 = 0 (HUD band un-swayed) and do
 *                per-frame VRAM work.
 * wait_split():  sleep to the line IRQ at the bottom of the HUD bar (R10 =
 *                HUD_PX-1) → from here down, the active loop pushes the sway
 *                value into R8 as the road draws. (We set a single sway value
 *                per frame here; reshape into a per-line table for a deeper
 *                curve, budgeting OUTs against the line time.)
 *
 * FOOTGUN — you cannot poll once IRQs are on: a status-port poll races the
 * ISR, which always wins and eats the flag, hanging the poll forever. HALT +
 * V-counter is the IRQ-era replacement.
 *
 * Requires: R10 programmed, IE1 + IE0 enabled, EI executed once after
 * display-on, the crt0 ack-only ISR, and wait_vblank/wait_split called EVERY
 * frame in this order. R10 reloads after each underflow, so the line IRQ
 * re-fires every HUD_PX lines down the frame — the later wakes harmlessly
 * interrupt game logic (the ISR acks them) and we re-halt in the NEXT
 * wait_vblank(). */
#define SPLIT_LINE (HUD_PX - 1)
static int8_t  sway;            /* current road horizontal sway, ±a few px     */
static uint8_t sway_phase;
static const int8_t sway_wave[8] = { 0, 1, 2, 2, 0, -2, -2, -1 };

static void wait_vblank(void) {
  /* check-first: if game logic overran into vblank, don't sleep a frame */
  while (PORT_V_COUNTER < 0xC0) { __asm__("halt"); }
  sms_vdp_write_reg(8, 0);          /* HUD band renders with X scroll 0 */
}

static void wait_split(void) {
  /* halt-first: vblank work always ends inside vblank (V ≥ 0xC0), and the
   * first wake at V < 0xC0 is the line IRQ at SPLIT_LINE */
  do { __asm__("halt"); } while (PORT_V_COUNTER >= 0xC0);
  sms_vdp_write_reg(8, (uint8_t)sway);  /* road below the bar sways */
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * BEST-DISTANCE in Sega-mapper cart RAM. The Sega mapper's control register at
 * $FFFC: bit 3 maps the cart's 8KB battery RAM into $8000-$BFFF (bank slot 2).
 * Map → copy → unmap; keep the window short so stray pointer bugs can't shred
 * the save. The block is magic + value + checksum so a never-written cart (all
 * $FF) reads back as "no save" instead of a garbage best.
 *
 * NOTE the $FFFC address: it's IN the WRAM mirror ($C000-$DFFF mirrors at
 * $E000-$FFFF), so this write also lands in WRAM at $DFFC — the mapper just
 * snoops the bus. That's why the crt0 parks SP at $DFF0.
 *
 * HONESTY (verified against the bundled gpgx core): gpgx only instantiates the
 * Sega mapper for ROMs LARGER than 48KB; this build pipeline emits 32KB ROMs,
 * so in-emulator the $8000 window stays open-bus (reads $FF), the magic check
 * fails, and the game falls back to the WRAM best (in-session only). The code
 * is the correct real-hardware idiom and lights up unchanged on a >48KB build
 * or a cart with battery RAM: the load path is self-falsifying, never wrong. */
#define MAPPER_CTRL (*(volatile uint8_t *)0xFFFC)
#define CART_RAM    ((volatile uint8_t *)0x8000)

static void best_save(uint16_t v) {
  uint8_t lo = (uint8_t)(v & 0xFF), hi = (uint8_t)(v >> 8);
  MAPPER_CTRL = 0x08;               /* map cart RAM at $8000 */
  CART_RAM[0] = 0x42;               /* 'B' */
  CART_RAM[1] = 0x44;               /* 'D' */
  CART_RAM[2] = lo;
  CART_RAM[3] = hi;
  CART_RAM[4] = (uint8_t)(lo ^ hi ^ 0xA5);
  MAPPER_CTRL = 0x00;               /* back to ROM in slot 2 */
}

static uint16_t best_load(void) {
  uint16_t v = 0;
  MAPPER_CTRL = 0x08;
  if (CART_RAM[0] == 0x42 && CART_RAM[1] == 0x44 &&
      CART_RAM[4] == (uint8_t)(CART_RAM[2] ^ CART_RAM[3] ^ 0xA5)) {
    v = (uint16_t)(CART_RAM[2] | ((uint16_t)CART_RAM[3] << 8));
  }
  MAPPER_CTRL = 0x00;
  return v;
}

/* ── GAME LOGIC (clay) — text via the font tiles (BG name table) ─────────────
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

/* ── GAME LOGIC (clay) — sprite HUD (digits ride the fixed top scanline) ─────
 * HUD glyphs are SPRITES (immune to the road's R9 vertical scroll), staged
 * into the SAT shadow each frame the HUD changes. Slot map (after the cars +
 * traffic): see stage_sprites. 1P: lives digit + 5-digit distance = 6 sprites
 * on the line; 2P: one crashes-left digit per player = 2. Mind the 8-sprites-
 * PER-SCANLINE limit — traffic spawns BELOW the HUD line so it never shares. */
static uint8_t hud_slot;           /* first SAT slot the HUD digits use        */
static void stage_hud_sprites(void) {
  uint8_t i, s = hud_slot;
  if (two_player) {
    sms_sprite_set(s++, 16,  HUD_Y, (uint8_t)(T_DIGIT0 + crashes_left[0]));
    sms_sprite_set(s++, 232, HUD_Y, (uint8_t)(T_DIGIT0 + crashes_left[1]));
    return;
  }
  sms_sprite_set(s++, 16, HUD_Y, (uint8_t)(T_DIGIT0 + crashes_left[0]));
  if (dist != hud_cached) {         /* recompute digits only on change */
    uint16_t v = dist;
    for (i = 0; i < 5; i++) { hud_digits[4 - i] = (uint8_t)(v % 10); v /= 10; }
    hud_cached = dist;
  }
  for (i = 0; i < 5; i++)
    sms_sprite_set(s++, (uint8_t)(200 + i * 8), HUD_Y, (uint8_t)(T_DIGIT0 + hud_digits[i]));
}

/* ── GAME LOGIC (clay) — paint the road into the name table ──────────────────
 * Whole-screen repaint with the DISPLAY OFF (free VRAM access, clean cut).
 * The dashed lane lines + shoulders are painted ONCE and never touched again:
 * they live in the BG, so R9 moves them with the road for free.
 * PERF FOOTGUN (inherited from the shmup): per-cell sms_set_tilemap_cell
 * redoes the 4-OUT address setup for every cell — over a full screen that's
 * seconds of black. Set the VRAM address ONCE per row (the data port
 * autoincrements) and stream. */
static uint8_t road_cell(uint8_t r, uint8_t c) {
  if (c == COL_EDGE_L || c == COL_EDGE_R || c == COL_DIVIDER) return BG_EDGE;
  if (c == COL_DASH_1 || c == COL_DASH_2) return BG_DASH;
  if (c > COL_EDGE_L && c < COL_EDGE_R) {                 /* tarmac           */
    return (((uint8_t)(r * 5 + c * 3) % 13) == 0) ? BG_SPECK : 0;
  }
  /* roadside grass + sparse tufts */
  if (((uint8_t)(r * 7 + c * 5) & 7) == 0) return BG_TUFT;
  return BG_GRASS;
}

static void paint_road(void) {
  uint8_t r, c;
  for (r = 0; r < 28; r++) {        /* all 28 plane rows (224 px) */
    sms_vdp_set_addr((uint16_t)(0x3800 + (uint16_t)r * 64), VDP_VRAM_WRITE);
    for (c = 0; c < 32; c++) {
      PORT_VDP_DATA = road_cell(r, c);  /* name-table entry low byte */
      PORT_VDP_DATA = 0;                /* high byte: flips/palette/priority */
    }
  }
}

static void paint_title(void) {
  sms_vdp_display_off();
  paint_road();                     /* the road itself is the backdrop */
  text_draw(6, (uint8_t)((32 - (sizeof(GAME_TITLE) - 1)) / 2), GAME_TITLE);
  text_draw(11, 10, "1P RACE - 1");
  text_draw(13, 10, "2P VERSUS - 2");
  text_draw(20, 12, "BEST");
  draw_u16(20, 17, best);
  sms_sprite_init();                /* park every sprite off-screen */
  sms_sat_upload();
  road_scroll = 0;
  sms_vdp_write_reg(8, 0);
  sms_vdp_write_reg(9, 0);
  sms_vdp_display_on();             /* re-enables the frame IRQ too */
}

static void paint_field(void) {
  uint8_t c;
  sms_vdp_display_off();
  paint_road();
  /* HUD strip rows 0-2: clear the BG under the sprite HUD, lay the solid bar
   * on row 2 where the split seam hides. (These rows scroll with the road via
   * R9 — they're a curtain the streamed restamp hides behind, and the sprite
   * digits ride above them.) */
  for (c = 0; c < 32; c++) {
    sms_set_tilemap_cell(0, c, 0, 0);
    sms_set_tilemap_cell(1, c, 0, 0);
    sms_set_tilemap_cell(2, c, BG_HUDBAR, 0);
  }
  sms_sprite_init();
  road_scroll = 0;
  prev_top_row = 0;
  hud_cached = 0xFFFF;
  sms_vdp_write_reg(8, 0);
  sms_vdp_write_reg(9, 0);
  sms_vdp_display_on();
}

/* The result card reuses the live road as its backdrop (a bare single-colour
 * card reads as a render failure — the verify tool flags >92% one-colour
 * frames) and draws its text via deferred over_step pieces in the ST_OVER
 * loop, one per vblank, so each vblank→split budget stays honest. The road
 * keeps scrolling under it. */

/* ── GAME LOGIC (clay) — traffic pool (fixed slots, no allocation) ── */
static void spawn_traffic(void) {
  uint8_t i;
  for (i = 0; i < MAX_TRAFFIC; i++) {
    if (!traffic_alive[i]) {
      traffic_alive[i] = 1;
      traffic_lane[i] = random8() & 3;
      traffic_y[i] = SPAWN_Y;
      return;
    }
  }
}

/* AABB, both boxes 8x8. */
static uint8_t hits(uint8_t ax, uint8_t ay, uint8_t bx, uint8_t by) {
  return dist8(ax, bx) < 8 && dist8(ay, by) < 8;
}

/* ── GAME LOGIC (clay) — start a run / end a run ── */
static void start_game(uint8_t versus) {
  uint8_t i;
  two_player = versus;
  for (i = 0; i < MAX_TRAFFIC; i++) traffic_alive[i] = 0;
  for (i = 0; i < 2; i++) {
    crashes_left[i] = START_LIVES;
    invuln[i] = 0;
    prev_pad[i] = 0xFF;             /* swallow buttons held across the change */
  }
  if (versus) {
    car_active[0] = 1; car_active[1] = 1;
    lane_min[0] = 0; lane_max[0] = 1; car_lane[0] = 0;   /* P1: left half  */
    lane_min[1] = 2; lane_max[1] = 3; car_lane[1] = 3;   /* P2: right half */
    speed = SPEED_2P;               /* shared road, fixed speed (see header) */
  } else {
    car_active[0] = 1; car_active[1] = 0;
    lane_min[0] = 0; lane_max[0] = 3; car_lane[0] = 1;   /* whole road */
    speed = 1;
  }
  dist = 0; dist_frac = 0;
  spawn_timer = 0;
  sway = 0; sway_phase = 0;
  start_pause = 30;                 /* green-light breather */
  paint_field();                    /* display-off repaint — safe */
  hud_slot = (uint8_t)(2 + MAX_TRAFFIC);   /* cars=0,1; traffic=2..7; HUD=8.. */
  hud_dirty = 1;
  sfx_tone(0, 214, 8);              /* start jingle (C5) */
  state = ST_PLAY;
}

static void game_over(void) {
  if (!two_player && dist > best) {
    best = dist;
    best_save(best);                /* cart RAM (real hardware); WRAM copy live */
  }
  sfx_noise(20);
  state = ST_OVER;
  over_step = 5;                    /* result text, one piece per vblank */
}

/* ── GAME LOGIC (clay) — crash rules ── */
static void crash(uint8_t p) {
  sfx_noise(14);
  invuln[p] = 60;                   /* blink + no-collide grace */
  if (!two_player) speed = 1;       /* a wreck kills your momentum */
  if (crashes_left[p] > 0) --crashes_left[p];
  hud_dirty = 1;
  if (crashes_left[p] == 0) {
    winner = (uint8_t)(1 - p);      /* versus: the OTHER player wins */
    game_over();
  }
}

/* ── GAME LOGIC (clay) — per-player input ────────────────────────────────────
 * LEFT/RIGHT steer between lanes (edge-detected — held d-pad shouldn't
 * machine-gun across the road). 1P only: button 1/UP accelerate, button 2/DOWN
 * brake (speed is shared in versus — see the design note). P2 is on PORT B. */
static void update_player(uint8_t p) {
  uint8_t pad = p ? sms_joypad_read_p2() : sms_joypad_read();
  uint8_t pressed = (uint8_t)(pad & ~prev_pad[p]);
  prev_pad[p] = pad;
  if (!car_active[p]) return;
  if ((pressed & JOY_LEFT) && car_lane[p] > lane_min[p]) {
    --car_lane[p];
    sfx_tone(1, 330, 3);                              /* lane tick */
  }
  if ((pressed & JOY_RIGHT) && car_lane[p] < lane_max[p]) {
    ++car_lane[p];
    sfx_tone(1, 330, 3);
  }
  if (!two_player) {                /* speed is shared — only 1P gets it */
    if ((pressed & (JOY_B1 | JOY_UP)) && speed < MAX_SPEED) {
      ++speed;
      sfx_tone(2, (uint16_t)(280 - speed * 30), 8);   /* engine rev */
      hud_dirty = 1;
    }
    if ((pressed & (JOY_B2 | JOY_DOWN)) && speed > 1) {
      --speed;
      sfx_tone(2, 500, 5);                            /* brake blip */
      hud_dirty = 1;
    }
  }
  if (invuln[p] > 0) --invuln[p];
}

/* ── GAME LOGIC (clay) — stage this frame's sprites ──────────────────────────
 * Fixed SAT slots: 0 = P1, 1 = P2, 2..7 = traffic, 8.. = HUD digits. Hidden
 * slots park at Y=$E0 (off-screen, NOT the $D0 terminator — that stops the
 * VDP scanning and blanks every later slot). */
static void stage_sprites(void) {
  uint8_t i;
  for (i = 0; i < 2; i++) {
    uint8_t vis = (state == ST_PLAY) && car_active[i] && !(invuln[i] & 2);
    sms_sprite_set(i, lane_x[car_lane[i]], vis ? CAR_Y : 0xE0, T_CAR);
  }
  for (i = 0; i < MAX_TRAFFIC; i++) {
    uint8_t vis = (state == ST_PLAY) && traffic_alive[i];
    sms_sprite_set((uint8_t)(2 + i), lane_x[traffic_lane[i]],
                   vis ? traffic_y[i] : 0xE0, T_TRAFFIC);
  }
  stage_hud_sprites();
}

void main(void) {
  uint8_t i, p;
  uint8_t top_row;

  /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
   * Init order: VDP regs (display off) → palette → tiles → name table → SAT →
   * R10 → display on (which also enables the frame IRQ) → EI. The one hard
   * rule: EI comes LAST, after every register is in place — the crt0 boots
   * with DI and the FIRST halt would hang forever if interrupts were never
   * enabled. */
  sms_vdp_init();                    /* R0=0x36 already has IE1 (line IRQ) set */
  sms_load_palette(palette);
  load_font();
  sms_load_tiles((uint16_t)(BG_GRASS * 32), deco_tiles, sizeof(deco_tiles));
  sms_load_tiles(0x2000, sprite_tiles, sizeof(sprite_tiles));
  sms_sprite_init();
  sfx_init();
  music_init();
  music_play(0);

  /* R10 = SPLIT_LINE arms the line counter: IRQ at the last bar line. Set
   * once — it reloads itself every underflow. */
  sms_vdp_write_reg(10, SPLIT_LINE);

  best = best_load();                /* cart RAM if present — else 0 */
  state = ST_TITLE;
  hud_slot = (uint8_t)(2 + MAX_TRAFFIC);
  paint_title();
  __asm__("ei");                     /* interrupts live from here on */

  for (;;) {
    /* Advance the per-frame sway wave (used below the HUD split). */
    sway_phase++;
    sway = sway_wave[(uint8_t)((sway_phase >> 2) & 7)];

    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: button 1 = 1P race, button 2 = 2P versus.
       * The road idles under the title card so the screen sells the scroll
       * before anyone presses a button. */
      wait_vblank();
      scroll_road_down(1);
      top_row = (uint8_t)((road_scroll >> 3) % 28);
      if (top_row != prev_top_row) { prev_top_row = top_row; stream_road_row(top_row); }
      sfx_update();
      music_update();
      wait_split();
      {
        uint8_t pad = sms_joypad_read();
        if ((pad & JOY_B1) && !(prev_pad[0] & JOY_B1)) start_game(0);
        else if ((pad & JOY_B2) && !(prev_pad[0] & JOY_B2)) start_game(1);
        prev_pad[0] = pad;
      }
      continue;
    }

    if (state == ST_OVER) {
      /* Freeze the road; deferred result text, one piece per vblank. Button 1
       * or 2 returns to the title. */
      wait_vblank();
      if (over_step) {
        if (over_step == 5) {
          if (two_player) text_draw(8, 12, winner ? "P2 WINS" : "P1 WINS");
          else            text_draw(8, 12, "WRECKED");
        } else if (over_step == 4) {
          if (two_player) text_draw(11, 9, "RIVAL WRECKED");
          else            text_draw(11, 12, "DIST");
        } else if (over_step == 3) {
          if (!two_player) draw_u16(11, 17, dist);
        } else if (over_step == 2) {
          if (!two_player) text_draw(13, 12, "BEST");
        } else {
          if (!two_player) draw_u16(13, 17, best);
        }
        over_step--;
        if (over_step == 0) text_draw(20, 10, "PRESS - 1 OR 2");
      }
      sfx_update();
      music_update();
      wait_split();
      {
        uint8_t pad = sms_joypad_read();
        if ((pad & (JOY_B1 | JOY_B2)) && !(prev_pad[0] & (JOY_B1 | JOY_B2))) {
          state = ST_TITLE;
          paint_title();
        }
        prev_pad[0] = pad;
      }
      stage_sprites();               /* park cars/traffic off-screen */
      continue;
    }

    /* ── ST_PLAY ──────────────────────────────────────────────────────────
     * Frame shape: [vblank: SAT + scroll + streamed row, R8=0] → [line IRQ at
     * the bar: R8=sway] → [rest of frame: game logic]. VRAM traffic stays
     * inside vblank; logic runs while the VDP draws the road.
     *
     * BUDGET FOOTGUN (inherited from the shmup): everything between
     * wait_vblank() and wait_split() must finish before the line IRQ at line
     * 23 — vblank (70 lines) + the HUD strip (23) ≈ 21k cycles, and the SAT
     * upload eats ~7k. The HUD digits are SPRITES (staged into the shadow SAT,
     * uploaded once), and dist digits recompute only when dist changes (see
     * stage_hud_sprites) — so we never blow the budget with division here. */
    wait_vblank();
    sms_sat_upload();                /* shadow SAT staged at end of last frame */

    if (start_pause) {               /* green light: freeze gameplay, keep
                                      * frames honest (scroll idles, sprites
                                      * staged) */
      --start_pause;
      scroll_road_down(0);           /* re-commit R9 (no motion) */
      sfx_update();
      music_update();
      wait_split();
      stage_sprites();
      continue;
    }

    scroll_road_down(speed);
    top_row = (uint8_t)((road_scroll >> 3) % 28);
    if (top_row != prev_top_row) { prev_top_row = top_row; stream_road_row(top_row); }

    sfx_update();
    music_update();
    wait_split();                    /* the line-interrupt split — every frame */

    /* ── GAME LOGIC (clay) from here down ── */
    update_player(0);
    if (two_player) update_player(1);
    if (state != ST_PLAY) { stage_sprites(); continue; }  /* a crash ended it */

    /* Distance (1P stat): 1 unit per 16 scrolled pixels. A chime every 256
     * units marks a checkpoint. */
    if (!two_player) {
      dist_frac = (uint8_t)(dist_frac + speed);
      if (dist_frac >= 16) {
        dist_frac -= 16;
        if (dist < 65535u) ++dist;
        if (dist != 0 && (dist & 0xFF) == 0) sfx_tone(0, 107, 8);  /* C6 chime */
      }
    }

    /* Traffic flows down at road speed (slower cars you overtake); despawn
     * past the player with a little pass tick. */
    for (i = 0; i < MAX_TRAFFIC; i++) {
      if (!traffic_alive[i]) continue;
      traffic_y[i] = (uint8_t)(traffic_y[i] + speed);
      if (traffic_y[i] >= DESPAWN_Y) {
        traffic_alive[i] = 0;
        sfx_tone(1, 660, 2);
      }
    }
    if (++spawn_timer >= SPAWN_PERIOD) {
      spawn_timer = 0;
      spawn_traffic();
    }

    /* Traffic ↔ cars. Crash grace: a just-wrecked car blinks and can't collide
     * for 60 frames. */
    for (i = 0; i < MAX_TRAFFIC && state == ST_PLAY; i++) {
      if (!traffic_alive[i]) continue;
      for (p = 0; p < 2; p++) {
        if (!car_active[p] || invuln[p]) continue;
        if (hits(lane_x[traffic_lane[i]], traffic_y[i], lane_x[car_lane[p]], CAR_Y)) {
          traffic_alive[i] = 0;
          crash(p);
          break;
        }
      }
    }

    stage_sprites();                 /* stage the SAT shadow for next vblank */
  }
}
