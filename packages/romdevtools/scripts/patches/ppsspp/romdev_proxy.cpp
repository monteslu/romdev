// romdev_proxy.cpp — run the PPSSPP core on a dedicated "app thread" so the JS main thread
// stays a pure message pump and PPSSPP's worker threads never deadlock proxying back to it.
//
// THE PROBLEM: PPSSPP (with -pthread) has worker threads (GL/IO/audio) that make calls
// emscripten proxies to the JS main thread. The romdev host drives the core by calling
// retro_run() synchronously, which would block the JS main thread → those proxied calls could
// never complete → deadlock.
//
// THE FIX: an explicit "app thread" (a pthread we spawn). The host calls the romdev_proxied_*
// wrappers from the JS main thread; each proxies the real retro_* call onto the app thread via
// emscripten_proxy_sync. While the JS main thread waits inside proxy_sync it STILL services
// incoming proxied calls from PPSSPP's workers (validated by PoC) — so no deadlock. PPSSPP's
// native threading stays fully intact; ZERO thread-elimination hacks. The GL context is created
// + used + read back all on the app thread (retro_load_game/run/readback all proxy there).
//
// Only the PSP core links this; other GL cores keep the host's direct synchronous path.

#ifdef __EMSCRIPTEN__

#include <emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <pthread.h>

