/* ── shmup.c — SNES vertical shooter (complete example game) ──────────────────
 *
 * A COMPLETE, working game — title screen, 1P and 2P SIMULTANEOUS co-op,
 * shared lives, score + persistent hi-score (battery SRAM), SPC music + SFX,
 * and a scrolling Mode 1 starfield under a rock-steady text HUD.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented SNES footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — enemy patterns, scoring, tuning, art: reshape freely.
 *
 * What depends on what:
 *   data.asm — font + sprite tiles + starfield tiles (rodata), and
 *     sram_read16/write16 (battery SRAM needs 24-bit addressing that tcc
 *     C pointers don't emit). Load-bearing.
 *   hdr.asm — THIS PROJECT OVERRIDES the stock header to declare battery
 *     SRAM (CARTRIDGETYPE $02 + SRAMSIZE $01). Delete that file and saves
 *     silently stop existing — the build still succeeds.
 *   snes_sfx.{h,c} + snes_sfx_data.asm + apu_blob.bin — the SPC700 sound
 *     driver (music + 2 one-shot samples). #include'd, not separately built.
 *
 * Why the HUD never shears (read this if you come from the NES): the SNES
 * Mode 1 gives you THREE independent background layers, each with its own
 * scroll registers. The starfield lives on BG1 and scrolls; the text HUD
 * lives on BG0 and simply never gets a scroll write. No sprite-0 splits, no
 * mid-frame raster tricks — layer separation IS the SNES way. (When one
 * layer must be two things — a fixed strip over a moving field on the SAME
 * BG — that's when you reach for HDMA; see the Mode 7 racing example.)
 *
 * VRAM BUDGET (word addresses):
 *   $0000- OBJ tiles, $2000- BG1 starfield tiles, $3000- BG0 console font,
 *   $4000- BG1 map, $6800- BG0 text map.
 */

#include <snes.h>
/* Single .c file in buildSnesC, so the sound wrapper is #include'd
 * inline rather than linked separately. */
#include "snes_sfx.c"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "SOLAR BULWARK"

extern char tilfont, palfont;          /* HUD font + text palette (data.asm)  */
extern char tilsprite, palsprite;      /* ship/bullet/enemy tiles + OBJ pal   */
extern char tilbg, palbg;              /* 4 starfield tiles + BG palette      */

/* consoleVblank() copies the dirty text tilemap to VRAM during VBlank.
 * No public prototype in console.h, so declare it; call once per frame. */
extern void consoleVblank(void);

/* data.asm exports — battery SRAM accessors (long addressing to $70:0000). */
extern u16 sram_read16(u16 offset);
extern void sram_write16(u16 offset, u16 value);

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * oamSet's FIRST arg is a BYTE OFFSET into OAM, not a slot number. Each
 * sprite is 4 bytes, so sprite slot N lives at offset N*4. Passing a plain
 * slot number interleaves/corrupts entries — always go through SPR(). */
#define SPR(slot) ((slot) << 2)

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Object pools — fixed slots, no allocation. OAM slot layout:
 *   0..1 = ships (P1, P2), 2..9 = bullets, 10..15 = enemies. */
#define MAX_BULLETS  8
#define MAX_ENEMIES  6
#define OAM_SHIP     0
#define OAM_BULLET   2
#define OAM_ENEMY    10
#define OAM_COUNT    16
#define TILE_SHIP    0          /* tile indexes into tilsprite (data.asm)     */
#define TILE_BULLET  1
#define TILE_ENEMY   2
#define START_LIVES  3
#define HUD_Y        24         /* playfield starts below the text HUD row    */
#define FIELD_BOT    208
#define INV_FRAMES   90         /* post-hit invulnerability (blink)           */

/* SRAM layout: [0]=magic "SB", [2]=hi-score, [4]=hiscore ^ 0xA5C3.
 * Magic is written LAST in hiscore_save so a torn write never validates. */
#define SRAM_MAGIC 0x4253u

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2

typedef struct { s16 x, y; u8 alive; } Obj;

