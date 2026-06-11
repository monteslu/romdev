/* ── platformer.c — NES side-scrolling platformer (complete example game) ────
 *
 * LEDGE LEAPER — a COMPLETE, working game: title screen, 1P mode and 2P
 * ALTERNATING-TURNS mode (arcade-classic: players swap on death; each player
 * has their own score and own 3 lives; player 2 plays on CONTROLLER 2),
 * coins + distance scoring, persistent hi-score (battery SRAM), music +
 * SFX, and the NES's signature sprite-0-hit split: a fixed HUD strip over
 * a horizontally scrolling level.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented NES footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — level layout, physics tuning, scoring, art: reshape
 *     freely.
 *
 * What depends on what:
 *   nes_runtime.{h,c} — rendering/input/sound/text/hi-score library.
 *   chr-ram-runtime.crt0.s — boot + NMI + iNES header (BATTERY bit feeds
 *     hiscore_load/save). Load-bearing; edit with TROUBLESHOOTING open.
 *
 * The level: a 256-px-wide COLUMN MAP (ground height + one-way platforms +
 * pits) painted IDENTICALLY into both nametables, so the 8-bit X scroll
 * wraps seamlessly — an endless looping run of pits, platforms, coins and
 * spikes. Coins/spikes are sprites that drift with the scroll (world-
 * anchored while on screen, respawning at the right edge).
 *
 * Frame budget (NTSC, 60fps): player physics + a two-column tile probe +
 * (3 coins + 2 spikes) of AABB + the sprite-0 spin (a few scanlines) fits
 * comfortably in one frame; a HUD redraw is ≤12 queued VRAM writes (the
 * queue drains 16 per vblank).
 */

#include "nes_runtime.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "LEDGE LEAPER"

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile art. Each 8x8 tile = 16 bytes: 8 plane-0 rows then 8 plane-1 rows
 * (2bpp — plane0-only pixels use colour 1, both planes = colour 3). */
static const uint8_t tile_blank[16] = { 0 };
static const uint8_t tile_player_idle[16] = {
  0x3C, 0x7E, 0xFF, 0xFF, 0xFF, 0x7E, 0x66, 0x66,  /* round body + legs */
  0x00, 0x24, 0x24, 0x00, 0x00, 0x00, 0x00, 0x00,  /* eyes (colour 3)   */
};
static const uint8_t tile_player_jump[16] = {
  0x18, 0x7E, 0xFF, 0xFF, 0xE7, 0xC3, 0x81, 0x00,  /* arms up           */
  0x00, 0x24, 0x24, 0x00, 0x00, 0x00, 0x00, 0x00,
};
static const uint8_t tile_coin[16] = {
  0x3C, 0x7E, 0xFF, 0xFF, 0xFF, 0xFF, 0x7E, 0x3C,  /* coin disc         */
  0x00, 0x3C, 0x66, 0x5A, 0x5A, 0x66, 0x3C, 0x00,  /* embossed ring     */
};
static const uint8_t tile_spike[16] = {
  0x00, 0x18, 0x18, 0x3C, 0x3C, 0x7E, 0x7E, 0xFF,  /* ground spike      */
  0,    0,    0,    0,    0,    0,    0,    0,
};
/* Sprite 0's marker block — fully OPAQUE (the sprite-0 hit fires on
 * opaque-sprite-over-opaque-BG, colour is irrelevant). Its palette below
 * makes it the same brown as the HUD bar, so it's invisible in the bar. */
static const uint8_t tile_mark[16] = {
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
  0,    0,    0,    0,    0,    0,    0,    0,
};

/* BG tiles (BACKGROUND pattern table $1000 — separate from the sprite
 * table at $0000; the runtime's PPUCTRL setup makes that split). */
