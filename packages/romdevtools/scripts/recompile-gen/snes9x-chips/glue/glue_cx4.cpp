/* The CX4 unit: snes9x's c4.cpp and c4emu.cpp (the high-level C4 command
 * set), with emscripten's libc for the sin/cos/atan they call, as the
 * reference core links them. The chip's 8KB (Memory.C4RAM) is here; ROM
 * reads (C4GetMemPointer) go to the cart's image. */
#include "glue_common.h"
#include "c4.h"

static uint8 c4ram[0x2000];

/* memmap.cpp Init: C4RAM (the cart keeps it here); InitROM: case 0xF320:
 * Settings.C4 = TRUE; cpu.cpp S9xReset: if (Settings.C4) S9xInitC4(); */
extern "C" void romdev_c4_init (uint8 *rom)
{
	Memory.ROM = rom;
	Memory.C4RAM = c4ram;
	S9xInitC4();
}
/* getset.h MAP_C4: S9xGetC4(Address & 0xffff) / S9xSetC4(Byte, Address & 0xffff) */
extern "C" int romdev_c4_get (int address) { return S9xGetC4((uint16) address); }
extern "C" void romdev_c4_set (int byte, int address) { S9xSetC4((uint8) byte, (uint16) address); }
