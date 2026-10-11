/* The DSP-1/2/3/4 unit: snes9x's dsp.cpp + dsp1-4.cpp HLE, driven the way
 * snes9x drives them. romdev_dsp_init repeats memmap.cpp InitROM's DSP
 * selection (the ROMType / ROMSpeed decode happens in the cart's loader,
 * which passes the DSP number, HiROM and CalculatedSize). */
#include "glue_common.h"

struct SDSP0	DSP0;
struct SDSP1	DSP1;
struct SDSP2	DSP2;
struct SDSP3	DSP3;
struct SDSP4	DSP4;

void CMemory::map_WriteProtectROM (void) {}

extern "C" void romdev_dsp_init (int dsp, int hirom, int calculatedSize)
{
	/* memmap.cpp InitROM: switch (Settings.DSP) */
	switch (dsp)
	{
		case 1:	// DSP1
			if (hirom)
			{
				DSP0.boundary = 0x7000;
				DSP0.maptype = M_DSP1_HIROM;
			}
			else if (calculatedSize > 0x100000)
			{
				DSP0.boundary = 0x4000;
				DSP0.maptype = M_DSP1_LOROM_L;
			}
			else
			{
				DSP0.boundary = 0xc000;
				DSP0.maptype = M_DSP1_LOROM_S;
			}

			SetDSP = &DSP1SetByte;
			GetDSP = &DSP1GetByte;
			break;

		case 2: // DSP2
			DSP0.boundary = 0x10000;
			DSP0.maptype = M_DSP2_LOROM;
			SetDSP = &DSP2SetByte;
			GetDSP = &DSP2GetByte;
			break;

		case 3: // DSP3
			DSP0.boundary = 0xc000;
			DSP0.maptype = M_DSP3_LOROM;
			SetDSP = &DSP3SetByte;
			GetDSP = &DSP3GetByte;
			break;

		case 4: // DSP4
			DSP0.boundary = 0xc000;
			DSP0.maptype = M_DSP4_LOROM;
			SetDSP = &DSP4SetByte;
			GetDSP = &DSP4GetByte;
			break;

		default:
			SetDSP = NULL;
			GetDSP = NULL;
			break;
	}
}

/* cpu.cpp S9xReset: if (Settings.DSP) S9xResetDSP(); */
extern "C" void romdev_dsp_reset (void) { S9xResetDSP(); }
/* getset.h MAP_DSP: S9xGetDSP(Address & 0xffff) / S9xSetDSP(Byte, Address & 0xffff) */
extern "C" int romdev_dsp_get (int address) { return S9xGetDSP((uint16) address); }
extern "C" void romdev_dsp_set (int byte, int address) { S9xSetDSP((uint8) byte, (uint16) address); }

/* the DSP-3's state as the reference serves it (romdev_chipstate.h) */
#define ROMDEV_CS_DSP3
#include "romdev_chipstate.h"
extern "C" int romdev_dsp3_chipstate (uint8 *o) { return (int) romdev_cs_dsp3(o); }

/* the DSP-1 / DSP-3 data ROM tables, from the cart's copy of the user's data
 * ROM (options.firmware; romdev_hledata.h) */
#define ROMDEV_HLEDATA_DSP
#include "romdev_hledata.h"
extern "C" int romdev_dsp_hledata (int dsp, const uint8 *data) { return romdev_hledata_install(dsp, data); }
