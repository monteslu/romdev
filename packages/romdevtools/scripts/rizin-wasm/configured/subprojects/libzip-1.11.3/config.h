#ifndef HAD_CONFIG_H
#define HAD_CONFIG_H
#ifndef _HAD_ZIPCONF_H
#include "zipconf.h"
#endif
/* BEGIN DEFINES */
// clang-format off
/* #undef HAVE___PROGNAME */
#define HAVE__CLOSE 1
#define HAVE__DUP 1
#define HAVE__FDOPEN 1
/* #undef HAVE__FILENO */
/* #undef HAVE__SETMODE */
/* #undef HAVE__SNPRINTF */
#define HAVE__SNWPRINTF_S 1
/* #undef HAVE__STRDUP */
/* #undef HAVE__STRICMP */
#define HAVE__STRTOI64 1
#define HAVE__STRTOUI64 1
#define HAVE__UMASK 1
#define HAVE__UNLINK 1
#define HAVE_ARC4RANDOM 1
#define HAVE_CLONEFILE 1
/* #undef HAVE_COMMONCRYPTO */
/* #undef HAVE_CRYPTO */
/* #undef HAVE_FICLONERANGE */
#define HAVE_FILENO 1
#define HAVE_FSEEKO 1
#define HAVE_FTELLO 1
#define HAVE_GETPROGNAME 1
/* #undef HAVE_GNUTLS */
/* #undef HAVE_LIBBZ2 */
/* #undef HAVE_LIBLZMA */
#define HAVE_LOCALTIME_R 1
/* #undef HAVE_MBEDTLS */
#define HAVE_MEMCPY_S 1
#define HAVE_MKSTEMP 1
#define HAVE_NULLABLE 1
/* #undef HAVE_OPENSSL */
#define HAVE_SETMODE 1
#define HAVE_SNPRINTF 1
#define HAVE_STRCASECMP 1
#define HAVE_STRDUP 1
#define HAVE_STRERROR_S 1
#define HAVE_STRICMP 1
#define HAVE_STRNCPY 1
#define HAVE_STRNCPY_S 1
#define HAVE_STRTOLL 1
#define HAVE_STRTOULL 1
/* #undef HAVE_STRUCT_TM_TM_ZONE */
#define HAVE_STDBOOL_H 1
#define HAVE_STRINGS_H 1
#define HAVE_UNISTD_H 1
/* #undef HAVE_WINDOWS_CRYPTO */
#define SIZEOF_OFF_T 8
#define SIZEOF_SIZE_T 4
#define HAVE_DIRENT_H 1
/* #undef HAVE_FTS_H */
/* #undef HAVE_NDIR_H */
#define HAVE_SYS_DIR_H 1
/* #undef HAVE_SYS_NDIR_H */
/* #undef WORDS_BIGENDIAN */
/* #undef HAVE_SHARED */
/* END DEFINES */
#define PACKAGE "libzip"
#define VERSION "1.11.3"
// clang-format on
# endif /* HAD_CONFIG_H */
