/* ── hUGEDriver.h — Game Boy music driver header ────────────────────
 *
 * Public interface compatible with the upstream hUGEDriver function names
 * (https://github.com/SuperDisk/hUGEDriver — public domain). The driver
 * implementation we ship under this header is a *compact, SDCC-native*
 * rewrite — it understands a simplified subset of the hUGETracker song
 * format (notes only, no instruments / effects / subpatterns / waves)
 * and plays the melody on channels 1 and 2 via the standard 4-channel
 * APU. Good enough to put real music in a homebrew ROM today.
 *
 * Bundled along this driver is the FULL upstream RGBDS source as
 * `hUGEDriver.upstream.asm` + `LICENSE-HUGEDRIVER`. If you eventually
 * pull in RGBDS + `rgb2sdas.py` you can swap our tiny driver out for
 * the real thing without touching your song data.
 *
 * Usage:
 *   #include "hUGEDriver.h"
 *
 *   extern const huge_song_t my_song;
 *
 *   void main(void) {
 *     sound_init();              // power up APU
 *     hUGE_init(&my_song);       // load song descriptor
 *     for (;;) {
 *       wait_vblank();
 *       hUGE_dosound();          // advance one tick
 *     }
 *   }
 *
 * Song format (see song_data.c for a worked example):
 *   - Each channel has its OWN order list: an array of pattern pointers.
 *   - Each pattern is exactly HUGE_ROWS_PER_PATTERN rows × 2 bytes/row.
 *   - Row encoding (2 bytes):
 *       byte 0 = note index (0..71 = C3..B8) or HUGE_NOTE_REST (0xFF)
 *       byte 1 = flags (low nibble = reserved; bit 7 = sustain previous note)
 *   - Driver advances 1 row every `ticks_per_row` calls to hUGE_dosound.
 *
 * This is intentionally NOT the full upstream byte layout (see the
 * upstream `dn` macro for that 3-byte format) — it's a smaller format
 * that an agent can hand-author easily and that the in-tree song
 * data files (song_data.c) use directly.
 */
#ifndef HUGEDRIVER_H
#define HUGEDRIVER_H

#include <stdint.h>

#define HUGE_ROWS_PER_PATTERN  16
#define HUGE_NOTE_REST         0xFF

/* Channels (matches upstream enum order). */
enum hUGE_channel_t { HT_CH1 = 0, HT_CH2 = 1, HT_CH3 = 2, HT_CH4 = 3 };
enum hUGE_mute_t    { HT_CH_PLAY = 0, HT_CH_MUTE = 1 };

/* A "row" in our compact format. 2 bytes per row. */
typedef struct huge_row_t {
  uint8_t note;      /* 0..71 = C3..B8, 0xFF = rest */
  uint8_t flags;     /* bit 7 = sustain (do not retrigger) */
} huge_row_t;

/* Per-channel order list: an array of pattern pointers, terminated by
 * a count value the song header carries. */
typedef struct huge_channel_t {
  const huge_row_t * const * orders;   /* array of pattern pointers */
  uint8_t order_cnt;                   /* number of entries in `orders` */
  uint8_t enabled;                     /* 0 = channel silent, 1 = play */
} huge_channel_t;

typedef struct huge_song_t {
  uint8_t ticks_per_row;               /* hUGE_dosound calls per row */
  huge_channel_t ch1;                  /* square 1 (sweep) */
  huge_channel_t ch2;                  /* square 2 */
  huge_channel_t ch3;                  /* wave (treated as silent for now) */
  huge_channel_t ch4;                  /* noise */
} huge_song_t;

/* ── API ──────────────────────────────────────────────────────────── */

/* Load a song. Caller is responsible for having called sound_init() first
 * to power on the APU. Does not start playback by itself — playback
 * advances each time you call hUGE_dosound(). */
void hUGE_init(const huge_song_t * song);

/* Advance the driver by one tick. Call once per frame (e.g. just after
 * wait_vblank()) for ~60 Hz; the song's ticks_per_row determines how
 * many ticks elapse between row advances. */
void hUGE_dosound(void);

/* Mute / unmute a channel at runtime. */
void hUGE_mute_channel(enum hUGE_channel_t ch, enum hUGE_mute_t mute);

/* Rewind to the start of the song (order index 0, row 0). */
void hUGE_set_position(uint8_t order_index);

#endif /* HUGEDRIVER_H */
