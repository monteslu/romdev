/* The S-RTC unit: snes9x's srtc.cpp (with byuu's srtcemu.cpp, which it
 * includes). time() is the cart's clock import. */
#include "glue_common.h"
#include "srtc.h"

struct SRTCData		RTCData;
struct SSRTCSnapshot	srtcsnap;

void CMemory::map_WriteProtectROM (void) {}

/* memmap.cpp InitROM: case 0x5535: Settings.SRTC = TRUE; S9xInitSRTC(); */
extern "C" void romdev_srtc_init (void) { Settings.SRTC = TRUE; S9xInitSRTC(); }
/* cpu.cpp S9xReset: if (Settings.SRTC) S9xResetSRTC(); */
extern "C" void romdev_srtc_reset (void) { S9xResetSRTC(); }
/* ppu.cpp: $2800 reads S9xGetSRTC, $2801 writes S9xSetSRTC */
extern "C" int romdev_srtc_get (int address) { return S9xGetSRTC((uint16) address); }
extern "C" void romdev_srtc_set (int byte, int address) { S9xSetSRTC((uint8) byte, (uint16) address); }

/* the S-RTC's state as the reference serves it (romdev_chipstate.h) */
#define ROMDEV_CS_SRTC
#include "romdev_chipstate.h"
extern "C" int romdev_srtc_chipstate (uint8 *o) { return (int) romdev_cs_srtc(o); }
/* RTCData.reg, the 20 bytes a frontend keeps as the cart's .rtc file
 * (libretro RETRO_MEMORY_RTC) */
extern "C" uint8 *romdev_srtc_rtcdata (void) { return RTCData.reg; }
