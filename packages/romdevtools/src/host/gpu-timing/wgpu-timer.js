// GPU time of a WebGPU cart's frames, measured by the host from timestamp
// queries, with no help from the cart.
//
// The host owns the device, so it sees every pass the cart encodes:
// GPUCommandEncoder.beginRenderPass / beginComputePass go through JavaScript
// (wasmcart's emdawnwebgpu glue; only the draw-level calls are native direct
// calls), so wrapping them reaches every pass. A pass the cart begins with no
// timestampWrites gets the host's own pair; a pass the cart already times
// (cartwheel's pass timers) keeps the cart's, and the host resolves those
// queries too. After the frame's last submit the host resolves the frame's
// queries into a buffer, copies it to a mappable one and maps it.
//
// Per frame it reports:
//   busyMs  the union of every pass's [begin, end] (the GPU time spent inside
//           the frame's passes; buffer copies and writeBuffer uploads outside
//           a pass are not timed, WebGPU has no timestamp for them)
//   spanMs  first pass begin to last pass end (includes the GPU idling while
//           it waited for the CPU to submit more)
//   passes  passes in the frame; cartTimed: those the cart timed itself
//
// The device needs the "timestamp-query" feature, which a device has only if
// it was requested when the device was made, so the cart must be LOADED for
// timing: installTimestampFeature() wraps webgpu-node's requestAdapter /
// requestDevice so an adapter requested with `romdevTimestampQuery: true` in
// its options makes devices with the feature (wasmcart passes adapterOptions
// through untouched).
//
// Plain JS ESM + JSDoc.

const TS_KEY = "romdevTimestampQuery";
const tsAdapters = new WeakSet();
let installed = null;

/**
 * Wrap webgpu-node's GPU.requestAdapter and GPUAdapter.requestDevice once, so
 * that an adapter requested with {romdevTimestampQuery:true} gives devices
 * with timestamp-query where the adapter has it. Other adapters are untouched.
 * @returns {Promise<boolean>} true when webgpu-node is there to wrap
 */
export async function installTimestampFeature() {
  if (installed) return installed;
  installed = (async () => {
    let mod;
    try { mod = await import("webgpu-node"); } catch { return false; }
    const G = mod.globals || mod;
    const GPU = G.GPU, Adapter = G.GPUAdapter;
    if (!GPU?.prototype?.requestAdapter || !Adapter?.prototype?.requestDevice) return false;
    // Dawn quantizes timestamps to 2^16 ns (65.5 us) by default, a guard
    // against timing attacks in a browser. A frame's passes are often shorter
    // than that, so a quantized pass time is mostly rounding. Every GPU
    // instance made from here on gets the toggle off (webgpu-node's createGPU
    // calls native-dawn's create with Dawn flags; it only affects devices that
    // have timestamp-query).
    try {
      const nd = (await import("native-dawn")).default;
      if (nd && typeof nd.create === "function" && !nd.create.__romdevUnquantized) {
        const create = nd.create;
        const wrapped = function (flags = []) {
          const f = [...flags];
          const i = f.findIndex((x) => x.startsWith("disable-dawn-features="));
          if (i < 0) f.push("disable-dawn-features=timestamp_quantization");
          else if (!f[i].includes("timestamp_quantization")) f[i] += ",timestamp_quantization";
          return create.call(this, f);
        };
        wrapped.__romdevUnquantized = true;
        nd.create = wrapped;
      }
    } catch { /* timestamps stay quantized; summarize() still works */ }
    const reqAdapter = GPU.prototype.requestAdapter;
    GPU.prototype.requestAdapter = async function (opts) {
      const want = !!opts?.[TS_KEY];
      let clean = opts;
      if (opts && TS_KEY in opts) { clean = { ...opts }; delete clean[TS_KEY]; }
      const a = await reqAdapter.call(this, clean);
      if (a && want) tsAdapters.add(a);
      return a;
    };
    const reqDevice = Adapter.prototype.requestDevice;
    Adapter.prototype.requestDevice = function (desc) {
      if (tsAdapters.has(this) && this.features?.has?.("timestamp-query")) {
        const req = [...(desc?.requiredFeatures || [])];
        if (!req.includes("timestamp-query")) req.push("timestamp-query");
        desc = { ...(desc || {}), requiredFeatures: req };
      }
      return reqDevice.call(this, desc);
    };
    return true;
  })();
  return installed;
}

