/* The OBC1 unit: snes9x's obc1.cpp on the cart's 8KB OBC1 RAM
 * (snes9x Memory.OBC1RAM). */
#include "glue_common.h"

struct SOBC1	OBC1;

void CMemory::map_WriteProtectROM (void) {}

extern "C" void romdev_obc1_bind (int obc1ram) { Memory.OBC1RAM = (uint8 *) (pint) obc1ram; }
/* cpu.cpp S9xReset: if (Settings.OBC1) S9xResetOBC1(); */
extern "C" void romdev_obc1_reset (void) { S9xResetOBC1(); }
/* getset.h MAP_OBC_RAM: S9xGetOBC1(Address & 0xffff) / S9xSetOBC1(Byte, Address & 0xffff) */
extern "C" int romdev_obc1_get (int address) { return S9xGetOBC1((uint16) address); }
extern "C" void romdev_obc1_set (int byte, int address) { S9xSetOBC1((uint8) byte, (uint16) address); }
