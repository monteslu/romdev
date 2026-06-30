/* ── gt_sprites.h — runtime pixel-art sprites in GRAM (no asset pipeline) ──────
 *
 * Real colored sprite art without the SDK's .bmp asset pipeline: define a sprite
 * as a flat array of PALETTE-INDEX bytes (0 = transparent) and gt_load_sprite()
 * copies it into a GRAM page, then queue_draw_sprite blits a rect FROM that GRAM
 * to the framebuffer (per-pixel color, transparency on index 0).
 *
 * This mirrors the SDK's load_spritesheet() EXACTLY (the only correct GRAM-write
 * path) but copies raw bytes instead of inflatemem-decompressing them, so no
 * asset build step is needed:
 *   - flagsMirror = 0  (plain mode — NOT DMA_CPU_TO_VRAM; that mode corrupts it)
 *   - bank_reg = bankflip | GRAM_PAGE(ramBank)  (select the GRAM page)
 *   - then plain CPU writes to vram[] ($4000) land in that GRAM page, row-major.
 * (My earlier version used direct_prepare_array_mode/DMA_CPU_TO_VRAM + the wrong
 * bank → the sprite read uninitialized GRAM and showed as noise.)
 *
 * GRAM page geometry is 128 wide. Lay sprites out on a grid in the page and pass
 * each one's (gx,gy,w,h). Colors are SDK-draw-path palette indices — see
 * gt_palette.h. Call gt_load_sprite() ONCE per sprite at init.
 */
#ifndef GT_SPRITES_H
#define GT_SPRITES_H
#include "gametank.h"
#include "sprites.h"
#include "draw_queue.h"
#include "banking.h"

typedef struct GtSprite { unsigned char gx, gy, w, h; } GtSprite;

/* copy a w*h block of palette-index bytes into GRAM page 0 at (gx,gy). Mirrors
 * load_spritesheet's GRAM setup; restores draw state after. */
static void gt_load_sprite(const unsigned char *px, unsigned char gx, unsigned char gy,
                           unsigned char w, unsigned char h) {
  unsigned char x, y;
  unsigned char oldFlags = flagsMirror;
  unsigned char oldBanks = banksMirror;
  flagsMirror = 0;                              /* plain mode (the SDK's setup) */
  *dma_flags = flagsMirror;
  banksMirror = bankflip | GRAM_PAGE(0);        /* GRAM page 0 */
  *bank_reg = banksMirror;
  for (y = 0; y < h; y++)
    for (x = 0; x < w; x++)
      vram[(unsigned int)(gy + y) * 128 + (gx + x)] = px[(unsigned int)y * w + x];
  flagsMirror = oldFlags;                        /* restore */
  banksMirror = oldBanks;
  *dma_flags = flagsMirror;
  *bank_reg = banksMirror;
}

/* blit a loaded sprite to (x,y) via the draw queue (gram slot 0). */
#define gt_blit(x, y, S) queue_draw_sprite((x), (y), (S).w, (S).h, (S).gx, (S).gy, 0)

#endif /* GT_SPRITES_H */
