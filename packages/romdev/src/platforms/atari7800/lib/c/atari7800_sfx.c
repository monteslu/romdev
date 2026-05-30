/* atari7800_sfx.c — TIA audio driver for Atari 7800 scaffolds.
 *
 * TIA audio register layout:
 *   $15 AUDC0   channel 0 waveform/distortion (0..15)
 *   $16 AUDC1   channel 1 waveform/distortion
 *   $17 AUDF0   channel 0 frequency divider (0..31, lower = higher pitch)
 *   $18 AUDF1   channel 1 frequency divider
 *   $19 AUDV0   channel 0 volume (0..15)
 *   $1A AUDV1   channel 1 volume
 *
 * Per-channel "frames-left" counter drives auto-silence in sfx_update.
 * Without sfx_update() the volume stays set and notes ring forever.
 */

#include "atari7800_sfx.h"

#define AUDC0  (*(volatile uint8_t*)0x15)
#define AUDC1  (*(volatile uint8_t*)0x16)
#define AUDF0  (*(volatile uint8_t*)0x17)
#define AUDF1  (*(volatile uint8_t*)0x18)
#define AUDV0  (*(volatile uint8_t*)0x19)
#define AUDV1  (*(volatile uint8_t*)0x1A)

static uint8_t sfx_remaining[2];

void sfx_init(void) {
  AUDC0 = 0; AUDC1 = 0;
  AUDF0 = 0; AUDF1 = 0;
  AUDV0 = 0; AUDV1 = 0;
  sfx_remaining[0] = 0;
  sfx_remaining[1] = 0;
}

void sfx_tone(uint8_t channel, uint8_t freq, uint8_t length_frames) {
  if (channel == 0) {
    AUDC0 = 4;             /* pure tone */
    AUDF0 = freq & 0x1F;   /* 5-bit divider */
    AUDV0 = 15;            /* max vol */
    sfx_remaining[0] = length_frames;
  } else if (channel == 1) {
    AUDC1 = 4;
    AUDF1 = freq & 0x1F;
    AUDV1 = 15;
    sfx_remaining[1] = length_frames;
  }
}

void sfx_noise(uint8_t length_frames) {
  /* White noise on channel 1 so an in-flight tone on ch 0 isn't
   * interrupted. Distortion mode 8 = white-noise-ish. */
  AUDC1 = 8;
  AUDF1 = 8;
  AUDV1 = 15;
  sfx_remaining[1] = length_frames;
}

void sfx_update(void) {
  uint8_t i;
  for (i = 0; i < 2; i++) {
    if (sfx_remaining[i] > 0) {
      sfx_remaining[i]--;
      if (sfx_remaining[i] == 0) {
        if (i == 0) AUDV0 = 0;
        else        AUDV1 = 0;
      }
    }
  }
}

void sfx_off(void) {
  AUDV0 = 0; AUDV1 = 0;
  sfx_remaining[0] = 0;
  sfx_remaining[1] = 0;
}
