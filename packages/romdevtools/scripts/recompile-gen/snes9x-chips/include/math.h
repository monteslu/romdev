/* Freestanding stand-in for <math.h>: seta010.cpp uses abs() on ints. */
#ifndef _ROMDEV_MATH_H_
#define _ROMDEV_MATH_H_
static inline int abs (int v) { return v < 0 ? -v : v; }
/* c4.cpp / c4emu.cpp: emscripten's libc (musl) sin, cos, atan and sqrt,
 * linked from its libc.a as the reference core links them */
extern "C" double sin (double);
extern "C" double cos (double);
extern "C" double atan (double);
extern "C" double sqrt (double);
/* bsx.cpp: ceil() for its satellite packet count (never reached: no stream opens) */
#ifndef _ROMDEV_CEIL_
#define _ROMDEV_CEIL_
static inline double ceil (double x) { return __builtin_ceil(x); }
#endif
#endif
