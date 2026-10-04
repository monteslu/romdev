/* romdev: the ST011 and ST018 run on ares's chips inside snes9x.
 *
 * snes9x's ST011 is a high-level emulation that gives up after the opening
 * moves, and its ST018 is a command stub (the game stops at the board).
 * When the chip's firmware is in the system directory (st011.rom, the
 * uPD96050's 0xC000-byte program ROM then 0x1000-byte data ROM; st018.rom, the
 * ARM's 0x20000-byte program ROM then 0x8000-byte data ROM), this file runs
 * the chip on ares's own code instead: the uPD96050 and ARM cores and their
 * drivers in scripts/recompile-gen/ares-chips/glue (romdev_ares_chips.hpp),
 * the SAME files the recompiler compiles into a cart's chip unit, so a cart
 * and this core agree on the chip to the bit. Without the firmware snes9x's
 * own code runs as before. scripts/build-snes9x.sh copies this file and the
 * glue in; scripts/patches/snes9x-ares-chips.patch calls it from
 * memmap.cpp (InitROM), seta018.cpp (the $3000-$3FFF window), cpu.cpp
 * (S9xReset), cpuexec.cpp (the line end) and libretro.cpp (snes_chipstate).
 *
 * Licence: the chip code is ares's (ISC, Copyright (c) 2004-2025 ares team,
 * Near et al; the notice is in romdev's NOTICE). This file is romdev's. */
#include <stdio.h>
#include <string>
#include "snes9x.h"
#include "memmap.h"
#include "display.h"
#include "seta.h"
#include "fscompat.h"
#include "romdev_ares_chips.hpp"

extern uint8 OpenBus;

int romdev_fwchip = 0;  /* 0, 11 (ST011 on the uPD96050) or 18 (ST018 on the ARM) */
static uint8 romdev_fwchip_fw[0x28000];

/* the firmware file in the system directory, all of it or nothing */
static bool romdev_fwchip_read(const char *name, uint32 size)
{
	std::string path = S9xGetDirectory(BIOS_DIR) + SLASH_STR + name;
	FILE *f = fopen(path.c_str(), "rb");
	if (!f)
		return false;
	size_t n = fread(romdev_fwchip_fw, 1, size, f);
	int extra = fgetc(f);
	fclose(f);
	return n == size && extra == EOF;
}

/* memmap.cpp InitROM: the ST018 (0xF530) or ST011 (0xF630, ROM[0x7FD7] == 0x09) */
bool romdev_fwchip_select (int which)
{
	romdev_fwchip = 0;
	if (which == 11 && romdev_fwchip_read("st011.rom", 0xd000))
		romdev_fwchip = 11;
	else if (which == 18 && romdev_fwchip_read("st018.rom", 0x28000))
		romdev_fwchip = 18;
	return romdev_fwchip != 0;
}

/* cpu.cpp S9xReset: ares powers the chip with the system */
void romdev_fwchip_power (void)
{
	if (romdev_fwchip == 11)
		romdev_necdsp_init(11, romdev_fwchip_fw);
	else if (romdev_fwchip == 18)
		romdev_armdsp_init(romdev_fwchip_fw);
}

/* getset.h MAP_SETA_DSP through GetSETA / SetSETA (banks $60-$6F) */
uint8 romdev_fwchip_get_seta (uint32 Address)
{
	return (uint8) romdev_necdsp_read((int) Address, CPU.Cycles);
}

void romdev_fwchip_set_seta (uint32 Address, uint8 Byte)
{
	romdev_necdsp_write((int) Address, Byte, CPU.Cycles);
}

/* getset.h MAP_SETA_RISC ($3000-$3FFF): the bridge is $3800-$38FF, the rest
 * of the window is not the chip's (open bus, writes go nowhere) */
uint8 romdev_fwchip_get_risc (uint32 Address)
{
	int v = romdev_armdsp_read((int) Address, CPU.Cycles);
	return v < 0 ? OpenBus : (uint8) v;
}

void romdev_fwchip_set_risc (uint8 Byte, uint32 Address)
{
	romdev_armdsp_write((int) Address, Byte, CPU.Cycles);
}

/* cpuexec.cpp HC_HCOUNTER_MAX_EVENT, before CPU.Cycles -= Timings.H_Max */
void romdev_fwchip_line (void)
{
	if (romdev_fwchip == 11)
		romdev_necdsp_line(Timings.H_Max);
	else if (romdev_fwchip == 18)
		romdev_armdsp_line(Timings.H_Max);
}

/* libretro.cpp snes_chipstate (romdev_ares_chipstate.h's layout) */
unsigned romdev_fwchip_chipstate (uint8 *out)
{
	if (romdev_fwchip == 11)
		return (unsigned) romdev_necdsp_chipstate(out);
	if (romdev_fwchip == 18)
		return (unsigned) romdev_armdsp_chipstate(out);
	return 0;
}
