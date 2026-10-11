/* romdev: bsnes's memory regions for the libretro target
 * (target-libretro/romdev_bsnes.cpp). scripts/build-bsnes.sh copies this file
 * to sfc/interface/romdev_bsnes_sfc.cpp; the patch includes it at the end of
 * sfc/interface/interface.cpp, which sees every chip object. */

#include "romdev_bsnes_chipstate.h"

#define ROMDEV_MEMORY_SNES_OAM       0x110
#define ROMDEV_MEMORY_SNES_CGRAM     0x111
#define ROMDEV_MEMORY_SNES_ARAM      0x112
#define ROMDEV_MEMORY_SNES_CHIPSTATE 0x1B9
#define ROMDEV_MEMORY_SNES_CHIPLOG   0x1BB

namespace SuperFamicom {

/* a firmware file the cart needs and romdev does not ship (sfc/cartridge/load.cpp,
 * sfc/coprocessor/icd/icd.cpp): retro_load_game refuses the cart with it
 * (target-libretro/romdev_bsnes.cpp) */
char romdev_load_error[512];

/* the accurate PPU keeps OAM, CGRAM and VRAM private, and the S-CPU its
 * master clock count (ppu.hpp and cpu.hpp name this struct a friend) */
struct RomdevAccess {
	static uint32_t cpuClock() { return cpu.counter.cpu; }
	static uint8_t oam(uint n) { return ppu.obj.oam.read(n); }
	static uint16_t cgram(uint n) { return ppu.screen.cgram[n]; }
	static void* vram() { return (void*)&ppu.vram.data[0]; }
};

static uint8_t romdev_oam[544];
static uint8_t romdev_cgram[512];
static uint8_t romdev_chipstate[ROMDEV_BSNES_CHIPSTATE_MAX];
static size_t romdev_chipstate_size = 0;

/* snes_chiplog: every S-CPU access to a firmware chip (necdsp.cpp / armdsp.cpp
 * call romdev_chiplog), for checking a transplant of the chip against bsnes
 * by replaying the S-CPU side into it. A ring of 12-byte entries after an
 * 8-byte header {u32 entries ever written, u32 capacity}; an entry is
 * {u32 S-CPU master clock count (CPU counter.cpu, wraps), u32 address |
 * kind << 24, u32 data}: kind 0 read DR/SR (address A0 = SR), 1 write DR/SR,
 * 2 read data RAM, 3 write data RAM (address = the 12-bit RAM address), 4 the
 * chip powered on (its clock is 0 here); for the ARM 0 / 1 are the bridge at
 * $3800-$38FF (address & 0xff06). Reads log the byte they returned. */
enum : uint32_t { RomdevChiplogCapacity = 1u << 18 };
static uint32_t romdev_chiplog_buf[2 + RomdevChiplogCapacity * 3];

auto romdev_chiplog(uint kind, uint addr, uint8 data) -> void {
	uint32_t n = romdev_chiplog_buf[0];
	uint32_t* e = &romdev_chiplog_buf[2 + (n % RomdevChiplogCapacity) * 3];
	e[0] = RomdevAccess::cpuClock();
	e[1] = (addr & 0xffffff) | kind << 24;
	e[2] = data;
	romdev_chiplog_buf[0] = n + 1;
	romdev_chiplog_buf[1] = RomdevChiplogCapacity;
}

}

extern "C" void romdev_bsnes_snapshot(void)
{
	using namespace SuperFamicom;
	if(SuperFamicom::system.fastPPU()) {
		for(uint n = 0; n < 544; n++) romdev_oam[n] = ppufast.readObject(n);
		for(uint n = 0; n < 256; n++) {
			romdev_cgram[n * 2 + 0] = ppufast.cgram[n] >> 0;
			romdev_cgram[n * 2 + 1] = ppufast.cgram[n] >> 8;
		}
	} else {
		for(uint n = 0; n < 544; n++) romdev_oam[n] = RomdevAccess::oam(n);
		for(uint n = 0; n < 256; n++) {
			uint16_t w = RomdevAccess::cgram(n);
			romdev_cgram[n * 2 + 0] = w >> 0;
			romdev_cgram[n * 2 + 1] = w >> 8;
		}
	}
	romdev_chipstate_size = 0;
	if(cartridge.has.NECDSP && necdsp.revision == Processor::uPD96050::Revision::uPD96050)
		romdev_chipstate_size = romdev_bsnes_cs_upd96050(romdev_chipstate, necdsp, necdsp.clock);
	else if(cartridge.has.ARMDSP)
		romdev_chipstate_size = romdev_bsnes_cs_armdsp(romdev_chipstate, armdsp, armdsp.processor, armdsp.pipeline,
			armdsp.bridge, armdsp.programRAM, sizeof(armdsp.programRAM), armdsp.clock);
}

extern "C" void* romdev_bsnes_region_data(unsigned id)
{
	using namespace SuperFamicom;
	switch(id) {
	case 0: return cartridge.ram.size() ? cartridge.ram.data() : nullptr;       /* RETRO_MEMORY_SAVE_RAM */
	case 2: return cpu.wram;                                                      /* RETRO_MEMORY_SYSTEM_RAM */
	case 3: return SuperFamicom::system.fastPPU() ? (void*)ppufast.vram : RomdevAccess::vram(); /* RETRO_MEMORY_VIDEO_RAM */
	case ROMDEV_MEMORY_SNES_OAM: return romdev_oam;
	case ROMDEV_MEMORY_SNES_CGRAM: return romdev_cgram;
	case ROMDEV_MEMORY_SNES_ARAM: return dsp.apuram;
	case ROMDEV_MEMORY_SNES_CHIPSTATE: return romdev_chipstate_size ? romdev_chipstate : nullptr;
	case ROMDEV_MEMORY_SNES_CHIPLOG: return (cartridge.has.NECDSP || cartridge.has.ARMDSP) ? romdev_chiplog_buf : nullptr;
	}
	return nullptr;
}

extern "C" size_t romdev_bsnes_region_size(unsigned id)
{
	using namespace SuperFamicom;
	switch(id) {
	case 0: return cartridge.ram.size();
	case 2: return sizeof(cpu.wram);
	case 3: return 64 * 1024;
	case ROMDEV_MEMORY_SNES_OAM: return sizeof(romdev_oam);
	case ROMDEV_MEMORY_SNES_CGRAM: return sizeof(romdev_cgram);
	case ROMDEV_MEMORY_SNES_ARAM: return sizeof(dsp.apuram);
	case ROMDEV_MEMORY_SNES_CHIPSTATE: return romdev_chipstate_size;
	case ROMDEV_MEMORY_SNES_CHIPLOG: return (cartridge.has.NECDSP || cartridge.has.ARMDSP) ? sizeof(romdev_chiplog_buf) : 0;
	}
	return 0;
}
