
/* ── romdev: R3000 register snapshot (appended by build-pcsx-rearmed.sh) ──────
 * EMSCRIPTEN_KEEPALIVE so LTO doesn't strip it.
 * out[0..33]=GPR.r[0..33] (32 GPRs + LO at 32 + HI at 33), out[34]=pc.
 * romdev's getCPUState reads this via host.getMipsRegs(). */
#include <emscripten.h>
EMSCRIPTEN_KEEPALIVE void romdev_mips_regs_get(unsigned int *out)
{
   int i;
   for (i = 0; i < 34; i++) out[i] = psxRegs.GPR.r[i];
   out[34] = psxRegs.pc;
}
