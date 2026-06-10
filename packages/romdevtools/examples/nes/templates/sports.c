/* ── sports.c — NES versus sports game (complete example game) ───────────────
 *
 * A COMPLETE, working game — COURT CLASH, a head-to-head court game (Pong
 * lineage): title screen, 1P vs CPU and 2P simultaneous versus, first-to-5
 * match flow with a result screen, queued-text HUD, music + SFX, and a
 * battery-backed record (longest win streak vs the CPU).
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented NES footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — court art, ball physics, CPU skill, scoring rules:
 *     reshape freely.
 *
 * What depends on what:
 *   nes_runtime.{h,c} — rendering/input/sound/text/hi-score library.
 *   chr-ram-runtime.crt0.s — boot + NMI + iNES header (BATTERY bit feeds
 *     hiscore_load/save). Load-bearing; edit with TROUBLESHOOTING open.
 *
 * Frame budget (NTSC, 60fps): 2 paddles + 1 ball + 2 paddle collision tests
 * + a handful of queued HUD writes — a fraction of one frame even on the
 * 1.79MHz 6502. Plenty of headroom for fancier ball physics.
 */

#include "nes_runtime.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "COURT CLASH"

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile art. Each 8x8 tile = 16 bytes: 8 plane-0 rows then 8 plane-1 rows
 * (2bpp — plane0-only pixels use colour 1, both planes = colour 3). */
