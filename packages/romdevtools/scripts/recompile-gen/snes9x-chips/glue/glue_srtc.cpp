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
