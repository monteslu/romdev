// Audio verification for recompiled wasmcarts: capture both sides' sound per
// frame on the shared frame axis and say how close the cart's samples are to
// the reference core's. Backs the `audio` option of frame({op:'verifyRecompile'})
// and frame({op:'findDiverge', cart}).
//
// What is compared, and why this shape:
//
//  * PER FRAME. A libretro core hands the host a variable number of samples
//    each retro_run (fceumm, gpgx and mGBA count samples with fractional
//    accumulators or blip buffers), and a recompiled cart writes its own count
//    each wc_render. Chunks are keyed by the frame that produced them, so
//    reference frame F is paired with cart frame F + offset (the same axis the
//    picture uses) and a count mismatch is reported at the frame it happens.
//  * STREAMS. "output" is what the core gives audio_batch_cb (int16 stereo)
//    and what the wasmcart host drains from the cart's ring. A core that
//    resamples or filters on the way out can also expose its PRE-resample
//    samples as a per-frame stream region (AUDIO_STREAM header below); a cart
//    section then names that region as its `reference`, or pairs one of its
//    own debug buffers with it (`streams.<name>.ref`).
//  * SCORES. exact = stereo sample frames where L and R both match; max abs
//    and RMS error; cross-correlation lag of the mono mix (0 for an exact
//    cart: a nonzero lag is a timing error the per-sample score hides as
//    "everything differs"); an envelope correlation (per-frame RMS) and a
//    spectral similarity (band-energy overlap) that survive a sample-rate
//    difference, for a reference whose rate the cart does not share.
//  * CONTROLS that must fail: silence (the scorer sees missing audio), a
//    one-frame shift (it sees timing), a stereo-channel drop (it sees a lost
//    side), and with the section's muteMask a real cart re-run with one mixer
//    channel silenced (it sees a lost voice).

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// ─── the reference-side per-frame stream region ──────────────────────────────

/**
 * Layout of a per-frame audio stream region exposed by a core patch
 * (retro_get_memory_data id, readable by memory({op:'read'})). The core
 * REWRITES it every retro_run: count restarts at 0 at the top of the frame.
 *   +0  u32 magic 'RDAS' (0x53414452)
 *   +4  u32 count      sample frames written during the last retro_run
 *   +8  u32 channels   1 or 2 (interleaved)
 *   +12 u32 format     0 = s16, 1 = s32, 2 = f32
 *   +16 u32 rate       samples per second (0 = not a fixed rate, e.g. per-event)
 *   +20 u32 capacity   sample frames the buffer holds (a count above it = overflow)
 *   +24 u32 dropped    sample frames that did not fit this frame
 *   +28 u32 reserved
 *   +32 samples
 */
export const AUDIO_STREAM = Object.freeze({ magic: 0x53414452, header: 32, formats: ["s16", "s32", "f32"] });

const BYTES = { s16: 2, s32: 4, f32: 4 };

function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

function decodeSamples(bytes, format) {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (format === "s16") return new Int16Array(buf);
  if (format === "s32") return new Int32Array(buf);
  return new Float32Array(buf);
}

/**
 * Read one frame of a reference stream region.
 * @param {object} host LibretroHost (regionSize/readMemory)
 * @param {string} region
 * @returns {{samples: Int16Array|Int32Array|Float32Array, channels: number, format: string, rate: number, dropped: number}}
 */
export function readRefStream(host, region) {
  const size = host.regionSize?.(region) ?? 0;
  if (!size) throw new Error(`reference has no audio stream region '${region}' (memory({op:'regions'}) lists what this core exposes)`);
  const h = Uint8Array.from(host.readMemory(region, 0, AUDIO_STREAM.header));
  if (u32(h, 0) !== AUDIO_STREAM.magic) throw new Error(`region '${region}' is not an audio stream (no 'RDAS' magic)`);
  const count = u32(h, 4), channels = u32(h, 8), format = AUDIO_STREAM.formats[u32(h, 12)], rate = u32(h, 16), cap = u32(h, 20), dropped = u32(h, 24);
  if (!format) throw new Error(`audio stream '${region}' has an unknown format code ${u32(h, 12)}`);
  const n = Math.min(count, cap) * channels;
  const bytes = n ? Uint8Array.from(host.readMemory(region, AUDIO_STREAM.header, n * BYTES[format])) : new Uint8Array(0);
  return { samples: decodeSamples(bytes, format), channels, format, rate, dropped: Math.max(dropped, count - cap, 0) };
}

