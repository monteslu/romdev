/* atari7800_sfx.h — minimal Atari 7800 TIA sound-effects wrapper.
 *
 * The 7800 inherits the 2600's TIA audio chip (the MARIA video chip
 * is the 7800-specific upgrade). TIA audio = 2 independent voices:
 *
 *   AUDC0/1  ($15/$16) — waveform/distortion (0..15)
 *     Useful values:
 *       1  = pure  (4-bit poly, sounds buzzy)
 *       4  = pure tone (5-bit poly)
 *       6  = pure tone (div-by-31)
 *       8  = white noise
 *      12  = pure tone (LFSR)
 *      15  = noise (lowest pitch)
 *   AUDF0/1  ($17/$18) — frequency divider (0..31). Lower = higher pitch.
 *   AUDV0/1  ($19/$1A) — volume (0..15). 0 = silent.
 *
 * Same 5-function shape as nes_runtime / gb_runtime / gba_sfx /
 * genesis_sfx / sms_sfx / gg_sfx:
 *
 *   sfx_init()
 *   sfx_tone(channel, freq, length_frames)
 *   sfx_noise(length_frames)
 *   sfx_update()       — call once per frame
 *   sfx_off()
 *
 * channel = 0 or 1 for sfx_tone (only 2 voices). sfx_noise always
 * uses channel 1 so channel 0 can keep playing a tone underneath.
 *
 * Notes: 7800 has an optional cartridge-side POKEY chip with 4 more
 * voices, but most carts didn't ship with POKEY. This wrapper uses
 * TIA-only so it works on every 7800.
 */

#ifndef ATARI7800_SFX_H
#define ATARI7800_SFX_H

#include <stdint.h>

void sfx_init(void);
void sfx_tone(uint8_t channel, uint8_t freq, uint8_t length_frames);
void sfx_noise(uint8_t length_frames);
void sfx_update(void);
void sfx_off(void);

#endif
