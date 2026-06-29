/* romdev live-debug instrumentation for PS1 (R3000) — 0.80.0: now a THIN per-core
   shim over the shared romdev_debug.c (the same lib the classic cores link). All the
   watchpoint/readwatch/range/coverage/pcbreak/watchdog state + the host-probed romdev_*
   exports live in the shared lib; this file keeps only the R3000 register snapshot +
   the adapter hooks the core's call sites invoke (psxmem write/read, the interpreter
   step). Main RAM is 2 MB mirrored, so addresses are masked before the shared compare.
   Appended by build-pcsx-rearmed.sh into libpcsxcore/. */
#include <stdint.h>
#include "r3000a.h"
#include "romdev_debug.h"

extern psxRegisters psxRegs;

/* romdev at-hit register snapshot (R3000) — per-core. Fills the shared
   romdev_snap_regs[] in the romdev_getreg regId order the host's getRegSnapshot reads:
   [0]=v0 [1..4]=a0-a3 [5..8]=t0-t3 [9..12]=s0-s3 [13]=sp [14]=ra [15]=gp [16]=fp
   [17]=lo [18]=pc. The shared lib packs out[1]=19 + out[2..20]. */
static void romdev_ps1_snap(int kind){
   int i; for(i=0;i<19;i++) romdev_snap_regs[i]=0;
   romdev_snap_regs[0]=psxRegs.GPR.n.v0;
   romdev_snap_regs[1]=psxRegs.GPR.n.a0; romdev_snap_regs[2]=psxRegs.GPR.n.a1;
   romdev_snap_regs[3]=psxRegs.GPR.n.a2; romdev_snap_regs[4]=psxRegs.GPR.n.a3;
   romdev_snap_regs[5]=psxRegs.GPR.n.t0; romdev_snap_regs[6]=psxRegs.GPR.n.t1;
   romdev_snap_regs[7]=psxRegs.GPR.n.t2; romdev_snap_regs[8]=psxRegs.GPR.n.t3;
   romdev_snap_regs[9]=psxRegs.GPR.n.s0; romdev_snap_regs[10]=psxRegs.GPR.n.s1;
   romdev_snap_regs[11]=psxRegs.GPR.n.s2; romdev_snap_regs[12]=psxRegs.GPR.n.s3;
   romdev_snap_regs[13]=psxRegs.GPR.n.sp; romdev_snap_regs[14]=psxRegs.GPR.n.ra;
   romdev_snap_regs[15]=psxRegs.GPR.n.gp; romdev_snap_regs[16]=psxRegs.GPR.n.fp;
   romdev_snap_regs[17]=psxRegs.GPR.n.lo; romdev_snap_regs[18]=psxRegs.pc;
   romdev_snap_kind=kind;
}

/* 2 MB main-RAM mirror canon — match the physical window so a host-set watch catches
   the mirrored access (and vice versa). */
#define ROMDEV_PS1_CANON(x) ((uint32_t)((x) & 0x1FFFFF))

/* ── the call-site adapters (named romdev_ps1_* so they don't collide with the shared
      lib's own romdev_on_write/on_read/on_dispatch) ───────────────────────────── */

/* psxmem store → romdev_ps1_write(mem, value, oldbyte). The PS1 write path captures the
   pre-write byte, so cond-watchpoints get a real oldv. */
void romdev_ps1_write(uint32_t mem, uint32_t val, uint32_t old){
   if(romdev_on_write(ROMDEV_PS1_CANON(mem), (unsigned char)old,
                      (unsigned char)val, psxRegs.pc, 0xFFFFFFFFu))
      romdev_ps1_snap(3);
}

/* psxmem load → romdev_ps1_read(mem). */
void romdev_ps1_read(uint32_t mem){
   if(romdev_on_read(ROMDEV_PS1_CANON(mem), 0, psxRegs.pc))
      romdev_ps1_snap(4);
}

/* interpreter step → romdev_ps1_step(regs->pc). Returns 1 to FREEZE (the caller sets
   regs->stop=1 + returns). Asks the shared lib (coverage + watchdog + pc-break/step). */
int romdev_ps1_step(uint32_t pc){
   if(romdev_on_dispatch(pc)){
      romdev_ps1_snap(romdev_pc_hit_kind()==2 ? 2 : 1);
      return 1;
   }
   return 0;
}

/* coverage is folded into romdev_on_dispatch now, so the old per-step cov mark is a
   no-op (kept so the interpreter call site needs no edit). */
void romdev_cov_mark(uint32_t pc){ (void)pc; }
