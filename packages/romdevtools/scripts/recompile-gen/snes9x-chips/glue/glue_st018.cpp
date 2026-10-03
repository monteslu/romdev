/* The ST018 unit: snes9x's seta018.cpp, which is snes9x's whole ST018
 * support (a command stub, not the ARM core): memmap.cpp map_SetaRISC puts
 * it at $3000-$3FFF of banks $00-$3F / $80-$BF (getset.h MAP_SETA_RISC ->
 * S9xGetST018 / S9xSetST018), and its writes land in Memory.SRAM. */
#include "glue_common.h"

struct SST010	ST010;
struct SST011	ST011;
struct SST018	ST018;

void CMemory::map_WriteProtectROM (void) {}

extern "C" void romdev_st018_bind (int sram) { Memory.SRAM = (uint8 *) (pint) sram; }
extern "C" int romdev_st018_get (int address) { return S9xGetST018((uint32) address); }
extern "C" void romdev_st018_set (int byte, int address) { S9xSetST018((uint8) byte, (uint32) address); }

/* the ST018 stub's state as the reference serves it (romdev_chipstate.h) */
#define ROMDEV_CS_SETA
#include "romdev_chipstate.h"
extern "C" int romdev_st018_chipstate (uint8 *o) { return (int) romdev_cs_st018(o); }
