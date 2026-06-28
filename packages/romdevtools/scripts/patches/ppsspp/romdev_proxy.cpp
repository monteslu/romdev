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
void retro_set_environment(void *cb);
void retro_set_video_refresh(void *cb);
void retro_set_audio_sample(void *cb);
void retro_set_audio_sample_batch(void *cb);
void retro_set_input_poll(void *cb);
void retro_set_input_state(void *cb);

static em_proxying_queue *g_q = nullptr;
static pthread_t g_app_thread;
static pthread_t g_main_thread;
static volatile int g_app_ready = 0;

// ── libretro callback trampolines ──
// The core (running on the app thread) invokes these. They proxy to the MAIN thread to run the
// real JS callback (which touches host JS state). The main thread is blocked in
// emscripten_proxy_sync(load_game/run) but pumps its own queue while waiting — validated — so
// the round-trip completes without deadlock. The host installs the JS impls as Module fns.
struct EnvArgs { unsigned cmd; void *data; int ret; };
static void env_on_main(void *p) {
  auto *a = (EnvArgs *)p;
  a->ret = EM_ASM_INT({ return Module['romdev_envCb']($0, $1); }, a->cmd, a->data);
}
static bool tramp_env(unsigned cmd, void *data) {
  EnvArgs a{cmd, data, 0};
  if (pthread_self() == g_main_thread) env_on_main(&a);  // already on main → run directly
  else emscripten_proxy_sync(g_q, g_main_thread, env_on_main, &a);
  return a.ret != 0;
}
struct VideoArgs { const void *data; unsigned w, h, pitch; };
static void video_on_main(void *p) {
  auto *a = (VideoArgs *)p;
  EM_ASM({ Module['romdev_videoCb']($0, $1, $2, $3); }, a->data, a->w, a->h, a->pitch);
}
static void tramp_video(const void *data, unsigned w, unsigned h, unsigned pitch) {
  VideoArgs a{data, w, h, pitch};
  if (pthread_self() == g_main_thread) video_on_main(&a);
  else emscripten_proxy_sync(g_q, g_main_thread, video_on_main, &a);
}
struct AudioBatchArgs { const void *data; unsigned frames; unsigned ret; };
static void audio_batch_on_main(void *p) {
  auto *a = (AudioBatchArgs *)p;
  a->ret = EM_ASM_INT({ return Module['romdev_audioBatchCb']($0, $1); }, a->data, a->frames);
}
static unsigned tramp_audio_batch(const void *data, unsigned frames) {
  AudioBatchArgs a{data, frames, frames};
  if (pthread_self() == g_main_thread) audio_batch_on_main(&a);
  else emscripten_proxy_sync(g_q, g_main_thread, audio_batch_on_main, &a);
  return a.ret;
}
static void tramp_audio_one(short l, short r) { (void)l; (void)r; }  // batch path is used
static void tramp_input_poll(void) { }
struct InputArgs { unsigned port, device, idx, id; int ret; };
static void input_on_main(void *p) {
  auto *a = (InputArgs *)p;
  a->ret = EM_ASM_INT({ return Module['romdev_inputCb']($0, $1, $2, $3); }, a->port, a->device, a->idx, a->id);
}
static short tramp_input_state(unsigned port, unsigned device, unsigned idx, unsigned id) {
  InputArgs a{port, device, idx, id, 0};
  if (pthread_self() == g_main_thread) input_on_main(&a);
  else emscripten_proxy_sync(g_q, g_main_thread, input_on_main, &a);
  return (short)a.ret;
}

// ── HW-render struct callbacks (get_current_framebuffer + get_proc_address) ──
// SET_HW_RENDER hands the core a retro_hw_render_callback struct; the host fills in
// get_current_framebuffer (+8) and get_proc_address (+12). These must be C function pointers
// (valid on the app thread where the core calls them), NOT main-thread addFunction trampolines
// (table-index-out-of-bounds on the app thread). The host writes these via the *_ptr() getters.
unsigned emscripten_GetProcAddress(const char *name);
static unsigned romdev_hw_get_fb(void) { return 0; }
static unsigned romdev_hw_get_proc(const char *sym) { return emscripten_GetProcAddress(sym); }
EMSCRIPTEN_KEEPALIVE void *romdev_hw_get_fb_ptr(void) { return (void *)romdev_hw_get_fb; }
EMSCRIPTEN_KEEPALIVE void *romdev_hw_get_proc_ptr(void) { return (void *)romdev_hw_get_proc; }

