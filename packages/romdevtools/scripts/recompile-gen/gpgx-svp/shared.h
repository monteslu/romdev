/* Freestanding stand-in for Genesis Plus GX's core/shared.h, for the SVP
 * unit (scripts/recompile-gen/gpgx-svp.mjs). It declares only what
 * cart_hw/svp/svp.c and ssp16.c touch, with gpgx's own layouts:
 *   types.h           uint8 / uint16 / uint32 / int8 / int16 / int32
 *   macros.h          READ_BYTE / WRITE_BYTE (LSB_FIRST)
 *   m68k/m68k.h       cpu_memory_map, m68ki_cpu_core.memory_map[256] (its first field)
 *   membnk.h          t_zbank_memory_map
 *   cart_hw/md_cart.h cart.rom
 * Genesis Plus GX is non-commercial; see cart_hw/svp/svp.c for its notice. */
#ifndef _SHARED_H_
#define _SHARED_H_

typedef unsigned char uint8;
typedef unsigned short int uint16;
typedef unsigned int uint32;
typedef signed char int8;
typedef signed short int int16;
typedef signed int int32;

#ifndef NULL
#define NULL ((void *)0)
#endif

#define memset __builtin_memset
#define memcpy __builtin_memcpy

#ifdef LSB_FIRST
#define READ_BYTE(BASE, ADDR) (BASE)[(ADDR)^1]
#define WRITE_BYTE(BASE, ADDR, VAL) (BASE)[(ADDR)^1] = (VAL)&0xff
#else
#define READ_BYTE(BASE, ADDR) (BASE)[ADDR]
#define WRITE_BYTE(BASE, ADDR, VAL) (BASE)[ADDR] = VAL & 0xff
#endif

/* m68k/m68k.h */
typedef struct
{
  unsigned char *base;
  unsigned int (*read8)(unsigned int address);
  unsigned int (*read16)(unsigned int address);
  void (*write8)(unsigned int address, unsigned int data);
  void (*write16)(unsigned int address, unsigned int data);
} cpu_memory_map;

typedef struct
{
  cpu_memory_map memory_map[256];
} m68ki_cpu_core;

extern m68ki_cpu_core m68k;

/* membnk.h */
typedef struct
{
  unsigned int (*read)(unsigned int address);
  void (*write)(unsigned int address, unsigned int data);
} t_zbank_memory_map;

extern t_zbank_memory_map zbank_memory_map[256];

/* cart_hw/md_cart.h (the field svp.c / ssp16.c read) */
typedef struct
{
  uint8 *rom;
} md_cart_t;

extern md_cart_t cart;

#include "svp.h"

#endif /* _SHARED_H_ */
