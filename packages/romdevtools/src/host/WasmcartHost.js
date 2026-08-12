// WasmcartHost — adapts wasmcart's CartHost to the subset of the LibretroHost
// surface that romdev's shared tools (frame/input/playtest/livestream) drive.
//
// wasmcart carts aren't emulated CPUs — they're native WASM game modules that
// export wc_render() and draw into a framebuffer. So this host implements the
// RUN + SEE + DRIVE surface (loadMedia / stepFrames / getFramebuffer / screenshot
// / setInput / status) but NOT the emulator-only surface (readMemory regions,
// cpuState, watchpoints, disasm, cheats). Those tools consult getCapabilities()
// and refuse with a pointer rather than pretending.
//
// CartHost.runFrame(pads) is a pure step function returning
//   { framebuffer: Uint8Array (XRGB8888), width, height, audio }
// which maps cleanly onto stepFrames + state.lastFrame. We drive its fixed-step
// clock so frame N is reproducible (setFixedStep), matching how romdev steps a core.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { CartHost, BUTTON } from "wasmcart";
import { framebufferToRgba } from "romdev-core-host/framebuffer.js";
import { framebufferToScreenshot } from "romdev-core-host/framebuffer-png.js";
import { RETRO_PIXEL_FORMAT_XRGB8888, ROMDEV_PIXEL_FORMAT_RGBA8888 } from "romdev-core-host/retroConstants.js";

// ── Headless GL for GL carts ─────────────────────────────────────────────────
// wasmcart takes glBackend as a FACTORY invoked only when the cart's wasm
// imports from the "gl" module, so 2D-only sessions never create a context.
// webgl-node + native-gles are REQUIRED dependencies (not optional): GL carts
// must render REAL pixels headless so screenshots and frame hashes mean
// something. wasmcart 0.7.0 makes "GL cart, no context" a load error, and
// romdev satisfies that by always having a context rather than opting out.

// ONE offscreen WebGL2 context per process, reused across loads — webgl-node
// binds a single native EGL context (no destroy API), so per-load creation
// isn't safe. GL state carries across reloads; carts set their own state.
// 720p ceiling: readback clamps to the drawing buffer.
/* MINIMUM offscreen GL size, not a ceiling — _getOffscreenGl() takes the max
 * of this and the cart's own dimensions, so a 1080p cart gets 1080p and a 720p
 * cart is not cropped by a context sized for someone else. */
const OFFSCREEN_GL_W = 1280, OFFSCREEN_GL_H = 720;
let _webglNodeMod; // undefined = untried, null = unavailable
let _offscreenGl = null;
async function _webglNode() {
  if (_webglNodeMod !== undefined) return _webglNodeMod;
  try { _webglNodeMod = await import("webgl-node"); } catch { _webglNodeMod = null; }
  return _webglNodeMod;
}
/**
 * The ONE offscreen GL context, sized to the largest cart seen this process.
 *
 * A single fixed size cannot be right for every cart, and both wrong answers
 * have shipped: at 1280x720 a 1080p cart was cropped to its top-left corner;
 * bumped to 1920x1080, a 720p cart was cropped the same way, because readback
 * takes width*height from a buffer that is now bigger than the cart. Either
 * way the picture is silently wrong rather than scaled.
 *
 * webgl-node binds a single native EGL context with no destroy API, so the
 * context cannot be recreated per load. Instead it is created at the size the
 * FIRST GL cart needs and GROWN if a later cart is bigger -- growing is safe
 * (readback still reads the cart's own width/height from the origin), shrinking
 * is not, and never needed.
 */
let _offscreenGlW = 0, _offscreenGlH = 0;
/* The full createWebGL2Context result, kept for makeCurrent: native-gles is
 * multi-context now (each bezel compositor owns one too), so whoever rendered
 * last owns the current context. A GL cart must claim OURS before its frame
 * or its draws land in someone else's context — which is exactly how one
 * session's game ended up inside another session's window. */
let _offscreenCtx = null;
/* The cart's DECLARED resolution, read straight from its manifest.
 *
 * This is the only size that is knowable before the wasm runs, and the GL
 * context has to be created before the cart can tell us anything. Returns {}
 * for a bytes-only load or anything unreadable; the caller falls back to the
 * info struct, which is no worse than the old behaviour.
 *
 * Handles both shapes romdev loads: a packed .wasc (a zip, manifest.json at
 * the root) and an unpacked directory (manifest.json beside the assets).
 */
function _manifestDims(source) {
  if (typeof source !== "string") return {};
  try {
    const st = fs.statSync(source);
    let json = null;
    if (st.isDirectory()) {
      json = fs.readFileSync(path.join(source, "manifest.json"), "utf8");
    } else {
      // Minimal zip read: find manifest.json in the central directory rather
      // than pulling in a zip dependency for two integers.
      const buf = fs.readFileSync(source);
      const name = Buffer.from("manifest.json");
      // scan local file headers (PK\x03\x04) for the entry
      for (let i = 0; i + 30 < buf.length; i++) {
        if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04) {
          const method = buf.readUInt16LE(i + 8);
          const csize = buf.readUInt32LE(i + 18);
          const nlen = buf.readUInt16LE(i + 26);
          const elen = buf.readUInt16LE(i + 28);
          const nameAt = i + 30;
          if (buf.slice(nameAt, nameAt + nlen).equals(name)) {
            const dataAt = nameAt + nlen + elen;
            const raw = buf.slice(dataAt, dataAt + csize);
            json = method === 0
              ? raw.toString("utf8")
              : zlib.inflateRawSync(raw).toString("utf8");
            break;
          }
          i = nameAt + nlen + elen + csize - 1;
        }
      }
    }
    if (!json) return {};
    const m = JSON.parse(json);
    return { width: m.width | 0, height: m.height | 0 };
  } catch {
    return {};
  }
}

/**
 * A PRIVATE GL context for one host, never the process-wide offscreen one.
 *
 * The shared context cannot be attached to a window: every wasmcart in every
 * session draws through it, so binding it to one window would drag all of them
 * into that window. A host that wants GL-direct present therefore gets its own
 * context, which it exclusively owns and may attach, and destroys on unload.
 *
 * Still floored at OFFSCREEN_GL_*, even though nobody else shares it. The
 * floor is not about sharing: a cart that declares nothing up front (neither a
 * manifest size nor a pre-init info struct) reports 0x0 here and only stamps
 * its real resolution after wc_init runs. Sizing to that literally gives a 1x1
 * context, and since webgl-node cannot resize, the cart is then cropped to one
 * pixel for the rest of the session. The floor is what makes the unknown case
 * land on a sane size instead of a broken one.
 */
