
/* ── romdev: R4300 register snapshot (appended by build-parallel-n64.sh) ──────
 * EMSCRIPTEN_KEEPALIVE so LTO doesn't strip it (nothing calls it internally).
 * out[0..31]=GPR reg[0..31] low32, out[32]=LO, out[33]=HI, out[34]=PC(PC->addr).
 * romdev's getCPUState reads this via host.getMipsRegs(). */
#include <emscripten.h>
EMSCRIPTEN_KEEPALIVE void romdev_mips_regs_get(unsigned int *out)
{
   int i;
   for (i = 0; i < 32; i++) out[i] = (unsigned int)reg[i];
   out[32] = (unsigned int)lo;
   out[33] = (unsigned int)hi;
   out[34] = (PC ? PC->addr : 0);
}
