/* ── platformer.c — Genesis side-scrolling platformer (complete example game) ─
 *
 * CINDER SPRINT — a COMPLETE, working game: title screen, 1P mode and 2P
 * ALTERNATING-TURNS mode (arcade-classic: players swap on death; each player
 * has their own score and own 3 lives; player 2 plays on CONTROLLER 2),
 * coins + distance scoring, persistent hi-score (cartridge SRAM), music +
 * SFX, and the Genesis's signature feature: DUAL-PLANE PARALLAX with
 * per-strip (cell) horizontal scroll — a dusk mountain ridge that slides at
 * HALF the foreground speed, under a hardware-fixed WINDOW-plane HUD.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented Genesis footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — level layout, physics tuning, scoring, art: reshape
 *     freely.
 *
 * What depends on what:
 *   genesis_sfx.{h,c} — PSG sound wrapper (tones + noise + a background
 *     melody loop). For full FM music, see the xgm2_demo template
 *     (XGM2_loadDriver + XGM2_play + a .xgc blob incbin'd via a data.s
 *     sibling) — we use the PSG path here so the platformer stays a
 *     single-file game; the swap is three lines plus the data.s sibling.
 *   rom_header.c (SGDK) — the Sega header at $100. Its 'RA' block at $1B0
 *     DECLARES the cartridge SRAM that hiscore_load/save below depend on
 *     (see the SRAM idiom). The build assembles it automatically.
 *
 * The level: a 512-px-wide COLUMN MAP (ground height + one-way slabs + pits)
 * painted once into plane A. The plane is exactly 512 px (64 cells) wide and
 * the VDP scroll WRAPS within the plane, so a forever-incrementing camera
 * loops the level seamlessly — an endless run of pits, slabs, coins and
 * spikes with ZERO tilemap writes per frame (hardware scroll is free;
 * rewriting tilemaps in the loop is the #1 "choppy movement" bug).
 *
 * Frame budget (NTSC, 60 fps): player physics + a two-column ground probe +
 * (3 coins + 2 spikes) of AABB + 56 hscroll words + 6 SAT entries queued for
 * vblank DMA — a tiny fraction of the 68000's frame. The vblank DMA budget
 * (~7 KB/frame in H40) is the real ceiling on Genesis; we use < 200 bytes.
 */

#include <genesis.h>
#include "genesis_sfx.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "CINDER SPRINT"

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * CONTROLLER MAPPING — two layers, both bite:
 *
 *   On the pad: SGDK's JOY_readJoypad(JOY_1/JOY_2) returns BUTTON_A/B/C/
 *   START/UP/DOWN/LEFT/RIGHT as a bitmask. Jump is BUTTON_A or BUTTON_C
 *   (real Genesis games map action buttons generously — thumbs rest on C).
 *
 *   Driving this game HEADLESSLY through an emulator (libretro/gpgx): the
 *   core maps Genesis A/B/C onto libretro Y/B/A. So setInput({y:true})
 *   presses GENESIS A (jump/start here), setInput({b:true}) presses GENESIS
 *   B (2P select), and setInput({a:true}) presses GENESIS C — NOT Genesis A.
 *   Getting this wrong looks like "the game ignores input". START is start.
 */
#define BTN_JUMP (BUTTON_A | BUTTON_C)

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile art. Genesis tiles are 4bpp: each u32 row = 8 pixels, one hex nibble
 * per pixel = a colour index into the tile's palette line (0 = transparent).
 * Sprites use PAL0, plane A (world) PAL1, plane B (backdrop) PAL2. */
#define T_GRASS   (TILE_USER_INDEX + 0)   /* plane A: ground surface       */
#define T_DIRT    (TILE_USER_INDEX + 1)   /* plane A: ground body          */
#define T_SLAB    (TILE_USER_INDEX + 2)   /* plane A: one-way platform     */
#define T_SKY     (TILE_USER_INDEX + 3)   /* plane B: dusk sky             */
#define T_CLOUD   (TILE_USER_INDEX + 4)   /* plane B: drifting cloud       */
#define T_PEAK    (TILE_USER_INDEX + 5)   /* plane B: mountain ridge tip   */
#define T_MOUNT   (TILE_USER_INDEX + 6)   /* plane B: mountain body        */
#define T_HUDBAND (TILE_USER_INDEX + 7)   /* plane B: flat band behind HUD */
#define T_PLAYER  (TILE_USER_INDEX + 8)   /* sprite: idle                  */
#define T_JUMP    (TILE_USER_INDEX + 9)   /* sprite: airborne              */
#define T_COIN    (TILE_USER_INDEX + 10)  /* sprite: pickup                */
#define T_SPIKE   (TILE_USER_INDEX + 11)  /* sprite: hazard                */

