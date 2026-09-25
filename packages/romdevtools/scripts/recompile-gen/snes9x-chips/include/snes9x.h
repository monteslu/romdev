/* Freestanding stand-in for snes9x.h (and the port.h types it pulls in),
 * for compiling snes9x's coprocessor sources to wasm32 in
 * scripts/recompile-gen/snes9x-chips.mjs. Only what the chip sources use is
 * declared; the chip code itself is snes9x's, unmodified.
 *
 * The cart shares ONE linear memory with the compiled chip code, so every
 * pointer the chip keeps (Memory.SRAM, Memory.OBC1RAM, the BS-X Map[] ...) is
 * a real cart address, set by the glue's bind function at power-on. */
#ifndef _SNES9X_H_
#define _SNES9X_H_

#include <stdint.h>
#include <stddef.h>

typedef uint8_t  uint8;
typedef uint16_t uint16;
typedef uint32_t uint32;
typedef uint64_t uint64;
typedef int8_t   int8;
typedef int16_t  int16;
typedef int32_t  int32;
typedef int64_t  int64;
typedef unsigned char bool8;
typedef intptr_t pint;
/* emscripten's musl time_t (what the reference core's time() returns) */
typedef long long time_t;

#ifndef TRUE
#define TRUE 1
#endif
#ifndef FALSE
#define FALSE 0
#endif

#define memset  __builtin_memset
#define memcpy  __builtin_memcpy
#define memmove __builtin_memmove

#define SLASH_STR "/"

/* port.h on the reference's emscripten build: LSB_FIRST and
 * FAST_LSB_WORD_ACCESS are defined (musl's <sys/types.h> brings in
 * <endian.h>, so __BYTE_ORDER == __ORDER_LITTLE_ENDIAN__), and the chip
 * sources take their FAST_LSB_WORD_ACCESS paths (seta010.cpp passes SRAM
 * words by reference there, which is not the same code as the byte path) */
#define LSB_FIRST
#define FAST_LSB_WORD_ACCESS
#define READ_WORD(s)		(*(uint16 *) (s))
#define READ_3WORD(s)		(*(uint32 *) (s) & 0x00ffffff)
#define READ_DWORD(s)		(*(uint32 *) (s))
#define WRITE_WORD(s, d)	*(uint16 *) (s) = (d)
#define WRITE_3WORD(s, d)	*(uint16 *) (s) = (uint16) (d), *((uint8 *) (s) + 2) = (uint8) ((d) >> 16)
#define WRITE_DWORD(s, d)	*(uint32 *) (s) = (d)

/* snes9x's OpenBus (the CPU data bus); the glue keeps it in sync with the
 * cart's $ob before every call that can read it */
extern uint8 OpenBus;

/* a few chip sources print under #ifdef DEBUGGER only; the rest are no-ops */
extern "C" int printf (const char *, ...);

/* the wall clock (emscripten's time(): trunc(Date.now() / 1000)), which
 * the cart takes from the wasmcart host's frame clock */
extern "C" time_t time (time_t *);

/* snes9x's file layer as the MSU-1 and BS-X sources use it (snes9x.h's
 * STREAM macros over stream.h, fscompat's S9xGetFilename), over files the
 * cart carries in its own memory. romdev_open_stream (the unit's glue)
 * answers for a name, or returns NULL as fopen does for a missing file. */
#include <string>
enum s9x_getdirtype
{
	DEFAULT_DIR = 0, HOME_DIR, ROMFILENAME_DIR, ROM_DIR, SRAM_DIR, SNAPSHOT_DIR, SCREENSHOT_DIR,
	SPC_DIR, CHEAT_DIR, PATCH_DIR, BIOS_DIR, LOG_DIR, SAT_DIR, LAST_DIR
};
std::string S9xGetFilename (std::string, enum s9x_getdirtype);
std::string S9xGetDirectory (enum s9x_getdirtype);
struct RomdevStream
{
	const uint8	*data;
	uint32		size;
	uint32		pos;
	bool		open;
	/* gzgetc / fgetc: the next byte, or -1 at the end */
	int get_char (void) { if (pos >= size) return -1; return data[pos++]; }
	/* gzread / fread: what is left, up to len */
	int read (void *p, uint32 len)
	{
		if (pos >= size) return 0;
		uint32 n = size - pos < len ? size - pos : len;
		memcpy(p, data + pos, n);
		pos += n;
		return (int) n;
	}
	/* gzseek / fseek (SEEK_SET): a position past the end reads as the end */
	int revert (uint8 origin, int32 offset) { (void) origin; pos = (uint32) offset; return 0; }
	void closeStream (void) { open = false; }
};
RomdevStream *romdev_open_stream (const char *, const char *);
#define STREAM					RomdevStream *
#define READ_STREAM(p, l, s)	(s)->read(p, l)
#define GETC_STREAM(s)			(s)->get_char()
#define OPEN_STREAM(f, m)		romdev_open_stream(f, m)
#define REVERT_STREAM(s, o, p)	(s)->revert(p, o)
#define CLOSE_STREAM(s)			(s)->closeStream()

struct SSettings
{
	bool8	BS;
	bool8	BSXItself;
	bool8	BSXBootup;
	bool8	MSU1;
	bool8	SRTC;
	bool8	SPC7110RTC;
};
extern struct SSettings Settings;

struct SSNESGameFixes
{
	uint8	SRAMInitialValue;
};
extern struct SSNESGameFixes SNESGameFixes;

#include "dsp.h"
#include "seta.h"
#include "obc1.h"

#endif
