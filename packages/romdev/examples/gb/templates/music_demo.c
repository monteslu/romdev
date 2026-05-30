/* ── music_demo.c — hUGEDriver music player demo (GB) ────────────────
 *
 * Plays the bundled sample_song (see song_data.c) on the GB APU.
 *
 * The driver shipped here is a compact SDCC-native music player whose
 * function surface (hUGE_init / hUGE_dosound) matches the upstream
 * hUGEDriver project (https://github.com/SuperDisk/hUGEDriver, public
 * domain). The upstream RGBDS asm source is bundled in source-visible
 * form as `hUGEDriver.upstream.asm` so an agent can later port to it.
 *
 * Wiring:
 *   - sound_init()         power-on the APU (NR52 master enable)
 *   - hUGE_init(&song)     load the song descriptor
 *   - hUGE_dosound()       advance one tick; call once per vblank
 *
 * What you should hear: a short looping 4-pattern, two-channel tune in
 * C-major. Melody on CH1 (square 1), bass on CH2 (square 2). Drops
 * back to the start of the song after ~8 seconds.
 *
 * Visual: BGP cycles through 4 shades so you can also SEE the driver
 * is alive even if you have audio muted in your emulator.
 */

#include "gb_hardware.h"
#include "gb_runtime.h"
#include "hUGEDriver.h"

/* The song descriptor is defined in song_data.c (linked in by the
 * project template). */
extern const huge_song_t sample_song;

void main(void) {
  uint8_t  shade = 0;
  uint16_t frame = 0;

  lcd_init_default();
  sound_init();

  hUGE_init(&sample_song);

  for (;;) {
    wait_vblank();
    hUGE_dosound();         /* one driver tick per frame */
    frame++;
    if ((frame & 0x1F) == 0) {
      shade = (uint8_t)((shade + 1) & 0x03);
      /* DMG palette cycle — every 32 frames shift the BG shade.
       * On GBC this writes through to the legacy DMG-compat palette. */
      BGP = (uint8_t)(0xE4u ^ (uint8_t)(shade * 0x55u));
    }
  }
}