static const u32 tile_grass[8] = {        /* grass lip over speckled dirt  */
    0x11111111, 0x11111111, 0x22222222, 0x22322222,
    0x22222232, 0x22222222, 0x23222222, 0x22222322,
};
static const u32 tile_dirt[8] = {         /* speckles make motion visible  */
    0x22222222, 0x22232222, 0x22222222, 0x32222223,
    0x22222222, 0x22223222, 0x22222222, 0x23222222,
};
static const u32 tile_slab[8] = {         /* thin one-way platform (top    */
    0x44444444, 0x45555554, 0x55555555,   /* half only — jump up through   */
    0x05555550, 0x00000000, 0x00000000,   /* the transparent bottom)       */
    0x00000000, 0x00000000,
};
static const u32 tile_sky[8] = {
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
};
static const u32 tile_cloud[8] = {
    0x11111111, 0x11222111, 0x12222221, 0x22222222,
    0x12222221, 0x11111111, 0x11111111, 0x11111111,
};
static const u32 tile_peak[8] = {         /* ridge tip: triangle over sky  */
    0x11133111, 0x11333311, 0x13333331, 0x33333333,
    0x33433333, 0x33333333, 0x33333433, 0x33333333,
};
static const u32 tile_mount[8] = {        /* body speckled for parallax    */
    0x33333333, 0x33343333, 0x33333333,   /* visibility — a flat colour    */
    0x33333343, 0x43333333, 0x33333333,   /* shifted N px looks identical  */
    0x33334333, 0x33333333,               /* to itself (motion invisible)  */
};
static const u32 tile_hudband[8] = {
    0x55555555, 0x55555555, 0x55555555, 0x55555555,
    0x55555555, 0x55555555, 0x55555555, 0x55555555,
};
static const u32 tile_player[8] = {       /* ember sprite, idle            */
    0x00222200, 0x02222220, 0x22322322, 0x22222222,
    0x22222222, 0x02222220, 0x02200220, 0x02200220,
};
static const u32 tile_jump[8] = {         /* arms up, legs tucked          */
    0x22000022, 0x22222222, 0x02322320, 0x02222220,
    0x02222220, 0x00222200, 0x02000020, 0x20000002,
};
static const u32 tile_coin[8] = {
    0x00444400, 0x04555540, 0x45444454, 0x45444454,
    0x45444454, 0x45444454, 0x04555540, 0x00444400,
};
static const u32 tile_spike[8] = {
    0x00000000, 0x00077000, 0x00077000, 0x00766700,
    0x00766700, 0x07666670, 0x07666670, 0x76666667,
};

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * The level — a 64-column map; world x = (screen x + camera) mod 512.
 *   ground_row[c] — plane row of the grass top, 0xFF = pit.
 *   plat_row[c]   — row of a one-way slab, 0 = none.
 * Rows are PLANE rows (y = row*8). Rows 0-1 sit under the HUD window;
 * playfield rows are 2..27 (the visible 224-px screen is 28 rows). */
#define NO_GROUND 0xFF
#define GROUND_R  24                       /* default ground surface row   */
static const u8 ground_row[64] = {
    24, 24, 24, 24, 24, 24, 24, 24,                    /* start runway     */
    24, 24, 24, 24, 24, 24, 24, 24,
    24, 24, 24, 24, NO_GROUND, NO_GROUND, NO_GROUND,   /* pit 1 (24 px)    */
    24, 24, 24, 24, 24, 24, 24, 24, 24,
    24, 24, NO_GROUND, NO_GROUND, 24, 24, 24,          /* pit 2 (16 px)    */
    24, 24, 24, 24, 24, 24, 24, 24,
    NO_GROUND, NO_GROUND, NO_GROUND, 24, 24, 24,       /* pit 3 (24 px)    */
    24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
};
static const u8 plat_row[64] = {
    0,  0,  0,  0,  0,  0, 21, 21,                     /* warm-up slab     */
    21, 0,  0,  0,  0,  0,  0,  0,
    0,  19, 19, 19, 19, 0,  0,  0,                     /* bridge over pit 1*/
    0,  0,  0,  21, 21, 0,  0,  0,
    0,  0,  19, 19, 0,  0,  0,  0,                     /* hop over pit 2   */
    0,  21, 21, 0,  0,  17, 17, 17,                    /* stairs up...     */
    0,  0,  19, 19, 0,  0,  0,  0,                     /* ...and over pit 3*/
    0,  0,  0,  0,  21, 21, 21, 0,
};
/* Mountain ridge silhouette for plane B — 16-column period (128 px), so a
 * half-speed shift is unambiguous to the eye (and to a headless pixel
 * probe). Values are the plane row of each column's ridge tip. */
