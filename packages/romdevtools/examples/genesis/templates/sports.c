/* ── sports.c — Genesis versus sports game (complete example game) ───────────
 *
 * A COMPLETE, working game — VOLT VOLLEY, a head-to-head court game (Pong
 * lineage): title screen, 1P vs a beatable CPU and 2P simultaneous versus
 * (player 2 on CONTROLLER 2), first-to-5 match flow with a result screen,
 * a hardware-fixed WINDOW-plane HUD, PSG music + SFX, and a battery-backed
 * record (longest win streak vs the CPU) in cartridge SRAM.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented Genesis footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — court art, ball physics, CPU skill, scoring rules:
 *     reshape freely.
 *
 * What depends on what:
 *   genesis_sfx.{h,c} — PSG sound wrapper (tones + noise + a background
 *     melody loop). For full FM music, see the xgm2_demo template
 *     (XGM2_loadDriver + XGM2_play + a .xgc blob incbin'd via a data.s
 *     sibling) — the PSG path keeps this a single-file game.
 *   rom_header.c (SGDK) — the Sega header at $100. Its 'RA' block at $1B0
 *     DECLARES the cartridge SRAM that record_load/save below depend on
 *     (see the SRAM idiom). The build assembles it automatically.
 *
 * Layering: the court (rails + net + floor) lives on plane B, painted ONCE
 * at boot and never touched again. Title/result text lives on plane A, which
 * is cleared during play. The HUD lives on the WINDOW plane — fixed by
 * hardware, zero per-frame cost. Nothing repaints inside the frame loop.
 *
 * Frame budget (NTSC, 60 fps): 2 paddles + 1 ball + 2 paddle AABB tests +
 * 7 SAT entries queued for vblank DMA + the occasional HUD digit — a tiny
 * fraction of the 68000's frame. Plenty of headroom for fancier physics.
 */

#include <genesis.h>
#include "genesis_sfx.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "VOLT VOLLEY"

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * CONTROLLER MAPPING — two layers, both bite:
 *
 *   On the pad: SGDK's JOY_readJoypad(JOY_1/JOY_2) returns BUTTON_A/B/C/
 *   START/UP/DOWN/LEFT/RIGHT as a bitmask. The title maps A (or START) to
 *   1P vs CPU and B to 2P versus; C also starts 1P (real Genesis games map
 *   action buttons generously — thumbs rest on C).
 *
 *   Driving this game HEADLESSLY through an emulator (libretro/gpgx): the
 *   core maps Genesis A/B/C onto libretro Y/B/A. So setInput({y:true})
 *   presses GENESIS A (1P start here), setInput({b:true}) presses GENESIS
 *   B (2P start), and setInput({a:true}) presses GENESIS C — NOT Genesis A.
 *   Getting this wrong looks like "the game ignores input". START is start.
 */
#define BTN_1P (BUTTON_A | BUTTON_C | BUTTON_START)
#define BTN_2P (BUTTON_B)

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Tile art. Genesis tiles are 4bpp: each u32 row = 8 pixels, one hex nibble
 * per pixel = a colour index into the tile's palette line (0 = transparent).
 * Sprites + font use PAL0, the P2 paddle PAL1, plane B (the court) PAL2. */
#define T_PADDLE (TILE_USER_INDEX + 0)   /* sprite: 4px-wide paddle column  */
#define T_BALL   (TILE_USER_INDEX + 1)   /* sprite: the ball                */
#define T_RAIL   (TILE_USER_INDEX + 2)   /* plane B: top/bottom court rail  */
#define T_NET    (TILE_USER_INDEX + 3)   /* plane B: dashed centre net      */
#define T_FLOOR  (TILE_USER_INDEX + 4)   /* plane B: speckled court floor   */
#define T_BAND   (TILE_USER_INDEX + 5)   /* plane B: flat band behind HUD   */

