/* ── shmup.c — NES vertical shooter (complete example game) ──────────────────
 *
 * A COMPLETE, working game — title screen, 1P and 2P co-op modes, lives,
 * score + persistent hi-score (battery SRAM), music + SFX, and the NES's
 * signature sprite-0-hit split (fixed HUD bar over a drifting starfield).
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented NES footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — enemy patterns, scoring, tuning, art: reshape freely.
 *
 * What depends on what:
 *   nes_runtime.{h,c} — rendering/input/sound/text/hi-score library.
 *   chr-ram-runtime.crt0.s — boot + NMI + iNES header (BATTERY bit feeds
 *     hiscore_load/save). Load-bearing; edit with TROUBLESHOOTING open.
 *
 * Frame budget (NTSC, 60fps): the whole update (2 ships × 6 bullets × 6
 * enemies AABB ≈ 72 checks worst case) is comfortably inside one frame.
 */

#include "nes_runtime.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "NOVA SENTRY"

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile art. Each 8x8 tile = 16 bytes: 8 plane-0 rows then 8 plane-1 rows
 * (2bpp — plane0-only pixels use colour 1, both planes = colour 3). */
static const uint8_t tile_blank[16] = { 0 };
static const uint8_t tile_ship[16] = {
  0x18, 0x3C, 0x7E, 0xFF, 0xFF, 0x7E, 0x3C, 0x18,
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t tile_bullet[16] = {
  0x00, 0x18, 0x3C, 0x3C, 0x3C, 0x3C, 0x18, 0x00,
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t tile_enemy[16] = {
  0x81, 0x42, 0x24, 0xFF, 0xFF, 0x24, 0x42, 0x81,
  0,    0,    0,    0,    0,    0,    0,    0,
};
/* Starfield BG tiles (BACKGROUND pattern table $1000 — separate from the
 * sprite table at $0000; the runtime's PPUCTRL setup makes that split). */
static const uint8_t tile_dust[16] = {
  0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA,
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t tile_star[16] = {
  0x00, 0x08, 0x00, 0x42, 0x00, 0x00, 0x20, 0x01,
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t tile_brite[16] = {
  0x00, 0x00, 0x10, 0x38, 0x10, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x10, 0x38, 0x10, 0x00, 0x00, 0x00,
};
/* A solid tile for the HUD bar — sprite 0 must overlap an OPAQUE BG pixel
 * for the sprite-0 hit to fire (see the split idiom below). */
static const uint8_t tile_hudbar[16] = {
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
  0,    0,    0,    0,    0,    0,    0,    0,
};
#define BG_DUST   1
#define BG_STAR   2
#define BG_BRITE  3
#define BG_HUDBAR 4

static const uint8_t palette[32] = {
  /* BG: near-black backdrop, dim white stars; pal 1 = HUD (dark bar) */
  0x0F, 0x10, 0x20, 0x30,
  0x0F, 0x00, 0x10, 0x30,
  0x0F, 0x10, 0x20, 0x30,
  0x0F, 0x10, 0x20, 0x30,
  /* Sprites: ship1 blue/white, bullets yellow, enemies red, ship2 green */
  0x0F, 0x21, 0x32, 0x30,
  0x0F, 0x37, 0x27, 0x16,
  0x0F, 0x16, 0x06, 0x36,
  0x0F, 0x2A, 0x1A, 0x0A,
};

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Object pools — fixed slots, no allocation (there is no heap worth having
 * on a 1.79MHz CPU with 2KB of work RAM). */
#define MAX_BULLETS 6
#define MAX_ENEMIES 6
#define TILE_SHIP    1
#define TILE_BULLET  2
#define TILE_ENEMY   3
#define SHIP1_PAL    0
#define SHIP2_PAL    3
#define BULLET_PAL   1
#define ENEMY_PAL    2
#define START_LIVES  3
/* HUD layout (mind the OVERSCAN: most NTSC displays/cores crop the top 8
 * scanlines, so nametable row 0 is invisible — never put text there):
 *   row 0 — blank (cropped by overscan)
 *   row 1 — HUD text (LV / SC / HI)
 *   row 2 — solid bar: the visual divider AND sprite 0's opaque anchor
 *   row 3+ — the scrolling playfield */
#define HUD_ROWS     3

static uint8_t bullet_active[MAX_BULLETS];
static uint8_t bullet_x[MAX_BULLETS];
static uint8_t bullet_y[MAX_BULLETS];
static uint8_t enemy_active[MAX_ENEMIES];
static uint8_t enemy_x[MAX_ENEMIES];
static uint8_t enemy_y[MAX_ENEMIES];

/* Players: index 0 = P1, 1 = P2 (only in 2P co-op mode). */
static uint8_t ship_x[2], ship_y[2], ship_alive[2], fire_cd[2];
static uint8_t two_player;       /* mode chosen on the title screen */
static uint8_t lives;            /* shared pool in co-op (arcade style) */
static uint16_t score;
static uint16_t hiscore;
static uint8_t spawn_timer;
static uint8_t scroll_x;         /* starfield drift (split-scrolled below HUD) */
static uint16_t rng = 0xACE1;

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

static void fire_bullet(uint8_t p) {
  uint8_t i;
  for (i = 0; i < MAX_BULLETS; i++) {
    if (!bullet_active[i]) {
      bullet_active[i] = 1;
      bullet_x[i] = ship_x[p];
      bullet_y[i] = ship_y[p] - 4;
      sound_play_tone(0, 0x100, 6, 4);
      return;
    }
  }
}

static void spawn_enemy(void) {
  uint8_t i;
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemy_active[i]) {
      enemy_active[i] = 1;
      /* Spread across the ship's ACTUAL travel (x 8-240), not just the left
       * half. `& 0x7F` capped spawns at x 143 while the ship reaches 240, so
       * a player sitting anywhere right of centre faced no enemies at all and
       * the score never moved -- which makes a forked scaffold look broken
       * when the collision code is fine. 8 + rand%224 covers the whole field. */
      enemy_x[i] = 8 + (uint8_t)(random8() % 224u);
      enemy_y[i] = HUD_ROWS * 8 + 8;       /* spawn below the HUD bar */
      return;
    }
  }
}

/* AABB, both boxes 8x8. */
static uint8_t hits(uint8_t ax, uint8_t ay, uint8_t bx, uint8_t by) {
  uint8_t dx = (ax > bx) ? (ax - bx) : (bx - ax);
  uint8_t dy = (ay > by) ? (ay - by) : (by - ay);
  return (dx < 8) && (dy < 8);
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
 *   3. After ppu_wait_nmi(), spin on PPUSTATUS bit 6: it sets at the exact
 *      pixel where sprite 0's opaque pixel overlaps opaque background.
 *   4. THEN write the playfield scroll to PPUSCROLL — everything below the
 *      HUD renders with the new scroll.
 *
 * Requires: sprite 0 staged FIRST (oam_spr call order = OAM order), an
 *   opaque BG pixel under it, ppu_scroll(0,0) left as the frame scroll, and
 *   this poll running EVERY frame (miss a frame and the field jumps).
 * Mid-frame X-scroll needs only the two PPUSCROLL writes below. (Mid-frame
 *   Y needs the 4-write $2006/$2005 dance — see TROUBLESHOOTING before
 *   attempting; X covers the HUD-over-scrolling-field pattern.)
 * The spin costs a few scanlines of CPU each frame — budget for it. */
#define PPUSTATUS_REG (*(volatile uint8_t *)0x2002)
#define PPUSCROLL_REG (*(volatile uint8_t *)0x2005)
static void split_after_hud(void) {
  uint8_t timeout = 240;
  /* FOOTGUN: the hit flag from the frame JUST RENDERED stays set all the
   * way through vblank — it only clears at the next pre-render line. We're
   * called right after ppu_wait_nmi() (i.e. inside vblank), so polling for
   * "set" alone can exit INSTANTLY on the stale flag and the PPUSCROLL
   * write lands during vblank — scrolling the WHOLE next frame, HUD
   * included (a subtle shear that looks like HUD drift). The classic fix
   * is the two-phase poll: wait for the stale flag to CLEAR (pre-render),
   * then wait for THIS frame's hit to SET. */
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
  oam_spr(4, (HUD_ROWS - 1) * 8, TILE_BULLET, 1);
}

/* ── GAME LOGIC (clay) — HUD text (queued writes; NMI commits next vblank) ── */
static void draw_hud(void) {
  text_draw_u16(0, 9, 1, score);
  text_draw_u16(0, 22, 1, hiscore);
  tile_set(0, 3, 1, 0x40 + lives);          /* lives as a digit */
}

static void draw_hud_labels(void) {
  text_draw(0, 0, 1, "LV");
  text_draw(0, 6, 1, "SC");
  text_draw(0, 16, 1, "HI");
}

/* ── GAME LOGIC (clay) — the title screen ──────────────────────────────────
 * Painted with the PPU OFF (text_draw_unsafe = raw VRAM writes; the queued
 * variant would deadlock with rendering disabled — see TROUBLESHOOTING). */
static void paint_title(void) {
  uint8_t r, c;
  ppu_off();
  /* Clear both HUD + field area to the dust backdrop. */
  for (r = 0; r < 30; r++)
    for (c = 0; c < 32; c++)
      vram_unsafe_set((uint16_t)(0x2000 + r * 32 + c), (r == 0 || r == 1) ? 0 : BG_DUST);
  text_draw_unsafe(0x2000 + 8 * 32 + ((32 - sizeof(GAME_TITLE) + 1) / 2), GAME_TITLE);
  text_draw_unsafe(0x2000 + 13 * 32 + 8,  "1P START - A");
  text_draw_unsafe(0x2000 + 15 * 32 + 8,  "2P CO-OP - B");
  text_draw_unsafe(0x2000 + 20 * 32 + 10, "HI");
  /* hiscore digits painted by hand (queued text needs rendering on) */
  {
    uint16_t v = hiscore;
    uint8_t d[5], i;
    for (i = 0; i < 5; i++) { d[i] = v % 10; v /= 10; }
    for (i = 0; i < 5; i++) vram_unsafe_set((uint16_t)(0x2000 + 20 * 32 + 13 + i), (uint8_t)(0x40 + d[4 - i]));
  }
  ppu_scroll(0, 0);
  oam_clear();
  ppu_on_all();
}

/* ── GAME LOGIC (clay) — start a run ── */
static void paint_field(void) {
  uint8_t r, c, tile;
  ppu_off();
  for (c = 0; c < 32; c++) {
    vram_unsafe_set((uint16_t)(0x2000 + 0 * 32 + c), 0);          /* row 0: overscan-cropped */
    vram_unsafe_set((uint16_t)(0x2000 + 1 * 32 + c), 0);          /* row 1: HUD text (queued draws fill it) */
    vram_unsafe_set((uint16_t)(0x2000 + 2 * 32 + c), BG_HUDBAR);  /* row 2: bar = divider + sprite-0 anchor */
  }
  for (r = HUD_ROWS; r < 30; r++) {
    for (c = 0; c < 32; c++) {
      tile = BG_DUST;
      if (((r * 5 + c * 3) % 7) == 0) tile = BG_STAR;
      if (((r * 3 + c * 7) % 23) == 0) tile = BG_BRITE;
      vram_unsafe_set((uint16_t)(0x2000 + r * 32 + c), tile);
    }
  }
  ppu_scroll(0, 0);
  oam_clear();
  ppu_on_all();
  /* Labels go through the queued path once rendering is on. */
  draw_hud_labels();
  draw_hud();
}

static void start_game(uint8_t players) {
  uint8_t i;
  two_player = players;
  for (i = 0; i < MAX_BULLETS; i++) bullet_active[i] = 0;
  for (i = 0; i < MAX_ENEMIES; i++) enemy_active[i] = 0;
  ship_x[0] = two_player ? 96 : 120; ship_y[0] = 200; ship_alive[0] = 1; fire_cd[0] = 0;
  ship_x[1] = 144;                   ship_y[1] = 200; ship_alive[1] = two_player; fire_cd[1] = 0;
  lives = START_LIVES;
  score = 0;
  spawn_timer = 0;
  scroll_x = 0;
  paint_field();
  state = ST_PLAY;
}

static void game_over(void) {
  if (score > hiscore) {
    hiscore = score;
    /* ── HARDWARE IDIOM (load-bearing) — persists via battery PRG-RAM at
     * $6000; works because the crt0's iNES header sets the BATTERY bit.
     * See nes_runtime.c for the magic+checksum layout. ── */
    hiscore_save(hiscore);
  }
  state = ST_OVER;
  text_draw(0, 11, 14, "GAME OVER");
}

/* ── GAME LOGIC (clay) — per-player update ── */
static void update_ship(uint8_t p) {
  uint8_t pad = pad_poll(p);
  if (!ship_alive[p]) return;
  if ((pad & PAD_LEFT)  && ship_x[p] > 8)   --ship_x[p];
  if ((pad & PAD_RIGHT) && ship_x[p] < 240) ++ship_x[p];
  if ((pad & PAD_UP)    && ship_y[p] > (HUD_ROWS * 8 + 8)) --ship_y[p];
  if ((pad & PAD_DOWN)  && ship_y[p] < 216) ++ship_y[p];
  if ((pad & PAD_A) && fire_cd[p] == 0) {
    fire_bullet(p);
    fire_cd[p] = 8;
  }
  if (fire_cd[p] > 0) --fire_cd[p];
}

void main(void) {
  uint8_t i, pad, prev_pad = 0;

  /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
   * Init order: PPU off → CHR upload → palette → nametable (raw writes) →
   * OAM clear → rendering on. CHR/palette/nametable writes REQUIRE the PPU
   * off (raw $2007 traffic during rendering corrupts the address latch
   * mid-frame). The runtime's ppu_off/ppu_on_all pair owns the PPUCTRL/
   * PPUMASK bits — don't poke those registers directly alongside it. */
  ppu_off();
  chr_ram_upload(0x0000, tile_blank,  16);
  chr_ram_upload(0x0010, tile_ship,   16);
  chr_ram_upload(0x0020, tile_bullet, 16);
  chr_ram_upload(0x0030, tile_enemy,  16);
  chr_ram_upload(0x1010, tile_dust,   16);
  chr_ram_upload(0x1020, tile_star,   16);
  chr_ram_upload(0x1030, tile_brite,  16);
  chr_ram_upload(0x1040, tile_hudbar, 16);
  font_upload();
  palette_load(palette);
  sound_init();

  hiscore = hiscore_load();   /* battery SRAM — 0 on first boot */
  state = ST_TITLE;
  paint_title();

  for (;;) {
    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: A = 1P, B = 2P co-op ── */
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
      /* Freeze the final frame; START or A returns to the title. */
      oam_clear();
      stage_sprite0();
      ppu_wait_nmi();
      split_after_hud();
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
    oam_clear();
    stage_sprite0();
    for (i = 0; i < 2; i++)
      if (ship_alive[i]) oam_spr(ship_x[i], ship_y[i], TILE_SHIP, i ? SHIP2_PAL : SHIP1_PAL);
    for (i = 0; i < MAX_BULLETS; i++)
      if (bullet_active[i]) oam_spr(bullet_x[i], bullet_y[i], TILE_BULLET, BULLET_PAL);
    for (i = 0; i < MAX_ENEMIES; i++)
      if (enemy_active[i]) oam_spr(enemy_x[i], enemy_y[i], TILE_ENEMY, ENEMY_PAL);

    ppu_wait_nmi();
    split_after_hud();          /* the sprite-0 split — every frame */
    sound_music_tick();

    /* ── GAME LOGIC (clay) from here down ── */
    update_ship(0);
    if (two_player) update_ship(1);

    /* Starfield drift (the split makes this not move the HUD). */
    if ((spawn_timer & 3) == 0) ++scroll_x;

    for (i = 0; i < MAX_BULLETS; i++) {
      if (!bullet_active[i]) continue;
      if (bullet_y[i] < HUD_ROWS * 8 + 4) bullet_active[i] = 0;
      else bullet_y[i] -= 4;
    }

    for (i = 0; i < MAX_ENEMIES; i++) {
      if (!enemy_active[i]) continue;
      if (enemy_y[i] >= 224) enemy_active[i] = 0;
      else ++enemy_y[i];
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
            ++score;
            sound_play_noise(8, 8, 6);
            draw_hud();
            break;
          }
        }
      }
    }

    /* Enemies ↔ ships: shared life pool (arcade co-op). */
    {
      uint8_t e, p;
      for (e = 0; e < MAX_ENEMIES; e++) {
        if (!enemy_active[e]) continue;
        for (p = 0; p < 2; p++) {
          if (!ship_alive[p]) continue;
          if (hits(enemy_x[e], enemy_y[e], ship_x[p], ship_y[p])) {
            enemy_active[e] = 0;
            sound_play_noise(12, 12, 12);
            if (lives > 0) --lives;
            draw_hud();
            if (lives == 0) {
              game_over();
            } else {
              /* respawn knockback */
              ship_y[p] = 200;
              ship_x[p] = p ? 144 : (two_player ? 96 : 120);
            }
          }
        }
      }
    }

    ++spawn_timer;
    if (spawn_timer >= 32) {
      spawn_timer = 0;
      spawn_enemy();
    }
  }
}