static const u8 ridge_top[16] = {
    13, 12, 11, 10, 10, 11, 12, 13, 14, 13, 11, 10, 11, 12, 13, 14,
};

/* ── GAME LOGIC (clay) — physics + tuning (Q4.4 fixed point: 16 = 1 px) ── */
#define GRAVITY_Q44    1     /* +1/16 px per frame per frame               */
#define JUMP_VEL_Q44 (-40)   /* launch vy → ~50 px apex (~6 tile rows)     */
#define MAX_VY_Q44    80     /* terminal 5 px/frame — MUST stay under 6:   *
                              * the landing probe's 6-px window can't      *
                              * catch a faster fall (tunnelling)           */
#define MOVE_SPEED     2     /* px/frame walk + scroll speed               */
#define SCROLL_WALL  144     /* px: past this the world scrolls, not you   */
#define GROUND_TOP   192     /* GROUND_R * 8                               */
#define SPIKE_Y      184     /* spikes stand on the ground                 */
#define SCREEN_W     320     /* H40 mode                                   */
#define NUM_COINS      3
#define NUM_SPIKES     2
#define START_LIVES    3
#define HUD_ROWS       2     /* window rows reserved for the HUD          */

static s16  px;              /* player screen x                            */
static u16  py_q44;          /* player y, Q4.4 — gravity adds <1 px/frame  *
                              * near the apex; integer y would stick       */
static s16  vy_q44;
static u8   on_ground;
static u16  cam;             /* camera/world scroll. NEVER reset mid-run   *
                              * and never wrapped by hand: the plane is    *
                              * 512 px and the VDP masks scroll values to  *
                              * the plane, and 65536 is a multiple of 512  *
                              * (and of 512*2 and 512*8), so plain u16     *
                              * overflow keeps BOTH parallax layers        *
                              * seamless forever.                          */
static u8   dist_sub;        /* sub-counter: 64 px scrolled = +1 point     */
static s16  coin_x[NUM_COINS];
static s16  coin_y[NUM_COINS];
static s16  spike_x[NUM_SPIKES];
static u8   spike_active[NUM_SPIKES];

/* Players: index 0 = P1 (controller 1), 1 = P2 (controller 2 — alternating
 * turns, arcade-classic style). Each has own score + own lives; the HUD
 * shows the CURRENT player's numbers. */
static u8   two_player;
static u8   cur_player;
static u8   p_lives[2];
static u16  p_score[2];
static u16  hiscore;
static u8   turn_pause;      /* freeze frames after a turn change          */
static u16  rng = 0xC0DE;

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static u8  state;
static u16 prev_pad;