static const uint8_t tile_blank[16]  = { 0 };
/* Paddle = solid 4px-wide column; players stack 3 of these (24px tall). */
static const uint8_t tile_paddle[16] = {
  0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C,
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t tile_ball[16] = {
  0x00, 0x3C, 0x7E, 0x7E, 0x7E, 0x7E, 0x3C, 0x00,
  0,    0,    0,    0,    0,    0,    0,    0,
};
/* Court BG tiles (BACKGROUND pattern table $1000 — separate from the sprite
 * table at $0000; the runtime's PPUCTRL setup makes that split):
 *   BG_WALL  — solid rail (colour 1): the top/bottom court boundaries.
 *   BG_NET   — dashed vertical bar (colour 1): the centre net.
 *   BG_FLOOR — faint hatch (colour 2): the court surface, so the arena
 *              reads as a court instead of sprites on flat black. */
static const uint8_t tile_wall[16] = {
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t tile_net[16] = {
  0x18, 0x18, 0x00, 0x00, 0x18, 0x18, 0x00, 0x00,
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t tile_floor[16] = {
  0,    0,    0,    0,    0,    0,    0,    0,
  0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55,
};
#define BG_WALL  1   /* BG slot 1 → CHR $1010 */
#define BG_NET   2   /* BG slot 2 → CHR $1020 */
#define BG_FLOOR 3   /* BG slot 3 → CHR $1030 */

/* Sprite pattern-table slots ($0000). The font lives at BG $40+ — uploaded
 * by font_upload(), used by all the text_draw* calls. */
#define T_PADDLE 1
#define T_BALL   2

static const uint8_t palette[32] = {
  /* BG: near-black backdrop, white rails/net (idx1), dark-green floor (idx2).
   * The font also draws with idx1 → white text everywhere. */
  0x0F, 0x30, 0x1A, 0x00,
  0x0F, 0x30, 0x1A, 0x00,
  0x0F, 0x30, 0x1A, 0x00,
  0x0F, 0x30, 0x1A, 0x00,
  /* Sprites: pal 0 = P1 (blue), pal 1 = P2/CPU (red), pal 2 = ball (white) */
  0x0F, 0x21, 0x11, 0x30,
  0x0F, 0x16, 0x06, 0x30,
  0x0F, 0x30, 0x10, 0x00,
  0x0F, 0x30, 0x10, 0x00,
};

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Court geometry + match rules. The court is framed by BG rails on
 * nametable rows 2 and 27; COURT_TOP/BOT keep the ball between them. */
#define PADDLE_H   24            /* 3 stacked 8px sprites */
#define PADDLE_X1  16            /* P1 — left side */
#define PADDLE_X2  232           /* P2/CPU — right side */
#define COURT_TOP  24            /* first pixel row below the top rail */
#define COURT_BOT  216           /* first pixel row of the bottom rail */
#define BALL_W     8
#define BALL_H     8
#define WIN_SCORE  5             /* first to 5 takes the match */
#define P1_PAL     0
#define P2_PAL     1
#define BALL_PAL   2

static int16_t p1y, p2y;         /* paddle top Y (int16: collision math) */
static int16_t bx, by;           /* ball position */
static int8_t  bdx, bdy;         /* ball velocity (px/frame) */
static uint8_t score_p1, score_p2;
static uint8_t serve_timer;      /* freeze frames between points */
static uint8_t two_player;       /* title pick: 0 = vs CPU, 1 = 2P versus */
static uint8_t streak;           /* current 1P-vs-CPU win streak (RAM) */
static uint16_t best_streak;     /* battery-backed record — see end_match */
static uint8_t new_record;       /* result screen shows NEW RECORD */

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;

/* ── GAME LOGIC (clay) — xorshift16 PRNG (~tens of cycles per call).
 * A versus game NEEDS this: the NES is fully deterministic, so without a
 * noise source two fixed strategies lock into an infinite rally loop (the
 * exact same 600-frame cycle, forever). random8() is ticked once per play
 * frame so identical game states a few seconds apart still diverge. */
static uint16_t rng = 0xC0A7;
static uint8_t random8(void) {
  uint16_t r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (uint8_t)r;
}

/* ── GAME LOGIC (clay) — serve: ball to centre, toward the chosen side ── */
static void serve_ball(uint8_t to_left) {
  bx = 124;
  by = 116;
  bdx = to_left ? -2 : 2;
  bdy = ((score_p1 + score_p2) & 1) ? -1 : 1;  /* alternate the angle */
  serve_timer = 30;                            /* half-second breather */
}

/* ── GAME LOGIC (clay) — HUD (queued writes; the NMI commits ≤16/vblank) ──
 * OVERSCAN RULE: most NTSC displays/cores crop the top 8 scanlines, so
 * nametable row 0 is invisible — HUD text lives on row 1, never row 0. */
static void draw_hud(void) {
  text_draw_u16(0, 4, 1, score_p1);
  text_draw_u16(0, 23, 1, score_p2);
}

static void draw_hud_labels(void) {
  text_draw(0, 1, 1, "P1");
  text_draw(0, 29, 1, two_player ? "P2" : "CPU");
}

/* ── GAME LOGIC (clay) — the title screen ──────────────────────────────────
 * Painted with the PPU OFF (text_draw_unsafe = raw VRAM writes; the queued
 * variant would deadlock with rendering disabled — see TROUBLESHOOTING). */
static void paint_title(void) {
  uint8_t r, c;
  ppu_off();
  /* Carpet the screen with court floor; keep rows 0-1 blank (row 0 is
   * overscan-cropped, row 1 is where the in-game HUD will live). */
  for (r = 0; r < 30; r++)
    for (c = 0; c < 32; c++)
      vram_unsafe_set((uint16_t)(0x2000 + r * 32 + c), (r == 0 || r == 1) ? 0 : BG_FLOOR);
  text_draw_unsafe(0x2000 + 8 * 32 + ((32 - sizeof(GAME_TITLE) + 1) / 2), GAME_TITLE);
  text_draw_unsafe(0x2000 + 13 * 32 + 9, "1P VS CPU - A");
  text_draw_unsafe(0x2000 + 15 * 32 + 9, "2P VERSUS - B");
  /* Persistent record line — the battery-backed best CPU-mode win streak. */
  text_draw_unsafe(0x2000 + 20 * 32 + 7, "BEST STREAK");
  {
    uint16_t v = best_streak;
    uint8_t d[5], i;
    for (i = 0; i < 5; i++) { d[i] = v % 10; v /= 10; }
    for (i = 0; i < 5; i++) vram_unsafe_set((uint16_t)(0x2000 + 20 * 32 + 19 + i), (uint8_t)(0x40 + d[4 - i]));
  }
  ppu_scroll(0, 0);
  oam_clear();
  ppu_on_all();
}

/* ── GAME LOGIC (clay) — paint the court, PPU off (match start only).
 * Once rendering is back on, ALL background changes must go through the
 * QUEUED path (tile_set / text_draw / text_draw_u16) — a raw $2007 write
 * mid-frame corrupts the PPU address latch and shears the screen. */
static void paint_court(void) {
  uint8_t r, c;
  ppu_off();
  for (c = 0; c < 32; c++) {
    vram_unsafe_set((uint16_t)(0x2000 + 0 * 32 + c), 0);        /* row 0: overscan-cropped */
    vram_unsafe_set((uint16_t)(0x2000 + 1 * 32 + c), 0);        /* row 1: HUD (queued draws fill it) */
    vram_unsafe_set((uint16_t)(0x2000 + 2 * 32 + c), BG_WALL);  /* top rail */
    vram_unsafe_set((uint16_t)(0x2000 + 27 * 32 + c), BG_WALL); /* bottom rail */
  }
  for (r = 3; r < 27; r++)
    for (c = 0; c < 32; c++)
      vram_unsafe_set((uint16_t)(0x2000 + r * 32 + c), (c == 15) ? BG_NET : BG_FLOOR);
  for (r = 28; r < 30; r++)
    for (c = 0; c < 32; c++)
      vram_unsafe_set((uint16_t)(0x2000 + r * 32 + c), BG_FLOOR);
  ppu_scroll(0, 0);
  oam_clear();
  ppu_on_all();
  /* Labels + scores go through the queued path now rendering is on. */
  draw_hud_labels();
  draw_hud();
}

/* ── GAME LOGIC (clay) — start a match ── */
static void start_match(uint8_t players) {
  two_player = players;
  p1y = 100; p2y = 100;
  score_p1 = 0; score_p2 = 0;
  new_record = 0;
  serve_ball(0);
  paint_court();
  state = ST_PLAY;
}

/* ── GAME LOGIC (clay) — match over: result + record bookkeeping.
 * Persistence choice: for a VERSUS sports game a raw hi-score is
 * meaningless (every match ends 5-x), so we persist the longest 1P win
 * streak against the CPU — the stat a returning player actually chases.
 * 2P matches never touch it (humans beating each other isn't a record). */
static void end_match(void) {
  if (score_p1 >= WIN_SCORE) {
    text_draw(0, 12, 14, "P1 WINS");
    if (!two_player) {
      ++streak;
      if (streak > best_streak) {
        best_streak = streak;
        new_record = 1;
        /* ── HARDWARE IDIOM (load-bearing) — persists via battery PRG-RAM
         * at $6000; works because the crt0's iNES header sets the BATTERY
         * bit. See nes_runtime.c for the magic+checksum layout. ── */
        hiscore_save(best_streak);
      }
    }
  } else if (two_player) {
    text_draw(0, 12, 14, "P2 WINS");
  } else {
    text_draw(0, 12, 14, "CPU WINS");
    streak = 0;                  /* the streak dies with the loss */
  }
  if (new_record) text_draw(0, 11, 16, "NEW RECORD");
  text_draw(0, 10, 18, "PRESS START");
  /* End-of-match whistle: two quick descending tones. */
  sound_play_tone(0, 0x0D6, 10, 8);
  sound_play_tone(1, 0x1AA, 10, 12);
  state = ST_OVER;
}

/* ── GAME LOGIC (clay) — one point scored ── */
static void score_point(uint8_t for_p1) {
  if (for_p1) ++score_p1; else ++score_p2;
  sound_play_noise(5, 8, 8);
  draw_hud();                    /* queued — safe while rendering */
  if (score_p1 >= WIN_SCORE || score_p2 >= WIN_SCORE) end_match();
  else serve_ball(for_p1);       /* winner of the point receives */
}

/* ── GAME LOGIC (clay) — paddle hit: deflect by where the ball struck.
 * Centre = flat-ish, edges = steep. Max |bdy| is 2 — the CPU moves at 1,
 * so an edge hit is exactly how a human beats it. A ±1 random "spin" on
 * every return keeps rallies from repeating (see the PRNG note above). */
static void deflect(int16_t paddle_y) {
  int16_t rel = (by + BALL_H / 2) - (paddle_y + PADDLE_H / 2);
  bdy = (int8_t)(rel >> 3);
  bdy += (int8_t)((random8() & 2) - 1);     /* spin: -1 or +1 */
  if (bdy > 2) bdy = 2;
  if (bdy < -2) bdy = -2;
  if (bdy == 0) bdy = (rel < 0) ? -1 : 1;   /* never return a flat ball */
  sound_play_tone(0, 0x150, 8, 4);
}

void main(void) {
  uint8_t pad, prev_pad = 0;

  /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
   * Init order: PPU off → CHR upload → palette → nametable (raw writes) →
   * OAM clear → rendering on. CHR/palette/nametable writes REQUIRE the PPU
   * off (raw $2007 traffic during rendering corrupts the address latch
   * mid-frame). The runtime's ppu_off/ppu_on_all pair owns the PPUCTRL/
   * PPUMASK bits — don't poke those registers directly alongside it. */
  ppu_off();
  chr_ram_upload(T_PADDLE * 16, tile_paddle, 16);
  chr_ram_upload(T_BALL * 16, tile_ball, 16);
  chr_ram_upload(0x1010, tile_wall, 16);
  chr_ram_upload(0x1020, tile_net, 16);
  chr_ram_upload(0x1030, tile_floor, 16);
  font_upload();                 /* '0'-'9'=$40, 'A'-'Z'=$4A, '-'=$64 (BG table) */
  palette_load(palette);
  sound_init();

  best_streak = hiscore_load();  /* battery SRAM — 0 on first boot */
  streak = 0;
  state = ST_TITLE;
  paint_title();

  for (;;) {
    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: A/START = 1P vs CPU, B = 2P versus ── */
      oam_clear();
      ppu_wait_nmi();
      sound_music_tick();
      pad = pad_poll(0);
      if ((pad & PAD_A) && !(prev_pad & PAD_A)) start_match(0);
      else if ((pad & PAD_B) && !(prev_pad & PAD_B)) start_match(1);
      else if ((pad & PAD_START) && !(prev_pad & PAD_START)) start_match(0);
      prev_pad = pad;
      continue;
    }

    if (state == ST_OVER) {
      /* Freeze the final scene; START or A returns to the title. Sprites
       * still need restaging every frame — oam_clear + the same draws —
       * because the NMI DMAs shadow OAM whether you updated it or not. */
      {
        uint8_t i;
        oam_clear();
        for (i = 0; i < PADDLE_H / 8; i++) oam_spr(PADDLE_X1, (uint8_t)(p1y + i * 8), T_PADDLE, P1_PAL);
        for (i = 0; i < PADDLE_H / 8; i++) oam_spr(PADDLE_X2, (uint8_t)(p2y + i * 8), T_PADDLE, P2_PAL);
      }
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

    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * Stage ALL sprites BEFORE ppu_wait_nmi(). The NMI DMAs shadow OAM →
     * real OAM at the START of vblank, copying whatever shadow OAM holds AT
     * THAT MOMENT. Stage-then-wait; flipping it shows stale/empty sprites.
     * OAM slot = oam_spr call order: P1 paddle fills slots 0-2, P2 paddle
     * 3-5, ball 6 — every frame, deterministically. */
    {
      uint8_t i;
      oam_clear();
      for (i = 0; i < PADDLE_H / 8; i++)
        oam_spr(PADDLE_X1, (uint8_t)(p1y + i * 8), T_PADDLE, P1_PAL);
      for (i = 0; i < PADDLE_H / 8; i++)
        oam_spr(PADDLE_X2, (uint8_t)(p2y + i * 8), T_PADDLE, P2_PAL);
      oam_spr((uint8_t)bx, (uint8_t)by, T_BALL, BALL_PAL);
    }

    ppu_wait_nmi();
    sound_music_tick();

    /* ── GAME LOGIC (clay) from here down ── */
    random8();                   /* tick the noise source every play frame */

    /* P1 — port 0, up/down, 2px/frame. (prev_pad tracks through play so
     * the result screen's edge-detect doesn't eat a held button.) */
    pad = pad_poll(0);
    prev_pad = pad;
    if ((pad & PAD_UP)   && p1y > COURT_TOP)            p1y -= 2;
    if ((pad & PAD_DOWN) && p1y < COURT_BOT - PADDLE_H) p1y += 2;

    if (two_player) {
      /* P2 — port 1, same speed: a fair simultaneous-versus match. */
      uint8_t pad2 = pad_poll(1);
      if ((pad2 & PAD_UP)   && p2y > COURT_TOP)            p2y -= 2;
      if ((pad2 & PAD_DOWN) && p2y < COURT_BOT - PADDLE_H) p2y += 2;
    } else {
      /* CPU — chases the ball centre at 1px/frame (half player speed) with
       * a small dead zone. Beatable by design: steep deflections outrun it. */
      int16_t target = by + BALL_H / 2 - PADDLE_H / 2;
      if (p2y + 2 < target && p2y < COURT_BOT - PADDLE_H) p2y += 1;
      else if (p2y > target + 2 && p2y > COURT_TOP)       p2y -= 1;
    }

    /* Ball update (frozen during the post-point serve pause). */
    if (serve_timer > 0) {
      --serve_timer;
      continue;
    }
    bx += bdx;
    by += bdy;

    /* Rail bounce. */
    if (by < COURT_TOP)          { by = COURT_TOP;          bdy = -bdy; sound_play_tone(1, 0x100, 8, 4); }
    if (by + BALL_H > COURT_BOT) { by = COURT_BOT - BALL_H; bdy = -bdy; sound_play_tone(1, 0x100, 8, 4); }

    /* Paddle collisions (direction-gated so the ball can't double-hit). */
    if (bdx < 0
        && bx <= PADDLE_X1 + 8 && bx + BALL_W >= PADDLE_X1
        && by + BALL_H > p1y && by < p1y + PADDLE_H) {
      bdx = -bdx;
      bx = PADDLE_X1 + 8;
      deflect(p1y);
    }
    if (bdx > 0
        && bx + BALL_W >= PADDLE_X2 && bx <= PADDLE_X2 + 8
        && by + BALL_H > p2y && by < p2y + PADDLE_H) {
      bdx = -bdx;
      bx = PADDLE_X2 - BALL_W;
      deflect(p2y);
    }

    /* Off either side → point. */
    if (bx < 4)   score_point(0);   /* past P1 → right side scores */
    if (bx > 244) score_point(1);   /* past P2 → P1 scores */
  }
}
