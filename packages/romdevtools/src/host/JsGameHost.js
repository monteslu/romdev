// JsGameHost — adapts jsgamelauncher's (rungame) headless host session to the subset
// of the LibretroHost surface romdev's shared tools drive.
//
// A jsgame is a JS web game run in a sandboxed V8 realm (no emulation). rungame's
// createHostSession() gives us a window-less, host-stepped session: we pump the game's
// requestAnimationFrame one frame at a time and read the offscreen canvas back as RGBA.
// So this host implements RUN + SEE + DRIVE (loadMedia / stepFrames / getFramebuffer /
// screenshot / setInput / status) but NOT the emulator-only surface (memory regions,
// cpuState, disasm, cheats). The V8 bonus here is JS-heap/globals introspection.
//
// REQUIRES the process to run with --experimental-vm-modules (rungame's realm uses
// vm.SourceTextModule). loadMedia throws a clear message if it's missing.

import { createHostSession } from "rungame";
import { framebufferToRgba } from "romdev-core-host/framebuffer.js";
import { framebufferToScreenshot } from "romdev-core-host/framebuffer-png.js";
import { ROMDEV_PIXEL_FORMAT_RGBA8888 } from "romdev-core-host/retroConstants.js";

// canvas.data() is RGBA already — reuse romdev's RGBA framebuffer format (no decode).
const JSGAME_FB_FORMAT = ROMDEV_PIXEL_FORMAT_RGBA8888;

const DEFAULT_W = 640;
const DEFAULT_H = 480;

export class JsGameHost {
  constructor({ log } = {}) {
    this.kind = "jsgame";
    this.hwRender = null;
    this._log = log || (() => {});
    this.session = null;
    this.state = { lastFrame: null };
    this._inputPorts = [{}];
    this.status = {
      loaded: false,
      platform: null,
      mediaPath: null,
      mediaKind: "jsgame",
      frameCount: 0,
      fbWidth: 0,
      fbHeight: 0,
      coreFps: 60,
      displayAspect: 0,
      audioSampleRate: 0,
    };
  }

  getCapabilities() {
    return {
      kind: "jsgame",
      canStepFrames: true,
      canScreenshot: true,
      canSetInput: true,
      hasAudio: false, // audio plays through the game's own WebAudio graph; not captured here yet
      hasSaveData: false,
      hasMemoryRegions: false,
      // Runs in real V8 — JS heap/globals introspection (globalThis._jsg, the realm)
      // is the bonus axis an emulator can't offer. Exposed via jsGlobals()/jsEval hooks.
      hasJsIntrospection: true,
      hasCpuState: false,
      hasDisasm: false,
      hasCheats: false,
      hasWatchpoints: false,
    };
  }

  /**
   * Load a jsgame (dir / .jsg / .jsgame). `mediaPath` only — a jsgame is a directory
   * tree / archive on disk, not in-memory bytes. Async: settles initial asset loads +
   * renders a first frame so screenshot works immediately.
   */
  async loadMedia({ platform, path: mediaPath, width, height } = {}) {
    if (!mediaPath) throw new Error("JsGameHost.loadMedia: provide `path` (a jsgame dir/.jsgame). In-memory bytes aren't supported for jsgame.");
    if (typeof globalThis.vm?.SourceTextModule === "undefined") {
      // createHostSession will throw its own clear message if the flag is missing;
      // surface it early with the fix.
    }
    try {
      this.session = await createHostSession(mediaPath, {
        width: width || DEFAULT_W,
        height: height || DEFAULT_H,
      });
    } catch (e) {
      if (String(e.message).includes("SourceTextModule")) {
        throw new Error(
          "jsgame requires the romdev server to run with node --experimental-vm-modules " +
          "(rungame sandboxes games in a vm realm). Restart the server with that flag. " +
          "Original: " + e.message,
        );
      }
      throw e;
    }

    this.status.loaded = true;
    this.status.platform = platform || "jsgame";
    this.status.mediaPath = mediaPath;
    this.status.mediaKind = "jsgame";
    this.status.frameCount = 0;

    // A first frame so status + screenshot are valid immediately (createHostSession
    // already settled initial async loads).
    await this.stepFrames(1);
    return this.status;
  }

  /** Map romdev's setInput vocabulary → a jsgame standard-pad object. */
  _padFromInput(input) {
    if (!input || typeof input !== "object") return {};
    // Pass through the standard button names jsgame's synthetic pad understands
    // (a,b,x,y,l1,r1,l2,r2,select,start,l3,r3,up,down,left,right + axes lx/ly/rx/ry).
    return { ...input };
  }

  setInput(input) {
    if (input && Array.isArray(input.ports)) {
      this._inputPorts = input.ports.map((p) => this._padFromInput(p));
    } else {
      this._inputPorts = [this._padFromInput(input)];
    }
    if (this.session) this.session.setInput(this._inputPorts);
  }

  /**
   * Advance n frames. stepFrame is async (it yields so the game's async work settles),
   * so this returns a Promise — the tools await it (LibretroHost.stepFrames is sync, but
   * the frame tool already awaits host.stepFrames for proxied cores).
   */
  async stepFrames(n) {
    if (!this.session) throw new Error("no jsgame loaded — loadMedia first");
    this.session.setInput(this._inputPorts);
    for (let i = 0; i < n; i++) {
      await this.session.stepFrame();
      this.status.frameCount++;
    }
    const f = this.session.readFrame(); // { data (RGBA), width, height }
    this.state.lastFrame = {
      width: f.width,
      height: f.height,
      pixels: f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data.buffer || f.data),
      pitch: f.width * 4,
      format: JSGAME_FB_FORMAT,
    };
    this.status.fbWidth = f.width;
    this.status.fbHeight = f.height;
    // The canvas IS the display (square pixels) — report the real ratio; a 0
    // here zero-sizes the playtest window.
    this.status.displayAspect = f.height > 0 ? f.width / f.height : 0;
    return n;
  }

  getFramebuffer() {
    if (!this.state.lastFrame) throw new Error("no frame produced yet — step frames first");
    return this.state.lastFrame;
  }

  screenshot() {
    const f = this.getFramebuffer();
    return framebufferToScreenshot(f.width, f.height, f.pixels, f.pitch, f.format);
  }

  screenshotRgba() {
    const f = this.getFramebuffer();
    return { width: f.width, height: f.height,
             pixels: framebufferToRgba(f.width, f.height, f.pixels, f.pitch, f.format) };
  }

  // ── JS introspection (the V8-runtime bonus) ──────────────────────────────────
  /** The game's exposed globals bag (rungame sets globalThis._jsg = {controllers, rom, …}). */
  jsGlobals() {
    return globalThis._jsg ? Object.keys(globalThis._jsg) : [];
  }

  cheatsSupported() { return false; }

  reset() { this.status.frameCount = 0; }

  destroy() {
    if (this.session) { try { this.session.destroy(); } catch { /* ignore */ } }
    this.session = null;
    this.state.lastFrame = null;
    this.status.loaded = false;
  }
}
