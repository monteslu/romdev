/* ── platformer.c — SNES side-scrolling platformer (complete example game) ───
 *
 * CRAG CAPER — a COMPLETE, working game: title screen, 1P mode and 2P
 * ALTERNATING-TURNS mode (arcade-classic: players swap on death; each player
 * has their own score and own 3 lives; player 2 plays on CONTROLLER 2),
 * coins + distance scoring, persistent hi-score (battery SRAM), SPC music +
 * SFX, and the SNES's answer to the fixed-HUD-over-scrolling-field problem:
 * the HUD is simply ANOTHER BACKGROUND LAYER with its own scroll register.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented SNES footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — level layout, physics tuning, scoring, art: reshape
 *     freely.
 *
 * What depends on what:
 *   data.asm — font + sprite/level tiles, sram_read16/write16 (battery SRAM
 *     needs 24-bit addressing tcc can't emit), and the bank-$7E telem block.
 *     Load-bearing.
 *   hdr.asm — THIS PROJECT OVERRIDES the stock header to declare battery
 *     SRAM (CARTRIDGETYPE $02 + SRAMSIZE $01). Delete that file and saves
 *     silently stop existing — the build still succeeds.
 *   snes_sfx.{h,c} + snes_sfx_data.asm + apu_blob.bin — the SPC700 sound
 *     driver (music + 2 one-shot samples). #include'd, not separately built.
 *
 * ── THE TWO-LAYER SPLIT (the SNES bonus this example teaches) ───────────────
 * Mode 1 gives three independent background layers, EACH with its own
 * H/V scroll registers. So a fixed HUD over a scrolling playfield is just:
 *   BG0 (text console) — HUD + all menu text. Its scroll stays (0,0). Ever.
 *   BG1 — the level. One register write per frame (bgSetScroll) moves it.
 * Zero raster tricks, zero CPU. Contrast the NES platformer example (this
 * game's direct ancestor): the NES has ONE scroll for the WHOLE frame, so
 * its fixed HUD costs a sprite-0-hit polling spin — ~35 scanlines of CPU
 * burned EVERY frame waiting for the beam to clear the HUD before rewriting
 * PPUSCROLL mid-frame. On SNES you only reach for that kind of mid-frame
 * machinery (HDMA) when one layer must be two things at once — see the
 * racing example's Mode 1/Mode 7 split.
 *
 * The level itself: a 256-px-wide COLUMN MAP (ground height + one-way
 * platforms + pits) painted once into a 32x32 tilemap. 256 px is exactly
 * the map's width, so a uint8 scroll wraps seamlessly — an endless looping
 * run of pits, platforms, coins and spikes. Coins/spikes are sprites that
 * drift with the scroll (world-anchored while on screen, respawning at the
 * right edge).
 */

#include <snes.h>
#include "snes_sfx.c"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "CRAG CAPER"

extern char tilfont, palfont;          /* HUD font + text palette (data.asm)  */
extern char tilsprite, palsprite;      /* player/coin/spike tiles + palette   */
extern char tilbg, palbg;              /* level tiles + sky/dirt/grass colours*/

/* consoleVblank() copies the dirty text tilemap to VRAM during VBlank.
 * No public prototype in console.h, so declare it; call once per frame. */
extern void consoleVblank(void);

/* data.asm exports — battery SRAM accessors ($70:0000 long addressing) and
 * the bank-$7E telemetry block a headless test can find by scanning. */
extern u16 sram_read16(u16 offset);
extern void sram_write16(u16 offset, u16 value);
extern u8 telem[];

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * VRAM budget (word addresses):
 *   $0000 OBJ tiles, $2000 level tiles, $3000 HUD font,
 *   $4000 level map (BG1), $6800 HUD/console text map (BG0).
 * Sprite tile numbers + the level tile numbers the map painter uses. */
#define TILE_IDLE  0
#define TILE_JUMP  1
#define TILE_COIN  2
#define TILE_SPIKE 3
#define BG_CLOUD   1
#define BG_DIRT    2
#define BG_GRASS   3   /* also used for floating platforms (grass slabs)    */

