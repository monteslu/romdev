/* romdev per-frame audio stream ("RDAS") - a debug copy of samples a core
 * produces BEFORE its own resampler / filter / mixer stage, exposed as a
 * retro_get_memory_data region so romdev's audio verifier
 * (romdevtools src/host/audio-verify.js, frame({op:'verifyRecompile', audio}))
 * can compare a recompiled cart against the core's native stream sample for
 * sample.
 *
 * Header-only and write-only from the core's point of view: the core copies
 * samples in, never reads them back, so emulation is unchanged (each patch
 * that adds a stream is proven byte-identical before/after on real ROMs).
 *
 * Layout (little-endian u32 header, then interleaved samples):
 *   +0  magic 'RDAS' (0x53414452)
 *   +4  count      sample frames written since the top of the last retro_run
 *   +8  channels   1 or 2 (interleaved)
 *   +12 format     0 = s16, 1 = s32, 2 = f32
 *   +16 rate       samples per second (0 = not a fixed rate)
 *   +20 capacity   sample frames the buffer holds
 *   +24 dropped    sample frames that did not fit (count keeps counting them)
 *   +28 reserved
 *   +32 samples
 */
#ifndef ROMDEV_AUDIO_STREAM_H
#define ROMDEV_AUDIO_STREAM_H

#include <stdint.h>
#include <string.h>

#define ROMDEV_AS_MAGIC  0x53414452u
#define ROMDEV_AS_HEADER 32u
#define ROMDEV_AS_S16 0u
#define ROMDEV_AS_S32 1u
#define ROMDEV_AS_F32 2u

typedef struct {
   uint32_t magic, count, channels, format, rate, capacity, dropped, reserved;
} romdev_as_header_t;

/* Bytes a stream of `cap` sample frames needs. */
#define ROMDEV_AS_BYTES(cap, ch, bps) (ROMDEV_AS_HEADER + (cap) * (ch) * (bps))

static inline romdev_as_header_t *romdev_as_hdr(void *buf) { return (romdev_as_header_t *)buf; }

static inline void romdev_as_init(void *buf, uint32_t channels, uint32_t format, uint32_t rate, uint32_t capacity)
{
   romdev_as_header_t *h = romdev_as_hdr(buf);
   h->magic = ROMDEV_AS_MAGIC; h->count = 0; h->channels = channels; h->format = format;
   h->rate = rate; h->capacity = capacity; h->dropped = 0; h->reserved = 0;
}

/* Call at the top of retro_run: the region then holds exactly one frame. */
static inline void romdev_as_begin_frame(void *buf)
{
   romdev_as_header_t *h = romdev_as_hdr(buf);
   h->count = 0; h->dropped = 0;
}

static inline void romdev_as_set_rate(void *buf, uint32_t rate) { romdev_as_hdr(buf)->rate = rate; }

/* Append `frames` sample frames of `bps`-byte samples. */
static inline void romdev_as_push(void *buf, const void *samples, uint32_t frames, uint32_t bps)
{
   romdev_as_header_t *h = romdev_as_hdr(buf);
   uint32_t room = h->count < h->capacity ? h->capacity - h->count : 0;
   uint32_t n = frames < room ? frames : room;
   if (n)
      memcpy((uint8_t *)buf + ROMDEV_AS_HEADER + (size_t)h->count * h->channels * bps, samples, (size_t)n * h->channels * bps);
   h->dropped += frames - n;
   h->count += frames;
}

static inline void romdev_as_push_s16x2(void *buf, int16_t l, int16_t r)
{
   int16_t s[2]; s[0] = l; s[1] = r;
   romdev_as_push(buf, s, 1, 2);
}

static inline void romdev_as_push_s32(void *buf, int32_t v)
{
   romdev_as_push(buf, &v, 1, 4);
}

static inline void romdev_as_push_s32x2(void *buf, int32_t l, int32_t r)
{
   int32_t s[2]; s[0] = l; s[1] = r;
   romdev_as_push(buf, s, 1, 4);
}

#endif
