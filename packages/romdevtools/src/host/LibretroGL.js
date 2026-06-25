// LibretroGL.js — Hardware-rendered libretro core support
//
// Handles RETRO_ENVIRONMENT_SET_HW_RENDER by creating an EGL context via
// native-gles and providing the three required callbacks:
//   context_reset, get_current_framebuffer, get_proc_address
//
// The core renders to an FBO. After retro_run(), we readback via glReadPixels
// and send the pixels to VideoOutput (same as wasmcart GL carts).

import {
  RETRO_HW_CONTEXT_OPENGLES2,
  RETRO_HW_CONTEXT_OPENGLES3,
  RETRO_HW_CONTEXT_OPENGLES_VERSION,
  RETRO_HW_CONTEXT_OPENGL,
  RETRO_HW_CONTEXT_OPENGL_CORE,
} from './retroConstants.js';
import { loadNativeGles } from './glOptionalDep.js';

// `native-gles` is an OPTIONAL native dependency — only the HW-render cores
// (n64/ps1) need it. It's loaded lazily at setup() so the 14 software-rendered
// cores and headless installs without the GPU module are completely unaffected.
let gl = null;

// retro_hw_render_callback struct offsets (WASM32):
//   +0   i32  context_type
//   +4   ptr  context_reset       (set by frontend)
//   +8   ptr  get_current_framebuffer (set by frontend)
//   +12  ptr  get_proc_address    (set by frontend)
//   +16  u8   depth
//   +17  u8   stencil
//   +18  u8   bottom_left_origin
//   +20  u32  version_major       (aligned)
//   +24  u32  version_minor
//   +28  u8   cache_context
//   +32  ptr  context_destroy     (set by core)
//   +36  u8   debug_context

export class LibretroGL {
  constructor() {
    this.active = false;
    this.contextType = 0;
    this.bottomLeftOrigin = true;
    this.fbo = 0;
    this.fboW = 0;
    this.fboH = 0;
    this.contextResetPtr = 0;    // WASM function pointer
    this.contextDestroyPtr = 0;  // WASM function pointer
    this._mod = null;
    this._glPixels = null;
    this._flipped = null;

    // GL function name → addFunction wrapper pointer (cached)
    this._procAddressCache = new Map();
  }

  /**
   * Load the optional native GL module (lazy). MUST be awaited before the core
   * boots, since the 14 software cores never call this and the module is an
   * optional dependency. Populates the module-level `gl` used by
   * createContext/readbackFrame/destroy.
   * @returns {Promise<void>}
   */
  async ensureGl() {
    if (!gl) gl = await loadNativeGles();
  }

  /** Make this core's GL context current. Called before each _retro_run so the
   *  core renders into OUR FBO (a multi-host server may have switched contexts). */
  makeCurrent() {
    if (this.active && gl) gl.makeCurrent();
  }

  /**
   * Handle RETRO_ENVIRONMENT_SET_HW_RENDER.
   * Reads the struct, creates EGL context, writes callback pointers back.
   * @param {object} mod - Emscripten module
   * @param {number} dataPtr - pointer to retro_hw_render_callback
   * @returns {boolean} true if HW render is supported
   */
  setup(mod, dataPtr) {
    this._mod = mod;

    // Read struct fields set by the core
    const contextType = mod.getValue(dataPtr, 'i32');
    const depth = mod.HEAPU8[dataPtr + 16];
    const stencil = mod.HEAPU8[dataPtr + 17];
    this.bottomLeftOrigin = !!mod.HEAPU8[dataPtr + 18];
    const versionMajor = mod.getValue(dataPtr + 20, 'i32');
    const versionMinor = mod.getValue(dataPtr + 24, 'i32');
    this.contextDestroyPtr = mod.getValue(dataPtr + 32, 'i32');

    // Validate: we only support GL ES contexts
    const supported = [
      RETRO_HW_CONTEXT_OPENGLES2,
      RETRO_HW_CONTEXT_OPENGLES3,
      RETRO_HW_CONTEXT_OPENGLES_VERSION,
      RETRO_HW_CONTEXT_OPENGL,
      RETRO_HW_CONTEXT_OPENGL_CORE,
    ];
    if (!supported.includes(contextType)) {
      console.error(`[libretro-gl] Unsupported HW context type: ${contextType}`);
      return false;
    }

    this.contextType = contextType;
    console.error(`[libretro-gl] HW render requested: type=${contextType} version=${versionMajor}.${versionMinor} depth=${depth} stencil=${stencil} bottomLeft=${this.bottomLeftOrigin}`);

    // Create callback wrappers the WASM core can call

    // get_current_framebuffer() → returns FBO 0 (default framebuffer)
    // The core renders through Emscripten's GL which manages its own FBOs.
    // We read back from FBO 0 after retro_run.
    const getFBCb = mod.addFunction(() => {
      return 0;
    }, 'i');

    // get_proc_address(const char* sym) → returns function pointer
    const getProcCb = mod.addFunction((symPtr) => {
      return this._getProcAddress(symPtr);
    }, 'ii');

    // Write our callback pointers into the struct
    // context_reset at +4 — we'll call the core's context_reset after context creation
    // For now, store the core's context_reset so we can call it later
    this.contextResetPtr = mod.getValue(dataPtr + 4, 'i32');
    // We don't write context_reset back — the core already set it.
    // We only need to write get_current_framebuffer and get_proc_address.
    mod.setValue(dataPtr + 8, getFBCb, 'i32');
    mod.setValue(dataPtr + 12, getProcCb, 'i32');

    this.active = true;
    return true;
  }

