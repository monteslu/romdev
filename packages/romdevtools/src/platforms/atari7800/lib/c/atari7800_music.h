/* atari7800_music.h — 2-voice TIA music engine for Atari 7800.
 *
 * Pairs with atari7800_sfx (same TIA registers) but is a *song player*,
 * not a one-shot fx wrapper. Two parallel note tables (melody on voice 0,
 * bass on voice 1) drive the chip per-frame. The note tables ARE the song;
 * editing them re-composes the tune.
 *
 *   music_init()    — silences both TIA voices, resets cursors
 *   music_play()    — restart playback from index 0 on both voices
 *   music_update()  — call once per frame (after vblank_wait). Each voice
 *                     independently counts down its current note's
 *                     frames-left; when it hits 0, advance to the next
 *                     note in that voice's table (wrapping at the end so
 *                     the song loops forever).
 *
 * TIA's frequency divider is only 5 bits (0..31), so the available pitch
 * set is small and the song sounds primitive. Goal here is "music plays
 * + you can hear melody-vs-bass" not "good music".
 *
 * Each note is a triple { AUDC distortion, AUDF frequency, length_frames }.
 * The note tables live in the .c file so the source IS the song.
 */

#ifndef ATARI7800_MUSIC_H
#define ATARI7800_MUSIC_H

#include <stdint.h>

void music_init(void);
void music_play(void);
void music_update(void);

#endif
