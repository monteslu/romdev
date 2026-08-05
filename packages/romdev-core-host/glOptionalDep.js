// glOptionalDep.js — lazy, optional loader for the native GL stack.
//
// The HW-render cores (N64 ParaLLEl, PS1 Beetle-PSX) need a real headless GL
// context. romdev provides it through `native-gles` (EGL/GLES via a prebuilt
// .node) and `webgl-node` (a WebGL2 context object for the minified Emscripten
// cores). Both are OPTIONAL dependencies: the 14 software-rendered cores never
// touch them, and a headless user who never boots N64/PS1 doesn't need them
// installed. We load them lazily and, if absent, throw ONE clear, actionable
// error instead of a cryptic module-not-found.

let _gl = null;
let _webgl = null;

const INSTALL_HINT =
  "N64/PS1 emulation needs the optional native GL module. Install it with:\n" +
  "  npm install native-gles webgl-node\n" +
  "(the other 14 platforms are software-rendered and don't require it).";

/**
 * Load the `native-gles` default export (the EGL/GLES binding). Cached.
 * @returns {Promise<object>} the native-gles module
 * @throws {Error} a clear install hint if the module isn't available
 */
export async function loadNativeGles() {
  if (_gl) return _gl;
  try {
    _gl = (await import("native-gles")).default;
  } catch (e) {
    throw new Error(`${INSTALL_HINT}\n(underlying: ${e.message})`);
  }
  if (!_gl || typeof _gl.createContext !== "function") {
    throw new Error(`native-gles loaded but has no createContext — ${INSTALL_HINT}`);
  }
  return _gl;
}

/**
 * Load `webgl-node`'s createWebGL2Context (the canvas/context the minified
 * Emscripten cores use via GLctx = canvas.getContext('webgl2')). Cached.
 * @returns {Promise<Function>} createWebGL2Context(width, height) → { canvas, gl }
 * @throws {Error} a clear install hint if the module isn't available
 */
export async function loadWebGl2Context() {
  if (_webgl) return _webgl;
  try {
    const m = await import("webgl-node");
    _webgl = m.createWebGL2Context;
  } catch (e) {
    throw new Error(`${INSTALL_HINT}\n(underlying: ${e.message})`);
  }
  if (typeof _webgl !== "function") {
    throw new Error(`webgl-node loaded but has no createWebGL2Context — ${INSTALL_HINT}`);
  }
  return _webgl;
}

let _ctxProbe = null; // null = untried; true/false = cached verdict

/**
 * Is the GL stack actually USABLE — not merely importable?
 *
 * The import-only version of this check passed on every machine with the
 * prebuilt .node installed, and then real context creation decided the truth:
 * fast EACCES on a box whose /dev/dri is ACL-gated (tests failed), or an
 * INDEFINITE BLOCK inside eglInitialize on a machine with no GPU device nodes
 * at all — which is what ate a CI runner's whole 30-minute job with two hung
 * addon threads. A native hang cannot be timed out in-process, so the probe
 * creates a real context in a CHILD process with a hard kill. Verdict cached
 * per process; each test file pays at most one probe.
 *
 * ROMDEV_NO_GL=1 short-circuits to false with no probe — set it where the
 * answer is known ahead of time (CI runners have no GPU, ever).
 */
export async function glStackAvailable() {
  if (process.env.ROMDEV_NO_GL === "1") return false;
  if (_ctxProbe !== null) return _ctxProbe;
  try { await loadNativeGles(); } catch { _ctxProbe = false; return false; }
  const { spawnSync } = await import("node:child_process");
  const probe =
    "import('webgl-node').then(m => { const c = m.createWebGL2Context(8, 8); " +
    "process.exit(c && c.gl ? 0 : 1); }).catch(() => process.exit(1));";
  const r = spawnSync(process.execPath, ["-e", probe], {
    timeout: 15000, killSignal: "SIGKILL", stdio: "ignore",
  });
  _ctxProbe = r.status === 0;
  return _ctxProbe;
}
