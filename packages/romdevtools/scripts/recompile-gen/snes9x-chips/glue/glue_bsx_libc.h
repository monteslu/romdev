/* The libc calls bsx.cpp makes, for the BS-X unit (glue_bsx.cpp defines
 * them): no file opens (romdev's reference has no BS-X.bin in its BIOS
 * directory and no satellite stream files), and localtime() in UTC, which
 * is how the verifier pins the reference's clock. */
#ifndef _ROMDEV_BSX_LIBC_H_
#define _ROMDEV_BSX_LIBC_H_
typedef struct RomdevFILE FILE;
extern "C" FILE *fopen (const char *, const char *);
extern "C" size_t fread (void *, size_t, size_t, FILE *);
extern "C" int fclose (FILE *);
extern "C" int snprintf (char *, size_t, const char *, ...);
#define PATH_MAX 4096
static inline int strncmp (const char *a, const char *b, size_t n)
{
	for (; n; n--, a++, b++)
	{
		if (*a != *b) return (unsigned char) *a - (unsigned char) *b;
		if (!*a) return 0;
	}
	return 0;
}
struct tm { int tm_sec, tm_min, tm_hour, tm_mday, tm_mon, tm_year, tm_wday, tm_yday, tm_isdst; };
extern "C" struct tm *localtime (const time_t *);
#endif
