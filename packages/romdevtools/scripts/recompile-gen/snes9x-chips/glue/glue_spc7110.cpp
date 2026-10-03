/* The SPC7110 unit: snes9x's spc7110.cpp with byuu and neviksti's
 * spc7110emu.cpp and spc7110dec.cpp (which it includes). time() is the
 * cart's clock import. The $D0-$FF data ROM window is the cart's block map
 * (spc7110.js), rebuilt from dx/ex/fx_offset after a $4831-$4833 write. */
#include "glue_common.h"
#include "srtc.h"
#include "spc7110.h"
#include "spc7110emu.h"

struct SRTCData			RTCData;
struct SSPC7110Snapshot	s7snap;
extern SPC7110			s7emu;

/* SPC7110Decomp's constructor takes its 64-byte buffer from new[] */
static uint8 pool[SPC7110_DECOMP_BUFFER_SIZE];
void *operator new[] (size_t) { return pool; }
void operator delete[] (void *) noexcept {}

/* the global SPC7110 object's destructor never runs in a cart */
extern "C" int __cxa_atexit (void (*) (void *), void *, void *) { return 0; }
void *__dso_handle;

extern "C" void __wasm_call_ctors (void);

/* memmap.cpp InitROM: case 0xF93A: Settings.SPC7110RTC = TRUE; (fall through)
 * case 0xF53A: Settings.SPC7110 = TRUE; S9xInitSPC7110(); after the image is
 * in Memory.ROM (CalculatedSize bytes) */
extern "C" void romdev_spc7110_init (uint8 *rom, int size, int rtc)
{
	__wasm_call_ctors();
	Memory.ROM = rom;
	Memory.CalculatedSize = size;
	Settings.SPC7110RTC = rtc ? TRUE : FALSE;
	S9xInitSPC7110();
}
/* cpu.cpp S9xReset: if (Settings.SPC7110) S9xResetSPC7110(); */
extern "C" void romdev_spc7110_reset (void) { S9xResetSPC7110(); }
/* ppu.cpp S9xGetCPU / getset.h MAP_SPC7110_DRAM: S9xGetSPC7110(address) */
extern "C" int romdev_spc7110_get (int address) { return S9xGetSPC7110((uint16) address); }
/* ppu.cpp S9xSetCPU: if (Settings.SPC7110 && Address >= 0x4800) S9xSetSPC7110(Byte, Address); */
extern "C" void romdev_spc7110_set (int byte, int address) { S9xSetSPC7110((uint8) byte, (uint16) address); }
/* the data ROM offset of $D0, $E0 or $F0 (S9xGetSPC7110Byte) */
extern "C" int romdev_spc7110_offset (int which) { return which == 0 ? s7emu.dx_offset : which == 1 ? s7emu.ex_offset : s7emu.fx_offset; }

/* dma.cpp S9xDoDMA, "SPC7110": the transfer's bytes come from the
 * decompressor, and the remaining length at $4809/$480A drops by them */
extern "C" void romdev_spc7110_dma (uint8 *buf, int transferBytes)
{
	for (int i = 0; i < transferBytes; i++)
		buf[i] = s7emu.decomp.read();

	int32	icount = s7emu.r4809 | (s7emu.r480a << 8);
	icount -= transferBytes;
	s7emu.r4809 =  icount & 0x00ff;
	s7emu.r480a = (icount & 0xff00) >> 8;
}

/* the SPC7110's state as the reference serves it (romdev_chipstate.h) */
#define ROMDEV_CS_SPC7110
#include "romdev_chipstate.h"
extern "C" int romdev_spc7110_chipstate (uint8 *o) { return (int) romdev_cs_spc7110(o); }
/* RTCData.reg, the 20 bytes a frontend keeps as the cart's .rtc file
 * (libretro RETRO_MEMORY_RTC) */
extern "C" uint8 *romdev_spc7110_rtcdata (void) { return RTCData.reg; }
