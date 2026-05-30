/* ── platformer.c — Game Boy SIDE-SCROLLING platformer scaffold ─────
 *
 * A horizontally scrolling platformer: the world is 256 px wide (the
 * full wrapping BG map), a camera follows the player and scrolls the BG
 * via the SCX register. Gravity + jump + land-on-top collision against
 * a static platform list in WORLD coords.
 *
 * Subpixel state (x/y in 1/16-pixel units) for fine acceleration. The
 * player sprite draws at SCREEN x = (worldX>>4) - camX.
 *
 * The world here is one BG map (256 px) so plain SCX scrolls it with no
 * streaming. For a WIDER world, stream the next BG-map column each time
 * camX crosses an 8-px boundary — see the GB MENTAL_MODEL.md.
 */

#include "gb_hardware.h"
#include "gb_runtime.h"

static const uint8_t tile_blank[16] = { 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0 };
static const uint8_t tile_player[16] = {
    0x18,0x18, 0x3C,0x3C, 0x7E,0x7E, 0xFF,0xFF,
    0xFF,0xFF, 0x7E,0x7E, 0x3C,0x3C, 0x18,0x18,
};
static const uint8_t tile_platform[16] = {
    0xFF,0xFF, 0x80,0x80, 0x80,0x80, 0x80,0x80,
    0x80,0x80, 0x80,0x80, 0x80,0x80, 0xFF,0xFF,
};

static const uint16_t obj_palette[4] = { 0x7FFF, 0x001F, 0x03E0, 0x7C00 };
static const uint16_t bg_palette[4]  = { 0x7FFF, 0x5294, 0x294A, 0x0000 };

typedef struct { int16_t x, y, w, h; } Rect;

#define WORLD_W  256
#define SCREEN_W 160

/* Platforms in WORLD coords, spread across the 256-px world. */
static const Rect platforms[] = {
    {   0, 128, 256,  16 }, /* floor spans the world */
    {  16, 100,  40,   8 },
    {  96,  96,  32,   8 },
    { 168,  80,  40,   8 },
    {  56,  64,  32,   8 },
    { 200, 110,  40,   8 },
    { 130,  48,  40,   8 },
};
#define N_PLATFORMS (sizeof(platforms)/sizeof(platforms[0]))

static uint8_t on_platform(int16_t px, int16_t py) {
    uint8_t i;
    const Rect *p;
    for (i = 0; i < N_PLATFORMS; i++) {
        p = &platforms[i];
        if (py + 8 == p->y && px + 8 > p->x && px < p->x + p->w) return 1;
    }
    return 0;
}

static void upload_tile(uint8_t slot, const uint8_t *src) {
    uint8_t *dst = (uint8_t *)(0x8000 + slot * 16);
    uint8_t i;
    for (i = 0; i < 16; i++) dst[i] = src[i];
}

static void paint_platforms(void) {
    /* Each cell of the BG map is 8×8, BG map base $9800. */
    uint8_t *map = (uint8_t *)0x9800;
    uint8_t i, j;
    uint16_t k;
    int16_t cx, cy, cw, ch;
    const Rect *p;
    /* k MUST be uint16_t: 32*18 = 576 > 255, so a uint8_t counter would
     * never reach the bound and this loop would spin forever (the BG map
     * never clears, main() never starts). Classic SDCC limited-range trap. */
    for (k = 0; k < 32 * 18; k++) map[k] = 0; /* blank tile slot 0 */
    for (i = 0; i < N_PLATFORMS; i++) {
        p = &platforms[i];
        cx = p->x >> 3;
        cy = p->y >> 3;
        cw = (p->w + 7) >> 3;
        ch = (p->h + 7) >> 3;
        for (j = 0; j < cw; j++) {
            if (cx + j < 32 && cy < 32)
                map[cy * 32 + cx + j] = 2; /* tile slot 2 = platform */
        }
    }
}

void main(void) {
    int16_t px = 16 << 4, py = 60 << 4;
    int16_t vx = 0,       vy = 0;
    int16_t ipx, ipy, npy, camX = 0;
    int32_t np;
    uint8_t grounded;
    uint8_t pad, prev = 0, i;
    const Rect *p;
    const int16_t GRAVITY = 10;
    const int16_t MOVE    = 20;
    const int16_t JUMP    = -180;
    const int16_t MAXFALL = 280;

    lcd_init_default();
    enable_vblank_irq();   /* MANDATORY: HALT-driven wait_vblank. Without this,
                            * busy-poll wait_vblank runs ~1/30 speed on the WASM
                            * emulator and the game loop appears to hang. */
    LCDC = 0;

    upload_tile(0, tile_blank);
    upload_tile(1, tile_player);
    upload_tile(2, tile_platform);

    OCPS = 0x80;
    for (i = 0; i < 4; i++) {
        OCPD = (uint8_t)(obj_palette[i] & 0xFF);
        OCPD = (uint8_t)((obj_palette[i] >> 8) & 0xFF);
    }
    BCPS = 0x80;
    for (i = 0; i < 4; i++) {
        BCPD = (uint8_t)(bg_palette[i] & 0xFF);
        BCPD = (uint8_t)((bg_palette[i] >> 8) & 0xFF);
    }

    paint_platforms();
    oam_clear();
    LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO;

    while (1) {
        wait_vblank();

        ipx = px >> 4;
        ipy = py >> 4;

        /* Camera follows the player, centered, clamped to the world.
         * Write SCX so the BG scrolls; player is drawn in SCREEN space. */
        camX = ipx - (SCREEN_W / 2 - 4);
        if (camX < 0) camX = 0;
        if (camX > WORLD_W - SCREEN_W) camX = WORLD_W - SCREEN_W;
        SCX = (uint8_t)camX;

        for (i = 0; i < 40; i++) oam_set(i, 0, 0, 0, 0);
        oam_set(0, ipy + 16, (ipx - camX) + 8, 1, 0);  /* screen x = world - cam */
        oam_dma_flush();

        pad = joypad_read();
        vx = 0;
        if (pad & PAD_LEFT)  vx = -MOVE;
        if (pad & PAD_RIGHT) vx =  MOVE;

        grounded = on_platform(ipx, ipy);
        if ((pad & PAD_A) && !(prev & PAD_A) && grounded) vy = JUMP;
        prev = pad;

        vy += GRAVITY;
        if (vy > MAXFALL) vy = MAXFALL;
        if (grounded && vy > 0) vy = 0;

        px += vx;
        if (px < 0) px = 0;
        if (px > (WORLD_W - 8) << 4) px = (WORLD_W - 8) << 4;

        np = py + vy;
        npy = np >> 4;
        if (vy > 0) {
            for (i = 0; i < N_PLATFORMS; i++) {
                p = &platforms[i];
                if (ipy + 8 <= p->y && npy + 8 >= p->y
                    && ipx + 8 > p->x && ipx < p->x + p->w) {
                    py = (p->y - 8) << 4;
                    vy = 0;
                    goto done;
                }
            }
        }
        py = np;
        if (py > 144 << 4) { py = 0; vy = 0; }
done:   ;
    }
}
