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

/** Best-effort probe: is the native GL stack importable? (for capability flags) */
export async function glStackAvailable() {
  try { await loadNativeGles(); return true; } catch { return false; }
}
