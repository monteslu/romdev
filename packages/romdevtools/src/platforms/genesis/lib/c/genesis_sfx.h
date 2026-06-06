/* ── genesis_sfx.h — minimal Genesis PSG sound-effects wrapper ──────
 *
 * Thin wrapper around SGDK's PSG API (SN76489) to match the NES/GB/GBA
 * scaffold sound shape — sfx_init + sfx_tone + sfx_noise + sfx_update.
 *
 * Channel layout (PSG = 4 channels):
 *   0, 1, 2 = square-wave tones (use sfx_tone)
 *   3       = noise              (use sfx_noise)
 *
 * The PSG has NO automatic envelope. Real games drive envelopes by
 * writing the envelope register each frame. This wrapper auto-silences
 * a channel after `length_frames` frames — but you MUST call
 * `sfx_update()` once per frame in your main loop for that to work.
 * Forget it and notes ring forever.
 *
 * The YM2612 FM synth (the other half of Genesis audio) is NOT wrapped.
 * For FM music + samples, use SGDK's XGM2 driver with a .xgm asset.
 */

#ifndef GENESIS_SFX_H
#define GENESIS_SFX_H

#include <types.h>

/* Call once near the start of main() before any sfx_*. */
void sfx_init(void);

/* Play a square-wave tone.
 *   channel: 0, 1, or 2 (3 is noise — use sfx_noise instead)
 *   freq:    PSG 10-bit tone divider. Hz = 3579545 / (32 * freq).
 *            Try 200 = high pew, 400 = mid blip, 800 = low thump.
 *   length_frames: 1..127. Auto-silences after this many frames
 *                  IF sfx_update() is called once per frame.
 */
void sfx_tone(u8 channel, u16 freq, u8 length_frames);

/* Play a noise burst on channel 3.
 *   length_frames: 1..127 (same auto-silence rule as sfx_tone). */
void sfx_noise(u8 length_frames);

/* Call once per frame (right before or after SYS_doVBlankProcess) to
 * decrement the auto-silence countdown. Without this, notes never
 * stop ringing. */
void sfx_update(void);

/* Power down all PSG channels immediately. */
void sfx_off(void);

#endif
