/* ── default.c — minimal Game Boy Color (CGB) starter ─────────────
 *
 * Boots the LCD, cycles a real CGB background palette via the BCPS
 * + BCPD palette-RAM registers. Smallest possible "ROM that does
 * something visible IN COLOR" — use this as the starting point when
 * you want CGB-mode color, not DMG greyscale.
 *
 * GBC-specific notes:
 *   - CGB uses BCPS/BCPD ($FF68/$FF69) to write into 64 bytes of
 *     palette RAM (8 BG palettes × 4 colors × 2 bytes each, BGR555
 *     little-endian). DMG-only BGP ($FF47) does nothing in CGB mode.
 *   - patchGbHeader on a .gbc file sets $0143 = $80 (CGB-aware) by
 *     default. The corresponding `.gb` default uses BGP — don't
 *     cross-pollinate the two trees.
 *   - This template is intentionally DIFFERENT from examples/gb/
 *     templates/default.c — that one demonstrates DMG palettes.
 *
 * For something more game-shaped, peek at other templates in this dir:
 *   - hello_sprite — sprite + d-pad movement
 *   - tile_engine  — multi-room tile map with collision + transitions
 *   - shmup / platformer / puzzle / sports / racing — genre scaffolds
 *   - music_demo   — bundled hUGEDriver music driver demo
 */

#include "gb_hardware.h"
#include "gb_runtime.h"

static const uint16_t palettes[4] = {
  0x7FFF,  /* white */
  0x3DEF,  /* light grey */
  0x2108,  /* dark grey */
  0x0000,  /* black */
};

void main(void) {
  uint8_t i;
  uint8_t shade = 0;
  uint16_t frame = 0;

  lcd_init_default();

  /* Initial BG palette = all 4 entries cycle to the same shade. */
  BCPS = 0x80;
  for (i = 0; i < 4; i++) {
    BCPD = (uint8_t)(palettes[shade] & 0xFF);
    BCPD = (uint8_t)((palettes[shade] >> 8) & 0xFF);
  }

  for (;;) {
    wait_vblank();
    frame++;
    if ((frame & 0x1F) == 0) {       /* every 32 frames */
      shade = (shade + 1) & 0x03;
      BCPS = 0x80;
      for (i = 0; i < 4; i++) {
        BCPD = (uint8_t)(palettes[shade] & 0xFF);
        BCPD = (uint8_t)((palettes[shade] >> 8) & 0xFF);
      }
    }
  }
}
