// Load an Emscripten-built libretro core from disk and return the Module.
//
// Cores ship as two files: `<name>_libretro.js` (Emscripten glue) and
// `<name>_libretro.wasm` (the binary). The .js is a factory.
//
// In Node we import the .js dynamically. Emscripten's Node glue locates the
// .wasm next to the .js automatically unless we pass `wasmBinary`.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { RETRO_API_VERSION } from "./retroConstants.js";

/**
 * @typedef {Object} LoadCoreArgs
 * @property {string} jsPath absolute path to the `_libretro.js` glue
 * @property {string} [wasmPath] absolute path to the `.wasm`; if omitted, Emscripten resolves next to the .js
 * @property {object} [glCanvas] HW-render cores (n64/ps1): a webgl-node mock canvas the
 *   minified Emscripten glue drives via `GLctx = canvas.getContext('webgl2')`.
 * @property {object} [glBridge] HW-render cores with UNMINIFIED imports: a map of GL
 *   function name → native-gles impl, patched directly into the WASM env imports.
 */

/**
 * Loads a libretro core's Emscripten module. Does NOT call _retro_init() —
 * the caller must register callbacks first, then init.
 * @param {LoadCoreArgs} args
 */
export async function loadLibretroCore(args) {
  const { jsPath, wasmPath, glCanvas, glBridge } = args;

  const url = pathToFileURL(jsPath).href + "?t=" + Date.now();
  const ns = await import(url);
  const factory = ns.default;
  if (typeof factory !== "function") {
    throw new Error(`Core glue at ${jsPath} did not default-export an Emscripten factory`);
  }

  /** @type {Record<string, unknown>} */
  const opts = {
    print: process.env.ROMDEV_CORE_LOG ? (s) => console.error("[core]", s) : () => {},
    printErr: process.env.ROMDEV_CORE_LOG ? (s) => console.error("[core:err]", s) : () => {},
  };
  // The cores are linked with INVOKE_RUN=0, so main() never auto-runs regardless.
  // Do NOT set noInitialRun on GL (canvas) cores: it suppresses the Emscripten GL
  // runtime init, so `Module.GL` (and thus the WebGL2/native-gles context the core's
  // SET_HW_RENDER path needs) is never created. For non-GL cores it's harmless either
  // way; we set it only there to keep their startup identical to before.
  if (!glCanvas) opts.noInitialRun = true;

  // HW-render cores: minified glue uses GLctx = canvas.getContext('webgl2'), so we
  // hand it a webgl-node mock canvas + install the WebGL2 globals Emscripten probes.
  if (glCanvas) {
    opts.canvas = glCanvas;
    if (typeof globalThis.WebGL2RenderingContext === "undefined") {
      const { WebGL2RenderingContext } = await import("webgl-node");
      globalThis.WebGL2RenderingContext = WebGL2RenderingContext;
      // CRITICAL: WebGLRenderingContext (WebGL1) must be a DISTINCT class from
      // WebGL2RenderingContext. Emscripten's getContext shim does
      //   return (ver=="webgl") == (gl instanceof WebGLRenderingContext) ? gl : null
      // For ver="webgl2" that needs `gl instanceof WebGLRenderingContext` to be
      // FALSE. If we aliased WebGLRenderingContext to the WebGL2 class, a webgl2
      // context IS instanceof it → the shim returns null → GLctx never set → the
      // core renders nothing. So WebGL1 gets its own empty marker class.
      globalThis.WebGLRenderingContext = class WebGLRenderingContext {};
    }
  }

  if (wasmPath && glBridge) {
    // Unminified GL cores: patch GL function imports + no-op EGL (we own EGL via
    // native-gles), and capture the instance memory for the bridge's marshaling.
    const wasmBinary = await readFile(wasmPath);
    opts.instantiateWasm = (info, receiveInstance) => {
      for (const nsObj of Object.values(info)) {
        if (typeof nsObj !== "object" || nsObj === null) continue;
        for (const [name, fn] of Object.entries(glBridge)) {
          if (name in nsObj) nsObj[name] = fn;
        }
        if ("eglGetDisplay" in nsObj) {
          nsObj.eglGetDisplay = () => 62000;
          nsObj.eglInitialize = () => 1;
          nsObj.eglQueryString = () => 0;
        }
      }
      WebAssembly.instantiate(wasmBinary, info).then((result) => {
        if (glBridge._setMemory && result.instance.exports.memory) {
          glBridge._setMemory(result.instance.exports.memory);
        }
        receiveInstance(result.instance, result.module);
      });
      return {};
    };
  } else if (wasmPath && !glCanvas) {
    opts.wasmBinary = await readFile(wasmPath);
  } else if (wasmPath && glCanvas) {
    // GL (canvas) cores: do NOT hand Emscripten a pre-read wasmBinary. Passing it
    // routes instantiation through a path that skips the GL runtime init, so
    // `Module.GL` (the WebGL2/native-gles context the SET_HW_RENDER path needs) is
    // never created. Let Emscripten locate `<name>.wasm` next to the `.js` itself
    // (via locateFile) — the same way retroemu loads parallel_n64/flycast.
    const wasmDir = wasmPath.slice(0, wasmPath.lastIndexOf("/") + 1);
    opts.locateFile = (file) => wasmDir + file;
  }

  const mod = await factory(opts);

  if (typeof mod._retro_api_version !== "function") {
    throw new Error(`Core ${jsPath} missing _retro_api_version export`);
  }
  const version = mod._retro_api_version();
  if (version !== RETRO_API_VERSION) {
    throw new Error(
      `Core ${jsPath} reports retro_api_version=${version}, expected ${RETRO_API_VERSION}`,
    );
  }

  return mod;
}
