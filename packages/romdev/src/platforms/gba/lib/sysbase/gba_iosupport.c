// gba_iosupport.c — minimal libsysbase for GBA.
//
// newlib's stdio (printf/iprintf/puts/...) bottoms out in the reentrant
// syscalls _write_r/_read_r/_close_r/etc. devkitPro routes those through a
// per-fd "device operations table" (devoptab_list[]); a console library
// (libtonc's tte_init_con / libgba's consoleInit) installs a devoptab whose
// write_r renders text to the screen, so `iprintf("...")` Just Works.
//
// The full devkitPro libsysbase carries a whole VFS (dirs, stat, sockets, …).
// A GBA homebrew only needs the stdout/stderr write path, so this is the
// minimal, fully-from-source implementation of exactly that:
//   - storage for devoptab_list[] (+ a default null device on every slot)
//   - AddDevice / FindDevice / RemoveDevice / GetDeviceOpTab
//   - the reentrant syscalls newlib calls, dispatched through devoptab_list[]
//
// This compiles with the bundled arm-none-eabi toolchain and links ahead of
// the libnosys.a stubs (an object beats an archive member), so providing
// _write_r here transparently replaces nosys's "_write always fails".

#include <sys/iosupport.h>
#include <sys/reent.h>
#include <sys/stat.h>
#include <errno.h>
#include <string.h>
#include <stdint.h>

// ── Default "null" device ────────────────────────────────────────────────
// Used for every fd until a real device is installed. Reads return EOF (0),
// writes silently succeed (so a program that prints before consoleInit() does
// not crash — it just goes nowhere, matching devkitPro behavior).
static ssize_t null_write_r(struct _reent *r, void *fd, const char *p, size_t len) {
  (void)r; (void)fd; (void)p; return (ssize_t)len;
}
static ssize_t null_read_r(struct _reent *r, void *fd, char *p, size_t len) {
  (void)r; (void)fd; (void)p; (void)len; return 0;
}

static const devoptab_t dotab_null = {
  .name = "null",
  .write_r = null_write_r,
  .read_r  = null_read_r,
};

// ── The device table ─────────────────────────────────────────────────────
// STD_MAX slots (newlib max fd). Every slot defaults to the null device, so a
// bare _write_r call before any console init is safe.
const devoptab_t *devoptab_list[STD_MAX] = {
  [0 ... STD_MAX - 1] = &dotab_null,
};

// ── Device registry ──────────────────────────────────────────────────────
// exact name match against the chars before ':' in `name`.
static int name_matches(const char *dev, const char *name, size_t namelen) {
  if (strlen(dev) != namelen) return 0;
  return strncmp(dev, name, namelen) == 0;
}

int FindDevice(const char *name) {
  if (!name) return -1;
  size_t namelen = strcspn(name, ":");
  for (int i = 0; i < STD_MAX; i++) {
    const devoptab_t *d = devoptab_list[i];
    if (d && d != &dotab_null && d->name &&
        name_matches(d->name, name, namelen)) {
      return i;
    }
  }
  return -1;
}

int AddDevice(const devoptab_t *device) {
  if (!device) return -1;
  for (int i = 3; i < STD_MAX; i++) {   // 0/1/2 reserved for stdin/out/err
    if (devoptab_list[i] == &dotab_null) {
      devoptab_list[i] = device;
      return i;
    }
  }
  return -1;
}

int RemoveDevice(const char *name) {
  int i = FindDevice(name);
  if (i >= 0) { devoptab_list[i] = &dotab_null; return 0; }
  return -1;
}

const devoptab_t *GetDeviceOpTab(const char *name) {
  int i = FindDevice(name);
  return (i >= 0) ? devoptab_list[i] : NULL;
}

// ── newlib reentrant syscalls → devoptab dispatch ────────────────────────
// newlib calls these with `fd` = file descriptor. We route to the device
// installed in devoptab_list[fd]. (For real games that open files you'd carry
// a richer fd→handle map; GBA homebrew only uses 0/1/2, which is all this
// needs to make iprintf/printf reach the screen.)

static const devoptab_t *dev_for(int fd) {
  if (fd < 0 || fd >= STD_MAX) return &dotab_null;
  const devoptab_t *d = devoptab_list[fd];
  return d ? d : &dotab_null;
}

_ssize_t _write_r(struct _reent *r, int fd, const void *ptr, size_t len) {
  const devoptab_t *d = dev_for(fd);
  if (!d->write_r) { r->_errno = EBADF; return -1; }
  return d->write_r(r, (void *)(intptr_t)fd, (const char *)ptr, len);
}

_ssize_t _read_r(struct _reent *r, int fd, void *ptr, size_t len) {
  const devoptab_t *d = dev_for(fd);
  if (!d->read_r) { r->_errno = EBADF; return -1; }
  return d->read_r(r, (void *)(intptr_t)fd, (char *)ptr, len);
}

int _close_r(struct _reent *r, int fd) {
  const devoptab_t *d = dev_for(fd);
  if (d->close_r) return d->close_r(r, (void *)(intptr_t)fd);
  return 0;
}

_off_t _lseek_r(struct _reent *r, int fd, _off_t pos, int dir) {
  const devoptab_t *d = dev_for(fd);
  if (d->seek_r) return d->seek_r(r, (void *)(intptr_t)fd, pos, dir);
  (void)pos; (void)dir; return 0;
}

int _fstat_r(struct _reent *r, int fd, struct stat *st) {
  // Report a character device so newlib treats stdout as unbuffered-ish.
  (void)fd;
  if (st) { memset(st, 0, sizeof(*st)); st->st_mode = S_IFCHR; }
  (void)r; return 0;
}

int _isatty_r(struct _reent *r, int fd) {
  (void)r; return (fd >= 0 && fd <= 2) ? 1 : 0;
}
