/* c64_music.h — tiny per-frame SID music driver for C64 scaffolds.
 *
 * 3-voice continuous music player on top of the SID. The note table IS
 * the song — open this file's .c sibling to see and edit the tune.
 *
 * NOT a .sid player (those need reSID-class emulation of a 6502 sub-
 * program). This is a plain frame-tick sequencer: each voice walks a
 * parallel array of (freq, length_frames) pairs and writes SID registers
 * on note transitions. Lightweight, source-visible, perfect for a
 * scaffold "music_demo".
 *
 * Wire it up:
 *   music_init()       — set master vol + ADSR for all 3 voices
 *   music_play()       — reset song position to 0 (begin playback)
 *   music_update()     — call once per frame from your main loop
 *   music_stop()       — clear gates + silence
 *
 * The track loops indefinitely; each voice can have its own length so
 * polyphony stays interesting.
 */

#ifndef C64_MUSIC_H
#define C64_MUSIC_H

#include <stdint.h>

void music_init(void);
void music_play(void);
void music_update(void);
void music_stop(void);

/* Returns 0..255 — a frame counter useful for sync (e.g. flash colors
 * on the beat). Wraps freely. */
uint8_t music_tick(void);

#endif
