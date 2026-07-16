/* genesis.ld — minimum-viable linker script for Sega Genesis ROMs.
 *
 * Memory layout:
 *   rom  : $00000000 - $003FFFFF  (4 MB max cart size)
 *   ram  : $00FF0000 - $00FFFFFF  (64 KB main work RAM)
 *
 * Section ordering: vectors at $0 (mandatory — 68000 reads SSP + reset
 * vector from $000000/$000004), then ROM header at $100, then code,
 * then read-only data. .bss + .data live in ram.
 *
 * Real Genesis projects use a more elaborate script (SGDK ships ~200
 * lines covering multi-bank, .data init copy, etc.). This is enough
 * for "bare main()" through the gcc pipeline.
 */
OUTPUT_FORMAT("elf32-m68k")
OUTPUT_ARCH(m68k)
ENTRY(_start)

MEMORY {
    rom (rx) : ORIGIN = 0x00000000, LENGTH = 4M
    ram (rwx): ORIGIN = 0x00FF0000, LENGTH = 64K
}

SECTIONS {
    .text 0x00000000 : {
        KEEP(*(.text._vectors))
        *(.text._rom_header)
        *(.text._start)
        *(.text*)
        *(.rodata*)
        . = ALIGN(2);
    } > rom

    .data : {
        *(.data*)
        . = ALIGN(2);
    } > rom

    .bss : {
        *(.bss*)
        *(COMMON)
        . = ALIGN(2);
    } > ram
}
