/* ── default.c — minimal Game Boy (DMG) starter ───────────────────
 *
 * Boots the LCD, cycles the DMG background palette through 4 shade
 * arrangements via BGP ($FF47). Smallest possible "ROM that does
 * something visible" — use this as the starting point when you're
 * not yet sure what you want to build.
 *
 * GB-specific notes for the agent:
 *   - DMG uses the BGP/OBP0/OBP1 registers — NOT the CGB BCPS/BCPD
 *     palette RAM. The GBC tree's default uses BCPS; don't copy that
 *     into a DMG project or your screen will stay one shade.
 *   - patchGbHeader writes $0143 = $00 by default on .gb files (DMG-
 *     only). If your ROM ever shows up white in gambatte, check that
 *     header byte first — $FF or $80 there forces CGB mode which
 *     silently ignores BGP/OBP*.
 *   - lcd_init_default() (from gb_runtime.c) sets BGP = 0xE4 (the
 *     "normal" arrangement: 11=black 10=dark 01=light 00=white) and
 *     turns the LCD on. We override BGP each shade tick to demonstrate
 *     the palette is alive.
 *
 * For something more game-shaped, peek at other templates in this dir:
 *   - hello_sprite — sprite + d-pad movement
 *   - tile_engine  — multi-room tile map with collision + transitions
 *   - shmup / platformer / puzzle / sports / racing — genre scaffolds
 *   - music_demo   — bundled hUGEDriver music driver demo
 */

#include "gb_hardware.h"
#include "gb_runtime.h"

/* Four BGP arrangements; each byte packs 4 color indices, 2 bits each:
 *   bits 7-6 = color for tile-index 3 (darkest source)
 *   bits 5-4 = color for tile-index 2
 *   bits 3-2 = color for tile-index 1
 *   bits 1-0 = color for tile-index 0 (lightest source)
 * Color: 0 = white, 1 = light grey, 2 = dark grey, 3 = black. */
static const uint8_t bgp_shades[4] = {
  0xE4,   /* normal:       3=black 2=dark  1=light 0=white */
  0x90,   /* inverted-ish: 3=dark  2=light 1=white 0=white */
  0x39,   /* shifted:      3=white 2=dark  1=dark  0=light */
  0x00,   /* all-white (DMG visible: "off"-looking screen) */
};

void main(void) {
  uint8_t shade = 0;
  uint16_t frame = 0;

  lcd_init_default();   /* turns LCD on with BGP=0xE4, BG+OBJ enabled */

  for (;;) {
    wait_vblank();
    frame++;
    if ((frame & 0x1F) == 0) {       /* every 32 frames */
      shade = (uint8_t)((shade + 1) & 0x03);
      BGP = bgp_shades[shade];
    }
  }
}
