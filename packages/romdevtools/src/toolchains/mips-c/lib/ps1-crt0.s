/* Minimal PS1 (R3000) crt0 — sets the stack, clears .bss, calls main(), loops.
   The PS-EXE header (set by the JS wrapper) points the BIOS entry here. */
    .set noreorder
    .section .text.start, "ax"
    .global _start
_start:
    la      $sp, __sp_top          /* stack top */
    /* zero .bss */
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
3:  b       3b                      /* main returned — hang */
    nop
