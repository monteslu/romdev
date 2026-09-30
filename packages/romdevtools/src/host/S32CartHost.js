// A natively recompiled cart (.s32 built by disasm({target:'recompile',
// emit:'sync32'})) as the "cart side" of frame({op:'verifyRecompile'}) and
// findDiverge.
//
// The verifier was written for wasmcarts: it reads cart state as offsets into
// one linear memory. Here that memory is the console's SRAM (s32core's
// system_ram region, base 0x20000000), where the cart keeps the emulated
// machine's state; the cart's descriptor (s32-cart.js) gives those offsets.
// Everything else (stepping, input, screenshots, the audio ring) is the
// sync32 core's own LibretroHost.
//
// Frame axis: loadMedia settles 5 frames on s32core as it does on the
// reference core, and the cart presents once per emulated frame, so
// status.frameCount counts the settle frames too (the alignment arithmetic
// then gives offset 0, the truth).
//
// Plain JS ESM + JSDoc.

import { LibretroHost } from "romdev-core-host/index.js";
import { resolveCore } from "../cores/registry.js";

export const SRAM_BASE = 0x20000000;

export class S32CartHost {
  constructor() {
    this.inner = new LibretroHost();
    this.platform = "sync32";
  }

  /** @param {{path:string}} a */
  async loadMedia(a) {
    const r = resolveCore("sync32");
    if (!r) throw new Error("no sync32 core (romdev-core-s32core) installed");
    await this.inner.loadCore(r.jsPath, r.wasmPath, { noderawfs: true });
    await this.inner.loadMedia({ platform: "sync32", path: a.path, beforeSettle: a.beforeSettle });
    this._settle = this.inner.status.settleFramesUsed ?? 0;
    return this;
  }

  get state() { return this.inner.state; }
  get status() {
    const s = this.inner.status;
    const settle = this._settle ?? 0;
    return new Proxy(s, { get: (t, k) => (k === "frameCount" ? (t.frameCount ?? 0) + settle : t[k]) });
  }
  get mod() { return this.inner.mod; }

  setInput(i) { return this.inner.setInput(i); }
  stepFrames(n) { return this.inner.stepFrames(n); }
  screenshotRgba() { return this.inner.screenshotRgba(); }
  getFramebuffer() { return this.inner.getFramebuffer?.(); }
  regionSize(r) { return this.inner.regionSize?.(r); }

  /** Cart-side reads: offsets into the console SRAM. */
  readMemory(offset, length) {
    if (typeof offset === "string") return this.inner.readMemory(offset, length, arguments[2]);
    return this.inner.readMemory("system_ram", offset, length);
  }
  writeMemory(offset, bytes) {
    if (typeof offset === "string") return this.inner.writeMemory(offset, bytes, arguments[2]);
    return this.inner.writeMemory("system_ram", offset, bytes);
  }
  wasmMemorySize() { return this.inner.regionSize?.("system_ram") ?? 0; }

  dispose() { this.inner.dispose?.(); this.inner.unloadMedia?.(); }
  destroy() { this.dispose(); }
}
