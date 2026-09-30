/* The few libc routines the Genesis runtime calls, freestanding. Memory
   routines are word-at-a-time where alignment allows; they sit on the VDP DMA
   and line-buffer paths. */
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>

void *memcpy(void *d, const void *s, size_t n) {
  uint8_t *dp = d; const uint8_t *sp = s;
  if ((((uintptr_t)dp | (uintptr_t)sp) & 3) == 0) {
    while (n >= 16) {
      uint32_t a = ((const uint32_t *)sp)[0], b = ((const uint32_t *)sp)[1];
      uint32_t c = ((const uint32_t *)sp)[2], e = ((const uint32_t *)sp)[3];
      ((uint32_t *)dp)[0] = a; ((uint32_t *)dp)[1] = b;
      ((uint32_t *)dp)[2] = c; ((uint32_t *)dp)[3] = e;
      dp += 16; sp += 16; n -= 16;
    }
    while (n >= 4) { *(uint32_t *)dp = *(const uint32_t *)sp; dp += 4; sp += 4; n -= 4; }
  }
  while (n--) *dp++ = *sp++;
  return d;
}

void *memmove(void *d, const void *s, size_t n) {
  uint8_t *dp = d; const uint8_t *sp = s;
  if (dp == sp || n == 0) return d;
  if (dp < sp || dp >= sp + n) return memcpy(d, s, n);
  dp += n; sp += n;
  while (n--) *--dp = *--sp;
  return d;
}

void *memset(void *d, int c, size_t n) {
  uint8_t *dp = d;
  uint32_t w = (uint8_t)c; w |= w << 8; w |= w << 16;
  while (n && ((uintptr_t)dp & 3)) { *dp++ = (uint8_t)c; n--; }
  while (n >= 16) {
    ((uint32_t *)dp)[0] = w; ((uint32_t *)dp)[1] = w;
    ((uint32_t *)dp)[2] = w; ((uint32_t *)dp)[3] = w;
    dp += 16; n -= 16;
  }
  while (n >= 4) { *(uint32_t *)dp = w; dp += 4; n -= 4; }
  while (n--) *dp++ = (uint8_t)c;
  return d;
}

int memcmp(const void *a, const void *b, size_t n) {
  const uint8_t *x = a, *y = b;
  for (; n; n--, x++, y++) if (*x != *y) return *x - *y;
  return 0;
}

size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
int strcmp(const char *a, const char *b) {
  while (*a && *a == *b) { a++; b++; }
  return (uint8_t)*a - (uint8_t)*b;
}
int strncmp(const char *a, const char *b, size_t n) {
  for (; n; n--, a++, b++) {
    if (*a != *b) return (uint8_t)*a - (uint8_t)*b;
    if (!*a) return 0;
  }
  return 0;
}
char *strstr(const char *h, const char *n) {
  size_t k = strlen(n);
  if (!k) return (char *)h;
  for (; *h; h++) if (!strncmp(h, n, k)) return (char *)h;
  return NULL;
}
char *strcpy(char *d, const char *s) { char *r = d; while ((*d++ = *s++)); return r; }
char *strncpy(char *d, const char *s, size_t n) {
  size_t i = 0;
  for (; i < n && s[i]; i++) d[i] = s[i];
  for (; i < n; i++) d[i] = 0;
  return d;
}
char *strchr(const char *s, int c) {
  for (;; s++) { if (*s == (char)c) return (char *)s; if (!*s) return NULL; }
}
char *strrchr(const char *s, int c) {
  const char *r = NULL;
  for (;; s++) { if (*s == (char)c) r = s; if (!*s) return (char *)r; }
}

/* A bump allocator over a fixed arena: gpgx allocates only at init (the blip
   buffers), never frees in a way that matters, and the console has no heap. */
#ifndef RD_HEAP_BYTES
#define RD_HEAP_BYTES (16 * 1024)
#endif
static uint8_t rd_heap[RD_HEAP_BYTES] __attribute__((aligned(8)));
static size_t rd_heap_used;
size_t rd_heap_high_water(void) { return rd_heap_used; }
void *malloc(size_t n) {
  n = (n + 7) & ~(size_t)7;
  if (rd_heap_used + n > sizeof(rd_heap)) return NULL;
  void *p = rd_heap + rd_heap_used;
  rd_heap_used += n;
  return p;
}
void *calloc(size_t n, size_t m) { void *p = malloc(n * m); if (p) memset(p, 0, n * m); return p; }
void *realloc(void *p, size_t n) { (void)p; return malloc(n); }
void free(void *p) { (void)p; }

double floor(double x) {
  if (x >= 4503599627370496.0 || x <= -4503599627370496.0) return x;
  long long i = (long long)x;
  double r = (double)i;
  return (r > x) ? r - 1.0 : r;
}
double ceil(double x) {
  if (x >= 4503599627370496.0 || x <= -4503599627370496.0) return x;
  long long i = (long long)x;
  double r = (double)i;
  return (r < x) ? r + 1.0 : r;
}

/* sprintf: only the %[0][width](d|u|x|X|s|c) forms gpgx's ROM header parser
   uses. */
#include <stdarg.h>
int sprintf(char *out, const char *fmt, ...) {
  va_list ap;
  char *o = out;
  va_start(ap, fmt);
  for (; *fmt; fmt++) {
    if (*fmt != '%') { *o++ = *fmt; continue; }
    fmt++;
    int zero = 0, width = 0;
    if (*fmt == '0') { zero = 1; fmt++; }
    while (*fmt >= '0' && *fmt <= '9') width = width * 10 + (*fmt++ - '0');
    char buf[16]; int n = 0;
    if (*fmt == 's') { const char *s = va_arg(ap, const char *); while (*s) *o++ = *s++; continue; }
    if (*fmt == 'c') { *o++ = (char)va_arg(ap, int); continue; }
    if (*fmt == '%') { *o++ = '%'; continue; }
    unsigned int v; int neg = 0;
    if (*fmt == 'd') { int d = va_arg(ap, int); if (d < 0) { neg = 1; v = (unsigned)-d; } else v = (unsigned)d; }
    else v = va_arg(ap, unsigned int);
    unsigned base = (*fmt == 'x' || *fmt == 'X') ? 16 : 10;
    do { unsigned dg = v % base; buf[n++] = (char)(dg < 10 ? '0' + dg : (*fmt == 'X' ? 'A' : 'a') + dg - 10); v /= base; } while (v);
    if (neg) buf[n++] = '-';
    while (n < width) buf[n++] = zero ? '0' : ' ';
    while (n) *o++ = buf[--n];
  }
  *o = 0;
  va_end(ap);
  return (int)(o - out);
}

/* zlib-compatible CRC-32 (sram.c fingerprints the backup RAM with it). */
unsigned int crc32(unsigned int crc, const unsigned char *buf, unsigned int len) {
  crc = ~crc;
  while (len--) {
    crc ^= *buf++;
    for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1)));
  }
  return ~crc;
}

/* rand(): only gpgx's soft-reset path asks, which this runtime never takes. */
static unsigned int rd_rand_state = 1;
int rand(void) { rd_rand_state = rd_rand_state * 1103515245u + 12345u; return (int)((rd_rand_state >> 1) & 0x7fffffff); }
