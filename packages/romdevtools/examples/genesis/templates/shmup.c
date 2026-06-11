/* ── shmup.c — Genesis vertical shooter (complete example game) ──────────────
 *
 * PULSAR RAMPART — a COMPLETE, working game: title screen, 1P mode and 2P
 * SIMULTANEOUS CO-OP (two ships on screen at once, P2 on CONTROLLER 2,
 * sharing one arcade-style life pool and one score), fixed-slot bullet +
 * enemy object pools, a wave spawner, persistent hi-score (cartridge SRAM),
 * music + SFX, and the Genesis's signature trick for vertical shooters:
 * PER-COLUMN VERTICAL SCROLL (VSCROLL_COLUMN) — a depth-banded starfield
 * where every 16-px column falls at its own speed, under a hardware-fixed
 * WINDOW-plane HUD.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented Genesis footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — enemy patterns, scoring, tuning, art: reshape freely.
 *
 * What depends on what:
 *   genesis_sfx.{h,c} — PSG sound wrapper (tones + noise + a background
 *     melody loop). For full FM music, see the xgm2_demo template
 *     (XGM2_loadDriver + XGM2_play + a .xgc blob incbin'd via a data.s
 *     sibling) — we use the PSG path here so the shooter stays a
 *     single-file game; the swap is three lines plus the data.s sibling.
 *   rom_header.c (SGDK) — the Sega header at $100. Its 'RA' block at $1B0
 *     DECLARES the cartridge SRAM that hiscore_load/save below depend on
 *     (see the SRAM idiom). The build assembles it automatically.
 *
 * SAT discipline (kept from the minimal scaffold this grew from): the
 * Genesis shows up to 80 sprites/frame in H40, and the cheap way to never
 * flicker is FIXED SLOT RANGES — no "find a free SAT entry" mid-frame:
 *   slot 0          → player 1 ship
 *   slot 1          → player 2 ship (parked off-screen in 1P mode)
 *   slot 2..7       → bullets (6, shared pool — both ships fire into it)
 *   slot 8..13      → enemies (6)
 *   total 14 < 80   → no flicker even when everything is alive
 *
 * Frame budget (NTSC, 60 fps): the whole update — 2 ships, 6 bullets,
 * 6 enemies, worst-case 6x6 + 6x2 AABB checks — plus 20 vscroll words and
 * 14 SAT entries queued for vblank DMA is a tiny fraction of the 68000's
 * frame. The vblank DMA budget (~7 KB/frame in H40) is the real ceiling
 * on Genesis; we use < 200 bytes of it.
 */

#include <genesis.h>
#include "genesis_sfx.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "PULSAR RAMPART"

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * CONTROLLER MAPPING — two layers, both bite:
 *
 *   On the pad: SGDK's JOY_readJoypad(JOY_1/JOY_2) returns BUTTON_A/B/C/
 *   START/UP/DOWN/LEFT/RIGHT as a bitmask. Fire is BUTTON_A or BUTTON_C
 *   (real Genesis games map action buttons generously — thumbs rest on C).
 *
 *   Driving this game HEADLESSLY through an emulator (libretro/gpgx): the
 *   core maps Genesis A/B/C onto libretro Y/B/A. So setInput({y:true})
 *   presses GENESIS A (fire/start here), setInput({b:true}) presses GENESIS
 *   B (2P select), and setInput({a:true}) presses GENESIS C — NOT Genesis A.
 *   Getting this wrong looks like "the game ignores input". START is start.
 */
#define BTN_FIRE (BUTTON_A | BUTTON_C)

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile art. Genesis tiles are 4bpp: each u32 row = 8 pixels, one hex nibble
 * per pixel = a colour index into the tile's palette line (0 = transparent).
 * Palette lines: PAL0 = P1 ship + font, PAL1 = backdrop + bullets,
 * PAL2 = enemies, PAL3 = P2 ship. The two ships share ONE tile — P2 is a
 * palette swap (same pattern, different palette line in the sprite attr),
 * the classic Genesis way to get a second player for free. */
#define T_SHIP   (TILE_USER_INDEX + 0)   /* sprite: both ships (pal swap)  */
#define T_BULLET (TILE_USER_INDEX + 1)   /* sprite: player shot            */
#define T_ENEMY  (TILE_USER_INDEX + 2)   /* sprite: descending raider      */
#define T_NEB1   (TILE_USER_INDEX + 3)   /* plane B: nebula weave A        */
#define T_NEB2   (TILE_USER_INDEX + 4)   /* plane B: nebula weave B        */
#define T_STAR   (TILE_USER_INDEX + 5)   /* plane B: bright star on weave  */