static u8 state;
static u8 two_player;          /* mode chosen on the title screen            */
static u8 sound_ok;
static Obj ships[2];
static u8 ship_inv[2];         /* invulnerability frames after a hit         */
static u8 fire_cd[2];
static Obj bullets[MAX_BULLETS];
static Obj enemies[MAX_ENEMIES];
static u8 lives;               /* SHARED pool in co-op (arcade style)        */
static u16 score, hiscore;
static u8 hud_dirty;
static u16 spawn_timer;
static u16 frame_ct;
static u16 star_v;             /* BG1 vertical scroll (starfield drift)      */
static u16 prev_pad0;
static char nbuf[8];           /* 5-digit number formatter output            */

/* BG1 starfield map: 32×32 entries, composed once at boot then scrolled in
 * hardware forever. Static (not a local): >255 bytes of locals overflows
 * tcc's 8-bit stack-relative addressing. */
static u16 bg_map[32 * 32];

/* Headless-test telemetry — written once per frame; a test harness finds it
 * by scanning WRAM for the "SB"+0xB7 signature, then plays the game from
 * real state instead of parsing pixels. Costs ~30 byte-writes; delete freely. */
static u8 telem[32];

/* ── GAME LOGIC (clay) — Galois LFSR (taps $B8), period 255 ────────────────── */
static u8 rng_state = 0xA5;
static u8 rand8(void) {
  u8 lsb = (u8)(rng_state & 1);
  rng_state >>= 1;
  if (lsb) rng_state ^= 0xB8;
  return rng_state;
}

/* ── GAME LOGIC (clay) — SRAM hi-score (see sram_* in data.asm) ────────────── */
static u16 hiscore_load(void) {
  u16 v;
  if (sram_read16(0) != SRAM_MAGIC) return 0;
  v = sram_read16(2);
  if (sram_read16(4) != (u16)(v ^ 0xA5C3u)) return 0;
  return v;
}

static void hiscore_save(u16 v) {
  sram_write16(2, v);
  sram_write16(4, (u16)(v ^ 0xA5C3u));
  sram_write16(0, SRAM_MAGIC);      /* magic LAST — torn write = no record */
}

/* ── GAME LOGIC (clay) — text helpers ──────────────────────────────────────── */
static void fmt5(u16 v) {           /* u16 → "00000" into nbuf */
  s8 i;
  for (i = 4; i >= 0; i--) { nbuf[i] = (char)('0' + v % 10); v /= 10; }
  nbuf[5] = 0;
}

static void clear_rows(u16 a, u16 b) {
  u16 y;
  for (y = a; y <= b; y++)
    consoleDrawText(0, y, "                                ");
}

static void draw_hud(void) {
  fmt5(score);   consoleDrawText(3, 1, nbuf);
  fmt5(hiscore); consoleDrawText(13, 1, nbuf);
  nbuf[0] = (char)('0' + lives); nbuf[1] = 0;
  consoleDrawText(23, 1, nbuf);
  hud_dirty = 0;
}

/* ── GAME LOGIC (clay) — firing + spawning ─────────────────────────────────── */
static void fire_bullet(u8 p) {
  u8 i;
  for (i = 0; i < MAX_BULLETS; i++) {
    if (!bullets[i].alive) {
      bullets[i].x = ships[p].x;
      bullets[i].y = ships[p].y - 8;
      bullets[i].alive = 1;
      if (sound_ok) sfx_play(1);            /* pew (voice 0 one-shot) */
      return;
    }
  }
}

static void spawn_enemy(void) {
  u8 i;
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemies[i].alive) {
      enemies[i].x = (s16)(rand8() % 224) + 8;
      enemies[i].y = HUD_Y;
      enemies[i].alive = 1;
      return;
    }
  }
}

