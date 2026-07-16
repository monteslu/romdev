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

/* ── background music: a 16-step melody loop on PSG channel 2 ───────
 * Ticked from sfx_update(), so every scaffold that already calls
 * sfx_init() + sfx_update() gets continuous music for free ("no sound"
 * was the #1 playtest complaint — a lone 6-frame blip on a rare event
 * reads as silence). sfx_music(0) turns it off. SFX own channels 0-1 +
 * noise, so effects always cut through. */
static const u16 music_hz[16] = {
    262, 330, 392, 523, 392, 330, 262, 0,     /* C4 E4 G4 C5 G4 E4 C4 -  */
    220, 262, 330, 440, 330, 262, 220, 0,     /* A3 C4 E4 A4 E4 C4 A3 -  */
};
static u8 music_enabled = 1;
static u8 music_step, music_timer;

void sfx_music(u8 on) {
    music_enabled = on;
    music_step = 0;
    music_timer = 0;
    if (!on) PSG_setEnvelope(2, PSG_ENVELOPE_MIN);
}

static void music_tick(void) {
    if (!music_enabled) return;
    if (music_timer == 0) {
        u16 hz = music_hz[music_step & 15];
        if (hz) {
            PSG_setFrequency(2, hz);
            PSG_setEnvelope(2, 5);            /* moderate, under the SFX */
        } else {
            PSG_setEnvelope(2, PSG_ENVELOPE_MIN);
        }
        music_step++;
    }
    music_timer++;
    if (music_timer >= 9) music_timer = 0;    /* ~6.6 notes/sec */
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
    music_tick();
}

void sfx_off(void) {
    for (u8 i = 0; i < 4; i++) {
        PSG_setEnvelope(i, PSG_ENVELOPE_MIN);
        sfx_remaining[i] = 0;
    }
}
