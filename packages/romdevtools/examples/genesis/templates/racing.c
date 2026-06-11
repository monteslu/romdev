/* ── racing.c — Genesis top-down road racer (complete example game) ──────────
 *
 * MIRAGE MILE — a COMPLETE, working game: title screen, 1P endless race with
 * speed control, 2P simultaneous SPLIT-LANE VERSUS (both cars on screen at
 * once — player 2 on CONTROLLER 2), a vertically-scrolling road done the
 * Genesis way (full-plane hardware VSCROLL), streamed roadside scenery
 * through the DMA queue, crash/lives rules, persistent best distance
 * (cartridge SRAM), music + SFX — and a LIVE per-scanline HSCROLL_LINE
 * heat-haze band shimmering across the asphalt, the deluxe scroll variant
 * the platformer template only documents.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented Genesis footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — traffic patterns, speeds, tuning, art: reshape
 *     freely.
 *
 * What depends on what:
 *   genesis_sfx.{h,c} — PSG sound wrapper (tones + noise + a background
 *     melody loop). For full FM music, see the xgm2_demo template.
 *   rom_header.c (SGDK) — the Sega header at $100. Its 'RA' block at $1B0
 *     DECLARES the cartridge SRAM that best_load/save below depend on (see
 *     the SRAM idiom). The build assembles it automatically.
 *
 * THE DESIGN (read before reshaping):
 *   Scrolling — the road is PLANE A, scrolled down by decrementing one
 *     vertical-scroll value per frame. Compare the NES version of this
 *     game (examples/nes/templates/racing.c): there a nametable is 240 px
 *     tall, scroll_y 240-255 fetches attribute bytes as tiles (garbage
 *     rows), and every scroll change goes through a wrap helper. The
 *     Genesis plane is 256 px tall and the VDP masks the scroll value to
 *     the plane IN HARDWARE: `vs -= speed` on a plain u16 is the entire
 *     idiom (65536 is a multiple of 256, so overflow is seamless forever).
 *   Streamed scenery — rows re-entering at the top get restamped with
 *     fresh random roadside through the DMA queue, hidden under the
 *     16-px WINDOW HUD (the same curtain trick the NES game plays with
 *     the overscan-cropped top band).
 *   Heat haze — HSCROLL_LINE mode: the VDP fetches one hscroll entry PER
 *     SCANLINE, so a 32-line band of the road ripples ±2 px in a moving
 *     wave while the rest of the screen holds still. 64 bytes/frame of
 *     vblank DMA. Sprites are NOT displaced — per-line hscroll bends
 *     planes only.
 *   HUD — the WINDOW plane: a hardware-fixed status bar that ignores all
 *     scrolling (no raster tricks needed — one register).
 *   2P VERSUS — ONE VDP means ONE road scroll, so both players share one
 *     road at a fixed speed and only steer (the same constraint the NES
 *     version explains): solid center divider, P1 (blue, pad 1) owns the
 *     left two lanes, P2 (green, pad 2) the right two. Each starts with 3
 *     crashes; first to use them all LOSES.
 *   1P RACE — all four lanes, A/UP accelerates, B/DOWN brakes (speed 1-4);
 *     3 crashes end the run. Persistent stat: best DISTANCE (u16, one
 *     unit = 16 scrolled pixels ≈ one car length) via best_load/save.
 *
 * Frame budget (NTSC, 60 fps): 6 traffic × 2 cars of AABB, one 64-cell row
 * restamp at most every other frame (128 B), the 32-entry haze table (64 B)
 * and 8 SAT entries (64 B) queued for vblank — ~300 bytes of the ~7 KB
 * H40 vblank DMA ceiling. The 68000 barely notices.
 */

#include <genesis.h>
#include "genesis_sfx.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "MIRAGE MILE"

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * CONTROLLER MAPPING — two layers, both bite:
 *
 *   On the pad: SGDK's JOY_readJoypad(JOY_1/JOY_2) returns BUTTON_A/B/C/
 *   START/UP/DOWN/LEFT/RIGHT as a bitmask. Gas is BUTTON_A or UP, brake is
 *   BUTTON_B or DOWN (real Genesis racers double the face buttons onto the
 *   d-pad so either thumb works).
 *
 *   Driving this game HEADLESSLY through an emulator (libretro/gpgx): the
 *   core maps Genesis A/B/C onto libretro Y/B/A. So setInput({y:true})
 *   presses GENESIS A (gas/1P start here), setInput({b:true}) presses
 *   GENESIS B (brake/2P select), and setInput({a:true}) presses GENESIS C —
 *   NOT Genesis A. Getting this wrong looks like "the game ignores input".
 *   START is start.
 */
