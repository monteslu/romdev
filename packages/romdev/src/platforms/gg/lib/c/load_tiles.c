/* SMS tile loader — upload bytes to VRAM at any destination.
 *
 * SMS tiles are 32 bytes each (4bpp interleaved). VRAM is 16 KB at
 * $0000-$3FFF. Tile N lives at VRAM offset (N * 32).
 *
 *     extern const uint8_t my_tiles[];
 *     gg_load_tiles(0x0000, my_tiles, sizeof(my_tiles));  // sprite bank
 *
 * Default R6=0xFB → sprite tiles read from $0000 (shared with BG tiles).
 * If you want sprite tiles in their own bank at $2000, set R6=0xFF AND
 * upload to $2000. Don't pick the address without checking R6.
 */
#include "gg_hw.h"

extern void gg_vdp_set_addr(uint16_t addr, uint8_t prefix);

void gg_load_tiles(uint16_t vram_dest, const uint8_t *src, uint16_t byte_count) {
  uint16_t i;
  gg_vdp_set_addr(vram_dest, VDP_VRAM_WRITE);
  for (i = 0; i < byte_count; i++) PORT_VDP_DATA = src[i];
}

/* Write a single name-table cell. Default name table at $3800.
 *   tile_idx: 0..511 (low 9 bits)
 *   attr:     hflip = bit 1, vflip = bit 2, palette = bit 3, priority = bit 4
 */
void gg_set_tilemap_cell(uint8_t row, uint8_t col, uint8_t tile_idx, uint8_t attr) {
  uint16_t addr = 0x3800 + ((uint16_t)row * 32 + col) * 2;
  gg_vdp_set_addr(addr, VDP_VRAM_WRITE);
  PORT_VDP_DATA = tile_idx;
  PORT_VDP_DATA = attr;
}
