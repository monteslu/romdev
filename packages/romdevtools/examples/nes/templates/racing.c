/* ── racing.c — NES top-down road racer (complete example game) ──────────────
 *
 * THROTTLE FEUD — a COMPLETE, working game: title screen, 1P endless race and
 * 2P simultaneous VERSUS, a vertically-scrolling road (the real thing — BG
 * scroll, not falling sprites), streamed roadside scenery through the queued
 * tile path, crash/lives rules, persistent best distance (battery SRAM),
 * music + SFX.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented NES footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — traffic patterns, speeds, tuning, art: reshape freely.
 *
 * What depends on what:
 *   nes_runtime.{h,c} — rendering/input/sound/text/hi-score library.
 *   chr-ram-runtime.crt0.s — boot + NMI + iNES header (BATTERY bit feeds
 *     hiscore_load/save; vertical mirroring makes the Y-wrap seamless).
 *     Load-bearing; edit with TROUBLESHOOTING open.
 *
 * THE DESIGN (read before reshaping):
 *   Scrolling — the road is the BACKGROUND, scrolled down by decrementing
 *     scroll_y each frame (the crt0 NMI commits scroll_x AND scroll_y every
 *     vblank). Cars/traffic are sprites with their own Y. See the Y-WRAP
 *     idiom below: NES vertical scroll wraps at 240, NOT 256.
 *   HUD — sprite digits on a fixed scanline. With the whole BG scrolling
 *     vertically, a fixed BG HUD would need a mid-frame Y-scroll change:
 *     unlike the X-only sprite-0 split in shmup.c, mid-frame Y needs the
 *     4-write $2006/$2005 sequence (the advanced variant — see
 *     TROUBLESHOOTING). Sprite HUD is the simple honest option, so that's
 *     what this game uses. Budget rule: max 8 sprites per scanline.
 *   2P VERSUS — ONE PPU means ONE road scroll, so both players share one
 *     road at a fixed speed and only steer: solid center divider, P1 (blue,
 *     port 0) owns the left two lanes, P2 (green, port 1) the right two.
 *     Each starts with 3 crashes; first to use them all LOSES.
 *   1P RACE — all four lanes, A/UP accelerates, B/DOWN brakes (speed 1-4);
 *     3 crashes end the run. Persistent stat: best DISTANCE (uint16, one
 *     unit = 16 scrolled pixels ≈ one car length) via hiscore_load/save.
 *
 * Frame budget (NTSC, 60fps): 6 traffic × 2 cars AABB = 12 checks, ≤4
 * queued tile writes per row crossing, and HUD digits recomputed only when
 * the distance value changes — comfortably inside one frame.
 */

#include "nes_runtime.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "THROTTLE FEUD"

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Sprite tile art ($0000 pattern table). Each 8x8 tile = 16 bytes: 8 plane-0
 * rows then 8 plane-1 rows (2bpp — plane0-only = colour 1, both = colour 3). */
