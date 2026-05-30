/* SMS palette loader — bulk upload to CRAM.
 *
 * SMS CRAM: 32 entries × 1 byte (2-2-2 BGR). White = 0x3F.
 * GG CRAM:  32 entries × 2 bytes (4-4-4 BGR LE).
 *
 *     extern const uint8_t my_palette[32];
 *     sms_load_palette(my_palette);
 */
#include "sms_hw.h"

extern void sms_vdp_set_addr(uint16_t addr, uint8_t prefix);

void sms_load_palette(const uint8_t *palette) {
  uint8_t i;
  sms_vdp_set_addr(0, VDP_CRAM_WRITE);
  for (i = 0; i < 32; i++) PORT_VDP_DATA = palette[i];
}

/* Game Gear variant — uploads 64 bytes (32 entries × 2). */
void gg_load_palette(const uint8_t *palette) {
  uint8_t i;
  sms_vdp_set_addr(0, VDP_CRAM_WRITE);
  for (i = 0; i < 64; i++) PORT_VDP_DATA = palette[i];
}