#define BTN_GAS   (BUTTON_A | BUTTON_UP)
#define BTN_BRAKE (BUTTON_B | BUTTON_DOWN)

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile art. Genesis tiles are 4bpp: each u32 row = 8 pixels, one hex nibble
 * per pixel = a colour index into the tile's palette line (0 = transparent).
 * Road plane (A) uses PAL1; the HUD band on plane B uses PAL2; sprites pick
 * their line per-sprite (P1 PAL0, traffic PAL2, P2 PAL3) so ONE car tile
 * serves three liveries. */
#define T_GRASS   (TILE_USER_INDEX + 0)   /* plane A: roadside base        */
#define T_TUFT    (TILE_USER_INDEX + 1)   /* plane A: scenery, common      */
#define T_TREE    (TILE_USER_INDEX + 2)   /* plane A: scenery, rare        */
#define T_ASPHALT (TILE_USER_INDEX + 3)   /* plane A: road surface         */
#define T_SPECK   (TILE_USER_INDEX + 4)   /* plane A: textured asphalt     */
#define T_EDGE    (TILE_USER_INDEX + 5)   /* plane A: solid shoulder line  */
#define T_DASH    (TILE_USER_INDEX + 6)   /* plane A: dashed lane line     */
#define T_DIVIDE  (TILE_USER_INDEX + 7)   /* plane A: double center line   */
#define T_BAND    (TILE_USER_INDEX + 8)   /* plane B: flat band behind HUD */
#define T_CAR     (TILE_USER_INDEX + 9)   /* sprite: player car, nose up   */
#define T_TRAFFIC (TILE_USER_INDEX + 10)  /* sprite: slow traffic, tail up */

static const u32 tile_grass[8] = {        /* speckles make motion visible  */
    0x11111111, 0x11121111, 0x11111111, 0x21111112,
    0x11111111, 0x11112111, 0x11111111, 0x12111111,
};
static const u32 tile_tuft[8] = {
    0x11111111, 0x11121111, 0x11222111, 0x12222211,
    0x11222111, 0x11121111, 0x11111111, 0x12111121,
};
static const u32 tile_tree[8] = {
    0x11166111, 0x11666611, 0x16666661, 0x16666661,
    0x11666611, 0x11122111, 0x11122111, 0x11111111,
};
static const u32 tile_asphalt[8] = {      /* a flat colour shifted N px    */
    0x44444444, 0x44445444, 0x44444444,   /* looks identical to itself —   */
    0x54444444, 0x44444444, 0x44444454,   /* the speckle is what makes the */
    0x44444444, 0x44544444,               /* scroll readable               */
};
static const u32 tile_speck[8] = {
    0x44444444, 0x44544444, 0x44455444, 0x44444444,
    0x44444454, 0x45444444, 0x44444444, 0x44445444,
};
static const u32 tile_edge[8] = {         /* solid white shoulder stripe   */
    0x44334444, 0x44334444, 0x44334444, 0x44334444,
    0x44334444, 0x44334444, 0x44334444, 0x44334444,
};
static const u32 tile_dash[8] = {         /* 4 px on, 4 off: stacked tiles */
    0x44433444, 0x44433444, 0x44433444,   /* read as a dashed lane line    */
    0x44433444, 0x44444444, 0x44444444,
    0x44444444, 0x44444444,
};
static const u32 tile_divide[8] = {       /* double line = 2P territory    */
    0x43344334, 0x43344334, 0x43344334,   /* border                        */
    0x43344334, 0x43344334, 0x43344334,
    0x43344334, 0x43344334,
};
static const u32 tile_band[8] = {
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
};
static const u32 tile_car[8] = {          /* nose up; 1 = body, 2 = glass  */
    0x00111100, 0x01111110, 0x11222211, 0x11111111,
    0x01111110, 0x11222211, 0x11111111, 0x01100110,
};
static const u32 tile_traffic[8] = {      /* tail up (it's slower traffic  */
    0x03300330, 0x33333333, 0x33444433,   /* you overtake, so you see its  */
    0x03333330, 0x33333333, 0x33444433,   /* rear). Colours 3/4, NOT 1/2:  */
    0x03333330, 0x00333300,               /* it shares PAL2 with the HUD   */
};                                        /* band, whose dark is index 1.  */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Road geometry. Four 4-cell-wide lanes between shoulders, a double center
 * divider (it's also the 2P territory line). Plane columns (cells):
 *   12 = left shoulder, 16/24 = dashed lane lines, 20 = center divider,
 *   28 = right shoulder; grass outside. The plane is 64 cells wide — paint
 *   ALL 64 (the haze wobble slides up to 2 px of the plane's wrap onto the
 *   screen edge; bare cells there would flash black). */
#define COL_EDGE_L   12
#define COL_DASH_1   16
#define COL_DIVIDER  20
#define COL_DASH_2   24
#define COL_EDGE_R   28
/* Lane center X for the 8px-wide car sprite (lane i spans 32 px). */
static const s16 lane_x[4] = { 108, 140, 172, 204 };

#define MAX_TRAFFIC  6
#define CAR_Y        192       /* both players' fixed screen Y             */
#define SPAWN_Y      20        /* traffic entry Y — just below the HUD     */
#define DESPAWN_Y    216       /* traffic exits past the player            */
#define START_LIVES  3         /* crashes per run / per player             */
#define SPAWN_PERIOD 40        /* frames between traffic spawns — traffic
                                * moves at road speed, so per-meter density
                                * stays constant whatever the player does   */
#define SPEED_2P     2         /* fixed road speed in versus (one VDP =
                                * one scroll = one shared speed)           */
