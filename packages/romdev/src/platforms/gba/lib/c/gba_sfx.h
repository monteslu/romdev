/* ── gba_sfx.h — minimal GBA sound-effects wrapper ──────────────────
 *
 * Thin DMG-compatible APU wrapper for the GBA's 4 PSG channels. Mirrors
 * the NES/GB scaffold pattern (sound_init + sound_play_tone + ...) so
 * cross-platform scaffolds feel the same.
 *
 * Channel layout:
 *   1, 2 = square waves (use sfx_tone)
 *   4    = white noise   (use sfx_noise)
 *
 * Channel 3 (wave RAM) is not wrapped — it needs a user-supplied wave
 * table. Direct Sound (PCM via DMA) is also not wrapped — that needs a
 * timer + DMA setup + a sample buffer; out of scope for an sfx helper.
 *
 * All functions are non-blocking — they trigger the channel and return
 * immediately. The hardware countdowns the length and silences the
 * channel on its own. Calling sfx_tone again before the countdown
 * finishes re-triggers (cuts the previous note).
 */

#ifndef GBA_SFX_H
#define GBA_SFX_H

#include <tonc_types.h>

/* Call once near the start of main() before any sfx_*. Powers up the
 * APU and routes all 4 channels at full volume to both speakers. */
void sfx_init(void);

/* Play a square-wave tone.
 *   channel: 1 or 2 (others ignored)
 *   freq_period: GBA 11-bit frequency code (lower=higher pitch).
 *                Hz ≈ 131072 / (2048 - freq_period).
 *                Useful range: 700..1900. Try 1900 for "pew",
 *                1300 for "blip", 700 for "low thump".
 *   length_frames: 1..63, scaled to GBA's 64-step length countdown
 *                  (~3.9ms each, so 16 frames ≈ 62ms).
 */
void sfx_tone(u8 channel, u16 freq_period, u8 length_frames);

/* Play a noise burst on channel 4.
 *   length_frames: 1..63 (same scaling as sfx_tone). */
void sfx_noise(u8 length_frames);

/* Power down the APU. */
void sfx_off(void);

#endif
