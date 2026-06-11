/* ── sports.c — SNES head-to-head court game (complete example game) ─────────
 *
 * A COMPLETE, working game — NET SURGE, a head-to-head court duel (Pong
 * lineage): title screen, 1P vs a beatable CPU and 2P simultaneous versus
 * (controller 2), first-to-5 match flow with a result screen, SPC music +
 * SFX, a PRNG that keeps rallies from looping forever, and a battery-SRAM
 * record (longest win streak vs the CPU) that survives power cycles.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented SNES footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — court art, ball physics, CPU skill, scoring rules:
 *     reshape freely.
 *
 * What depends on what:
 *   data.asm — font + sprite/wallpaper tiles, and sram_read16/sram_write16
 *     (battery SRAM lives at $70:0000, reachable only with long addressing —
 *     that's why they're asm). Load-bearing.
 *   hdr.asm — THIS PROJECT OVERRIDES the stock header to declare battery
 *     SRAM (CARTRIDGETYPE $02 + SRAMSIZE $01). Delete that file and saves
 *     silently stop existing — the build still succeeds.
 *   snes_sfx.{h,c} + snes_sfx_data.asm + apu_blob.bin — the SPC700 sound
 *     driver (music + 2 one-shot samples). #include'd, not separately built.
 *
 * tcc-65816 is C89 — all declarations at block top, no inline `for (u16 i …)`.
 *
 * Frame budget: 7 sprites, 2 collision tests, a few consoleDrawText calls —
 * a tiny fraction of a frame. Plenty of headroom for fancier ball physics.
 */

#include <snes.h>
#include "snes_sfx.c"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "NET SURGE"

extern char tilfont, palfont;       /* console font + text palette (data.asm) */
extern char tilsprite, palsprite;   /* solid 8x8 block tile + OBJ palette     */
extern char tilbg, palbg;           /* wallpaper tile + palette (data.asm)    */

/* consoleVblank() copies the dirty text tilemap to VRAM during VBlank.
 * No public prototype in console.h, so declare it; call once per frame. */
extern void consoleVblank(void);

/* data.asm exports — battery SRAM accessors ($70:0000, long addressing). */
extern u16 sram_read16(u16 offset);
extern void sram_write16(u16 offset, u16 value);

/* BG1 wallpaper map: a full 32x32 screen of the 4-colour tile so the
 * court reads as a real backdrop, not flat blank. Filled at runtime. */
static u16 bg_map[32 * 32];

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * oamSet's FIRST arg is a BYTE OFFSET into OAM, not a slot number: slot N
 * lives at byte offset N*4. Passing the raw slot writes every sprite into
 * OAM bytes 0-9, corrupting each other → black/garbled screen. */
#define SPR(slot) ((slot) << 2)

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Court geometry + match rules. The court is framed by '-' rails drawn on
 * the text BG at rows 4 and 23 (pixels 32-39 and 184-191); COURT_TOP/BOT
 * keep the ball between them. The text grid is 32x28 cells (8px each). */
#define COURT_ROW_TOP  4
#define COURT_ROW_BOT  23
#define COURT_NET_COL  16
#define COURT_TOP   40              /* first pixel row below the top rail    */
#define COURT_BOT   184             /* first pixel row of the bottom rail    */
#define PADDLE_H    24              /* 3 stacked 8x8 sprites                 */
#define BALL_SIZE   8
#define PADDLE_X1   16              /* P1 — left side                        */
#define PADDLE_X2   232             /* P2/CPU — right side                   */
#define WIN_SCORE   5               /* first to 5 takes the match            */

/* SRAM layout: [0]=magic "NS", [2]=best streak, [4]=best ^ 0xA5C3.
 * Magic is written LAST in streak_save so a torn write never validates. */
#define SRAM_MAGIC 0x534Eu

/* Game states — the shell every example shares: title → play → result. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2

static u8 state;
static s16 p1y, p2y;                /* paddle top Y                          */
static s16 bx, by;                  /* ball position                         */
static s8  bdx, bdy;                /* ball velocity (px/frame)              */
static u8 score_p1, score_p2;
static u8 serve_timer;              /* freeze frames between points          */
static u8 two_player;               /* title pick: 0 = vs CPU, 1 = 2P versus */
static u8 streak;                   /* current 1P-vs-CPU win streak (RAM)    */
static u16 best_streak;             /* battery-backed record — see end_match */
static u8 new_record;               /* result screen shows NEW RECORD        */
static u8 sound_ok;
static u16 prev_pad0;
static char nbuf[8];                /* fmt_u16 output                        */