  /**
   * Create FBO for the core to render into. Called after retro_load_game succeeds
   * and AV info is available.
   *
   * @param {number} width
   * @param {number} height
   * @param {boolean} contextExists - if true, EGL context was already created externally
   */
  createContext(width, height, contextExists = false) {
    this.fboW = width;
    this.fboH = height;

    if (contextExists) {
      // Context already created by LibretroHost before core loading.
      // Resize if needed and ensure it's current.
      gl.resizeContext(width, height);
      gl.makeCurrent();
    } else {
      // Create pbuffer EGL context
      if (!gl.createContext(width, height)) {
        console.error('[libretro-gl] Failed to create EGL context');
        return false;
      }
      gl.makeCurrent();
    }

    // Core renders to default FBO (0). We read back from there after retro_run.
    // The Emscripten GL layer manages its own FBO tracking — we don't create one.
    this.fbo = 0;
    gl.glViewport(0, 0, width, height);
    console.error(`[libretro-gl] Using default FBO: ${width}x${height}`);

    // Call the core's context_reset callback
    if (this.contextResetPtr) {
      this._mod.dynCall('v', this.contextResetPtr, []);
    }

    return true;
  }

  /**
   * Read back the rendered frame as RGBA pixels.
   * Returns { pixels, width, height } or null if not active.
   */
  readbackFrame() {
    if (!this.active) return null;

    gl.glFinish();
    const w = this.fboW, h = this.fboH;
    const GL_RGBA = 0x1908, GL_UNSIGNED_BYTE = 0x1401;

    if (!this._glPixels || this._glPixels.length !== w * h * 4) {
      this._glPixels = new Uint8Array(w * h * 4);
    }

    gl.glBindFramebuffer(0x8D40, 0); // GL_FRAMEBUFFER — read from default FBO
    gl.glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, this._glPixels);


    // Flip vertically if bottom-left origin (GL convention)
    let pixels;
    if (this.bottomLeftOrigin) {
      if (!this._flipped || this._flipped.length !== w * h * 4) {
        this._flipped = new Uint8Array(w * h * 4);
      }
      const rowBytes = w * 4;
      for (let y = 0; y < h; y++) {
        const srcOff = (h - 1 - y) * rowBytes;
        const dstOff = y * rowBytes;
        this._flipped.set(this._glPixels.subarray(srcOff, srcOff + rowBytes), dstOff);
      }
      pixels = this._flipped;
    } else {
      pixels = this._glPixels;
    }

    return { pixels, width: w, height: h };
  }

  /**
   * Resolve a GL function name to a WASM-callable function pointer.
   * The core calls get_proc_address("glClear") and gets back a function
   * table index it can call via indirect call.
   */
  _getProcAddress(symPtr) {
    const mod = this._mod;
    const name = mod.UTF8ToString(symPtr);

    // Check cache
    if (this._procAddressCache.has(name)) {
      return this._procAddressCache.get(name);
    }

    // Look up the function on native-gles
    const fn = gl[name];
    if (!fn) {
      // Not found — some cores probe for extension functions
      this._procAddressCache.set(name, 0);
      return 0;
    }

    // We need to create an Emscripten addFunction wrapper that bridges
    // the WASM call to the native GL call. The challenge is that each
    // GL function has a different signature.
    //
    // For libretro cores compiled with Emscripten, they typically call
    // GL functions directly (linked at compile time) rather than through
    // get_proc_address. get_proc_address is mainly used for extension
    // functions. We return 0 for now if they're probing — the core's
    // Emscripten build should have the GL functions linked directly.
    //
    // If a core truly needs runtime-resolved GL, we'd need a signature
    // table mapping GL function names to their parameter types.

    // For common GL functions, return a stub that indicates "available"
    // The actual calls go through the Emscripten-linked GL functions.
    // Returning non-zero tells the core the function exists.
    // We create a minimal no-op wrapper since the core will call the
    // directly-linked version, not this pointer.
    const stub = mod.addFunction(() => { return 0; }, 'i');
    this._procAddressCache.set(name, stub);
    return stub;
  }

  destroy() {
    if (this.contextDestroyPtr && this._mod) {
      try {
        this._mod.dynCall('v', this.contextDestroyPtr, []);
      } catch { /* ignore */ }
    }
    if (this.active) {
      gl.destroyContext();
      this.active = false;
    }
  }
}
