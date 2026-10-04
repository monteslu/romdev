/*
  libco for WebAssembly (romdev): cothreads on binaryen's Asyncify pass, run
  entirely inside the module (no JavaScript involved in a switch).

  A switch saves the running cothread's wasm call stack into its Asyncify
  buffer by unwinding (asyncify start_unwind), returns to the trampoline at the
  bottom of the stack, and rewinds the target cothread's saved stack (asyncify
  start_rewind) by calling its entry function again. The functions imported
  from module "asyncify" are binaryen's own intrinsics: the build runs
  `wasm-opt --asyncify --pass-arg=asyncify-ignore-imports
  --pass-arg=asyncify-removelist@romdev_co_trampoline` on the linked module
  (scripts/wasm-emcc/link.mjs does so whenever the module imports "asyncify"),
  which turns those calls into calls to the functions the pass adds.

  Every cothread also owns a separate C (shadow) stack in linear memory; the
  stack pointer is saved when a cothread unwinds and restored before it
  rewinds, as emscripten's own fibers do (src/lib/libasync.js).

  co_switch is only valid inside romdev_co_run(), which the embedder wraps
  around every entry point that may switch (retro_run, retro_serialize, ...).
*/
#define LIBCO_C
#include "libco.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

#define ROMDEV_ASYNCIFY(name) __attribute__((import_module("asyncify"), import_name(name)))
ROMDEV_ASYNCIFY("start_unwind") void romdev_asyncify_start_unwind(void*);
ROMDEV_ASYNCIFY("stop_unwind") void romdev_asyncify_stop_unwind(void);
ROMDEV_ASYNCIFY("start_rewind") void romdev_asyncify_start_rewind(void*);
ROMDEV_ASYNCIFY("stop_rewind") void romdev_asyncify_stop_rewind(void);

/* emscripten system/lib/compiler-rt/stack_ops.S */
uintptr_t emscripten_stack_get_current(void);
void _emscripten_stack_restore(uintptr_t);

#define CO_MAGIC 0x636f7764u
#define CO_ASYNCIFY_BYTES (64u * 1024u)
#define CO_MIN_BYTES (256u * 1024u)

typedef struct {
  /* binaryen's asyncify data header: where the next saved frame goes, and the end */
  unsigned char* data_ptr;
  unsigned char* data_end;
  uint32_t magic;
  uint32_t size;           /* bytes in the block */
  void (*entry)(void);
  unsigned char* abuf;     /* asyncify buffer */
  uint32_t abuf_size;
  uintptr_t stack_top;     /* top (highest address) of this cothread's C stack */
  uintptr_t sp;            /* C stack pointer when it last unwound */
  int started;
} co_ctx;

static co_ctx co_host;
static co_ctx* co_running = 0;
static co_ctx* co_target = 0;
static int co_in_trampoline = 0;
static int co_unwinding = 0;
static int co_rewinding = 0;

cothread_t co_active() {
  if(!co_running) co_running = &co_host;
  return (cothread_t)co_running;
}

cothread_t co_derive(void* memory, unsigned int size, void (*entry)(void)) {
  if(!memory) return 0;
  co_ctx* co = (co_ctx*)memory;
  /* bsnes and ares re-derive a cothread in place (Thread::create on a thread that
     exists) passing its nominal size: a block co_create made keeps its own */
  if(co->magic == CO_MAGIC && co->size > size) size = co->size;
  if(size < sizeof(co_ctx) + CO_ASYNCIFY_BYTES + 4096) return 0;
  memset(co, 0, sizeof(co_ctx));
  co->magic = CO_MAGIC;
  co->size = size;
  co->entry = entry;
  co->abuf = (unsigned char*)memory + ((sizeof(co_ctx) + 15) & ~15u);
  co->abuf_size = CO_ASYNCIFY_BYTES;
  co->stack_top = ((uintptr_t)memory + size) & ~(uintptr_t)15;
  return (cothread_t)co;
}

cothread_t co_create(unsigned int size, void (*entry)(void)) {
  if(size < CO_MIN_BYTES) size = CO_MIN_BYTES;
  void* memory = malloc(size);
  if(!memory) return 0;
  /* a fresh block is not a cothread yet (co_derive reads the magic) */
  ((co_ctx*)memory)->magic = 0;
  cothread_t co = co_derive(memory, size, entry);
  if(!co) free(memory);
  return co;
}

void co_delete(cothread_t handle) {
  if(handle && handle != (cothread_t)&co_host) free(handle);
}

/* The one function that starts an unwind; it is not instrumented itself (it
   only calls the intrinsics), so it runs again, for real, when the cothread
   is rewound into it, and then finishes the rewind. */
__attribute__((noinline)) static void co_suspend(co_ctx* self) {
  if(co_rewinding) {
    co_rewinding = 0;
    romdev_asyncify_stop_rewind();
    return;
  }
  self->data_ptr = self->abuf;
  self->data_end = self->abuf + self->abuf_size;
  self->sp = emscripten_stack_get_current();
  co_unwinding = 1;
  romdev_asyncify_start_unwind(self);
}

void co_switch(cothread_t handle) {
  co_ctx* self = (co_ctx*)co_active();
  if((co_ctx*)handle == self) return;
  if(!co_in_trampoline) abort();
  co_target = (co_ctx*)handle;
  co_suspend(self);
  co_running = self;
}

int co_serializable() {
  return 0;
}

/* Runs `root` as the host cothread. Not instrumented by Asyncify (removelist):
   unwinds stop here and rewinds start here. */
__attribute__((noinline)) void romdev_co_trampoline(void (*root)(void)) {
  co_ctx* run = &co_host;
  int host_fresh = 1;
  for(;;) {
    co_running = run;
    if(run == &co_host && host_fresh) {
      host_fresh = 0;
      root();
    } else if(run != &co_host && !run->started) {
      run->started = 1;
      _emscripten_stack_restore(run->stack_top);
      run->entry();
    } else {
      _emscripten_stack_restore(run->sp);
      co_rewinding = 1;
      romdev_asyncify_start_rewind(run);
      if(run == &co_host) root(); else run->entry();
    }
    if(co_unwinding) {
      co_unwinding = 0;
      romdev_asyncify_stop_unwind();
      run = co_target;
      continue;
    }
    if(run == &co_host) break;
    abort();  /* a cothread's entry returned: libco cothreads must never return */
  }
  co_running = &co_host;
}

void romdev_co_run(void (*root)(void)) {
  if(co_in_trampoline) { root(); return; }
  if(!co_host.abuf) {
    static unsigned char host_buffer[CO_ASYNCIFY_BYTES] __attribute__((aligned(16)));
    co_host.magic = CO_MAGIC;
    co_host.abuf = host_buffer;
    co_host.abuf_size = sizeof host_buffer;
  }
  co_in_trampoline = 1;
  romdev_co_trampoline(root);
  co_in_trampoline = 0;
}

#ifdef __cplusplus
}
#endif
