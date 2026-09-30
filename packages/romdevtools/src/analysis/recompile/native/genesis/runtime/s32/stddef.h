/* Minimal freestanding <stddef.h> for the sync32 Genesis runtime. */
#ifndef _RD_STDDEF_H
#define _RD_STDDEF_H
typedef unsigned int size_t;
typedef int ptrdiff_t;
#ifndef NULL
#define NULL ((void *)0)
#endif
#define offsetof(t, m) __builtin_offsetof(t, m)
#endif
