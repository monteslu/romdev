/* GG palette loader — uploads 64-byte palette (32 entries × 2 bytes) to CRAM.
 *
 * GG CRAM: 32 entries × 2 bytes (4-4-4 BGR LE), 64 bytes total.
 *   Entry layout: low byte = $GR (G=high nibble, R=low), high byte = $0B.
 *   Pack with: low = (g << 4) | r, high = b.
 *
 *     extern const uint8_t my_palette[64];
 *     gg_load_palette(my_palette);
 *
 * Entries 0-15 = BG palette, 16-31 = sprite palette.
 */
#include "gg_hw.h"

extern void gg_vdp_set_addr(uint16_t addr, uint8_t prefix);

void gg_load_palette(const uint8_t *palette) {
  uint16_t i;
  gg_vdp_set_addr(0, VDP_CRAM_WRITE);
  for (i = 0; i < 64; i++) PORT_VDP_DATA = palette[i];
}