/* ── GAME LOGIC (clay) — xorshift16 PRNG (~tens of cycles per call).
 * A versus game NEEDS this: the SNES is fully deterministic, so without a
 * noise source two fixed strategies lock into an infinite rally loop (the
 * exact same few-hundred-frame cycle, forever — an idle 1P match would
 * never end). random8() is ticked once per play frame so identical game
 * states a few seconds apart still diverge. */
static u16 rng = 0xC0A7;
static u8 random8(void) {
  u16 r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (u8)r;
}

/* ── GAME LOGIC (clay) — battery-SRAM record (see sram_* in data.asm) ─────── */
static u16 streak_load(void) {
  u16 v;
  if (sram_read16(0) != SRAM_MAGIC) return 0;
  v = sram_read16(2);
  if (sram_read16(4) != (u16)(v ^ 0xA5C3u)) return 0;
  return v;
}

static void streak_save(u16 v) {
  sram_write16(2, v);
  sram_write16(4, (u16)(v ^ 0xA5C3u));
  sram_write16(0, SRAM_MAGIC);      /* magic LAST — torn write = no record */
}

/* ── GAME LOGIC (clay) — text helpers ──────────────────────────────────────── */
static void fmt_u16(u16 v) {        /* decimal, no leading zeros, into nbuf */
  char tmp[6];
  u8 n = 0, i;
  do { tmp[n++] = (char)('0' + v % 10); v /= 10; } while (v);
  for (i = 0; i < n; i++) nbuf[i] = tmp[n - 1 - i];
  nbuf[n] = 0;
}

static void clear_row(u16 y) {
  consoleDrawText(0, y, "                                ");
}

static void clear_rows(u16 a, u16 b) {
  u16 y;
  for (y = a; y <= b; y++) clear_row(y);
}

/* ── GAME LOGIC (clay) — serve: ball to centre, toward the chosen side ────── */
static void serve_ball(u8 to_left) {
  bx = 124;
  by = 108;
  bdx = to_left ? -2 : 2;
  bdy = ((score_p1 + score_p2) & 1) ? -1 : 1;  /* alternate the angle */
  serve_timer = 30;                            /* half-second breather */
}

/* ── GAME LOGIC (clay) — HUD: labels row 1, scores redrawn after points ───── */
static void draw_scores(void) {
  nbuf[0] = (char)('0' + score_p1); nbuf[1] = 0;
  consoleDrawText(6, 1, nbuf);
  nbuf[0] = (char)('0' + score_p2);
  consoleDrawText(28, 1, nbuf);
}

/* Draw the court out of font glyphs on the text BG (no extra tile data
 * needed): a dashed rail across the top and bottom of the playfield plus
 * a dashed centre net. */
static void draw_court(void) {
  char rail[29];
  u16 i;
  for (i = 0; i < 28; i++) rail[i] = '-';
  rail[28] = 0;
  consoleDrawText(2, COURT_ROW_TOP, rail);
  consoleDrawText(2, COURT_ROW_BOT, rail);
  for (i = COURT_ROW_TOP + 1; i < COURT_ROW_BOT; i += 2)
    consoleDrawText(COURT_NET_COL, i, ":");
}

/* ── GAME LOGIC (clay) — state entries ─────────────────────────────────────── */
static void hide_sprites(void) {
  u16 i;
  for (i = 0; i < 7; i++) oamSet(SPR(i), 0, 240, 3, 0, 0, 0, 0);
}

static void title_enter(void) {
  clear_rows(0, 27);
  consoleDrawText((32 - (sizeof(GAME_TITLE) - 1)) / 2, 2, GAME_TITLE);
  consoleDrawText(9, 4, "BEST STREAK");
  fmt_u16(best_streak);
  consoleDrawText(21, 4, nbuf);
  consoleDrawText(9, 7, "A - 1P VS CPU");
  consoleDrawText(9, 9, "B - 2P VERSUS");
  consoleDrawText(8, 12, "FIRST TO 5 WINS");
  hide_sprites();
  state = ST_TITLE;
}