static const u32 tile_paddle[8] = {       /* colour 1: P1 cyan / P2 red via *
                                           * the palette LINE in TILE_ATTR  */
    0x11110000, 0x11110000, 0x11110000, 0x11110000,
    0x11110000, 0x11110000, 0x11110000, 0x11110000,
};
static const u32 tile_ball[8] = {         /* volt-yellow ball + highlight   */
    0x00444400, 0x04444440, 0x44455444, 0x44455444,
    0x44444444, 0x44444444, 0x04444440, 0x00444400,
};
static const u32 tile_rail[8] = {
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
};
/* Centre net: a 2px dashed bar. DIM on purpose — title/result text on plane
 * A overlaps the net column, and white-on-white glyphs would be unreadable
 * (plane A glyph backgrounds are transparent, so plane B shows through). */
static const u32 tile_net[8] = {
    0x00022000, 0x00022000, 0x00022000, 0x00000000,
    0x00022000, 0x00022000, 0x00022000, 0x00000000,
};
static const u32 tile_floor[8] = {        /* sparse speckles so the arena   *
                                           * reads as a court, not a void   */
    0x00000000, 0x00300000, 0x00000000, 0x00000003,
    0x00000000, 0x03000000, 0x00000000, 0x00000300,
};
static const u32 tile_band[8] = {
    0x55555555, 0x55555555, 0x55555555, 0x55555555,
    0x55555555, 0x55555555, 0x55555555, 0x55555555,
};

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Court geometry + match rules. The court is framed by plane-B rails on cell
 * rows 2 and 27; COURT_TOP/BOT keep the ball between them. Rows 0-1 sit
 * under the WINDOW HUD (see the window idiom below). */
#define HUD_ROWS   2             /* window rows reserved for the HUD        */
#define PADDLE_H   24            /* 3 stacked 8px sprites                   */
#define PADDLE_W   4
#define PADDLE_X1  16            /* P1 — left side                          */
#define PADDLE_X2  300           /* P2/CPU — right side (320 - 16 - 4)      */
#define COURT_TOP  24            /* first pixel row below the top rail      */
#define COURT_BOT  216           /* first pixel row of the bottom rail      */
#define NET_COL    20            /* cell column of the centre net           */
#define BALL_W     8
#define BALL_H     8
#define SCREEN_W   320           /* H40 mode                                */
#define WIN_SCORE  5             /* first to 5 takes the match              */
#define P1_SPEED   2             /* px/frame — both humans move at this     */
#define CPU_SPEED  1             /* px/frame — half speed: beatable         */

static s16 p1y, p2y;             /* paddle top Y, pixels                    */
static s16 bx, by;               /* ball top-left, pixels                   */
static s16 bdx, bdy;             /* ball velocity (px/frame)                */
static u8  score_p1, score_p2;
static u8  serve_timer;          /* freeze frames between points            */
static u8  two_player;           /* title pick: 0 = vs CPU, 1 = 2P versus   */
static u8  streak;               /* current 1P-vs-CPU win streak (RAM)      */
static u16 best_streak;          /* battery-backed record — see end_match   */
static u8  new_record;           /* result screen shows NEW RECORD          */

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static u8  state;
static u16 prev_pad;

/* ── GAME LOGIC (clay) — xorshift16 PRNG (a few 68k instructions per call).
 * A versus game NEEDS this: the Genesis is fully deterministic, so without
 * a noise source two fixed strategies lock into an infinite rally loop (the
 * exact same 600-frame cycle, forever — a match that never ends). random8()
 * is ticked once per play frame so identical game states a few seconds
 * apart still diverge, and every paddle return adds a ±1 "spin". */
