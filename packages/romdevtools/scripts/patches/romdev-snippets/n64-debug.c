/* romdev live-debug instrumentation for N64 (R4300). Appended by
   build-parallel-n64.sh. write/read watchpoints, PC break + single-step, range
   watch, coverage, at-hit register snapshot — so romdev's breakpoint/watch tools
   work. Big-endian; hooks into write_rdram_dram + the interpreter step. */
#include <stdint.h>
#include <emscripten.h>

extern int64_t reg[32], hi, lo;
struct precomp_instr; extern struct precomp_instr *PC;
/* precomp_instr's first field is uint32_t addr — read it via a cast */
static uint32_t cur_pc(void){ return PC ? *(uint32_t*)PC : 0; }

uint32_t romdev_wp_addr=0; int romdev_wp_enabled=0;
uint32_t romdev_wp_last_pc=0xFFFFFFFF, romdev_wp_last_val=0, romdev_wp_hits=0, romdev_wp_last_old=0; int romdev_wp_cond=0; uint32_t romdev_wp_cond_val=0;
uint32_t romdev_rw_addr=0; int romdev_rw_enabled=0; uint32_t romdev_rw_last_pc=0xFFFFFFFF, romdev_rw_hits=0;
uint32_t romdev_pc_target=0xFFFFFFFF; int romdev_pc_enabled=0; uint32_t romdev_pc_hit_pc=0xFFFFFFFF; int romdev_pc_hit=0, romdev_step_remaining=0;
#define ROMDEV_RANGE_CAP 4096
uint32_t romdev_range_lo=0, romdev_range_hi=0; int romdev_range_enabled=0, romdev_range_kind=2;
static uint32_t romdev_range_buf[ROMDEV_RANGE_CAP*3], romdev_range_count=0, romdev_range_total=0;
static uint32_t romdev_snap[21];

static void romdev_take_snap(int kind){
   romdev_snap[0]=kind; romdev_snap[1]=19;
   /* R4300: v0,a0-a3,t0-t3,s0-s3,sp,ra,gp,fp,lo,pc (low 32 bits) */
   romdev_snap[2]=(uint32_t)reg[2]; romdev_snap[3]=(uint32_t)reg[4]; romdev_snap[4]=(uint32_t)reg[5];
   romdev_snap[5]=(uint32_t)reg[6]; romdev_snap[6]=(uint32_t)reg[7]; romdev_snap[7]=(uint32_t)reg[8];
   romdev_snap[8]=(uint32_t)reg[9]; romdev_snap[9]=(uint32_t)reg[10]; romdev_snap[10]=(uint32_t)reg[11];
   romdev_snap[11]=(uint32_t)reg[16]; romdev_snap[12]=(uint32_t)reg[17]; romdev_snap[13]=(uint32_t)reg[18];
   romdev_snap[14]=(uint32_t)reg[19]; romdev_snap[15]=(uint32_t)reg[29]; romdev_snap[16]=(uint32_t)reg[31];
   romdev_snap[17]=(uint32_t)reg[28]; romdev_snap[18]=(uint32_t)reg[30]; romdev_snap[19]=(uint32_t)lo;
   romdev_snap[20]=cur_pc();
}