extern "C" {

bool retro_load_game(const void *info);
void retro_run(void);
void retro_reset(void);
void retro_unload_game(void);

static em_proxying_queue *g_q = nullptr;
static pthread_t g_app_thread;
static volatile int g_app_ready = 0;

// The app thread: park forever executing proxied work. emscripten_exit_with_live_runtime keeps
// this pthread + the runtime alive; the proxying queue is pumped by the runtime.
static void *app_thread_main(void *arg) {
  (void)arg;
  g_app_ready = 1;
  emscripten_exit_with_live_runtime();
  return nullptr;
}

// Called once from JS (the main thread) right after the module loads. Spawns the app thread.
EMSCRIPTEN_KEEPALIVE void romdev_proxy_init(void) {
  if (g_q) return;
  g_q = emscripten_proxy_get_system_queue();
  pthread_create(&g_app_thread, nullptr, app_thread_main, nullptr);
  // spin until the app thread has recorded itself (cheap; happens immediately)
  while (!g_app_ready) { emscripten_thread_sleep(1); }
}

EMSCRIPTEN_KEEPALIVE int romdev_app_ready(void) { return g_app_ready; }

struct LoadArgs { const void *info; bool result; };
static void run_load(void *p) { auto *a = (LoadArgs *)p; a->result = retro_load_game(a->info); }
EMSCRIPTEN_KEEPALIVE int romdev_proxied_load_game(const void *info) {
  LoadArgs a{info, false};
  if (!emscripten_proxy_sync(g_q, g_app_thread, run_load, &a)) return 0;
  return a.result ? 1 : 0;
}

static void run_run(void *p) { (void)p; retro_run(); }
EMSCRIPTEN_KEEPALIVE void romdev_proxied_run(void) {
  emscripten_proxy_sync(g_q, g_app_thread, run_run, nullptr);
}

static void run_reset(void *p) { (void)p; retro_reset(); }
EMSCRIPTEN_KEEPALIVE void romdev_proxied_reset(void) {
  emscripten_proxy_sync(g_q, g_app_thread, run_reset, nullptr);
}

static void run_unload(void *p) { (void)p; retro_unload_game(); }
EMSCRIPTEN_KEEPALIVE void romdev_proxied_unload(void) {
  emscripten_proxy_sync(g_q, g_app_thread, run_unload, nullptr);
}

// Run a host-supplied function pointer (the GL readback) on the app thread, so glReadPixels
// happens on the thread that owns the GL context.
static void run_thunk(void *p) { ((void (*)(void))p)(); }
EMSCRIPTEN_KEEPALIVE void romdev_proxied_call(void *fnPtr) {
  emscripten_proxy_sync(g_q, g_app_thread, run_thunk, fnPtr);
}

// Build the ENTIRE GL stack ON THE APP THREAD: import native-gles + webgl-node (validated to
// work inside an emscripten pthread = Node worker_thread), create the offscreen canvas + EGL
// context there, install the WebGL2 globals Emscripten probes, and create + make-current the
// Emscripten GL context. After this the core's GL (context_reset, draw) + the readback all run
// on this thread, while the JS main thread stays a pure message pump. Width/height come in via
// shared WASM memory (set by the host before calling). Synchronous EM_ASM so it completes
// before the proxied call returns.
// GL setup needs an async import() on the app thread; a spin-wait would block the app thread's
// event loop and the import would never resolve. So use emscripten_proxy_sync_with_ctx: the
// proxied fn kicks off the async import and stashes the proxying ctx; the async JS calls
// romdev_gl_setup_finish(ctx, ok) when done, which marks the task finished — only THEN does the
// host's proxy_sync return. The host thread (blocked in proxy_sync) keeps pumping its own queue.
static volatile int g_gl_setup_result = 0;
static int g_gl_w = 480, g_gl_h = 272;

extern "C" EMSCRIPTEN_KEEPALIVE void romdev_gl_setup_finish(void *ctx, int ok) {
  g_gl_setup_result = ok;
  emscripten_proxy_finish((em_proxying_ctx *)ctx);
}

static void gl_setup_ctx(em_proxying_ctx *ctx, void *p) {
  (void)p;
  int w = g_gl_w, h = g_gl_h;
  EM_ASM({
    var w = $0; var h = $1; var ctx = $2;
    (async () => {
      try {
        var nativeGles = (await import("native-gles")).default;
        var webglNode = await import("webgl-node");
        var ctxPair = webglNode.createWebGL2Context(w, h);
        var canvas = ctxPair.canvas;
        canvas.getContextSafariWebGL2Fixed = canvas.getContext;
        globalThis.WebGL2RenderingContext = webglNode.WebGL2RenderingContext;
        if (typeof globalThis.WebGLRenderingContext === 'undefined')
          globalThis.WebGLRenderingContext = class WebGLRenderingContext {};
        Module['romdev_nativeGles'] = nativeGles;
        Module['romdev_appCanvas'] = canvas;
        var hnd = Module['GL'].createContext(canvas, { majorVersion: 2 });
        if (hnd > 0) Module['GL'].makeContextCurrent(hnd);
        Module['_romdev_gl_setup_finish'](ctx, 1);
      } catch (e) { console.error('[romdev gl_setup]', e); Module['_romdev_gl_setup_finish'](ctx, -1); }
    })();
  }, w, h, ctx);
}
EMSCRIPTEN_KEEPALIVE int romdev_proxied_gl_setup(int w, int h) {
  g_gl_w = w; g_gl_h = h;
  g_gl_setup_result = 0;
  emscripten_proxy_sync_with_ctx(g_q, g_app_thread, gl_setup_ctx, nullptr);
  return g_gl_setup_result;
}

// Read back the rendered frame ON THE APP THREAD into a WASM buffer the host then copies out.
// (glReadPixels must run on the GL-owning thread.) Returns via the shared buffer pointer.
struct ReadbackArgs { int w; int h; unsigned char *out; };
static void gl_readback(void *p) {
  auto *a = (ReadbackArgs *)p;
  EM_ASM({
    var w = $0; var h = $1; var outPtr = $2;
    var gl = Module['romdev_nativeGles'];
    gl.makeCurrent();
    gl.glFinish();
    var px = new Uint8Array(w * h * 4);
    gl.glBindFramebuffer(0x8D40, 0);
    gl.glReadPixels(0, 0, w, h, 0x1908, 0x1401, px);
    HEAPU8.set(px, outPtr);
  }, a->w, a->h, a->out);
}
EMSCRIPTEN_KEEPALIVE void romdev_proxied_readback(int w, int h, unsigned char *out) {
  ReadbackArgs a{w, h, out};
  emscripten_proxy_sync(g_q, g_app_thread, gl_readback, &a);
}

} // extern "C"

#endif // __EMSCRIPTEN__
