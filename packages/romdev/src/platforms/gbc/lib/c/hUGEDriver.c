/* ── hUGEDriver.c — compact SDCC-native music driver for Game Boy ──
 *
 * See hUGEDriver.h for the song-format contract. This file is the
 * implementation. ~150 lines, C89 (SDCC sm83 friendly).
 *
 * What it does each tick:
 *   1. Decrement `tick_counter`. If still > 0, return.
 *   2. tick_counter <- ticks_per_row, advance to next row.
 *   3. For each enabled channel:
 *        a. Read the (note, flags) pair for this row from the current pattern.
 *        b. If note is 0..71 and flags bit 7 = 0 → trigger that note on that channel.
 *        c. If flags bit 7 = 1 (sustain) → leave APU alone.
 *        d. If note == 0xFF (rest) → silence the channel (NRx2 = 0).
 *   4. If row index hits HUGE_ROWS_PER_PATTERN, advance order index.
 *      If order index hits order_cnt, wrap to 0 (loop forever).
 *
 * What it deliberately does NOT do (vs. upstream hUGEDriver):
 *   - No instruments (envelope/sweep/duty are hard-coded per channel).
 *   - No effects (vibrato, slide, arpeggio, etc.).
 *   - No subpatterns.
 *   - No wave channel (CH3) — silent for now.
 *
 * Swap in upstream by replacing this .c + the .h's struct definitions with
 * the upstream .h and the `rgb2sdas.py`-converted hUGEDriver.o.
 */

#include "gb_hardware.h"
#include "hUGEDriver.h"

/* ── 72-entry note table (C3..B8), copied from upstream hUGE_note_table.inc.
 * Each entry is the 11-bit GB frequency period; lower = lower pitch.
 * https://github.com/SuperDisk/hUGEDriver/blob/master/include/hUGE_note_table.inc */
static const uint16_t hUGE_note_table[72] = {
    44, 156, 262, 363, 457, 547, 631, 710, 786, 854, 923, 986,
  1046,1102,1155,1205,1253,1297,1339,1379,1417,1452,1486,1517,
  1546,1575,1602,1627,1650,1673,1694,1714,1732,1750,1767,1783,
  1798,1812,1825,1837,1849,1860,1871,1881,1890,1899,1907,1915,
  1923,1930,1936,1943,1949,1954,1959,1964,1969,1974,1978,1982,
  1985,1988,1992,1995,1998,2001,2004,2006,2009,2011,2013,2015
};

/* ── Driver state ──────────────────────────────────────────────── */

static const huge_song_t * cur_song;
static uint8_t   tick_counter;     /* counts down to next row */
static uint8_t   row_index;        /* 0 .. HUGE_ROWS_PER_PATTERN-1 */
static uint8_t   order_index[4];   /* per-channel order list cursor */
static uint8_t   mute_mask;        /* bit n = channel n+1 muted */

/* ── Helpers ───────────────────────────────────────────────────── */

static void trigger_square(uint8_t channel, uint16_t period) {
  uint8_t lo;
  uint8_t hi;
  lo = (uint8_t)(period & 0xFFu);
  hi = (uint8_t)((period >> 8) & 0x07u);
  if (channel == HT_CH1) {
    NR10 = 0x00;                  /* no sweep */
    NR11 = 0x80;                  /* 50% duty, length 0 (so length counter never silences) */
    NR12 = 0xF0;                  /* full volume, no envelope */
    NR13 = lo;
    NR14 = (uint8_t)(0x80 | hi);  /* trigger, length disable */
  } else {                        /* HT_CH2 */
    NR21 = 0x80;
    NR22 = 0xF0;
    NR23 = lo;
    NR24 = (uint8_t)(0x80 | hi);
  }
}

static void silence_square(uint8_t channel) {
  /* Setting NRx2 (volume/envelope) to 0 with bits 3..7 clear is the
   * canonical "DAC off" — instantly silences the channel. */
  if (channel == HT_CH1) {
    NR12 = 0x00;
    NR14 = 0x80;   /* re-trigger so the silence takes effect immediately */
  } else {
    NR22 = 0x00;
    NR24 = 0x80;
  }
}

