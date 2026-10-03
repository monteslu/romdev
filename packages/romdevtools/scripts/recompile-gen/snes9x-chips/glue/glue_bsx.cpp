/* The BS-X unit: snes9x's bsx.cpp (the Satellaview BIOS cart's MMC, flash
 * and PSRAM mapping, the $2188-$219F registers and the satellite clock).
 * bsx.cpp rebuilds snes9x's Memory.Map[] itself (BSX_Map, on reset and when
 * the game writes MMC $0E:5000); its closing map_WriteProtectROM() call is
 * where this glue turns Map[] into the cart's own block table. Memory.ROM,
 * BIOSROM (ROM + $300000) and BSRAM / PSRAM (ROM + $400000) are the cart's
 * image as snes9x lays out its ROM buffer. */
#include "glue_common.h"

struct SBSX	BSX;

/* cart addresses */
static uint32	*maptab;	/* the cart's MAPTAB: 4096 x {u32 type, u32 base} */
static uint32	wram;		/* the cart's work RAM */
/* Memory.RAM as the chip sees it: the cart's work RAM sits at address 0,
 * which a Map[] entry cannot tell from the MAP_CPU index, so bsx.cpp is
 * given this stand-in and the table translates it back */
#define RAM_TAG	0x7f000000u

/* cart block types (memmap.js MAP_TYPE) */
enum { T_NONE = 0, T_ROM = 1, T_RAM = 2, T_PPU = 3, T_CPU = 4, T_LOSRAM = 5, T_HISRAM = 6, T_CHIP = 7 };

void CMemory::map_WriteProtectROM (void)
{
	for (int c = 0; c < 0x1000; c++)
	{
		pint p = (pint) Map[c];
		uint32 type, base = 0;
		if (p < CMemory::MAP_LAST)
		{
			switch (p)
			{
				case CMemory::MAP_CPU:			type = T_CPU; break;
				case CMemory::MAP_PPU:			type = T_PPU; break;
				case CMemory::MAP_LOROM_SRAM:	type = T_LOSRAM; break;
				case CMemory::MAP_HIROM_SRAM:	type = T_HISRAM; break;
				case CMemory::MAP_BSX:			type = T_CHIP; break;
				default:						type = T_NONE; break;
			}
		}
		else
		{
			/* snes9x reads Map[c] + (Address & 0xffff): this block's first byte */
			uint32 first = (uint32) p + ((c & 0xf) << 12);
			if (first >= RAM_TAG && first < RAM_TAG + 0x20000)
				first = first - RAM_TAG + wram;
			base = first;
			/* map_WriteProtectROM: a ROM block's WriteMap is MAP_NONE */
			type = BlockIsROM[c] ? T_ROM : T_RAM;
		}
		maptab[c * 2] = type;
		maptab[c * 2 + 1] = base;
	}
}

/* libretro.cpp S9xGetDirectory: the satellite stream files would live
 * there; the path only reaches fopen / ifstream, which find nothing */
std::string S9xGetDirectory (enum s9x_getdirtype) { return std::string(""); }
std::string S9xGetFilename (std::string ext, enum s9x_getdirtype) { return ext; }

/* libc (glue_bsx_libc.h) */
extern "C" FILE *fopen (const char *, const char *) { return NULL; }
extern "C" size_t fread (void *, size_t, size_t, FILE *) { return 0; }
extern "C" int fclose (FILE *) { return 0; }
extern "C" int snprintf (char *s, size_t n, const char *, ...) { if (n) s[0] = 0; return 0; }
/* localtime in UTC: days since 1970-01-01 to a civil date */
static struct tm tmbuf;
extern "C" struct tm *localtime (const time_t *t)
{
	long long secs = *t;
	long long days = secs / 86400, rem = secs % 86400;
	if (rem < 0) { rem += 86400; days--; }
	tmbuf.tm_hour = (int) (rem / 3600);
	tmbuf.tm_min = (int) (rem % 3600 / 60);
	tmbuf.tm_sec = (int) (rem % 60);
	int wd = (int) ((days + 4) % 7);
	tmbuf.tm_wday = wd < 0 ? wd + 7 : wd;
	long long z = days + 719468;
	long long era = (z >= 0 ? z : z - 146096) / 146097;
	long long doe = z - era * 146097;
	long long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
	long long y = yoe + era * 400;
	long long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	long long mp = (5 * doy + 2) / 153;
	long long d = doy - (153 * mp + 2) / 5 + 1;
	long long m = mp < 10 ? mp + 3 : mp - 9;
	if (m <= 2) y++;
	tmbuf.tm_mday = (int) d;
	tmbuf.tm_mon = (int) m - 1;
	tmbuf.tm_year = (int) (y - 1900);
	static const int cum[12] = { 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334 };
	bool leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
	tmbuf.tm_yday = cum[m - 1] + (int) d - 1 + (leap && m > 2 ? 1 : 0);
	tmbuf.tm_isdst = 0;
	return &tmbuf;
}

/* memmap.cpp InitROM's S9xInitBSX over the cart's image. `rom` is snes9x's
 * Memory.ROM (the image), `size` CalculatedSize, and the Multi fields are
 * LoadMultiCartMem's (zero for the BIOS loaded by itself). */
extern "C" void romdev_bsx_init (int rom, int size, int sram, int wramBase, int maptabAddr,
	int cartType, int offsetA, int sizeA, int offsetB, int sizeB)
{
	Memory.ROM = (uint8 *) (pint) rom;
	Memory.BIOSROM = Memory.ROM + 0x300000;
	Memory.BSRAM = Memory.ROM + 0x400000;
	Memory.SRAM = (uint8 *) (pint) sram;
	Memory.RAM = (uint8 *) (pint) RAM_TAG;
	Memory.CalculatedSize = size;
	wram = (uint32) wramBase;
	maptab = (uint32 *) (pint) maptabAddr;
	Multi.cartType = cartType;
	Multi.cartOffsetA = (uint32) offsetA; Multi.cartSizeA = sizeA;
	Multi.cartOffsetB = (uint32) offsetB; Multi.cartSizeB = sizeB;
	S9xInitBSX();
}

extern "C" int romdev_bsx_active (void) { return Settings.BS; }
/* cpu.cpp S9xReset: S9xResetBSX() (it runs BSX_Map when Settings.BS) */
extern "C" void romdev_bsx_reset (void) { S9xResetBSX(); }
/* getset.h MAP_BSX: S9xGetBSX(Address) / S9xSetBSX(Byte, Address) */
extern "C" int romdev_bsx_get (int address) { return S9xGetBSX((uint32) address); }
extern "C" void romdev_bsx_set (int byte, int address) { S9xSetBSX((uint8) byte, (uint32) address); }
/* ppu.cpp: $2188-$219F */
extern "C" int romdev_bsx_ppu_get (int address, int openbus) { OpenBus = (uint8) openbus; return S9xGetBSXPPU((uint16) address); }
extern "C" void romdev_bsx_ppu_set (int byte, int address) { S9xSetBSXPPU((uint8) byte, (uint16) address); }

/* the BS-X's state as the reference serves it (romdev_chipstate.h) */
#define ROMDEV_CS_BSX
#include "romdev_chipstate.h"
extern "C" int romdev_bsx_chipstate (uint8 *o) { return (int) romdev_cs_bsx(o); }
