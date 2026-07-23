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

import { CartHost, BUTTON } from "wasmcart";
import { framebufferToRgba } from "romdev-core-host/framebuffer.js";
import { framebufferToScreenshot } from "romdev-core-host/framebuffer-png.js";
import { RETRO_PIXEL_FORMAT_XRGB8888 } from "romdev-core-host/retroConstants.js";

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
  async loadMedia({ platform, path: mediaPath, bytes, glBackend, deterministic } = {}) {
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
    await this.cart.load(source, {
      ...(glBackend ? { glBackend } : {}),
      ...(deterministic ? { deterministic } : {}),
    });
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
  }

  /** Advance n frames, driving CartHost.runFrame with the current input. Each
   *  frame's audio is accumulated into state.audioRing (as Int16) so the shared
   *  audioDebug({op:'record'}) tool can drain it exactly like a libretro core. */
  stepFrames(n) {
    if (!this.cart) throw new Error("no cart loaded — loadMedia first");
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
    }
    return n;
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
  }
}