static const uint8_t bg_tile_cloud[16] = {
  0x00, 0x18, 0x3C, 0x7E, 0x7E, 0x00, 0x00, 0x00,  /* puffy cloud (idx1) */
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t bg_tile_dirt[16] = {
  0,    0,    0,    0,    0,    0,    0,    0,
  0xFF, 0xFF, 0xEF, 0xFF, 0xFF, 0xFE, 0xFF, 0xFF,  /* dirt fill (idx2)  */
};
static const uint8_t bg_tile_grass[16] = {
  0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  /* top 2 rows idx3   */
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,  /* rest idx2 (dirt)  */
};
/* A solid tile for the HUD bar — sprite 0 must overlap an OPAQUE BG pixel
 * for the sprite-0 hit to fire (see the split idiom below). */
static const uint8_t bg_tile_hudbar[16] = {
  0,    0,    0,    0,    0,    0,    0,    0,
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,  /* solid idx2 brown  */
};
#define BG_CLOUD  1
#define BG_DIRT   2
#define BG_GRASS  3   /* also used for floating platforms (grass slabs) */
#define BG_HUDBAR 4

static const uint8_t palette[32] = {
  /* BG: ALL FOUR sub-palettes identical (sky, cloud white, dirt brown,
   * grass green). That makes stale attribute-table bits harmless — power-on
   * CIRAM is garbage, and identical sub-palettes mean any attribute value
   * picks the same colours. We clear the attribute tables anyway (belt and
   * braces, see paint_field). */
  0x21, 0x30, 0x17, 0x2A,
  0x21, 0x30, 0x17, 0x2A,
  0x21, 0x30, 0x17, 0x2A,
  0x21, 0x30, 0x17, 0x2A,
  /* The universal backdrop ($3F00) is MIRRORED at $3F10 — sprite palette 0
   * colour 0. palette_load writes all 32 bytes in order, so this byte is
   * the LAST write to the mirror and wins: keep it equal to the BG backdrop
   * (sky blue) or the whole sky changes colour. (Sprite colour 0 is
   * transparent regardless — this never affects how sprites draw.) */
  0x21, 0x16, 0x30, 0x27,  /* sp0: player — red body, white/orange trim   */
  0x0F, 0x17, 0x17, 0x17,  /* sp1: sprite-0 marker — HUD-bar brown camo   */
  0x0F, 0x16, 0x06, 0x30,  /* sp2: spikes — danger red                    */
  0x0F, 0x28, 0x27, 0x30,  /* sp3: coins — gold                           */
};

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * The level — a 32-column map; world x = (screen x + scroll) mod 256.
 *   ground_row[c] — nametable row of the ground's grass top, 0xFF = pit.
 *   plat_row[c]   — row of a one-way floating platform, 0 = none.
 * Rows are nametable rows (y = row*8). Playfield rows are 3..29. */
#define NO_GROUND 0xFF
static const uint8_t ground_row[32] = {
  26, 26, 26, 26, 26, 26, 26, 26,                  /* start runway        */
  26, NO_GROUND, NO_GROUND, 26, 26, 26, 26, 26,    /* pit 1 (16 px)       */
  26, 26, 26, 26, NO_GROUND, NO_GROUND, NO_GROUND, /* pit 2 (24 px)       */
  26, 26, 26, 26, 26, 26, 26, 26, 26,
};
static const uint8_t plat_row[32] = {
  0, 0, 0, 0, 21, 21, 21, 0,                       /* slab before pit 1   */
  0, 0, 0, 0, 0, 0, 20, 20,                        /* slab mid-level      */
  20, 0, 0, 0, 0, 0, 0, 0,
  0, 21, 21, 21, 0, 0, 0, 0,                       /* slab near the loop  */
};

#define TILE_PLAYER_IDLE 1
#define TILE_PLAYER_JUMP 2
#define TILE_COIN        3
#define TILE_SPIKE       4
#define TILE_MARK        5
#define PLAYER_PAL       0
#define MARK_PAL         1
#define SPIKE_PAL        2
#define COIN_PAL         3

/* HUD layout (mind the OVERSCAN: most NTSC displays/cores crop the top 8
 * scanlines, so nametable row 0 is invisible — never put text there):
 *   row 0 — blank (cropped by overscan)
 *   row 1 — HUD text (P# / lives / SC / HI)
 *   row 2 — solid bar: the visual divider AND sprite 0's opaque anchor
 *   row 3+ — the scrolling playfield
 * The HUD strip always renders with scroll (0,0) from nametable 0, so HUD
 * text lives ONLY in nametable 0 — it can never scroll into view twice. */
#define HUD_ROWS    3
#define START_LIVES 3

/* ── GAME LOGIC (clay) — physics + tuning ── */
#define GRAVITY_Q44    1    /* +1/16 px per frame per frame                */
#define JUMP_VEL_Q44 (-40)  /* launch vy (Q4.4) → ~50 px / ~6 tile apex    */
#define MAX_VY_Q44    80    /* terminal velocity, 5 px/frame — MUST stay   *
                             * under 6: the landing probe's 6-px window    *
                             * can't catch a faster fall (tunnelling)      */
#define MOVE_SPEED     2    /* px/frame walk + scroll speed                */
#define SCROLL_WALL  112    /* px: past this the world scrolls, not you    */
#define GROUND_TOP   208    /* ground_row 26 * 8                           */
#define SPIKE_Y      200    /* spikes stand on the ground                  */
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

/* Players: index 0 = P1 (controller 1), 1 = P2 (controller 2 — alternating
 * turns, arcade-classic style). Each has own score + own lives; the HUD shows the
 * CURRENT player's numbers. */
static uint8_t  two_player;
static uint8_t  cur_player;
static uint8_t  p_lives[2];
static uint16_t p_score[2];
static uint16_t hiscore;
static uint8_t  turn_pause;         /* freeze frames after a turn change   */
static uint16_t rng = 0xC0DE;

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;
static uint8_t prev_pad;

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
  return (a > b) ? (a - b) : (b - a);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Sprite-0-hit split scroll — THE classic NES technique (the fixed
 * status bar over a scrolling field in countless NES classics). The PPU has ONE scroll for the whole
 * frame; to keep the HUD fixed while the playfield scrolls, you change the
 * scroll MID-FRAME, and sprite 0 is your timing signal:
 *
 *   1. Sprite 0 (the FIRST sprite staged each frame) sits inside the HUD,
 *      overlapping an OPAQUE background pixel (our solid HUD bar tile).
 *   2. The NMI commits scroll (0,0) at vblank — the HUD renders unscrolled.
 *   3. After ppu_wait_nmi(), poll PPUSTATUS bit 6 in TWO phases: first wait
 *      for it to CLEAR (the stale flag from the previous frame survives all
 *      of vblank and only clears at the pre-render line), then wait for it
 *      to SET — the exact pixel where sprite 0's opaque pixel overlaps
 *      opaque background.
 *   4. THEN write the playfield scroll to PPUSCROLL — everything below the
 *      HUD renders with the new scroll.
 *
 * Requires: sprite 0 staged FIRST (oam_spr call order = OAM order), an
 *   opaque BG pixel under it, ppu_scroll(0,0) left as the frame scroll, and
 *   this poll running EVERY frame (miss a frame and the field jumps).
 * Mid-frame X-scroll needs only the two PPUSCROLL writes below. (Mid-frame
 *   Y needs the 4-write $2006/$2005 dance — see TROUBLESHOOTING before
 *   attempting; X covers the HUD-over-scrolling-field pattern.)
 * The two-phase spin burns from vblank start to the hit scanline — about
 * 35 scanlines of CPU every frame. Budget for it: your game logic gets the
 * rest of the visible frame, which is plenty for a game this size. */
#define PPUSTATUS_REG (*(volatile uint8_t *)0x2002)
#define PPUSCROLL_REG (*(volatile uint8_t *)0x2005)
static void split_after_hud(void) {
  uint8_t timeout = 240;
  /* FOOTGUN: the hit flag from the frame JUST RENDERED stays set all the
   * way through vblank — it only clears at the next pre-render line. We're
   * called right after ppu_wait_nmi() (i.e. inside vblank), so polling for
   * "set" alone exits INSTANTLY on the stale flag and the PPUSCROLL write
   * lands during vblank — scrolling the WHOLE next frame, HUD included
   * (the shear is subtle: it looks like the HUD "drifting"). The classic
   * fix is the two-phase poll: wait for the stale flag to CLEAR (the
   * pre-render line), then wait for THIS frame's hit to SET. */
  while (PPUSTATUS_REG & 0x40) {
    if (--timeout == 0) return;   /* flag stuck: bail, keep scroll (0,0) */
  }
  timeout = 240;
  while (!(PPUSTATUS_REG & 0x40)) {
    if (--timeout == 0) return;   /* rendering off / sprite-0 missing: bail */
  }
  PPUSCROLL_REG = scroll_x;       /* playfield X scroll (below the HUD) */
  PPUSCROLL_REG = 0;
}

/* Stage sprite 0 = an 8x8 opaque block over the HUD BAR row (OAM y is
 * scanline-1, so y=16 renders scanlines 17-24 = nametable row 2 = the bar —
 * opaque-on-opaque, so the hit fires INSIDE the bar and the scroll change
 * lands below it, never shearing the text row). Must be the FIRST oam_spr
 * call of the frame (OAM order = call order; the split needs index 0). */
static void stage_sprite0(void) {
  oam_spr(4, (HUD_ROWS - 1) * 8, TILE_MARK, MARK_PAL);
}

/* ── GAME LOGIC (clay) — HUD text (queued writes; NMI commits next vblank) ── */
static void draw_hud(void) {
  tile_set(0, 1, 1, (uint8_t)(0x41 + cur_player));   /* '1' or '2'        */
  tile_set(0, 3, 1, 0x40 + p_lives[cur_player]);     /* lives as a digit  */
  text_draw_u16(0, 9, 1, p_score[cur_player]);
  text_draw_u16(0, 19, 1, hiscore);
}

static void draw_hud_labels(void) {
  text_draw(0, 0, 1, "P");
  text_draw(0, 6, 1, "SC");
  text_draw(0, 16, 1, "HI");
}

/* PPU-off digit painter (the queued text_draw_u16 needs rendering ON). */
static void digits_unsafe(uint16_t ppu_addr, uint16_t v) {
  uint8_t d[5], i;
  for (i = 0; i < 5; i++) { d[i] = v % 10; v /= 10; }
  for (i = 0; i < 5; i++) vram_unsafe_set(ppu_addr + i, (uint8_t)(0x40 + d[4 - i]));
}

/* ── GAME LOGIC (clay) — the title screen ──────────────────────────────────
 * Painted with the PPU OFF (text_draw_unsafe = raw VRAM writes; the queued
 * variant would deadlock with rendering disabled — see TROUBLESHOOTING). */
static void paint_title(void) {
  uint16_t a = 0x2000;
  uint8_t r, c, t;
  ppu_off();
  for (r = 0; r < 30; r++) {
    for (c = 0; c < 32; c++) {
      t = 0;                                  /* sky backdrop              */
      if (r == 26) t = BG_GRASS;
      else if (r > 26) t = BG_DIRT;
      vram_unsafe_set(a, t);
      ++a;
    }
  }
  text_draw_unsafe(0x2000 + 8 * 32 + ((32 - sizeof(GAME_TITLE) + 1) / 2), GAME_TITLE);
  text_draw_unsafe(0x2000 + 13 * 32 + 10, "1P START - A");
  text_draw_unsafe(0x2000 + 15 * 32 + 10, "2P TURNS - B");
  text_draw_unsafe(0x2000 + 20 * 32 + 10, "HI");
  digits_unsafe(0x2000 + 20 * 32 + 13, hiscore);
  ppu_scroll(0, 0);
  oam_clear();
  ppu_on_all();
}

/* ── GAME LOGIC (clay) — paint the level from the column map ───────────────
 * Painted into BOTH nametables (vertical mirroring puts NT0 + NT1 side by
 * side = a 512-px canvas). Identical copies + a 256-px-periodic level make
 * the uint8 scroll wrap PERFECTLY seamless: the visible window always shows
 * the same content at world x mod 256, so the run loops forever. */
static void paint_field(void) {
  uint16_t base, a;
  uint8_t nt, r, c, t, g;
  ppu_off();
  for (nt = 0; nt < 2; nt++) {
    base = nt ? 0x2400 : 0x2000;
    a = base;
    for (c = 0; c < 32; c++) { vram_unsafe_set(a, 0); ++a; }          /* row 0: overscan */
    for (c = 0; c < 32; c++) { vram_unsafe_set(a, 0); ++a; }          /* row 1: HUD text */
    for (c = 0; c < 32; c++) { vram_unsafe_set(a, BG_HUDBAR); ++a; }  /* row 2: bar      */
    for (r = HUD_ROWS; r < 30; r++) {
      for (c = 0; c < 32; c++) {
        g = ground_row[c];
        t = 0;
        if (r == plat_row[c]) t = BG_GRASS;          /* floating slab     */
        else if (g != NO_GROUND) {
          if (r == g) t = BG_GRASS;                  /* ground surface    */
          else if (r > g) t = BG_DIRT;               /* ground body       */
        }
        if (t == 0 && r >= 4 && r <= 9) {
          if (((r * 7 + c * 5) & 15) == 0) t = BG_CLOUD;
        }
        vram_unsafe_set(a, t);
        ++a;
      }
    }
    /* Attribute table → palette 0 everywhere. CIRAM powers on as garbage;
     * with our identical BG sub-palettes it wouldn't show, but clear it so
     * forks that diverge the palettes don't inherit a latent bug. */
    a = base + 0x3C0;
    for (c = 0; c < 64; c++) { vram_unsafe_set(a, 0); ++a; }
  }
  ppu_scroll(0, 0);
  oam_clear();
  ppu_on_all();
  /* Labels go through the queued path once rendering is on. */
  draw_hud_labels();
}

/* ── GAME LOGIC (clay) — the game-over results screen ── */
static void paint_over(void) {
  uint16_t a = 0x2000;
  uint16_t i;
  ppu_off();
  for (i = 0; i < 960; i++) { vram_unsafe_set(a, 0); ++a; }
  text_draw_unsafe(0x2000 +  8 * 32 + 11, "GAME OVER");
  text_draw_unsafe(0x2000 + 12 * 32 +  9, "P1");
  digits_unsafe(0x2000 + 12 * 32 + 13, p_score[0]);
  if (two_player) {
    text_draw_unsafe(0x2000 + 14 * 32 + 9, "P2");
    digits_unsafe(0x2000 + 14 * 32 + 13, p_score[1]);
  }
  text_draw_unsafe(0x2000 + 17 * 32 +  9, "HI");
  digits_unsafe(0x2000 + 17 * 32 + 13, hiscore);
  text_draw_unsafe(0x2000 + 21 * 32 +  9, "START - TITLE");
  ppu_scroll(0, 0);
  oam_clear();
  ppu_on_all();
}

/* ── GAME LOGIC (clay) — coins + spikes (sprite objects in the world) ── */
static const uint8_t coin_heights[4] = { 184, 160, 128, 152 };
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

/* ── GAME LOGIC (clay) — start a turn / a run ── */
static void begin_turn(void) {
  px = 24;
  py_q44 = (uint16_t)(GROUND_TOP - 8) << 4;
  vy_q44 = 0;
  on_ground = 1;
  scroll_x = 0;
  dist_sub = 0;
  coin_x[0] =  88; coin_y[0] = 184;
  coin_x[1] = 152; coin_y[1] = 160;
  coin_x[2] = 216; coin_y[2] = 128;
  spike_x[0] = 136; spike_active[0] = 1;   /* both anchored on ground at  */
  spike_x[1] = 224; spike_active[1] = 1;   /* scroll 0 — see ground_row   */
  turn_pause = 48;                         /* "P1/P2 ready" breather      */
  prev_pad = 0xFF;                         /* swallow held buttons across *
                                            * the turn change             */
  ppu_scroll(0, 0);
  draw_hud();
}

static void start_game(uint8_t players) {
  two_player = players;
  cur_player = 0;
  p_score[0] = p_score[1] = 0;
  p_lives[0] = START_LIVES;
  p_lives[1] = players ? START_LIVES : 0;
  paint_field();
  begin_turn();
  sound_play_tone(0, 0x0FD, 8, 8);         /* start jingle (A4)           */
  state = ST_PLAY;
}

static void game_over(void) {
  uint16_t best = p_score[0];
  if (two_player && p_score[1] > best) best = p_score[1];
  if (best > hiscore) {
    hiscore = best;
    /* ── HARDWARE IDIOM (load-bearing) — persists via battery PRG-RAM at
     * $6000; works because the crt0's iNES header sets the BATTERY bit.
     * See nes_runtime.c for the magic+checksum layout. ── */
    hiscore_save(hiscore);
  }
  state = ST_OVER;
  paint_over();
}

/* ── GAME LOGIC (clay) — death + alternating-turn handoff ── */
static void kill_player(void) {
  uint8_t other;
  sound_play_noise(12, 12, 14);
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
 * One-way platforms, classic NES style: only catch the player while FALLING
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
    top = r << 3;
    if ((uint8_t)(feet + 1) >= top && feet <= (uint8_t)(top + 4)) return top;
  }
  r = ground_row[c];
  if (r != NO_GROUND) {
    top = r << 3;
    if ((uint8_t)(feet + 1) >= top && feet <= (uint8_t)(top + 4)) return top;
  }
  return 0;
}