static const u32 tile_ship[8] = {        /* dart hull, cockpit, twin flame */
    0x00011000, 0x00122100, 0x00122100, 0x01111110,
    0x11111111, 0x11111111, 0x01300310, 0x00300300,
};
static const u32 tile_bullet[8] = {
    0x00022000, 0x00022000, 0x00222200, 0x00222200,
    0x00222200, 0x00222200, 0x00022000, 0x00022000,
};
static const u32 tile_enemy[8] = {
    0x33000033, 0x03333330, 0x33333333, 0x33033033,
    0x33333333, 0x03333330, 0x30000003, 0x03000030,
};
/* Two distinct DARK nebula blocks are checkerboarded across plane B so no
 * single colour dominates the screen (a flat backdrop reads as "blank" to
 * both humans and render-health checks) — and each tile's rows DIFFER, so
 * vertical motion is visible (a flat colour shifted N px looks identical
 * to itself). Kept dark on purpose: the window HUD floats over plane B
 * (see the WINDOW idiom) and white text must stay readable on it. */
static const u32 tile_neb1[8] = {
    0x44444444, 0x44455444, 0x44444444, 0x54444445,
    0x44444444, 0x44455444, 0x44444444, 0x54444445,
};
static const u32 tile_neb2[8] = {
    0x55555555, 0x55544555, 0x55555555, 0x45555554,
    0x55555555, 0x55544555, 0x55555555, 0x45555554,
};
static const u32 tile_star[8] = {        /* nebula base + a bright cross   */
    0x44444444, 0x44464444, 0x44666444, 0x44464444,
    0x44444444, 0x44444464, 0x44444444, 0x46444444,
};

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Object pools — fixed slots, no allocation. Pool sizes mirror the SAT slot
 * map in the header comment: change one, change the other. */
#define MAX_BULLETS 6
#define MAX_ENEMIES 6
#define START_LIVES 3
#define SCREEN_W    320      /* H40 mode                                   */
#define FIELD_TOP   16       /* HUD_ROWS * 8 — nothing flies above this    */
#define HUD_ROWS    2        /* window rows reserved for the HUD           */

typedef struct { s16 x, y; bool alive; } Obj;

static Obj  ships[2];        /* index 0 = P1 (pad 1), 1 = P2 (pad 2)       */
static Obj  bullets[MAX_BULLETS];
static Obj  enemies[MAX_ENEMIES];
static u8   fire_cd[2];      /* per-ship autofire cooldown                 */
static u8   two_player;      /* mode chosen on the title screen            */
static u8   lives;           /* SHARED pool in co-op (arcade style)        */
static u16  score;           /* shared in co-op too — one team, one number */
static u16  hiscore;
static u16  spawn_timer;
static u16  cam;             /* starfield fall counter. NEVER reset and    *
                              * never wrapped by hand: plane B is 256 px   *
                              * tall, the VDP masks vscroll to the plane,  *
                              * and 65536 is a multiple of 256 (and of     *
                              * 256*2/4/8), so plain u16 overflow keeps    *
                              * every depth band seamless forever.         */

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static u8  state;
static u16 prev_pad;

/* ── GAME LOGIC (clay) — spawn spread ───────────────────────────────────────
 * Cheap LCG, advanced once per spawn. Seeded free-running (NOT from
 * spawn_timer, which is always the same value at the spawn call → every
 * enemy would descend in one column). */