#define MAX_SPEED    4         /* px/frame — MUST stay under 8: the row
                                * streamer restamps one row per crossing
                                * and a >8 px step could skip a row        */
#define HUD_ROWS     2         /* window rows reserved for the HUD         */

/* Players: index 0 = P1 (pad 1), 1 = P2 (pad 2, versus only). */
static u8   car_lane[2];
static u8   car_active[2];
static u8   crashes_left[2];
static u8   invuln[2];         /* post-crash blink/no-collide frames       */
static u16  prev_pads[2];
static u8   lane_min[2], lane_max[2];   /* 2P: split territories           */
static u8   two_player;
static u8   winner;            /* versus result: 0 = P1, 1 = P2            */

static u8   traffic_alive[MAX_TRAFFIC];
static u8   traffic_lane[MAX_TRAFFIC];
static s16  traffic_y[MAX_TRAFFIC];

static u8   speed;             /* road px/frame, 1..MAX_SPEED              */
static u16  dist;              /* 1P distance, 1 unit = 16 scrolled px     */
static u8   dist_frac;
static u16  best;              /* persisted best 1P distance               */
static u8   spawn_timer;
static u16  vs;                /* vertical scroll. NEVER wrapped by hand:  *
                                * the plane is 256 px tall, the VDP masks  *
                                * the scroll value to the plane, and 65536 *
                                * is a multiple of 256 — plain u16         *
                                * overflow keeps the road seamless forever *
                                * (the NES needs a 240-wrap helper here).  */
static u8   prev_top_row;      /* last restamped plane row                 */
static u8   start_pause;       /* freeze frames at green light             */
static u16  rng = 0xC0DE;

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static u8 state;

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
 * Best-distance record layout (SGDK offsets): 0='B' 1='D' 2=lo 3=hi
 * 4=checksum(lo^hi^$A5). Fresh SRAM is all $FF — the magic+checksum
 * rejects it (and any corruption) so first boot shows 0, not 65535.
 *
 * Emulator note (verified against gpgx): the core sizes its save_ram
 * region by scanning for the last non-$FF byte, so the region reads as
 * EMPTY until the first write below lands — that's why best_init runs
 * at the very top of main(). Real hardware and .srm-restoring frontends
 * have no such wrinkle. */
static u16 best_load(void) {
    u8 m0, m1, lo, hi, ck;
    SRAM_enableRO();
    m0 = SRAM_readByte(0);
    m1 = SRAM_readByte(1);
    lo = SRAM_readByte(2);
    hi = SRAM_readByte(3);
    ck = SRAM_readByte(4);
    SRAM_disable();
    if (m0 == 'B' && m1 == 'D' && ck == (u8)(lo ^ hi ^ 0xA5))
        return ((u16)hi << 8) | lo;
    return 0;
}

static void best_save(u16 d) {
    u8 lo = (u8)d, hi = (u8)(d >> 8);
    SRAM_enable();
    SRAM_writeByte(0, 'B');
    SRAM_writeByte(1, 'D');
    SRAM_writeByte(2, lo);
    SRAM_writeByte(3, hi);
    SRAM_writeByte(4, (u8)(lo ^ hi ^ 0xA5));
    SRAM_disable();
}

/* Format-on-first-boot: if the magic is absent (fresh battery), write a
 * valid zero record immediately so the save file exists from frame one. */
