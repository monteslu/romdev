// sync32 ROM entry. The loader jumps here with the api table pointer in r0.
// We set up the game's C environment (stack is already set by loader),
// zero .bss, copy .data (XIP builds), then call game_main(api).
    .syntax unified
    .cpu cortex-m33
    .thumb
    .section .text._start
    .global _start
    .thumb_func
_start:
    push {r0, lr}
    // copy .data from load address (no-op on RAM builds: VMA==LMA)
    ldr r1, =__data_load__
    ldr r2, =__data_start__
    ldr r3, =__data_end__
    cmp r1, r2
    beq 2f
1:  cmp r2, r3
    bcs 2f
    ldr r4, [r1], #4
    str r4, [r2], #4
    b 1b
2:  // zero .bss
    ldr r2, =__bss_start__
    ldr r3, =__bss_end__
    movs r4, #0
3:  cmp r2, r3
    bcs 4f
    str r4, [r2], #4
    b 3b
4:  pop {r0, lr}
    bl game_main
5:  b 5b              // game_main must not return; spin if it does
    .pool