async function _createPrivateGl(wantW, wantH) {
  const wn = await _webglNode();
  if (!wn) return null;
  const w = Math.max(OFFSCREEN_GL_W, wantW | 0);
  const h = Math.max(OFFSCREEN_GL_H, wantH | 0);
  try {
    return wn.createWebGL2Context(w, h);
  } catch (e) {
    console.error(`[wasmcart] private GL context (${w}x${h}) failed: ${e.message}`);
    return null;
  }
}

async function _getOffscreenGl(wantW, wantH) {
  const wn = await _webglNode();
  if (!wn) return null;
  const w = Math.max(OFFSCREEN_GL_W, wantW | 0);
  const h = Math.max(OFFSCREEN_GL_H, wantH | 0);
  if (!_offscreenGl) {
    _offscreenCtx = wn.createWebGL2Context(w, h);
    _offscreenGl = _offscreenCtx.gl;
    _offscreenGlW = w; _offscreenGlH = h;
  } else if (w > _offscreenGlW || h > _offscreenGlH) {
    // A bigger cart arrived after the context existed. There is no resize API,
    // so warn rather than render a silently-cropped picture.
    console.error(
      `[wasmcart] this process's GL context is ${_offscreenGlW}x${_offscreenGlH} but this cart wants `
      + `${w}x${h}. webgl-node cannot resize an existing context, so the picture will be cropped. `
      + "Restart the server and load the larger cart first.");
  }
  return _offscreenGl;
}

// wasmcart framebuffer is uint32 XRGB8888 (0x00RRGGBB) → bytes [B,G,R,X] in LE
// memory, identical to libretro's XRGB8888, so romdev's decoder handles it as-is.
const WASMCART_FB_FORMAT = RETRO_PIXEL_FORMAT_XRGB8888;

// libretro RETRO_DEVICE_ID_JOYPAD bit → wasmcart pad button field. romdev's
// setInput speaks the libretro button vocabulary (b,y,select,start,up,down,left,
// right,a,x,l,r,…); wasmcart pads carry the same conceptual buttons. We translate
// the input bitmask/object into the pad object shape CartHost._writePads expects.
const _JOYPAD = {
  b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7,
  a: 8, x: 9, l: 10, r: 11, l2: 12, r2: 13, l3: 14, r3: 15,
};

export class WasmcartHost {
  constructor({ log } = {}) {
    this.kind = "wasmcart";
    this.hwRender = null; // wasmcart GL carts render into their own FB; no libretro HW-render path
    this._log = log || (() => {});
    this.cart = null;
    // state.audioRing mirrors LibretroHost's shape so the SHARED audioDebug
    // ({op:'record'}) tool drains it host-kind-agnostically: an array of
    // interleaved-stereo Int16Array chunks. CartHost.runFrame returns Int16 OR
    // Float32 per frame; we convert Float32→Int16 so the WAV encoder (Int16)
    // gets one shape regardless of what the cart emits.
    this.state = { lastFrame: null, audioRing: [], lastAudio: null };
    // Per-port pad objects, applied each stepFrames. Pad 0 starts connected
    // and idle so carts that check pad.connected see a controller before the
    // first setInput — the same contract as a libretro port.
    this._inputPorts = [this._padFromInput({})];
    this.status = {
      loaded: false,
      platform: null,
      mediaPath: null,
      mediaKind: "cart",
      frameCount: 0,
      fbWidth: 0,
      fbHeight: 0,
      coreFps: 60,
      displayAspect: 0,
      audioSampleRate: 0,
      paused: false,
      gl: null, // "rendered" for GL carts, null for 2D carts
    };
    this._gl = null; // live GL context for readback (offscreen or caller-supplied)
    // GL-direct present state. _glCtx is the webgl-node wrapper (the object
    // carrying attachWindow/swapBuffers) and is non-null ONLY for a private,
    // exclusively-owned context — never for the shared offscreen one.
    this._glCtx = null;
    this._glAttached = false;
    this._glWindowHandle = null;
  }

  /**
   * Capability descriptor. The shared tools branch on this; emulator-only tools
   * see the false flags and refuse with a clear pointer instead of no-oping.
   */
  getCapabilities() {
    return {
      kind: "wasmcart",
      canStepFrames: true,
      canScreenshot: true,
      canSetInput: true,
      hasAudio: true,
      hasSaveData: true,
      // No EMULATED memory regions (there's no CPU/address-space to name), but the
      // cart runs in real V8 — so we DO expose the WASM linear memory + exports for
      // introspection an emulator can't give: peek the actual cart heap, list the
      // module's exported functions/globals. Different axis than emulator regions.
      hasMemoryRegions: false,
      hasWasmIntrospection: true,
      // GL carts render on a real (offscreen) WebGL2 context and screenshots
      // show the actual draws. 2D carts: false (they never request a context).
      hasGlRendering: !!this._gl,
      // Named debug state (opt-in wasmcart debug ABI). True only when the cart
      // opted in AND the wasmcart build exposes the reader — feature-detected.
      hasDebugState: this.debugSupported(),
      // Cart declares FLAG_DETERMINISTIC (honors seeded replay) AND the
      // wasmcart build can deliver a seed — feature-detected like debug.
      hasDeterministic: !!this.cart?.info?.hasDeterministic
        && this.cart?.deterministicSeed !== undefined,
      // Frame-stamped wc_log/wc_debug_mark capture (wasmcart 0.5.0+).
      hasDebugEvents: typeof this.cart?.drainDebugEvents === "function",
      hasCpuState: false,
      hasDisasm: false,
      hasCheats: false,
      hasWatchpoints: false,
    };
  }

