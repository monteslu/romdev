/* The MSU-1 unit: snes9x's msu1.cpp (with apu/resampler.h), over the data
 * file and PCM tracks the cart carries in its own memory. The entry points
 * are where snes9x calls in:
 *
 *   libretro retro_init   S9xInitSound(32): the MSU resampler, 2050 * 3 / 2
 *                         samples (apu.cpp S9xInitSound), and S9xMSU1SetOutput
 *   memmap.cpp InitROM    Settings.MSU1 = S9xMSU1ROMExists(), then
 *                         S9xAPUTimingSetSpeedup -> UpdatePlaybackRate: the
 *                         MSU time ratio (apu.cpp UpdatePlaybackRate)
 *   cpu.cpp S9xReset      S9xResetMSU(), then S9xMSU1Init() if Settings.MSU1
 *   ppu.cpp               $2000-$2007: S9xMSU1ReadPort / S9xMSU1WritePort
 *   SPC_DSP.cpp           SPC_DSP_OUT_HOOK: S9xMSU1Generate(2) per DSP sample
 *   libretro S9xSyncSpeed S9xGetSampleCount (the MSU resampler's avail) and
 *                         S9xMixSamples (its read, mixed into the DSP's) */
#include "glue_common.h"
#include "msu1.h"
#include "apu/resampler.h"

struct SMSU1	MSU1;

void CMemory::map_WriteProtectROM (void) {}

/* A bump allocator for the resampler's buffer (resize runs once, at init). */
static uint8	arena[0x4000];
static uint32	arena_used;
void *operator new[] (size_t n) { void *p = arena + arena_used; arena_used = (arena_used + (uint32) n + 15) & ~15u; return p; }
void *operator new (size_t n) { return operator new[](n); }
void operator delete[] (void *) noexcept {}
void operator delete (void *) noexcept {}
void operator delete (void *, size_t) noexcept {}
void operator delete[] (void *, size_t) noexcept {}

/* fscompat.cpp: the file name is only matched against the cart's files, so
 * the extension alone names it (".msu", "-3.pcm", "msu1.rom") */
std::string S9xGetFilename (std::string ext, enum s9x_getdirtype) { return ext; }
std::string S9xGetDirectory (enum s9x_getdirtype) { return std::string(""); }

/* The cart's files: the .msu data file, and a table of {track, address, size}. */
static const uint8	*msu_data;
static uint32		msu_data_size;
static const uint32	*msu_tracks;
static int		msu_ntracks;
static RomdevStream	streams[2];

static bool streq (const char *a, const char *b) { while (*a && *a == *b) { a++; b++; } return *a == *b; }

RomdevStream *romdev_open_stream (const char *name, const char *)
{
	const uint8 *d = NULL;
	uint32 size = 0;
	if (streq(name, ".msu"))
	{
		if (!msu_data) return NULL;
		d = msu_data; size = msu_data_size;
	}
	else if (name[0] == '-')
	{
		/* "-" + std::to_string(track) + ".pcm" */
		uint32 n = 0; const char *p = name + 1;
		if (*p < '0' || *p > '9') return NULL;
		while (*p >= '0' && *p <= '9') n = n * 10 + (uint32) (*p++ - '0');
		if (!streq(p, ".pcm")) return NULL;
		for (int i = 0; i < msu_ntracks; i++)
			if (msu_tracks[i * 3] == n) { d = (const uint8 *) (pint) msu_tracks[i * 3 + 1]; size = msu_tracks[i * 3 + 2]; }
		if (!d) return NULL;
	}
	else
		return NULL;
	for (int i = 0; i < 2; i++)
		if (!streams[i].open)
		{
			streams[i].data = d; streams[i].size = size; streams[i].pos = 0; streams[i].open = true;
			return &streams[i];
		}
	return NULL;
}

static Resampler	*msu_rs;
/* apu.cpp S9xMixSamples's msu::resampler_buffer (a std::vector: it only
 * grows, and a short read leaves the previous frame's samples in it) */
static int16		mixbuf[0x4000];
static int		mixlen;

/* retro_init + InitROM + S9xReset for a cart with an MSU-1 pack. `hackDenominator`
 * is apu.cpp's timing_hack_denominator (256 - Timings.APUSpeedup). */
extern "C" void romdev_msu_init (int data, int dataSize, int tracks, int ntracks, int hackDenominator)
{
	msu_data = (const uint8 *) (pint) data;
	msu_data_size = (uint32) dataSize;
	msu_tracks = (const uint32 *) (pint) tracks;
	msu_ntracks = ntracks;

	/* S9xInitSound(32): buffer_size_samples = max(MINIMUM_BUFFER_SIZE, 32040 * 32 * 2 / 1000) */
	int buffer_size_samples = 550 * 2;
	int requested = 32040 * 32 * 2 / 1000;
	if (requested > buffer_size_samples)
		buffer_size_samples = requested;
	msu_rs = new Resampler();
	msu_rs->resize(buffer_size_samples * 3 / 2);
	S9xMSU1SetOutput(msu_rs);

	/* InitROM */
	Settings.MSU1 = S9xMSU1ROMExists();
	/* UpdatePlaybackRate (SoundInputRate = SoundPlaybackRate = 32040) */
	double time_ratio = (double) 32040 * 256 / (32040 * hackDenominator);
	if (Settings.MSU1)
	{
		time_ratio = time_ratio * 44100 / 32040;
		msu_rs->time_ratio(time_ratio);
	}

	/* S9xReset */
	S9xResetMSU();
	if (Settings.MSU1)
		S9xMSU1Init();
}

extern "C" int romdev_msu_enabled (void) { return Settings.MSU1; }
extern "C" int romdev_msu_read (int port) { return S9xMSU1ReadPort((uint8) port); }
extern "C" void romdev_msu_write (int port, int byte) { S9xMSU1WritePort((uint8) port, (uint8) byte); }
extern "C" void romdev_msu_generate (void) { S9xMSU1Generate(2); }
extern "C" int romdev_msu_avail (void) { return msu_rs->avail(); }

/* S9xMixSamples's MSU part: `count` samples starting at stereo frame
 * `start` of the cart's ring of `frames` frames (a power of two) */
extern "C" void romdev_msu_mix (int ring, int frames, int start, int count)
{
	int16 *out = (int16 *) (pint) ring;
	if (mixlen < count)
	{
		for (int i = mixlen; i < count; i++) mixbuf[i] = 0;
		mixlen = count;
	}
	msu_rs->read(mixbuf, count);
	int mask = frames * 2 - 1;
	for (int i = 0; i < count; ++i)
	{
		int16 *o = &out[(start * 2 + i) & mask];
		int32 mixed = (int32) *o + mixbuf[i];
		*o = ((int16) mixed != mixed) ? (mixed >> 31) ^ 0x7fff : mixed;
	}
}