// The libretro log callback (retro_log_printf_t). The core calls this from the app thread during
// load/run, so it must be a C function pointer (a main-thread addFunction would be a bad table
// index here). Route to console; varargs ignored (PPSSPP pre-formats most messages).
#include <cstdarg>
static void romdev_log_cb(int level, const char *fmt, ...) {
  (void)level;
  EM_ASM({ if (Module['romdev_logCb']) Module['romdev_logCb']($0, $1); }, level, fmt);
}
EMSCRIPTEN_KEEPALIVE void *romdev_log_cb_ptr(void) { return (void *)romdev_log_cb; }

// Fire the core's context_reset (read from the hw_render struct at SET_HW_RENDER) ON THE APP
// THREAD, where the GL context lives — so PPSSPP (re)builds its GL resources against our surface.
// The host passes the pointer (it read it during SET_HW_RENDER on the main side).
typedef void (*ctx_reset_fn)(void);
static ctx_reset_fn g_ctx_reset = nullptr;
static void run_ctx_reset(void *p) {
  (void)p;
  // Make the EMSCRIPTEN GL context (Module.GL → GLctx, which PPSSPP's GL calls go through) current
  // before context_reset — it creates the DrawContext + GL render manager via GLctx. native-gles
  // makeCurrent alone isn't enough (PPSSPP renders through GLctx, not the raw binding).
  EM_ASM({
    if (Module['romdev_nativeGles']) Module['romdev_nativeGles'].makeCurrent();
    if (Module['GL'] && Module['romdev_glHandle'] != null) Module['GL'].makeContextCurrent(Module['romdev_glHandle']);
  });
  if (g_ctx_reset) g_ctx_reset();
}
EMSCRIPTEN_KEEPALIVE void romdev_proxied_fire_context_reset(void *fn) {
  g_ctx_reset = (ctx_reset_fn)fn;
  if (g_ctx_reset) emscripten_proxy_sync(g_q, g_app_thread, run_ctx_reset, nullptr);
}


// Register the trampolines with the core. Runs ON THE APP THREAD (proxied), so the function
// pointers are valid there (where the core invokes them). Called once before retro_init.
EMSCRIPTEN_KEEPALIVE void romdev_register_callbacks(void) {
  retro_set_environment((void *)tramp_env);
  retro_set_video_refresh((void *)tramp_video);
  retro_set_audio_sample((void *)tramp_audio_one);
  retro_set_audio_sample_batch((void *)tramp_audio_batch);
  retro_set_input_poll((void *)tramp_input_poll);
  retro_set_input_state((void *)tramp_input_state);
}

// The app thread: park forever executing proxied work (live runtime keeps it + the runtime alive).
static void *app_thread_main(void *arg) {
  (void)arg;
  // Do NOT set g_app_ready here — it would be true before the runtime's event loop (below) is
  // actually pumping the proxy queue, so a proxied call from main would sit unprocessed and a
  // proxy_sync would hang main forever. Instead the host pings via romdev_app_ping (proxied), and
  // ping_on_app sets g_app_ready — which only runs once the queue is being serviced.
  emscripten_exit_with_live_runtime();
  return nullptr;
}
// Runs ON the app thread (proxied) once its queue is live → proves the channel works.
static void ping_on_app(void *p) { (void)p; g_app_ready = 1; }
EMSCRIPTEN_KEEPALIVE void romdev_app_ping(void) {
  // proxy_async: returns immediately; the host then polls romdev_app_ready() while pumping +
  // yielding, so the app thread's event loop spins up and runs ping_on_app.
  emscripten_proxy_async(g_q, g_app_thread, ping_on_app, nullptr);
}
EMSCRIPTEN_KEEPALIVE void romdev_proxy_init(void) {
  if (g_q) return;
  g_q = emscripten_proxy_get_system_queue();
  g_main_thread = pthread_self();
  pthread_create(&g_app_thread, nullptr, app_thread_main, nullptr);
  // The host calls romdev_app_ping() then waits for romdev_app_ready() in JS (yielding + pumping).
}