/* ── GAME LOGIC (clay) — the level ───────────────────────────────────────────
 * A 32-column map; world x = (screen x + scroll) mod 256.
 *   ground_row[c] — tilemap row of the ground's grass top, 0xFF = pit.
 *   plat_row[c]   — row of a one-way floating platform, 0 = none.
 * Rows are tilemap rows (y = row*8). The SNES screen shows rows 0-27. */
#define NO_GROUND 0xFF
static const u8 ground_row[32] = {
  26, 26, 26, 26, 26, 26, 26, 26,                  /* start runway        */
  26, NO_GROUND, NO_GROUND, 26, 26, 26, 26, 26,    /* pit 1 (16 px)       */
  26, 26, 26, 26, NO_GROUND, NO_GROUND, NO_GROUND, /* pit 2 (24 px)       */
  26, 26, 26, 26, 26, 26, 26, 26, 26,
};
static const u8 plat_row[32] = {
  0, 0, 0, 0, 21, 21, 21, 0,                       /* slab before pit 1   */
  0, 0, 0, 0, 0, 0, 20, 20,                        /* slab mid-level      */
  20, 0, 0, 0, 0, 0, 0, 0,
  0, 21, 21, 21, 0, 0, 0, 0,                       /* slab near the loop  */
};

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
#define START_LIVES    3

/* SRAM layout: [0]=magic "CG", [2]=hi-score, [4]=hi ^ 0x5AC3.
 * Magic is written LAST in hi_save so a torn write never validates. */
#define SRAM_MAGIC 0x4743u

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2

static u8  state;
static u8  px;                 /* player screen x                          */
static u16 py_q44;             /* player y, Q4.4 fixed point — gravity adds
                                * <1 px/frame near the jump apex, so we
                                * need sub-pixel precision                 */
static s8  vy_q44;
static u8  on_ground;
static u8  scroll_x;           /* level scroll — u8 wraps at 256 = exactly *
                                * one level loop (seamless)                */
static u8  dist_sub;           /* sub-counter: 64 px scrolled = +1 pt      */
static u8  coin_x[NUM_COINS], coin_y[NUM_COINS];
static u8  spike_x[NUM_SPIKES], spike_active[NUM_SPIKES];

/* Players: index 0 = P1 (controller 1), 1 = P2 (controller 2 — alternating
 * turns, arcade-classic style). Each has own score + own lives; the HUD
 * shows the CURRENT player's numbers. */
static u8  two_player;
static u8  cur_player;
static u8  p_lives[2];
static u16 p_score[2];
static u16 hiscore;
static u8  turn_pause;         /* freeze frames after a turn change        */
static u8  sound_ok;
static u16 rng = 0xC0DE;
static u16 prev_pad0, prev_padP;
static u8  attract_sub;        /* title attract: scroll every 2nd frame    */
static char tbuf[8];           /* 5-digit score formatter output           */

static u16 bg_map[32 * 32];    /* level tilemap staging (DMA'd at boot)    */

/* ── GAME LOGIC (clay) — xorshift16 PRNG (~tens of cycles per call) ── */
static u8 random8(void) {
  u16 r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (u8)r;
}

static u8 dist8(u8 a, u8 b) {
  return (a > b) ? (u8)(a - b) : (u8)(b - a);
}

/* ── GAME LOGIC (clay) — battery SRAM hi-score (see sram_* in data.asm) ───── */
static u16 hi_load(void) {
  u16 v;
  if (sram_read16(0) != SRAM_MAGIC) return 0;
  v = sram_read16(2);
  if (sram_read16(4) != (u16)(v ^ 0x5AC3u)) return 0;
  return v;
}

static void hi_save(u16 v) {
  sram_write16(2, v);
  sram_write16(4, (u16)(v ^ 0x5AC3u));
  sram_write16(0, SRAM_MAGIC);      /* magic LAST — torn write = no record */
}

/* ── GAME LOGIC (clay) — text helpers ──────────────────────────────────────── */
static void fmt_u16(u16 v) {        /* 5 right-aligned digits into tbuf */
  u8 i;
  for (i = 0; i < 5; i++) { tbuf[4 - i] = (char)('0' + v % 10); v /= 10; }
  tbuf[5] = 0;
}

static void clear_row(u16 y) {
  consoleDrawText(0, y, "                                ");
}

