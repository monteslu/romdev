/* ── romdev live-debug instrumentation for beetle_psx_hw (mednafen PSX, R3000A) ──
 * 0.80.0: a thin shim over the SHARED romdev_debug.c (the same lib every other
 * instrumented core links). Appended to mednafen/psx/cpu.c by build-beetle-psx-hw.sh,
 * where the GPR / BACKED_PC macros (→ the static s_cpu) are in scope. The shared lib
 * owns the watchpoint/readwatch/range/coverage/pcbreak/watchdog state + the host-probed
 * romdev_* exports; this shim keeps only the R3000 register snapshot + the call-site
 * adapters the hook injections invoke (WriteMemory_u8/16/32, ReadMemory_u8/16/32, the
 * CPU_RunReal dispatch loop). Main RAM is 2 MB mirrored → mask before the shared compare.
 *
 * NOTE: the WASM build sets HAVE_LIGHTREC=0, so CPU_RunReal (the interpreter) is the
 * live CPU path — the dispatch hook fires every instruction. */
#include "romdev_debug.h"

/* romdev at-hit register snapshot (R3000A) — per-core. Fills the shared
 * romdev_snap_regs[] in the romdev_getreg regId order the host's getRegSnapshot reads:
 * [0]=v0 [1..4]=a0-a3 [5..8]=t0-t3 [9..12]=s0-s3 [13]=sp [14]=ra [15]=gp [16]=fp
 * [17]=lo [18]=pc. (o32 MIPS: v0=2, a0-a3=4-7, t0-t3=8-11, s0-s3=16-19, gp=28, sp=29,
 * fp=30, ra=31; LO at GPR[32]; pc = BACKED_PC.) */
static void romdev_beetle_snap(int kind){
   int i; for(i=0;i<19;i++) romdev_snap_regs[i]=0;
   romdev_snap_regs[0]=GPR[2];
   romdev_snap_regs[1]=GPR[4]; romdev_snap_regs[2]=GPR[5];
   romdev_snap_regs[3]=GPR[6]; romdev_snap_regs[4]=GPR[7];
   romdev_snap_regs[5]=GPR[8]; romdev_snap_regs[6]=GPR[9];
   romdev_snap_regs[7]=GPR[10]; romdev_snap_regs[8]=GPR[11];
   romdev_snap_regs[9]=GPR[16]; romdev_snap_regs[10]=GPR[17];
   romdev_snap_regs[11]=GPR[18]; romdev_snap_regs[12]=GPR[19];
   romdev_snap_regs[13]=GPR[29]; romdev_snap_regs[14]=GPR[31];
   romdev_snap_regs[15]=GPR[28]; romdev_snap_regs[16]=GPR[30];
   romdev_snap_regs[17]=LO; romdev_snap_regs[18]=BACKED_PC;
   romdev_snap_kind=kind;
}

/* The hook sees the RAW address the instruction used (the WriteMemory_u8/16/32 hook is at
 * the function top, BEFORE mednafen masks the segment), so it's the same virtual address
 * the host arms via setWatchpoint(0x80xxxxxx) / watchRange — pass it through unmasked so
 * the shared lib's exact-address compare matches. (R3000 KUSEG/KSEG0/KSEG1 alias the same
 * RAM; the user arms whichever segment their code uses.) */

/* WriteMemory_u{8,16,32} → romdev_beetle_write(address, value). mednafen's write path
 * doesn't hand us the pre-write byte cheaply, so cond-watchpoints get oldv=0 (the plain
 * watch + range-write still work). PC of the writing instruction = BACKED_PC. */
void romdev_beetle_write(uint32_t address, uint32_t value){
   if(romdev_on_write(address, 0, (unsigned char)value, BACKED_PC, 0xFFFFFFFFu))
      romdev_beetle_snap(3);
}

/* ReadMemory_u{8,16,32} → romdev_beetle_read(address). */
void romdev_beetle_read(uint32_t address){
   if(romdev_on_read(address, 0, BACKED_PC))
      romdev_beetle_snap(4);
}

/* CPU_RunReal loop → romdev_beetle_step(PC). Returns 1 to FREEZE: the caller forces the
 * loop to exit (timestamp = next_event_ts) so retro_run returns with the CPU parked on
 * the un-executed break instruction; the shared lib's hit flag stops re-execution on the
 * next retro_run. Asks the shared lib (coverage + watchdog + pc-break/single-step). */
int romdev_beetle_step(uint32_t pc){
   if(romdev_on_dispatch(pc)){
      romdev_beetle_snap(romdev_pc_hit_kind()==2 ? 2 : 1);
      return 1;
   }
   return 0;
}