static u16 spawn_seed = 0xC0DE;

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * CARTRIDGE SRAM — the Genesis battery-save mechanism, three parts:
 *
 *   1. The ROM HEADER declares it: bytes $1B0.. hold 'R','A', a type word
 *      ($F820 = battery-backed, byte-wide on ODD addresses — the classic
 *      cart wiring), then start/end addresses $200000/$20FFFF. SGDK's
 *      rom_header.c (assembled into every build) already declares exactly
 *      this — no linker work needed. Emulators allocate the save RAM by
 *      READING THIS HEADER; no 'RA' block = writes to $200000+ go nowhere.
 *   2. The MAPPER GATE: writing 1 to $A130F1 banks SRAM into $200000+,
 *      0 banks the ROM back in. SGDK's SRAM_enable()/SRAM_disable() do
 *      this. ALWAYS disable after access — on carts >2 MB the SRAM window
 *      shadows ROM, and leaving it enabled corrupts later ROM fetches.
 *   3. ODD-BYTE ADDRESSING: SRAM_readByte/writeByte(offset) access 68k
 *      address $200001 + offset*2. Headlessly, the emulator's save_ram
 *      region interleaves with dead even bytes: SGDK offset k lives at
 *      save_ram[k*2 + 1] (the even bytes read back $FF).
 *
 * Hi-score record layout (SGDK offsets): 0='H' 1='S' 2=lo 3=hi
 * 4=checksum(lo^hi^$A5). Fresh SRAM is all $FF — the magic+checksum
 * rejects it (and any corruption) so first boot shows 0, not 65535.
 *
 * Emulator note (verified against gpgx): the core sizes its save_ram
 * region by scanning for the last non-$FF byte, so the region reads as
 * EMPTY until the first write below lands — that's why hiscore_init runs
 * at the very top of main(). Real hardware and .srm-restoring frontends
 * have no such wrinkle. */
static u16 hiscore_load(void) {
    u8 m0, m1, lo, hi, ck;
    SRAM_enableRO();
    m0 = SRAM_readByte(0);
    m1 = SRAM_readByte(1);
    lo = SRAM_readByte(2);
    hi = SRAM_readByte(3);
    ck = SRAM_readByte(4);
    SRAM_disable();
    if (m0 == 'H' && m1 == 'S' && ck == (u8)(lo ^ hi ^ 0xA5))
        return ((u16)hi << 8) | lo;
    return 0;
}

static void hiscore_save(u16 sc) {
    u8 lo = (u8)sc, hi = (u8)(sc >> 8);
    SRAM_enable();
    SRAM_writeByte(0, 'H');
    SRAM_writeByte(1, 'S');
    SRAM_writeByte(2, lo);
    SRAM_writeByte(3, hi);
    SRAM_writeByte(4, (u8)(lo ^ hi ^ 0xA5));
    SRAM_disable();
}

/* Format-on-first-boot: if the magic is absent (fresh battery), write a
 * valid zero record immediately so the save file exists from frame one. */
static void hiscore_init(void) {
    hiscore = hiscore_load();
    if (hiscore == 0) hiscore_save(0);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * PER-COLUMN VERTICAL SCROLL — the Genesis signature for vertical shooters.
 * The VDP can scroll plane A and plane B vertically in INDEPENDENT 2-CELL
 * (16-px) COLUMNS: VSRAM holds one scroll word per plane per column, and
 *
 *   VDP_setScrollingMode(HSCROLL_PLANE, VSCROLL_COLUMN)
 *
 * switches the VDP from one-vscroll-per-plane to one-per-column (20
 * columns cover the 320-px H40 screen). Per frame we queue one 20-word
 * table for plane B, banding the columns into three depths:
 *
 *   far bands  = -(cam / 8)   (barely falls)
 *   mid bands  = -(cam / 4)
 *   near bands = -(cam / 2)   (streams past)
 *
 * Three speeds from ONE plane — this is how real carts faked deep space
 * on a two-plane VDP. NEGATIVE values because the vscroll offset slides
 * the plane UP; a "falling" starfield means the plane content slides DOWN.
 *
 * Requires: VSCROLL_COLUMN mode set BEFORE the first table write; plane
 *   A's 20 entries written too (once, all zero here — in column mode the
 *   VDP reads BOTH planes' columns from VSRAM, and garbage there shears
 *   your title text); DMA_QUEUE so the VSRAM write lands in vblank
 *   (SYS_doVBlankProcess flushes the queue); the value arrays static
 *   (the queue reads them AT FLUSH TIME — stack arrays are gone by then,
 *   shipping garbage).
 * Hardware wrinkle (real VDP + accurate emulators): in column mode the
 *   LEFTMOST column can fetch a mixed scroll value when the plane is ALSO
 *   h-scrolled mid-column. We keep hscroll at 0, so it never bites here —
 *   if you add horizontal motion, scroll plane B by whole 16-px steps or
 *   live with a 1-column fringe. */