/**
 * Read one frame of a cart debug stream (section audio.streams.<name>).
 * @param {object} cartHost WasmcartHost
 * @param {{offset:number,countOffset:number,capacity:number,channels?:number,format?:string}} s
 */
export function readCartStream(cartHost, s) {
  const format = s.format ?? "s16", channels = s.channels ?? 1;
  const count = u32(Uint8Array.from(cartHost.readMemory(s.countOffset, 4)), 0);
  const n = Math.min(count, s.capacity) * channels;
  const bytes = n ? Uint8Array.from(cartHost.readMemory(s.offset, n * BYTES[format])) : new Uint8Array(0);
  return { samples: decodeSamples(bytes, format), channels, format, dropped: Math.max(0, count - s.capacity) };
}

/** Everything the host queued on its audio ring since the last drain, as one interleaved s16 array. */
export function drainAudioRing(host) {
  const ring = host?.state?.audioRing;
  if (!Array.isArray(ring) || !ring.length) { if (Array.isArray(ring)) ring.length = 0; return new Int16Array(0); }
  let total = 0;
  for (const c of ring) total += c.length;
  const out = new Int16Array(total);
  let p = 0;
  for (const c of ring) { out.set(c, p); p += c.length; }
  ring.length = 0;
  return out;
}

// ─── per-frame capture ───────────────────────────────────────────────────────

/**
 * Collects one side's audio per frame. `source` is "output" (the host's
 * audio ring), {region} (a reference stream region) or {cartStream} (a cart
 * debug buffer). Frames outside [from, to] are drained and dropped, so
 * memory is bounded by the window.
 */
export class AudioCapture {
  /**
   * @param {object} host
   * @param {{source?: "output"|{region:string}|{cartStream:object}, from?: number, to?: number, keep?: boolean, maxBytes?: number}} [o]
   */
  constructor(host, o = {}) {
    this.host = host;
    this.source = o.source ?? "output";
    this.from = o.from ?? 0;
    this.to = o.to ?? Infinity;
    this.keep = o.keep !== false;
    // A raw stream is big (gb_apu_raw is ~140 KB a frame): bound what one
    // capture may hold rather than exhausting the server's heap.
    this.maxBytes = o.maxBytes ?? 512 * 1024 * 1024;
    this.bytes = 0;
    /** @type {Map<number, Int16Array|Int32Array|Float32Array>} */
    this.frames = new Map();
    this.channels = 2;
    this.format = "s16";
    this.rate = 0;
    this.dropped = 0;
    this.errors = [];
    // Audio queued before capture starts (load-time settle frames) belongs
    // to no frame on the shared axis.
    if (this.source === "output") drainAudioRing(host);
  }

  /** Called after the host ran frame `f` (frames stepped since load). */
  onFrame(f) {
    let s;
    if (this.source === "output") s = drainAudioRing(this.host);
    else {
      try {
        const r = this.source.region ? readRefStream(this.host, this.source.region) : readCartStream(this.host, this.source.cartStream);
        s = r.samples; this.channels = r.channels; this.format = r.format; if (r.rate) this.rate = r.rate; this.dropped += r.dropped;
      } catch (e) {
        if (this.errors.length < 4) this.errors.push(`frame ${f}: ${e.message}`);
        s = null;
      }
    }
    if (s && this.keep && f >= this.from && f <= this.to) {
      this.bytes += s.byteLength;
      if (this.bytes > this.maxBytes) {
        throw new Error(`audio capture of ${this.source === "output" ? "the output stream" : this.source.region ?? "a cart debug stream"} passed ${Math.round(this.maxBytes / 1048576)} MB at frame ${f} (${this.frames.size} frames kept): narrow audioFrames to the span you need`);
      }
      this.frames.set(f, s);
    }
    return s;
  }
}

// ─── math ────────────────────────────────────────────────────────────────────

/** In-place iterative radix-2 FFT (re, im: Float64Array of power-of-two length). */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

const pow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

/** Mono mix of interleaved samples (the mean of the channels), as Float64Array. */
export function toMono(samples, channels = 2) {
  if (channels === 1) return Float64Array.from(samples);
  if (channels > 2) {
    const n = Math.floor(samples.length / channels), out = new Float64Array(n);
    for (let i = 0; i < n; i++) { let v = 0; for (let k = 0; k < channels; k++) v += samples[i * channels + k]; out[i] = v / channels; }
    return out;
  }
  const n = samples.length >> 1, out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (samples[2 * i] + samples[2 * i + 1]) / 2;
  return out;
}

