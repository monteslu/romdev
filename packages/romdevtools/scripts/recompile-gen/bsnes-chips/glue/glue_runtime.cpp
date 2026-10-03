/* romdev: the little C/C++ runtime a bsnes chip unit needs inside a
 * recompiled cart (scripts/recompile-gen/bsnes-chips.mjs). A unit has no libc:
 * its memory is a block the cart places, so allocation is a bump allocator
 * over an arena in the unit's own .bss (zeroed by the unit's start function).
 * bsnes allocates only while a chip is built (the ARM's instruction tables,
 * once) and on a reset (a register's function object), so nothing is ever
 * given back. Only for chip units: the snes9x core links the chips against
 * emscripten's real libc instead. */
#include <stddef.h>
#include <new>

#ifndef ROMDEV_UNIT_ARENA
#define ROMDEV_UNIT_ARENA (64 * 1024)
#endif

namespace {
alignas(16) unsigned char arena[ROMDEV_UNIT_ARENA];
size_t used = 0;

void* allocate(size_t size) {
  size_t at = (used + 7) & ~(size_t)7;
  /* each block remembers its size for realloc */
  if(at + 8 + size > sizeof(arena)) __builtin_trap();
  *(size_t*)(arena + at) = size;
  used = at + 8 + size;
  return arena + at + 8;
}
}

/* bytes of the arena in use (the generator sizes the arena by it) */
extern "C" int romdev_unit_arena_used(void) { return (int)used; }

extern "C" {

void* malloc(size_t size) { return allocate(size); }
void* calloc(size_t n, size_t size) {
  unsigned char* p = (unsigned char*)allocate(n * size);
  for(size_t i = 0; i < n * size; i++) p[i] = 0;
  return p;
}
void free(void*) {}
void* realloc(void* old, size_t size) {
  unsigned char* p = (unsigned char*)allocate(size);
  if(old) {
    size_t was = *(size_t*)((unsigned char*)old - 8);
    for(size_t i = 0; i < was && i < size; i++) p[i] = ((unsigned char*)old)[i];
  }
  return p;
}

void* memcpy(void* dst, const void* src, size_t n) {
  unsigned char* d = (unsigned char*)dst; const unsigned char* s = (const unsigned char*)src;
  for(size_t i = 0; i < n; i++) d[i] = s[i];
  return dst;
}
void* memmove(void* dst, const void* src, size_t n) {
  unsigned char* d = (unsigned char*)dst; const unsigned char* s = (const unsigned char*)src;
  if(d < s) { for(size_t i = 0; i < n; i++) d[i] = s[i]; }
  else { for(size_t i = n; i-- > 0;) d[i] = s[i]; }
  return dst;
}
void* memset(void* dst, int v, size_t n) {
  unsigned char* d = (unsigned char*)dst;
  for(size_t i = 0; i < n; i++) d[i] = (unsigned char)v;
  return dst;
}
int memcmp(const void* a, const void* b, size_t n) {
  const unsigned char* x = (const unsigned char*)a; const unsigned char* y = (const unsigned char*)b;
  for(size_t i = 0; i < n; i++) if(x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
size_t strlen(const char* s) { size_t n = 0; while(s[n]) n++; return n; }

/* what a chip never reaches: an exception (bsnes's nall throws only on misuse),
 * a failed assertion, a pure virtual call */
void __assert_fail(const char*, const char*, unsigned, const char*) { __builtin_trap(); }
void __cxa_pure_virtual() { __builtin_trap(); }
void* __cxa_allocate_exception(size_t) { __builtin_trap(); }
void __cxa_throw(void*, void*, void (*)(void*)) { __builtin_trap(); }
void __cxa_rethrow() { __builtin_trap(); }
int __cxa_atexit(void (*)(void*), void*, void*) { return 0; }
void* __dso_handle = nullptr;
void abort() { __builtin_trap(); }

}

void* operator new(size_t size) { return allocate(size); }
void* operator new[](size_t size) { return allocate(size); }
void operator delete(void*) noexcept {}
void operator delete[](void*) noexcept {}
void operator delete(void*, size_t) noexcept {}
void operator delete[](void*, size_t) noexcept {}

/* type_info vtables nall's `any` names (RTTI is on for it; no chip uses it) */
namespace __cxxabiv1 {
struct __class_type_info { virtual ~__class_type_info(); };
struct __si_class_type_info { virtual ~__si_class_type_info(); };
__class_type_info::~__class_type_info() {}
__si_class_type_info::~__si_class_type_info() {}
}
