/* ── lcd_init — turn the LCD on with sensible DMG defaults ─────────
 * BG ON, OBJ ON, tile data $8000-$8FFF (unsigned), BG map $9800.
 * Default DMG grayscale palette (BGP=$E4 = 3-2-1-0).
 *
 * Call once from main() before doing anything else.
 */
#include "gb_hardware.h"

void lcd_init(void) {
  /* Wait for vblank before touching the LCD control reg. */
  while (LY < 144) { }
  LCDC = 0;                          /* turn off so we can safely write VRAM */
  BGP  = 0xE4;                       /* 11 10 01 00 — darkest first */
  OBP0 = 0xE0;
  OBP1 = 0xE0;
  SCY  = 0;
  SCX  = 0;
  LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO;
}
