OUTPUT_FORMAT("elf32-littlemips")
OUTPUT_ARCH(mips)
ENTRY(_start)
MEMORY { ram (rwx) : ORIGIN = 0x80010000, LENGTH = 0x1F0000 }
SECTIONS {
  .text : { *(.text.start) *(.text*) *(.rodata*) } > ram
  .data : { *(.data*) *(.sdata*) } > ram
  . = ALIGN(4);
  __bss_start = .;
  .bss : { *(.bss*) *(.sbss*) *(COMMON) } > ram
  . = ALIGN(4);
  __bss_end = .;
  __sp_top = 0x801FFFF0;
  /DISCARD/ : { *(.MIPS.abiflags) *(.reginfo) *(.comment) }
}
