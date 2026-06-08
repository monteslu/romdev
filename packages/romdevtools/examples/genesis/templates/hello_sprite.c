/* ── hello_sprite.c — Genesis SGDK starter (one sprite + d-pad) ───
 *
 * Drives one sprite around the screen with the directional pad. Uses
 * SGDK's lightweight VDP_setSprite() path (NOT the higher-level
 * sprite engine — that's reserved for hello_sprite + the genre
 * scaffolds where animation frames matter).
 *
 * Boots-from-cold game-loop shape:
 *   1. main(bool hard) — SGDK already initialised VDP + default
 *      palette in sega.s before us. We just load a tile + start drawing.
 *   2. Upload one 8×8 tile (filled square) to VRAM at TILE_USER_INDEX.
 *   3. Set sprite palette entry 1 to white so the tile shows up.
 *   4. Game loop: poll JOY_1, move sprite, VDP_setSprite + flush via
 *      VDP_updateSprites, then SYS_doVBlankProcess() to sync to vblank.
 *
 * Why VDP_updateSprites every frame?
 *   The VDP keeps its sprite-attribute table (SAT) in VRAM. SGDK
 *   buffers updates in vdpSpriteCache RAM-side and flushes via DMA
 *   on demand. Forget the flush → sprite never appears.
 */

#include <genesis.h>

/* A simple 8×8 tile, 4bpp Genesis format (32 bytes = 8 rows × 4 bytes
 * each, each byte = two 4-bit pixels). All pixels are colour index 1,
 * which we set to white below. */
static const u32 tile_data[8] = {
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
};

/* A checkered backdrop block tiled across plane B so the screen isn't a
 * flat black void (a lone sprite on black reads as "blank" to a human).
 * Colour index 4 with a thin colour-5 frame — we set both below. */
static const u32 tile_bg[8] = {
    0x44444444, 0x45555554, 0x45000054, 0x45000054,
    0x45000054, 0x45000054, 0x45555554, 0x44444444,
};

#define T_SPRITE (TILE_USER_INDEX + 0)
#define T_BG     (TILE_USER_INDEX + 1)

int main(bool hard) {
    (void)hard;

    s16 px = 152;  /* roughly mid-screen X (320 = H40, 152 ≈ centre - 8) */
    s16 py = 108;  /* roughly mid-screen Y (224 visible lines) */
    u16 prev = 0;

    /* Make sure sprite palette 0 entry 1 is white so we can see our
     * tile. SGDK uses 0RRR0GGG0BBB packed words (BGR, 3 bits each). */
    PAL_setColor(1, 0x0EEE); /* near-white sprite */
    /* Plane-B backdrop colours (palette 1). */
    PAL_setColor(16 + 4, 0x0640); /* dark teal field */
    PAL_setColor(16 + 5, 0x0860); /* lighter frame   */

    /* Upload the user tile to VRAM at TILE_USER_INDEX (everything
     * below that is reserved for SGDK's font + system tiles). */
    VDP_loadTileData(tile_data, T_SPRITE, 1, DMA);
    VDP_loadTileData(tile_bg,   T_BG,     1, DMA);

    /* Tile plane B with the backdrop block so there's a visible
     * background behind the sprite + text. Sprites + the font plane (A)
     * always draw above plane B, so the d-pad sprite reads on top. */
    for (u16 cy = 0; cy < 28; cy++)
        for (u16 cx = 0; cx < 40; cx++)
            VDP_setTileMapXY(BG_B, TILE_ATTR_FULL(PAL1, 0, 0, 0, T_BG), cx, cy);

    VDP_drawText("D-PAD MOVES THE SPRITE", 8, 2);
    VDP_drawText("START FOR SOFT RESET",  9, 4);

    while (TRUE) {
        u16 pad = JOY_readJoypad(JOY_1);

        if (pad & BUTTON_LEFT)  px -= 2;
        if (pad & BUTTON_RIGHT) px += 2;
        if (pad & BUTTON_UP)    py -= 2;
        if (pad & BUTTON_DOWN)  py += 2;

        /* Edge-detected START → soft-reset back to centre. */
        if ((pad & BUTTON_START) && !(prev & BUTTON_START)) {
            px = 152;
            py = 108;
        }
        prev = pad;

        /* Stage the sprite, flush the SAT, then sync to vblank.
         * SPRITE_SIZE(1,1) = 8×8. TILE_ATTR_FULL(palette,prio,vflip,
         * hflip,tile_index). */
        VDP_setSprite(0, px, py, SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(PAL0, 1, 0, 0, T_SPRITE));
        VDP_updateSprites(1, DMA);

        SYS_doVBlankProcess();
    }
    return 0;
}
