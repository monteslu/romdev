/* ── two_plane_parallax.c — Genesis SGDK two-plane parallax scaffold ──
 *
 * A smooth-scrolling side-scroller starting point: a side-scrolling world that
 * moves SMOOTHLY because the frame loop does HARDWARE SCROLL ONLY. There
 * are ZERO tilemap writes inside the loop — the two planes are painted
 * ONCE at setup, and every frame we just nudge two scroll registers and
 * re-stage one sprite. This is the single most important thing to copy:
 *
 *     ★ Do NOT rewrite tilemaps in the frame loop. ★
 *
 * Rewriting a plane each frame is a big VDP/DMA burst that overruns
 * vblank and makes movement feel choppy/juddery. Hardware scroll is free.
 *
 * Layout:
 *   - Plane A (foreground): a painted "world" — a ground strip + scattered
 *     platform blocks across a 512-px (64-cell) plane. Scrolls 1:1 with
 *     the camera.
 *   - Plane B (background): a repeated starfield filling the whole plane.
 *     Scrolls at 1/4 the camera speed for parallax depth (far things
 *     move slower). Because Plane B is filled edge-to-edge and the VDP
 *     scroll wraps within the plane, it tiles forever with no redraw.
 *   - One hardware sprite = the player, drawn in SCREEN space.
 *
 * Drive it: D-pad LEFT/RIGHT scrolls the camera (the player walks within
 * the world). The camera clamps to the world edges.
 *
 * IMPORTANT (logical vs hardware plane size): the Genesis has ONE shared
 * plane-size setting for BOTH planes. We use the default 64x32 cells
 * (512x256 px). A "32-wide level" still lives inside a 64-wide PHYSICAL
 * plane — you don't get an independent per-plane size. See the Genesis
 * MENTAL_MODEL.md "Scrolling, parallax & the feel trap".
 *
 * To go WIDER than 512 px (a large multi-screen level) you keep this exact
 * loop and add ONE thing: stream the single offscreen column that's about
 * to scroll into view each time the camera crosses an 8-px tile boundary
 * (a circular buffer in the 64-cell plane) — NOT a whole-plane redraw.
 * See MENTAL_MODEL.md "How large scrolling maps REALLY work".
 */

#include <genesis.h>

/* ── Tiles (4bpp, 8 rows x 4 bytes). Indices live at/above TILE_USER_INDEX
 *    so they don't clobber SGDK's font + system tiles below it. ── */
#define T_BLANK   (TILE_USER_INDEX + 0)
#define T_GROUND  (TILE_USER_INDEX + 1)
#define T_BLOCK   (TILE_USER_INDEX + 2)
#define T_PLAYER  (TILE_USER_INDEX + 3)
#define T_STAR    (TILE_USER_INDEX + 4)

static const u32 tile_blank[8]  = { 0,0,0,0,0,0,0,0 };
/* Solid ground: lit top edge, darker body. */
static const u32 tile_ground[8] = {
    0x11111111, 0x12222221, 0x12222221, 0x12222221,
    0x12222221, 0x12222221, 0x12222221, 0x12222221,
};
/* A floating platform block. */
static const u32 tile_block[8]  = {
    0x33333333, 0x34444443, 0x34444443, 0x34444443,
    0x34444443, 0x34444443, 0x34444443, 0x33333333,
};
/* Player: a chunky diamond so it reads on screen. */
static const u32 tile_player[8] = {
    0x00055000, 0x00555500, 0x05555550, 0x55555555,
    0x55555555, 0x05555550, 0x00555500, 0x00055000,
};
/* A single off-center star pixel on a dark field (background twinkle). */
static const u32 tile_star[8]   = {
    0x00000000, 0x00060000, 0x00000000, 0x00000600,
    0x00000000, 0x06000000, 0x00000000, 0x00000060,
};

#define PLANE_W_CELLS 64          /* default plane is 64x32 cells       */
#define WORLD_W       512         /* = 64 cells * 8 px (one plane wide)  */
#define SCREEN_W      320         /* H40                                  */
#define GROUND_Y      192         /* px — top of the ground strip         */

/* Static foreground platforms in WORLD PIXEL coords. Painted ONCE. */
typedef struct { s16 x, y, wcells; } Block;
static const Block blocks[] = {
    {  48, 152, 5 }, { 160, 128, 4 }, { 256, 160, 6 },
    { 352, 112, 4 }, { 432, 144, 5 },
};
#define N_BLOCKS (sizeof(blocks) / sizeof(blocks[0]))

