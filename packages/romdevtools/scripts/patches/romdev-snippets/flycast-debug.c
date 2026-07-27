// ── romdev debug exports for flycast (Dreamcast: SH-4 cpuState + AICA audioDebug) ──
// Appended to shell/libretro/libretro.cpp by build-flycast.sh. Compiled as C++
// (extern "C" so the names aren't mangled). EMSCRIPTEN_KEEPALIVE + listed in
// EXPORTED_FUNCTIONS so LTO keeps them. The host's *Supported() checks just probe
// for these exports → cpu({op:'read'}) + audioDebug light up with the host plumbing.
//
// cpuState (romdev_sh4_regs_get → out[0..23]): a fixed SH-4 register block
//   0..15 = r[0..15], 16 = pc, 17 = pr, 18 = gbr, 19 = vbr, 20 = sr.status,
//   21 = mac.l, 22 = mac.h, 23 = fpul. Read from Sh4cntx (p_sh4rcb->cntx).
// audioDebug (romdev_aica_get → out[0..bytes-1]): the AICA register file
//   aica_reg[] (per-channel SGC regs at 0x000.., CommonData at 0x2800). Host reads
//   the low window (channels + common) for the audioDebug(chip:'aica') decode.
#include <emscripten.h>
#include "hw/sh4/sh4_if.h"
#include "hw/aica/aica_mem.h"

// C++-linkage externs (these globals are plain C++ symbols in rec_wasm.cpp /
// libretro.cpp, so declare them OUTSIDE extern "C" or the names won't resolve).
extern unsigned int kcode[4];
extern unsigned int g_shil_fb_call_count;  // rec_wasm.cpp: per-op interpreter fallbacks
extern unsigned int g_wasm_block_count;    // rec_wasm.cpp: total JIT blocks executed

extern "C" {

EMSCRIPTEN_KEEPALIVE void romdev_sh4_regs_get(unsigned int *out)
{
   int i;
   if (!out) return;
   for (i = 0; i < 16; i++) out[i] = Sh4cntx.r[i];
   out[16] = Sh4cntx.pc;
   out[17] = Sh4cntx.pr;
   out[18] = Sh4cntx.gbr;
   out[19] = Sh4cntx.vbr;
   out[20] = Sh4cntx.sr.status;
   out[21] = Sh4cntx.mac.l;
   out[22] = Sh4cntx.mac.h;
   out[23] = Sh4cntx.fpul;
}

EMSCRIPTEN_KEEPALIVE void romdev_aica_get(unsigned char *out, int bytes)
{
   int i;
   if (!out) return;
   if (bytes <= 0) bytes = 0x3000;          /* channels (0x000..) + CommonData (0x2800) */
   if (bytes > (int)sizeof(aica::aica_reg)) bytes = (int)sizeof(aica::aica_reg);
   for (i = 0; i < bytes; i++) out[i] = aica::aica_reg[i];
}

/* Live Maple controller button mask per port (post-UpdateInputState). kcode is
 * active-LOW (a pressed button is a 0 bit), so this reports what the game reads.
 * Debug-only: lets romdev verify setInput actually reaches the DC input path. */
EMSCRIPTEN_KEEPALIVE unsigned int romdev_jit_stats(int which){
   if (which==0) return g_shil_fb_call_count;
   if (which==1) return g_wasm_block_count;
   return 0;
}
EMSCRIPTEN_KEEPALIVE unsigned int romdev_dc_kcode_get(int port)
{
   if (port < 0 || port > 3) return 0xFFFFFFFFu;
   return kcode[port];
}

}
