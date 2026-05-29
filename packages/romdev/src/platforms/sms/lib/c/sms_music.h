/* sms_music.h — tiny 3-voice tracker for the SMS SN76489 PSG.
 *
 * Sits on top of sms_sfx.{h,c}'s raw PSG write path. The "song" is a
 * pair of parallel arrays: a list of (divider, duration_frames) events
 * per voice, played back step-by-step. When the per-voice cursor hits
 * the end of its track it loops back to step 0 — instant continuous
 * music with no need for an asset pipeline.
 *
 * Three tone voices (ch 0/1/2). The noise channel (ch 3) is left alone
 * so a game's sfx layer can keep using sfx_noise for hit/explosion FX.
 *
 * SN76489 frequency divider math (NTSC SMS):
 *   Hz = 3579545 / 32 / divider     →    divider = 111861 / Hz
 *
 *   note    Hz       divider
 *   C3      130.81   855
 *   G3      196.00   570
 *   C4      261.63   427
 *   D4      293.66   381
 *   E4      329.63   339
 *   F4      349.23   320
 *   G4      392.00   285
 *   A4      440.00   254
 *   B4      493.88   226
 *   C5      523.25   214
 *
 * Use divider 0 to mean "rest" — the driver skips the PSG write and
 * just counts the duration down before advancing to the next step.
 *
 * API mirrors sfx_*:
 *
 *   music_init()              — clear state, silence tone channels
 *   music_play(song_idx)      — start playback at song step 0
 *                               (song_idx reserved for future multi-song
 *                                 banks; current build has one song)
 *   music_update()            — call ONCE per frame from the vblank loop
 *   music_stop()              — silence the 3 tone channels, halt playback
 */

#ifndef SMS_MUSIC_H
#define SMS_MUSIC_H

#include <stdint.h>

void music_init(void);
void music_play(uint8_t song_idx);
void music_update(void);
void music_stop(void);

#endif