/* Player WORLD x exposed for headless motion-trace inspection:
 *   symbols({op:'resolve', name:'g_player_x'}) → read it over frames while
 *   holding RIGHT and compare against the camera scroll (see MENTAL_MODEL
 *   "Why does horizontal movement feel choppy?"). `volatile` keeps it from
 *   being optimised into a register so the read resolves. */
volatile s16 g_player_x = 32;     /* world px */
volatile s16 g_cam_x    = 0;      /* camera scroll (world px) */

int main(bool hard) {
    (void)hard;

    /* Palettes (BGR, 3 bits/chan). PAL0 = sprite, PAL1 = planes. */
    PAL_setColor(0 +  5, 0x008E);  /* player orange */
    PAL_setColor(16 + 1, 0x0A86);  /* ground top   (light)  */
    PAL_setColor(16 + 2, 0x0530);  /* ground body  (dark)   */
    PAL_setColor(16 + 3, 0x0CCC);  /* block edge   (white)  */
    PAL_setColor(16 + 4, 0x0844);  /* block body   (steel)  */
    PAL_setColor(16 + 6, 0x0EEE);  /* star         (white)  */

    /* Upload all tiles once. */
    VDP_loadTileData(tile_blank,  T_BLANK,  1, DMA);
    VDP_loadTileData(tile_ground, T_GROUND, 1, DMA);
    VDP_loadTileData(tile_block,  T_BLOCK,  1, DMA);
    VDP_loadTileData(tile_player, T_PLAYER, 1, DMA);
    VDP_loadTileData(tile_star,   T_STAR,   1, DMA);

    /* ── PAINT PLANE B (starfield) ONCE — fills the whole 64x32 plane so
     *    it tiles forever as the scroll wraps. NEVER touched again. ── */
    VDP_fillTileMapRect(BG_B, TILE_ATTR_FULL(PAL1, 0, 0, 0, T_STAR),
                        0, 0, PLANE_W_CELLS, 32);

    /* ── PAINT PLANE A (foreground world) ONCE. ──
     * Ground strip across the whole world width, then the platform blocks
     * on top. After this, the loop does NOT write the tilemap again. */
    VDP_fillTileMapRect(BG_A, TILE_ATTR_FULL(PAL1, 0, 0, 0, T_GROUND),
                        0, GROUND_Y >> 3, PLANE_W_CELLS, (256 - GROUND_Y) >> 3);
    for (u16 i = 0; i < N_BLOCKS; i++) {
        const Block* b = &blocks[i];
        VDP_fillTileMapRect(BG_A, TILE_ATTR_FULL(PAL1, 0, 0, 0, T_BLOCK),
                            b->x >> 3, b->y >> 3, b->wcells, 1);
    }

    VDP_drawText("PARALLAX  D-PAD = SCROLL", 7, 1);

    const s16 PLAYER_SPEED = 2;
    s16 player_screen_x = SCREEN_W / 2 - 4;  /* player stays mid-screen */

    while (TRUE) {
        u16 pad = JOY_readJoypad(JOY_1);

        /* Move the player through the WORLD. */
        if (pad & BUTTON_LEFT)  g_player_x -= PLAYER_SPEED;
        if (pad & BUTTON_RIGHT) g_player_x += PLAYER_SPEED;
        if (g_player_x < 0)            g_player_x = 0;
        if (g_player_x > WORLD_W - 8)  g_player_x = WORLD_W - 8;

        /* Camera centers on the player, clamped to the world edges. */
        s16 cam = g_player_x - (SCREEN_W / 2 - 4);
        if (cam < 0)                    cam = 0;
        if (cam > WORLD_W - SCREEN_W)   cam = WORLD_W - SCREEN_W;
        g_cam_x = cam;

        /* When the camera is hard against an edge, let the player walk to
         * the screen edge instead of staying pinned to the centre. */
        player_screen_x = g_player_x - cam;

        /* ★ THE ENTIRE PER-FRAME RENDER COST: two scroll-register writes.
         * Positive cam scrolls the plane LEFT, so we write the negative.
         * Plane A: 1:1 with the world. Plane B: 1/4 speed = parallax. */
        VDP_setHorizontalScroll(BG_A, -cam);
        VDP_setHorizontalScroll(BG_B, -(cam >> 2));

        /* Re-stage the one player sprite (screen space) + flush the SAT.
         * SPRITE_SIZE(1,1) = 8x8. */
        VDP_setSprite(0, player_screen_x, GROUND_Y - 8, SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(PAL0, 1, 0, 0, T_PLAYER));
        VDP_updateSprites(1, DMA);

        SYS_doVBlankProcess();
    }
    return 0;
}
