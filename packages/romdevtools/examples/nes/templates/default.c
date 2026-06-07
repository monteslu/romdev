/* ── default.c — minimal NES starter ────────────────────────────
 *
 * A "hello, it works!" screen: a tiled background band + a bouncing
 * sprite, so the very first build shows recognizable content (not a
 * flat color). Smallest starting point when you're not yet sure what
 * you want to build — edit from here.
 *
 * For something more game-shaped:
 *   - hello_sprite — sprite + d-pad movement
 *   - tile_engine  — 32×30 nametable + rooms + door transitions
 *   - scaffold({op:'game', genre:'shmup'|'platformer'|...}) — full genres
 *
 * NES uses CHR-RAM here, so we upload our tile graphics at boot before
 * turning rendering on (an empty CHR-RAM = a blank screen — the #1 NES
 * "why is it black" footgun; see TROUBLESHOOTING.md).
 */

#include "nes_runtime.h"

/* Two 8×8 tiles in 2bpp NES format (plane0 = low bit, plane1 = high bit;
 * 8 bytes each). Tile 1 = a solid filled block (color 1). Tile 2 = a simple
 * face/box so the sprite reads as an object. */
static const uint8_t tiles[32] = {
  /* tile 1 — solid block: plane0 all-on, plane1 all-off → every pixel color 1 */
  0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  /* tile 2 — sprite: a filled diamond/box (color 1 outline + fill) */
  0x18,0x3C,0x7E,0xFF,0xFF,0x7E,0x3C,0x18,
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
};

/* 32-byte palette: BG palette 0 gives the block a bright color on a blue
 * backdrop; sprite palette 0 colour 1 = yellow so the sprite pops. */
static const uint8_t palette[32] = {
  0x01, 0x30, 0x21, 0x0F,   /* BG0: backdrop blue, block white, ... */
  0x01, 0x30, 0x21, 0x0F,
  0x01, 0x30, 0x21, 0x0F,
  0x01, 0x30, 0x21, 0x0F,
  0x0F, 0x28, 0x16, 0x30,   /* SPR0: colour1 yellow */
  0x0F, 0x28, 0x16, 0x30,
  0x0F, 0x28, 0x16, 0x30,
  0x0F, 0x28, 0x16, 0x30,
};

void main(void) {
  uint8_t x, y;
  uint8_t sx = 120, sy = 96;     /* sprite position */
  int8_t dx = 1, dy = 1;         /* sprite velocity */
  uint8_t frame = 0;

  ppu_off();
  /* The runtime's default PPUCTRL puts SPRITES at pattern table $0000 and the
   * BACKGROUND at $1000 — two separate 4KB tables. So upload the block tile to
   * the BG table ($1000, slot 1 → $1010) AND the sprite tile to the sprite
   * table ($0000, slot 2 → $0020). (Uploading only to $0000 = invisible BG, the
   * classic "my tiles are in the wrong pattern table" NES gotcha.) */
  chr_ram_upload(0x1010, tiles,      16);  /* BG  block  → BG tile index 1  */
  chr_ram_upload(0x0020, tiles + 16, 16);  /* SPR object → sprite tile index 2 */
  palette_load(palette);
  oam_clear();

  /* Populate the nametable DIRECTLY while rendering is off. We use
   * vram_unsafe_set (a raw PPU write) here on purpose: the friendly tile_set()
   * goes through the NMI-flushed queue (24 entries), which would deadlock if you
   * push hundreds of tiles before turning the PPU on. The "write VRAM directly
   * while off, then turn on" idiom is the standard NES way to lay out a screen.
   * Tile index 1 = the solid block. */
  for (x = 0; x < 32; x++) {
    vram_unsafe_set((uint16_t)(0x2000 + 4 * 32 + x), 1);    /* top band  (row 4)  */
    vram_unsafe_set((uint16_t)(0x2000 + 25 * 32 + x), 1);   /* bottom band (row 25) */
  }
  for (y = 10; y < 18; y++) {
    for (x = 8; x < 24; x++)
      vram_unsafe_set((uint16_t)(0x2000 + (uint16_t)y * 32 + x), 1);  /* center box */
  }

  ppu_on_all();

  for (;;) {
    /* stage the sprite BEFORE waiting (NMI DMAs shadow_oam at vblank). */
    oam_clear();
    oam_spr(sx, sy, 2, 0);         /* tile 2, sprite palette 0 */
    ppu_wait_nmi();

    ++frame;
    /* bounce the sprite around the visible area */
    sx = (uint8_t)(sx + dx);
    sy = (uint8_t)(sy + dy);
    if (sx < 8 || sx > 240) dx = (int8_t)-dx;
    if (sy < 16 || sy > 208) dy = (int8_t)-dy;
  }
}
