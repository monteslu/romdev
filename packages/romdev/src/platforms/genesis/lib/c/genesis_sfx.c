/* ── genesis_sfx.c — minimal Genesis PSG sound-effects wrapper ──────
 *
 * SGDK's PSG_* helpers do the byte-twiddling. We add:
 *   - 4-channel per-channel "frames-left" countdown
 *   - sfx_update() to tick it each frame and silence on zero
 */

#include "genesis_sfx.h"
#include <psg.h>

/* Frames remaining before each channel auto-silences. */
static u8 sfx_remaining[4];

void sfx_init(void) {
    PSG_reset();
    for (u8 i = 0; i < 4; i++) {
        sfx_remaining[i] = 0;
        PSG_setEnvelope(i, PSG_ENVELOPE_MIN);  /* PSG_ENVELOPE_MIN = 15 = silent */
    }
}

void sfx_tone(u8 channel, u16 freq, u8 length_frames) {
    if (channel > 2) return;
    PSG_setFrequency(channel, freq);
    PSG_setEnvelope(channel, PSG_ENVELOPE_MAX);   /* MAX = 0 = loudest */
    sfx_remaining[channel] = length_frames;
}

void sfx_noise(u8 length_frames) {
    PSG_setNoise(PSG_NOISE_TYPE_WHITE, PSG_NOISE_FREQ_CLOCK4);
    PSG_setEnvelope(3, PSG_ENVELOPE_MAX);
    sfx_remaining[3] = length_frames;
}

void sfx_update(void) {
    for (u8 i = 0; i < 4; i++) {
        if (sfx_remaining[i] > 0) {
            sfx_remaining[i]--;
            if (sfx_remaining[i] == 0) {
                PSG_setEnvelope(i, PSG_ENVELOPE_MIN);
            }
        }
    }
}

void sfx_off(void) {
    for (u8 i = 0; i < 4; i++) {
        PSG_setEnvelope(i, PSG_ENVELOPE_MIN);
        sfx_remaining[i] = 0;
    }
}
