/* romdev live-debug instrumentation for PS1 (R3000). Appended by
   build-pcsx-rearmed.sh. Provides write/read watchpoints, a PC breakpoint +
   single-step, a range watch, and an at-hit register snapshot — the same shape
   as the fceumm/mgba romdev patches, so romdev's breakpoint/watch tools work. */
#include <stdint.h>
#include <emscripten.h>
#include "r3000a.h"

extern psxRegisters psxRegs;

/* ── write watchpoint ── */
uint32_t romdev_wp_addr = 0; int romdev_wp_enabled = 0;
uint32_t romdev_wp_last_pc = 0xFFFFFFFF, romdev_wp_last_val = 0, romdev_wp_hits = 0;
uint32_t romdev_wp_last_old = 0; int romdev_wp_cond = 0; uint32_t romdev_wp_cond_val = 0;

/* ── read watchpoint ── */
uint32_t romdev_rw_addr = 0; int romdev_rw_enabled = 0;
uint32_t romdev_rw_last_pc = 0xFFFFFFFF, romdev_rw_hits = 0;

/* ── pc breakpoint / single-step ── */
uint32_t romdev_pc_target = 0xFFFFFFFF; int romdev_pc_enabled = 0;
uint32_t romdev_pc_hit_pc = 0xFFFFFFFF; int romdev_pc_hit = 0;
int romdev_step_remaining = 0;   /* >0 = single-step N then halt */

/* ── range watch (ring buffer of (pc,addr,val)) ── */
#define ROMDEV_RANGE_CAP 4096
uint32_t romdev_range_lo = 0, romdev_range_hi = 0; int romdev_range_enabled = 0, romdev_range_kind = 2;
static uint32_t romdev_range_buf[ROMDEV_RANGE_CAP*3]; static uint32_t romdev_range_count = 0, romdev_range_total = 0;

/* ── at-hit register snapshot ── */
static uint32_t romdev_snap[21]; /* [kind,count,reg0..18] */

static void romdev_take_snap(int kind) {
   int i; romdev_snap[0] = kind; romdev_snap[1] = 19;
   /* MIPS: 16 of the most useful regs + pc. We pack v0,a0-a3,t0-t3,s0-s3,sp,ra,pc */
   romdev_snap[2]=psxRegs.GPR.n.v0; romdev_snap[3]=psxRegs.GPR.n.a0; romdev_snap[4]=psxRegs.GPR.n.a1;
   romdev_snap[5]=psxRegs.GPR.n.a2; romdev_snap[6]=psxRegs.GPR.n.a3; romdev_snap[7]=psxRegs.GPR.n.t0;
   romdev_snap[8]=psxRegs.GPR.n.t1; romdev_snap[9]=psxRegs.GPR.n.t2; romdev_snap[10]=psxRegs.GPR.n.t3;
   romdev_snap[11]=psxRegs.GPR.n.s0; romdev_snap[12]=psxRegs.GPR.n.s1; romdev_snap[13]=psxRegs.GPR.n.s2;
   romdev_snap[14]=psxRegs.GPR.n.s3; romdev_snap[15]=psxRegs.GPR.n.sp; romdev_snap[16]=psxRegs.GPR.n.ra;
   romdev_snap[17]=psxRegs.GPR.n.gp; romdev_snap[18]=psxRegs.GPR.n.fp; romdev_snap[19]=psxRegs.GPR.n.lo;
   romdev_snap[20]=psxRegs.pc;
}

EMSCRIPTEN_KEEPALIVE void romdev_watchpoint_set(uint32_t addr, int en){ romdev_wp_addr=addr; romdev_wp_enabled=en?1:0; romdev_wp_last_pc=0xFFFFFFFF; romdev_wp_last_val=0; romdev_wp_last_old=0; romdev_wp_cond=0; romdev_wp_cond_val=0; romdev_wp_hits=0; }
EMSCRIPTEN_KEEPALIVE void romdev_watchpoint_set_cond(uint32_t addr, int en, int cond, int val){ romdev_watchpoint_set(addr,en); romdev_wp_cond=cond; romdev_wp_cond_val=(uint32_t)val; }
EMSCRIPTEN_KEEPALIVE void romdev_watchpoint_get(uint32_t *o, int clear){ if(!o)return; o[0]=romdev_wp_enabled; o[1]=romdev_wp_addr; o[2]=romdev_wp_last_pc; o[3]=romdev_wp_last_val; o[4]=romdev_wp_hits; o[5]=0xFFFFFFFF; if(clear){ romdev_wp_hits=0; romdev_wp_last_pc=0xFFFFFFFF; } }
EMSCRIPTEN_KEEPALIVE void romdev_readwatch_set(uint32_t addr, int en){ romdev_rw_addr=addr; romdev_rw_enabled=en?1:0; romdev_rw_last_pc=0xFFFFFFFF; romdev_rw_hits=0; }
EMSCRIPTEN_KEEPALIVE void romdev_readwatch_get(uint32_t *o, int clear){ if(!o)return; o[0]=romdev_rw_enabled; o[1]=romdev_rw_addr; o[2]=romdev_rw_last_pc; o[3]=romdev_rw_hits; o[4]=0xFFFFFFFF; if(clear){ romdev_rw_hits=0; romdev_rw_last_pc=0xFFFFFFFF; } }
EMSCRIPTEN_KEEPALIVE void romdev_pcbreak_set(uint32_t pc, int en){ romdev_pc_target=pc; romdev_pc_enabled=en?1:0; romdev_pc_hit=0; romdev_pc_hit_pc=0xFFFFFFFF; romdev_step_remaining=0; }
EMSCRIPTEN_KEEPALIVE void romdev_pcbreak_get(uint32_t *o, int clear){ if(!o)return; o[0]=romdev_pc_enabled; o[1]=romdev_pc_target; o[2]=romdev_pc_hit; o[3]=romdev_pc_hit_pc; if(clear){ romdev_pc_hit=0; romdev_pc_hit_pc=0xFFFFFFFF; } }
EMSCRIPTEN_KEEPALIVE void romdev_range_set(uint32_t lo, uint32_t hi, int kind, int en){ romdev_range_lo=lo; romdev_range_hi=hi; romdev_range_kind=kind; romdev_range_enabled=en?1:0; romdev_range_count=0; romdev_range_total=0; }
EMSCRIPTEN_KEEPALIVE uint32_t romdev_range_get(uint32_t *o, uint32_t maxEntries, uint32_t *out2){ uint32_t n=romdev_range_count; if(n>maxEntries)n=maxEntries; if(o){ for(uint32_t i=0;i<n*3;i++) o[i]=romdev_range_buf[i]; } if(out2){ out2[0]=romdev_range_total; out2[1]=romdev_range_count; } return n; }
EMSCRIPTEN_KEEPALIVE void romdev_regsnap_get(uint32_t *o, int clear){ if(!o)return; for(int i=0;i<21;i++) o[i]=romdev_snap[i]; if(clear){ romdev_snap[0]=0; } }
EMSCRIPTEN_KEEPALIVE void romdev_watchdog_set(uint32_t n){ (void)n; }