static const uint8_t tile_blank[16] = { 0 };
static const uint8_t tile_car[16] = {          /* player car, nose up */
  0x18, 0x7E, 0x5A, 0x7E, 0x3C, 0x7E, 0x5A, 0x66,
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t tile_traffic[16] = {      /* slow traffic, tail up */
  0x66, 0x5A, 0x7E, 0x3C, 0x7E, 0x5A, 0x7E, 0x18,
  0,    0,    0,    0,    0,    0,    0,    0,
};
/* Compact 3x5 digits for the sprite HUD. font_upload() only serves the
 * BACKGROUND pattern table, and sprites read from $0000 — so the HUD gets
 * its own digit tiles on the sprite side. */
static const uint8_t tile_digits[10 * 16] = {
  /* 0 */ 0xE0,0xA0,0xA0,0xA0,0xE0,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 1 */ 0x40,0xC0,0x40,0x40,0xE0,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 2 */ 0xE0,0x20,0xE0,0x80,0xE0,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 3 */ 0xE0,0x20,0xE0,0x20,0xE0,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 4 */ 0xA0,0xA0,0xE0,0x20,0x20,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 5 */ 0xE0,0x80,0xE0,0x20,0xE0,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 6 */ 0xE0,0x80,0xE0,0xA0,0xE0,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 7 */ 0xE0,0x20,0x20,0x40,0x40,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 8 */ 0xE0,0xA0,0xE0,0xA0,0xE0,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
  /* 9 */ 0xE0,0xA0,0xE0,0x20,0xE0,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,
};
#define TILE_CAR     1
#define TILE_TRAFFIC 2
#define TILE_DIGIT0  3        /* sprite tiles 3-12 */

/* ── GAME LOGIC (clay) — road BG tiles (BACKGROUND pattern table $1000 —
 * separate from the sprite table at $0000; the runtime's PPUCTRL setup makes
 * that split). Colour 0 = the grey backdrop = the asphalt itself. */
static const uint8_t bg_edge[16] = {           /* solid shoulder/divider line */
  0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18,
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t bg_dash[16] = {           /* lane dash: 4 px on, 4 off */
  0x18, 0x18, 0x18, 0x18, 0x00, 0x00, 0x00, 0x00,
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t bg_grass[16] = {          /* roadside hatch (colour 2) */
  0,    0,    0,    0,    0,    0,    0,    0,
  0xEE, 0xBB, 0xEE, 0xBB, 0xEE, 0xBB, 0xEE, 0xBB,
};
static const uint8_t bg_tuft[16] = {           /* scenery: grass tuft */
  0x00, 0x00, 0x00, 0x24, 0x5A, 0x00, 0x00, 0x00,
  0xEE, 0xBB, 0xEE, 0x9B, 0xA4, 0xBB, 0xEE, 0xBB,
};
static const uint8_t bg_tree[16] = {           /* scenery: bush/tree */
  0x18, 0x3C, 0x7E, 0x7E, 0x3C, 0x18, 0x18, 0x00,
  0x18, 0x3C, 0x7E, 0x7E, 0x3C, 0x18, 0x18, 0xBB,
};
static const uint8_t bg_speck[16] = {          /* tarmac texture speck */
  0x00, 0x00, 0x10, 0x00, 0x00, 0x08, 0x00, 0x00,
  0x00, 0x00, 0x10, 0x00, 0x00, 0x08, 0x00, 0x00,
};
#define BG_EDGE   1
#define BG_DASH   2
#define BG_GRASS  3
#define BG_TUFT   4
#define BG_TREE   5
#define BG_SPECK  6

static const uint8_t palette[32] = {
  /* BG: dark-grey asphalt backdrop, white markings, green grass,
   * light-grey specks. One palette everywhere = no attribute scrolling
   * headaches (attribute bytes cover 16x16 zones and scroll WITH the BG). */
  0x00, 0x30, 0x1A, 0x10,
  0x00, 0x30, 0x1A, 0x10,
  0x00, 0x30, 0x1A, 0x10,
  0x00, 0x30, 0x1A, 0x10,
  /* Sprites: P1 blue, P2 green, traffic red, HUD white */
  0x00, 0x21, 0x11, 0x30,
  0x00, 0x2A, 0x1A, 0x30,
  0x00, 0x16, 0x06, 0x30,
  0x00, 0x30, 0x10, 0x00,
};
#define PAL_P1      0
#define PAL_P2      1
#define PAL_TRAFFIC 2
#define PAL_HUD     3

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Road geometry. Four 4-tile-wide lanes between shoulders, solid divider in
 * the middle (it's also the 2P territory line). Tile columns:
 *   7 = left shoulder, 12/20 = dashed lane lines, 16 = solid center divider,
 *   24 = right shoulder; grass outside. */
#define COL_EDGE_L   7
#define COL_DASH_1   12
#define COL_DIVIDER  16
#define COL_DASH_2   20
#define COL_EDGE_R   24
/* Lane center X for the 8px-wide car sprite (lane i spans 32 px). */
static const uint8_t lane_x[4] = { 76, 108, 140, 172 };

#define MAX_TRAFFIC  6
#define CAR_Y        200       /* both players' fixed screen Y */
#define HUD_Y        9         /* sprite HUD scanline (top 8 are overscan-cropped) */
#define SPAWN_Y      18        /* traffic entry Y — BELOW the HUD scanlines so
                                * traffic never shares them (8 sprites/scanline
                                * is a hard PPU limit; the 1P HUD already puts
                                * 6 there) */
#define START_LIVES  3         /* crashes per run/per player */
#define SPAWN_PERIOD 40        /* frames between traffic spawns — traffic moves
                                * at road speed, so per-meter density stays
                                * constant whatever the player's speed is */
#define SPEED_2P     2         /* fixed road speed in versus (one PPU = one
                                * scroll = one shared speed; see header) */

/* Players: index 0 = P1 (port 0), 1 = P2 (port 1, versus only). */
static uint8_t car_lane[2];
static uint8_t car_active[2];
static uint8_t crashes_left[2];
static uint8_t invuln[2];          /* post-crash blink/no-collide frames */
static uint8_t prev_pad[2];
static uint8_t lane_min[2], lane_max[2];   /* 2P: split territories */
static uint8_t two_player;
static uint8_t winner;             /* versus result: 0 = P1, 1 = P2 */

static uint8_t traffic_alive[MAX_TRAFFIC];
static uint8_t traffic_lane[MAX_TRAFFIC];
static uint8_t traffic_y[MAX_TRAFFIC];

static uint8_t speed;              /* road px/frame, 1-4 */
static uint16_t dist;              /* 1P distance, 1 unit = 16 scrolled px */
static uint8_t dist_frac;
static uint16_t best;              /* persisted best 1P distance */
static uint8_t spawn_timer;
static uint8_t road_scroll;        /* BG scroll_y, ALWAYS kept in 0..239 */
static uint8_t prev_top_row;       /* last streamed nametable row */
static uint16_t rng = 0xC0DE;

/* HUD digit cache — cc65's 16-bit div/mod helpers cost hundreds of cycles
 * each; recompute the 5 digits only when dist actually changes. */
static uint8_t hud_digits[5];
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

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Vertical scroll Y-WRAP. A nametable is 32x30 tiles = 240 pixels tall, so
 * vertical scroll wraps at 240, NOT 256. scroll_y values 240-255 make the
 * PPU fetch ATTRIBUTE-table bytes as tile indices — rows of garbage tiles.
 * Plain uint8_t arithmetic happily produces 240-255, so every change to
 * road_scroll goes through this helper. (Scrolling DOWN = the road slides
 * toward the player = scroll_y DECREASES.) The crt0's iNES header sets
 * vertical mirroring, so the nametable below $2000 mirrors $2000 and the
 * wrap is seamless. */
static void scroll_road_down(uint8_t px) {
  if (road_scroll >= px) road_scroll -= px;
  else                   road_scroll = (uint8_t)(road_scroll + 240 - px);
  ppu_scroll(0, road_scroll);     /* NMI commits scroll_x AND scroll_y */
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Streaming-row scenery through the QUEUED tile path. As the road scrolls
 * down, nametable rows re-enter at the top of the screen; the moment row R
 * becomes the top row we restamp its roadside scenery cells with fresh
 * random tiles, so the wrap never shows the same 240px loop twice. Classic
 * streaming-row technique — same trick big scrollers use, just downward.
 * Two hard rules:
 *   1. QUEUED writes only (tile_set) — raw $2007 traffic while rendering
 *      corrupts the scroll/address latch. The NMI drains 16 queue entries
 *      per vblank; we stamp 4 cells per row crossing, and at max speed (4
 *      px/frame) a crossing happens at most every other frame. Stay under
 *      the 16/vblank budget when adding cells.
 *   2. The restamped row sits in the overscan-cropped top band (most NTSC
 *      displays/cores hide the top 8 scanlines) when the queue commits, so
 *      the swap is invisible. Restamp rows anywhere lower and the player
 *      sees tiles pop. */
static void stream_road_row(uint8_t row) {
  uint8_t r;
  r = random8();  tile_set(0, 2,  row, (r & 7) == 0 ? BG_TREE : ((r & 3) == 0 ? BG_TUFT : BG_GRASS));
  r = random8();  tile_set(0, 5,  row, (r & 7) == 0 ? BG_TREE : ((r & 3) == 0 ? BG_TUFT : BG_GRASS));
  r = random8();  tile_set(0, 26, row, (r & 7) == 0 ? BG_TREE : ((r & 3) == 0 ? BG_TUFT : BG_GRASS));
  r = random8();  tile_set(0, 29, row, (r & 7) == 0 ? BG_TREE : ((r & 3) == 0 ? BG_TUFT : BG_GRASS));
}

/* AABB, both boxes 8x8. */
static uint8_t hits(uint8_t ax, uint8_t ay, uint8_t bx, uint8_t by) {
  uint8_t dx = (ax > bx) ? (ax - bx) : (bx - ax);
  uint8_t dy = (ay > by) ? (ay - by) : (by - ay);
  return (dx < 8) && (dy < 8);
}

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

/* ── GAME LOGIC (clay) — sprite HUD ─────────────────────────────────────────
 * All HUD glyphs are SPRITES on one fixed scanline (see header for why not
 * a BG HUD). 1P: lives digit left + 5-digit distance right = 6 sprites on
 * the line; 2P: one crashes-left digit per player = 2. Traffic spawns below
 * this scanline, so the 8-sprites-per-scanline PPU limit is never hit. */
static void stage_hud(void) {
  uint8_t i;
  if (two_player) {
    oam_spr(8,   HUD_Y, (uint8_t)(TILE_DIGIT0 + crashes_left[0]), PAL_P1);
    oam_spr(240, HUD_Y, (uint8_t)(TILE_DIGIT0 + crashes_left[1]), PAL_P2);
    return;
  }
  oam_spr(8, HUD_Y, (uint8_t)(TILE_DIGIT0 + crashes_left[0]), PAL_HUD);
  if (dist != hud_cached) {        /* recompute digits only on change */
    uint16_t v = dist;
    for (i = 0; i < 5; i++) { hud_digits[4 - i] = (uint8_t)(v % 10); v /= 10; }
    hud_cached = dist;
  }
  for (i = 0; i < 5; i++)
    oam_spr((uint8_t)(192 + i * 8), HUD_Y, (uint8_t)(TILE_DIGIT0 + hud_digits[i]), PAL_HUD);
}

/* ── GAME LOGIC (clay) — paint the road into nametable 0 ───────────────────
 * Whole-screen paint with the PPU OFF (vram_unsafe_set — the queued path
 * would deadlock with rendering disabled; see TROUBLESHOOTING). The dashed
 * lane lines are painted ONCE and never touched again: they live in the BG,
 * so the scroll moves them with the road for free. */
static void paint_road(void) {
  uint8_t row, col, tile;
  uint16_t base;
  for (row = 0; row < 30; row++) {
    base = (uint16_t)(0x2000 + (uint16_t)row * 32);
    for (col = 0; col < 32; col++) {
      if (col < COL_EDGE_L || col > COL_EDGE_R) {
        tile = BG_GRASS;                                /* roadside */
        if (((row * 7 + col * 13) % 31) == 0) tile = BG_TREE;
        else if (((row * 5 + col * 3) % 11) == 0) tile = BG_TUFT;
      } else if (col == COL_EDGE_L || col == COL_EDGE_R) {
        tile = BG_EDGE;                                 /* shoulders */
      } else if (col == COL_DIVIDER) {
        tile = BG_EDGE;                                 /* solid center line */
      } else if (col == COL_DASH_1 || col == COL_DASH_2) {
        tile = BG_DASH;                                 /* dashed lane lines */
      } else {
        tile = (((row * 5 + col * 3) % 13) == 0) ? BG_SPECK : 0;   /* tarmac */
      }
      vram_unsafe_set((uint16_t)(base + col), tile);
    }
  }
}

/* ── GAME LOGIC (clay) — the title screen ──────────────────────────────────
 * Painted with the PPU OFF (text_draw_unsafe = raw VRAM writes). The road
 * itself is the backdrop; text cells overwrite road cells (font pixels are
 * colour 1 = white over the colour-0 asphalt backdrop). */
static void paint_title(void) {
  uint8_t i;
  uint16_t v;
  uint8_t d[5];
  ppu_off();
  paint_road();
  text_draw_unsafe(0x2000 + 8 * 32 + ((32 - sizeof(GAME_TITLE) + 1) / 2), GAME_TITLE);
  text_draw_unsafe(0x2000 + 13 * 32 + 10, "1P RACE - A");
  text_draw_unsafe(0x2000 + 15 * 32 + 9,  "2P VERSUS - B");
  /* Persistent best line — hand-painted digits (queued text needs rendering
   * on; we're PPU-off here). */
  text_draw_unsafe(0x2000 + 20 * 32 + 10, "BEST");
  v = best;
  for (i = 0; i < 5; i++) { d[i] = (uint8_t)(v % 10); v /= 10; }
  for (i = 0; i < 5; i++)
    vram_unsafe_set((uint16_t)(0x2000 + 20 * 32 + 15 + i), (uint8_t)(0x40 + d[4 - i]));
  road_scroll = 0;
  ppu_scroll(0, 0);
  oam_clear();
  ppu_on_all();
}

/* ── GAME LOGIC (clay) — the result screen ── */
static void paint_over(void) {
  ppu_off();
  /* Same road backdrop as the title — a bare single-colour card looks like a
   * render failure (the verify tool flags >92% one-colour frames). */
  paint_road();
  if (two_player) {
    text_draw_unsafe(0x2000 + 10 * 32 + 12, winner ? "P2 WINS" : "P1 WINS");
    text_draw_unsafe(0x2000 + 14 * 32 + 8,  "RIVAL CRASHED OUT");
  } else {
    uint8_t i; uint16_t v; uint8_t d[5];
    text_draw_unsafe(0x2000 + 9 * 32 + 12, "WRECKED");
    text_draw_unsafe(0x2000 + 13 * 32 + 9,  "DIST");
    text_draw_unsafe(0x2000 + 15 * 32 + 9,  "BEST");
    v = dist;
    for (i = 0; i < 5; i++) { d[i] = (uint8_t)(v % 10); v /= 10; }
    for (i = 0; i < 5; i++)
      vram_unsafe_set((uint16_t)(0x2000 + 13 * 32 + 14 + i), (uint8_t)(0x40 + d[4 - i]));
    v = best;
    for (i = 0; i < 5; i++) { d[i] = (uint8_t)(v % 10); v /= 10; }
    for (i = 0; i < 5; i++)
      vram_unsafe_set((uint16_t)(0x2000 + 15 * 32 + 14 + i), (uint8_t)(0x40 + d[4 - i]));
  }
  text_draw_unsafe(0x2000 + 20 * 32 + 9, "START - TITLE");
  road_scroll = 0;
  ppu_scroll(0, 0);
  oam_clear();
  ppu_on_all();
}

/* ── GAME LOGIC (clay) — start a run ── */
static void start_game(uint8_t versus) {
  uint8_t i;
  two_player = versus;
  for (i = 0; i < MAX_TRAFFIC; i++) traffic_alive[i] = 0;
  for (i = 0; i < 2; i++) {
    crashes_left[i] = START_LIVES;
    invuln[i] = 0;
    prev_pad[i] = 0;
  }
  if (versus) {
    car_active[0] = 1; car_active[1] = 1;
    lane_min[0] = 0; lane_max[0] = 1; car_lane[0] = 0;   /* P1: left half  */
    lane_min[1] = 2; lane_max[1] = 3; car_lane[1] = 3;   /* P2: right half */
    speed = SPEED_2P;                /* shared road, fixed speed (see header) */
  } else {
    car_active[0] = 1; car_active[1] = 0;
    lane_min[0] = 0; lane_max[0] = 3; car_lane[0] = 1;   /* whole road */
    speed = 1;
  }
  dist = 0; dist_frac = 0;
  hud_cached = 0xFFFF;
  spawn_timer = 0;
  ppu_off();
  paint_road();
  road_scroll = 0;
  prev_top_row = 0;
  ppu_scroll(0, 0);
  oam_clear();
  ppu_on_all();
  state = ST_PLAY;
}

static void game_over(void) {
  if (!two_player && dist > best) {
    best = dist;
    /* ── HARDWARE IDIOM (load-bearing) — persists via battery PRG-RAM at
     * $6000; works because the crt0's iNES header sets the BATTERY bit.
     * See nes_runtime.c for the magic+checksum layout. ── */
    hiscore_save(best);
  }
  state = ST_OVER;
  paint_over();
}

/* ── GAME LOGIC (clay) — per-player input ───────────────────────────────────
 * LEFT/RIGHT steer between lanes (edge-detected — held d-pad shouldn't
 * machine-gun across the road). 1P only: A/UP accelerate, B/DOWN brake. */
static void update_player(uint8_t p) {
  uint8_t pad = pad_poll(p);
  uint8_t pressed = (uint8_t)(pad & ~prev_pad[p]);
  prev_pad[p] = pad;
  if (!car_active[p]) return;
  if ((pressed & PAD_LEFT) && car_lane[p] > lane_min[p]) {
    --car_lane[p];
    sound_play_tone(0, 0x120, 5, 2);                       /* lane tick */
  }
  if ((pressed & PAD_RIGHT) && car_lane[p] < lane_max[p]) {
    ++car_lane[p];
    sound_play_tone(0, 0x120, 5, 2);
  }
  if (!two_player) {                  /* speed is shared — only 1P gets it */
    if ((pressed & (PAD_A | PAD_UP)) && speed < 4) {
      ++speed;
      sound_play_tone(1, (uint16_t)(0x140 - speed * 0x30), 7, 4);  /* engine */
    }
    if ((pressed & (PAD_B | PAD_DOWN)) && speed > 1) {
      --speed;
      sound_play_tone(1, 0x1C0, 4, 3);                     /* brake blip */
    }
  }
  if (invuln[p] > 0) --invuln[p];
}

static void crash(uint8_t p) {
  sound_play_noise(10, 12, 14);
  invuln[p] = 60;                     /* blink + no-collide grace */
  if (!two_player) speed = 1;         /* a wreck kills your momentum */
  if (crashes_left[p] > 0) --crashes_left[p];
  if (crashes_left[p] == 0) {
    winner = (uint8_t)(1 - p);        /* versus: the OTHER player wins */
    game_over();
  }
}

void main(void) {
  uint8_t i, p, pad;
  uint8_t top_row;

  /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
   * Init order: PPU off → CHR upload → palette → nametable (raw writes) →
   * OAM clear → rendering on. CHR/palette/nametable writes REQUIRE the PPU
   * off (raw $2007 traffic during rendering corrupts the address latch
   * mid-frame). The runtime's ppu_off/ppu_on_all pair owns the PPUCTRL/
   * PPUMASK bits — don't poke those registers directly alongside it. */
  ppu_off();
  chr_ram_upload(0x0000, tile_blank,   16);
  chr_ram_upload(TILE_CAR     * 16, tile_car,     16);
  chr_ram_upload(TILE_TRAFFIC * 16, tile_traffic, 16);
  chr_ram_upload(TILE_DIGIT0  * 16, tile_digits,  sizeof(tile_digits));
  chr_ram_upload((uint16_t)(0x1000 + BG_EDGE  * 16), bg_edge,  16);
  chr_ram_upload((uint16_t)(0x1000 + BG_DASH  * 16), bg_dash,  16);
  chr_ram_upload((uint16_t)(0x1000 + BG_GRASS * 16), bg_grass, 16);
  chr_ram_upload((uint16_t)(0x1000 + BG_TUFT  * 16), bg_tuft,  16);
  chr_ram_upload((uint16_t)(0x1000 + BG_TREE  * 16), bg_tree,  16);
  chr_ram_upload((uint16_t)(0x1000 + BG_SPECK * 16), bg_speck, 16);
  font_upload();
  palette_load(palette);
  sound_init();

  best = hiscore_load();      /* battery SRAM — 0 on first boot */
  state = ST_TITLE;
  paint_title();

  for (;;) {
    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: A = 1P race, B = 2P versus ── */
      oam_clear();
      ppu_wait_nmi();
      sound_music_tick();
      pad = pad_poll(0);
      if ((pad & PAD_A) && !(prev_pad[0] & PAD_A)) { prev_pad[0] = pad; start_game(0); continue; }
      if ((pad & PAD_B) && !(prev_pad[0] & PAD_B)) { prev_pad[0] = pad; start_game(1); continue; }
      if ((pad & PAD_START) && !(prev_pad[0] & PAD_START)) { prev_pad[0] = pad; start_game(0); continue; }
      prev_pad[0] = pad;
      continue;
    }

    if (state == ST_OVER) {
      /* Result card; START or A returns to the title. */
      oam_clear();
      ppu_wait_nmi();
      sound_music_tick();
      pad = pad_poll(0);
      if ((pad & (PAD_START | PAD_A)) && !(prev_pad[0] & (PAD_START | PAD_A))) {
        state = ST_TITLE;
        paint_title();
      }
      prev_pad[0] = pad;
      continue;
    }

    /* ── ST_PLAY ─────────────────────────────────────────────────────── */

    /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
     * Stage ALL sprites BEFORE ppu_wait_nmi(). The NMI DMAs shadow OAM →
     * real OAM at the START of vblank, copying whatever shadow OAM holds AT
     * THAT MOMENT. Stage-then-wait; flipping it shows stale/empty sprites.
     * (No sprite-0 split here — the HUD is sprites — so order past that is
     * free; we stage cars first purely so they win sprite-priority ties.) */
    oam_clear();
    for (p = 0; p < 2; p++) {
      if (!car_active[p]) continue;
      if (invuln[p] & 2) continue;            /* crash blink: skip odd pairs */
      oam_spr(lane_x[car_lane[p]], CAR_Y, TILE_CAR, p ? PAL_P2 : PAL_P1);
    }
    for (i = 0; i < MAX_TRAFFIC; i++)
      if (traffic_alive[i]) oam_spr(lane_x[traffic_lane[i]], traffic_y[i], TILE_TRAFFIC, PAL_TRAFFIC);
    stage_hud();

    ppu_wait_nmi();
    sound_music_tick();

    /* Scroll the road, then stream scenery into the row that just wrapped
     * into the (overscan-hidden) top band. Both idioms documented above. */
    scroll_road_down(speed);
    top_row = (uint8_t)(road_scroll >> 3);
    if (top_row != prev_top_row) {
      prev_top_row = top_row;
      stream_road_row(top_row);
    }

    /* ── GAME LOGIC (clay) from here down ── */
    update_player(0);
    if (two_player) update_player(1);
    if (state != ST_PLAY) continue;     /* a crash may have ended the game */

    /* Distance (1P stat): 1 unit per 16 scrolled pixels. A chime every 256
     * units marks a checkpoint. */
    if (!two_player) {
      dist_frac = (uint8_t)(dist_frac + speed);
      if (dist_frac >= 16) {
        dist_frac -= 16;
        if (dist < 65535u) ++dist;
        if (dist != 0 && (dist & 0xFF) == 0)
          sound_play_tone(0, 0x0D6, 8, 10);   /* checkpoint chime (C6) */
      }
    }

    /* Traffic flows down at road speed (it reads as slower cars you're
     * overtaking); despawn past the bottom with a little pass tick. */
    for (i = 0; i < MAX_TRAFFIC; i++) {
      if (!traffic_alive[i]) continue;
      if (traffic_y[i] >= (uint8_t)(224 - speed)) {
        traffic_alive[i] = 0;
        sound_play_tone(1, 0x0C0, 2, 2);
      } else {
        traffic_y[i] = (uint8_t)(traffic_y[i] + speed);
      }
    }
    if (++spawn_timer >= SPAWN_PERIOD) {
      spawn_timer = 0;
      spawn_traffic();
    }

    /* Traffic ↔ cars. Crash grace: a just-wrecked car blinks and can't
     * collide for 60 frames. */
    for (i = 0; i < MAX_TRAFFIC; i++) {
      if (!traffic_alive[i]) continue;
      for (p = 0; p < 2; p++) {
        if (!car_active[p] || invuln[p]) continue;
        if (hits(lane_x[traffic_lane[i]], traffic_y[i], lane_x[car_lane[p]], CAR_Y)) {
          traffic_alive[i] = 0;
          crash(p);
          if (state != ST_PLAY) break;
        }
      }
      if (state != ST_PLAY) break;
    }
  }
}
