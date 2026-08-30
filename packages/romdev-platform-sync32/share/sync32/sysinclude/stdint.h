/* Freestanding <stdint.h> for sync32 carts (ARMv8-M / Cortex-M33, ILP32).
 *
 * A sync32 cart is built -ffreestanding against no libc, so it cannot use
 * newlib's stdint.h — that one includes <machine/_default_types.h> and pulls a
 * whole hosted header tree behind it. Only the exact-width types are needed
 * (sync32.h uses uint8_t/uint16_t/uint32_t and friends), and on this target
 * their widths are fixed by the ABI, so a small correct header is better than
 * a large conditional one.
 *
 * Types come from the compiler's own __INT*_TYPE__ macros where available, so
 * they cannot disagree with what the compiler actually uses.
 */
#ifndef _SYNC32_STDINT_H
#define _SYNC32_STDINT_H

typedef signed char        int8_t;
typedef unsigned char      uint8_t;
typedef short              int16_t;
typedef unsigned short     uint16_t;
typedef int                int32_t;
typedef unsigned int       uint32_t;
typedef long long          int64_t;
typedef unsigned long long uint64_t;

/* Fast/least variants: on a 32-bit MCU the natural width is 32 bits, but the
 * least-width types must be exactly the smallest that fits. */
typedef int8_t   int_least8_t;   typedef uint8_t   uint_least8_t;
typedef int16_t  int_least16_t;  typedef uint16_t  uint_least16_t;
typedef int32_t  int_least32_t;  typedef uint32_t  uint_least32_t;
typedef int64_t  int_least64_t;  typedef uint64_t  uint_least64_t;

typedef int32_t  int_fast8_t;    typedef uint32_t  uint_fast8_t;
typedef int32_t  int_fast16_t;   typedef uint32_t  uint_fast16_t;
typedef int32_t  int_fast32_t;   typedef uint32_t  uint_fast32_t;
typedef int64_t  int_fast64_t;   typedef uint64_t  uint_fast64_t;

typedef int32_t  intptr_t;       typedef uint32_t  uintptr_t;
typedef int64_t  intmax_t;       typedef uint64_t  uintmax_t;

#define INT8_MIN   (-128)
#define INT8_MAX   127
#define UINT8_MAX  255
#define INT16_MIN  (-32768)
#define INT16_MAX  32767
#define UINT16_MAX 65535
#define INT32_MIN  (-2147483647 - 1)
#define INT32_MAX  2147483647
#define UINT32_MAX 4294967295U
#define INT64_MIN  (-9223372036854775807LL - 1)
#define INT64_MAX  9223372036854775807LL
#define UINT64_MAX 18446744073709551615ULL

#define INTPTR_MIN  INT32_MIN
#define INTPTR_MAX  INT32_MAX
#define UINTPTR_MAX UINT32_MAX
#define INTMAX_MIN  INT64_MIN
#define INTMAX_MAX  INT64_MAX
#define UINTMAX_MAX UINT64_MAX
#define SIZE_MAX    UINT32_MAX
#define PTRDIFF_MIN INT32_MIN
#define PTRDIFF_MAX INT32_MAX

#define INT8_C(v)   v
#define UINT8_C(v)  v
#define INT16_C(v)  v
#define UINT16_C(v) v
#define INT32_C(v)  v
#define UINT32_C(v) v ## U
#define INT64_C(v)  v ## LL
#define UINT64_C(v) v ## ULL
#define INTMAX_C(v)  INT64_C(v)
#define UINTMAX_C(v) UINT64_C(v)

#endif /* _SYNC32_STDINT_H */
