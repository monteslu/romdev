/* atari7800_music.c — 2-voice TIA music driver for Atari 7800.
 *
 * TIA audio register layout (same as atari7800_sfx.c):
 *   $15 AUDC0 / $16 AUDC1 — waveform/distortion (0..15)
 *   $17 AUDF0 / $18 AUDF1 — frequency divider (0..31, lower = higher pitch)
 *   $19 AUDV0 / $1A AUDV1 — volume (0..15)
 *
 * Distortion modes used here:
 *   4  = pure tone via 5-bit polynomial — used for both melody and bass
 *   6  = pure tone (div-by-31), lower-pitched character — used for bass
 *        so the two voices have distinct timbres even when their AUDF
 *        values overlap (TIA's 5-bit divider gives only 32 pitches).
 *
 * Pitch picks: AUDF=4..30. Lower = higher pitch. The "tonic" of the
 * melody hook sits around AUDF=12, the octave-up around AUDF=6.
 * Bass walks an octave below the melody (AUDF=24/18 range).
 *
 * Each table entry is 3 bytes: { distortion, freq, frames }. The trailing
 * sentinel is { 0, 0, 0 } — the player wraps to index 0 when it sees
 * frames==0 OR when it runs past the table end (frames==0 doubles as
 * "end of song"). Each voice loops independently.
 *
 * @60Hz, 30 frames = 0.5s = one quarter note at 120 BPM. The melody uses
 * 15-frame eighths and 30-frame quarters; the bass uses 60-frame halves
 * for a walking quarter-note feel (60-frame note at 120BPM = a half).
 */

#include "atari7800_music.h"

#define AUDC0  (*(volatile uint8_t*)0x15)
#define AUDC1  (*(volatile uint8_t*)0x16)
#define AUDF0  (*(volatile uint8_t*)0x17)
#define AUDF1  (*(volatile uint8_t*)0x18)
#define AUDV0  (*(volatile uint8_t*)0x19)
#define AUDV1  (*(volatile uint8_t*)0x1A)

/* Pitch shorthand (AUDF values, picked by ear on TIA distortion 4).
 * These aren't equal-tempered — TIA can't be — but they're audibly
 * distinct and form a usable "scale". */
#define M_DO_HI  6
#define M_TI     7
#define M_LA     8
#define M_SOL    9
#define M_FA     10
#define M_MI     12
#define M_RE     14
#define M_DO     15

/* Bass an octave down (distortion mode 6 for timbre contrast). */
#define B_DO     30
#define B_SOL    20
#define B_FA     25
#define B_LA     18

/* Note tables. Format: distortion, freq, frames. The note tables ARE
 * the song; edit them to re-compose. */

/* Melody: 4-bar arpeggio hook (do-mi-sol-do-mi-do-sol-mi) twice, then
 * a descending walk (do-ti-la-sol-fa-mi-re-do), then repeat with the
 * arpeggio shifted up an octave. ~48 notes. */
static const uint8_t melody_notes[] = {
  /* bar 1: do mi sol do (octave up) */
  4, M_DO,    15,
  4, M_MI,    15,
  4, M_SOL,   15,
  4, M_DO_HI, 15,
  /* bar 2: mi sol mi do */
  4, M_MI,    15,
  4, M_SOL,   15,
  4, M_MI,    15,
  4, M_DO,    15,
  /* bar 3: sol mi do mi */
  4, M_SOL,   15,
  4, M_MI,    15,
  4, M_DO,    15,
  4, M_MI,    15,
  /* bar 4: sol do (octave-up) sol mi */
  4, M_SOL,   15,
  4, M_DO_HI, 15,
  4, M_SOL,   15,
  4, M_MI,    15,
  /* bar 5: descending walk */
  4, M_DO_HI, 15,
  4, M_TI,    15,
  4, M_LA,    15,
  4, M_SOL,   15,
  /* bar 6: continue walk */
  4, M_FA,    15,
  4, M_MI,    15,
  4, M_RE,    15,
  4, M_DO,    30,
  /* bar 7: octave-up arpeggio */
  4, M_DO_HI, 15,
  4, M_SOL,   15,
  4, M_MI,    15,
  4, M_SOL,   15,
  /* bar 8: cadence */
  4, M_DO_HI, 15,
  4, M_SOL,   15,
  4, M_MI,    15,
  4, M_DO,    30,
  /* bar 9-12: repeat arpeggio + variation */
  4, M_DO,    15,
  4, M_MI,    15,
  4, M_SOL,   15,
  4, M_DO_HI, 15,
  4, M_SOL,   15,
  4, M_MI,    15,
  4, M_DO,    15,
  4, M_MI,    15,
  4, M_FA,    15,
  4, M_LA,    15,
  4, M_FA,    15,
  4, M_MI,    15,
  4, M_RE,    15,
  4, M_MI,    15,
  4, M_DO,    15,
  4, M_DO,    30,
  0, 0,        0    /* sentinel — loop */
};