/* hooks called from the memory write/read paths + the interpreter step */
void romdev_on_write(uint32_t mem, uint32_t val, uint32_t old){
   uint32_t a = mem & 0x1FFFFF; /* main RAM offset */
   if(romdev_wp_enabled && a==(romdev_wp_addr&0x1FFFFF)){
      int pass=1;
      if(romdev_wp_cond==1) pass=((val&0xFF)>(old&0xFF));
      else if(romdev_wp_cond==2) pass=((val&0xFF)<(old&0xFF));
      else if(romdev_wp_cond==3) pass=((val&0xFF)==(romdev_wp_cond_val&0xFF));
      if(pass){ romdev_wp_last_pc=psxRegs.pc; romdev_wp_last_val=val; romdev_wp_last_old=old; romdev_wp_hits++; romdev_take_snap(3); }
   }
   if(romdev_range_enabled && (romdev_range_kind&2) && a>=(romdev_range_lo&0x1FFFFF) && a<=(romdev_range_hi&0x1FFFFF)){
      romdev_range_total++;
      if(romdev_range_count<ROMDEV_RANGE_CAP){ uint32_t *e=&romdev_range_buf[romdev_range_count*3]; e[0]=psxRegs.pc; e[1]=mem; e[2]=val&0xFF; romdev_range_count++; }
   }
}
void romdev_on_read(uint32_t mem){
   uint32_t a = mem & 0x1FFFFF;
   if(romdev_rw_enabled && a==(romdev_rw_addr&0x1FFFFF)){ romdev_rw_last_pc=psxRegs.pc; romdev_rw_hits++; romdev_take_snap(4); }
   if(romdev_range_enabled && (romdev_range_kind&1) && a>=(romdev_range_lo&0x1FFFFF) && a<=(romdev_range_hi&0x1FFFFF)){
      romdev_range_total++;
      if(romdev_range_count<ROMDEV_RANGE_CAP){ uint32_t *e=&romdev_range_buf[romdev_range_count*3]; e[0]=psxRegs.pc; e[1]=mem; e[2]=0; romdev_range_count++; }
   }
}
/* returns 1 if the CPU should HALT before executing pc (pc-break or step-done) */
int romdev_on_step(uint32_t pc){
   if(romdev_pc_enabled && pc==romdev_pc_target){ romdev_pc_hit=1; romdev_pc_hit_pc=pc; romdev_take_snap(1); return 1; }
   if(romdev_step_remaining>0){ if(--romdev_step_remaining==0){ romdev_take_snap(1); return 1; } }
   return 0;
}

/* ── coverage (execution coverage of a PC range) ── */
static uint8_t romdev_cov_bits[0x200000/8]; uint32_t romdev_cov_lo=0, romdev_cov_hi=0; int romdev_cov_enabled=0;
EMSCRIPTEN_KEEPALIVE void romdev_cov_set(uint32_t lo, uint32_t hi, int en){ romdev_cov_lo=lo; romdev_cov_hi=hi; romdev_cov_enabled=en?1:0; if(en){ for(uint32_t i=0;i<sizeof(romdev_cov_bits);i++) romdev_cov_bits[i]=0; } }
EMSCRIPTEN_KEEPALIVE uint32_t romdev_cov_get(uint32_t *o, uint32_t maxEntries, uint32_t *out2){ uint32_t n=0; uint32_t lo=romdev_cov_lo&0x1FFFFF, hi=romdev_cov_hi&0x1FFFFF; for(uint32_t a=lo; a<=hi && n<maxEntries; a+=4){ if(romdev_cov_bits[(a>>2)>>3] & (1<<((a>>2)&7))){ if(o) o[n]=0x80000000|a; n++; } } if(out2){ out2[0]=n; out2[1]=n; } return n; }
void romdev_cov_mark(uint32_t pc){ if(!romdev_cov_enabled)return; uint32_t a=pc&0x1FFFFF; if(a>=(romdev_cov_lo&0x1FFFFF)&&a<=(romdev_cov_hi&0x1FFFFF)){ romdev_cov_bits[(a>>2)>>3] |= (1<<((a>>2)&7)); } }
