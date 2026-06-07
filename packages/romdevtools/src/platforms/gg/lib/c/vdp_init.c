/* SMS VDP — minimum viable initialization (C).
 *
 * Writes the 11 mode-4 registers to a sane baseline:
 *   display OFF, vblank IRQ off, 192-line mode 4, name table at $3800,
 *   BG tile data at $0000, sprite attr table at $3F00, sprite tile data
 *   at $2000 (R6=0xFF → SA13 set → tiles read from $2000-$3FFF). Call
 *   once after reset before uploading palette/tiles/map.
 *
 * Sprite-tile base: R6 bit 2 (SA13) selects $0000 (clear) vs $2000 (set).
 * We default to R6=0xFF ($2000) because EVERY bundled scaffold uploads its
 * sprite tiles to $2000 (gg_load_tiles(0x2000, ...)) — so the baseline must
 * match what consumers do, or sprites read from the empty/BG bank and render
 * invisible. (Many SMS/GG references say "R6=0xFB → $2000", which is backwards:
 * 0xFB has SA13 CLEAR = $0000.) If you instead keep sprite tiles in the BG
 * bank at $0000, set R6=0xFB. sprites({op:'inspect'}) → spriteTileDataBase
 * shows the address the VDP is actually reading from.
 *
 * After loading assets, enable display by re-writing R1 with bit 6 set:
 *   gg_vdp_display_on();
 */
#include "gg_hw.h"

/* Write a value to a VDP register. SMS convention: data first, then
 * (0x80 | reg). */
void gg_vdp_write_reg(uint8_t reg, uint8_t value) {
  PORT_VDP_CTRL = value;
  PORT_VDP_CTRL = VDP_REG_WRITE | reg;
}

void gg_vdp_init(void) {
  static const uint8_t regs[11] = {
    0x36,  /* R0:  Mode 4 */
    0x80,  /* R1:  display OFF, vblank IRQ off */
    0xFF,  /* R2:  name table at $3800 */
    0xFF,  /* R3:  color table (ignored in M4) */
    0xFF,  /* R4:  BG tile data at $0000 */
    0xFF,  /* R5:  sprite attr table at $3F00 */
    0xFF,  /* R6:  sprite tile data at $2000 (SA13 set; scaffolds upload here) */
    0x00,  /* R7:  border = sprite palette entry 0 */
    0x00,  /* R8:  BG X scroll */
    0x00,  /* R9:  BG Y scroll */
    0xFF,  /* R10: line IRQ counter disabled */
  };
  uint8_t i;
  for (i = 0; i < 11; i++) gg_vdp_write_reg(i, regs[i]);
}

void gg_vdp_display_on(void) {
  gg_vdp_write_reg(1, 0xE0);  /* display on, vblank IRQ on, 192-line */
}

void gg_vdp_display_off(void) {
  gg_vdp_write_reg(1, 0x80);
}

/* Set the VDP destination address (for the next data-port writes). */
void gg_vdp_set_addr(uint16_t addr, uint8_t prefix) {
  PORT_VDP_CTRL = (uint8_t)(addr & 0xFF);
  PORT_VDP_CTRL = (uint8_t)((addr >> 8) & 0x3F) | prefix;
}