void main(void) {
  uint8_t i, pad, delta, y8, feet, c0, c1, top, killed;
  uint8_t player_y;

  /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
   * Init order: PPU off → CHR upload → palette → nametable (raw writes) →
   * OAM clear → rendering on. CHR/palette/nametable writes REQUIRE the PPU
   * off (raw $2007 traffic during rendering corrupts the address latch
   * mid-frame). The runtime's ppu_off/ppu_on_all pair owns the PPUCTRL/
   * PPUMASK bits — don't poke those registers directly alongside it. */
  ppu_off();
  chr_ram_upload(0x0000, tile_blank,       16);
  chr_ram_upload(0x0010, tile_player_idle, 16);
  chr_ram_upload(0x0020, tile_player_jump, 16);
  chr_ram_upload(0x0030, tile_coin,        16);
  chr_ram_upload(0x0040, tile_spike,       16);
  chr_ram_upload(0x0050, tile_mark,        16);
  chr_ram_upload(0x1010, bg_tile_cloud,    16);
  chr_ram_upload(0x1020, bg_tile_dirt,     16);
  chr_ram_upload(0x1030, bg_tile_grass,    16);
  chr_ram_upload(0x1040, bg_tile_hudbar,   16);
  font_upload();
  palette_load(palette);
  sound_init();

  hiscore = hiscore_load();   /* battery SRAM — 0 on first boot */
  state = ST_TITLE;
  paint_title();

  for (;;) {
    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: A = 1P, B = 2P alternating turns ── */
      oam_clear();
      ppu_wait_nmi();
      sound_music_tick();
      pad = pad_poll(0);
      if ((pad & PAD_A) && !(prev_pad & PAD_A)) start_game(0);
      else if ((pad & PAD_B) && !(prev_pad & PAD_B)) start_game(1);
      else if ((pad & PAD_START) && !(prev_pad & PAD_START)) start_game(0);
      prev_pad = pad;
      continue;
    }

    if (state == ST_OVER) {
      /* Results screen (scroll 0, no split needed); START or A → title. */
      oam_clear();
      ppu_wait_nmi();
      sound_music_tick();
      pad = pad_poll(0);
      if ((pad & (PAD_START | PAD_A)) && !(prev_pad & (PAD_START | PAD_A))) {
        state = ST_TITLE;
        paint_title();
      }
      prev_pad = pad;
      continue;
    }

    /* ── ST_PLAY ─────────────────────────────────────────────────────── */

    /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
     * Stage ALL sprites BEFORE ppu_wait_nmi(). The NMI DMAs shadow OAM →
     * real OAM at the START of vblank, copying whatever shadow OAM holds AT
     * THAT MOMENT. Stage-then-wait; flipping it shows stale/empty sprites.
     * Sprite 0 (the split marker) must be staged FIRST — OAM order is
     * oam_spr call order, and the split idiom needs it at index 0. */
    player_y = (uint8_t)(py_q44 >> 4);
    oam_clear();
    stage_sprite0();
    /* Blink the player during the turn-change breather. */
    if (turn_pause == 0 || (turn_pause & 4))
      oam_spr(px, player_y,
              on_ground ? TILE_PLAYER_IDLE : TILE_PLAYER_JUMP, PLAYER_PAL);
    for (i = 0; i < NUM_COINS; i++)
      oam_spr(coin_x[i], coin_y[i], TILE_COIN, COIN_PAL);
    for (i = 0; i < NUM_SPIKES; i++)
      if (spike_active[i]) oam_spr(spike_x[i], SPIKE_Y, TILE_SPIKE, SPIKE_PAL);

    ppu_wait_nmi();
    split_after_hud();          /* the sprite-0 split — every frame */
    sound_music_tick();

    if (turn_pause) {           /* freeze gameplay, keep the frame honest */
      --turn_pause;
      continue;
    }

    /* ── GAME LOGIC (clay) from here down ──────────────────────────────
     * Input — the CURRENT player's controller (alternating turns: P2 is
     * on controller 2). Past SCROLL_WALL the world scrolls instead of the
     * player (the camera never scrolls back — the classic one-way camera). */
    pad = pad_poll(cur_player);
    delta = 0;
    if (pad & PAD_RIGHT) {
      if (px < SCROLL_WALL) px += MOVE_SPEED;
      else { scroll_x += MOVE_SPEED; delta = MOVE_SPEED; }
    }
    if ((pad & PAD_LEFT) && px > 8) px -= MOVE_SPEED;
    if ((pad & PAD_A) && !(prev_pad & PAD_A) && on_ground) {
      vy_q44 = JUMP_VEL_Q44;
      on_ground = 0;
      sound_play_tone(0, 0x150, 6, 6);                   /* jump whoop    */
    }
    prev_pad = pad;

    /* World objects drift left as the level scrolls (world-anchored). */
    if (delta) {
      dist_sub += delta;
      if (dist_sub >= 64) {                              /* distance pay  */
        dist_sub -= 64;
        ++p_score[cur_player];
        draw_hud();
      }
      for (i = 0; i < NUM_COINS; i++) {
        if (coin_x[i] < 16 + delta) respawn_coin(i);
        else coin_x[i] -= delta;
      }
      for (i = 0; i < NUM_SPIKES; i++) {
        if (!spike_active[i]) continue;
        if (spike_x[i] < 16 + delta) spike_active[i] = 0;
        else spike_x[i] -= delta;
      }
    }
    for (i = 0; i < NUM_SPIKES; i++)
      if (!spike_active[i]) try_spawn_spike(i);

    /* Physics: gravity + sub-pixel Y. */
    if (vy_q44 < MAX_VY_Q44) vy_q44 += GRAVITY_Q44;
    py_q44 += vy_q44;
    y8 = (uint8_t)(py_q44 >> 4);

    /* Fell into a pit (below the screen) → lose the turn. */
    if (y8 >= 232) {
      kill_player();
      continue;
    }

    /* Landing — probe the two level columns under the player's feet. */
    if (vy_q44 >= 0) {
      feet = y8 + 8;
      c0 = (uint8_t)(px + scroll_x) >> 3;
      c1 = (uint8_t)(px + scroll_x + 7) >> 3;
      top = land_top(c0, feet);
      if (top == 0) top = land_top(c1, feet);
      if (top) {
        py_q44 = (uint16_t)(top - 8) << 4;
        vy_q44 = 0;
        if (!on_ground) sound_play_tone(1, 0x2A0, 3, 2); /* landing thud  */
        on_ground = 1;
      } else {
        on_ground = 0;                                   /* walked off    */
      }
    }

    /* Coins (collect) + spikes (death). */
    for (i = 0; i < NUM_COINS; i++) {
      if (dist8(coin_x[i], px) < 8 && dist8(coin_y[i], y8) < 8) {
        p_score[cur_player] += 10;
        sound_play_tone(0, 0x0D6, 8, 5);                 /* coin ping     */
        draw_hud();
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
  }
}