/** The adapterOptions key that asks for timestamp-query on the device. */
export const TIMESTAMP_ADAPTER_OPTION = TS_KEY;

const MAX_PASSES = 1024; // host query pairs per frame
const RING = 3;          // readback buffers in flight

/**
 * Times one device's frames. attach() once; beginFrame() before the cart's
 * frame, endFrame() after it (after its last submit). endFrame returns a
 * promise of the frame's numbers.
 */
export class WgpuFrameTimer {
  /**
   * @param {GPUDevice} device
   * @param {object} G - the WebGPU globals (GPUBufferUsage, GPUMapMode)
   */
  constructor(device, G) {
    this.device = device;
    this.G = G;
    this.available = !!device?.features?.has?.("timestamp-query");
    this.reason = this.available ? null
      : "the cart's WebGPU device has no timestamp-query feature: load the cart with loadMedia({gpuTiming:true}) (the feature can only be asked for when the device is made)";
    this._on = false;
    this._frame = null;
    this._attached = false;
    this.overflowFrames = 0;
  }

  attach() {
    if (this._attached || !this.available) return;
    this._attached = true;
    const { device, G } = this;
    this.qs = device.createQuerySet({ type: "timestamp", count: MAX_PASSES * 2 });
    // resolve target: the host's pairs first, then 256-aligned slots per cart query set
    this._resolveBytes = MAX_PASSES * 2 * 8 + 16 * 4096 * 8;
    this.resolveBuf = device.createBuffer({ size: this._resolveBytes, usage: G.GPUBufferUsage.QUERY_RESOLVE | G.GPUBufferUsage.COPY_SRC });
    this.ring = [];
    for (let i = 0; i < RING; i++) this.ring.push({ buf: device.createBuffer({ size: this._resolveBytes, usage: G.GPUBufferUsage.MAP_READ | G.GPUBufferUsage.COPY_DST }), busy: null });
    this._ringAt = 0;
    const timer = this;
    const origCreate = device.createCommandEncoder;
    // Own-property wrapper on THIS device only: other devices in the process
    // (other sessions' carts) never see it.
    device.createCommandEncoder = function (desc) {
      const enc = origCreate.call(this, desc);
      if (timer._on && timer._frame) timer._wrapEncoder(enc);
      return enc;
    };
    this._origCreate = origCreate;
    this._queue = device.queue;
    this._origSubmit = device.queue.submit;
  }

  /**
   * Copy the stamps of the cart-timed passes encoded so far on `enc` into
   * resolveBuf, on that same encoder. A cart that times its own passes may
   * reuse its query indices later in the same command buffer (cartwheel
   * resolves its set and starts again from index 0 at each flush), so the
   * copy must sit in the command stream before the next pass can overwrite
   * them: it is recorded when the next pass begins, when the cart resolves its
   * own set, and when the encoder finishes. (A pass's end() is a direct
   * native call, so it cannot be the hook.)
   */
  _flush(enc, origResolve) {
    const f = this._frame;
    const pend = enc.__romdevPending;
    if (!f || !pend?.length) return;
    enc.__romdevPending = [];
    for (const c of pend) {
      const lo = Math.min(c.b, c.e), count = Math.abs(c.e - c.b) + 1;
      if (f.off + count * 8 > this._resolveBytes) { f.lost++; continue; }
      origResolve.call(enc, c.qs, lo, count, this.resolveBuf, f.off);
      f.placed.push({ c, lo, off: f.off });
      f.off = Math.ceil((f.off + count * 8) / 256) * 256;
    }
  }

