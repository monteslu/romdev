/* c64_sfx.c — SID driver for C64 scaffolds.
 *
 * Three voices, each with:
 *   FREQ_LO/HI   16-bit frequency divider
 *   PW_LO/HI     12-bit pulse width (only relevant for pulse waveform)
 *   CTRL         bit 0  = GATE (1 = note on, 0 = release)
 *                bit 4  = triangle wave
 *                bit 5  = sawtooth
 *                bit 6  = pulse
 *                bit 7  = noise
 *   AD           attack (high nibble) / decay (low nibble), 0..15 each
 *   SR           sustain (high) / release (low), 0..15 each
 *
 * SID_VOL_MODE ($D418):
 *   bits 0..3  master volume 0..15 (15 = full)
 *   (filter bits in 4..7 — not used here)
 *
 * Per-voice "frames-left" counter drives auto-key-off.
 */

#include "c64_sfx.h"
#include "c64_registers.h"

#define POKE(addr, val)  (*(volatile uint8_t*)(addr) = (val))

static uint8_t sfx_remaining[3];
static uint8_t sfx_ctrl[3];   /* the current waveform+gate bits so we can clear GATE on key-off */

void sfx_init(void) {
  uint8_t i;
  /* Master volume = full, no filter. */
  POKE(SID_VOL_MODE, 0x0F);
  /* Clear all voice control registers. */
  for (i = 0; i < 3; i++) {
    POKE(SID_CTRL(i), 0);
    POKE(SID_AD(i), 0);
    POKE(SID_SR(i), 0);
    sfx_remaining[i] = 0;
    sfx_ctrl[i] = 0;
  }
}

void sfx_tone(uint8_t channel, uint8_t freq_lo, uint8_t freq_hi, uint8_t length_frames) {
  uint8_t ctrl;
  if (channel > 2) return;
  POKE(SID_FREQ_LO(channel), freq_lo);
  POKE(SID_FREQ_HI(channel), freq_hi);
  /* Pulse waveform at 50% duty (PW = 0x800). */
  POKE(SID_PW_LO(channel), 0x00);
  POKE(SID_PW_HI(channel), 0x08);
  /* Attack 0, decay 9 — punchy then fades. */
  POKE(SID_AD(channel), 0x09);
  /* Sustain 8/15, release 5/15 — note holds then fades. */
  POKE(SID_SR(channel), 0x85);
  /* Pulse waveform + GATE on. */
  ctrl = SID_PULSE | SID_GATE;
  POKE(SID_CTRL(channel), ctrl);
  sfx_ctrl[channel] = ctrl;
  sfx_remaining[channel] = length_frames;
}

void sfx_noise(uint8_t length_frames) {
  /* Use voice 2 for noise so voice 0/1 can hold tones underneath. */
  POKE(SID_FREQ_LO(2), 0x00);
  POKE(SID_FREQ_HI(2), 0x40);
  POKE(SID_AD(2), 0x09);
  POKE(SID_SR(2), 0x84);
  POKE(SID_CTRL(2), SID_NOISE | SID_GATE);
  sfx_ctrl[2] = SID_NOISE | SID_GATE;
  sfx_remaining[2] = length_frames;
}

void sfx_update(void) {
  uint8_t i;
  for (i = 0; i < 3; i++) {
    if (sfx_remaining[i] > 0) {
      sfx_remaining[i]--;
      if (sfx_remaining[i] == 0) {
        /* Clear GATE — release phase of the ADSR envelope plays. */
        POKE(SID_CTRL(i), sfx_ctrl[i] & ~SID_GATE);
      }
    }
  }
}

void sfx_off(void) {
  uint8_t i;
  for (i = 0; i < 3; i++) {
    POKE(SID_CTRL(i), 0);
    sfx_remaining[i] = 0;
    sfx_ctrl[i] = 0;
  }
  POKE(SID_VOL_MODE, 0);
}
