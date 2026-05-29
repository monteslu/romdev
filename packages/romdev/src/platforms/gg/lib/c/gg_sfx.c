/* sms_sfx.c — SN76489 PSG driver for SMS / Game Gear.
 *
 * SN76489 latch protocol (write-only via port $7F):
 *   Latch byte (bit 7 = 1):
 *     bit 7    = 1 (latch)
 *     bits 6-5 = channel (00=ch0, 01=ch1, 10=ch2, 11=ch3-noise)
 *     bit 4    = 0 (frequency) | 1 (volume/attenuation)
 *     bits 3-0 = low 4 bits of frequency, OR 4-bit attenuation (0=loud, 15=silent)
 *   Data byte (bit 7 = 0):
 *     bits 5-0 = high 6 bits of frequency
 *
 * To play a tone:
 *   1. Latch: $80|chan<<5|0|(freq & 0x0F)
 *   2. Data:  (freq >> 4) & 0x3F
 *   3. Latch volume: $90|chan<<5|attenuation
 *
 * Noise uses a different latch (low 3 bits select shift rate / source):
 *   $E0 | (mode_bit << 2) | rate
 *   rate 0=clock/512, 1=clock/1024, 2=clock/2048, 3=use ch2 freq
 *
 * Attenuation is in 2 dB steps: 0=loudest, 15=off.
 *
 * Per-channel "frames-left" countdown drives auto-silence. sfx_update
 * runs once per frame and silences a channel whose counter hits 0.
 */

#include "gg_sfx.h"
#include "gg_hw.h"

static uint8_t sfx_remaining[4];

static void psg_write(uint8_t b) {
  PORT_H_COUNTER = b;            /* port $7F is the PSG write port */
}

void sfx_init(void) {
  uint8_t i;
  for (i = 0; i < 4; i++) {
    sfx_remaining[i] = 0;
    /* Silence channel i (latch volume = 0xF = off). */
    psg_write(0x90 | (i << 5) | 0x0F);
  }
}

void sfx_tone(uint8_t channel, uint16_t freq, uint8_t length_frames) {
  if (channel > 2) return;
  /* Latch + data byte for frequency. */
  psg_write(0x80 | (channel << 5) | (freq & 0x0F));
  psg_write((freq >> 4) & 0x3F);
  /* Volume at max (attenuation 0). */
  psg_write(0x90 | (channel << 5) | 0x00);
  sfx_remaining[channel] = length_frames;
}

void sfx_noise(uint8_t length_frames) {
  /* White noise, rate = clock/1024 (mid frequency). */
  psg_write(0xE0 | 0x04 | 0x01);
  /* Volume at max (channel 3 attenuation = 0). */
  psg_write(0xF0);
  sfx_remaining[3] = length_frames;
}

void sfx_update(void) {
  uint8_t i;
  for (i = 0; i < 4; i++) {
    if (sfx_remaining[i] > 0) {
      sfx_remaining[i]--;
      if (sfx_remaining[i] == 0) {
        /* Silence channel i. */
        psg_write(0x90 | (i << 5) | 0x0F);
      }
    }
  }
}

void sfx_off(void) {
  uint8_t i;
  for (i = 0; i < 4; i++) {
    psg_write(0x90 | (i << 5) | 0x0F);
    sfx_remaining[i] = 0;
  }
}