  /**
   * Load a .wasc cart (or dev directory). `mediaPath` is a real path; `bytes` is
   * in-memory cart zip. Mirrors LibretroHost.loadMedia's post-conditions:
   * status.loaded + a first framebuffer so screenshot works immediately.
   */
  async loadMedia({ platform, path: mediaPath, bytes, glBackend, deterministic, presentWindow } = {}) {
    const source = bytes ?? mediaPath;
    if (!source) throw new Error("WasmcartHost.loadMedia: provide `path` or `bytes`.");

    this.cart = new CartHost();
    // Deterministic replay (wasmcart 0.5.0+): {seed, stepMs?}. Feature-detect
    // via the constructor field — an older CartHost would silently ignore the
    // option and hand back a non-deterministic run the caller believes is seeded.
    if (deterministic && this.cart.deterministicSeed === undefined) {
      throw new Error(
        "deterministic replay needs wasmcart >= 0.5.0 (this install predates wc_set_seed) — reinstall/repin wasmcart."
      );
    }
    // Headless GL: hand CartHost a lazy offscreen-context factory. It runs
    // ONLY if the cart's wasm imports GL, so 2D-only sessions never create a
    // context. A caller-supplied glBackend always wins.
    this._gl = null;
    this._glCtx = null;
    this._glAttached = false;
    let glFactory = null;
    if (!glBackend) {
      glFactory = async () => {
        // Size the context to THIS cart. Carts declare their own resolution
        // (720p, 1080p, whatever), so a fixed size crops whichever half of the
        // corpus it was not chosen for.
        //
        // getInfo() here reports the cart's COMPILE-TIME default, not its final
        // resolution: this factory runs during cart.load(), and a cart that
        // picks its size at boot (wasmcart-lua reads conf.lua inside wc_init)
        // only stamps the real numbers afterward -- CartHost re-reads the info
        // struct after wc_init for exactly that reason. Sizing from the
        // pre-init value gave a 1080p cart a 1280x720 context, and since
        // webgl-node cannot resize, readback then cropped it to its top-left
        // corner for the rest of the session.
        //
        // The MANIFEST knows the answer before the wasm ever runs, so prefer
        // it and fall back to the pre-init struct.
        const ci = this.cart?.getInfo?.() ?? {};
        const mw = _manifestDims(source);
        const wantW = Math.max(ci.width | 0, mw.width | 0);
        const wantH = Math.max(ci.height | 0, mw.height | 0);
        // presentWindow: this cart is destined for a playtest window and wants
        // to present by GPU swap. That needs a context it exclusively owns
        // (the shared offscreen one is every other session's too), so build a
        // private one. Falls through to the shared context if that fails --
        // a slower present is better than no cart.
        if (presentWindow) {
          const priv = await _createPrivateGl(wantW, wantH);
          if (priv) {
            this._glCtx = priv;
            this._gl = priv.gl;
            priv.makeCurrent?.();
            return priv.gl;
          }
          console.error("[wasmcart] private GL context unavailable — "
            + "falling back to the shared offscreen context (readback present).");
        }
        const gl = await _getOffscreenGl(wantW, wantH);
        if (!gl) {
          // webgl-node/native-gles are REQUIRED dependencies, so reaching here
          // means a broken install rather than an unsupported configuration.
          // Say that plainly: wasmcart's own error ("no glBackend was provided")
          // would point at the caller, which is not where the fault is.
          throw new Error(
            "romdev requires headless GL for wasmcart GL carts, but webgl-node/native-gles " +
            "failed to load. Reinstall romdevtools (native-gles builds or downloads a native " +
            "module at install time; check that step's output).");
        }
        this._gl = gl;
        return gl;
      };
    }
    // No allowMissingGL: a GL cart with no context renders black with no error,
    // which is the failure mode wasmcart 0.7.0 made fatal on purpose. romdev
    // guarantees a context instead of opting out of the check.
    await this.cart.load(source, {
      glBackend: glBackend ?? glFactory,
      ...(deterministic ? { deterministic } : {}),
    });
    if (glBackend && this.cart.usesGL) this._gl = glBackend;
    // Surfaced in status: are this GL cart's draws real pixels or stubs?
    // "stubbed" is no longer reachable: the factory either supplies a context
    // or throws, so a loaded GL cart is always really rendering.
    this.status.gl = this.cart.usesGL ? "rendered" : null;
    // Deterministic clock: romdev steps frames, so frame N should be reproducible.
    // Feature-detect — setFixedStep is a newer CartHost addition; older published
    // versions fall back to wall-clock (still works, just non-deterministic timing).
    // A deterministic load already engaged its own step (possibly custom) — don't clobber it.
    if (typeof this.cart.setFixedStep === "function" && !deterministic) {
      this.cart.setFixedStep(1000 / 60);
    }
    this._deterministicClock = typeof this.cart.setFixedStep === "function";

    // Full deterministic replay (seeded RNG, wasmcart 0.5.0+): surfaced in
    // status so regression goldens can stamp + verify the seed they ran under.
    this.status.deterministicSeed = deterministic ? this.cart.deterministicSeed : null;

    this.status.loaded = true;
    this.status.platform = platform || "wasmcart";
    this.status.mediaPath = typeof mediaPath === "string" ? mediaPath : null;
    this.status.mediaKind = "cart";
    this.status.frameCount = 0;
    this.status.coreFps = 60;
    // Audio sample rate the cart declared (WCInfo.audioSampleRate) so the WAV
    // record op tags the file correctly. 0 (no audio) falls back to 48000 in the tool.
    try { this.status.audioSampleRate = this.cart.getInfo()?.audioSampleRate || 0; }
    catch { this.status.audioSampleRate = 0; }

    // Settle a first frame so width/height and a framebuffer exist (carts often
    // finalize their resolution during the first render).
    this.stepFrames(1);
    this.status.fbWidth = this.state.lastFrame?.width || 0;
    this.status.fbHeight = this.state.lastFrame?.height || 0;
    // A cart's display IS its framebuffer (square pixels, no CRT stretch) —
    // report the real ratio; a 0 here zero-sizes the playtest window.
    this.status.displayAspect = this.status.fbHeight > 0
      ? this.status.fbWidth / this.status.fbHeight : 0;
    return this.status;
  }

