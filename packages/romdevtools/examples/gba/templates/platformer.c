/* ── platformer.c — Game Boy Advance Tonc SIDE-SCROLLING platformer ──
 *
 * A horizontally scrolling platformer: the world is 512 px wide, BG0
 * uses a 64x32 map (so the whole world fits with no streaming), the
 * camera follows the player via REG_BG0HOFS, and the HUD lives on BG1
 * which we leave un-scrolled. Gravity, jump, land-on-top collision
 * against a static platform list in WORLD coords.
 *
 * Physics is fixed-point: x/y in 1/16-pixel subpixel units. The player
 * sprite draws at SCREEN x = (worldX>>4) - camX.
 *
 * For a world WIDER than the 64x32 map (512 px) you stream the column
 * entering view each 8-px camera step into the map's screen-blocks —
 * see the GBA MENTAL_MODEL.md "Horizontal scrolling" section.
 */

#include <tonc.h>
#include "gba_sfx.h"

#define TILE_BLANK    0
#define TILE_PLATFORM 1
#define TILE_PLAYER   1   /* sprite tile 1 (sprites have their own char base) */

static const u32 tile_platform[8] = {
    0x11111111, 0x12222221, 0x12222221, 0x12222221,
    0x12222221, 0x12222221, 0x12222221, 0x11111111,
};
static const u32 tile_player[8] = {
    0x00033000, 0x00333300, 0x03333330, 0x03333330,
    0x03333330, 0x03333330, 0x00333300, 0x00033000,
};

typedef struct { s16 x, y, w, h; } Rect;

#define WORLD_W  512
#define SCREEN_W 240

/* Static platforms in WORLD PIXEL coords, spread across the 512-px world. */
static const Rect platforms[] = {
    {   0, 144, 512,  16 }, /* floor spans the world */
    {  24, 112,  56,   8 },
    { 140, 100,  64,   8 },
    { 250,  84,  48,   8 },
    { 360,  68,  56,   8 },
    { 440, 120,  56,   8 },
    { 180,  52,  48,   8 },
};
/* (int) cast so `for (int i = 0; i < N_PLATFORMS; ...)` doesn't compare a
 * signed counter against an unsigned size_t (-Wsign-compare). */
#define N_PLATFORMS ((int)(sizeof(platforms) / sizeof(platforms[0])))

static OBJ_ATTR obj_buffer[128];

static int on_platform(s16 px, s16 py) {
    /* Returns 1 when an 8x8 player at (px, py) is standing on the
     * top edge of any platform. */
    for (int i = 0; i < N_PLATFORMS; i++) {
        const Rect *p = &platforms[i];
        if (py + 8 == p->y
            && px + 8 > p->x
            && px     < p->x + p->w) {
            return 1;
        }
    }
    return 0;
}

