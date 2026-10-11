/* romdev additions to bsnes's libretro target (scripts/build-bsnes.sh copies
 * this file next to libretro.cpp; scripts/patches/bsnes-romdev.patch includes
 * it at the end of libretro.cpp and renames the entry points below to
 * romdev_impl_*).
 *
 * 1. Cothreads. bsnes runs every chip as a libco cothread. romdev's libco
 *    backend for WebAssembly (libco/wasm.c, from scripts/patches/libco-wasm/
 *    libco-wasm.c) switches inside romdev_co_run(), so every libretro entry
 *    point that can reach the scheduler runs through it.
 *
 * 2. Memory regions, with the IDs romdev's snes9x patch uses
 *    (scripts/patches/snes9x-romdev-memory-regions.patch), so the same region
 *    names read the same things on either core:
 *      RETRO_MEMORY_SAVE_RAM    cartridge RAM
 *      RETRO_MEMORY_SYSTEM_RAM  128KB WRAM
 *      RETRO_MEMORY_VIDEO_RAM   64KB VRAM
 *      0x110 snes_oam           544B OAM as the CPU reads it
 *      0x111 snes_cgram         512B CGRAM, 15-bit words little-endian
 *      0x112 snes_aram          64KB SPC700 RAM
 *      0x1B9 snes_chipstate     the ST010/ST011 (uPD96050) or ST018 (ARM)
 *                               state, in the layout of romdev_bsnes_chipstate.h,
 *                               the file the recompiler's chip units use too
 *    OAM, CGRAM and the chip state are copies refreshed after every entry
 *    point; the others are bsnes's own arrays. The regions are served by
 *    romdev_bsnes_sfc.cpp, compiled inside bsnes's sfc/interface/interface.cpp
 *    (the libretro translation unit does not see bsnes's chip objects).
 */

extern "C" void romdev_co_run(void (*root)(void));
extern "C" void romdev_bsnes_snapshot(void);
extern "C" void* romdev_bsnes_region_data(unsigned id);
extern "C" size_t romdev_bsnes_region_size(unsigned id);

static void romdev_snapshot()
{
	if(emulator && emulator->loaded()) romdev_bsnes_snapshot();
}



/* ---- entry points, each run as the host cothread ---- */

static void romdev_root_run() { romdev_impl_retro_run(); }
RETRO_API void retro_run()
{
	romdev_co_run(romdev_root_run);
	romdev_snapshot();
}

static size_t romdev_size_result;
static void romdev_root_serialize_size() { romdev_size_result = romdev_impl_retro_serialize_size(); }
RETRO_API size_t retro_serialize_size()
{
	romdev_co_run(romdev_root_serialize_size);
	return romdev_size_result;
}

static void *romdev_ser_data;
static const void *romdev_unser_data;
static size_t romdev_ser_size;
static bool romdev_bool_result;
static void romdev_root_serialize() { romdev_bool_result = romdev_impl_retro_serialize(romdev_ser_data, romdev_ser_size); }
RETRO_API bool retro_serialize(void *data, size_t size)
{
	romdev_ser_data = data; romdev_ser_size = size;
	romdev_co_run(romdev_root_serialize);
	return romdev_bool_result;
}

static void romdev_root_unserialize() { romdev_bool_result = romdev_impl_retro_unserialize(romdev_unser_data, romdev_ser_size); }
RETRO_API bool retro_unserialize(const void *data, size_t size)
{
	romdev_unser_data = data; romdev_ser_size = size;
	romdev_co_run(romdev_root_unserialize);
	romdev_snapshot();
	return romdev_bool_result;
}

static void romdev_root_reset() { romdev_impl_retro_reset(); }
RETRO_API void retro_reset()
{
	romdev_co_run(romdev_root_reset);
	romdev_snapshot();
}

// a firmware file the cart needs and romdev does not ship (sfc/interface/romdev_bsnes_sfc.cpp)
namespace SuperFamicom { extern char romdev_load_error[512]; }

static const retro_game_info *romdev_game;
static void romdev_root_load_game() { romdev_bool_result = romdev_impl_retro_load_game(romdev_game); }
RETRO_API bool retro_load_game(const retro_game_info *game)
{
	SuperFamicom::romdev_load_error[0] = 0;
	romdev_game = game;
	romdev_co_run(romdev_root_load_game);
	romdev_snapshot();
	// a firmware file the cart needs is not in the system directory: refused, with the file named
	if (romdev_bool_result && SuperFamicom::romdev_load_error[0]) {
		if (libretro_print) libretro_print(RETRO_LOG_ERROR, SuperFamicom::romdev_load_error);
		return false;
	}
	return romdev_bool_result;
}

static void romdev_root_unload_game() { romdev_impl_retro_unload_game(); }
RETRO_API void retro_unload_game()
{
	romdev_co_run(romdev_root_unload_game);
}

/* ---- memory regions ---- */

RETRO_API void *retro_get_memory_data(unsigned id)
{
	if(!emulator || !emulator->loaded()) return nullptr;
	return romdev_bsnes_region_data(id);
}

RETRO_API size_t retro_get_memory_size(unsigned id)
{
	if(!emulator || !emulator->loaded()) return 0;
	return romdev_bsnes_region_size(id);
}
