OUTPUT_FORMAT("elf32-bigmips")
OUTPUT_ARCH(mips)
ENTRY(_start)
MEMORY { ram (rwx) : ORIGIN = 0x80000400, LENGTH = 0x3FFC00 }
SECTIONS {
  .text : { *(.text.start) *(.text*) *(.rodata*) } > ram
  .data : { *(.data*) *(.sdata*) *(.lit8) *(.lit4) *(.scommon) } > ram
  . = ALIGN(8);
  __bss_start = .;
  .bss : { *(.bss*) *(.sbss*) *(.scommon) *(COMMON) } > ram
  . = ALIGN(8);
  __bss_end = .;
  __sp_top = 0x803FFFF0;
  /DISCARD/ : { *(.MIPS.abiflags) *(.reginfo) *(.comment) }
}
