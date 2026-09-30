/* setjmp/longjmp for the sync32 Genesis runtime (Cortex-M33, hard float):
   Musashi's address-error trap needs them and the console has no libc.
   Saves the AAPCS callee-saved state: r4-r11, sp, lr, s16-s31. */
#include <setjmp.h>

__attribute__((naked, returns_twice)) int setjmp(jmp_buf env) {
  __asm__ volatile(
    "mov r12, sp\n"
    "stmia r0!, {r4-r11, r12, lr}\n"
    "vstmia r0!, {s16-s31}\n"
    "movs r0, #0\n"
    "bx lr\n");
}

__attribute__((naked, noreturn)) void longjmp(jmp_buf env, int val) {
  __asm__ volatile(
    "ldmia r0!, {r4-r11, r12, lr}\n"
    "vldmia r0!, {s16-s31}\n"
    "mov sp, r12\n"
    "movs r0, r1\n"
    "it eq\n"
    "moveq r0, #1\n"
    "bx lr\n");
}
