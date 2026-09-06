/* romdev live-debug instrumentation for N64 (R4300) — 0.80.0: now a THIN per-core
   shim over the shared romdev_debug.c (the same lib the 10 classic cores link). All
   the watchpoint/readwatch/range/coverage/pcbreak/watchdog state + the host-probed
   romdev_* exports live in the shared lib; this file keeps only the R4300 register
   snapshot + the adapter hooks the core's call sites invoke (write_rdram_dram, the
   pure-interpreter step). Big-endian R4300; RDRAM is mirrored, so addresses are
   masked to the physical window before the shared compare. Appended by
   build-parallel-n64.sh into mupen64plus-core/src/r4300/. */
#include <stdint.h>
#include "romdev_debug.h"
#include <stdlib.h>

extern int64_t reg[32], hi, lo;
struct precomp_instr; extern struct precomp_instr *PC;
/* precomp_instr's first field is uint32_t addr — read it via a cast */
static uint32_t cur_pc(void){ return PC ? *(uint32_t*)PC : 0; }

/* romdev at-hit register snapshot (R4300) — per-core. Fills the shared
   romdev_snap_regs[] in the romdev_getreg regId order the host's getRegSnapshot
   reads: [0]=v0 [1..4]=a0-a3 [5..8]=t0-t3 [9..12]=s0-s3 [13]=sp [14]=ra [15]=gp
   [16]=fp [17]=lo [18]=pc(low32). The shared lib packs out[1]=19 + out[2..20]. */
static void romdev_n64_snap(int kind){
   int i; for(i=0;i<19;i++) romdev_snap_regs[i]=0;
   romdev_snap_regs[0]=(uint32_t)reg[2];
   romdev_snap_regs[1]=(uint32_t)reg[4]; romdev_snap_regs[2]=(uint32_t)reg[5];
   romdev_snap_regs[3]=(uint32_t)reg[6]; romdev_snap_regs[4]=(uint32_t)reg[7];
   romdev_snap_regs[5]=(uint32_t)reg[8]; romdev_snap_regs[6]=(uint32_t)reg[9];
   romdev_snap_regs[7]=(uint32_t)reg[10]; romdev_snap_regs[8]=(uint32_t)reg[11];
   romdev_snap_regs[9]=(uint32_t)reg[16]; romdev_snap_regs[10]=(uint32_t)reg[17];
   romdev_snap_regs[11]=(uint32_t)reg[18]; romdev_snap_regs[12]=(uint32_t)reg[19];
   romdev_snap_regs[13]=(uint32_t)reg[29]; romdev_snap_regs[14]=(uint32_t)reg[31];
   romdev_snap_regs[15]=(uint32_t)reg[28]; romdev_snap_regs[16]=(uint32_t)reg[30];
   romdev_snap_regs[17]=(uint32_t)lo; romdev_snap_regs[18]=cur_pc();
   romdev_snap_kind=kind;
}

/* RDRAM mirror canon — match the physical window so a host-set $00xxxxxx watch
   catches the mirrored access (and vice versa). */
#define ROMDEV_N64_CANON(x) ((uint32_t)((x) & 0x7FFFFF))

/* ── the call-site adapters the core invokes (named romdev_n64_* so they don't
      collide with the shared lib's own romdev_on_write/on_read/on_dispatch) ───── */

/* write_rdram_dram → romdev_n64_write(address, value). The N64 write path doesn't read
   back the pre-write byte, so cond-watchpoints get oldv=0 (informational; the plain
   watch + range-write still work). */
void romdev_n64_write(uint32_t mem, uint32_t val){
   if(romdev_on_write(ROMDEV_N64_CANON(mem), 0, (unsigned char)val, cur_pc(), 0xFFFFFFFFu))
      romdev_n64_snap(3);
}

/* pure_interpreter step → romdev_n64_step(PC->addr). Returns 1 to FREEZE (the caller
   sets stop=1 + breaks). Asks the shared lib (coverage + watchdog + pc-break/step). */
int romdev_n64_step(uint32_t pc){
   if(romdev_on_dispatch(pc)){
      romdev_n64_snap(romdev_pc_hit_kind()==2 ? 2 : 1);
      return 1;
   }
   return 0;
}

/* A PC-break / single-step / watchdog hit yields to the frontend the same way the
   VI frame end does (co_switch to main_thread inside retro_return), so retro_run
   returns to the host with the CPU stopped AT the hit PC and the next retro_run
   resumes right here. Never `stop = 1`: that ends the emulation thread for good. */
extern int retro_return(int just_flipping);
/* This build has NO_LIBCO: there is no second thread. retro_return(0) records that the
   CPU loop must stop for this frame (stop_stepping = 1, flip_only = 0) and RETURNS; the
   CPU loop then `break`s, EmuThreadStep() returns, emu_step_render() finds nothing
   flipped and retro_run exits with the last frame duped. The CPU is stopped AT the hit
   PC (the instruction did not execute) and the next retro_run re-enters the loop
   there. A `while (hook) yield;` here would spin forever: nothing else runs. */
void romdev_n64_yield(void){ retro_return(0); }
