/* sms_music.c — 3-voice PSG tracker for SMS.
 *
 * Hand-authored song: a relaxed C-major arpeggio loop. Voice 0 carries
 * the melody (octave-5/4 line), voice 1 plays a slower harmony, voice 2
 * drives a walking bass. Each voice has its own independent step cursor
 * + per-step countdown, so the three tracks can be different lengths
 * and they'll polyrhythm naturally — voice 2 (bass) loops every 16
 * steps, voice 1 (harmony) every 8, voice 0 (melody) every 16. The
 * common period is 16 steps so the song lines up cleanly on the loop.
 *
 * Playback is purely time-driven: when a voice's frame counter hits 0
 * we (a) advance the step cursor (wrapping at the track length), (b)
 * write the new divider to the PSG via the SN76489 latch+data protocol,
 * and (c) reload the frame counter from the new step's duration. We
 * keep the volume latched at "loud" (attenuation 0) for tone channels
 * while a note is held, and write attenuation 0xF (silent) on rests.
 *
 * Why not reuse sms_sfx.c's psg_write?
 *   sms_sfx.c keeps psg_write static — its API is the high-level sfx_*.
 *   We write the same byte directly to PORT_H_COUNTER ourselves so the
 *   music driver is self-contained and doesn't entangle the two layers
 *   (sfx auto-silences after N frames; music doesn't want that).
 *
 * Z80 / SDCC notes:
 *   - C89 only: all locals declared at top of block (see SDCC_GOTCHAS).
 *   - uint16_t divider table is in const ROM (declared `const`) — fine.
 *   - All state in static RAM, no malloc.
 */

#include "sms_music.h"
#include "sms_hw.h"

/* ─── Note dividers (NTSC, 3.58MHz / 32) ───────────────────────────── */
#define D_REST  0
#define D_C3    855
#define D_G3    570
#define D_A3    509
#define D_C4    427
#define D_D4    381
#define D_E4    339
#define D_F4    320
#define D_G4    285
#define D_A4    254
#define D_B4    226
#define D_C5    214
#define D_D5    191
#define D_E5    170

/* ─── Song data — parallel per-voice tracks ────────────────────────── */
/* 60 fps; quarter ≈ 18 frames, half ≈ 36, eighth ≈ 9. */
#define Q  18
#define H  36
#define E  9

/* Voice 0 — melody (16 steps, ~3.2 sec/loop). Mary-had-a-little-lamb
 * style line transposed to feel like a chiptune arpeggio. */
static const uint16_t mel0_freq[16] = {
  D_E5, D_D5, D_C5, D_D5, D_E5, D_E5, D_E5, D_REST,
  D_D5, D_D5, D_D5, D_REST, D_E5, D_G4, D_G4, D_REST,
};
static const uint8_t  mel0_len[16] = {
  Q, Q, Q, Q,  Q, Q, H, E,
  Q, Q, H, E,  Q, Q, H, E,
};

/* Voice 1 — harmony / countermelody (8 steps, ~2.4 sec/loop). Holds
 * thirds + fifths under the melody. */
static const uint16_t mel1_freq[8] = {
  D_G4, D_E4, D_F4, D_E4,
  D_G4, D_C4, D_D4, D_E4,
};
static const uint8_t  mel1_len[8] = {
  H, H, H, H,
  H, H, H, H,
};

/* Voice 2 — bass (8 steps, ~3.2 sec/loop). Walking C/G/A/F pattern. */
static const uint16_t mel2_freq[8] = {
  D_C3, D_C3, D_G3, D_G3,
  D_A3, D_A3, D_F4, D_G3,
};
static const uint8_t  mel2_len[8] = {
  H, H, H, H,
  H, H, H, H,
};

/* ─── Playback state ────────────────────────────────────────────────── */
static uint8_t  cursor[3];      /* current step index per voice */
static uint8_t  remaining[3];   /* frames left on current step */
static uint8_t  playing;        /* nonzero = music_update() drives PSG */

/* Track length per voice — kept as a tiny lookup so the step-advance
 * code can stay branch-free across voices. */
static const uint8_t track_len[3] = { 16, 8, 8 };

/* ─── PSG write primitive (same byte to port $7F as sms_sfx.c) ────── */
static void psg_write(uint8_t b) {
  PORT_H_COUNTER = b;
}

static void psg_silence(uint8_t channel) {
  psg_write(0x90 | (channel << 5) | 0x0F);
}

static void psg_tone(uint8_t channel, uint16_t divider) {
  psg_write(0x80 | (channel << 5) | (divider & 0x0F));
  psg_write((divider >> 4) & 0x3F);
  psg_write(0x90 | (channel << 5) | 0x00);   /* volume max */
}

/* Fetch the (freq, len) at step `s` of voice `v`. We keep the song
 * tables typed individually for clarity rather than a 3-row 2D array;
 * the compiler folds this switch into a jump table just fine. */
static void fetch_step(uint8_t v, uint8_t s, uint16_t *freq_out, uint8_t *len_out) {
  if (v == 0) {
    *freq_out = mel0_freq[s];
    *len_out  = mel0_len[s];
  } else if (v == 1) {
    *freq_out = mel1_freq[s];
    *len_out  = mel1_len[s];
  } else {
    *freq_out = mel2_freq[s];
    *len_out  = mel2_len[s];
  }
}

static void start_step(uint8_t v) {
  uint16_t f;
  uint8_t  len;
  fetch_step(v, cursor[v], &f, &len);
  if (f == D_REST) {
    psg_silence(v);
  } else {
    psg_tone(v, f);
  }
  remaining[v] = len;
}

void music_init(void) {
  uint8_t i;
  for (i = 0; i < 3; i++) {
    cursor[i] = 0;
    remaining[i] = 0;
    psg_silence(i);
  }
  playing = 0;
}

void music_play(uint8_t song_idx) {
  uint8_t i;
  (void)song_idx;          /* one bundled song for now — future banks */
  for (i = 0; i < 3; i++) {
    cursor[i] = 0;
    start_step(i);
  }
  playing = 1;
}

void music_update(void) {
  uint8_t v;
  if (!playing) return;
  for (v = 0; v < 3; v++) {
    if (remaining[v] > 0) {
      remaining[v]--;
    }
    if (remaining[v] == 0) {
      cursor[v]++;
      if (cursor[v] >= track_len[v]) cursor[v] = 0;
      start_step(v);
    }
  }
}

void music_stop(void) {
  uint8_t i;
  playing = 0;
  for (i = 0; i < 3; i++) psg_silence(i);
}
