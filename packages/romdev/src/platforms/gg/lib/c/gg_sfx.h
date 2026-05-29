/* sms_sfx.h — minimal SMS PSG sound-effects wrapper.
 *
 * SMS audio = SN76489 PSG (same chip as Genesis PSG, 4 channels):
 *   ch 0, 1, 2 = square-wave tones
 *   ch 3       = noise
 *
 * Accessed via I/O port $7F (write-only — reads return the H-counter).
 *
 * Same shape as nes_runtime / gb_runtime / gba_sfx / genesis_sfx:
 *
 *   sfx_init()
 *   sfx_tone(channel, freq, length_frames)
 *   sfx_noise(length_frames)
 *   sfx_update()    // call once per frame to tick auto-silence
 *   sfx_off()
 *
 * Game Gear shares the SAME chip + the same port $7F write path,
 * so this wrapper works unchanged on GG. (GG adds a stereo register
 * at port $06 that's optional — we don't touch it.)
 *
 * The PSG has NO automatic envelope. We hand-decrement a per-channel
 * counter and silence on zero — that's what sfx_update does. Forget
 * to call it once per frame and notes ring forever.
 *
 * Frequency on SMS is 10-bit (0..1023). Hz = 3579545 / 32 / freq.
 * Useful values: 200 = high pew, 400 = mid blip, 800 = low thump.
 */

#ifndef SMS_SFX_H
#define SMS_SFX_H

#include <stdint.h>

void sfx_init(void);
void sfx_tone(uint8_t channel, uint16_t freq, uint8_t length_frames);
void sfx_noise(uint8_t length_frames);
void sfx_update(void);
void sfx_off(void);

#endif