EMSCRIPTEN_KEEPALIVE void romdev_watchpoint_set(uint32_t a,int e){ romdev_wp_addr=a; romdev_wp_enabled=e?1:0; romdev_wp_last_pc=0xFFFFFFFF; romdev_wp_last_val=0; romdev_wp_last_old=0; romdev_wp_cond=0; romdev_wp_cond_val=0; romdev_wp_hits=0; }
EMSCRIPTEN_KEEPALIVE void romdev_watchpoint_set_cond(uint32_t a,int e,int c,int v){ romdev_watchpoint_set(a,e); romdev_wp_cond=c; romdev_wp_cond_val=(uint32_t)v; }
EMSCRIPTEN_KEEPALIVE void romdev_watchpoint_get(uint32_t *o,int cl){ if(!o)return; o[0]=romdev_wp_enabled; o[1]=romdev_wp_addr; o[2]=romdev_wp_last_pc; o[3]=romdev_wp_last_val; o[4]=romdev_wp_hits; o[5]=0xFFFFFFFF; if(cl){romdev_wp_hits=0;romdev_wp_last_pc=0xFFFFFFFF;} }
EMSCRIPTEN_KEEPALIVE void romdev_readwatch_set(uint32_t a,int e){ romdev_rw_addr=a; romdev_rw_enabled=e?1:0; romdev_rw_last_pc=0xFFFFFFFF; romdev_rw_hits=0; }
EMSCRIPTEN_KEEPALIVE void romdev_readwatch_get(uint32_t *o,int cl){ if(!o)return; o[0]=romdev_rw_enabled; o[1]=romdev_rw_addr; o[2]=romdev_rw_last_pc; o[3]=romdev_rw_hits; o[4]=0xFFFFFFFF; if(cl){romdev_rw_hits=0;romdev_rw_last_pc=0xFFFFFFFF;} }
EMSCRIPTEN_KEEPALIVE void romdev_pcbreak_set(uint32_t pc,int e){ romdev_pc_target=pc; romdev_pc_enabled=e?1:0; romdev_pc_hit=0; romdev_pc_hit_pc=0xFFFFFFFF; romdev_step_remaining=0; }
EMSCRIPTEN_KEEPALIVE void romdev_pcbreak_get(uint32_t *o,int cl){ if(!o)return; o[0]=romdev_pc_enabled; o[1]=romdev_pc_target; o[2]=romdev_pc_hit; o[3]=romdev_pc_hit_pc; if(cl){romdev_pc_hit=0;romdev_pc_hit_pc=0xFFFFFFFF;} }
EMSCRIPTEN_KEEPALIVE void romdev_range_set(uint32_t lo_,uint32_t hi_,int k,int e){ romdev_range_lo=lo_; romdev_range_hi=hi_; romdev_range_kind=k; romdev_range_enabled=e?1:0; romdev_range_count=0; romdev_range_total=0; }
EMSCRIPTEN_KEEPALIVE uint32_t romdev_range_get(uint32_t *o,uint32_t mx,uint32_t *o2){ uint32_t n=romdev_range_count; if(n>mx)n=mx; if(o){for(uint32_t i=0;i<n*3;i++)o[i]=romdev_range_buf[i];} if(o2){o2[0]=romdev_range_total;o2[1]=romdev_range_count;} return n; }
EMSCRIPTEN_KEEPALIVE void romdev_regsnap_get(uint32_t *o,int cl){ if(!o)return; for(int i=0;i<21;i++)o[i]=romdev_snap[i]; if(cl)romdev_snap[0]=0; }
EMSCRIPTEN_KEEPALIVE void romdev_watchdog_set(uint32_t n){ (void)n; }
/* coverage */
static uint8_t romdev_cov_bits[0x400000/8]; uint32_t romdev_cov_lo=0, romdev_cov_hi=0; int romdev_cov_enabled=0;
EMSCRIPTEN_KEEPALIVE void romdev_cov_set(uint32_t lo_,uint32_t hi_,int e){ romdev_cov_lo=lo_; romdev_cov_hi=hi_; romdev_cov_enabled=e?1:0; if(e)for(uint32_t i=0;i<sizeof(romdev_cov_bits);i++)romdev_cov_bits[i]=0; }
EMSCRIPTEN_KEEPALIVE uint32_t romdev_cov_get(uint32_t *o,uint32_t mx,uint32_t *o2){ uint32_t n=0,lo_=romdev_cov_lo&0x3FFFFF,hi_=romdev_cov_hi&0x3FFFFF; for(uint32_t a=lo_;a<=hi_&&n<mx;a+=4){ if(romdev_cov_bits[(a>>2)>>3]&(1<<((a>>2)&7))){ if(o)o[n]=0x80000000|a; n++; } } if(o2){o2[0]=n;o2[1]=n;} return n; }

/* hooks */
void romdev_on_write(uint32_t mem,uint32_t val,uint32_t old){
   uint32_t a=mem&0x7FFFFF; uint32_t pc=cur_pc();
   if(romdev_wp_enabled && a==(romdev_wp_addr&0x7FFFFF)){
      int pass=1; if(romdev_wp_cond==1)pass=((val&0xFF)>(old&0xFF)); else if(romdev_wp_cond==2)pass=((val&0xFF)<(old&0xFF)); else if(romdev_wp_cond==3)pass=((val&0xFF)==(romdev_wp_cond_val&0xFF));
      if(pass){ romdev_wp_last_pc=pc; romdev_wp_last_val=val; romdev_wp_last_old=old; romdev_wp_hits++; romdev_take_snap(3); }
   }
   if(romdev_range_enabled && (romdev_range_kind&2) && a>=(romdev_range_lo&0x7FFFFF) && a<=(romdev_range_hi&0x7FFFFF)){
      romdev_range_total++; if(romdev_range_count<ROMDEV_RANGE_CAP){ uint32_t *e=&romdev_range_buf[romdev_range_count*3]; e[0]=pc; e[1]=mem; e[2]=val&0xFF; romdev_range_count++; }
   }
}
void romdev_on_read(uint32_t mem){
   uint32_t a=mem&0x7FFFFF; uint32_t pc=cur_pc();
   if(romdev_rw_enabled && a==(romdev_rw_addr&0x7FFFFF)){ romdev_rw_last_pc=pc; romdev_rw_hits++; romdev_take_snap(4); }
   if(romdev_range_enabled && (romdev_range_kind&1) && a>=(romdev_range_lo&0x7FFFFF) && a<=(romdev_range_hi&0x7FFFFF)){
      romdev_range_total++; if(romdev_range_count<ROMDEV_RANGE_CAP){ uint32_t *e=&romdev_range_buf[romdev_range_count*3]; e[0]=pc; e[1]=mem; e[2]=0; romdev_range_count++; }
   }
}
int romdev_on_step(uint32_t pc){
   if(romdev_cov_enabled){ uint32_t a=pc&0x3FFFFF; if(a>=(romdev_cov_lo&0x3FFFFF)&&a<=(romdev_cov_hi&0x3FFFFF)) romdev_cov_bits[(a>>2)>>3]|=(1<<((a>>2)&7)); }
   if(romdev_pc_enabled && pc==romdev_pc_target){ romdev_pc_hit=1; romdev_pc_hit_pc=pc; romdev_take_snap(1); return 1; }
   if(romdev_step_remaining>0){ if(--romdev_step_remaining==0){ romdev_take_snap(1); return 1; } }
   return 0;
}
