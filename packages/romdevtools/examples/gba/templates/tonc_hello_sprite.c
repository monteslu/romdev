/* ── tonc_hello_sprite.c — Game Boy Advance Tonc sprite + d-pad ─────
 *
 * One 8×8 sprite driven by the d-pad. The canonical Tonc-tutorial
 * pattern (every sprite chapter in gbadev.net/tonc opens with this
 * shape).
 *
 * Hardware notes:
 *   - 4bpp sprite tiles live at $06010000-$06017FFF (32 KB)
 *   - OAM (object attribute memory) at $07000000 — 128 sprites × 8 B
 *   - Each OBJ_ATTR is 8 bytes: attr0 (Y/shape/256-col), attr1
 *     (X/affine/size), attr2 (tile/priority/palette), filler
 *   - Sprite palette at $05000200-$050003FF (256 colors)
 *
 * Tonc API used:
 *   - tile4_t / TILE4              4bpp tile bitmap type
 *   - tile_mem[4][0]               first sprite tile slot
 *   - pal_obj_mem                  sprite palette memory
 *   - REG_DISPCNT                  display control
 *   - DCNT_MODE0 | DCNT_OBJ | DCNT_OBJ_1D   tile BG + sprites + linear OAM mapping
 *   - oam_init() + obj_buffer[]    shadow OAM + flush helper
 *   - obj_set_attr / obj_set_pos   sprite attribute helpers
 *   - oam_copy()                   shadow → real OAM (via DMA)
 *   - key_poll() + key_held(KEY_*)  input
 *   - VBlankIntrWait               frame heartbeat
 */

#include <tonc.h>
#include "gba_sfx.h"

/* A simple 8×8 sprite tile — colour 1 filled square. Each row of a
 * 4bpp tile is 4 bytes (8 pixels × 4 bits = 32 bits). All-1s = every
 * pixel uses palette index 1. */
static const u32 sprite_tile[8] = {
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
};

/* Shadow OAM. Tonc's recommended pattern: allocate your own 128-slot
 * buffer in WRAM, mutate it freely each frame, then oam_copy to push
 * the changes to OAM hardware via DMA. */
static OBJ_ATTR obj_buffer[128];

int main(void) {
    int x = 120, y = 80;

    /* ── Sprite tile data ─────────────────────────────────────────
     * Upload our tile into the FIRST sprite tile slot (object tile
     * area at char base 4, tile 0). tile_mem[4] is the OBJ char
     * base, [0] is the tile index. tonccpy is Tonc's VRAM-safe
     * memcpy (only does 16/32-bit writes — VRAM hates byte writes). */
    tonccpy(&tile_mem[4][0], sprite_tile, sizeof(sprite_tile));

    /* ── Sprite palette ───────────────────────────────────────────
     * pal_obj_mem[i] = colour i in the sprite palette. Index 0 is
     * always transparent for sprites; index 1 = bright cyan. */
    pal_obj_mem[1] = CLR_CYAN;

    /* ── OAM shadow init + place sprite 0 at (x, y) ───────────────
     * oam_init clears the 128-slot shadow buffer (hides every
     * sprite). Then we configure sprite 0 with:
     *   attr0: y + 8x8 shape (ATTR0_SQUARE) + regular (non-affine)
     *   attr1: x + tiny size (ATTR1_SIZE_8 = 8x8 within the square)
     *   attr2: tile 0, priority 0, palette 0
     */
    oam_init(obj_buffer, 128);

    /* ── IRQ setup ── REQUIRED for VBlankIntrWait() to work ──────
     * Without this, the BIOS halts the CPU on the first
     * VBlankIntrWait() forever (it waits for an IRQ that never
     * fires). Single most common GBA-Tonc gotcha. */
    irq_init(NULL);
    irq_add(II_VBLANK, NULL);

    /* Tiny boot chime so it's obvious sound is working from frame 1. */
    sfx_init();
    sfx_tone(1, 1700, 8);

    obj_set_attr(&obj_buffer[0],
        ATTR0_SQUARE,
        ATTR1_SIZE_8,
        ATTR2_PALBANK(0) | 0);
    obj_set_pos(&obj_buffer[0], x, y);

    /* ── Display setup ───────────────────────────────────────────
     * DCNT_MODE0  — tiled mode (so BG0..3 are tile maps)
     * DCNT_OBJ    — enable sprites
     * DCNT_OBJ_1D — linear OAM tile addressing (vs the 2D matrix
     *               layout that's almost always wrong) */
    REG_DISPCNT = DCNT_MODE0 | DCNT_OBJ | DCNT_OBJ_1D;

    /* ── Game loop ───────────────────────────────────────────────
     * key_poll() updates the key state — call it once per frame.
     * key_held(KEY_LEFT) etc. test current state. */
    while (1) {
        VBlankIntrWait();

        key_poll();
        if (key_held(KEY_LEFT)  && x > 0)   x--;
        if (key_held(KEY_RIGHT) && x < 232) x++;
        if (key_held(KEY_UP)    && y > 0)   y--;
        if (key_held(KEY_DOWN)  && y < 152) y++;

        obj_set_pos(&obj_buffer[0], x, y);

        /* Flush all 128 OAM slots via DMA. Cheap; do it every frame. */
        oam_copy(oam_mem, obj_buffer, 128);
    }
    return 0;
}
