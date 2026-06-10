/* lynx_sfx.h — minimal Atari Lynx MIKEY sound-effects wrapper.
 *
 * Lynx audio = MIKEY's 4 audio voices ($FD20-$FD3F). Each voice is a
 * linear-feedback shift register (LFSR) producing pulse/tone/noise
 * output, with manual volume, period, and LFSR feedback configuration.
 * No automatic envelope — sfx_update silences after the countdown.
 *
 * Same 5-function cross-platform shape:
 *   sfx_init()
 *   sfx_tone(channel, period, length_frames)
 *   sfx_noise(length_frames)
 *   sfx_update()       — call once per frame DURING VBLANK (mandatory)
 *   sfx_off()
 *
 * channel = 0..3 (4 voices).
 *
 * period is the 8-bit timer reload value. Lower = higher pitch.
 * Hz ≈ 16000000 / 16 / (period+1) / 2.
 *   period =  80  → ~6 kHz (high pew)
 *   period = 160  → ~3 kHz (mid blip)
 *   period = 200  → ~2 kHz (low thump)
 *
 * ─── R57 IMPORTANT — call sfx_update() DURING VBLANK ───────────────
 *
 * sfx_tone / sfx_noise stage their config in shadow RAM and do NOT
 * write to MIKEY hardware until sfx_update() runs. The actual MIKEY
 * writes have to land during vblank because the timer-event
 * rescheduling triggered by writing the voice CTL register (handy's
 * `gNextTimerEvent = NOW` on bit 3 / bit 6) can preempt an in-flight
 * Suzy blit and corrupt the playfield render mid-frame.
 *
 * Canonical loop:
 *
 *   for (;;) {
 *     // ... build frame ...
 *     tgi_updatedisplay();   // waits for vblank, swaps pages
 *     sfx_update();          // ← MIKEY writes happen here (in vblank)
 *
 *     pad = joy_read(JOY_1);
 *     // ... game logic, may call sfx_tone(...) — STAGED only ...
 *   }
 *
 * Round 29 friction reported "audio APIs wedge TGI rendering" —
 * confirmed: pre-R57 sfx_tone wrote MIKEY synchronously which
 * interrupted Suzy blits. The defer-to-update pattern fixes it.
 */

#ifndef LYNX_SFX_H
#define LYNX_SFX_H

#include <stdint.h>

void sfx_init(void);
void sfx_tone(uint8_t channel, uint8_t period, uint8_t length_frames);
void sfx_noise(uint8_t length_frames);
void sfx_update(void);
void sfx_music(uint8_t on);  /* background melody on voice 1 — ON by default; 0 = off */
void sfx_off(void);

#endif
