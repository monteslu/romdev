ENTRY(_start)
MEMORY { ram (rwx) : ORIGIN = 0x8c010000, LENGTH = 0x800000 }
SECTIONS {
  .text : { *(.text.start) *(.text*) *(.rodata*) } > ram
  .data : { *(.data*) } > ram
  . = ALIGN(4);
  __bss_start = .;
  .bss  : { *(.bss*) *(COMMON) } > ram
  . = ALIGN(4);
  _end = .;
}