/** Linear resample of a mono signal from rate `from` to rate `to`. */
export function resampleLinear(x, from, to) {
  if (!from || !to || Math.abs(from - to) < 1e-9) return x;
  const n = Math.floor((x.length * to) / from), out = new Float64Array(n), step = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * step, k = Math.floor(p), f = p - k;
    out[i] = (x[k] ?? 0) * (1 - f) + (x[k + 1] ?? x[k] ?? 0) * f;
  }
  return out;
}

/**
 * Normalised cross-correlation lag between two mono signals at the same
 * rate: the lag k (in samples) that best explains cart[n] = ref[n - k]
 * (positive = the cart is LATE). Uses the loudest `maxLen` span of the
 * reference so a long run stays cheap (one FFT pair).
 * @returns {{lag:number, peak:number, atZero:number, span:[number,number]}|null} null when the span is silent
 */
export function crossCorrelationLag(ref, cart, { maxLag = 2048, maxLen = 65536 } = {}) {
  const n0 = Math.min(ref.length, cart.length);
  if (n0 < 16) return null;
  const len = Math.min(maxLen, n0);
  // loudest span of the reference (energy in 1024-sample hops)
  let start = 0;
  if (n0 > len) {
    let best = -1;
    for (let s = 0; s + len <= n0; s += 1024) {
      let e = 0;
      for (let i = s; i < s + len; i += 16) e += ref[i] * ref[i];
      if (e > best) { best = e; start = s; }
    }
  }
  const a = ref.subarray(start, start + len), b = cart.subarray(start, start + len);
  const ma = a.reduce((s, v) => s + v, 0) / len, mb = b.reduce((s, v) => s + v, 0) / len;
  let ea = 0, eb = 0;
  for (let i = 0; i < len; i++) { ea += (a[i] - ma) ** 2; eb += (b[i] - mb) ** 2; }
  if (ea < 1e-9 * len || eb < 1e-9 * len) return null;
  const N = pow2(2 * len);
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  for (let i = 0; i < len; i++) { ar[i] = a[i] - ma; br[i] = b[i] - mb; }
  fft(ar, ai); fft(br, bi);
  // conj(A) * B -> inverse via conj trick
  for (let i = 0; i < N; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i], im = ar[i] * bi[i] - ai[i] * br[i];
    ar[i] = r; ai[i] = -im;
  }
  fft(ar, ai);
  const norm = Math.sqrt(ea * eb);
  const at = (k) => (ar[(k + N) % N] / N) / norm;
  const L = Math.min(maxLag, len - 1);
  let lag = 0, peak = -Infinity;
  for (let k = -L; k <= L; k++) { const v = at(k); if (v > peak + 1e-12 || (Math.abs(v - peak) <= 1e-12 && Math.abs(k) < Math.abs(lag))) { peak = v; lag = k; } }
  const r4 = (v) => Math.round(v * 10000) / 10000;
  return { lag, peak: r4(peak), atZero: r4(at(0)), span: [start, start + len] };
}

function acRms(x) {
  if (!x.length) return 0;
  let m = 0;
  for (let i = 0; i < x.length; i++) m += x[i];
  m /= x.length;
  let e = 0;
  for (let i = 0; i < x.length; i++) e += (x[i] - m) ** 2;
  return Math.sqrt(e / x.length);
}

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  if (sxx < 1e-9 || syy < 1e-9) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Band-energy distribution of a mono block: `bands` log-spaced bands from lo Hz to hi Hz. */
function bandEnergies(x, rate, lo, hi, bands) {
  const N = pow2(Math.max(64, x.length)), re = new Float64Array(N), im = new Float64Array(N);
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= x.length || 1;
  for (let i = 0; i < x.length; i++) re[i] = (x[i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, x.length - 1)));
  fft(re, im);
  const out = new Float64Array(bands);
  const edge = (b) => lo * (hi / lo) ** (b / bands);
  for (let k = 1; k < N / 2; k++) {
    const hz = (k * rate) / N;
    if (hz < lo || hz >= hi) continue;
    const b = Math.min(bands - 1, Math.floor((bands * Math.log(hz / lo)) / Math.log(hi / lo)));
    if (hz >= edge(b)) out[b] += re[k] * re[k] + im[k] * im[k];
  }
  return out;
}

