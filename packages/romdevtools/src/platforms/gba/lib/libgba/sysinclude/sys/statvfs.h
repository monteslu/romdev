/* sys/statvfs.h — POSIX filesystem-statistics struct.
 *
 * Bundled so devkitPro's <sys/iosupport.h> compiles: the devoptab_t device
 * table has a statvfs_r() function-pointer member whose signature references
 * `struct statvfs`. GBA homebrew never calls statvfs() (no filesystem), but the
 * type must exist for the header to parse. Standard POSIX layout. */

#ifndef _SYS_STATVFS_H_
#define _SYS_STATVFS_H_

#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

struct statvfs {
  unsigned long f_bsize;    /* file system block size */
  unsigned long f_frsize;   /* fragment size */
  fsblkcnt_t    f_blocks;   /* size of fs in f_frsize units */
  fsblkcnt_t    f_bfree;    /* free blocks in fs */
  fsblkcnt_t    f_bavail;   /* free blocks avail to non-superuser */
  fsfilcnt_t    f_files;    /* total file nodes in file system */
  fsfilcnt_t    f_ffree;    /* free file nodes in fs */
  fsfilcnt_t    f_favail;   /* avail file nodes in fs */
  unsigned long f_fsid;     /* file system id */
  unsigned long f_flag;     /* mount flags */
  unsigned long f_namemax;  /* maximum length of filenames */
};

#define ST_RDONLY 1
#define ST_NOSUID 2

int statvfs(const char *__path, struct statvfs *__buf);
int fstatvfs(int __fd, struct statvfs *__buf);

#ifdef __cplusplus
}
#endif

#endif /* _SYS_STATVFS_H_ */