static u16 rng = 0xC0A7;
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
 * Record layout (SGDK offsets): 0='H' 1='S' 2=lo 3=hi 4=checksum
 * (lo^hi^$A5). Fresh SRAM is all $FF — the magic+checksum rejects it (and
 * any corruption) so first boot shows 0, not 65535.
 *
 * Persistence choice: for a VERSUS sports game a raw hi-score is
 * meaningless (every match ends 5-x), so we persist the longest 1P win
 * streak against the CPU — the stat a returning player actually chases.
 * 2P matches never touch it (humans beating each other isn't a record).
 *
 * Emulator note (verified against gpgx): the core sizes its save_ram
 * region by scanning for the last non-$FF byte, so the region reads as
 * EMPTY until the first write below lands — that's why record_init runs
 * at the very top of main(). Real hardware and .srm-restoring frontends
 * have no such wrinkle. */
static u16 record_load(void) {
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

static void record_save(u16 v) {
    u8 lo = (u8)v, hi = (u8)(v >> 8);
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
static void record_init(void) {
    best_streak = record_load();
    if (best_streak == 0) record_save(0);
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
 *     text always reads, and nothing in the game flies above y=16
 *     (COURT_TOP is 24 — the top rail keeps the ball clear of the HUD). */
static void hud_init(void) {
    VDP_setWindowOnTop(HUD_ROWS);
}

/* ── GAME LOGIC (clay) — HUD text (window plane, redrawn only on change) ── */
static void draw_u16(VDPPlane plane, u16 v, u16 x, u16 y) {
    char buf[8];
    uintToStr(v, buf, 5);
    VDP_drawTextBG(plane, buf, x, y);
}

static void draw_scores(void) {
    char b[2] = { 0, 0 };
    b[0] = '0' + score_p1;
    VDP_drawTextBG(WINDOW, b, 5, 0);
    b[0] = '0' + score_p2;
    VDP_drawTextBG(WINDOW, b, 38, 0);
}

static void draw_hud_play(void) {
    VDP_clearTextAreaBG(WINDOW, 0, 0, 40, HUD_ROWS);
    VDP_drawTextBG(WINDOW, "P1", 1, 0);
    VDP_drawTextBG(WINDOW, two_player ? " P2" : "CPU", 33, 0);
    VDP_drawTextBG(WINDOW, "BEST", 14, 0);
    draw_u16(WINDOW, best_streak, 19, 0);
    draw_scores();
}

static void draw_hud_title(void) {
    VDP_clearTextAreaBG(WINDOW, 0, 0, 40, HUD_ROWS);
    VDP_drawTextBG(WINDOW, "BEST", 14, 0);
    draw_u16(WINDOW, best_streak, 19, 0);
}

/* ── GAME LOGIC (clay) — paint the court (plane B, ONCE at boot) ──────────
 * Painted once and never touched again — the frame loop does zero tilemap
 * writes (rewriting tilemaps per frame is the #1 "choppy movement" bug). */
static void paint_court(void) {
    u16 c, r;
    /* Flat dark band behind the window HUD (rows 0-1). */
    VDP_fillTileMapRect(BG_B, TILE_ATTR_FULL(PAL2, 0, 0, 0, T_BAND),
                        0, 0, 64, HUD_ROWS);
    for (c = 0; c < 40; c++) {
        VDP_setTileMapXY(BG_B, TILE_ATTR_FULL(PAL2, 0, 0, 0, T_RAIL), c, 2);
        VDP_setTileMapXY(BG_B, TILE_ATTR_FULL(PAL2, 0, 0, 0, T_RAIL), c, 27);
    }
    for (r = 3; r < 27; r++)
        for (c = 0; c < 40; c++)
            VDP_setTileMapXY(BG_B, TILE_ATTR_FULL(PAL2, 0, 0, 0,
                             (c == NET_COL) ? T_NET : T_FLOOR), c, r);
}

/* ── GAME LOGIC (clay) — the title screen (text on plane A over the court) ── */
static void paint_title(void) {
    VDP_clearPlane(BG_A, TRUE);
    VDP_drawTextBG(BG_A, GAME_TITLE, (40 - (sizeof(GAME_TITLE) - 1)) / 2, 8);
    VDP_drawTextBG(BG_A, "1P VS CPU - A", 13, 14);
    VDP_drawTextBG(BG_A, "2P VERSUS - B", 13, 16);
    VDP_drawTextBG(BG_A, "FIRST TO 5", 15, 19);
    VDP_drawTextBG(BG_A, "UP DOWN MOVES YOUR PADDLE", 7, 22);
    draw_hud_title();
}

/* ── GAME LOGIC (clay) — the result screen ── */
static void paint_over(void) {
    char line[8];
    VDP_clearPlane(BG_A, TRUE);
    if (score_p1 >= WIN_SCORE)
        VDP_drawTextBG(BG_A, "P1 WINS", 16, 8);
    else
        VDP_drawTextBG(BG_A, two_player ? "P2 WINS" : "CPU WINS", 16, 8);
    line[0] = '0' + score_p1;
    line[1] = ' '; line[2] = '-'; line[3] = ' ';
    line[4] = '0' + score_p2;
    line[5] = 0;
    VDP_drawTextBG(BG_A, line, 17, 11);
    if (new_record) VDP_drawTextBG(BG_A, "NEW RECORD", 15, 14);
    VDP_drawTextBG(BG_A, "START - TITLE", 13, 21);
}

/* ── GAME LOGIC (clay) — serve: ball to centre, toward the chosen side.
 * The serve angle takes a PRNG bit (not a fixed alternation) — one more
 * place determinism is broken so idle matches can't settle into a cycle. */
static void serve_ball(u8 to_left) {
    bx = SCREEN_W / 2 - BALL_W / 2;
    by = (COURT_TOP + COURT_BOT) / 2;
    bdx = to_left ? -2 : 2;
    bdy = (random8() & 1) ? -1 : 1;
    serve_timer = 30;                  /* half-second breather */
}

/* ── GAME LOGIC (clay) — start a match ── */
static void start_match(u8 players) {
    two_player = players;
    p1y = (COURT_TOP + COURT_BOT) / 2 - PADDLE_H / 2;
    p2y = p1y;
    score_p1 = 0;
    score_p2 = 0;
    new_record = 0;
    serve_ball(0);
    VDP_clearPlane(BG_A, TRUE);        /* drop the title text — court shows */
    draw_hud_play();
    sfx_tone(0, 523, 10);              /* start jingle (C5) */
    state = ST_PLAY;
}

/* ── GAME LOGIC (clay) — match over: result + record bookkeeping ── */
static void end_match(void) {
    if (score_p1 >= WIN_SCORE && !two_player) {
        ++streak;
        if (streak > best_streak) {
            best_streak = streak;
            new_record = 1;
            record_save(best_streak);  /* battery SRAM — see the SRAM idiom */
        }
    } else if (!two_player) {
        streak = 0;                    /* the streak dies with the loss */
    }
    /* End-of-match whistle: two quick descending tones. */
    sfx_tone(0, 380, 8);
    sfx_tone(1, 570, 12);
    paint_over();
    prev_pad = 0xFFFF;                 /* swallow buttons held at match end */
    state = ST_OVER;
}

/* ── GAME LOGIC (clay) — one point scored ── */
static void score_point(u8 for_p1) {
    if (for_p1) ++score_p1; else ++score_p2;
    sfx_noise(10);
    draw_scores();
    if (score_p1 >= WIN_SCORE || score_p2 >= WIN_SCORE) end_match();
    else serve_ball(for_p1);           /* winner of the point receives */
}

/* ── GAME LOGIC (clay) — paddle hit: deflect by where the ball struck.
 * Centre = flat-ish, edges = steep. Max |bdy| is 2 — the CPU moves at 1,
 * so an edge hit is exactly how a human beats it. The ±1 random "spin" on
 * every return keeps rallies from repeating (see the PRNG note above). */
static void deflect(s16 paddle_y) {
    s16 rel = (by + BALL_H / 2) - (paddle_y + PADDLE_H / 2);
    bdy = rel >> 3;
    bdy += (s16)(random8() & 2) - 1;   /* spin: -1 or +1 */
    if (bdy > 2) bdy = 2;
    if (bdy < -2) bdy = -2;
    if (bdy == 0) bdy = (rel < 0) ? -1 : 1;   /* never return a flat ball */
    sfx_tone(0, 280, 4);
}

/* ── GAME LOGIC (clay) — stage this frame's sprites ─────────────────────────
 * Fixed SAT slots: 0-2 = P1 paddle, 3-5 = P2 paddle, 6 = ball. Hidden
 * sprites park at y = -16 (above the screen). NEVER hide with x = -128..0 —
 * a SAT x of 0 is the VDP's sprite-masking trigger and silently blanks
 * every lower-priority sprite on those scanlines. */
#define HIDE_Y (-16)
static void stage_sprites(void) {
    u16 i;
    u8 actors = (state != ST_TITLE);   /* paddles freeze on the result      */
    u8 ball_on = (state == ST_PLAY);   /* the match ball went off-side      */
    for (i = 0; i < PADDLE_H / 8; i++) {
        VDP_setSprite(0 + i, PADDLE_X1, actors ? p1y + (s16)(i * 8) : (s16)HIDE_Y,
                      SPRITE_SIZE(1, 1), TILE_ATTR_FULL(PAL0, 1, 0, 0, T_PADDLE));
        VDP_setSprite(3 + i, PADDLE_X2, actors ? p2y + (s16)(i * 8) : (s16)HIDE_Y,
                      SPRITE_SIZE(1, 1), TILE_ATTR_FULL(PAL1, 1, 0, 0, T_PADDLE));
    }
    VDP_setSprite(6, bx, ball_on ? by : (s16)HIDE_Y,
                  SPRITE_SIZE(1, 1), TILE_ATTR_FULL(PAL0, 1, 0, 0, T_BALL));
    /* ── HARDWARE IDIOM (load-bearing) — CHAIN the sprite list before
     * uploading. VDP_setSprite does NOT set the SAT link byte, and link 0
     * means "end of list": skip this and the VDP draws sprite 0 only.
     * VDP_linkSprites(0, 7) links slots 0..6; the queued DMA flushes the
     * 7 SAT entries during vblank. ── */
    VDP_linkSprites(0, 7);
    VDP_updateSprites(7, DMA_QUEUE);
}

int main(bool hard) {
    u16 pad, pad2, fresh;
    (void)hard;

    /* SRAM first — before any VDP work. The save file then exists within
     * the game's first frames of life, which is what lets a frontend (or
     * a headless host) see a non-empty save_ram region as early as
     * possible (see the SRAM idiom note on gpgx's size scan). */
    record_init();
    streak = 0;

    /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
     * Init order: tiles + palettes before the tilemaps that reference them,
     * window size before window text. SGDK's boot already did the dangerous
     * part (VDP regs, Z80, vblank int); this game never scrolls, so the
     * default scroll mode + zero scroll values are exactly right. */
    hud_init();

    /* Palettes: PAL0 sprites + font, PAL1 the P2 paddle, PAL2 the court.
     * Colours are BGR, 3 bits per channel: 0x0BGR with E = full.
     * PAL0 colour 0 is also the BACKDROP — the court floor colour. */
    PAL_setColor( 0, 0x0420);      /* backdrop: dark navy court        */
    PAL_setColor( 1, 0x0EE2);      /* P1 paddle volt cyan              */
    PAL_setColor( 4, 0x00EE);      /* ball volt yellow                 */
    PAL_setColor( 5, 0x08FF);      /* ball highlight                   */
    PAL_setColor(15, 0x0EEE);      /* font white (index 15 = SGDK font colour) */
    PAL_setColor(16 + 1, 0x022E);  /* P2 paddle red                    */
    PAL_setColor(32 + 1, 0x0CC4);  /* rail cyan                        */
    PAL_setColor(32 + 2, 0x0875);  /* net — DIM (text overlaps it)     */
    PAL_setColor(32 + 3, 0x0641);  /* floor speckle                    */
    PAL_setColor(32 + 5, 0x0201);  /* HUD band near-black              */

    VDP_loadTileData(tile_paddle, T_PADDLE, 1, DMA);
    VDP_loadTileData(tile_ball,   T_BALL,   1, DMA);
    VDP_loadTileData(tile_rail,   T_RAIL,   1, DMA);
    VDP_loadTileData(tile_net,    T_NET,    1, DMA);
    VDP_loadTileData(tile_floor,  T_FLOOR,  1, DMA);
    VDP_loadTileData(tile_band,   T_BAND,   1, DMA);

    paint_court();             /* plane B: painted once, never again      */
    sfx_init();                /* PSG: sfx channels + background melody   */

    state = ST_TITLE;
    prev_pad = 0xFFFF;         /* swallow buttons held across power-on    */
    paint_title();

    while (TRUE) {
        stage_sprites();

        if (state == ST_TITLE) {
            /* ── GAME LOGIC (clay) — title: A/START = 1P vs CPU, B = 2P ── */
            pad = JOY_readJoypad(JOY_1);
            fresh = pad & ~prev_pad;
            prev_pad = pad;
            if (fresh & BTN_1P) start_match(0);
            else if (fresh & BTN_2P) start_match(1);
            sfx_update();
            SYS_doVBlankProcess();
            continue;
        }

        if (state == ST_OVER) {
            /* Result screen freezes the final scene; START or A → title. */
            pad = JOY_readJoypad(JOY_1);
            fresh = pad & ~prev_pad;
            prev_pad = pad;
            if (fresh & (BUTTON_START | BUTTON_A | BUTTON_C)) {
                state = ST_TITLE;
                prev_pad = 0xFFFF;     /* swallow the held START */
                paint_title();
            }
            sfx_update();
            SYS_doVBlankProcess();
            continue;
        }

        /* ── ST_PLAY ──────────────────────────────────────────────────── */

        /* ── GAME LOGIC (clay) from here down ── */
        random8();                 /* tick the noise source every play frame */

        /* P1 — controller 1, UP/DOWN. (prev_pad tracks through play so the
         * result screen's edge-detect doesn't eat a held button.) */
        pad = JOY_readJoypad(JOY_1);
        prev_pad = pad;
        if ((pad & BUTTON_UP)   && p1y > COURT_TOP)            p1y -= P1_SPEED;
        if ((pad & BUTTON_DOWN) && p1y < COURT_BOT - PADDLE_H) p1y += P1_SPEED;

        if (two_player) {
            /* P2 — CONTROLLER 2, same speed: a fair simultaneous-versus
             * match. (JOY_readJoypad(JOY_2) returns 0 with no pad in port
             * 2 — the paddle just sits still; this mode is for two humans,
             * the CPU lives in 1P mode.) */
            pad2 = JOY_readJoypad(JOY_2);
            if ((pad2 & BUTTON_UP)   && p2y > COURT_TOP)            p2y -= P1_SPEED;
            if ((pad2 & BUTTON_DOWN) && p2y < COURT_BOT - PADDLE_H) p2y += P1_SPEED;
        } else {
            /* CPU — chases the ball centre at half player speed with a
             * small dead zone. Beatable by design: steep edge deflections
             * outrun it. */
            s16 target = by + BALL_H / 2 - PADDLE_H / 2;
            if (p2y + 2 < target && p2y < COURT_BOT - PADDLE_H) p2y += CPU_SPEED;
            else if (p2y > target + 2 && p2y > COURT_TOP)       p2y -= CPU_SPEED;
        }

        /* Ball update (frozen during the post-point serve pause). */
        if (serve_timer > 0) {
            --serve_timer;
            sfx_update();
            SYS_doVBlankProcess();
            continue;
        }
        bx += bdx;
        by += bdy;

        /* Rail bounce. */
        if (by < COURT_TOP)          { by = COURT_TOP;          bdy = -bdy; sfx_tone(1, 350, 3); }
        if (by + BALL_H > COURT_BOT) { by = COURT_BOT - BALL_H; bdy = -bdy; sfx_tone(1, 350, 3); }

        /* Paddle collisions (direction-gated so the ball can't double-hit). */
        if (bdx < 0
            && bx <= PADDLE_X1 + PADDLE_W && bx + BALL_W >= PADDLE_X1
            && by + BALL_H > p1y && by < p1y + PADDLE_H) {
            bdx = -bdx;
            bx = PADDLE_X1 + PADDLE_W;
            deflect(p1y);
        }
        if (bdx > 0
            && bx + BALL_W >= PADDLE_X2 && bx <= PADDLE_X2 + PADDLE_W
            && by + BALL_H > p2y && by < p2y + PADDLE_H) {
            bdx = -bdx;
            bx = PADDLE_X2 - BALL_W;
            deflect(p2y);
        }

        /* Off either side → point. */
        if (bx < 4)            score_point(0);   /* past P1 → right side scores */
        if (bx > SCREEN_W - 4) score_point(1);   /* past P2 → P1 scores         */

        sfx_update();
        SYS_doVBlankProcess();
    }
    return 0;
}