int main(void) {
    /* ── BG palette (for the platform tile) ──────────────────────────
     * pal_bg_mem[i] is the BG palette. */
    pal_bg_mem[0] = CLR_BLACK;
    pal_bg_mem[1] = CLR_GRAY;       /* platform edge */
    pal_bg_mem[2] = RGB15(8, 8, 12);/* platform fill */

    /* ── Sprite palette ──────────────────────────────────────────────
     * Sprite palette 0, colour 3 = red player. */
    pal_obj_mem[3] = CLR_RED;

    /* ── BG tiles ─ char base 0 ─ */
    tonccpy(&tile_mem[0][TILE_PLATFORM], tile_platform, sizeof(tile_platform));

    /* ── Sprite tiles ─ char base 4 ─ */
    tonccpy(&tile_mem[4][TILE_PLAYER], tile_player, sizeof(tile_player));

    /* ── BG0 control ── char-block 0, 64x32 map (= 512x256 px, fits the
     * whole world). A 64x32 map occupies TWO screen-blocks (28 and 29);
     * BG1's HUD sits at SBB 30, clear of it. ── */
    REG_BG0CNT = BG_CBB(0) | BG_SBB(28) | BG_REG_64x32 | BG_4BPP;

    /* Draw platforms into the 64x32 map. A 64-wide map is laid out as two
     * 32x32 screen-blocks side by side: the left 32 cols in SBB 28, the
     * right 32 cols in SBB 29. se_index() handles that mapping for us, but
     * we can address it as a flat 64-wide grid via the helper below. */
    SCR_ENTRY *sbbL = se_mem[28];
    SCR_ENTRY *sbbR = se_mem[29];
    #define MAP_SET(tx, ty, se) do {                                   \
        if ((tx) < 32) sbbL[(ty) * 32 + (tx)] = (se);                  \
        else           sbbR[(ty) * 32 + ((tx) - 32)] = (se);           \
    } while (0)
    for (int ty = 0; ty < 32; ty++)
        for (int tx = 0; tx < 64; tx++)
            MAP_SET(tx, ty, SE_BUILD(TILE_BLANK, 0, 0, 0));
    for (int i = 0; i < N_PLATFORMS; i++) {
        const Rect *p = &platforms[i];
        int tx0 = p->x >> 3, ty0 = p->y >> 3;
        int tw  = (p->w + 7) >> 3, th = (p->h + 7) >> 3;
        for (int dy = 0; dy < th; dy++)
            for (int dx = 0; dx < tw; dx++) {
                int tx = tx0 + dx, ty = ty0 + dy;
                if (tx < 64 && ty < 32) MAP_SET(tx, ty, SE_BUILD(TILE_PLATFORM, 0, 0, 0));
            }
    }

    oam_init(obj_buffer, 128);

    /* IRQ setup — required for VBlankIntrWait() to function. */
    irq_init(NULL);
    irq_add(II_VBLANK, NULL);

    sfx_init();

    /* ── TTE for hint text on a SECOND BG ────────────────────────────
     * BG1 at screen-block 30, char-block 2 (TTE chr4c packs glyphs
     * starting around tile 0 of its char-block). */
    tte_init_chr4c_default(1, BG_CBB(2) | BG_SBB(30));
    tte_write("#{P:64,8}D-PAD MOVE  A JUMP");

    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0 | DCNT_BG1 | DCNT_OBJ | DCNT_OBJ_1D;

    /* Subpixel state — 1 pixel = 16 subpixels. WORLD coords. */
    s32 px = 32 << 4, py = 60 << 4;
    s32 vx = 0,       vy = 0;
    s32 camX = 0;

    const s32 GRAVITY    = 12;
    const s32 MOVE_SPEED = 24;
    const s32 JUMP_VEL   = -200;
    const s32 MAX_FALL   = 320;

    u16 prev = 0;

    while (1) {
        VBlankIntrWait();
        key_poll();

        vx = 0;
        if (key_held(KEY_LEFT))  vx = -MOVE_SPEED;
        if (key_held(KEY_RIGHT)) vx =  MOVE_SPEED;

        s16 ipx = px >> 4;
        s16 ipy = py >> 4;
        int grounded = on_platform(ipx, ipy);

        u16 now = key_curr_state();
        if ((now & KEY_A) && !(prev & KEY_A) && grounded) {
            vy = JUMP_VEL;
            sfx_tone(1, 1500, 6);   /* boing */
        }
        prev = now;

        vy += GRAVITY;
        if (vy > MAX_FALL) vy = MAX_FALL;
        if (grounded && vy > 0) vy = 0;

        /* Horizontal — clamp to the world (it scrolls now, no wrap). */
        px += vx;
        if (px < 0) px = 0;
        if (px > ((WORLD_W - 8) << 4)) px = (WORLD_W - 8) << 4;

        /* Vertical with platform-stop. */
        s32 np = py + vy;
        s16 npy = np >> 4;
        /* THE fall-through-the-floor fix: this used to be additionally
         * gated on blocked_below(), which only matches when a platform
         * top is within ONE pixel of the feet — but falls reach 20 px/
         * frame, so the (correct) crossing test below almost never got
         * to run and the player tunnelled through every platform. The
         * crossing test alone is the right check. */
        if (vy > 0) {
            for (int i = 0; i < N_PLATFORMS; i++) {
                const Rect *p = &platforms[i];
                if (ipy + 8 <= p->y && npy + 8 >= p->y
                    && ipx + 8 > p->x && ipx < p->x + p->w) {
                    py = (p->y - 8) << 4;
                    vy = 0;
                    sfx_tone(2, 800, 3);   /* thud */
                    goto done_y;
                }
            }
        }
        py = np;
        if (py > (160 << 4)) { py = 0; vy = 0; }
done_y:

        /* Camera follows player, centered, clamped to the world. Write the
         * BG0 horizontal scroll offset. BG1 (HUD) is left un-scrolled. */
        camX = (px >> 4) - (SCREEN_W / 2 - 4);
        if (camX < 0) camX = 0;
        if (camX > WORLD_W - SCREEN_W) camX = WORLD_W - SCREEN_W;
        REG_BG0HOFS = camX;

        /* Player sprite drawn in SCREEN space = world - camera. */
        obj_set_attr(&obj_buffer[0],
            ATTR0_SQUARE,
            ATTR1_SIZE_8,
            ATTR2_PALBANK(0) | TILE_PLAYER);
        obj_set_pos(&obj_buffer[0], (px >> 4) - camX, py >> 4);
        oam_copy(oam_mem, obj_buffer, 1);
    }
    return 0;
}
