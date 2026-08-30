/* sync32 RAM-load ROM: whole image copied to the game region and run there */
MEMORY {
  GAME (rwx) : ORIGIN = 0x20030000, LENGTH = 0x50000 - 0x4000  /* top 16K = stack */
}
ENTRY(_start)
SECTIONS {
  .text : { KEEP(*(.text._start)) *(.text*) *(.rodata*) . = ALIGN(4); } > GAME
  .data : { __data_start__ = .; *(.data*) . = ALIGN(4); __data_end__ = .; } > GAME
  __data_load__ = __data_start__;   /* VMA==LMA: crt0 copy is a no-op */
  .bss (NOLOAD) : { __bss_start__ = .; *(.bss*) *(COMMON) . = ALIGN(4); __bss_end__ = .; } > GAME
  __image_end__ = __data_end__;
  /DISCARD/ : { *(.ARM.exidx*) *(.ARM.attributes) *(.comment) }
}
