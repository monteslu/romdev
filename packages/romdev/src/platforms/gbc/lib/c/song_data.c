/* ── song_data.c — sample song for hUGEDriver.c (compact format) ────
 *
 * A short hand-authored two-channel tune in C-major. 4 patterns, 16
 * rows each, ticks_per_row = 8 (~7.5 rows per second at 60 Hz).
 *
 * Pattern layout (per row): {note, flags}
 *   note  = 0..71 (C3..B8). See hUGE_note_table in hUGEDriver.c.
 *           Useful indices: C4=12 D4=14 E4=16 F4=17 G4=19 A4=21 B4=23
 *                           C5=24 D5=26 E5=28 F5=29 G5=31 A5=33 B5=35
 *                           C6=36
 *           Octave below: C3=0 G3=7 C4=12.
 *   flags = 0 (re-trigger) / 0x80 (sustain — leave APU alone)
 *           0xFF as note = rest (silence channel)
 *
 * For agents: to author your own song, replace these arrays with your
 * own pattern data. The format is intentionally simple — a 16-row
 * pattern is 32 bytes. A 4-pattern song is 128 bytes per channel.
 */

#include "hUGEDriver.h"

/* Convenience constants for readability. Match indices in
 * hUGE_note_table[] (driver source). */
#define R   { 0xFF, 0 }            /* rest */
#define _S  { 0,    0x80 }         /* sustain (note byte ignored) */
#define N(n) { (uint8_t)(n), 0 }

/* ── CH1 (melody — square 1) ───────────────────────────────────────── */

static const huge_row_t mel_p0[HUGE_ROWS_PER_PATTERN] = {
  N(24), _S, N(28), _S, N(31), _S, N(36), _S,   /* C5 E5 G5 C6 */
  N(31), _S, N(28), _S, N(24), _S, R, R
};

static const huge_row_t mel_p1[HUGE_ROWS_PER_PATTERN] = {
  N(26), _S, N(29), _S, N(33), _S, N(38), _S,   /* D5 F5 A5 D6 */
  N(33), _S, N(29), _S, N(26), _S, R, R
};

static const huge_row_t mel_p2[HUGE_ROWS_PER_PATTERN] = {
  N(28), _S, N(31), _S, N(35), _S, N(40), _S,   /* E5 G5 B5 E6 */
  N(35), _S, N(31), _S, N(28), _S, R, R
};

static const huge_row_t mel_p3[HUGE_ROWS_PER_PATTERN] = {
  N(36), _S, N(35), _S, N(33), _S, N(31), _S,   /* C6 B5 A5 G5 */
  N(29), _S, N(28), _S, N(26), _S, N(24), _S    /* F5 E5 D5 C5 */
};

static const huge_row_t * const mel_orders[] = {
  mel_p0, mel_p1, mel_p2, mel_p3
};

/* ── CH2 (bass — square 2) ────────────────────────────────────────── */

static const huge_row_t bas_p0[HUGE_ROWS_PER_PATTERN] = {
  N(0),  _S, _S, _S, N(0),  _S, _S, _S,         /* C3 */
  N(7),  _S, _S, _S, N(0),  _S, _S, _S          /* G3 / C3 */
};

static const huge_row_t bas_p1[HUGE_ROWS_PER_PATTERN] = {
  N(2),  _S, _S, _S, N(2),  _S, _S, _S,         /* D3 */
  N(9),  _S, _S, _S, N(2),  _S, _S, _S          /* A3 / D3 */
};

static const huge_row_t bas_p2[HUGE_ROWS_PER_PATTERN] = {
  N(4),  _S, _S, _S, N(4),  _S, _S, _S,         /* E3 */
  N(11), _S, _S, _S, N(4),  _S, _S, _S          /* B3 / E3 */
};

static const huge_row_t bas_p3[HUGE_ROWS_PER_PATTERN] = {
  N(12), _S, _S, _S, N(7),  _S, _S, _S,         /* C4 / G3 */
  N(4),  _S, _S, _S, N(0),  _S, _S, _S          /* E3 / C3 (resolve) */
};

static const huge_row_t * const bas_orders[] = {
  bas_p0, bas_p1, bas_p2, bas_p3
};

/* ── Song descriptor ──────────────────────────────────────────────── */

const huge_song_t sample_song = {
  /* ticks_per_row */ 8,
  /* ch1 */ { mel_orders, 4, 1 },
  /* ch2 */ { bas_orders, 4, 1 },
  /* ch3 */ { 0,          0, 0 },
  /* ch4 */ { 0,          0, 0 },
};
