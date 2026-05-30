/* GG sprite attribute table — shadow OAM in WRAM, DMA'd to SAT once
 * per frame. GG VDP is SMS-compatible so the SAT layout is identical.
 *
 * SAT VRAM layout ($3F00):
 *   $00-$3F:  64 Y bytes ($D0 in any slot = HARD TERMINATOR — see below)
 *   $80-$FF:  64 (X, tile) pairs
 *
 * The $D0 terminator footgun:
 *   The VDP stops scanning further sprite slots the moment it sees Y=$D0
 *   in ANY OAM byte. If you populate slots 0..5 and slot 6 still has
 *   $D0, slot 5 is the last sprite you'll ever see. Earlier rounds of
 *   this runtime initialised every slot to $D0 — "hidden at boot" — but
 *   that meant the FIRST gap in your sprite allocation killed the
 *   renderer for everything past it. We now initialise unused slots to
 *   $E0 instead: still off-screen but NOT the terminator. Slots you
 *   don't touch stay invisible; slots you do touch render. Set a slot's
 *   Y to $D0 yourself if you ACTUALLY want the renderer to stop there.
 *
 * Workflow:
 *   gg_sprite_init();             // once
 *   gg_sprite_set(0, x, y, 4);    // game logic
 *   ...
 *   gg_sat_upload();              // once per vblank
 */
#include "gg_hw.h"

extern void gg_vdp_set_addr(uint16_t addr, uint8_t prefix);

/* Shadow OAM: matches the VDP's expected SAT layout. */
uint8_t shadow_oam[256];

/* Y value for "hidden but not terminator." 192-line mode is visible
 * Y=0..191; $E0 (224) is below the visible area and won't render.
 * Also below the GG visible viewport (hw-coord y∈[24,167]). */
#define OAM_Y_HIDDEN  0xE0

void gg_sprite_init(void) {
  uint8_t i;
  /* Park every slot off-screen with a non-terminator Y. The renderer
   * keeps scanning past these (so any slot you later populate will
   * actually draw); they just don't render themselves. */
  for (i = 0; i < 64; i++) shadow_oam[i] = OAM_Y_HIDDEN;
  for (i = 0; i < 128; i++) shadow_oam[0x80 + i] = 0;
}

void gg_sprite_set(uint8_t slot, uint8_t x, uint8_t y, uint8_t tile) {
  shadow_oam[slot] = y;
  shadow_oam[0x80 + (uint16_t)slot * 2] = x;
  shadow_oam[0x80 + (uint16_t)slot * 2 + 1] = tile;
}

void gg_sat_upload(void) {
  uint8_t i;
  /* Y bytes → VRAM $3F00. */
  gg_vdp_set_addr(0x3F00, VDP_VRAM_WRITE);
  for (i = 0; i < 64; i++) PORT_VDP_DATA = shadow_oam[i];
  /* (X, tile) pairs → VRAM $3F80. */
  gg_vdp_set_addr(0x3F80, VDP_VRAM_WRITE);
  for (i = 0; i < 128; i++) PORT_VDP_DATA = shadow_oam[0x80 + i];
}