/* AABB, both boxes 8×8. */
static u8 hits(Obj *a, Obj *b) {
  return a->x < b->x + 8 && a->x + 8 > b->x
      && a->y < b->y + 8 && a->y + 8 > b->y;
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Stage every OAM slot every frame, then ONE oamUpdate(). Inactive objects
 * park at Y=240 (below the 224-line display) — that's how you "hide" a
 * sprite without touching the OAM high table; oamInitGfxSet leaves slots
 * shown. The invulnerability blink also parks the ship every few frames.
 * CHANNEL BUDGET NOTE: oamUpdate only marks the shadow table; PVSnesLib's
 * VBlank ISR DMAs it on CHANNEL 7 every frame, and ch 0 carries the console
 * text upload. If you add HDMA effects (gradient sky, per-line scroll —
 * see the Mode 7 racing example) park them on channels 2-6: a channel can't
 * serve HDMA and that GP-DMA in the same frame, and the ISR silently
 * rewrites ch 7's params each NMI. */
static void stage_frame(void) {
  u8 i, hide;
  s16 y;
  for (i = 0; i < 2; i++) {
    hide = (u8)(!ships[i].alive || (ship_inv[i] & 4));
    y = hide ? 240 : ships[i].y;
    /* P2 = same tile, OBJ palette 1 (oamSet's LAST arg; CGRAM entry 145
     * is recoloured green in main). */
    oamSet(SPR(OAM_SHIP + i), ships[i].x, y, 3, 0, 0, TILE_SHIP, i);
  }
  for (i = 0; i < MAX_BULLETS; i++) {
    y = bullets[i].alive ? bullets[i].y : 240;
    oamSet(SPR(OAM_BULLET + i), bullets[i].x, y, 3, 0, 0, TILE_BULLET, 0);
  }
  for (i = 0; i < MAX_ENEMIES; i++) {
    y = enemies[i].alive ? enemies[i].y : 240;
    oamSet(SPR(OAM_ENEMY + i), enemies[i].x, y, 3, 0, 0, TILE_ENEMY, 0);
  }
}

/* ── GAME LOGIC (clay) — state entries ─────────────────────────────────────── */
static void clear_pools(void) {
  u8 i;
  for (i = 0; i < MAX_BULLETS; i++) bullets[i].alive = 0;
  for (i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = 0;
  ships[0].alive = ships[1].alive = 0;
}

static void title_enter(void) {
  clear_pools();
  clear_rows(0, 27);
  consoleDrawText((32 - sizeof(GAME_TITLE) + 1) / 2, 6, GAME_TITLE);
  consoleDrawText(12, 9, "HI");
  fmt5(hiscore); consoleDrawText(15, 9, nbuf);
  consoleDrawText(10, 12, "A - 1P START");
  consoleDrawText(10, 14, "B - 2P CO-OP");
  consoleDrawText(7, 20, "D-PAD MOVE   B FIRE");
  prev_pad0 = 0xFFFF;   /* swallow the press that ENTERED this state — without
                         * this, the START that left the game-over screen
                         * instantly restarts (classic edge-detect reuse bug) */
  state = ST_TITLE;
}

static void respawn_ship(u8 p) {
  ships[p].x = p ? 144 : (two_player ? 96 : 124);
  ships[p].y = 200;
  fire_cd[p] = 0;
}

static void play_enter(u8 players) {
  two_player = players;
  clear_pools();
  ships[0].alive = 1;
  ships[1].alive = two_player;
  respawn_ship(0);
  respawn_ship(1);
  ship_inv[0] = ship_inv[1] = 0;
  lives = START_LIVES;
  score = 0;
  spawn_timer = 0;
  clear_rows(0, 27);
  consoleDrawText(0, 1, "SC");
  consoleDrawText(10, 1, "HI");
  consoleDrawText(20, 1, "LV");
  draw_hud();
  state = ST_PLAY;
}

static void game_over(void) {
  u8 newhi = 0;
  if (score > hiscore) {
    hiscore = score;
    /* ── HARDWARE IDIOM (load-bearing) — persists via battery SRAM at
     * $70:0000; works because hdr.asm declares CARTRIDGETYPE $02 +
     * SRAMSIZE $01. Magic+checksum layout, magic written last. ── */
    hiscore_save(hiscore);
    newhi = 1;
    hud_dirty = 1;
  }
  consoleDrawText(11, 13, "GAME OVER");
  if (newhi) consoleDrawText(10, 15, "NEW HI SCORE");
  consoleDrawText(10, 17, "PRESS START");
  if (sound_ok) sfx_play(2);
  prev_pad0 = 0xFFFF;               /* swallow the held pad into ST_OVER  */
  state = ST_OVER;
}

/* ── GAME LOGIC (clay) — per-player update. THE 2P wiring is one line:
 * padsCurrent(p) reads controller port p (0 = pad 1, 1 = pad 2). ──────────── */
static void update_ship(u8 p) {
  u16 pad = padsCurrent(p);
  if (!ships[p].alive) return;
  if ((pad & KEY_LEFT)  && ships[p].x > 8)             ships[p].x -= 2;
  if ((pad & KEY_RIGHT) && ships[p].x < 240)           ships[p].x += 2;
  if ((pad & KEY_UP)    && ships[p].y > HUD_Y + 8)     ships[p].y -= 2;
  if ((pad & KEY_DOWN)  && ships[p].y < FIELD_BOT)     ships[p].y += 2;
  if ((pad & KEY_B) && fire_cd[p] == 0) {
    fire_bullet(p);
    fire_cd[p] = 10;
  }
  if (fire_cd[p]) --fire_cd[p];
  if (ship_inv[p]) --ship_inv[p];
}

/* ── GAME LOGIC (clay) — the playfield tick ────────────────────────────────── */
static void play_update(void) {
  u8 i, j;
  u16 interval;

  update_ship(0);
  if (two_player) update_ship(1);

  for (i = 0; i < MAX_BULLETS; i++) {
    if (!bullets[i].alive) continue;
    bullets[i].y -= 4;
    if (bullets[i].y < HUD_Y) bullets[i].alive = 0;
  }

  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemies[i].alive) continue;
    enemies[i].y += 1;
    if (enemies[i].y >= 224) enemies[i].alive = 0;  /* escaped — no penalty */
  }

  /* difficulty ramp: spawn faster as the score grows */
  interval = score >> 6;
  interval = (interval >= 20) ? 12 : (32 - interval);
  if (++spawn_timer >= interval) { spawn_timer = 0; spawn_enemy(); }

  /* bullets ↔ enemies */
  for (i = 0; i < MAX_BULLETS; i++) {
    if (!bullets[i].alive) continue;
    for (j = 0; j < MAX_ENEMIES; j++) {
      if (!enemies[j].alive) continue;
      if (hits(&bullets[i], &enemies[j])) {
        bullets[i].alive = 0;
        enemies[j].alive = 0;
        if (score < 65500) score += 10;
        hud_dirty = 1;
        if (sound_ok) sfx_play(2);          /* boom */
        break;
      }
    }
  }

  /* enemies ↔ ships: SHARED life pool (arcade co-op) + invulnerability
   * blink, so one bad wave can't drain every life in a single overlap */
  for (j = 0; j < MAX_ENEMIES; j++) {
    if (!enemies[j].alive) continue;
    for (i = 0; i < 2; i++) {
      if (!ships[i].alive || ship_inv[i]) continue;
      if (hits(&enemies[j], &ships[i])) {
        enemies[j].alive = 0;
        if (sound_ok) sfx_play(2);
        if (lives) --lives;
        hud_dirty = 1;
        if (lives == 0) { game_over(); return; }
        respawn_ship(i);
        ship_inv[i] = INV_FRAMES;
      }
    }
  }
}