static void trigger_noise(uint8_t note) {
  /* Map low note index to a noise frequency. The noise channel's NR43
   * "shift clock" controls pitch; we let the song supply a coarse 0..7
   * range via the low 3 bits of note. */
  uint8_t shift;
  shift = (uint8_t)(note & 0x07u);
  NR41 = 0x00;                                /* length 0 */
  NR42 = 0xF0;                                /* full volume, no envelope */
  NR43 = (uint8_t)((shift << 4) | 0x03u);     /* mid divisor */
  NR44 = 0x80;                                /* trigger, length disable */
}

static void silence_noise(void) {
  NR42 = 0x00;
  NR44 = 0x80;
}

/* Process one row for one channel. */
static void channel_step(uint8_t channel, const huge_channel_t * ch) {
  const huge_row_t * pattern;
  uint8_t           note;
  uint8_t           flags;
  uint8_t           muted;
  uint8_t           oi;

  if (!ch->enabled || ch->order_cnt == 0) return;
  muted = (uint8_t)(mute_mask & (1u << channel));
  oi = order_index[channel];
  if (oi >= ch->order_cnt) oi = 0;
  pattern = ch->orders[oi];
  note  = pattern[row_index].note;
  flags = pattern[row_index].flags;
  if (flags & 0x80u) return;        /* sustain — leave APU alone */

  if (note == HUGE_NOTE_REST) {
    if (channel == HT_CH1 || channel == HT_CH2) silence_square(channel);
    else if (channel == HT_CH4)                 silence_noise();
    return;
  }
  if (muted) return;
  if (note >= 72) return;

  if (channel == HT_CH1 || channel == HT_CH2) {
    trigger_square(channel, hUGE_note_table[note]);
  } else if (channel == HT_CH4) {
    trigger_noise(note);
  }
  /* CH3 (wave) intentionally silent in this compact driver. */
}

/* ── Public API ───────────────────────────────────────────────────── */

void hUGE_init(const huge_song_t * song) {
  uint8_t i;
  cur_song     = song;
  tick_counter = 1;          /* fire row 0 on the very first hUGE_dosound */
  row_index    = 0;
  mute_mask    = 0;
  for (i = 0; i < 4; i++) order_index[i] = 0;
  /* Stop any lingering tones. */
  silence_square(HT_CH1);
  silence_square(HT_CH2);
  silence_noise();
}

void hUGE_dosound(void) {
  if (cur_song == 0) return;
  tick_counter--;
  if (tick_counter != 0) return;
  tick_counter = cur_song->ticks_per_row;
  if (tick_counter == 0) tick_counter = 1;

  channel_step(HT_CH1, &cur_song->ch1);
  channel_step(HT_CH2, &cur_song->ch2);
  channel_step(HT_CH3, &cur_song->ch3);
  channel_step(HT_CH4, &cur_song->ch4);

  row_index++;
  if (row_index >= HUGE_ROWS_PER_PATTERN) {
    row_index = 0;
    order_index[0]++;
    order_index[1]++;
    order_index[2]++;
    order_index[3]++;
    if (cur_song->ch1.order_cnt && order_index[0] >= cur_song->ch1.order_cnt) order_index[0] = 0;
    if (cur_song->ch2.order_cnt && order_index[1] >= cur_song->ch2.order_cnt) order_index[1] = 0;
    if (cur_song->ch3.order_cnt && order_index[2] >= cur_song->ch3.order_cnt) order_index[2] = 0;
    if (cur_song->ch4.order_cnt && order_index[3] >= cur_song->ch4.order_cnt) order_index[3] = 0;
  }
}

void hUGE_mute_channel(enum hUGE_channel_t ch, enum hUGE_mute_t mute) {
  uint8_t bit;
  bit = (uint8_t)(1u << (uint8_t)ch);
  if (mute == HT_CH_MUTE) {
    mute_mask = (uint8_t)(mute_mask | bit);
    if (ch == HT_CH1 || ch == HT_CH2) silence_square((uint8_t)ch);
    else if (ch == HT_CH4)            silence_noise();
  } else {
    mute_mask = (uint8_t)(mute_mask & (uint8_t)~bit);
  }
}

void hUGE_set_position(uint8_t order_index_) {
  uint8_t i;
  row_index    = 0;
  tick_counter = 1;
  for (i = 0; i < 4; i++) order_index[i] = order_index_;
}
