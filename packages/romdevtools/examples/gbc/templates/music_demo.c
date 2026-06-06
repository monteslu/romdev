/* ── music_demo.c — hUGEDriver music player demo (GBC) ───────────────
 *
 * Plays the bundled sample_song (see song_data.c) on the GBC APU. The
 * APU is identical between DMG and CGB modes, so the driver code is
 * the same — only the BG-palette path differs (BCPS/BCPD instead of
 * BGP). The .gbc extension flips $0143 = $80 → gambatte boots CGB mode.
 *
 * Driver: compact SDCC-native rewrite of the upstream hUGEDriver
 * interface (https://github.com/SuperDisk/hUGEDriver, public domain).
 *
 * Wiring:
 *   - sound_init()         power-on the APU
 *   - hUGE_init(&song)     load song descriptor
 *   - hUGE_dosound()       advance one tick; call once per vblank
 *
 * Visual: BG palette 0 cycles through 4 colors — purple/blue/green/red —
 * via BCPS/BCPD writes, so the demo is unambiguously CGB-mode visible.
 */

#include "gb_hardware.h"
#include "gb_runtime.h"
#include "hUGEDriver.h"

extern const huge_song_t sample_song;

static const uint16_t bg_colors[4] = {
  0x4210,  /* dim purple */
  0x4308,  /* dim blue   */
  0x0252,  /* dim green  */
  0x0017,  /* dim red    */
};

void main(void) {
  uint8_t  i;
  uint8_t  shade = 0;
  uint16_t frame = 0;

  lcd_init_default();
  sound_init();

  /* Write the initial CGB BG palette 0 (4 entries, same colour). */
  BCPS = 0x80;            /* auto-increment, start at index 0 */
  for (i = 0; i < 4; i++) {
    BCPD = (uint8_t)(bg_colors[shade] & 0xFFu);
    BCPD = (uint8_t)((bg_colors[shade] >> 8) & 0xFFu);
  }

  hUGE_init(&sample_song);

  for (;;) {
    wait_vblank();
    hUGE_dosound();
    frame++;
    if ((frame & 0x3F) == 0) {     /* every 64 frames ≈ 1 s */
      shade = (uint8_t)((shade + 1) & 0x03);
      BCPS = 0x80;
      for (i = 0; i < 4; i++) {
        BCPD = (uint8_t)(bg_colors[shade] & 0xFFu);
        BCPD = (uint8_t)((bg_colors[shade] >> 8) & 0xFFu);
      }
    }
  }
}
