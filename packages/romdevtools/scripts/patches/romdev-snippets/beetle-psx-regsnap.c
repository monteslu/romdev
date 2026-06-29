/* ── romdev: R3000A register snapshot for beetle_psx_hw (cpuState) ───────────
 * Appended to mednafen/psx/cpu.c by build-beetle-psx-hw.sh, where the GPR /
 * BACKED_PC macros (resolving to the static s_cpu) are in scope.
 * EMSCRIPTEN_KEEPALIVE + listed in EXPORTED_FUNCTIONS so LTO keeps it.
 *
 * out[0..33] = GPR_full[0..33] (r0..r31, LO at 32, HI at 33),
 * out[34]    = BACKED_PC (the live PC). Matches the host's getMipsRegs()
 *              35-u32 layout (r0..r31, LO, HI, pc).
 * (The SPU reader lives in spu.c — romdev_spu_get — where the raw `regs` mirror
 *  is in scope; see beetle-psx-spu.c.)
 */
#include <emscripten.h>

EMSCRIPTEN_KEEPALIVE void romdev_mips_regs_get(unsigned int *out)
{
   int i;
   if (!out) return;
   /* GPR / BACKED_PC are #defines in cpu.c that resolve to s_cpu.* — use them so
    * the read hits the live register file (PSX_CPU points at the same s_cpu). */
   for (i = 0; i < 34; i++) out[i] = GPR[i];
   out[34] = BACKED_PC;
}