// Write a file into the APP THREAD's MEMFS (its JS heap), so PPSSPP's fopen on the app thread
// finds it. MEMFS is per-thread, so a main-thread FS.writeFile is invisible to the app thread.
// The host stages the bytes in WASM memory (shared) + the path; this copies them on the app thread.
struct FsWriteArgs { const char *path; const unsigned char *data; int len; };
static void fs_write_on_app(void *p) {
  auto *a = (FsWriteArgs *)p;
  EM_ASM({
    var path = UTF8ToString($0);
    var bytes = HEAPU8.subarray($1, $1 + $2);
    try {
      // mkdir -p the parent dirs
      var parts = path.split('/'); var cur = '';
      for (var i = 1; i < parts.length - 1; i++) { cur += '/' + parts[i]; try { FS.mkdir(cur); } catch(e) {} }
      FS.writeFile(path, bytes);
    } catch (e) { console.error('[romdev fs_write]', path, e); }
  }, a->path, a->data, a->len);
}
EMSCRIPTEN_KEEPALIVE void romdev_app_fs_write(const char *path, const unsigned char *data, int len) {
  FsWriteArgs a{path, data, len};
  emscripten_proxy_sync(g_q, g_app_thread, fs_write_on_app, &a);
}

// Proxied retro_init — runs the core's init on the app thread (after callbacks are registered).
void retro_init(void);
static void run_init(void *p) { (void)p; retro_init(); }
EMSCRIPTEN_KEEPALIVE void romdev_proxied_init(void) {
  emscripten_proxy_sync(g_q, g_app_thread, run_init, nullptr);
}

// Register the callback trampolines on the app thread (so the function pointers belong there).
static void do_register_cbs(void *p) { (void)p; romdev_register_callbacks(); }
EMSCRIPTEN_KEEPALIVE void romdev_proxied_register_callbacks(void) {
  emscripten_proxy_sync(g_q, g_app_thread, do_register_cbs, nullptr);
}

EMSCRIPTEN_KEEPALIVE int romdev_app_ready(void) { return g_app_ready; }

// ── ASYNC load_game + run ──
// Critical: emscripten_proxy_ASYNC (not sync) so the JS MAIN thread is NOT blocked — its event
// loop keeps turning, which is what services PPSSPP's worker-thread operations (pooled-Worker
// grabs, postMessage wakeups, futex). A blocking proxy_sync freezes main's event loop → the
// core's threads can't be scheduled → deadlock. The host kicks the async op then polls the done
// flag from JS, yielding to the event loop between polls. load: 0=running,1=ok,2=fail. run:1=busy.
static volatile int g_load_state = 0;
static const void *g_load_info = nullptr;
static void run_load_async(void *p) { (void)p; g_load_state = retro_load_game(g_load_info) ? 1 : 2; }
EMSCRIPTEN_KEEPALIVE void romdev_proxied_load_game_start(const void *info) {
  g_load_state = 0; g_load_info = info;
  emscripten_proxy_async(g_q, g_app_thread, run_load_async, nullptr);
}
EMSCRIPTEN_KEEPALIVE int romdev_proxied_load_state(void) { return g_load_state; }

static volatile int g_run_state = 0;
static void run_run_async(void *p) { (void)p; retro_run(); g_run_state = 0; }
EMSCRIPTEN_KEEPALIVE void romdev_proxied_run_start(void) {
  g_run_state = 1;
  emscripten_proxy_async(g_q, g_app_thread, run_run_async, nullptr);
}
EMSCRIPTEN_KEEPALIVE int romdev_proxied_run_state(void) { return g_run_state; }

// The host's async poll loop calls this each tick (on the MAIN thread) to execute any callbacks
// the app thread proxied back to main. With async load/run, main isn't blocked in proxy_sync (so
// it doesn't auto-pump), so we pump explicitly — while still yielding to the JS event loop
// between pumps (so emscripten can service the app thread's pooled-Worker grabs / postMessage).
// Drain the main thread's proxy queue. Guard against re-entry: a proxied task can itself end up
// here (emscripten may pump while a task runs), and nesting emscripten_proxy_execute_queue blows
// the JS stack. The flag makes a nested call a no-op — the outer drain finishes the work.
static volatile int g_pumping = 0;
EMSCRIPTEN_KEEPALIVE void romdev_pump_main_queue(void) {
  if (g_pumping) return;
  g_pumping = 1;
  emscripten_proxy_execute_queue(g_q);
  g_pumping = 0;
}

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