static void clear_rows(u16 a, u16 b) {
  u16 y;
  for (y = a; y <= b; y++) clear_row(y);
}

/* HUD row 1, on BG0 — fixed because BG0's scroll never moves (see the
 * two-layer split note up top). Layout: "P1 L3 SC 00000 HI 00000". */
static void draw_hud(void) {
  consoleDrawText(1, 1, cur_player ? "P2" : "P1");
  tbuf[0] = 'L'; tbuf[1] = (char)('0' + p_lives[cur_player]); tbuf[2] = 0;
  consoleDrawText(4, 1, tbuf);
  fmt_u16(p_score[cur_player]);
  consoleDrawText(10, 1, tbuf);
}

static void draw_hud_labels(void) {
  consoleDrawText(7, 1, "SC");
  consoleDrawText(17, 1, "HI");
  fmt_u16(hiscore);
  consoleDrawText(20, 1, tbuf);
}

/* ── GAME LOGIC (clay) — paint the level from the column map ─────────────────
 * Composed once in WRAM and DMA'd to VRAM at boot (bgInitMapSet). The level
 * is static; only the scroll register moves it. Rows 0-2 stay sky so the
 * HUD text floats over clean backdrop. Map entries are plain tile numbers
 * (palette block 0, no flips, no priority). */
static void paint_level(void) {
  u8 r, c, g;
  u16 t;
  for (r = 0; r < 32; r++) {
    for (c = 0; c < 32; c++) {
      g = ground_row[c];
      t = 0;                                       /* sky backdrop        */
      if (plat_row[c] && r == plat_row[c]) t = BG_GRASS;  /* floating slab */
      else if (g != NO_GROUND) {
        if (r == g) t = BG_GRASS;                  /* ground surface      */
        else if (r > g) t = BG_DIRT;               /* ground body         */
      }
      if (t == 0 && r >= 14 && r <= 18) {          /* sparse cloud band   */
        if (((r * 7 + c * 5) & 15) == 0) t = BG_CLOUD;
      }
      bg_map[(u16)(r << 5) + c] = t;
    }
  }
}

/* ── GAME LOGIC (clay) — coins + spikes (sprite objects in the world) ── */
static const u8 coin_heights[4] = { 184, 160, 128, 152 };
static void respawn_coin(u8 i) {
  coin_x[i] = (u8)(232 + (random8() & 15));        /* enter at the right  */
  coin_y[i] = coin_heights[random8() & 3];
}

static void try_spawn_spike(u8 i) {
  /* Anchor only over ground: an inactive spike rolls a low per-frame
   * chance, and only spawns if the level column entering at the right
   * edge has ground under it (never floats over a pit). */
  u8 c = (u8)(248 + scroll_x) >> 3;
  if (ground_row[c] == NO_GROUND) return;
  if (random8() > 4) return;
  spike_x[i] = 248;
  spike_active[i] = 1;
}

