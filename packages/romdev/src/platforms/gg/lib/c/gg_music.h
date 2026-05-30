/* gg_music.h — minimal Game Gear PSG music engine.
 *
 * Companion to gg_sfx (sfx wrapper). Where sfx_tone() plays a single
 * fire-and-forget tone with a countdown, music_play() runs an entire
 * hand-authored song on a dedicated PSG channel, advancing one note
 * per call to music_update() (call once per frame, 60 Hz).
 *
 * Same SN76489 PSG chip + same I/O port ($7F) as SMS, so the protocol
 * is identical — only difference vs the (parallel) SMS driver is the
 * file name. We intentionally keep gg_music/sms_music independent (no
 * shared common-z80 lib), matching the existing gg_sfx / sms_sfx /
 * genesis_sfx split. If somebody later wants to consolidate they can
 * lift the byte-identical bits into a common file.
 *
 * Song format — see gg_music.c for the full breakdown. TL;DR each row
 * is a (note, duration_frames) pair stored as 10-bit PSG freq divider
 * and an 8-bit frame count. Duration 0 = end-of-song sentinel; the
 * engine then either stops (one-shot) or restarts the song (loop).
 *
 *   music_init();                  // silence music channel
 *   music_play(0);                 // start song 0 on the music channel
 *   for (;;) {
 *     gg_vblank_wait();
 *     music_update();              // advance one frame of music
 *   }
 *
 * The engine uses PSG channel 2 by default (leaves ch 0/1 free for
 * gg_sfx tones and ch 3 for noise). Change MUSIC_CHANNEL in gg_music.c
 * if you want a different one.
 *
 * Frequencies are pre-baked SN76489 register values (0..1023), NOT Hz,
 * so the note table is exactly what the chip latches. The header below
 * exposes the standard NOTE_* defines so songs can read as music.
 */

#ifndef GG_MUSIC_H
#define GG_MUSIC_H

#include <stdint.h>

/* One row of a song. Note 0 + dur 0 = end sentinel. */
typedef struct {
  uint16_t note;   /* SN76489 10-bit freq divider, or 0 for rest */
  uint8_t  dur;    /* duration in frames (60 Hz); 0 = end-of-song */
} music_note_t;

typedef struct {
  const music_note_t *notes;
  uint8_t loop;    /* 0 = one-shot, 1 = loop forever */
} music_song_t;

void music_init(void);
void music_play(uint8_t song_idx);
void music_stop(void);
void music_update(void);

/* Number of songs in the bundled bank (see gg_music.c). */
extern const uint8_t music_song_count;

/* ── SN76489 note table (10-bit freq dividers @ ~3.58 MHz) ────────
 * Formula: divider = 3579545 / (32 * Hz). Higher divider = lower pitch.
 * Octave indices roughly cover C3..C6 — comfortable handheld range.
 */
#define NOTE_REST 0

#define NOTE_C3   855  /* 130.81 Hz */
#define NOTE_D3   762
#define NOTE_E3   679
#define NOTE_F3   641
#define NOTE_G3   571
#define NOTE_A3   509
#define NOTE_B3   453
#define NOTE_C4   428  /* 261.63 Hz — middle C */
#define NOTE_D4   381
#define NOTE_E4   339
#define NOTE_F4   320
#define NOTE_G4   285
#define NOTE_A4   254  /* 440 Hz concert A */
#define NOTE_B4   226
#define NOTE_C5   214
#define NOTE_D5   190
#define NOTE_E5   170
#define NOTE_F5   160
#define NOTE_G5   142
#define NOTE_A5   127
#define NOTE_B5   113
#define NOTE_C6   107

#endif