// retro_get_system_av_info + retro_set_controller_port_device read/touch core state that lives on
// the app thread — proxy them there (a direct main-thread call wedges).
void retro_get_system_av_info(void *info);
struct AvArgs { void *info; };
static void run_av_info(void *p) { retro_get_system_av_info(((AvArgs *)p)->info); }
EMSCRIPTEN_KEEPALIVE void romdev_proxied_av_info(void *info) {
  AvArgs a{info};
  emscripten_proxy_sync(g_q, g_app_thread, run_av_info, &a);
}
void retro_set_controller_port_device(unsigned port, unsigned device);
struct CtrlArgs { unsigned port, device; };
static void run_ctrl(void *p) { auto *a = (CtrlArgs *)p; retro_set_controller_port_device(a->port, a->device); }
EMSCRIPTEN_KEEPALIVE void romdev_proxied_set_controller(unsigned port, unsigned device) {
  CtrlArgs a{port, device};
  emscripten_proxy_sync(g_q, g_app_thread, run_ctrl, &a);
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

// Async GL setup: kick it on the app thread, then the host polls romdev_gl_setup_state while
// pumping the main queue + yielding (so the app thread's import() can use the main event loop).
// proxy_async doesn't carry an em_proxying_ctx, so the JS finish writes g_gl_setup_result and
// also flips g_gl_setup_started→2 done. 0=idle,1=running,2=done(result in g_gl_setup_result).
static volatile int g_gl_setup_phase = 0;
static void gl_setup_async(void *p) {
  (void)p;
  int w = g_gl_w, h = g_gl_h;
  EM_ASM({
    var w = $0; var h = $1;
    (async () => {
      try {
        var nativeGles = (await import("native-gles")).default;
        var webglNode = await import("webgl-node");
        // webgl-node.createWebGL2Context creates the shared EGL surface (native-gles + webgl-node
        // render into the same surface the readback reads). Don't also call
        // nativeGles.createContext — that makes a SECOND context and segfaults.
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
        Module['romdev_glHandle'] = hnd;
        Module['_romdev_gl_setup_set_phase'](1, 2);
      } catch (e) { console.error('[romdev gl_setup]', e); Module['_romdev_gl_setup_set_phase'](-1, 2); }
    })();
  }, w, h);
}
EMSCRIPTEN_KEEPALIVE void romdev_gl_setup_set_phase(int result, int phase) {
  g_gl_setup_result = result; g_gl_setup_phase = phase;
}
EMSCRIPTEN_KEEPALIVE void romdev_proxied_gl_setup_start(int w, int h) {
  g_gl_w = w; g_gl_h = h; g_gl_setup_result = 0; g_gl_setup_phase = 1;
  emscripten_proxy_async(g_q, g_app_thread, gl_setup_async, nullptr);
}
EMSCRIPTEN_KEEPALIVE int romdev_gl_setup_phase(void) { return g_gl_setup_phase; }
EMSCRIPTEN_KEEPALIVE int romdev_gl_setup_result(void) { return g_gl_setup_result; }

// Read back the rendered frame ON THE APP THREAD into a WASM buffer the host then copies out.
// (glReadPixels must run on the GL-owning thread.) Returns via the shared buffer pointer.
struct ReadbackArgs { int w; int h; unsigned char *out; };
static void gl_readback(void *p) {
  auto *a = (ReadbackArgs *)p;
  EM_ASM({
    var w = $0; var h = $1; var outPtr = $2;
    var px = new Uint8Array(w * h * 4);
    // PPSSPP renders through GLctx (the webgl-node WebGL2 context Module.GL is bound to). Read from
    // THAT context so we read exactly the surface PPSSPP drew to (the separate native-gles handle
    // may be a different EGL context). Fall back to native-gles if GLctx is unavailable.
    try {
      if (typeof GLctx !== 'undefined' && GLctx && GLctx.readPixels) {
        GLctx.bindFramebuffer(GLctx.FRAMEBUFFER, null);
        GLctx.finish();
        GLctx.readPixels(0, 0, w, h, GLctx.RGBA, GLctx.UNSIGNED_BYTE, px);
        HEAPU8.set(px, outPtr);
        return;
      }
    } catch (e) { /* fall through to native-gles */ }
    var gl = Module['romdev_nativeGles'];
    gl.makeCurrent();
    gl.glFinish();
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
