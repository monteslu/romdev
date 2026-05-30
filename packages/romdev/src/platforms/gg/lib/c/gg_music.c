/* gg_music.c — Game Gear SN76489 PSG music driver.
 *
 * Plays a hand-authored note table on a dedicated PSG channel, one note
 * per frame-tick. Companion to gg_sfx (which keeps ch 0/1 free for
 * fire-and-forget sound effects and ch 3 for noise — we own ch 2).
 *
 * Protocol recap (port $7F, write-only):
 *   Tone latch: bit7=1, bits6-5=channel, bit4=0, bits3-0=freq_low
 *   Tone data : bit7=0, bits5-0=freq_high
 *   Vol  latch: bit7=1, bits6-5=channel, bit4=1, bits3-0=attenuation
 *
 * Attenuation: 0=loudest, 15=silent (2 dB steps).
 *
 * Song table format (see gg_music.h music_note_t):
 *   - .note = 10-bit PSG divider (0 = rest), .dur = frame count
 *   - sentinel row {0, 0} marks end-of-song
 *
 * The note table IS the song — no compression, no compiler — you can
 * read the melody right in this file. Add or edit songs by appending
 * a music_note_t[] array and bumping music_song_count.
 */

#include "gg_music.h"
#include "gg_hw.h"

#define MUSIC_CHANNEL 2  /* PSG ch 2 — ch 0/1 reserved for gg_sfx */
#define MUSIC_VOLUME  3  /* attenuation; lower = louder, 3 ≈ -6 dB */

static void psg_write(uint8_t b) {
  PORT_H_COUNTER = b;            /* port $7F = PSG write port */
}

static void psg_set_tone(uint8_t ch, uint16_t freq) {
  /* Two-byte latch+data for tone frequency. */
  psg_write((uint8_t)(0x80 | (ch << 5) | (freq & 0x0F)));
  psg_write((uint8_t)((freq >> 4) & 0x3F));
}

static void psg_set_attn(uint8_t ch, uint8_t attn) {
  psg_write((uint8_t)(0x90 | (ch << 5) | (attn & 0x0F)));
}

/* ── Song 0: arpeggiated C-major motif ─────────────────────────────
 * Source-visible: this IS the song. Each row = one note (or rest)
 * and how many 60Hz frames to hold it. 30 frames = 0.5 s.
 * Pattern: C major chord arpeggio up + down, then a melodic flourish.
 */
static const music_note_t song0[] = {
  { NOTE_C4, 18 }, { NOTE_E4, 18 }, { NOTE_G4, 18 }, { NOTE_C5, 36 },
  { NOTE_G4, 18 }, { NOTE_E4, 18 }, { NOTE_C4, 36 },
  { NOTE_REST, 12 },
  { NOTE_D4, 18 }, { NOTE_F4, 18 }, { NOTE_A4, 18 }, { NOTE_D5, 36 },
  { NOTE_A4, 18 }, { NOTE_F4, 18 }, { NOTE_D4, 36 },
  { NOTE_REST, 18 },
  /* Melodic flourish — "shave and a haircut" feel */
  { NOTE_G4, 18 }, { NOTE_C5, 18 }, { NOTE_C5, 18 },
  { NOTE_D5, 18 }, { NOTE_C5, 36 }, { NOTE_REST, 12 },
  { NOTE_E5, 18 }, { NOTE_C5, 36 },
  { 0, 0 }, /* end-of-song sentinel */
};

/* ── Song 1: minor / spooky arpeggio (A minor) ────────────────────── */
static const music_note_t song1[] = {
  { NOTE_A3, 24 }, { NOTE_C4, 24 }, { NOTE_E4, 24 }, { NOTE_A4, 48 },
  { NOTE_E4, 24 }, { NOTE_C4, 24 }, { NOTE_A3, 48 },
  { NOTE_REST, 12 },
  { NOTE_G3, 24 }, { NOTE_B3, 24 }, { NOTE_D4, 24 }, { NOTE_G4, 48 },
  { NOTE_F4, 24 }, { NOTE_D4, 24 }, { NOTE_B3, 24 }, { NOTE_G3, 48 },
  { 0, 0 },
};

/* ── Song 2: short jingle / fanfare ────────────────────────────────── */
static const music_note_t song2[] = {
  { NOTE_C5, 12 }, { NOTE_C5, 12 }, { NOTE_C5, 12 }, { NOTE_E5, 36 },
  { NOTE_G4, 12 }, { NOTE_E4, 24 }, { NOTE_G4, 36 },
  { NOTE_REST, 6 },
  { NOTE_C5, 12 }, { NOTE_G4, 12 }, { NOTE_E4, 12 }, { NOTE_C4, 48 },
  { 0, 0 },
};

static const music_song_t songs[] = {
  { song0, 1 },  /* arpeggio — loops */
  { song1, 1 },  /* minor — loops */
  { song2, 0 },  /* fanfare — one-shot */
};
const uint8_t music_song_count = 3;

/* ── Engine state ─────────────────────────────────────────────────── */
static const music_note_t *cur_song;
static uint8_t cur_song_loop;
static uint16_t cur_pos;
static uint8_t cur_remaining;  /* frames left on the current row */
static uint8_t playing;

void music_init(void) {
  cur_song = 0;
  cur_song_loop = 0;
  cur_pos = 0;
  cur_remaining = 0;
  playing = 0;
  /* Silence the music channel up front. */
  psg_set_attn(MUSIC_CHANNEL, 0x0F);
}

static void start_row(void) {
  uint16_t note = cur_song[cur_pos].note;
  uint8_t dur  = cur_song[cur_pos].dur;
  if (dur == 0) {
    /* End sentinel. */
    if (cur_song_loop) {
      cur_pos = 0;
      note = cur_song[0].note;
      dur  = cur_song[0].dur;
      if (dur == 0) {
        /* Empty song — bail. */
        music_stop();
        return;
      }
    } else {
      music_stop();
      return;
    }
  }
  if (note == NOTE_REST) {
    psg_set_attn(MUSIC_CHANNEL, 0x0F);  /* silent rest */
  } else {
    psg_set_tone(MUSIC_CHANNEL, note);
    psg_set_attn(MUSIC_CHANNEL, MUSIC_VOLUME);
  }
  cur_remaining = dur;
}

void music_play(uint8_t song_idx) {
  if (song_idx >= music_song_count) return;
  cur_song = songs[song_idx].notes;
  cur_song_loop = songs[song_idx].loop;
  cur_pos = 0;
  playing = 1;
  start_row();
}

void music_stop(void) {
  playing = 0;
  psg_set_attn(MUSIC_CHANNEL, 0x0F);
}

void music_update(void) {
  if (!playing) return;
  if (cur_remaining == 0) return;  /* defensive */
  cur_remaining--;
  if (cur_remaining == 0) {
    cur_pos++;
    start_row();
  }
}
