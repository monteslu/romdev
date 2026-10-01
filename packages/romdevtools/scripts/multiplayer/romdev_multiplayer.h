/* SPDX-License-Identifier: GPL-2.0-only
 * Versioned deterministic-state helpers for the pinned libretro cores.
 */
#ifndef ROMDEV_MULTIPLAYER_H
#define ROMDEV_MULTIPLAYER_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <time.h>
#ifdef __cplusplus
extern "C" {
#endif
extern uint32_t romdev_clock_enabled, romdev_clock_epoch;
extern uint64_t romdev_clock_ticks;
extern uint32_t romdev_gb_oam_last_change, romdev_gb_oam_size_source;
time_t romdev_time(void);
#ifdef __cplusplus
}
#endif
static uint32_t mp_r32(const unsigned char *p) {
 return (uint32_t)p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24;
}
static void mp_w32(unsigned char *p, uint32_t x) { unsigned i; for(i=0;i<4;i++) p[i]=(unsigned char)(x>>(i*8)); }
static uint64_t mp_r64(const unsigned char *p) { return (uint64_t)mp_r32(p) | (uint64_t)mp_r32(p+4)<<32; }
static void mp_w64(unsigned char *p, uint64_t x) { mp_w32(p,(uint32_t)x);mp_w32(p+4,(uint32_t)(x>>32)); }
static uint32_t mp_rotr(uint32_t x, unsigned n) { return (x>>n)|(x<<(32-n)); }
/* SHA-256's fixed round constants, FIPS 180-4 section 4.2.2. */
static const uint32_t mp_k[64]={
 0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
 0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
 0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
 0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
 0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
 0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
 0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
 0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
static void mp_sha256(const unsigned char *data, size_t size, unsigned char *out) {
 uint32_t h[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
 size_t blocks=(size+9+63)/64, block; unsigned i,j; uint64_t bits=(uint64_t)size*8;
 for(block=0;block<blocks;block++) {
  uint32_t w[64],a,b,c,d,e,f,g,z; unsigned char bytes[64];
  for(i=0;i<64;i++) { size_t p=block*64+i;
   bytes[i]=p<size?data[p]:p==size?0x80:0;
   if(p>=blocks*64-8) bytes[i]=(unsigned char)(bits>>((blocks*64-1-p)*8));
  }
  for(i=0;i<16;i++) w[i]=(uint32_t)bytes[i*4]<<24|(uint32_t)bytes[i*4+1]<<16|(uint32_t)bytes[i*4+2]<<8|bytes[i*4+3];
  for(i=16;i<64;i++) w[i]=w[i-16]+(mp_rotr(w[i-15],7)^mp_rotr(w[i-15],18)^(w[i-15]>>3))+w[i-7]+(mp_rotr(w[i-2],17)^mp_rotr(w[i-2],19)^(w[i-2]>>10));
  a=h[0];b=h[1];c=h[2];d=h[3];e=h[4];f=h[5];g=h[6];z=h[7];
  for(i=0;i<64;i++) { uint32_t t1=z+(mp_rotr(e,6)^mp_rotr(e,11)^mp_rotr(e,25))+((e&f)^(~e&g))+mp_k[i]+w[i];
   uint32_t t2=(mp_rotr(a,2)^mp_rotr(a,13)^mp_rotr(a,22))+((a&b)^(a&c)^(b&c));
   z=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;
  }
  h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=z;
 }
 for(i=0;i<8;i++)for(j=0;j<4;j++)out[i*4+j]=(unsigned char)(h[i]>>(24-j*8));
}
#endif
