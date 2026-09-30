/* No stdio on sync32: logging compiles away, file access does not exist. */
#ifndef _RD_STDIO_H
#define _RD_STDIO_H
#include <stddef.h>
#include <stdarg.h>
typedef struct _rd_file FILE;
#define printf(...) ((void)0)
#define fprintf(...) ((void)0)
int sprintf(char *out, const char *fmt, ...);
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2
#endif