static void match_enter(u8 players) {
  two_player = players;
  p1y = 100; p2y = 100;
  score_p1 = 0; score_p2 = 0;
  new_record = 0;
  serve_ball(0);
  clear_rows(0, 27);
  consoleDrawText(2, 1, "P1");
  consoleDrawText(24, 1, two_player ? "P2 " : "CPU");
  draw_scores();
  draw_court();
  if (sound_ok) sfx_play(1);        /* serve-up blip */
  state = ST_PLAY;
}

/* ── GAME LOGIC (clay) — match over: result + record bookkeeping.
 * Persistence choice: for a VERSUS sports game a raw hi-score is
 * meaningless (every match ends 5-x), so we persist the longest 1P win
 * streak against the CPU — the stat a returning player actually chases.
 * 2P matches never touch it (humans beating each other isn't a record). */
static void end_match(void) {
  clear_rows(11, 17);               /* result card overlays the court */
  if (score_p1 >= WIN_SCORE) {
    consoleDrawText(8, 12, two_player ? "P1 WINS THE MATCH" : "YOU BEAT THE CPU");
    if (!two_player) {
      ++streak;
      if (streak > best_streak) {
        best_streak = streak;
        new_record = 1;
        streak_save(best_streak);   /* battery SRAM — see hdr.asm note up top */
      }
    }
  } else if (two_player) {
    consoleDrawText(8, 12, "P2 WINS THE MATCH");
  } else {
    consoleDrawText(7, 12, "CPU TAKES THE MATCH");
    streak = 0;                     /* the streak dies with the loss */
  }
  if (!two_player) {
    consoleDrawText(10, 14, "STREAK");
    fmt_u16(streak);
    consoleDrawText(17, 14, nbuf);
    if (new_record) consoleDrawText(20, 14, "- NEW RECORD");
  }
  consoleDrawText(10, 16, "PRESS START");
  if (sound_ok) sfx_play(2);        /* end-of-match flourish */
  state = ST_OVER;
}

/* ── GAME LOGIC (clay) — one point scored ── */
static void score_point(u8 for_p1) {
  if (for_p1) ++score_p1; else ++score_p2;
  if (sound_ok) sfx_play(2);
  draw_scores();
  if (score_p1 >= WIN_SCORE || score_p2 >= WIN_SCORE) end_match();
  else serve_ball(for_p1);          /* winner of the point receives */
}

/* ── GAME LOGIC (clay) — paddle hit: deflect by where the ball struck.
 * Centre = flat-ish, edges = steep. Max |bdy| is 2 — the CPU moves at 1,
 * so an edge hit is exactly how a human beats it. A ±1 random "spin" on
 * every return keeps rallies from repeating (see the PRNG note above). */
static void deflect(s16 paddle_y) {
  s16 rel = (s16)(by + BALL_SIZE / 2) - (s16)(paddle_y + PADDLE_H / 2);
  bdy = (s8)(rel >> 3);
  bdy += (s8)((random8() & 2) - 1);           /* spin: -1 or +1 */
  if (bdy > 2) bdy = 2;
  if (bdy < -2) bdy = -2;
  if (bdy == 0) bdy = (rel < 0) ? -1 : 1;     /* never return a flat ball */
  if (sound_ok) sfx_play(1);
}

/* Headless-test telemetry — written once per frame into this block. A test
 * harness finds it by scanning WRAM for the "NS"+0xBD signature, then plays
 * the game from real state instead of parsing pixels. Delete freely. */
static u8 telem[16];
static void telem_update(void) {
  telem[0] = 'N'; telem[1] = 'S'; telem[2] = 0xBD;
  telem[3] = state;
  telem[4] = score_p1;
  telem[5] = score_p2;
  telem[6] = (u8)((sound_ok << 7) | two_player);
  telem[7] = (u8)p1y;
  telem[8] = (u8)p2y;
  telem[9] = (u8)bx; telem[10] = (u8)(bx >> 8);
  telem[11] = (u8)by;
  telem[12] = serve_timer;
  telem[13] = streak;
  telem[14] = (u8)best_streak; telem[15] = (u8)(best_streak >> 8);
}

