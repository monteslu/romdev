// The frame-timing contract (gpu-timing/measure.js) for a libretro core.
//
// Every core gets wall and CPU time per frame (one retro_run plus romdev's
// per-frame work). A core that renders through GL on romdev's own context
// (the HW-render cores that run on the main thread: N64 ParaLLEl, PS1 Beetle
// PSX HW, Dreamcast Flycast as registered) also gets GPU time: a
// GL_TIME_ELAPSED query on that context around the frame, read after
// glFinish. A core that runs its GL on a worker thread (proxied) or renders
// on the CPU reports GPU time "unavailable" with the reason.
//
// The query is made through native-gles, the binding the core's GL calls go
// to, on the core's own context (LibretroGL.makeCurrent). The frame includes
// romdev's HW-render readback (glReadPixels of the core's framebuffer), which
// every stepped frame pays on romdev.
//
// Plain JS ESM + JSDoc.

const TIME_ELAPSED = 0x88bf, QUERY_RESULT = 0x8866, QUERY_RESULT_AVAILABLE = 0x8867, GPU_DISJOINT = 0x8fbb;

let _gles;
async function gles() {
  if (_gles !== undefined) return _gles;
  try { _gles = (await import("native-gles")).default; } catch { _gles = null; }
  return _gles;
}

/**
 * Give a LibretroHost the timing contract, once. Returns the host.
 * @param {object} host
 */
export function withLibretroTiming(host) {
  if (typeof host.timedFrame === "function") return host;
  let q = null, g = null, ok = false, reason = null;
  const hw = () => host.hwRender && host.hwRender.active;
  host.timingInfo = () => {
    const proxied = !!(host._proxied || host.state?.proxied);
    let gpu;
    if (!hw()) gpu = { available: false, reason: `this ${host.status?.platform ?? "libretro"} core renders on the CPU: there is no GPU work to time` };
    else if (proxied) gpu = { available: false, reason: "this core runs its GL on its own worker thread, where romdev cannot put a timer query: wall and CPU only" };
    else if (reason) gpu = { available: false, reason };
    else gpu = { available: true, measure: "span", method: "a GL_TIME_ELAPSED query on the core's GL context around retro_run and romdev's framebuffer readback" };
    return {
      host: "libretro", api: hw() ? "gl" : "cpu",
      cpu: "time inside the frame: retro_run plus romdev's per-frame input, audio and (HW render) readback",
      wall: hw() ? "frame start until glFinish returned (the GPU finished the frame)" : "the same as cpu: the core runs synchronously",
      gpu, size: { width: host.status?.fbWidth, height: host.status?.fbHeight },
    };
  };
  host.timingBegin = async () => {
    ok = false; reason = null;
    if (!hw() || host._proxied) return;
    g = await gles();
    if (!g) { reason = "native-gles did not load"; return; }
    host.hwRender.makeCurrent();
    if (q == null) { const a = new Uint32Array(1); g.glGenQueries(1, a); q = a[0]; }
    while (g.glGetError() !== 0) { /* clear */ }
    g.glBeginQuery(TIME_ELAPSED, q);
    const err = g.glGetError();
    if (err !== 0) { reason = `this GL context refused a GL_TIME_ELAPSED query (GL error 0x${err.toString(16)}): no EXT_disjoint_timer_query`; return; }
    g.glEndQuery(TIME_ELAPSED);
    ok = true;
  };
  host.timedFrame = async () => {
    const t0 = performance.now();
    if (ok) { host.hwRender.makeCurrent(); g.glBeginQuery(TIME_ELAPSED, q); }
    await host.stepFrames(1);
    const cpuMs = performance.now() - t0;
    if (!ok) return { wallMs: cpuMs, cpuMs, gpuMs: null, gpuSpanMs: null };
    host.hwRender.makeCurrent();
    g.glEndQuery(TIME_ELAPSED);
    g.glFinish();
    const wallMs = performance.now() - t0;
    let gpuMs = null, gpuNote;
    if (g.glGetQueryObjectuiv(q, QUERY_RESULT_AVAILABLE)) {
      const disjoint = (() => { try { const a = new Int32Array(1); g.glGetIntegerv?.(GPU_DISJOINT, a); return a[0] !== 0; } catch { return false; } })();
      if (disjoint) gpuNote = "GPU timer disjoint this frame";
      else gpuMs = g.glGetQueryObjectuiv(q, QUERY_RESULT) / 1e6;
    } else gpuNote = "the frame's query had no result after glFinish";
    return { wallMs, cpuMs, gpuMs, gpuSpanMs: gpuMs, ...(gpuNote ? { gpuNote } : {}) };
  };
  host.timingEnd = async () => {};
  return host;
}
