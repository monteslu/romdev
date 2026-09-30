#ifndef RZ_CONFIGURE_H
#define RZ_CONFIGURE_H

#include "rz_build_version.h"

// clang-format off
#define RZ_CHECKS_LEVEL             2
#define DEBUGGER                    0
#define HAVE_THREADS                1
#define HAVE_PTHREAD                1
#define HAVE_LZMA                   0
#define HAVE_ZLIB                   0
#define HAVE_DECL_ADDR_NO_RANDOMIZE 1
#define HAVE_DECL_PROCCTL_ASLR_CTL  0
#define HAVE_ARC4RANDOM             1
#define HAVE_ARC4RANDOM_UNIFORM     1
#define HAVE_EXPLICIT_BZERO         1
#define HAVE_EXPLICIT_MEMSET        0
#define HAVE_CLOCK_NANOSLEEP        1
#define HAVE_SIGACTION              1
#define HAVE_PIPE                   1
#define HAVE_EXECV                  1
#define HAVE_EXECVE                 1
#define HAVE_EXECVP                 1
#define HAVE_EXECL                  1
#define HAVE_SYSTEM                 1
#define HAVE_REALPATH               1
#define HAVE_PIPE2                  1
#define HAVE_ENVIRON                1
#define HAVE_OPENPTY                1
#define HAVE_FORKPTY                1
#define HAVE_LOGIN_TTY              1
#define HAVE_SHM_OPEN               1
#define HAVE_LIB_MAGIC              0
#define USE_LIB_MAGIC               0
#define HAVE_LIB_XXHASH             0
#define USE_LIB_XXHASH              0
#define HAVE_LIB_SSL                0
#define HAVE_PTRACE                 0
#define USE_PTRACE_WRAP             0
#define HAVE_FORK                   1
#define HAVE_STRLCPY                1
#define HAVE_STRNLEN                1
#define WANT_DYLINK                 1
#define WITH_GPL                    1
#define HAVE_JEMALLOC               1
#define IS_IOS                      0
#define RZ_BUILD_DEBUG              1
#define WITH_SWIFT_DEMANGLER        1
#define N_THREAD_LIMIT              32767
#define HAVE_COPYFILE               0
#define HAVE_COPY_FILE_RANGE        1
#define HAVE_BACKTRACE              1
#define HAVE___BUILTIN_BSWAP16      1
#define HAVE___BUILTIN_BSWAP32      1
#define HAVE___BUILTIN_BSWAP64      1
#define HAVE___BUILTIN_CLZLL        1
#define HAVE_POSIX_MEMALIGN         1
#define HAVE__ALIGNED_MALLOC        0

#define HAVE_HEADER_LINUX_ASHMEM_H  0
#define HAVE_HEADER_SYS_SHM_H       1
#define HAVE_HEADER_SYS_IPC_H       1
#define HAVE_HEADER_SYS_MMAN_H      1
#define HAVE_HEADER_INTTYPES_H      1

#define RZ_IS_PORTABLE 1

#define RZ_BINDIR_DEPTH 1
// clang-format on

#define RZ_PREFIX "/usr/local"
#define RZ_BINDIR "bin"
#define RZ_LIBDIR "lib"
#define RZ_INCDIR "include/librz"
#define RZ_DATDIR "share"

#define RZ_WWWROOT  "share/rizin/www"
#define RZ_PLUGINS  "lib/rizin/plugins"
#define RZ_DATADIR  "share/rizin"
#define RZ_SDB      "share/rizin"
#define RZ_SIGDB    "share/rizin/sigdb"
#define RZ_THEMES   "share/rizin/cons"
#define RZ_FORTUNES "share/rizin/fortunes"
#define RZ_FLAGS    "share/rizin/flag"
#define RZ_HUD      "share/rizin/hud"

#define RZ_SDB_ARCH_PLATFORMS RZ_JOIN_3_PATHS(RZ_SDB, "arch", "platforms")
#define RZ_SDB_ARCH_CPUS      RZ_JOIN_3_PATHS(RZ_SDB, "asm", "cpus")
#define RZ_SDB_TYPES          RZ_JOIN_2_PATHS(RZ_SDB, "types")
#define RZ_SDB_OPCODES        RZ_JOIN_2_PATHS(RZ_SDB, "opcodes")
#define RZ_SDB_REG            RZ_JOIN_2_PATHS(RZ_SDB, "reg")
#define RZ_SDB_MAGIC          RZ_JOIN_2_PATHS(RZ_SDB, "magic")
#define RZ_SDB_FORMAT         RZ_JOIN_2_PATHS(RZ_SDB, "format")
#define RZ_PDB                RZ_JOIN_2_PATHS(RZ_DATADIR, "pdb")
#define RZ_PROJECTS           RZ_JOIN_2_PATHS(RZ_DATADIR, "projects")
#define RZ_BINRC              RZ_JOIN_2_PATHS(RZ_DATADIR, "rc.d")

#define RZ_HOME_PREFIX    ".local"
#define RZ_HOME_CONFIGDIR RZ_JOIN_2_PATHS(".config", "rizin")
#define RZ_HOME_CACHEDIR  RZ_JOIN_2_PATHS(".cache", "rizin")

#define RZ_HOME_HISTORY RZ_JOIN_2_PATHS(RZ_HOME_CACHEDIR, "history")

#define RZ_HOME_CONFIG_RC     RZ_JOIN_2_PATHS(RZ_HOME_CONFIGDIR, "rizinrc")
#define RZ_HOME_CONFIG_RC_DIR RZ_JOIN_2_PATHS(RZ_HOME_CONFIGDIR, "rizinrc.d")
#define RZ_GLOBAL_RC          RZ_JOIN_2_PATHS(RZ_DATADIR, "rizinrc")
#define RZ_HOME_RC            ".rizinrc"

// This is an optional extra prefix used to load plugins, sdb files, sdb files,
// etc. It can be outside the default prefix. Used e.g. by Homebrew to load
// plugins from the general /opt/homebrew prefix instead of the version specific
// prefix e.g. /opt/homebrew/Cellar/rizin/0.x.y/
// clang-format off
#define RZ_EXTRA_PREFIX 0
// clang-format on

#endif
