/* The ST010 / ST011 unit: snes9x's seta.cpp + seta010.cpp + seta011.cpp.
 * romdev_seta_init repeats memmap.cpp InitROM's 0xF630 case (the cart's
 * loader decodes it and passes ST_010 or ST_011). The chips work in the
 * cart's SRAM (Memory.SRAM / SRAMMask). */
#include "glue_common.h"

struct SST010	ST010;
struct SST011	ST011;
struct SST018	ST018;

void CMemory::map_WriteProtectROM (void) {}

extern "C" void romdev_seta_init (int seta, int sram, int sramMask)
{
	Memory.SRAM = (uint8 *) (pint) sram;
	Memory.SRAMMask = (uint32) sramMask;
	/* memmap.cpp InitROM: case 0xF630 */
	if (seta == ST_011)
	{
		SetSETA = &S9xSetST011;
		GetSETA = &S9xGetST011;
	}
	else
	{
		SetSETA = &S9xSetST010;
		GetSETA = &S9xGetST010;
	}
}

/* getset.h MAP_SETA_DSP: S9xGetSetaDSP(Address) / S9xSetSetaDSP(Byte, Address) */
extern "C" int romdev_seta_get (int address) { return S9xGetSetaDSP((uint32) address); }
extern "C" void romdev_seta_set (int byte, int address) { S9xSetSetaDSP((uint8) byte, (uint32) address); }

/* the ST010 / ST011's state as the reference serves it (romdev_chipstate.h; ST011 only) */
#define ROMDEV_CS_SETA
#include "romdev_chipstate.h"
extern "C" int romdev_st011_chipstate (uint8 *o) { return (int) romdev_cs_st011(o); }

/* the ST010's data ROM tables, from the cart's copy of the user's data ROM
 * (options.firmware; romdev_hledata.h) */
#define ROMDEV_HLEDATA_ST010
#include "romdev_hledata.h"
extern "C" int romdev_seta_hledata (const uint8 *data) { return romdev_hledata_install(10, data); }