static void best_init(void) {
    best = best_load();
    if (best == 0) best_save(0);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * FULL-PLANE VERTICAL SCROLL + STREAMED ROWS — the Genesis road. With
 * VSCROLL_PLANE mode, one VSRAM value scrolls the whole plane vertically;
 * the VDP wraps it inside the 256-px plane in hardware. Screen line y shows
 * plane line (y + vs) & 255, so DECREMENTING vs slides the road DOWN — the
 * driving-up illusion — for the cost of one register write per frame.
 * Zero tilemap writes for the motion itself (rewriting tilemaps in the
 * loop is the #1 "choppy movement" bug).
 *
 * The plane's 32 rows recycle as vs shrinks: the row crossing into the top
 * of the screen is plane row (vs >> 3) & 31. The moment it changes we
 * restamp that ONE row with fresh random roadside, so the 256-px loop
 * never shows the same scenery twice. Three hard rules:
 *   1. DMA_QUEUE only — the queued write lands in vblank, never mid-frame
 *      (SYS_doVBlankProcess flushes the queue; raw mid-frame VRAM writes
 *      tear). The data buffer must be STATIC: the queue reads it AT FLUSH
 *      TIME — a stack buffer is gone by then, shipping garbage.
 *   2. The restamped row enters under the 16-px WINDOW HUD, which hides
 *      the swap (the NES version uses the overscan-cropped top band as
 *      its curtain; the window is ours). Restamp rows anywhere lower and
 *      the player sees tiles pop.
 *   3. Road speed stays under 8 px/frame (MAX_SPEED) so a frame never
 *      skips past a whole row crossing.
 */
static u16 rowbuf[64];   /* static — the DMA queue reads it at flush time */

static u16 road_cell(u16 c) {
    u8 r;
    if (c == COL_EDGE_L || c == COL_EDGE_R)
        return TILE_ATTR_FULL(PAL1, 0, 0, 0, T_EDGE);
    if (c == COL_DIVIDER)
        return TILE_ATTR_FULL(PAL1, 0, 0, 0, T_DIVIDE);
    if (c == COL_DASH_1 || c == COL_DASH_2)
        return TILE_ATTR_FULL(PAL1, 0, 0, 0, T_DASH);
    r = random8();
    if (c > COL_EDGE_L && c < COL_EDGE_R)               /* tarmac          */
        return TILE_ATTR_FULL(PAL1, 0, 0, 0, (r & 7) == 0 ? T_SPECK : T_ASPHALT);
    if ((r & 31) == 0) return TILE_ATTR_FULL(PAL1, 0, 0, 0, T_TREE);
    if ((r & 7) == 0)  return TILE_ATTR_FULL(PAL1, 0, 0, 0, T_TUFT);
    return TILE_ATTR_FULL(PAL1, 0, 0, 0, T_GRASS);      /* roadside        */
}

static void build_road_row(void) {
    u16 c;
    for (c = 0; c < 64; c++) rowbuf[c] = road_cell(c);
}

/* Initial paint: all 32 plane rows, immediate CPU writes (init-time only —
 * inside the frame loop everything goes through the DMA queue). */
static void paint_road(void) {
    u16 r;
    for (r = 0; r < 32; r++) {
        build_road_row();
        VDP_setTileMapData(VDP_BG_A, rowbuf, r * 64, 64, 2, CPU);
    }
}

/* Advance the road by px pixels: one VSRAM write + at most one queued row
 * restamp. Called every frame the road moves (play AND the title drift). */
static void advance_road(u8 px) {
    u8 top_row;
    vs -= px;                              /* hardware wraps — see idiom   */
    VDP_setVerticalScroll(BG_A, (s16)vs);
    top_row = (u8)((vs >> 3) & 31);
    if (top_row != prev_top_row) {
        prev_top_row = top_row;
        build_road_row();
        VDP_setTileMapData(VDP_BG_A, rowbuf, (u16)top_row * 64, 64, 2, DMA_QUEUE);
    }
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * PER-SCANLINE HSCROLL — the heat-haze band, LIVE. This game runs in
 * HSCROLL_LINE mode: the VDP fetches one hscroll entry per SCANLINE from
 * the hscroll table in VRAM (interleaved words: plane A's value for the
 * line, then plane B's). The platformer template runs the cheaper
 * HSCROLL_TILE (one entry per 8-line strip) and only documents this
 * variant — here it earns its keep: a traveling ±2 px sine wave across a
 * 32-line band of the road reads as heat shimmer rising off the asphalt.
 *
 * Requires: HSCROLL_LINE set BEFORE any scroll-table write (the mode
 *   decides the table layout the VDP reads); the value array STATIC (the
 *   DMA queue reads it at flush time); and only the band's lines need
 *   updating each frame — the other 192 entries stay 0 in VRAM (SGDK's
 *   boot cleared VRAM, and a console reset re-runs that boot), so the
 *   cost is 32 words = 64 bytes/frame of the ~7 KB vblank budget. The
 *   FULL table at one entry per line per plane would be ~1.8 KB/frame —
 *   budget it before scaling this up.
 * Sprites are not displaced — per-line hscroll bends PLANES only. The
 *   cars drive through the shimmer untouched, which is exactly how real
 *   carts looked (and why effect bands avoid gameplay-critical rows). */
#define HAZE_TOP   96          /* first shimmering scanline                */
#define HAZE_LINES 32
static s16 haze[HAZE_LINES];   /* static — DMA queue reads at flush time  */
static const s16 haze_wave[8] = { 0, 1, 2, 1, 0, -1, -2, -1 };
static u16 haze_phase;

static void update_haze(void) {
    u16 i;
    haze_phase++;
    for (i = 0; i < HAZE_LINES; i++)
        haze[i] = haze_wave[(i + (haze_phase >> 1)) & 7];
    VDP_setHorizontalScrollLine(BG_A, HAZE_TOP, haze, HAZE_LINES, DMA_QUEUE);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * WINDOW-PLANE HUD — the fixed status bar. The window is a third tilemap
 * that REPLACES plane A wherever it's shown and IGNORES ALL SCROLLING —
 * a hardware-fixed HUD with zero per-frame cost over a road that never
 * stops moving (the NES version needs sprite digits for this; on Genesis
 * it's one register). Two footguns:
 *   - The window only lives at screen edges (top/bottom N rows or left/
 *     right N columns) — it cannot float mid-screen.
 *   - It replaces plane A ONLY: plane B and sprites still render behind/
 *     over it. Plane B's top rows are painted with a flat dark band so
 *     HUD text always reads, and traffic spawns BELOW y=16.
 * Bonus idiom on display here: the title/results text lives on PLANE B
 * with the text priority bit SET, floating over the LOW-priority road on
 * plane A — priority trumps plane order on the Genesis (high-pri B draws
 * above low-pri A), which is how text sits on a busy foreground plane
 * without repainting it. */
static void hud_init(void) {
    VDP_setWindowOnTop(HUD_ROWS);
    VDP_setTextPriority(1);    /* window + plane-B text above the road     */
}

/* ── GAME LOGIC (clay) — HUD text (window plane, redrawn only on change) ── */
static void draw_u16(VDPPlane plane, u16 v, u16 x, u16 y) {
    char buf[8];
    uintToStr(v, buf, 5);
    VDP_drawTextBG(plane, buf, x, y);
}

static void draw_hud(void) {
    char b[4];
    VDP_clearTextAreaBG(WINDOW, 0, 0, 40, 1);
    if (two_player) {
        b[0] = 'P'; b[1] = '1'; b[2] = 0;
        VDP_drawTextBG(WINDOW, b, 1, 0);
        b[0] = 'x'; b[1] = '0' + crashes_left[0]; b[2] = 0;
        VDP_drawTextBG(WINDOW, b, 4, 0);
        b[0] = 'P'; b[1] = '2'; b[2] = 0;
        VDP_drawTextBG(WINDOW, b, 34, 0);
        b[0] = 'x'; b[1] = '0' + crashes_left[1]; b[2] = 0;
        VDP_drawTextBG(WINDOW, b, 37, 0);
        return;
    }
    b[0] = 'x'; b[1] = '0' + crashes_left[0]; b[2] = 0;
    VDP_drawTextBG(WINDOW, b, 1, 0);
    VDP_drawTextBG(WINDOW, "SPD", 5, 0);
    b[0] = '0' + speed; b[1] = 0;
    VDP_drawTextBG(WINDOW, b, 9, 0);
    VDP_drawTextBG(WINDOW, "DIST", 12, 0);
    draw_u16(WINDOW, dist, 17, 0);
    VDP_drawTextBG(WINDOW, "BEST", 24, 0);
    draw_u16(WINDOW, best, 29, 0);
}

static void draw_hud_title(void) {
    VDP_clearTextAreaBG(WINDOW, 0, 0, 40, HUD_ROWS);
    VDP_drawTextBG(WINDOW, "BEST", 24, 0);
    draw_u16(WINDOW, best, 29, 0);
}

/* ── GAME LOGIC (clay) — plane B cards (title / results) ────────────────────
 * Plane B never scrolls: rows 0-1 hold the dark band behind the window HUD,
 * the rest holds high-priority text floating over the live road. Repainted
 * on state changes only. */
static void paint_band(void) {
    VDP_fillTileMapRect(BG_B, TILE_ATTR_FULL(PAL2, 0, 0, 0, T_BAND),
                        0, 0, 64, HUD_ROWS);
}

static void paint_title(void) {
    VDP_clearPlane(BG_B, TRUE);
    paint_band();
    VDP_drawTextBG(BG_B, GAME_TITLE, (40 - (sizeof(GAME_TITLE) - 1)) / 2, 6);
    VDP_drawTextBG(BG_B, "1P RACE - A", 14, 12);
    VDP_drawTextBG(BG_B, "2P VERSUS - B", 13, 14);
    VDP_drawTextBG(BG_B, "STEER L R - GAS A - BRAKE B", 6, 20);
    draw_hud_title();
}

static void paint_over(void) {
    VDP_clearPlane(BG_B, TRUE);
    paint_band();
    if (two_player) {
        VDP_drawTextBG(BG_B, winner ? "P2 WINS" : "P1 WINS", 16, 8);
        VDP_drawTextBG(BG_B, "RIVAL WRECKED", 13, 12);
    } else {
        VDP_drawTextBG(BG_B, "WRECKED", 16, 8);
        VDP_drawTextBG(BG_B, "DIST", 13, 12);
        draw_u16(BG_B, dist, 18, 12);
        VDP_drawTextBG(BG_B, "BEST", 13, 14);
        draw_u16(BG_B, best, 18, 14);
    }
    VDP_drawTextBG(BG_B, "START - TITLE", 13, 20);
}

/* ── GAME LOGIC (clay) — traffic pool (fixed slots, no allocation) ── */
static void spawn_traffic(void) {
    u16 i;
    for (i = 0; i < MAX_TRAFFIC; i++) {
        if (!traffic_alive[i]) {
            traffic_alive[i] = 1;
            traffic_lane[i] = random8() & 3;
            traffic_y[i] = SPAWN_Y;
            return;
        }
    }
}

/* AABB, both boxes 8x8 (s16 math — sprite coords go negative off-screen). */
static u8 hits(s16 ax, s16 ay, s16 bx, s16 by) {
    return ax < bx + 8 && ax + 8 > bx && ay < by + 8 && ay + 8 > by;
}

/* ── GAME LOGIC (clay) — start a run ── */
static void start_game(u8 versus) {
    u16 i;
    two_player = versus;
    for (i = 0; i < MAX_TRAFFIC; i++) traffic_alive[i] = 0;
    for (i = 0; i < 2; i++) {
        crashes_left[i] = START_LIVES;
        invuln[i] = 0;
        prev_pads[i] = 0xFFFF;   /* swallow buttons held across the change */
    }
    if (versus) {
        car_active[0] = 1; car_active[1] = 1;
        lane_min[0] = 0; lane_max[0] = 1; car_lane[0] = 0;  /* P1: left half  */
        lane_min[1] = 2; lane_max[1] = 3; car_lane[1] = 3;  /* P2: right half */
        speed = SPEED_2P;        /* shared road, fixed speed (see header)  */
    } else {
        car_active[0] = 1; car_active[1] = 0;
        lane_min[0] = 0; lane_max[0] = 3; car_lane[0] = 1;  /* whole road     */
        speed = 1;
    }
    dist = 0; dist_frac = 0;
    spawn_timer = 0;
    start_pause = 30;            /* green-light breather                   */
    VDP_clearPlane(BG_B, TRUE);  /* drop the title card — road shows clear */
    paint_band();
    draw_hud();
    sfx_tone(0, 523, 10);        /* start jingle (C5)                      */
    state = ST_PLAY;
}

static void game_over(void) {
    if (!two_player && dist > best) {
        best = dist;
        best_save(best);         /* battery SRAM — see the SRAM idiom      */
    }
    state = ST_OVER;
    paint_over();
    draw_hud_title();            /* window shows BEST — may have changed   */
    sfx_noise(20);
}

/* ── GAME LOGIC (clay) — crash rules ── */
static void crash(u8 p) {
    sfx_noise(14);
    invuln[p] = 60;              /* blink + no-collide grace               */
    if (!two_player) speed = 1;  /* a wreck kills your momentum            */
    if (crashes_left[p] > 0) --crashes_left[p];
    if (crashes_left[p] == 0) {
        winner = (u8)(1 - p);    /* versus: the OTHER player wins          */
        game_over();
        return;
    }
    draw_hud();
}

/* ── GAME LOGIC (clay) — per-player input ───────────────────────────────────
 * LEFT/RIGHT steer between lanes (edge-detected — held d-pad shouldn't
 * machine-gun across the road). 1P only: A/UP accelerate, B/DOWN brake
 * (speed is shared in versus — see the design note). */
static void update_player(u8 p) {
    u16 pad = JOY_readJoypad(p ? JOY_2 : JOY_1);
    u16 pressed = pad & ~prev_pads[p];
    prev_pads[p] = pad;
    if (!car_active[p]) return;
    if ((pressed & BUTTON_LEFT) && car_lane[p] > lane_min[p]) {
        --car_lane[p];
        sfx_tone(0, 880, 3);                              /* lane tick     */
    }
    if ((pressed & BUTTON_RIGHT) && car_lane[p] < lane_max[p]) {
        ++car_lane[p];
        sfx_tone(0, 880, 3);
    }
    if (!two_player) {
        if ((pressed & BTN_GAS) && speed < MAX_SPEED) {
            ++speed;
            sfx_tone(1, (u16)(700 - speed * 120), 8);     /* engine rev    */
            draw_hud();
        }
        if ((pressed & BTN_BRAKE) && speed > 1) {
            --speed;
            sfx_tone(1, 220, 5);                          /* brake blip    */
            draw_hud();
        }
    }
    if (invuln[p] > 0) --invuln[p];
}

/* ── GAME LOGIC (clay) — stage this frame's sprites ─────────────────────────
 * Fixed SAT slots: 0 = P1, 1 = P2, 2-7 = traffic. Hidden sprites park at
 * y = -16 (above the screen). NEVER hide with x = -128..0 — a SAT x of 0
 * is the VDP's sprite-masking trigger and silently blanks every lower-
 * priority sprite on those scanlines. */
#define HIDE_Y (-16)
static void stage_sprites(void) {
    u16 i;
    u8 p;
    for (p = 0; p < 2; p++) {
        u8 vis = (state == ST_PLAY) && car_active[p] && !(invuln[p] & 2);
        VDP_setSprite(p, lane_x[car_lane[p]], vis ? (s16)CAR_Y : (s16)HIDE_Y,
                      SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(p ? PAL3 : PAL0, 1, 0, 0, T_CAR));
    }
    for (i = 0; i < MAX_TRAFFIC; i++) {
        u8 vis = (state == ST_PLAY) && traffic_alive[i];
        VDP_setSprite(2 + i, lane_x[traffic_lane[i]],
                      vis ? traffic_y[i] : (s16)HIDE_Y,
                      SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(PAL2, 1, 0, 0, T_TRAFFIC));
    }
    /* ── HARDWARE IDIOM (load-bearing) — CHAIN the sprite list before
     * uploading. VDP_setSprite does NOT set the SAT link byte, and link 0
     * means "end of list": skip this and the VDP draws sprite 0 only.
     * VDP_linkSprites(0, 8) links slots 0..7; the queued DMA flushes the
     * 8 SAT entries during vblank. ── */
    VDP_linkSprites(0, 8);
    VDP_updateSprites(8, DMA_QUEUE);
}

int main(bool hard) {
    u16 i, pad, fresh;
    u8 p;
    (void)hard;

    /* SRAM first — before any VDP work. The save file then exists within
     * the game's first frames of life, which is what lets a frontend (or
     * a headless host) see a non-empty save_ram region as early as
     * possible (see the SRAM idiom note on gpgx's size scan). */
    best_init();

    /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
     * Init order: scrolling MODE before scroll VALUES (the mode decides
     * the hscroll-table layout the VDP reads — see the haze idiom), tiles
     * + palettes before tilemaps that reference them, window size before
     * window text. SGDK's boot already did the dangerous part (VDP regs,
     * Z80, vblank int, VRAM clear). */
    VDP_setScrollingMode(HSCROLL_LINE, VSCROLL_PLANE);
    hud_init();

    /* Palettes: PAL0 P1 car + font, PAL1 road plane, PAL2 traffic + HUD
     * band, PAL3 P2 car. Colours are BGR, 3 bits per channel: 0x0BGR with
     * E = full. */
    PAL_setColor( 1, 0x0E44);      /* P1 body electric blue  */
    PAL_setColor( 2, 0x0420);      /* P1 glass dark          */
    PAL_setColor(15, 0x0EEE);      /* font white (index 15 = SGDK font)    */
    PAL_setColor(16 + 1, 0x0292);  /* grass green            */
    PAL_setColor(16 + 2, 0x0161);  /* tuft dark green        */
    PAL_setColor(16 + 3, 0x0EEE);  /* road markings white    */
    PAL_setColor(16 + 4, 0x0444);  /* asphalt grey           */
    PAL_setColor(16 + 5, 0x0666);  /* asphalt speck          */
    PAL_setColor(16 + 6, 0x0040);  /* tree foliage deep green*/
    PAL_setColor(32 + 1, 0x0202);  /* HUD band near-black    */
    PAL_setColor(32 + 3, 0x022E);  /* traffic body red       */
    PAL_setColor(32 + 4, 0x0CCC);  /* traffic glass light    */
    PAL_setColor(48 + 1, 0x04C4);  /* P2 body green          */
    PAL_setColor(48 + 2, 0x0420);  /* P2 glass dark          */

    VDP_loadTileData(tile_grass,   T_GRASS,   1, DMA);
    VDP_loadTileData(tile_tuft,    T_TUFT,    1, DMA);
    VDP_loadTileData(tile_tree,    T_TREE,    1, DMA);
    VDP_loadTileData(tile_asphalt, T_ASPHALT, 1, DMA);
    VDP_loadTileData(tile_speck,   T_SPECK,   1, DMA);
    VDP_loadTileData(tile_edge,    T_EDGE,    1, DMA);
    VDP_loadTileData(tile_dash,    T_DASH,    1, DMA);
    VDP_loadTileData(tile_divide,  T_DIVIDE,  1, DMA);
    VDP_loadTileData(tile_band,    T_BAND,    1, DMA);
    VDP_loadTileData(tile_car,     T_CAR,     1, DMA);
    VDP_loadTileData(tile_traffic, T_TRAFFIC, 1, DMA);

    paint_road();              /* plane A: 32 rows, then streamed forever  */
    sfx_init();                /* PSG: sfx channels + background melody    */

    vs = 0;
    prev_top_row = 0;
    state = ST_TITLE;
    paint_title();
    prev_pads[0] = 0xFFFF;

    while (TRUE) {
        if (state == ST_TITLE) {
            /* ── GAME LOGIC (clay) — title: A = 1P race, B = 2P versus ──
             * The road idles under the title card so the screen sells the
             * scroll + the heat haze before anyone presses a button. */
            advance_road(1);
            update_haze();
            stage_sprites();
            pad = JOY_readJoypad(JOY_1);
            fresh = pad & ~prev_pads[0];
            if (fresh & (BUTTON_A | BUTTON_C | BUTTON_START)) start_game(0);
            else if (fresh & BUTTON_B) start_game(1);
            else prev_pads[0] = pad;
            sfx_update();
            SYS_doVBlankProcess();
            continue;
        }

        if (state == ST_OVER) {
            /* Results card; the road freezes, the haze keeps shimmering.
             * START or A returns to the title. */
            update_haze();
            stage_sprites();
            pad = JOY_readJoypad(JOY_1);
            fresh = pad & ~prev_pads[0];
            if (fresh & (BUTTON_START | BUTTON_A | BUTTON_C)) {
                state = ST_TITLE;
                prev_pads[0] = 0xFFFF;   /* swallow the held START         */
                paint_title();
            } else {
                prev_pads[0] = pad;
            }
            sfx_update();
            SYS_doVBlankProcess();
            continue;
        }

        /* ── ST_PLAY ──────────────────────────────────────────────────── */
        stage_sprites();
        update_haze();

        if (start_pause) {             /* green light: freeze gameplay,    */
            --start_pause;             /* keep frames honest (sprites +    */
            sfx_update();              /* haze staged)                     */
            SYS_doVBlankProcess();
            continue;
        }

        advance_road(speed);

        /* ── GAME LOGIC (clay) from here down ── */
        update_player(0);
        if (two_player) update_player(1);

        /* Distance (1P stat): 1 unit per 16 scrolled pixels. A chime every
         * 256 units marks a checkpoint. */
        if (!two_player) {
            dist_frac = (u8)(dist_frac + speed);
            if (dist_frac >= 16) {
                dist_frac -= 16;
                if (dist < 65535u) ++dist;
                draw_u16(WINDOW, dist, 17, 0);
                if (dist != 0 && (dist & 0xFF) == 0)
                    sfx_tone(0, 1047, 8);     /* checkpoint chime (C6)     */
            }
        }

        /* Traffic flows down at road speed (it reads as slower cars you're
         * overtaking); despawn past the player with a little pass tick. */
        for (i = 0; i < MAX_TRAFFIC; i++) {
            if (!traffic_alive[i]) continue;
            traffic_y[i] += speed;
            if (traffic_y[i] > DESPAWN_Y) {
                traffic_alive[i] = 0;
                sfx_tone(1, 660, 2);
            }
        }
        if (++spawn_timer >= SPAWN_PERIOD) {
            spawn_timer = 0;
            spawn_traffic();
        }

        /* Traffic ↔ cars. Crash grace: a just-wrecked car blinks and can't
         * collide for 60 frames. */
        for (i = 0; i < MAX_TRAFFIC && state == ST_PLAY; i++) {
            if (!traffic_alive[i]) continue;
            for (p = 0; p < 2; p++) {
                if (!car_active[p] || invuln[p]) continue;
                if (hits(lane_x[traffic_lane[i]], traffic_y[i],
                         lane_x[car_lane[p]], CAR_Y)) {
                    traffic_alive[i] = 0;
                    crash(p);
                    break;
                }
            }
        }

        sfx_update();
        SYS_doVBlankProcess();
    }
    return 0;
}