/* Hide every gameplay sprite (OAM ids 0,4,..,20 = player, 3 coins, 2 spikes). */
static void hide_actors(void) {
  u8 i;
  for (i = 0; i < 24; i += 4) oamSetVisible(i, OBJ_HIDE);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Stage ALL sprites BEFORE WaitForVBlank. PVSnesLib's NMI handler DMAs the
 * shadow OAM to the real OAM every vblank (on channel 7 — never park HDMA
 * there), copying whatever the shadow holds AT THAT MOMENT. Stage-then-wait;
 * flipping it shows stale/empty sprites. oamSet rewrites x/y, which is also
 * what un-hides a sprite after OBJ_HIDE (hide just parks it off-screen). */
static void stage_actors(void) {
  u8 i, y8;
  y8 = (u8)(py_q44 >> 4);
  /* Blink the player during the turn-change breather. */
  if (turn_pause == 0 || (turn_pause & 4))
    oamSet(0, px, y8, 3, 0, 0, on_ground ? TILE_IDLE : TILE_JUMP, 0);
  else
    oamSetVisible(0, OBJ_HIDE);
  for (i = 0; i < NUM_COINS; i++)
    oamSet((u16)(4 + (i << 2)), coin_x[i], coin_y[i], 3, 0, 0, TILE_COIN, 0);
  for (i = 0; i < NUM_SPIKES; i++) {
    if (spike_active[i])
      oamSet((u16)(16 + (i << 2)), spike_x[i], SPIKE_Y, 3, 0, 0, TILE_SPIKE, 0);
    else
      oamSetVisible((u16)(16 + (i << 2)), OBJ_HIDE);
  }
}

/* ── GAME LOGIC (clay) — state entries ─────────────────────────────────────── */
static void title_enter(void) {
  bgSetEnable(1);                /* the level scrolls behind the title      */
  hide_actors();
  clear_rows(0, 27);
  consoleDrawText(11, 3, GAME_TITLE);
  consoleDrawText(10, 6, "A - 1P GAME");
  consoleDrawText(10, 7, "B - 2P TURNS");
  consoleDrawText(11, 9, "HI");
  fmt_u16(hiscore);
  consoleDrawText(14, 9, tbuf);
  state = ST_TITLE;
}

/* ── GAME LOGIC (clay) — start a turn / a run ── */
static void begin_turn(void) {
  px = 24;
  py_q44 = (u16)(GROUND_TOP - 8) << 4;
  vy_q44 = 0;
  on_ground = 1;
  scroll_x = 0;
  dist_sub = 0;
  coin_x[0] =  88; coin_y[0] = 184;
  coin_x[1] = 152; coin_y[1] = 160;
  coin_x[2] = 216; coin_y[2] = 128;
  spike_x[0] = 136; spike_active[0] = 1;   /* both anchored on ground at  */
  spike_x[1] = 224; spike_active[1] = 1;   /* scroll 0 — see ground_row   */
  turn_pause = 48;                         /* "P1/P2 GO" breather         */
  prev_padP = 0xFFFF;  /* swallow held buttons across the turn change —
                        * without this the A that picked 1P on the title
                        * instantly jumps (classic edge-detect reuse bug) */
  draw_hud();
  if (two_player)
    consoleDrawText(11, 4, cur_player ? "PLAYER 2 GO" : "PLAYER 1 GO");
}

static void start_game(u8 players) {
  u8 i;
  two_player = players;
  cur_player = 0;
  p_score[0] = p_score[1] = 0;
  p_lives[0] = START_LIVES;
  p_lives[1] = players ? START_LIVES : 0;
  clear_rows(0, 27);
  draw_hud_labels();
  for (i = 0; i < 24; i += 4) oamSetEx(i, OBJ_SMALL, OBJ_SHOW);
  begin_turn();
  if (sound_ok) sfx_play(1);               /* start blip                  */
  state = ST_PLAY;
}

static void game_over(void) {
  u16 best = p_score[0];
  if (two_player && p_score[1] > best) best = p_score[1];
  if (best > hiscore) { hiscore = best; hi_save(hiscore); }
  bgSetDisable(1);               /* clean card: sky backdrop + text only   */
  hide_actors();
  clear_rows(0, 27);
  consoleDrawText(11, 6, "GAME OVER");
  consoleDrawText(9, 10, "P1");
  fmt_u16(p_score[0]); consoleDrawText(15, 10, tbuf);
  if (two_player) {
    consoleDrawText(9, 12, "P2");
    fmt_u16(p_score[1]); consoleDrawText(15, 12, tbuf);
  }
  consoleDrawText(9, 15, "HI");
  fmt_u16(hiscore); consoleDrawText(15, 15, tbuf);
  consoleDrawText(9, 20, "START - TITLE");
  if (sound_ok) sfx_play(2);               /* game-over thud              */
  state = ST_OVER;
}

/* ── GAME LOGIC (clay) — death + alternating-turn handoff ── */
static void kill_player(void) {
  u8 other;
  if (sound_ok) sfx_play(2);
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
 * One-way platforms, classic style: only catch the player while FALLING
 * through a narrow window at the surface. The window is 6 px tall —
 * top-1 (the standing snap parks feet at top, and gravity's sub-pixel
 * trickle doesn't move the integer Y every frame; without the -1 slack the
 * player "stands" with on_ground=0 most frames, so jumps only register on
 * lucky frames and the idle/jump sprite flickers) through top+4 (so a
 * 5 px/frame terminal-velocity fall can't step over it). */
static u8 land_top(u8 c, u8 feet) {
  u8 r, top;
  r = plat_row[c];
  if (r) {
    top = (u8)(r << 3);
    if ((u8)(feet + 1) >= top && feet <= (u8)(top + 4)) return top;
  }
  r = ground_row[c];
  if (r != NO_GROUND) {
    top = (u8)(r << 3);
    if ((u8)(feet + 1) >= top && feet <= (u8)(top + 4)) return top;
  }
  return 0;
}

/* ── GAME LOGIC (clay) — one frame of gameplay ─────────────────────────────── */
static void play_update(void) {
  u16 pad;
  u8 i, delta, y8, feet, c0, c1, top, killed;

  if (turn_pause) {              /* freeze gameplay, keep the frame honest */
    --turn_pause;
    if (turn_pause == 0) clear_row(4);     /* drop the "Pn GO" banner     */
    stage_actors();
    return;
  }

  /* Input — the CURRENT player's controller (alternating turns: P2 is on
   * controller 2 — padsCurrent(1); that one index IS the 2P wiring). Past
   * SCROLL_WALL the world scrolls instead of the player (the camera never
   * scrolls back — the classic one-way camera). */
  pad = padsCurrent(cur_player);
  delta = 0;
  if (pad & KEY_RIGHT) {
    if (px < SCROLL_WALL) px += MOVE_SPEED;
    else { scroll_x += MOVE_SPEED; delta = MOVE_SPEED; }
  }
  if ((pad & KEY_LEFT) && px > 8) px -= MOVE_SPEED;
  if ((pad & (KEY_B | KEY_A)) && !(prev_padP & (KEY_B | KEY_A)) && on_ground) {
    vy_q44 = JUMP_VEL_Q44;
    on_ground = 0;
    if (sound_ok) sfx_play(1);                       /* jump blip         */
  }
  prev_padP = pad;

  /* World objects drift left as the level scrolls (world-anchored). */
  if (delta) {
    dist_sub += delta;
    if (dist_sub >= 64) {                            /* distance pay      */
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
  y8 = (u8)(py_q44 >> 4);

  /* Fell into a pit (below the screen) → lose the turn. */
  if (y8 >= 232) {
    kill_player();
    return;
  }

  /* Landing — probe the two level columns under the player's feet. */
  if (vy_q44 >= 0) {
    feet = (u8)(y8 + 8);
    c0 = (u8)(px + scroll_x) >> 3;
    c1 = (u8)(px + scroll_x + 7) >> 3;
    top = land_top(c0, feet);
    if (top == 0) top = land_top(c1, feet);
    if (top) {
      py_q44 = (u16)(top - 8) << 4;
      vy_q44 = 0;
      on_ground = 1;
    } else {
      on_ground = 0;                                 /* walked off        */
    }
  }

  /* Coins (collect) + spikes (death). */
  for (i = 0; i < NUM_COINS; i++) {
    if (dist8(coin_x[i], px) < 8 && dist8(coin_y[i], y8) < 8) {
      p_score[cur_player] += 10;
      if (sound_ok) sfx_play(1);                     /* coin ping         */
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
  if (killed) { kill_player(); return; }

  stage_actors();
}

/* Headless-test telemetry — written once per frame into the bank-$7E telem
 * block (data.asm). A test harness finds it by scanning WRAM for the
 * "CG"+0xBD signature, then plays the game from real state instead of
 * parsing pixels. spike_x is always even (spawns at 248, drifts by 2), so
 * its bit 0 carries the active flag. Costs ~20 byte-writes; delete freely. */
static void telem_update(void) {
  telem[0] = 'C'; telem[1] = 'G'; telem[2] = 0xBD;
  telem[3] = state;
  telem[4] = (u8)((sound_ok << 7) | (two_player << 1) | cur_player);
  telem[5] = p_lives[0];
  telem[6] = p_lives[1];
  telem[7] = px;
  telem[8] = (u8)(py_q44 >> 4);
  telem[9] = scroll_x;
  telem[10] = on_ground;
  telem[11] = (u8)p_score[0]; telem[12] = (u8)(p_score[0] >> 8);
  telem[13] = (u8)p_score[1]; telem[14] = (u8)(p_score[1] >> 8);
  telem[15] = turn_pause;
  telem[16] = (u8)(spike_x[0] | spike_active[0]);
  telem[17] = (u8)(spike_x[1] | spike_active[1]);
}

int main(void) {
  u16 pad;

  /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
   * Init order: console text pointers FIRST, then mode, then VRAM uploads
   * while the screen is still off (forced blank — VRAM DMA during active
   * display is lost or corrupts). consoleInitText DMAs the font but does
   * NOT set the PPU BG base registers — bgSetGfxPtr/bgSetMapPtr must agree
   * with the console pointers or text renders as garbage tiles. */
  consoleSetTextMapPtr(0x6800);
  consoleSetTextGfxPtr(0x3000);
  consoleSetTextOffset(0x0000);
  consoleInitText(0, 16 * 2, &tilfont, &palfont);
  setMode(BG_MODE1, 0);
  bgSetGfxPtr(0, 0x3000);
  bgSetMapPtr(0, 0x6800, SC_32x32);

  /* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
   * The two-layer split (see the header essay): BG0 = HUD/text, scroll
   * pinned at (0,0); BG1 = the level, moved by one bgSetScroll per frame.
   * palbg loads into CGRAM block 0 AFTER the font palette and is a superset
   * of it (colour 1 stays white) — so HUD ink and level tiles share the
   * block without fighting. BG2 carries power-on garbage in Mode 1 — keep
   * it disabled. */
  paint_level();
  bgInitTileSet(1, (u8 *)&tilbg, (u8 *)&palbg, 0, 4 * 32, 32, BG_16COLORS, 0x2000);
  bgInitMapSet(1, (u8 *)bg_map, sizeof(bg_map), SC_32x32, 0x4000);
  bgSetEnable(1);
  bgSetDisable(2);

  /* OBJ: 8x8 sprites (player, coins, spikes) at VRAM $0000. */
  oamInitGfxSet(&tilsprite, 4 * 32, &palsprite, 32, 0, 0x0000, OBJ_SIZE8_L16);

  setScreenOn();

  /* ── HARDWARE IDIOM (load-bearing) — sfx_init AFTER setScreenOn, and CHECK
   * the return: a wedged SPC700 must not take the video down with it. ── */
  sound_ok = (sfx_init() == 0);
  /* ── HARDWARE IDIOM (load-bearing) — one frame between init and the first
   * command. sfx_init returns the instant the SPC echoes the jump command,
   * but the driver then spends ~50 port writes initialising the DSP BEFORE
   * it seeds its command edge-detector from $2140. Send a command in that
   * window and the seed swallows it — music silently never starts. A
   * WaitForVBlank is thousands of SPC cycles — deterministic cure. ── */
  WaitForVBlank();
  if (sound_ok) sfx_music_play();

  hiscore = hi_load();              /* battery SRAM — 0 on first boot */
  prev_pad0 = prev_padP = 0;
  title_enter();

  while (1) {
    pad = padsCurrent(0);

    if (state == ST_TITLE) {
      /* attract: the level drifts by under the title — the scroll register
       * demo, and the first thing a fork breaks if the layers get swapped */
      attract_sub ^= 1;
      if (attract_sub) scroll_x++;
      if ((pad & KEY_A && !(prev_pad0 & KEY_A)) ||
          (pad & KEY_START && !(prev_pad0 & KEY_START))) {
        start_game(0);
      } else if (pad & KEY_B && !(prev_pad0 & KEY_B)) {
        start_game(1);
      }
    } else if (state == ST_PLAY) {
      play_update();
    } else { /* ST_OVER */
      if ((pad & (KEY_START | KEY_A)) && !(prev_pad0 & (KEY_START | KEY_A)))
        title_enter();
    }
    prev_pad0 = pad;
    telem_update();
    oamUpdate();

    WaitForVBlank();
    /* ── HARDWARE IDIOM (load-bearing) — scroll + text commits in vblank.
     * bgSetScroll writes the BG1 scroll registers directly; mid-frame the
     * beam would render the top of the frame with the old value and the
     * bottom with the new (a shear). BG0 gets NO scroll write, ever —
     * that's the whole fixed-HUD trick. ── */
    bgSetScroll(1, scroll_x, 0);
    consoleVblank();
  }
  return 0;
}