  /** Translate romdev's setInput vocabulary into the pad object
   *  CartHost._writePads expects: {connected, buttons: <BUTTON bitmask>,
   *  leftX..rightTrigger}. A pad without `connected` is ZEROED by CartHost,
   *  so every translated pad is connected — like a libretro port. */
  _padFromInput(input) {
    const src = input && typeof input === "object" ? input : {};
    let buttons = 0;
    for (const [name, bit] of Object.entries(BUTTON)) {
      if (src[name.toLowerCase()]) buttons |= bit;
    }
    return {
      connected: true,
      buttons,
      leftX: src.leftX | 0, leftY: src.leftY | 0,
      rightX: src.rightX | 0, rightY: src.rightY | 0,
      leftTrigger: src.leftTrigger | 0, rightTrigger: src.rightTrigger | 0,
    };
  }

  /**
   * Store input to apply on subsequent stepFrames. Accepts romdev's setInput shapes:
   * a flat button object ({a:true,right:true}) OR the multi-port form
   * ({ports:[{...p0}, {...p1}]}). wasmcart pads are per-controller, so we keep all
   * ports and hand them to CartHost.runFrame.
   */
  setInput(input) {
    if (input && Array.isArray(input.ports)) {
      this._inputPorts = input.ports.map((p) => this._padFromInput(p));
    } else {
      this._inputPorts = [this._padFromInput(input)];
    }
    // Absolute pointer (mouse/touch): {pointer:{x,y,left,right,active}}. Carts
    // that declare FLAG_POINTER read this; harnesses can click at exact coords.
    if (input && input.pointer && typeof this.cart?.setPointer === "function") {
      const p = input.pointer;
      const buttons = (p.left ? 1 : 0) | (p.right ? 2 : 0) | (p.middle ? 4 : 0);
      const active = p.active === false ? false : true;
      /* Slot id, not hardcoded 0.
       *
       * The wasmcart v3 pointer ABI is a wc_pointer_t[10] array: mouse is slot
       * 0, touch fingers land in slots 1+. This hardcoded a 0, so romdev could
       * only ever simulate a mouse -- which makes the #1 cart-side portability
       * trap untestable. A cart that polls only pointer[0] works perfectly with
       * a desktop mouse and silently ignores every touch on Android, and no
       * regression test could catch it because the tool could not place a
       * finger in slot 1. CartHost.setPointer already takes any id 0..9. */
      this.cart.setPointer(p.id | 0, p.x | 0, p.y | 0, buttons, active);
    }
  }

  /** Advance n frames, driving CartHost.runFrame with the current input. Each
   *  frame's audio is accumulated into state.audioRing (as Int16) so the shared
   *  audioDebug({op:'record'}) tool can drain it exactly like a libretro core. */
  /**
   * Pause/resume, same contract as LibretroHost: `status.paused` is the ONE
   * flag the playtest loop and stepFrames both read, so a paused cart is
   * frozen no matter who asks it to run.
   */
  pause() {
    this.status.paused = true;
  }

  resume() {
    this.status.paused = false;
  }

