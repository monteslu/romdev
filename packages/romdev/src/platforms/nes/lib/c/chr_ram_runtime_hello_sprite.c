/* chr_ram_runtime_hello_sprite.c — canonical NES sprite-render pattern.
 *
 * This is the "does my NES build pipeline work" sanity check. If
 * this compiles and shows a moving square, your toolchain + runtime
 * + linker preset are all wired correctly. Use as the starting
 * point for any sprite-driven game.
 *
 * Build with:
 *   buildSource({platform:"nes", linkerConfig:"chr-ram-runtime",
 *                sources:{"main.c": <this>, "nes_runtime.c": <runtime>},
 *                includes:{"nes_runtime.h": <header>}})
 *
 * What this demonstrates (each footgun cost a previous agent rounds):
 *
 * 1. Init order: ppu_off → upload CHR → upload palette → seed OAM
 *    → ppu_on_all. CHR/palette uploads only land while rendering is
 *    OFF. Inverting this order = "tiles never appear."
 *
 * 2. Loop order: stage shadow_oam → ppu_wait_nmi (NOT wait_nmi then
 *    stage). The NMI handler DMAs shadow_oam at vblank start;
 *    populate it BEFORE sleeping or you'll DMA stale data.
 *
 * 3. Sprite Y is screen-Y minus 1 (hardware off-by-one). oam_spr
 *    handles this for you — pass screen Y directly.
 *
 * 4. Sprite pattern table is at $0000 by default (PPUCTRL bit 3 = 0).
 *    Upload sprite tiles via chr_ram_upload(0x0000 + tile*16, ...),
 *    NOT 0x1000 (that's the BG pattern table).
 */
#include "nes_runtime.h"

/* 8x8 hollow-square sprite tile (2bpp NES format, two planes). */
static const uint8_t sprite_tile[16] = {
  /* plane 0 (low bit of each pixel — color 1 fills the outline) */
  0xFF, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xFF,
  /* plane 1 (high bit — zero, so all pixels are color 1) */
  0,    0,    0,    0,    0,    0,    0,    0,
};

/* 32-byte palette. Sprite palette 0 (entries 16-19) defines the
 * outline color. Color 0 of every palette is the universal backdrop
 * — set $0F (black) to avoid the "wrong colour" footgun. */
static const uint8_t palette[32] = {
  /* BG palettes 0-3 */
  0x0F, 0x30, 0x10, 0x00,
  0x0F, 0x21, 0x11, 0x01,
  0x0F, 0x27, 0x17, 0x07,
  0x0F, 0x2A, 0x1A, 0x0A,
  /* Sprite palettes 0-3 — palette 0 colour 1 = light blue */
  0x0F, 0x2C, 0x12, 0x32,
  0x0F, 0x21, 0x11, 0x01,
  0x0F, 0x27, 0x17, 0x07,
  0x0F, 0x2A, 0x1A, 0x0A,
};

void main(void) {
  uint8_t px = 124;       /* mid-screen X */
  uint8_t py = 110;       /* mid-screen Y (avoid row 0 — see footgun #1) */
  uint8_t pad;

  /* ── 1. Init (rendering OFF — safe to write VRAM) ─────────── */
  ppu_off();
  chr_ram_upload(0x0010, sprite_tile, 16);    /* tile 1 of sprite pattern table */
  palette_load(palette);
  oam_clear();
  oam_spr(px, py, /* tile */ 1, /* attr */ 0);
  ppu_on_all();

  /* ── 2. Game loop — stage FIRST, then wait ──────────────────── */
  for (;;) {
    oam_clear();
    oam_spr(px, py, 1, 0);          /* stage sprite at current px/py */
    ppu_wait_nmi();                  /* NMI DMAs the sprite we just staged */

    pad = pad_poll(0);
    if (pad & PAD_LEFT)  --px;
    if (pad & PAD_RIGHT) ++px;
    if (pad & PAD_UP)    --py;
    if (pad & PAD_DOWN)  ++py;
  }
}