int main(void) {
  u16 pad, pad2;
  u16 i, slot;
  s16 target;

  /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
   * Init order: console text pointers FIRST, then mode, then BG bases.
   * consoleInitText DMAs the font but does NOT set the PPU BG base
   * registers — point BG0 at the same font ($3000) + map ($6800) yourself
   * or the text layer renders garbage. */
  consoleSetTextMapPtr(0x6800);
  consoleSetTextGfxPtr(0x3000);
  consoleSetTextOffset(0x0000);   /* tile index = (char-0x20); font at BG char base */
  consoleInitText(0, 16 * 2, &tilfont, &palfont);
  setMode(BG_MODE1, 0);
  bgSetGfxPtr(0, 0x3000);
  bgSetMapPtr(0, 0x6800, SC_32x32);

  /* BG1 = full-screen wallpaper so the court never reads as blank.
   * Tiles -> VRAM $2000, map -> VRAM $4000 (clear of sprites $0000 and
   * the console gfx $3000 / map $6800). Map entries use palette block 1
   * (0x0400) so the wallpaper palette doesn't disturb the console font
   * palette in block 0 (HUD/court text stays legible). */
  bgInitTileSet(1, (u8 *)&tilbg, (u8 *)&palbg, 1,
                32, 32, BG_16COLORS, 0x2000);

  /* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────
   * Court-green backdrop tint: recolor the wallpaper's CGRAM entries
   * (block 1 = entries 16+). Swap these for your own arena's mood. */
  setPaletteColor(0, RGB5(2, 9, 4));
  setPaletteColor(17, RGB5(5, 14, 7));
  setPaletteColor(18, RGB5(3, 11, 5));
  for (i = 0; i < 32 * 32; i++) bg_map[i] = 0x0400;
  bgInitMapSet(1, (u8 *)bg_map, sizeof(bg_map), SC_32x32, 0x4000);
  bgSetEnable(1);
  bgSetDisable(2);                  /* BG3 carries garbage in mode 1 */

  oamInitGfxSet(&tilsprite, 32, &palsprite, 32, 0, 0x0000, OBJ_SIZE8_L16);
  hide_sprites();

  setScreenOn();

  /* ── HARDWARE IDIOM (load-bearing) — sfx_init AFTER setScreenOn, and CHECK
   * the return: a wedged SPC700 must not take the video down with it. ── */
  sound_ok = (sfx_init() == 0);
  /* ── HARDWARE IDIOM (load-bearing) — one frame between init and the first
   * command. sfx_init returns the instant the SPC echoes the jump command,
   * but the driver then spends ~50 port writes initialising the DSP BEFORE
   * it seeds its command edge-detector from $2140. Send a command in that
   * window and the seed swallows it — music silently never starts (found
   * via getAudioState: voice 1 pitch 0, ARAM prev_cmd already = 3). A
   * WaitForVBlank is thousands of SPC cycles — deterministic cure. ── */
  WaitForVBlank();
  if (sound_ok) sfx_music_play();

  /* ── HARDWARE IDIOM (load-bearing) — initialize EVERY mutable global.
   * PVSnesLib's crt0 does NOT zero BSS, and SNES WRAM powers up dirty
   * ($55 fill in snes9x). A static you never assigned holds garbage —
   * here that meant two_player=0x55 picked "2P mode" paths before the
   * first match ever set it. C's "statics start at 0" does not apply. ── */
  best_streak = streak_load();      /* battery SRAM — 0 on first boot */
  streak = 0;
  two_player = 0;
  score_p1 = score_p2 = 0;
  p1y = p2y = 100;
  bx = 124; by = 108;
  bdx = bdy = 0;
  serve_timer = 0;
  new_record = 0;
  rng = 0xC0A7;                     /* the data segment isn't trustworthy either */
  prev_pad0 = 0;
  title_enter();

  while (1) {
    pad = padsCurrent(0);

    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: A/START = 1P vs CPU, B = 2P versus ── */
      if ((pad & KEY_A && !(prev_pad0 & KEY_A)) ||
          (pad & KEY_START && !(prev_pad0 & KEY_START))) {
        match_enter(0);
      } else if (pad & KEY_B && !(prev_pad0 & KEY_B)) {
        match_enter(1);
      }
    } else if (state == ST_OVER) {
      /* Freeze the final scene; START or A returns to the title. */
      if (pad & (KEY_START | KEY_A) && !(prev_pad0 & (KEY_START | KEY_A)))
        title_enter();
    } else {
      /* ── ST_PLAY — GAME LOGIC (clay) from here down ──────────────────── */
      random8();                    /* tick the noise source every play frame */

      /* P1 — port 0, up/down, 2px/frame. */
      if ((pad & KEY_UP)   && p1y > COURT_TOP)            p1y -= 2;
      if ((pad & KEY_DOWN) && p1y < COURT_BOT - PADDLE_H) p1y += 2;

      if (two_player) {
        /* P2 — port 1 (controller 2), same speed: a fair versus match. */
        pad2 = padsCurrent(1);
        if ((pad2 & KEY_UP)   && p2y > COURT_TOP)            p2y -= 2;
        if ((pad2 & KEY_DOWN) && p2y < COURT_BOT - PADDLE_H) p2y += 2;
      } else {
        /* CPU — chases the ball centre at 1px/frame (half player speed)
         * with a small dead zone. Beatable by design: steep deflections
         * outrun it. */
        target = by + BALL_SIZE / 2 - PADDLE_H / 2;
        if (p2y + 2 < target && p2y < COURT_BOT - PADDLE_H) p2y += 1;
        else if (p2y > target + 2 && p2y > COURT_TOP)       p2y -= 1;
      }

      /* Ball update (frozen during the post-point serve pause). */
      if (serve_timer > 0) {
        serve_timer--;
      } else if (state == ST_PLAY) {
        bx = (s16)(bx + bdx);
        by = (s16)(by + bdy);

        /* Rail bounce. */
        if (by < COURT_TOP)              { by = COURT_TOP;             bdy = (s8)(-bdy); }
        if (by + BALL_SIZE > COURT_BOT)  { by = COURT_BOT - BALL_SIZE; bdy = (s8)(-bdy); }

        /* Paddle collisions (direction-gated so the ball can't double-hit). */
        if (bdx < 0
            && bx <= PADDLE_X1 + 8 && bx + BALL_SIZE >= PADDLE_X1
            && by + BALL_SIZE > p1y && by < p1y + PADDLE_H) {
          bdx = (s8)(-bdx);
          bx = PADDLE_X1 + 8;
          deflect(p1y);
        }
        if (bdx > 0
            && bx + BALL_SIZE >= PADDLE_X2 && bx <= PADDLE_X2 + 8
            && by + BALL_SIZE > p2y && by < p2y + PADDLE_H) {
          bdx = (s8)(-bdx);
          bx = PADDLE_X2 - BALL_SIZE;
          deflect(p2y);
        }

        /* Off either side → point. */
        if (bx < 4)        score_point(0);   /* past P1 → right side scores */
        else if (bx > 244) score_point(1);   /* past P2 → P1 scores */
      }
    }
    prev_pad0 = pad;
    telem_update();

    /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
     * Stage ALL sprites, then oamUpdate(), then WaitForVBlank. PVSnesLib's
     * NMI handler DMAs shadow OAM → real OAM every vblank (channel 7);
     * oamUpdate marks the shadow dirty so that DMA carries THIS frame's
     * positions. Stage-after-wait shows last frame's sprites. */
    if (state == ST_PLAY || state == ST_OVER) {
      slot = 0;
      for (i = 0; i < PADDLE_H / 8; i++)
        oamSet(SPR(slot++), PADDLE_X1, (u16)(p1y + i * 8), 3, 0, 0, 0, 0);
      for (i = 0; i < PADDLE_H / 8; i++)
        oamSet(SPR(slot++), PADDLE_X2, (u16)(p2y + i * 8), 3, 0, 0, 0, 0);
      oamSet(SPR(slot), (u16)bx, (u16)by, 3, 0, 0, 0, 0);
    }
    oamUpdate();
    WaitForVBlank();
    consoleVblank();
  }
  return 0;
}
