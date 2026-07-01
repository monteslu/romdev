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

import { CartHost } from "wasmcart";
import { framebufferToScreenshot, framebufferToRgba } from "./framebuffer.js";
import { RETRO_PIXEL_FORMAT_XRGB8888 } from "./retroConstants.js";

// wasmcart framebuffer is uint32 XRGB8888 (0x00RRGGBB) → bytes [B,G,R,X] in LE
// memory, identical to libretro's XRGB8888, so romdev's decoder handles it as-is.
const WASMCART_FB_FORMAT = RETRO_PIXEL_FORMAT_XRGB8888;

// libretro RETRO_DEVICE_ID_JOYPAD bit → wasmcart pad button field. romdev's
// setInput speaks the libretro button vocabulary (b,y,select,start,up,down,left,
// right,a,x,l,r,…); wasmcart pads carry the same conceptual buttons. We translate
// the input bitmask/object into the pad object shape CartHost._writePads expects.
const JOYPAD = {
  b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7,
  a: 8, x: 9, l: 10, r: 11, l2: 12, r2: 13, l3: 14, r3: 15,
};

export class WasmcartHost {
  constructor({ log } = {}) {
    this.kind = "wasmcart";
    this.hwRender = null; // wasmcart GL carts render into their own FB; no libretro HW-render path
    this._log = log || (() => {});
    this.cart = null;
    this.state = { lastFrame: null };
    this._inputPorts = [{}]; // per-port pad objects, applied each stepFrames
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
    };
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
  async loadMedia({ platform, path: mediaPath, bytes, glBackend } = {}) {
    const source = bytes ?? mediaPath;
    if (!source) throw new Error("WasmcartHost.loadMedia: provide `path` or `bytes`.");

    this.cart = new CartHost();
    await this.cart.load(source, glBackend ? { glBackend } : {});
    // Deterministic clock: romdev steps frames, so frame N should be reproducible.
    // Feature-detect — setFixedStep is a newer CartHost addition; older published
    // versions fall back to wall-clock (still works, just non-deterministic timing).
    if (typeof this.cart.setFixedStep === "function") {
      this.cart.setFixedStep(1000 / 60);
      this._deterministicClock = true;
    }

    this.status.loaded = true;
    this.status.platform = platform || "wasmcart";
    this.status.mediaPath = typeof mediaPath === "string" ? mediaPath : null;
    this.status.mediaKind = "cart";
    this.status.frameCount = 0;
    this.status.coreFps = 60;

    // Settle a first frame so width/height and a framebuffer exist (carts often
    // finalize their resolution during the first render).
    this.stepFrames(1);
    this.status.fbWidth = this.state.lastFrame?.width || 0;
    this.status.fbHeight = this.state.lastFrame?.height || 0;
    return this.status;
  }

  /** Translate romdev's setInput vocabulary into a wasmcart pad object. */
  _padFromInput(input) {
    if (!input || typeof input !== "object") return {};
    const pad = { up: 0, down: 0, left: 0, right: 0, a: 0, b: 0, x: 0, y: 0,
                  l: 0, r: 0, start: 0, select: 0 };
    for (const key of Object.keys(pad)) {
      if (input[key]) pad[key] = 1;
    }
    return pad;
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
  }

  /** Advance n frames, driving CartHost.runFrame with the current input. */
  stepFrames(n) {
    if (!this.cart) throw new Error("no cart loaded — loadMedia first");
    let r = null;
    for (let i = 0; i < n; i++) {
      r = this.cart.runFrame(this._inputPorts);
      this.status.frameCount++;
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
    }
    return n;
  }

  /** @returns {{width,height,pixels,pitch,format}} the last rendered frame. */
  getFramebuffer() {
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
    return { width: f.width, height: f.height,
             pixels: framebufferToRgba(f.width, f.height, f.pixels, f.pitch, f.format) };
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
  }
}