// ─── scoring ─────────────────────────────────────────────────────────────────

const SILENT_RANGE = 4;

function stats(samples) {
  let mn = Infinity, mx = -Infinity, e = 0;
  for (let i = 0; i < samples.length; i++) { const v = samples[i]; if (v < mn) mn = v; if (v > mx) mx = v; e += v * v; }
  return samples.length ? { min: mn, max: mx, rms: Math.round(Math.sqrt(e / samples.length) * 100) / 100 } : { min: 0, max: 0, rms: 0 };
}

function concatChunks(chunks, Ctor) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Ctor(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

function fnv(arr) {
  const b = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Per-frame hash of an audio chunk (FNV-1a over its bytes, with the length). */
export function audioChunkHash(chunk) {
  return chunk ? `${chunk.length}:${fnv(chunk)}` : "0:none";
}

/**
 * Score a cart stream against a reference stream, both captured per frame.
 *
 * @param {object} a
 * @param {Map<number, ArrayLike<number>>} a.ref     reference chunks by reference frame
 * @param {Map<number, ArrayLike<number>>} a.cart    cart chunks by cart frame
 * @param {number} a.offset                          cart frame = reference frame + offset
 * @param {number} [a.from] first reference frame compared
 * @param {number} [a.to]   last reference frame compared
 * @param {number} [a.refRate]
 * @param {number} [a.cartRate]
 * @param {number} [a.refChannels=2]
 * @param {number} [a.cartChannels=2]
 * @param {number} [a.maxLag]      cross-correlation lag search (samples, default one frame of audio x 2)
 * @param {object} [a.bar]         {minSpectral, minEnvelope} for the "similar" mode
 * @returns {object}
 */
export function scoreAudio(a) {
  const off = a.offset ?? 0;
  const refCh = a.refChannels ?? 2, cartCh = a.cartChannels ?? 2;
  const refFrames = [...a.ref.keys()].filter((f) => (a.from == null || f >= a.from) && (a.to == null || f <= a.to) && a.cart.has(f + off)).sort((x, y) => x - y);
  const refRate = a.refRate || 0, cartRate = a.cartRate || 0;
  const sameRate = refRate > 0 && cartRate > 0 && Math.abs(refRate - cartRate) < 1;
  const sameShape = refCh === cartCh;
  const mode = sameRate && sameShape ? "exact" : "similar";
  const bar = { minSpectral: 0.9, minEnvelope: 0.9, ...(a.bar ?? {}) };
  if (!refFrames.length) {
    return { mode, framesCompared: 0, status: "NO-DATA", note: "no reference frame in the window has a cart frame on the shared axis (check the window and the alignment)" };
  }
  const refChunks = refFrames.map((f) => a.ref.get(f)), cartChunks = refFrames.map((f) => a.cart.get(f + off));
  // per-frame: counts and exactness
  let countMismatch = 0, firstCount = null, framesExact = 0, firstFrame = null;
  const perFrameRms = { ref: [], cart: [] };
  for (let i = 0; i < refFrames.length; i++) {
    const r = refChunks[i], c = cartChunks[i];
    const rn = r.length / refCh, cn = c.length / cartCh;
    if (rn !== cn) { countMismatch++; firstCount ??= { refFrame: refFrames[i], cartFrame: refFrames[i] + off, refSamples: rn, cartSamples: cn }; }
    let same = rn === cn && sameShape;
    if (same) for (let k = 0; k < r.length; k++) if (r[k] !== c[k]) { same = false; break; }
    if (same) framesExact++;
    else if (!firstFrame) {
      let k = 0;
      if (sameShape) while (k < Math.min(r.length, c.length) && r[k] === c[k]) k++;
      firstFrame = { refFrame: refFrames[i], cartFrame: refFrames[i] + off, sampleFrame: Math.floor(k / refCh), channel: refCh === 2 ? (k % 2 ? "R" : "L") : "mono",
        ref: r[k] ?? null, cart: c[k] ?? null, refSamples: rn, cartSamples: cn };
    }
    // AC level (the frame's mean removed): a core's raw stream can carry a
    // DC bias its output filter removes, which would swamp the envelope.
    perFrameRms.ref.push(acRms(toMono(r, refCh)));
    perFrameRms.cart.push(acRms(toMono(c, cartCh)));
  }
  const refAll = concatChunks(refChunks, refChunks[0].constructor), cartAll = concatChunks(cartChunks, cartChunks[0].constructor);
  const refStats = stats(refAll), cartStats = stats(cartAll);
  const refSilent = refStats.max - refStats.min <= SILENT_RANGE, cartSilent = cartStats.max - cartStats.min <= SILENT_RANGE;
  const out = {
    mode, framesCompared: refFrames.length, window: [refFrames[0], refFrames[refFrames.length - 1]],
    refRate, cartRate, refChannels: refCh, cartChannels: cartCh,
    refSampleFrames: refAll.length / refCh, cartSampleFrames: cartAll.length / cartCh,
    framesExact, framesExactPct: Math.round((10000 * framesExact) / refFrames.length) / 100,
    countMismatchFrames: countMismatch, ...(firstCount ? { firstCountMismatch: firstCount } : {}),
    ...(firstFrame ? { firstMismatch: firstFrame } : {}),
    ref: { ...refStats, silent: refSilent }, cart: { ...cartStats, silent: cartSilent },
  };
  // sample-level over the concatenation (same shape only)
  if (sameShape) {
    const n = Math.min(refAll.length, cartAll.length);
    let match = 0, maxAbs = 0, se = 0;
    for (let i = 0; i + refCh - 1 < n; i += refCh) {
      let eq = true;
      for (let k = 0; k < refCh; k++) {
        const d = cartAll[i + k] - refAll[i + k];
        if (d) { eq = false; const ad = Math.abs(d); if (ad > maxAbs) maxAbs = ad; se += d * d; }
      }
      if (eq) match++;
    }
    const total = Math.max(refAll.length, cartAll.length) / refCh;
    out.exactSampleFrames = match;
    out.exactPct = total ? Math.floor((1e6 * match) / total) / 1e4 : null;
    out.maxAbsError = maxAbs;
    out.rmsError = n ? Math.round(Math.sqrt(se / n) * 100) / 100 : null;
    out.lengthDiff = cartAll.length / cartCh - refAll.length / refCh;
  }
  // lag, envelope, spectrum: on the mono mix; when the rates differ both are
  // brought to the LOWER rate (a 2 MHz raw stream is never upsampled to), and
  // the lag is reported in reference samples and seconds.
  const common = sameRate || !refRate || !cartRate ? (refRate || cartRate) : Math.min(refRate, cartRate);
  const refMono = sameRate || !common ? toMono(refAll, refCh) : resampleLinear(toMono(refAll, refCh), refRate, common);
  const cartMono = sameRate || !common ? toMono(cartAll, cartCh) : resampleLinear(toMono(cartAll, cartCh), cartRate, common);
  const perFrame = common ? Math.round(common / 60) : 800;
  const scaleLag = !sameRate && refRate && common ? refRate / common : 1;
  out.xcorr = crossCorrelationLag(refMono, cartMono, { maxLag: a.maxLag ? Math.round(a.maxLag / scaleLag) : perFrame * 2 });
  if (out.xcorr && scaleLag !== 1) Object.assign(out.xcorr, { lag: Math.round(out.xcorr.lag * scaleLag), lagAtRate: common });
  if (out.xcorr && common) out.xcorr.lagSeconds = Math.round((out.xcorr.lag / (refRate || common)) * 1e6) / 1e6;
  if (!out.xcorr) out.xcorrNote = refSilent || cartSilent ? "one side is silent in the loudest span: no lag to measure" : "too few samples";
  const env = pearson(perFrameRms.ref, perFrameRms.cart);
  const sumR = perFrameRms.ref.reduce((s, v) => s + v, 0), sumC = perFrameRms.cart.reduce((s, v) => s + v, 0);
  out.envelope = { correlation: env == null ? null : Math.round(env * 10000) / 10000, levelRatio: sumR ? Math.round((1000 * sumC) / sumR) / 1000 : null };
  out.spectral = spectralSimilarity(refChunks, cartChunks, refCh, cartCh, refRate || 48000, cartRate || refRate || 48000);
  // verdict for this comparison
  const reasons = [];
  if (refSilent) reasons.push("the reference is SILENT across the window: audio cannot be verified here (pick frames where the game makes sound)");
  if (mode === "exact") {
    if (countMismatch) reasons.push(`sample counts differ on ${countMismatch} frame(s), first at ref frame ${firstCount.refFrame} (ref ${firstCount.refSamples}, cart ${firstCount.cartSamples})`);
    if (out.exactPct !== 100) reasons.push(`${out.exactPct}% of sample frames match exactly (max abs error ${out.maxAbsError}, RMS ${out.rmsError})${firstFrame ? `; first mismatch at ref frame ${firstFrame.refFrame} sample ${firstFrame.sampleFrame} ${firstFrame.channel} (ref ${firstFrame.ref}, cart ${firstFrame.cart})` : ""}`);
    if (out.xcorr && out.xcorr.lag !== 0) reasons.push(`the cart's audio is offset by ${out.xcorr.lag} samples (cross-correlation peak ${out.xcorr.peak} vs ${out.xcorr.atZero} at 0)`);
  } else {
    if (out.spectral.similarity == null || out.spectral.similarity < bar.minSpectral) reasons.push(`spectral similarity ${out.spectral.similarity} below ${bar.minSpectral}`);
    if (out.envelope.correlation == null || out.envelope.correlation < bar.minEnvelope) reasons.push(`envelope correlation ${out.envelope.correlation} below ${bar.minEnvelope}`);
  }
  out.pass = reasons.length === 0;
  out.reasons = reasons;
  if (mode === "similar") out.modeNote = !sameShape
    ? `channel layouts differ (ref ${refCh}, cart ${cartCh}): only the envelope and spectrum are comparable`
    : `rates differ (ref ${refRate} Hz, cart ${cartRate} Hz): sample-exact comparison is impossible, so the envelope and spectrum decide. For an exact compare the cart must output at the reference stream's rate, or the reference must expose its pre-resample stream (audio.reference).`;
  return out;
}

/**
 * Band-energy overlap per block of 4 frames (sum over bands of min(p, q) of
 * the two normalised distributions; 1 = same spectral shape), weighted by the
 * reference block's energy. Works across sample rates: bands are in Hz.
 */
export function spectralSimilarity(refChunks, cartChunks, refCh, cartCh, refRate, cartRate, { blockFrames = 4, bands = 24 } = {}) {
  const lo = 60, hi = Math.min(refRate, cartRate) * 0.45;
  if (hi <= lo * 2) return { similarity: null, note: "sample rate too low for the band layout" };
  let wsum = 0, ssum = 0, blocks = 0, silentBoth = 0, cartSilentOnly = 0;
  for (let i = 0; i < refChunks.length; i += blockFrames) {
    const r = toMono(concatChunks(refChunks.slice(i, i + blockFrames), Float64Array), refCh);
    const c = toMono(concatChunks(cartChunks.slice(i, i + blockFrames), Float64Array), cartCh);
    if (r.length < 32) continue;
    const er = bandEnergies(r, refRate, lo, hi, bands), ec = c.length >= 32 ? bandEnergies(c, cartRate, lo, hi, bands) : new Float64Array(bands);
    const tr = er.reduce((s, v) => s + v, 0), tc = ec.reduce((s, v) => s + v, 0);
    const quietR = tr < 1e-3 * r.length, quietC = tc < 1e-3 * Math.max(1, c.length);
    if (quietR && quietC) { silentBoth++; continue; }
    let sim = 0;
    if (!quietR && !quietC) for (let b = 0; b < bands; b++) sim += Math.min(er[b] / tr, ec[b] / tc);
    else if (quietC) cartSilentOnly++;
    const w = quietR ? 1 : Math.log1p(tr / r.length);
    wsum += w; ssum += w * sim; blocks++;
  }
  return { similarity: blocks ? Math.round((10000 * ssum) / wsum) / 10000 : null, blocks, silentBlocks: silentBoth, cartSilentBlocks: cartSilentOnly, bandsHz: [lo, Math.round(hi)] };
}

// ─── controls ────────────────────────────────────────────────────────────────

function mapChunks(m, fn) {
  const out = new Map();
  for (const [f, c] of m) out.set(f, fn(c, f));
  return out;
}

/**
 * The synthetic must-fail controls: the cart's own captured stream altered
 * the way a broken cart would be, scored with the SAME scorer and bar.
 *   silence     every sample zeroed
 *   shift       every frame's chunk replaced by the previous frame's (one frame late)
 *   stereoDrop  the right channel zeroed (stereo streams only)
 * A control that cannot fail (a silent reference, a mono stream) says so.
 */
export function syntheticAudioControls(base, which = ["silence", "shift", "stereoDrop"]) {
  const out = {};
  const run = (name, cart) => {
    const s = scoreAudio({ ...base, cart });
    return { failed: !s.pass || (s.mode === "exact" && s.exactPct !== 100), exactPct: s.exactPct ?? null, spectral: s.spectral?.similarity ?? null, envelope: s.envelope?.correlation ?? null };
  };
  const refSilent = (() => { const s = scoreAudio(base); return s.ref?.silent; })();
  for (const w of which) {
    if (refSilent) { out[w] = { skipped: "the reference is silent in the window: no audio control can fail" }; continue; }
    if (w === "silence") out.silence = run("silence", mapChunks(base.cart, (c) => new c.constructor(c.length)));
    else if (w === "shift") {
      const frames = [...base.cart.keys()].sort((x, y) => x - y);
      const shifted = new Map();
      for (let i = 1; i < frames.length; i++) shifted.set(frames[i], base.cart.get(frames[i - 1]));
      out.shift = run("shift", shifted);
    } else if (w === "stereoDrop") {
      if ((base.cartChannels ?? 2) !== 2) { out.stereoDrop = { skipped: "mono stream" }; continue; }
      const r = run("stereoDrop", mapChunks(base.cart, (c) => { const d = c.slice(); for (let i = 1; i < d.length; i += 2) d[i] = 0; return d; }));
      // a reference whose right channel is silent cannot fail this
      let rightLive = false;
      for (const c of base.ref.values()) { for (let i = 1; i < c.length; i += 2) if (Math.abs(c[i]) > SILENT_RANGE) { rightLive = true; break; } if (rightLive) break; }
      out.stereoDrop = rightLive ? r : { ...r, skipped: r.failed ? undefined : "the reference's right channel is silent in the window" };
    }
    if (out[w] && !out[w].skipped && !out[w].failed) out[w].couldNotFail = `altering the cart stream (${w}) still passed the bar: the window's audio cannot tell this fault from the right answer (a constant tone or a repeating loop). Pick a window where the sound changes.`;
  }
  return out;
}

// ─── WAV ─────────────────────────────────────────────────────────────────────

/**
 * Write interleaved samples as a 16-bit PCM WAV (s32/f32 streams are scaled:
 * f32 x 32767, s32 clamped).
 */
export function writeWav(file, samples, rate, channels = 2) {
  const n = samples.length, dataSize = n * 2, buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii"); buf.writeUInt32LE(36 + dataSize, 4); buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii"); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels, 22);
  const r = Math.max(1, Math.round(rate || 48000));
  buf.writeUInt32LE(r, 24); buf.writeUInt32LE(r * channels * 2, 28); buf.writeUInt16LE(channels * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii"); buf.writeUInt32LE(dataSize, 40);
  const f32 = samples instanceof Float32Array;
  for (let i = 0; i < n; i++) {
    let v = f32 ? Math.round(samples[i] * 32767) : samples[i];
    v = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
    buf.writeInt16LE(v, 44 + i * 2);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, buf);
  return file;
}

/**
 * [cart | ref | diff] WAVs of a compared window. diff = cart - ref (only when
 * the two streams share rate and layout).
 */
export function writeAudioWavs(dir, tag, a) {
  const off = a.offset ?? 0;
  const refFrames = [...a.ref.keys()].filter((f) => (a.from == null || f >= a.from) && (a.to == null || f <= a.to) && a.cart.has(f + off)).sort((x, y) => x - y);
  if (!refFrames.length) return null;
  const r = concatChunks(refFrames.map((f) => a.ref.get(f)), a.ref.get(refFrames[0]).constructor);
  const c = concatChunks(refFrames.map((f) => a.cart.get(f + off)), a.cart.get(refFrames[0] + off).constructor);
  const files = {
    cart: writeWav(path.join(dir, `${tag}_audio_cart.wav`), c, a.cartRate, a.cartChannels ?? 2),
    ref: writeWav(path.join(dir, `${tag}_audio_ref.wav`), r, a.refRate, a.refChannels ?? 2),
  };
  if ((a.refChannels ?? 2) === (a.cartChannels ?? 2) && Math.abs((a.refRate || 0) - (a.cartRate || 0)) < 1) {
    const n = Math.max(r.length, c.length), d = new Int32Array(n);
    for (let i = 0; i < n; i++) d[i] = (c[i] ?? 0) - (r[i] ?? 0);
    files.diff = writeWav(path.join(dir, `${tag}_audio_diff.wav`), d, a.refRate, a.refChannels ?? 2);
  }
  return files;
}