/* ── GAME LOGIC (clay) — boot-time starfield composition ─────────────────────
 * Two space tones in a checker (so no single colour ever dominates the
 * screen) + LFSR-scattered star tiles. Map entries: tile index | 0x0400 =
 * palette block 1 (bits 10-12), keeping the console font palette (block 0)
 * untouched — HUD text stays white/legible. */
static void build_starfield(void) {
  u16 r, c, e;
  u8 v;
  for (r = 0; r < 32; r++) {
    for (c = 0; c < 32; c++) {
      e = ((r ^ c) & 1) ? 1 : 0;          /* space A / space B checker */
      v = rand8();
      if ((v & 0x1F) == 0)      e = 2;    /* bright star (on tone A)   */
      else if ((v & 0x1F) == 1) e = 3;    /* gold star   (on tone B)   */
      bg_map[(r << 5) + c] = (u16)(0x0400 | e);
    }
  }
}

static void telem_update(void) {
  u8 i;
  telem[0] = 'S'; telem[1] = 'B'; telem[2] = 0xB7;
  telem[3] = state;
  telem[4] = lives;
  telem[5] = (u8)((sound_ok << 7) | (two_player << 1));
  telem[6] = (u8)score;   telem[7] = (u8)(score >> 8);
  telem[8] = (u8)hiscore; telem[9] = (u8)(hiscore >> 8);
  telem[10] = (u8)ships[0].x; telem[11] = (u8)ships[0].y;
  telem[12] = (u8)ships[1].x; telem[13] = (u8)ships[1].y;
  telem[14] = (u8)(ships[0].alive | (ships[1].alive << 1)
                 | ((ship_inv[0] != 0) << 2) | ((ship_inv[1] != 0) << 3));
  for (i = 0; i < MAX_ENEMIES; i++) {
    telem[15 + (i << 1)] = enemies[i].alive ? (u8)enemies[i].x : 0xFF;
    telem[16 + (i << 1)] = enemies[i].alive ? (u8)enemies[i].y : 0xFF;
  }
  telem[27] = (u8)frame_ct;
}