/* Bass: walking quarter-notes following a do-do-sol-sol / do-do-fa-sol
 * I-V-IV-V style pattern. Each entry is a half-note @ 60 frames so the
 * melody plays ~4 eighths per bass note. ~16 notes. */
static const uint8_t bass_notes[] = {
  6, B_DO,  60,
  6, B_DO,  60,
  6, B_SOL, 60,
  6, B_SOL, 60,
  6, B_FA,  60,
  6, B_FA,  60,
  6, B_SOL, 60,
  6, B_DO,  60,
  6, B_DO,  60,
  6, B_LA,  60,
  6, B_FA,  60,
  6, B_FA,  60,
  6, B_SOL, 60,
  6, B_SOL, 60,
  6, B_DO,  60,
  6, B_DO,  60,
  0, 0,      0    /* sentinel — loop */
};

/* Per-voice playback state. */
static uint16_t mel_idx;
static uint16_t bass_idx;
static uint8_t  mel_frames_left;
static uint8_t  bass_frames_left;

static void start_melody_note(void) {
  uint8_t c = melody_notes[mel_idx];
  uint8_t f = melody_notes[mel_idx + 1];
  uint8_t l = melody_notes[mel_idx + 2];
  if (l == 0) {           /* sentinel — loop back to start */
    mel_idx = 0;
    c = melody_notes[0];
    f = melody_notes[1];
    l = melody_notes[2];
  }
  AUDC0 = c;
  AUDF0 = f & 0x1F;
  AUDV0 = 12;             /* slightly less than max so 2 voices don't clip */
  mel_frames_left = l;
}

static void start_bass_note(void) {
  uint8_t c = bass_notes[bass_idx];
  uint8_t f = bass_notes[bass_idx + 1];
  uint8_t l = bass_notes[bass_idx + 2];
  if (l == 0) {
    bass_idx = 0;
    c = bass_notes[0];
    f = bass_notes[1];
    l = bass_notes[2];
  }
  AUDC1 = c;
  AUDF1 = f & 0x1F;
  AUDV1 = 10;             /* bass a touch quieter than melody */
  bass_frames_left = l;
}

void music_init(void) {
  AUDC0 = 0; AUDC1 = 0;
  AUDF0 = 0; AUDF1 = 0;
  AUDV0 = 0; AUDV1 = 0;
  mel_idx = 0;
  bass_idx = 0;
  mel_frames_left = 0;
  bass_frames_left = 0;
}

void music_play(void) {
  mel_idx = 0;
  bass_idx = 0;
  start_melody_note();
  start_bass_note();
}

void music_update(void) {
  if (mel_frames_left > 0) {
    mel_frames_left--;
    if (mel_frames_left == 0) {
      mel_idx += 3;
      start_melody_note();
    }
  }
  if (bass_frames_left > 0) {
    bass_frames_left--;
    if (bass_frames_left == 0) {
      bass_idx += 3;
      start_bass_note();
    }
  }
}