  _wrapEncoder(enc) {
    const timer = this;
    enc.__romdevPending = [];
    const origResolve = enc.resolveQuerySet;
    for (const kind of ["beginRenderPass", "beginComputePass"]) {
      const orig = enc[kind];
      enc[kind] = function (desc) {
        const f = timer._frame;
        if (!f || !timer._on) return orig.call(this, desc);
        timer._flush(this, origResolve); // the previous pass has ended: copy its stamps first
        f.passes++;
        const tw = desc?.timestampWrites;
        if (tw && tw.querySet) {
          // the cart times this pass itself: read its stamps too
          const b = tw.beginningOfPassWriteIndex, e = tw.endOfPassWriteIndex;
          if (b != null && e != null) this.__romdevPending.push({ qs: tw.querySet, b, e });
          else f.partial++;
          f.cartTimed++;
          return orig.call(this, desc);
        }
        if (f.used + 2 > MAX_PASSES * 2) { f.overflow = true; return orig.call(this, desc); }
        const i = f.used; f.used += 2;
        return orig.call(this, { ...(desc || {}), timestampWrites: { querySet: timer.qs, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 } });
      };
    }
    enc.resolveQuerySet = function (...a) {
      if (timer._frame) timer._flush(this, origResolve);
      return origResolve.apply(this, a);
    };
    const origFinish = enc.finish;
    enc.finish = function (...a) {
      if (timer._frame) timer._flush(this, origResolve);
      return origFinish.apply(this, a);
    };
  }

  beginFrame() {
    if (!this.available) return;
    this.attach();
    this._on = true;
    this._frame = { used: 0, passes: 0, cartTimed: 0, partial: 0, lost: 0, placed: [],
      off: Math.ceil((MAX_PASSES * 2 * 8) / 256) * 256, overflow: false };
  }

  /**
   * After the cart's frame: resolve, copy, map. Resolves to
   * {busyMs, spanMs, passes, cartTimed, overflow} (busyMs/spanMs null when the
   * frame had no timed pass).
   */
  endFrame() {
    if (!this.available || !this._frame) return Promise.resolve(null);
    const f = this._frame;
    this._frame = null;
    this._on = false;
    const { device, G } = this;
    const slot = this.ring[this._ringAt];
    this._ringAt = (this._ringAt + 1) % RING;
    const wait = slot.busy || Promise.resolve();
    const run = async () => {
      await wait;
      const enc = this._origCreate.call(device);
      if (f.used) enc.resolveQuerySet(this.qs, 0, f.used, this.resolveBuf, 0);
      const bytes = Math.max(f.off, 256);
      enc.copyBufferToBuffer(this.resolveBuf, 0, slot.buf, 0, bytes);
      this._origSubmit.call(this._queue, [enc.finish()]);
      await slot.buf.mapAsync(G.GPUMapMode.READ, 0, bytes);
      const v = new BigUint64Array(slot.buf.getMappedRange(0, bytes).slice(0));
      slot.buf.unmap();
      const iv = [];
      for (let i = 0; i + 1 < f.used; i += 2) iv.push([v[i], v[i + 1]]);
      for (const { c, lo, off: o } of f.placed) {
        const base = o / 8;
        iv.push([v[base + c.b - lo], v[base + c.e - lo]]);
      }
      return { ...summarize(iv), passes: f.passes, cartTimed: f.cartTimed, partial: f.partial, lost: f.lost, overflow: f.overflow };
    };
    const p = run();
    slot.busy = p.catch(() => {});
    return p;
  }

  detach() {
    if (!this._attached) return;
    try { this.device.createCommandEncoder = this._origCreate; } catch { /* device gone */ }
    try { delete this.device.createCommandEncoder; } catch { /* own property only */ }
    for (const r of this.ring || []) { try { r.buf.destroy(); } catch { /* gone */ } }
    try { this.resolveBuf?.destroy(); } catch { /* gone */ }
    try { this.qs?.destroy(); } catch { /* gone */ }
    this._attached = false;
  }
}

/**
 * Union and span of [begin, end] timestamp pairs (BigInt ns). Pairs with a
 * zero or reversed stamp (a pass that never ran, a query the GPU did not
 * write) are dropped and counted.
 * @param {Array<[bigint, bigint]>} pairs
 */
export function summarize(pairs) {
  const ok = pairs.filter(([b, e]) => b > 0n && e >= b).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  if (!ok.length) return { busyMs: null, spanMs: null, timedPasses: 0, dropped: pairs.length };
  let busy = 0n, curB = ok[0][0], curE = ok[0][1];
  let first = ok[0][0], last = ok[0][1];
  for (let i = 1; i < ok.length; i++) {
    const [b, e] = ok[i];
    if (e > last) last = e;
    if (b <= curE) { if (e > curE) curE = e; }
    else { busy += curE - curB; curB = b; curE = e; }
  }
  busy += curE - curB;
  return { busyMs: Number(busy) / 1e6, spanMs: Number(last - first) / 1e6, timedPasses: ok.length, dropped: pairs.length - ok.length };
}