#define VS_COLS 20
static s16 vsA[VS_COLS];                 /* stays all-zero: plane A fixed  */
static s16 vsB[VS_COLS];
static void apply_starfield(void) {
    u16 i;
    for (i = 0; i < VS_COLS; i++) {
        u16 band = i & 3;                /* 0 = far, 1 = near, 2/3 = mid   */
        vsB[i] = (band == 1) ? -(s16)(cam >> 1)
               : (band == 0) ? -(s16)(cam >> 3)
                             : -(s16)(cam >> 2);
    }
    VDP_setVerticalScrollTile(BG_B, 0, vsB, VS_COLS, DMA_QUEUE);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * WINDOW-PLANE HUD — the fixed status bar. The window is a third tilemap
 * that REPLACES plane A wherever it's shown and IGNORES ALL SCROLLING —
 * a hardware-fixed HUD with zero per-frame cost, even while every plane-B
 * column under it falls at its own speed. Three footguns:
 *   - The window only lives at screen edges (top/bottom N rows or left/
 *     right N columns) — it cannot float mid-screen.
 *   - It replaces plane A ONLY: plane B still renders BEHIND its
 *     transparent pixels (our scrolling starfield shows through around
 *     the HUD glyphs — that's why the backdrop tiles stay dark), and
 *     sprites still render OVER it: nothing in the game flies above
 *     y=16, and bullets despawn at the HUD line instead of crossing it.
 *   - Window size before window text: VDP_setWindowOnTop first. */
static void hud_init(void) {
    VDP_setWindowOnTop(HUD_ROWS);
}

/* ── GAME LOGIC (clay) — HUD text (window plane, redrawn only on change) ── */
static void draw_u16(VDPPlane plane, u16 v, u16 x, u16 y) {
    char buf[8];
    uintToStr(v, buf, 5);
    VDP_drawTextBG(plane, buf, x, y);
}

static void draw_hud(void) {
    char b[4];
    VDP_drawTextBG(WINDOW, "LV", 1, 0);
    b[0] = 'x'; b[1] = '0' + lives; b[2] = 0;
    VDP_drawTextBG(WINDOW, b, 4, 0);
    VDP_drawTextBG(WINDOW, "SC", 8, 0);
    draw_u16(WINDOW, score, 11, 0);
    VDP_drawTextBG(WINDOW, "HI", 18, 0);
    draw_u16(WINDOW, hiscore, 21, 0);
}

static void draw_hud_title(void) {
    VDP_clearTextAreaBG(WINDOW, 0, 0, 40, HUD_ROWS);
    VDP_drawTextBG(WINDOW, "HI", 18, 0);
    draw_u16(WINDOW, hiscore, 21, 0);
}

/* ── GAME LOGIC (clay) — paint plane B once at boot, never again ──────────
 * The frame loop only ever touches VSRAM (the column scroll table) — ZERO
 * tilemap writes per frame. Rewriting tilemaps in the loop is the #1
 * "choppy movement" bug; hardware scroll is free. */
static void paint_backdrop(void) {
    u16 cx, cy;
    for (cy = 0; cy < 32; cy++) {
        for (cx = 0; cx < 64; cx++) {
            u16 t = ((cx ^ cy) & 1) ? T_NEB2 : T_NEB1;
            if (((cx * 7 + cy * 13) & 31) == 0) t = T_STAR;
            VDP_setTileMapXY(BG_B, TILE_ATTR_FULL(PAL1, 0, 0, 0, t), cx, cy);
        }
    }
}

/* ── GAME LOGIC (clay) — the title screen (text on plane A, vscroll 0) ── */
static void paint_title(void) {
    VDP_clearPlane(BG_A, TRUE);
    VDP_drawTextBG(BG_A, GAME_TITLE, (40 - (sizeof(GAME_TITLE) - 1)) / 2, 8);
    VDP_drawTextBG(BG_A, "1P START - A", 14, 14);
    VDP_drawTextBG(BG_A, "2P CO-OP - B", 14, 16);
    VDP_drawTextBG(BG_A, "D-PAD MOVES - A FIRES", 9, 21);
    draw_hud_title();
}

/* ── GAME LOGIC (clay) — the game-over results screen ── */
static void paint_over(void) {
    VDP_clearPlane(BG_A, TRUE);
    VDP_drawTextBG(BG_A, "GAME OVER", 15, 8);
    VDP_drawTextBG(BG_A, "SC", 13, 12);
    draw_u16(BG_A, score, 17, 12);
    VDP_drawTextBG(BG_A, "HI", 13, 17);
    draw_u16(BG_A, hiscore, 17, 17);
    VDP_drawTextBG(BG_A, "START - TITLE", 13, 21);
}

/* ── GAME LOGIC (clay) — pools ── */
static void fire_bullet(u8 p) {
    u16 i;
    for (i = 0; i < MAX_BULLETS; i++) {
        if (!bullets[i].alive) {
            bullets[i].x = ships[p].x;
            bullets[i].y = ships[p].y - 8;
            bullets[i].alive = TRUE;
            sfx_tone(0, 1568, 4);                       /* pew (G6)        */
            return;
        }
    }
}

static void spawn_enemy(void) {
    u16 i;
    for (i = 0; i < MAX_ENEMIES; i++) {
        if (!enemies[i].alive) {
            spawn_seed = (u16)(spawn_seed * 1103 + 12345);
            enemies[i].x = (s16)((spawn_seed >> 4) % (SCREEN_W - 16) + 8);
            /* Pop in just BELOW the HUD line — sprites render OVER the
             * window plane, so an enemy gliding in from y=-8 would crawl
             * across the HUD text (see the WINDOW idiom). */
            enemies[i].y = FIELD_TOP + 2;
            enemies[i].alive = TRUE;
            return;
        }
    }
}

static bool aabb_hit(Obj* a, Obj* b) {
    return (a->x < b->x + 8) && (a->x + 8 > b->x)
        && (a->y < b->y + 8) && (a->y + 8 > b->y);
}

/* ── GAME LOGIC (clay) — start a run ── */
static void start_game(u8 players) {
    u16 i;
    two_player = players;
    ships[0].x = players ? 120 : 156; ships[0].y = 200; ships[0].alive = TRUE;
    ships[1].x = 184;                 ships[1].y = 200; ships[1].alive = players;
    fire_cd[0] = fire_cd[1] = 0;
    for (i = 0; i < MAX_BULLETS; i++) bullets[i].alive = FALSE;
    for (i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = FALSE;
    lives = START_LIVES;
    score = 0;
    spawn_timer = 0;
    prev_pad = 0xFFFF;          /* swallow the held title button           */
    VDP_clearPlane(BG_A, TRUE); /* the playfield is open space             */
    draw_hud();
    sfx_tone(0, 523, 10);       /* start jingle (C5)                       */
    state = ST_PLAY;
}

static void game_over(void) {
    if (score > hiscore) {
        hiscore = score;
        hiscore_save(hiscore);  /* battery SRAM — see the SRAM idiom       */
    }
    state = ST_OVER;
    prev_pad = 0xFFFF;
    draw_hud();      /* refresh the window HUD — HI may have just changed */
    paint_over();
}

/* ── GAME LOGIC (clay) — per-ship update. p = 0 reads pad 1, p = 1 reads
 * pad 2: simultaneous co-op is literally "the same update twice with a
 * different joypad index" on Genesis — both pads sit on the same I/O chip
 * and JOY_readJoypad(JOY_2) costs the same as JOY_1. ── */
static void update_ship(u8 p) {
    u16 pad;
    if (!ships[p].alive) return;
    pad = JOY_readJoypad(p ? JOY_2 : JOY_1);
    if ((pad & BUTTON_LEFT)  && ships[p].x > 8)              ships[p].x -= 2;
    if ((pad & BUTTON_RIGHT) && ships[p].x < SCREEN_W - 16)  ships[p].x += 2;
    if ((pad & BUTTON_UP)    && ships[p].y > FIELD_TOP + 8)  ships[p].y -= 2;
    if ((pad & BUTTON_DOWN)  && ships[p].y < 208)            ships[p].y += 2;
    if ((pad & BTN_FIRE) && fire_cd[p] == 0) {
        fire_bullet(p);
        fire_cd[p] = 8;                  /* autofire while held, 8f apart  */
    }
    if (fire_cd[p] > 0) --fire_cd[p];
}

/* ── GAME LOGIC (clay) — stage this frame's sprites into the fixed SAT
 * slots (the map from the header comment). Hidden sprites park at
 * y = -16 (above the screen). NEVER hide with x = -128..0 — a SAT x of 0
 * is the VDP's sprite-masking trigger and silently blanks every
 * lower-priority sprite on those scanlines. ── */
#define HIDE_Y (-16)
static void stage_sprites(void) {
    u16 i;
    u8 play = (state == ST_PLAY);
    for (i = 0; i < 2; i++) {
        u8 vis = play && ships[i].alive;
        /* P2 = same tile, different palette line: the classic pal swap. */
        VDP_setSprite(i, ships[i].x, vis ? ships[i].y : (s16)HIDE_Y,
                      SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(i ? PAL3 : PAL0, 1, 0, 0, T_SHIP));
    }
    for (i = 0; i < MAX_BULLETS; i++) {
        u8 vis = play && bullets[i].alive;
        VDP_setSprite(2 + i, bullets[i].x, vis ? bullets[i].y : (s16)HIDE_Y,
                      SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(PAL1, 1, 0, 0, T_BULLET));
    }
    for (i = 0; i < MAX_ENEMIES; i++) {
        u8 vis = play && enemies[i].alive;
        VDP_setSprite(8 + i, enemies[i].x, vis ? enemies[i].y : (s16)HIDE_Y,
                      SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(PAL2, 1, 0, 0, T_ENEMY));
    }
    /* ── HARDWARE IDIOM (load-bearing) — CHAIN the sprite list before
     * uploading. VDP_setSprite does NOT set the SAT link byte, and link 0
     * means "end of list": skip this and the VDP draws sprite 0 only.
     * VDP_linkSprites(0, 14) links slots 0..13; the queued DMA flushes
     * the 14 SAT entries during vblank. ── */
    VDP_linkSprites(0, 14);
    VDP_updateSprites(14, DMA_QUEUE);
}

int main(bool hard) {
    u16 i, pad, fresh;
    (void)hard;

    /* SRAM first — before any VDP work. The save file then exists within
     * the game's first frames of life, which is what lets a frontend (or
     * a headless host) see a non-empty save_ram region as early as
     * possible (see the SRAM idiom note on gpgx's size scan). */
    hiscore_init();

    /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
     * Init order: scrolling MODE before scroll VALUES, tiles + palettes
     * before tilemaps that reference them, window size before window text.
     * SGDK's boot already did the dangerous part (VDP regs, Z80, vblank
     * int) — keep VDP_setScrollingMode FIRST here so every later
     * apply_starfield() writes the VSRAM layout the VDP actually reads,
     * and seed plane A's column entries (all zero) right after: in
     * VSCROLL_COLUMN mode the VDP fetches plane A's scroll per column
     * too, and uninitialised entries shear the title text. */
    VDP_setScrollingMode(HSCROLL_PLANE, VSCROLL_COLUMN);
    VDP_setVerticalScrollTile(BG_A, 0, vsA, VS_COLS, DMA_QUEUE);
    hud_init();

    /* Palettes: PAL0 P1 ship + HUD text, PAL1 backdrop + bullets,
     * PAL2 enemies, PAL3 P2 ship (the pal-swap line).
     * Colours are BGR, 3 bits per channel: 0x0BGR with E = full. */
    PAL_setColor( 1, 0x0EEE);      /* P1 hull white                        */
    PAL_setColor( 2, 0x0EA0);      /* P1 cockpit teal                      */
    PAL_setColor( 3, 0x004E);      /* engine flame orange                  */
    PAL_setColor(15, 0x0EEE);      /* font white (index 15 = SGDK font)    */
    PAL_setColor(16 + 2, 0x00EE);  /* bullet yellow                        */
    PAL_setColor(16 + 4, 0x0411);  /* nebula deep blue                     */
    PAL_setColor(16 + 5, 0x0204);  /* nebula dark plum                     */
    PAL_setColor(16 + 6, 0x0CEE);  /* star bright                          */
    PAL_setColor(32 + 3, 0x022E);  /* enemy red                            */
    PAL_setColor(48 + 1, 0x04E4);  /* P2 hull green                        */
    PAL_setColor(48 + 2, 0x0AEA);  /* P2 cockpit pale green                */
    PAL_setColor(48 + 3, 0x004E);  /* engine flame orange                  */

    VDP_loadTileData(tile_ship,   T_SHIP,   1, DMA);
    VDP_loadTileData(tile_bullet, T_BULLET, 1, DMA);
    VDP_loadTileData(tile_enemy,  T_ENEMY,  1, DMA);
    VDP_loadTileData(tile_neb1,   T_NEB1,   1, DMA);
    VDP_loadTileData(tile_neb2,   T_NEB2,   1, DMA);
    VDP_loadTileData(tile_star,   T_STAR,   1, DMA);

    paint_backdrop();          /* plane B: painted once, scrolled forever  */
    sfx_init();                /* PSG: sfx channels + background melody    */

    state = ST_TITLE;
    cam = 0;
    apply_starfield();
    paint_title();

    while (TRUE) {
        if (state == ST_TITLE) {
            /* ── GAME LOGIC (clay) — title: A = 1P, B = 2P co-op ──
             * The starfield keeps falling so the title sells the
             * column-banded depth while the plane-A text holds still
             * (its VSRAM columns stay 0 — only plane B's get cam). */
            cam += 2;
            apply_starfield();
            stage_sprites();
            pad = JOY_readJoypad(JOY_1);
            fresh = pad & ~prev_pad;
            if (fresh & (BUTTON_A | BUTTON_C | BUTTON_START)) start_game(0);
            else if (fresh & BUTTON_B) start_game(1);
            prev_pad = pad;
            sfx_update();
            SYS_doVBlankProcess();
            continue;
        }

        if (state == ST_OVER) {
            /* Results screen; START or A returns to the title. The
             * starfield never stops — motion on every screen for free. */
            cam += 2;
            apply_starfield();
            stage_sprites();
            pad = JOY_readJoypad(JOY_1);
            fresh = pad & ~prev_pad;
            if (fresh & (BUTTON_START | BUTTON_A | BUTTON_C)) {
                state = ST_TITLE;
                prev_pad = 0xFFFF;     /* swallow the held START           */
                paint_title();
            } else {
                prev_pad = pad;
            }
            sfx_update();
            SYS_doVBlankProcess();
            continue;
        }

        /* ── ST_PLAY ──────────────────────────────────────────────────── */
        stage_sprites();
        cam += 2;
        apply_starfield();

        /* ── GAME LOGIC (clay) from here down ── */
        update_ship(0);
        if (two_player) update_ship(1);

        for (i = 0; i < MAX_BULLETS; i++) {
            if (!bullets[i].alive) continue;
            bullets[i].y -= 4;
            /* Despawn AT the HUD line, not off-screen: sprites draw OVER
             * the window plane (see the WINDOW idiom). */
            if (bullets[i].y < FIELD_TOP + 2) bullets[i].alive = FALSE;
        }
        for (i = 0; i < MAX_ENEMIES; i++) {
            if (!enemies[i].alive) continue;
            enemies[i].y += 1;
            if (enemies[i].y > 224) enemies[i].alive = FALSE;  /* slipped  *
                                                * past — no penalty, the   *
                                                * pressure IS the penalty  */
        }
        if (++spawn_timer >= 28) {
            spawn_timer = 0;
            spawn_enemy();
        }

        /* Bullets × enemies. */
        for (i = 0; i < MAX_BULLETS; i++) {
            u16 j;
            if (!bullets[i].alive) continue;
            for (j = 0; j < MAX_ENEMIES; j++) {
                if (!enemies[j].alive) continue;
                if (aabb_hit(&bullets[i], &enemies[j])) {
                    bullets[i].alive = FALSE;
                    enemies[j].alive = FALSE;
                    if (score < 65500u) score += 10;
                    sfx_noise(8);                        /* explosion      */
                    draw_hud();
                    break;
                }
            }
        }

        /* Enemies × ships: shared life pool (arcade co-op). */
        for (i = 0; i < MAX_ENEMIES; i++) {
            u16 p;
            if (!enemies[i].alive) continue;
            for (p = 0; p < 2; p++) {
                if (!ships[p].alive) continue;
                if (aabb_hit(&enemies[i], &ships[p])) {
                    enemies[i].alive = FALSE;
                    sfx_noise(14);
                    if (lives > 0) --lives;
                    draw_hud();
                    if (lives == 0) {
                        game_over();
                    } else {
                        /* respawn knockback to the start column */
                        ships[p].y = 200;
                        ships[p].x = p ? 184 : (two_player ? 120 : 156);
                    }
                    break;
                }
            }
            if (state != ST_PLAY) break;
        }

        sfx_update();
        SYS_doVBlankProcess();
    }
    return 0;
}
