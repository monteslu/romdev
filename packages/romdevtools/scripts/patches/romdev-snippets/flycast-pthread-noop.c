// romdev: neutralize ALL worker threads for the single-threaded Flycast WASM build.
// pthread_create "succeeds" (returns 0) but spawns NOTHING — std::thread's ctor
// doesn't throw (no abort in flycast's -fno-exceptions code), and join/detach are
// no-ops. The async/worker threads (achievements/http/network/audio) never run;
// emulation is synchronous on retro_run (ThreadedRendering defaulted false). This is
// the clean fix for the "thread constructor failed" abort + the pthread/main-thread
// `unwind` (no threads → the main thread never blocks on a worker).
#include <pthread.h>
static volatile unsigned long s_fakeid = 1;
int __wrap_pthread_create(pthread_t* thread, const pthread_attr_t* attr,
                          void* (*start)(void*), void* arg) {
  (void)attr; (void)start; (void)arg;
  if (thread) *thread = (pthread_t)(__sync_add_and_fetch(&s_fakeid, 1));
  return 0;
}
int __wrap_pthread_join(pthread_t thread, void** retval) {
  (void)thread; if (retval) *retval = 0; return 0;
}
int __wrap_pthread_detach(pthread_t thread) { (void)thread; return 0; }
