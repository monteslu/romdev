/* ── default.c — minimal NES starter ────────────────────────────
 *
 * Cycles the backdrop color (palette entry $3F00) through 4 shades.
 * Smallest possible "ROM that does something visible" — use this as
 * the starting point when you're not yet sure what you want to build.
 *
 * For something more game-shaped:
 *   - hello_sprite — sprite + d-pad movement
 *   - tile_engine  — 32×30 nametable + rooms + door transitions
 *
 * Both available via createProject({platform:"nes", template:"..."}).
 */

#include "nes_runtime.h"

static const uint8_t bg_colors[4] = { 0x0F, 0x01, 0x21, 0x31 };

void main(void) {
  uint8_t palette[32];
  uint8_t i;
  uint8_t shade = 0;
  uint8_t frame = 0;

  for (i = 0; i < 32; i++) palette[i] = bg_colors[0];

  ppu_off();
  palette_load(palette);
  oam_clear();
  ppu_on_all();

  for (;;) {
    ppu_wait_nmi();
    ++frame;
    if ((frame & 0x1F) == 0) {       /* every 32 frames */
      shade = (uint8_t)((shade + 1) & 0x03);
      /* Only the backdrop entry ($3F00) needs updating for a flash.
       * vram_set queues the write — NMI commits it next vblank. */
      vram_set(0x3F00, bg_colors[shade]);
    }
  }
}
