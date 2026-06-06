/* c64_sfx.h — minimal C64 SID sound-effects wrapper.
 *
 * SID = Sound Interface Device. The legendary C64 audio chip, 3 voices,
 * 4 waveforms (triangle/sawtooth/pulse/noise), per-voice ADSR
 * envelope, and a programmable filter. Sounds amazing when used well;
 * this scaffold wrapper uses the basics.
 *
 * Same 5-function cross-platform shape:
 *   sfx_init()
 *   sfx_tone(channel, freq_lo, freq_hi, length_frames)   — pulse wave
 *   sfx_noise(length_frames)                              — voice 2 noise
 *   sfx_update()                                          — call once per frame
 *   sfx_off()
 *
 * channel = 0, 1, or 2 (SID has 3 voices).
 *
 * Frequency is a 16-bit divider:
 *   Hz = (freq * 0.0596) for PAL, or (freq * 0.0596) for NTSC.
 *   Useful values: 0x1000 ≈ middle range, 0x2000 ≈ higher, 0x0800 ≈ low.
 *
 * The SID has REAL ADSR — sfx_tone sets a sensible default (fast attack,
 * mid release) so the note has shape. sfx_update keys-off (clears GATE)
 * when the countdown hits 0, letting the release tail play.
 */

#ifndef C64_SFX_H
#define C64_SFX_H

#include <stdint.h>

void sfx_init(void);
void sfx_tone(uint8_t channel, uint8_t freq_lo, uint8_t freq_hi, uint8_t length_frames);
void sfx_noise(uint8_t length_frames);
void sfx_update(void);
void sfx_off(void);

#endif