int main(void) {
  u16 pad;

  /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
   * Init order: console text pointers FIRST, then mode, then per-BG base
   * registers, then VRAM uploads — all while the screen is still off.
   * consoleInitText DMAs the font but does NOT set the PPU BG base
   * registers; bgSetGfxPtr/bgSetMapPtr for BG0 must repeat the same
   * addresses or the HUD renders garbage. */
  consoleSetTextMapPtr(0x6800);
  consoleSetTextGfxPtr(0x3000);
  consoleSetTextOffset(0x0000);   /* tile index = (char - 0x20)            */
  consoleInitText(0, 16 * 2, &tilfont, &palfont);
  setMode(BG_MODE1, 0);
  bgSetGfxPtr(0, 0x3000);
  bgSetMapPtr(0, 0x6800, SC_32x32);

  /* BG1 = the scrolling starfield. 4 tiles → VRAM $2000, map → $4000
   * (clear of sprites $0000, the console font $3000 and map $6800). */
  bgInitTileSet(1, (u8 *)&tilbg, (u8 *)&palbg,
                1,              /* palbg → CGRAM palette block 1 */
                4 * 32, 32, BG_16COLORS, 0x2000);
  build_starfield();
  bgInitMapSet(1, (u8 *)bg_map, sizeof(bg_map), SC_32x32, 0x4000);
  bgSetEnable(1);
  bgSetDisable(2);                /* BG2 carries garbage in mode 1 — off  */

  setPaletteColor(0, RGB5(0, 0, 3));        /* backdrop: near-black space */
  /* P2's ship: OBJ palette 1 (CGRAM 144+), colour 1 recoloured green.
   * Same tile as P1 — only oamSet's palette argument differs. */
  setPaletteColor(145, RGB5(6, 28, 10));

  /* 3 sprite tiles (ship/bullet/enemy) × 32 bytes = 96 bytes. */
  oamInitGfxSet(&tilsprite, 96, &palsprite, 32, 0, 0x0000, OBJ_SIZE8_L16);

  /* ── HARDWARE IDIOM (load-bearing) — stage + flush OAM BEFORE the screen
   * turns on, so frame 1 shows the game (not power-on OAM garbage). ── */
  clear_pools();
  stage_frame();
  oamUpdate();

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

  hiscore = hiscore_load();         /* battery SRAM — 0 on first boot */
  star_v = 0;
  frame_ct = 0;
  title_enter();

  while (1) {
    pad = padsCurrent(0);

    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: A/START = 1P, B = 2P co-op ── */
      if ((pad & KEY_A && !(prev_pad0 & KEY_A)) ||
          (pad & KEY_START && !(prev_pad0 & KEY_START))) {
        play_enter(0);
      } else if (pad & KEY_B && !(prev_pad0 & KEY_B)) {
        play_enter(1);
      }
    } else if (state == ST_PLAY) {
      play_update();
    } else { /* ST_OVER — field frozen, stars keep drifting */
      if (pad & KEY_START && !(prev_pad0 & KEY_START)) title_enter();
    }
    prev_pad0 = pad;

    /* starfield drift: ~0.5 px/frame downward. VOFS decreasing moves BG
     * content DOWN the screen; the 256-px map wraps in hardware. */
    if (frame_ct & 1) --star_v;
    frame_ct++;

    telem_update();
    stage_frame();
    oamUpdate();
    if (hud_dirty) draw_hud();

    WaitForVBlank();
    bgSetScroll(1, 0, star_v);      /* scroll regs: write inside vblank   */
    consoleVblank();
  }
  return 0;
}