  stepFrames(n) {
    if (!this.cart) throw new Error("no cart loaded — loadMedia first");
    if (this.status.paused) return 0;
    // Claim OUR context for this burst. native-gles is multi-context (another
    // cart, a bezel compositor, another session), so whoever rendered last
    // owns currency -- draws land in someone else's context otherwise.
    // A PRIVATE context (presentWindow) needs this every bit as much as the
    // shared one: without it the cart rendered into whatever context happened
    // to be current, and a screenshot read our (empty) buffer while the WINDOW
    // showed the game correctly -- a black capture of a visibly-working window.
    // (Caller-supplied glBackends manage their own currency.)
    if (this._glCtx) this._glCtx.makeCurrent?.();
    else if (this._gl && this._gl === _offscreenGl) _offscreenCtx?.makeCurrent?.();
    let r = null;
    for (let i = 0; i < n; i++) {
      r = this.cart.runFrame(this._inputPorts);
      this.status.frameCount++;
      if (r?.audio && r.audio.length) {
        // Copy out (the buffer is a subarray into WASM memory that moves next
        // frame) and normalize Float32 [-1,1] → Int16 so the ring is uniform.
        const a = r.audio;
        if (a instanceof Float32Array) {
          const i16 = new Int16Array(a.length);
          for (let k = 0; k < a.length; k++) {
            const s = a[k] < -1 ? -1 : a[k] > 1 ? 1 : a[k];
            i16[k] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          this.state.audioRing.push(i16);
        } else {
          this.state.audioRing.push(new Int16Array(a)); // Int16 copy
        }
      }
    }
    if (r) {
      // Copy the framebuffer view out (CartHost returns a subarray into WASM memory,
      // which can move on the next frame). pitch = width*4 (no row padding).
      this.state.lastFrame = {
        width: r.width,
        height: r.height,
        pixels: new Uint8Array(r.framebuffer), // copy
        pitch: r.width * 4,
        format: WASMCART_FB_FORMAT,
      };
      this.state.lastAudio = r.audio || null;
      this.status.fbWidth = r.width;
      this.status.fbHeight = r.height;
      this.status.displayAspect = r.height > 0 ? r.width / r.height : 0;
    }
    // GL carts draw into the GL context, not the 2D framebuffer. The pixels
    // are read back LAZILY: glReadPixels is a full pipeline stall plus two
    // 8 MB allocations plus a row-flip and an alpha pass in JS, which on a
    // 1080p cart measured 4.2 ms EVERY FRAME -- about 2/3 of the whole frame
    // budget -- spent producing an image that a human playtest never looks
    // at. Mark it dirty here; whoever actually wants pixels pays for them.
    if (this._gl && this.cart.usesGL) {
      this._glDirty = true;
      // Keep the declared size current even without a readback, since
      // getStatus()/aspect consumers read it every tick.
      //
      // Take it from the cart's REDIRECT FBO, never from
      // gl.drawingBufferWidth/Height. Those follow the WINDOW once the
      // context is attached and resizeGlSurface updates them, and the old
      // `Math.min(status, drawingBuffer)` clamp then rewrote the cart's
      // declared size to the window's -- permanently, since min() only ever
      // shrinks. Dragging a 1920x1080 cart into a 492-wide window made
      // status.fbWidth 492 and displayAspect 0.455, so the letterbox target
      // itself became portrait and the game rendered STRETCHED rather than
      // fitted. The cart's frame size is a property of the cart; a human
      // resizing a window must never change it.
      const gl = this._gl;
      let w = 0, h = 0;
      const fromFbo = this.cart?.withRenderedFrame?.((fw, fh) => { w = fw; h = fh; });
      if (!fromFbo || !(w > 0 && h > 0)) {
        // No redirect FBO: the cart really does draw into the default
        // framebuffer, so the context size is the honest answer there.
        w = Math.min(this.status.fbWidth || gl.drawingBufferWidth, gl.drawingBufferWidth);
        h = Math.min(this.status.fbHeight || gl.drawingBufferHeight, gl.drawingBufferHeight);
      }
      if (w > 0 && h > 0) {
        this.status.fbWidth = w;
        this.status.fbHeight = h;
        this.status.displayAspect = h > 0 ? w / h : 0;
      }
    }
    return n;
  }

  /** Bring state.lastFrame up to date if a GL cart has stepped since the last
   *  readback. Called by every consumer of the pixels, so the cost is paid
   *  once per REQUEST rather than once per frame. */
  _syncGl() {
    if (!(this._glDirty && this._gl && this.cart?.usesGL)) return;
    // Safe at any point in the frame, including after a present: the cart
    // renders into wasmcart's redirect FBO, which a buffer swap does not
    // touch, and _readbackGl reads THAT rather than the default framebuffer.
    // (The window surface really is undefined post-swap -- reading it is what
    // produced black screenshots of a visibly-working window.)
    this._readbackGl();
  }

  /** Replace state.lastFrame with the GL context's pixels. GL's origin is
   *  bottom-left → rows are flipped; GL targets often leave alpha 0 → forced
   *  opaque (alpha 0 composites to a black screenshot — the hwRender lesson).
   *  Readback region = the cart's declared resolution clamped to the context
   *  (viewport and readPixels share the bottom-left origin, so a cart that
   *  viewports at 0,0 — the norm — is read exactly). */
  _readbackGl() {
    const gl = this._gl;
    // Claim our context before reading: this runs on demand (a screenshot, a
    // frame hash), which can be long after the last frame, by which time
    // another cart or a bezel compositor may own currency. Reading without it
    // returns THEIR buffer -- or an empty one.
    if (this._glCtx) this._glCtx.makeCurrent?.();
    else if (gl === _offscreenGl) _offscreenCtx?.makeCurrent?.();
    // Read the CART's frame size, and take it from the redirect FBO when there
    // is one. The old code clamped to gl.drawingBufferWidth/Height, which is
    // the CONTEXT's (i.e. the window's) size -- fine when the cart drew into
    // the default framebuffer, but the cart now renders into a cart-sized
    // redirect FBO. Clamping that to a smaller window read a window-sized
    // sub-rect: captures came back cropped on the left and scaled up, and the
    // crop MOVED when the window resized. The FBO is authoritative about its
    // own size, so ask it.
    let w = 0, h = 0;
    const gotFboSize = this.cart?.withRenderedFrame?.((fw, fh) => { w = fw; h = fh; });
    if (!gotFboSize || !(w > 0 && h > 0)) {
      // No redirect FBO (older cart, 2D): the cart really did draw into the
      // default framebuffer, so the context size is the right clamp.
      w = Math.min(this.status.fbWidth || gl.drawingBufferWidth, gl.drawingBufferWidth);
      h = Math.min(this.status.fbHeight || gl.drawingBufferHeight, gl.drawingBufferHeight);
    }
    if (!(w > 0 && h > 0)) return;
    const row = w * 4;
    const bytes = w * h * 4;

    // Buffers are RETAINED across frames. At 1080p each of these is 8 MB, so
    // allocating a fresh pair every frame handed the GC 16 MB per frame to
    // collect — on a 60fps cart that is ~1 GB/s of churn for two buffers
    // whose size only changes when the resolution does.
    if (!this._rbRaw || this._rbRaw.length !== bytes) {
      this._rbRaw = new Uint8Array(bytes);
      this._rbFlipped = new Uint8Array(bytes);
      this._rbRawW = new Uint32Array(this._rbRaw.buffer);
      this._rbFlippedW = new Uint32Array(this._rbFlipped.buffer);
    }
    const raw = this._rbRaw;
    const flipped = this._rbFlipped;

    // Read the cart's REDIRECT FBO, not the default framebuffer. With the
    // context attached to a window the default framebuffer IS the window
    // surface, whose contents are undefined after a swap — reading it gave a
    // pure black screenshot from a window that was visibly showing the game.
    // The redirect FBO always holds the frame the cart drew, so this is
    // correct on both paths (attached and offscreen) rather than a special
    // case. Costs one extra bind, and only on the paths that ask for pixels.
    const readViaFbo = this.cart?.withRenderedFrame?.(() => {
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    });
    // Older carts (or a 2D cart) have no redirect FBO: read as before.
    if (!readViaFbo) gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);

    // Row flip via TypedArray.set — that is a native memcpy per row, and a
    // hand-written per-word JS loop that fuses the alpha fixup into the same
    // pass measured SLOWER despite touching memory once instead of twice.
    // (Tried it; ~0.4 ms worse at 1080p. Native copy beats saved traffic.)
    for (let y = 0; y < h; y++) {
      flipped.set(raw.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    }
    // Force opaque: a GL target commonly leaves alpha at 0, which composites
    // to a black or transparent window, and this buffer now goes STRAIGHT to
    // the presenter with no converter pass behind it to fix that up. 32-bit
    // OR so this is ~500K operations rather than 2M byte writes.
    const dstW = this._rbFlippedW;
    for (let i = 0; i < dstW.length; i++) dstW[i] |= 0xff000000;

    this.state.lastFrame = {
      width: w, height: h, pixels: flipped, pitch: row,
      format: ROMDEV_PIXEL_FORMAT_RGBA8888,
    };
    this.status.fbWidth = w;
    this.status.fbHeight = h;
    this.status.displayAspect = h > 0 ? w / h : 0;
    this._glDirty = false;
  }

  /* ── GL-DIRECT PRESENT ───────────────────────────────────────────────────
   *
   * A GL cart renders on the GPU and then, by default, has its frame dragged
   * back to the CPU (`_readbackGl`: a pipeline stall, a row flip, an alpha
   * pass) purely so SDL can blit it in software. At 1080p that round trip is
   * ~5.4 ms of a 16.7 ms budget, moving pixels the GPU already had.
   *
   * `attachWindow` binds this cart's GL context straight to a window surface,
   * so `presentGl()` is a swap and the readback never happens.
   *
   * THE HAZARD, and why this is opt-in per host rather than automatic: the
   * offscreen context is ONE process-wide object shared by every wasmcart in
   * every session (see _getOffscreenGl). Attaching it to a window would
   * redirect every other session's cart into that window too -- the same
   * class of bug as "one session's game ended up inside another session's
   * window", which is what makeCurrent exists to prevent. So a host only
   * attaches a context it does NOT share: a caller-supplied glBackend. A cart
   * on the shared offscreen context refuses and keeps the readback path.
   */

  /** True if this host's GL context can be bound to a window surface. False
   *  on the shared offscreen context, which must never be attached. */
  canAttachWindow() {
    return !!(this._glCtx && typeof this._glCtx.attachWindow === "function"
      && this._gl && this._gl !== _offscreenGl && this.cart?.usesGL);
  }

  /**
   * Bind this cart's GL context to a native window handle. After a successful
   * attach the cart renders straight to the window and `presentGl()` swaps.
   * @param {Buffer} handle SDL's native window handle
   * @returns {boolean} false if this host cannot attach (shared context, no
   *   GL cart, or the bind was refused) — the caller keeps its old path.
   */
  attachWindow(handle) {
    if (!this.canAttachWindow() || !handle) return false;
    const ok = !!this._glCtx.attachWindow(handle);
    if (ok) {
      this._glAttached = true;
      this._glWindowHandle = handle;
      /* Interval 0, NOT the driver default of 1. A vsync-BLOCKING swap parks
       * the whole Node event loop inside presentGl for most of a frame (33 ms
       * measured here, i.e. slower than the readback path this replaces) and
       * fights the playtest loop's audio-clock regulator: the block shifts
       * tick timing, the queue over/under-drains, and the regulator answers
       * with burst or skipped steps -- even presents, uneven GAME TIME. Same
       * call and same reason as the bezel compositor's window attach. */
      this._glCtx.setSwapInterval?.(0);
    }
    return ok;
  }

  /** Release the window surface, returning the context to offscreen rendering
   *  (and the host to the readback path). Safe to call when not attached. */
  /**
   * Tell this host's GL context that its window surface changed size.
   *
   * `drawingBufferWidth`/`Height` are cached at context creation, so after a
   * resize (or F11 fullscreen) they still report the ORIGINAL size. The
   * present blit sizes its viewport from the caller's rect, but the SURFACE
   * behind it is still the old one — which is how a resized or fullscreened
   * window went back to showing a corner of the game.
   *
   * Safe to call on any host (2D cart, no window attached, older webgl-node):
   * the playtest loop calls it from an SDL resize handler, where a throw
   * escapes the tool-call error path entirely and kills the process.
   *
   * @returns {boolean} true if a context was actually told.
   */
  resizeGlSurface(width, height) {
    if (!this._glCtx || typeof this._glCtx.resize !== "function") return false;
    if (!(width > 0 && height > 0)) return false;
    try {
      this._glCtx.makeCurrent?.();
      return !!this._glCtx.resize(width, height);
    } catch (e) {
      console.error(`[wasmcart] GL surface resize failed: ${e.message}`);
      return false;
    }
  }

  detachWindow() {
    if (!this._glAttached) return false;
    const ok = !!this._glCtx?.detachWindow?.();
    if (ok) {
      this._glAttached = false;
      this._glWindowHandle = null;
      // The next consumer of pixels must pay for a real readback again.
      this._glDirty = true;
    }
    return ok;
  }

  /** Swap the attached window surface. Returns false if not attached, so a
   *  caller can tell "presented" from "nothing happened". */
  presentGl(dst) {
    if (!this._glAttached || typeof this._glCtx?.swapBuffers !== "function") return false;
    this._glCtx.makeCurrent?.();
    // The cart renders into wasmcart's redirect FBO, NOT the window surface,
    // so presenting means blitting that FBO out. Without this the swap shows
    // whatever is in the default framebuffer -- and before the redirect
    // existed, a cart drawing 1:1 from the surface origin put a 1080p picture
    // in the bottom-left CORNER of any smaller window. `dst` is the letterbox
    // rect the caller computed, so the aspect ratio survives a resize.
    this.cart?.presentToSurface?.(dst);
    this._glCtx.swapBuffers();
    // Deliberately do NOT clear _glDirty here. An earlier version did, on the
    // reasoning that the back buffer is undefined after a swap and so must not
    // be read -- true of the DEFAULT framebuffer, but the cart renders into
    // the redirect FBO, which the swap does not touch. Clearing it made
    // _syncGl skip the readback, so every screenshot of an open GL-direct
    // window came back BLACK while the window itself showed the game. The
    // frame stays readable; the readback stays lazy (only a consumer asking
    // for pixels pays for it).
    return true;
  }

  /** Snapshot of the host status (mirrors LibretroHost.getStatus — used by
   *  catalog({op:'status'}), which is host-kind-agnostic). */
  getStatus() {
    return { ...this.status };
  }

  /** FNV-1a hash of the last framebuffer — a cheap "did the frame change"
   *  fingerprint for the regression harness. Strided on large buffers (GL carts
   *  can be 1080p+, ~8 MB) so a checkpoint hash stays fast; the stride is
   *  deterministic so the same frame always hashes the same. Matches
   *  LibretroHost.framebufferHash's contract (0 = no frame yet). */
  framebufferHash() {
    this._syncGl();
    const f = this.state.lastFrame;
    if (!f) return 0;
    const px = f.pixels;
    // Aim for ~64K sampled bytes: stride so a small frame hashes every byte and
    // a big one is sampled. Deterministic (depends only on length), so a golden
    // captured here re-hashes identically on replay.
    const stride = Math.max(1, Math.floor(px.length / 65536));
    let h = 0x811c9dc5;
    for (let i = 0; i < px.length; i += stride) {
      h ^= px[i];
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    // Fold in width/height so a resolution change never collides.
    h = (h ^ (f.width * 73856093) ^ (f.height * 19349663)) >>> 0;
    return h >>> 0;
  }

  /** @returns {{width,height,pixels,pitch,format}} the last rendered frame. */
  getFramebuffer() {
    this._syncGl();
    if (!this.state.lastFrame) throw new Error("no frame produced yet — step frames first");
    return this.state.lastFrame;
  }

  /** PNG (base64) of the current frame — same output as LibretroHost.screenshot(). */
  screenshot() {
    const f = this.getFramebuffer();
    return framebufferToScreenshot(f.width, f.height, f.pixels, f.pitch, f.format);
  }

  /** Flat RGBA Uint8Array of the current frame (for the livestream/side-by-side). */
  screenshotRgba() {
    const f = this.getFramebuffer();
    // Key is `rgba` — the LibretroHost contract. It was `pixels` until
    // 0.106.0, which made frame({op:'verify'}) throw a raw TypeError on
    // every wasmcart cart (first exercised by the openarena GL smoke).
    return { width: f.width, height: f.height,
             rgba: framebufferToRgba(f.width, f.height, f.pixels, f.pitch, f.format) };
  }

  /** Save data (SRAM equivalent) if the cart declares any. */
  getSaveData() {
    return this.cart ? this.cart.getSaveData() : null;
  }

  // ── WASM introspection (the V8-runtime bonus an emulator can't offer) ─────────
  //
  // A wasmcart runs as a real WebAssembly instance in V8, so we can read its actual
  // linear memory and enumerate its exports. This is NOT an emulated address space
  // with named regions — it's the cart's own heap. `readMemory` therefore takes a
  // raw byte offset into that heap (no region arg), and `wasmExports` lists what the
  // module exposes.

  /** Total size (bytes) of the cart's WASM linear memory. */
  wasmMemorySize() {
    if (!this.cart?.memory) return 0;
    return this.cart.memory.buffer.byteLength;
  }

  /**
   * Read `length` bytes from the cart's WASM linear memory at byte `offset`.
   * @returns {Uint8Array} a copy (the heap can move on the next frame).
   */
  readMemory(offset, length) {
    if (!this.cart?.memory) throw new Error("no cart loaded — loadMedia first");
    const heap = new Uint8Array(this.cart.memory.buffer);
    const off = offset >>> 0;
    const end = Math.min(heap.length, off + (length >>> 0));
    if (off >= heap.length) {
      throw new Error(`offset ${off} is past the ${heap.length}-byte WASM heap`);
    }
    return heap.slice(off, end);
  }

  /**
   * Write bytes into the cart's WASM linear memory at byte `offset`. Useful for
   * poking cart state during debugging (there are no cheats/watchpoints, but the
   * heap is real and writable).
   */
  writeMemory(offset, bytes) {
    if (!this.cart?.memory) throw new Error("no cart loaded — loadMedia first");
    const heap = new Uint8Array(this.cart.memory.buffer);
    heap.set(bytes, offset >>> 0);
    return bytes.length;
  }

  // ── Debug ABI passthrough (opt-in named state) ───────────────────────────
  // Feature-detected, like setFixedStep: the CartHost debug methods exist only
  // in wasmcart with the debug ABI. Absent (older published wasmcart) → these
  // report "unsupported" and the wasm tool says so, rather than crashing.

  /** True when the loaded cart opts into the debug ABI AND this CartHost build
   *  exposes the debug reader. */
  debugSupported() {
    return typeof this.cart?.readDebugState === "function"
      && !!this.cart?.readDebugState?.();
  }

  /** The cart's named debug-state descriptor table, or null. */
  readDebugState() {
    if (typeof this.cart?.readDebugState !== "function") return null;
    return this.cart.readDebugState();
  }

  /** Read a named debug value (decoded per its declared type). */
  readDebugValue(name) {
    if (typeof this.cart?.readDebugValue !== "function") {
      throw new Error("this wasmcart build has no debug ABI (update the wasmcart package). Use wasm({op:'read', offset}) for a raw heap read.");
    }
    return this.cart.readDebugValue(name);
  }

  /** Write a named scalar debug value. */
  writeDebugValue(name, value) {
    if (typeof this.cart?.writeDebugValue !== "function") {
      throw new Error("this wasmcart build has no debug ABI. Use wasm({op:'write', offset}) for a raw heap write.");
    }
    return this.cart.writeDebugValue(name, value);
  }

  /** Drain the frame-stamped debug event trace (wc_log lines + wc_debug_mark
   *  annotations). Pull-model; clears the rings. wasmcart 0.5.0+. */
  drainDebugEvents() {
    if (typeof this.cart?.drainDebugEvents !== "function") {
      throw new Error("this wasmcart build has no debug event capture (needs wasmcart >= 0.5.0).");
    }
    return this.cart.drainDebugEvents();
  }

  /** Enumerate the cart module's WASM exports (function/memory/global/table names + kinds). */
  wasmExports() {
    if (!this.cart?.instance) return [];
    const ex = this.cart.instance.exports;
    return Object.keys(ex).map((name) => ({
      name,
      kind:
        typeof ex[name] === "function" ? "function"
        : ex[name] instanceof WebAssembly.Memory ? "memory"
        : ex[name] instanceof WebAssembly.Global ? "global"
        : ex[name] instanceof WebAssembly.Table ? "table"
        : typeof ex[name],
      ...(ex[name] instanceof WebAssembly.Global ? { value: ex[name].value } : {}),
    }));
  }

  /** The cart's parsed WCInfo (fbPtr, savePtr/saveSize, width/height, abi). */
  getInfo() {
    return this.cart ? this.cart.getInfo() : null;
  }

  /** The cart's parsed manifest.json (name, abi, players, pointer, keyboard, net). */
  getManifest() {
    return this.cart ? this.cart.getManifest() : null;
  }

  /**
   * ABI/manifest conformance check — the "won't load / loaded but wrong, why?"
   * verdict an agent can't get from its own source. Format validation against
   * the wasmcart spec, language-agnostic. Returns { conforms, issues[] }, each
   * issue { severity:'error'|'warn', code, message } naming the fix.
   *
   * NOTE: the cart is already LOADED here (CartHost.load ran + validated the ABI
   * version and the required exports enough to init), so this reports the
   * matches/mismatches a *loaded* cart can still have — a manifest that lies
   * about its resolution, a declared capability with no matching import, an ABI
   * the host tolerated but the manifest misdeclares. A cart that fails to load
   * at all surfaces its error through loadMedia; this is the next layer.
   */
  checkConformance() {
    if (!this.cart) throw new Error("no cart loaded — loadMedia first");
    const issues = [];
    const info = this.cart.getInfo() || {};
    const manifest = this.cart.getManifest() || {};
    const exportNames = new Set(Object.keys(this.cart.instance?.exports || {}));

    // 1. Required ABI exports (the top broken-cart cause). CartHost.load would
    //    have thrown before here if wc_get_info were missing, but wc_init /
    //    wc_render can be absent on a partially-built cart that still parsed.
    for (const req of ["wc_get_info", "wc_init", "wc_render"]) {
      if (!exportNames.has(req)) {
        issues.push({ severity: "error", code: "missing-export",
          message: `required export '${req}' is not present — the cart won't run. Export it from your entry translation unit (see include/wc_cart.h).` });
      }
    }

    // 2. Manifest ABI vs the running instance's WCInfo version.
    if (manifest.abi != null && info.version != null && manifest.abi !== info.version) {
      issues.push({ severity: "error", code: "abi-mismatch",
        message: `manifest declares abi:${manifest.abi} but wc_get_info reports version ${info.version} — align the manifest's abi with WC_ABI_VERSION the cart was built against.` });
    }

    // 3. Declared resolution vs. what the instance reports (a manifest that lies
    //    about width/height mis-sizes the host's framebuffer expectations).
    for (const [mk, ik] of [["width", "width"], ["height", "height"]]) {
      if (manifest[mk] != null && info[ik] != null && manifest[mk] !== info[ik]) {
        issues.push({ severity: "warn", code: "resolution-mismatch",
          message: `manifest ${mk}:${manifest[mk]} differs from the running ${ik} ${info[ik]} — the instance's value wins; fix the manifest to match.` });
      }
    }

    // 4. Manifest sanity — declared opt-in capabilities that are malformed.
    //    (Import-vs-declaration cross-checking needs the WASM Module's import
    //    list, which CartHost doesn't retain post-instantiation; deferred to a
    //    WS3 debug-ABI increment rather than guessed here.)
    if (manifest.net?.websocket != null && !Array.isArray(manifest.net.websocket)) {
      issues.push({ severity: "error", code: "manifest-shape",
        message: "manifest net.websocket must be an array of allowed domains (e.g. [\"api.example.com\"])." });
    }
    if (manifest.players != null && (!Number.isInteger(manifest.players) || manifest.players < 1 || manifest.players > 4)) {
      issues.push({ severity: "warn", code: "manifest-shape",
        message: `manifest players:${manifest.players} is out of range — wasmcart supports 1-4 players.` });
    }

    // 5. Debug ABI consistency (opt-in). FLAG_DEBUG (1<<5) set but no
    //    wc_debug_state export = a broken debug cart; declaring debug scaffolding
    //    without opting in via the flag is a self-policing warn.
    const FLAG_DEBUG = 1 << 5;
    const flagDebug = !!((info.flags ?? 0) & FLAG_DEBUG);
    const hasDebugExport = exportNames.has("wc_debug_state");
    if (flagDebug && !hasDebugExport) {
      issues.push({ severity: "error", code: "debug-missing-export",
        message: "WC_FLAG_DEBUG is set but the cart doesn't export wc_debug_state() — add the export (WC_DEBUG_FIELDS) or clear the flag." });
    }
    if (!flagDebug && hasDebugExport) {
      issues.push({ severity: "warn", code: "debug-unflagged",
        message: "cart exports wc_debug_state() but WC_FLAG_DEBUG isn't set — the host won't read it (default is no debugging). Set the flag or drop the export." });
    }

    // 6. Deterministic-replay consistency (opt-in). FLAG_DETERMINISTIC (1<<6)
    //    declares the cart honors seeded replay — meaningless without the
    //    wc_set_seed export the host delivers the seed through.
    const FLAG_DETERMINISTIC = 1 << 6;
    const flagDet = !!((info.flags ?? 0) & FLAG_DETERMINISTIC);
    const hasSeedExport = exportNames.has("wc_set_seed");
    if (flagDet && !hasSeedExport) {
      issues.push({ severity: "error", code: "deterministic-missing-export",
        message: "WC_FLAG_DETERMINISTIC is set but the cart doesn't export wc_set_seed() — the host can't seed it, so replay isn't reproducible. Add WC_DETERMINISTIC_RNG (or your own wc_set_seed) or clear the flag." });
    }
    if (!flagDet && hasSeedExport) {
      issues.push({ severity: "warn", code: "deterministic-unflagged",
        message: "cart exports wc_set_seed() but WC_FLAG_DETERMINISTIC isn't set — hosts won't seed it (default is a normal run). Set the flag if the cart truly honors seeded replay." });
    }

    return {
      conforms: issues.every((i) => i.severity !== "error"),
      abi: info.version ?? null,
      manifestAbi: manifest.abi ?? null,
      width: info.width ?? null,
      height: info.height ?? null,
      requiredExportsPresent: ["wc_get_info", "wc_init", "wc_render"].every((e) => exportNames.has(e)),
      issues,
    };
  }

  cheatsSupported() { return false; }

  reset() {
    // Re-load would be needed for a true reset; expose frameCount reset as a soft reset hook.
    this.status.frameCount = 0;
  }

  destroy() {
    if (this.cart) { try { this.cart.destroy(); } catch { /* ignore */ } }
    this.cart = null;
    this.state.lastFrame = null;
    this.status.loaded = false;
    // A PRIVATE context (presentWindow) is owned solely by this host, so it
    // must be released here or every load leaks a GPU context. Detach first:
    // destroying a context still bound to a window surface leaves the window
    // pointing at freed GL state. The SHARED offscreen context is a
    // process-lifetime singleton and is only ever dropped by reference.
    if (this._glCtx) {
      try { if (this._glAttached) this._glCtx.detachWindow?.(); } catch { /* ignore */ }
      try { this._glCtx.destroy?.(); } catch { /* ignore */ }
      this._glCtx = null;
    }
    this._glAttached = false;
    this._gl = null;
  }
}
