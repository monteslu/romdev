/* setjmp/longjmp for Cortex-M33 (setjmp.S): r4-r11, sp, lr and s16-s31. */
#ifndef _RD_SETJMP_H
#define _RD_SETJMP_H
typedef unsigned int jmp_buf[26];
int setjmp(jmp_buf env) __attribute__((returns_twice));
void longjmp(jmp_buf env, int val) __attribute__((noreturn));
#endif
