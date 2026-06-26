/* Minimal N64 (R4300) crt0 — bare stack + .bss clear + main(). NOTE: a real
   bootable N64 ROM needs the IPL3 bootcode + a libdragon-style header; this
   minimal crt0 exercises the mips-elf toolchain (big-endian) and produces a flat
   code image. Full N64 boot = libdragon (STAGE 3). */
    .set noreorder
    .section .text.start, "ax"
    .global _start
_start:
    la      $sp, __sp_top
    la      $t0, __bss_start
    la      $t1, __bss_end
1:  beq     $t0, $t1, 2f
    nop
    sw      $zero, 0($t0)
    addiu   $t0, $t0, 4
    b       1b
    nop
2:  jal     main
    nop
3:  b       3b
    nop