/* ── GAME LOGIC (clay) — xorshift16 PRNG (a few 68k instructions) ── */
static u8 random8(void) {
    u16 r = rng;
    r ^= r << 7;
    r ^= r >> 9;
    r ^= r << 8;
    rng = r;
    return (u8)r;
}

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
 * DUAL-PLANE PARALLAX + per-strip scroll — THE Genesis signature. The VDP
 * composites two independent tilemap planes (A above B), each with its own
 * horizontal scroll, and the scroll can vary DOWN THE SCREEN:
 *
 *   VDP_setScrollingMode(HSCROLL_TILE, VSCROLL_PLANE) tells the VDP to
 *   fetch one hscroll entry per 8-LINE STRIP from the hscroll table in
 *   VRAM (28 strips cover the 224-line screen) instead of one per frame.
 *   Each strip entry is a pair of words: plane A's offset, then plane B's.
 *
 * Per frame we queue two 28-word tables:
 *   plane A: every strip = -cam        (the world, 1:1 with the camera)
 *   plane B: sky strips  = -(cam / 8)  (far: barely moves)
 *            ridge strips= -(cam / 2)  (the half-speed mountain layer)
 * Three speeds from two planes — banding ONE plane by strip is how real
 * carts faked 3+ layers. POSITIVE camera = NEGATIVE scroll value (the
 * scroll offset slides the plane right; we want the world to slide left).
 *
 * DELUXE VARIANT (not used here, same table): HSCROLL_LINE gives one entry
 * per SCANLINE — 224 s16s per plane. Fill them with smooth per-line speeds
 * for a sky gradient, or add sin(line+frame) ripple inside a water band
 * (VDP_setHorizontalScrollLine). Costs ~1.8 KB/frame of vblank DMA versus
 * our 224 bytes, so budget it (H40 vblank fits ~7 KB).
 *
 * Requires: HSCROLL_TILE mode set BEFORE the first table write; BOTH
 *   tables queued every frame you move the camera (a stale plane-A table
 *   shears the world); DMA_QUEUE so the VRAM writes land in vblank, never
 *   mid-frame (SYS_doVBlankProcess flushes the queue — mid-frame writes
 *   tear the strip boundary); the value arrays static (the queue reads
 *   them AT FLUSH TIME — stack arrays are gone by then, shipping garbage).
 * Plane-size note: A and B share ONE size setting (default 64x32 cells =
 *   512x256 px). You can't size them independently. */
