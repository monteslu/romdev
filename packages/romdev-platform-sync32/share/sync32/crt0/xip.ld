/* sync32 flash-XIP ROM: code+rodata run in place from the game slot,
   .data copied to game RAM by crt0, .bss zeroed there */
MEMORY {
  SLOT (rx)  : ORIGIN = 0x10100000, LENGTH = 12M
  /* The top of the game region is the stack, which grows DOWN from
     0x20080000. S32_STACK is how much is reserved for it; the default 16 KB
     suits a game whose call depth is its own, but a ported engine can want
     far more (Doom's BSP recursion measured over 23 KB), so a cart can raise
     it with -Wl,--defsym=S32_STACK=N at the cost of its own RAM. */
  GAME (rwx) : ORIGIN = 0x20030000, LENGTH = 0x50000 - S32_STACK
}
/* Default stack reservation; override with -Wl,--defsym=S32_STACK=0x8000 */
S32_STACK = DEFINED(S32_STACK) ? S32_STACK : 0x4000;
ENTRY(_start)
SECTIONS {
  .text : { KEEP(*(.text._start)) *(.text*) *(.rodata*) . = ALIGN(4); } > SLOT
  /* C++ static constructors: carts call __s32_run_ctors() (see sync32.h) */
  .init_array : { . = ALIGN(4); __init_array_start = .;
                  KEEP(*(.init_array*)) __init_array_end = .; } > SLOT
  .data : { __data_start__ = .; *(.data*) . = ALIGN(4); __data_end__ = .; } > GAME AT > SLOT
  __data_load__ = LOADADDR(.data);
  .bss (NOLOAD) : { __bss_start__ = .; *(.bss*) *(COMMON) . = ALIGN(4); __bss_end__ = .; } > GAME
  /DISCARD/ : { *(.ARM.exidx*) *(.ARM.attributes) *(.comment) }
}