#define SKY_STRIPS 10                  /* strips 0-9 = HUD band + sky      */
static s16 hsA[28];
static s16 hsB[28];
static void apply_camera(void) {
    u16 i;
    for (i = 0; i < 28; i++) {
        hsA[i] = -(s16)cam;
        hsB[i] = (i < SKY_STRIPS) ? -(s16)(cam >> 3) : -(s16)(cam >> 1);
    }
    VDP_setHorizontalScrollTile(BG_A, 0, hsA, 28, DMA_QUEUE);
    VDP_setHorizontalScrollTile(BG_B, 0, hsB, 28, DMA_QUEUE);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * WINDOW-PLANE HUD — the fixed status bar. The window is a third tilemap
 * that REPLACES plane A wherever it's shown and IGNORES ALL SCROLLING —
 * a hardware-fixed HUD with zero per-frame cost. (The NES needs a sprite-0
 * raster trick for this; on Genesis it's one register.)
 * VDP_setWindowOnTop(2) shows it on the top 2 cell rows; text goes in with
 * VDP_drawTextBG(WINDOW, ...). Two footguns:
 *   - The window only lives at screen edges (top/bottom N rows or left/
 *     right N columns) — it cannot float mid-screen.
 *   - It replaces plane A ONLY: plane B and sprites still render behind/
 *     over it. We paint plane B's top rows with a flat dark band so HUD
 *     text always reads, and nothing in the game flies above y=16. */
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
    b[0] = 'P'; b[1] = '1' + cur_player; b[2] = 0;
    VDP_drawTextBG(WINDOW, b, 1, 0);
    b[0] = 'x'; b[1] = '0' + p_lives[cur_player]; b[2] = 0;
    VDP_drawTextBG(WINDOW, b, 4, 0);
    VDP_drawTextBG(WINDOW, "SC", 8, 0);
    draw_u16(WINDOW, p_score[cur_player], 11, 0);
    VDP_drawTextBG(WINDOW, "HI", 18, 0);
    draw_u16(WINDOW, hiscore, 21, 0);
}

static void draw_hud_title(void) {
    VDP_clearTextAreaBG(WINDOW, 0, 0, 40, HUD_ROWS);
    VDP_drawTextBG(WINDOW, "HI", 18, 0);
    draw_u16(WINDOW, hiscore, 21, 0);
}

/* ── GAME LOGIC (clay) — paint the two planes ───────────────────────────────
 * Plane B (backdrop) is painted ONCE at boot and never touched again.
 * Plane A is repainted on state changes only (title text ↔ the level).
 * NOTHING repaints inside the frame loop — scroll is hardware. */
static void paint_backdrop(void) {
    u16 c, r;
    /* Flat dark band behind the window HUD (rows 0-1). */
    VDP_fillTileMapRect(BG_B, TILE_ATTR_FULL(PAL2, 0, 0, 0, T_HUDBAND),
                        0, 0, 64, HUD_ROWS);
    for (c = 0; c < 64; c++) {
        u16 top = ridge_top[c & 15];
        /* Dusk sky with deterministic clouds (PRNG would repaint different
         * art after a console reset — fine, but determinism helps tests). */
        for (r = HUD_ROWS; r < top; r++) {
            u16 t = (((r * 5 + c * 11) & 31) == 0 && r >= 3) ? T_CLOUD : T_SKY;
            VDP_setTileMapXY(BG_B, TILE_ATTR_FULL(PAL2, 0, 0, 0, t), c, r);
        }
        VDP_setTileMapXY(BG_B, TILE_ATTR_FULL(PAL2, 0, 0, 0, T_PEAK), c, top);
        VDP_fillTileMapRect(BG_B, TILE_ATTR_FULL(PAL2, 0, 0, 0, T_MOUNT),
                            c, top + 1, 1, 32 - (top + 1));
    }
}

static void paint_level(void) {
    u16 c;
    VDP_clearPlane(BG_A, TRUE);
    for (c = 0; c < 64; c++) {
        u8 g = ground_row[c];
        if (g != NO_GROUND) {
            VDP_setTileMapXY(BG_A, TILE_ATTR_FULL(PAL1, 0, 0, 0, T_GRASS), c, g);
            VDP_fillTileMapRect(BG_A, TILE_ATTR_FULL(PAL1, 0, 0, 0, T_DIRT),
                                c, g + 1, 1, 32 - (g + 1));
        }
        if (plat_row[c])
            VDP_setTileMapXY(BG_A, TILE_ATTR_FULL(PAL1, 0, 0, 0, T_SLAB),
                             c, plat_row[c]);
    }
}

/* ── GAME LOGIC (clay) — the title screen (text on plane A, scroll 0) ── */
static void paint_title(void) {
    VDP_clearPlane(BG_A, TRUE);
    VDP_drawTextBG(BG_A, GAME_TITLE, (40 - (sizeof(GAME_TITLE) - 1)) / 2, 8);
    VDP_drawTextBG(BG_A, "1P START - A", 14, 14);
    VDP_drawTextBG(BG_A, "2P TURNS - B", 14, 16);
    VDP_drawTextBG(BG_A, "JUMP THE PITS - GRAB THE COINS", 5, 21);
    draw_hud_title();
}

/* ── GAME LOGIC (clay) — the game-over results screen ── */
static void paint_over(void) {
    VDP_clearPlane(BG_A, TRUE);
    VDP_drawTextBG(BG_A, "GAME OVER", 15, 8);
    VDP_drawTextBG(BG_A, "P1", 13, 12);
    draw_u16(BG_A, p_score[0], 17, 12);
    if (two_player) {
        VDP_drawTextBG(BG_A, "P2", 13, 14);
        draw_u16(BG_A, p_score[1], 17, 14);
    }
    VDP_drawTextBG(BG_A, "HI", 13, 17);
    draw_u16(BG_A, hiscore, 17, 17);
    VDP_drawTextBG(BG_A, "START - TITLE", 13, 21);
}

/* ── GAME LOGIC (clay) — coins + spikes (sprite objects in the world) ── */
static const s16 coin_heights[4] = { 168, 144, 120, 152 };
static void respawn_coin(u16 i) {
    coin_x[i] = SCREEN_W + 8 + (random8() & 31);   /* enter at the right  */
    coin_y[i] = coin_heights[random8() & 3];
}

static void try_spawn_spike(u16 i) {
    /* Anchor only over ground: an inactive spike rolls a low per-frame
     * chance, and only spawns if the level column entering at the right
     * edge has ground under it (never floats over a pit). */
    u16 c = ((u16)(SCREEN_W + 8 + cam) >> 3) & 63;
    if (ground_row[c] == NO_GROUND) return;
    if (random8() > 4) return;
    spike_x[i] = SCREEN_W + 8;
    spike_active[i] = 1;
}

/* ── GAME LOGIC (clay) — start a turn / a run ── */
static void begin_turn(void) {
    u16 i;
    px = 24;
    py_q44 = (u16)(GROUND_TOP - 8) << 4;
    vy_q44 = 0;
    on_ground = 1;
    cam = 0;
    dist_sub = 0;
    coin_x[0] = 120; coin_y[0] = 168;
    coin_x[1] = 200; coin_y[1] = 144;
    coin_x[2] = 280; coin_y[2] = 120;
    for (i = 0; i < NUM_SPIKES; i++) spike_active[i] = 0;
    spike_x[0] = 232; spike_active[0] = 1;   /* runway columns — always    */
    spike_x[1] = 304; spike_active[1] = 1;   /* ground at cam 0            */
    turn_pause = 48;                         /* "P1/P2 ready" breather     */
    prev_pad = 0xFFFF;                       /* swallow held buttons across*
                                              * the turn change            */
    apply_camera();
    draw_hud();
}

static void start_game(u8 players) {
    two_player = players;
    cur_player = 0;
    p_score[0] = p_score[1] = 0;
    p_lives[0] = START_LIVES;
    p_lives[1] = players ? START_LIVES : 0;
    paint_level();
    begin_turn();
    sfx_tone(0, 523, 10);                    /* start jingle (C5)          */
    state = ST_PLAY;
}

static void game_over(void) {
    u16 best = p_score[0];
    if (two_player && p_score[1] > best) best = p_score[1];
    if (best > hiscore) {
        hiscore = best;
        hiscore_save(hiscore);   /* battery SRAM — see the SRAM idiom      */
    }
    state = ST_OVER;
    cam = 0;
    apply_camera();
    draw_hud();      /* refresh the window HUD — HI may have just changed */
    paint_over();
}

/* ── GAME LOGIC (clay) — death + alternating-turn handoff ── */
static void kill_player(void) {
    u8 other;
    sfx_noise(14);
    if (p_lives[cur_player] > 0) --p_lives[cur_player];
    if (two_player) {
        other = cur_player ^ 1;
        if (p_lives[other] > 0) cur_player = other;          /* swap turns */
        else if (p_lives[cur_player] == 0) { game_over(); return; }
    } else if (p_lives[0] == 0) {
        game_over();
        return;
    }
    begin_turn();
}

/* ── GAME LOGIC (clay) — landing probe against the column map ──────────────
 * One-way platforms, arcade-classic style: only catch the player while
 * FALLING through a narrow window at the surface: top-1 (the standing snap
 * parks feet exactly at top, and gravity's sub-pixel trickle doesn't move
 * the integer y every frame — without the -1 slack the player "stands"
 * with on_ground=0 most frames and jumps only register on lucky frames)
 * through top+4 (so a 5 px/frame terminal fall can't step over it). */
static s16 land_top(u16 c, s16 feet) {
    u8 r;
    s16 top;
    r = plat_row[c];
    if (r) {
        top = (s16)r << 3;
        if (feet + 1 >= top && feet <= top + 4) return top;
    }
    r = ground_row[c];
    if (r != NO_GROUND) {
        top = (s16)r << 3;
        if (feet + 1 >= top && feet <= top + 4) return top;
    }
    return 0;
}

/* ── GAME LOGIC (clay) — stage this frame's sprites ─────────────────────────
 * Fixed SAT slots: 0 = player, 1-3 = coins, 4-5 = spikes. Hidden sprites
 * park at y = -16 (above the screen). NEVER hide with x = -128..0 — a SAT
 * x of 0 is the VDP's sprite-masking trigger and silently blanks every
 * lower-priority sprite on those scanlines. */
#define HIDE_Y (-16)
static void stage_sprites(void) {
    u16 i;
    s16 player_y = (s16)(py_q44 >> 4);
    if (state != ST_PLAY)                      /* no actors off the field  */
        VDP_setSprite(0, px, HIDE_Y, SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(PAL0, 1, 0, 0, T_PLAYER));
    else if (turn_pause == 0 || (turn_pause & 4))   /* blink on handoff    */
        VDP_setSprite(0, px, player_y, SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(PAL0, 1, 0, 0, on_ground ? T_PLAYER : T_JUMP));
    else
        VDP_setSprite(0, px, HIDE_Y, SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(PAL0, 1, 0, 0, T_PLAYER));
    for (i = 0; i < NUM_COINS; i++) {
        s16 cx = coin_x[i];
        VDP_setSprite(1 + i, (state == ST_PLAY && cx < SCREEN_W) ? cx : (s16)SCREEN_W,
                      (state == ST_PLAY && cx < SCREEN_W) ? coin_y[i] : (s16)HIDE_Y,
                      SPRITE_SIZE(1, 1), TILE_ATTR_FULL(PAL0, 1, 0, 0, T_COIN));
    }
    for (i = 0; i < NUM_SPIKES; i++) {
        u8 vis = (state == ST_PLAY) && spike_active[i] && spike_x[i] < SCREEN_W;
        VDP_setSprite(4 + i, spike_x[i], vis ? (s16)SPIKE_Y : (s16)HIDE_Y,
                      SPRITE_SIZE(1, 1), TILE_ATTR_FULL(PAL0, 1, 0, 0, T_SPIKE));
    }
    /* ── HARDWARE IDIOM (load-bearing) — CHAIN the sprite list before
     * uploading. VDP_setSprite does NOT set the SAT link byte, and link 0
     * means "end of list": skip this and the VDP draws sprite 0 only.
     * VDP_linkSprites(0, 6) links slots 0..5; the queued DMA flushes the
     * 6 SAT entries during vblank. ── */
    VDP_linkSprites(0, 6);
    VDP_updateSprites(6, DMA_QUEUE);
}

int main(bool hard) {
    u16 i, pad, fresh;
    s16 delta, y, feet, top;
    u16 c0, c1;
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
     * apply_camera() writes the table layout the VDP is actually reading. */
    VDP_setScrollingMode(HSCROLL_TILE, VSCROLL_PLANE);
    hud_init();

    /* Palettes: PAL0 sprites + HUD text, PAL1 plane A, PAL2 plane B.
     * Colours are BGR, 3 bits per channel: 0x0BGR with E = full. */
    PAL_setColor( 2, 0x028E);  /* player ember orange      */
    PAL_setColor( 3, 0x0008);  /* player eyes dark red     */
    PAL_setColor( 4, 0x02CE);  /* coin gold                */
    PAL_setColor( 5, 0x008C);  /* coin shading             */
    PAL_setColor( 6, 0x0888);  /* spike steel              */
    PAL_setColor( 7, 0x0CCC);  /* spike highlight          */
    PAL_setColor(15, 0x0EEE);  /* font white (index 15 = SGDK font colour) */
    PAL_setColor(16 + 1, 0x04A2);  /* grass dusk green     */
    PAL_setColor(16 + 2, 0x0248);  /* dirt brown           */
    PAL_setColor(16 + 3, 0x0136);  /* dirt speckle         */
    PAL_setColor(16 + 4, 0x0666);  /* slab stone           */
    PAL_setColor(16 + 5, 0x0AAA);  /* slab lip             */
    PAL_setColor(32 + 1, 0x036C);  /* dusk sky orange      */
    PAL_setColor(32 + 2, 0x08AE);  /* cloud pink           */
    PAL_setColor(32 + 3, 0x0413);  /* mountain dark purple */
    PAL_setColor(32 + 4, 0x0635);  /* mountain speckle     */
    PAL_setColor(32 + 5, 0x0202);  /* HUD band near-black  */

    VDP_loadTileData(tile_grass,   T_GRASS,   1, DMA);
    VDP_loadTileData(tile_dirt,    T_DIRT,    1, DMA);
    VDP_loadTileData(tile_slab,    T_SLAB,    1, DMA);
    VDP_loadTileData(tile_sky,     T_SKY,     1, DMA);
    VDP_loadTileData(tile_cloud,   T_CLOUD,   1, DMA);
    VDP_loadTileData(tile_peak,    T_PEAK,    1, DMA);
    VDP_loadTileData(tile_mount,   T_MOUNT,   1, DMA);
    VDP_loadTileData(tile_hudband, T_HUDBAND, 1, DMA);
    VDP_loadTileData(tile_player,  T_PLAYER,  1, DMA);
    VDP_loadTileData(tile_jump,    T_JUMP,    1, DMA);
    VDP_loadTileData(tile_coin,    T_COIN,    1, DMA);
    VDP_loadTileData(tile_spike,   T_SPIKE,   1, DMA);

    paint_backdrop();          /* plane B: painted once, scrolled forever */
    sfx_init();                /* PSG: sfx channels + background melody   */

    state = ST_TITLE;
    cam = 0;
    apply_camera();
    paint_title();

    while (TRUE) {
        if (state == ST_TITLE) {
            /* ── GAME LOGIC (clay) — title: A = 1P, B = 2P turns ──
             * The camera drifts so the title sells the parallax: plane B
             * slides at two speeds while the plane-A title text holds
             * still (its strip values stay 0 — only B's get the drift). */
            cam += 1;
            for (i = 0; i < 28; i++) {
                hsA[i] = 0;
                hsB[i] = (i < SKY_STRIPS) ? -(s16)(cam >> 3) : -(s16)(cam >> 1);
            }
            VDP_setHorizontalScrollTile(BG_A, 0, hsA, 28, DMA_QUEUE);
            VDP_setHorizontalScrollTile(BG_B, 0, hsB, 28, DMA_QUEUE);
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
            /* Results screen; START or A returns to the title. */
            stage_sprites();
            pad = JOY_readJoypad(JOY_1);
            fresh = pad & ~prev_pad;
            if (fresh & (BUTTON_START | BUTTON_A | BUTTON_C)) {
                state = ST_TITLE;
                cam = 0;
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
        apply_camera();

        if (turn_pause) {              /* freeze gameplay, keep frames     */
            --turn_pause;              /* honest (sprites/scroll staged)   */
            sfx_update();
            SYS_doVBlankProcess();
            continue;
        }

        /* ── GAME LOGIC (clay) from here down ─────────────────────────────
         * Input — the CURRENT player's controller (alternating turns: P2
         * is on controller 2). Past SCROLL_WALL the world scrolls instead
         * of the player (the camera never scrolls back — the classic
         * one-way runner camera). */
        pad = JOY_readJoypad(cur_player ? JOY_2 : JOY_1);
        delta = 0;
        if (pad & BUTTON_RIGHT) {
            if (px < SCROLL_WALL) px += MOVE_SPEED;
            else { cam += MOVE_SPEED; delta = MOVE_SPEED; }
        }
        if ((pad & BUTTON_LEFT) && px > 8) px -= MOVE_SPEED;
        if ((pad & BTN_JUMP) && !(prev_pad & BTN_JUMP) && on_ground) {
            vy_q44 = JUMP_VEL_Q44;
            on_ground = 0;
            sfx_tone(0, 784, 8);                         /* jump whoop     */
        }
        prev_pad = pad;

        /* World objects drift left as the level scrolls (world-anchored). */
        if (delta) {
            dist_sub += delta;
            if (dist_sub >= 64) {                        /* distance pay   */
                dist_sub -= 64;
                ++p_score[cur_player];
                draw_hud();
            }
            for (i = 0; i < NUM_COINS; i++) {
                coin_x[i] -= delta;
                if (coin_x[i] < 8) respawn_coin(i);
            }
            for (i = 0; i < NUM_SPIKES; i++) {
                if (!spike_active[i]) continue;
                spike_x[i] -= delta;
                if (spike_x[i] < 8) spike_active[i] = 0;
            }
        }
        for (i = 0; i < NUM_SPIKES; i++)
            if (!spike_active[i]) try_spawn_spike(i);

        /* Physics: gravity + sub-pixel y. */
        if (vy_q44 < MAX_VY_Q44) vy_q44 += GRAVITY_Q44;
        py_q44 += vy_q44;
        y = (s16)(py_q44 >> 4);

        /* Fell into a pit (below the screen) → lose the turn. */
        if (y >= 224) {
            kill_player();
            sfx_update();
            SYS_doVBlankProcess();
            continue;
        }

        /* Landing — probe the two level columns under the player's feet. */
        if (vy_q44 >= 0) {
            feet = y + 8;
            c0 = ((u16)(px + cam) >> 3) & 63;
            c1 = ((u16)(px + cam + 7) >> 3) & 63;
            top = land_top(c0, feet);
            if (top == 0) top = land_top(c1, feet);
            if (top) {
                py_q44 = (u16)(top - 8) << 4;
                vy_q44 = 0;
                if (!on_ground) sfx_tone(1, 196, 4);     /* landing thud   */
                on_ground = 1;
            } else {
                on_ground = 0;                           /* walked off     */
            }
        }

        /* Coins (collect) + spikes (death). AABB on 8x8 sprites. */
        for (i = 0; i < NUM_COINS; i++) {
            if (coin_x[i] < px + 8 && coin_x[i] + 8 > px &&
                coin_y[i] < y + 8 && coin_y[i] + 8 > y) {
                p_score[cur_player] += 10;
                sfx_tone(0, 1047, 6);                    /* coin ping      */
                draw_hud();
                respawn_coin(i);
            }
        }
        for (i = 0; i < NUM_SPIKES; i++) {
            if (!spike_active[i]) continue;
            if (spike_x[i] < px + 7 && spike_x[i] + 7 > px &&
                SPIKE_Y < y + 7 && SPIKE_Y + 7 > y) {
                kill_player();
                break;
            }
        }

        sfx_update();
        SYS_doVBlankProcess();
    }
    return 0;
}
