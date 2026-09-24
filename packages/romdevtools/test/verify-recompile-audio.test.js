// Audio verification of recompiled carts: frame({op:'verifyRecompile',
// audio}) and findDiverge audio:true, driven end to end with a SYNTHETIC cart
// (WAT assembled in-process, run by the real WasmcartHost, its ring written
// through cart-abi's audio helpers) against a JS "reference core" that makes
// the same sound. Two voices (a 441 Hz and a 1225 Hz square, amplitude
// stepping every 8 frames), L = v0 + v1, R = v0 - v1, at a per-frame sample
// count that varies (733/734 at 44100 Hz for a 60.0988 Hz frame), so the
// per-frame pairing, the counts, the lag and every control are exercised.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assembleWatSync } from "../src/analysis/recompile/wat/assemble.js";
import { WasmcartHost } from "../src/host/WasmcartHost.js";
import { verifyRecompile, findRecompileDivergence } from "../src/host/verify-recompile.js";
import { withRecompileSection, wascFromWasm, validateRecompileLayout, readRecompileLayout } from "../src/analysis/recompile/recompile-section.js";
import { abiBlock, wcGetInfoWat, audioPushWat, audioStreamWat, audioSection, audioRingLayout, AUDIO_CONTRACT, WC_FLAG } from "../src/analysis/recompile/wat/cart-abi.js";
import { scoreAudio, crossCorrelationLag, AUDIO_STREAM, readRefStream, spectralSimilarity } from "../src/host/audio-verify.js";

const W = 64, H = 48, FB = 16384, MASK = 16;
const ABI = abiBlock(1024);
const RING = audioRingLayout(4096, 2048);
const DBG = { offset: 40960, countOffset: 40956, capacity: 1024, channels: 1, format: "s16" };
const F0 = 882, F1 = 2450; // 2 x Hz: sign flips at 441 Hz and 1225 Hz

/** Samples produced before machine frame m: floor(m * rate / 60.0988). */
function total(m, rate) { return Math.floor((m * rate * 625) / 37562); }

/** The sound of machine sample n in frame m (both sides compute this). */
function voices(n, m, rate, { f1 = F1 } = {}) {
  const amp = 1 + ((m >> 3) & 3);
  const v0 = (Math.floor((n * F0) / rate) & 1 ? 3000 : -3000) * amp;
  const v1 = Math.floor((n * f1) / rate) & 1 ? 1000 : -1000;
  return [v0, v1];
}

function cartWat({ rate = 44100, delay = 0, f1BugFrom = null, ignoreMask = false, noAudio = false, silentFrom = null } = {}) {
  const tot = (mexpr) => `(i32.wrap_i64 (i64.div_u (i64.mul (i64.extend_i32_u ${mexpr}) (i64.const ${rate * 625})) (i64.const 37562)))`;
  const f1 = f1BugFrom == null ? `(i64.const ${F1})` : `(select (i64.const ${F1 + 400}) (i64.const ${F1}) (i32.ge_u (local.get $m) (i32.const ${f1BugFrom})))`;
  const mask = ignoreMask ? "(i32.const 0)" : `(i32.load8_u (i32.const ${MASK}))`;
  return `(module
  (memory (export "memory") 1)
${wcGetInfoWat({ info: ABI.info, width: W, height: H, fb: FB, input: ABI.input, time: ABI.time, hostInfo: ABI.hostInfo,
    ...(noAudio ? {} : { audio: RING.ring, audioCap: RING.capacity, audioWrite: ABI.audioWrite, sampleRate: rate }) })}
${audioPushWat({ ring: RING.ring, capacity: RING.capacity, cursor: ABI.audioWrite })}
${audioStreamWat("dbg_v0", DBG)}
  (func (export "wc_init"))
  (func (export "wc_render")
    (local $m i32) (local $n i32) (local $end i32) (local $v0 i32) (local $v1 i32) (local $amp i32) (local $k i32) (local $i i32) (local $c i32)
    (local.set $m (i32.load (i32.const 0)))
    (i32.store (i32.const 0) (i32.add (local.get $m) (i32.const 1)))
    (call $dbg_v0_reset)
    (local.set $amp (i32.add (i32.const 1) (i32.and (i32.shr_u (local.get $m) (i32.const 3)) (i32.const 3))))
    (local.set $n ${tot("(local.get $m)")})
    (local.set $end ${tot("(i32.add (local.get $m) (i32.const 1))")})
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $n) (local.get $end)))
      (local.set $k (i32.sub (local.get $n) (i32.const ${delay})))
      (local.set $v0 (i32.mul (local.get $amp)
        (select (i32.const 3000) (i32.const -3000) (i32.and (i32.wrap_i64 (i64.div_u (i64.mul (i64.extend_i32_s (local.get $k)) (i64.const ${F0})) (i64.const ${rate}))) (i32.const 1)))))
      (local.set $v1 (select (i32.const 1000) (i32.const -1000) (i32.and (i32.wrap_i64 (i64.div_u (i64.mul (i64.extend_i32_s (local.get $k)) ${f1}) (i64.const ${rate}))) (i32.const 1))))
      (if (i32.and ${mask} (i32.const 1)) (then (local.set $v0 (i32.const 0))))
      (if (i32.and ${mask} (i32.const 2)) (then (local.set $v1 (i32.const 0))))
      ${silentFrom == null ? "" : `(if (i32.ge_u (local.get $m) (i32.const ${silentFrom})) (then (local.set $v0 (i32.const 0)) (local.set $v1 (i32.const 0))))`}
      (call $dbg_v0_push (local.get $v0))
      ${noAudio ? "" : "(call $audio_push (i32.add (local.get $v0) (local.get $v1)) (i32.sub (local.get $v0) (local.get $v1)))"}
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $l)))
    (local.set $i (i32.const 0))
    (block $pd (loop $pl
      (br_if $pd (i32.ge_u (local.get $i) (i32.const ${W * H})))
      (local.set $c (i32.shr_u (i32.mul (i32.add (local.get $i) (i32.mul (local.get $m) (i32.const 3))) (i32.const -1640531535)) (i32.const 24)))
      (i32.store (i32.add (i32.const ${FB}) (i32.shl (local.get $i) (i32.const 2))) (i32.mul (local.get $c) (i32.const 0x010101)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $pl))))
)`;
}

const AUDIO_BLOCK = audioSection({ sampleRate: 44100, streams: { dbg_v0: { ...DBG, ref: "fake_v0_stream" } }, muteMask: { offset: MASK, size: 1, channels: ["v0", "v1"] } });
const LAYOUT = validateRecompileLayout({ platform: "fake", buttons: "positional", regions: {}, audio: AUDIO_BLOCK });

function cartBytes(opts = {}, layout = LAYOUT) {
  const wasm = assembleWatSync(cartWat(opts));
  return layout ? withRecompileSection(wasm, layout) : wasm;
}

async function openCartFrom(wasm) {
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", bytes: wascFromWasm(wasm, "synthetic-audio") });
  return h;
}

/** A JS stand-in for a libretro core making the same sound: 5 settle frames, an audio ring, an RDAS stream region. */
class FakeCore {
  constructor({ rate = 44100, silent = false, streamRegion = true } = {}) {
    this.rate = rate; this.silent = silent;
    this.mach = 0;
    this.state = { audioRing: [] };
    this.status = { platform: "fake", loaded: true, frameCount: 0, settleFramesUsed: 5, fbWidth: W, fbHeight: H, audioSampleRate: rate };
    this.stream = streamRegion ? new Uint8Array(AUDIO_STREAM.header + 4096 * 2) : null;
    for (let i = 0; i < 5; i++) this._frame();
  }
  _frame() {
    const m = this.mach++;
    this.last = m;
    const n0 = total(m, this.rate), n1 = total(m + 1, this.rate);
    const out = new Int16Array((n1 - n0) * 2), v0s = new Int16Array(n1 - n0);
    for (let n = n0; n < n1; n++) {
      let [v0, v1] = voices(n, m, this.rate);
      if (this.silent) { v0 = 0; v1 = 0; }
      out[(n - n0) * 2] = v0 + v1; out[(n - n0) * 2 + 1] = v0 - v1; v0s[n - n0] = v0;
    }
    this.state.audioRing.push(out);
    if (this.stream) {
      const dv = new DataView(this.stream.buffer);
      dv.setUint32(0, AUDIO_STREAM.magic, true); dv.setUint32(4, v0s.length, true); dv.setUint32(8, 1, true);
      dv.setUint32(12, 0, true); dv.setUint32(16, this.rate, true); dv.setUint32(20, 4096, true); dv.setUint32(24, 0, true);
      this.stream.set(new Uint8Array(v0s.buffer), AUDIO_STREAM.header);
    }
  }
  setInput() {}
  stepFrames(n) { for (let i = 0; i < n; i++) { this._frame(); this.status.frameCount++; } return n; }
  screenshotRgba() {
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const c = (Math.imul(i + this.last * 3, -1640531535) >>> 24) & 0xff;
      rgba[i * 4] = c; rgba[i * 4 + 1] = c; rgba[i * 4 + 2] = c; rgba[i * 4 + 3] = 0xff;
    }
    return { width: W, height: H, rgba };
  }
  regionSize(r) { return r === "fake_v0_stream" && this.stream ? this.stream.length : 0; }
  readMemory(r, off, len) { return this.stream.slice(off, off + len); }
  dispose() {}
}

const BAR = { minContentPx: 1000, minMovingPx: 100 };

function run(overrides = {}, { cart = cartBytes(), core = {}, layout = LAYOUT } = {}) {
  return verifyRecompile({
    openCart: () => openCartFrom(cart), openRef: async () => new FakeCore(core), refPlatform: "fake",
    layout, frames: [40, 80], bar: BAR, controls: ["wrongFrame"], audio: "required", ...overrides,
  });
}
function dispose(r) { r.cartHost.destroy?.(); r.refHost.dispose?.(); }

test("schema: the audio block is validated and defaulted", () => {
  const a = validateRecompileLayout({ regions: {}, audio: { sampleRate: 48000 } }).audio;
  assert.deepEqual({ channels: a.channels, format: a.format, reference: a.reference }, { channels: 2, format: "s16", reference: "output" });
  assert.throws(() => validateRecompileLayout({ regions: {}, audio: {} }), /sampleRate/);
  assert.throws(() => validateRecompileLayout({ regions: {}, audio: { sampleRate: 48000, channels: 1 } }), /channels must be 2/);
  assert.throws(() => validateRecompileLayout({ regions: {}, audio: { sampleRate: 48000, format: "u8" } }), /format/);
  assert.throws(() => validateRecompileLayout({ regions: {}, audio: { sampleRate: 48000, streams: { x: { offset: 0, countOffset: 4 } } } }), /capacity/);
  assert.throws(() => validateRecompileLayout({ regions: {}, audio: { sampleRate: 48000, muteMask: { offset: 0, size: 1, channels: Array(9).fill("c") } } }), /no more than/);
  // the section round-trips through the cart
  assert.deepEqual(readRecompileLayout(cartBytes()).audio, AUDIO_BLOCK);
  assert.ok(AUDIO_CONTRACT.perFrame && AUDIO_CONTRACT.rate && AUDIO_CONTRACT.format);
});

test("cart-abi: wc_get_info refuses an audio ring without cap, cursor or rate", () => {
  const base = { info: ABI.info, width: W, height: H, fb: FB, input: ABI.input, time: ABI.time };
  assert.throws(() => wcGetInfoWat({ ...base, audio: RING.ring, audioWrite: ABI.audioWrite, sampleRate: 48000 }), /audioCap/);
  assert.throws(() => wcGetInfoWat({ ...base, audio: RING.ring, audioCap: 2048, sampleRate: 48000 }), /audioWrite/);
  assert.throws(() => wcGetInfoWat({ ...base, audio: RING.ring, audioCap: 2048, audioWrite: ABI.audioWrite }), /sampleRate/);
  assert.throws(() => wcGetInfoWat({ ...base, audio: ABI.input, audioCap: 64, audioWrite: ABI.audioWrite, sampleRate: 48000 }), /overlaps/);
  assert.match(wcGetInfoWat({ ...base, audio: RING.ring, audioCap: 2048, audioWrite: ABI.audioWrite, sampleRate: 48000, flags: WC_FLAG.AUDIO_F32 }), /i32.const 48000/);
});

test("an exact cart is AUDIO VERIFIED: every frame's count and samples equal, lag 0, every audio control fails", async () => {
  const dir = mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", ".audio-"));
  const r = await run({ audioWav: true, outputDir: dir, tag: "tone" });
  try {
    const a = r.result.audio;
    assert.equal(r.result.verdict, "VERIFIED", JSON.stringify(r.result.reasons));
    assert.equal(a.verdict, "AUDIO VERIFIED", JSON.stringify(a.reasons));
    assert.equal(a.mode, "exact");
    assert.equal(a.exactPct, 100);
    assert.equal(a.framesExactPct, 100);
    assert.equal(a.countMismatchFrames, 0);
    assert.equal(a.maxAbsError, 0);
    assert.equal(a.xcorr.lag, 0);
    assert.ok(a.xcorr.peak > 0.999);
    assert.deepEqual(a.window, [1, 80]);
    assert.equal(a.refRate, 44100); assert.equal(a.cartRate, 44100);
    // the counts really vary per frame
    assert.equal(a.refSampleFrames, total(85, 44100) - total(5, 44100), "reference frames 1..80 = machine frames 5..84");
    const counts = new Set(Array.from({ length: 80 }, (_, i) => total(i + 6, 44100) - total(i + 5, 44100)));
    assert.equal(counts.size, 2, "the per-frame count varies (733/734)");
    for (const c of ["silence", "shift", "stereoDrop", "channelDrop"]) assert.equal(a.controls[c].failed, true, `${c} must fail: ${JSON.stringify(a.controls[c])}`);
    assert.equal(a.controls.channelDrop.channel, "v0");
    // the debug stream matched its reference stream region
    assert.equal(a.streams.dbg_v0.exactPct, 100, JSON.stringify(a.streams.dbg_v0));
    assert.equal(a.streams.dbg_v0.pass, true);
    // WAVs
    for (const k of ["cart", "ref", "diff"]) assert.ok(existsSync(a.wavs[k]), k);
    const diff = readFileSync(a.wavs.diff);
    assert.equal(diff.toString("ascii", 0, 4), "RIFF");
    assert.equal(diff.readUInt32LE(24), 44100);
    assert.ok(diff.subarray(44).every((b) => b === 0), "the diff of an exact cart is silence");
  } finally { dispose(r); rmSync(dir, { recursive: true, force: true }); }
});

test("a cart one sample late fails: exact% drops and the cross-correlation names the lag", async () => {
  const r = await run({}, { cart: cartBytes({ delay: 3 }) });
  try {
    const a = r.result.audio;
    assert.equal(r.result.verdict, "NOT VERIFIED");
    assert.equal(a.verdict, "AUDIO DIFFERS");
    assert.ok(a.exactPct < 100);
    assert.equal(a.xcorr.lag, 3, JSON.stringify(a.xcorr));
    assert.match(r.result.reasons.join(" "), /audio: .*offset by 3 samples/);
    assert.equal(a.countMismatchFrames, 0, "the counts are right, only the timing is not");
  } finally { dispose(r); }
});

test("a wrong voice from frame 50 fails at exactly that frame; findDiverge audio finds the same frame", async () => {
  const cart = cartBytes({ f1BugFrom: 50 + 4 + 4 }); // machine frame 58 = reference frame 54 (settle 5 -> machine = F + 4)
  const r = await run({}, { cart });
  try {
    const a = r.result.audio;
    assert.equal(a.verdict, "AUDIO DIFFERS");
    assert.equal(a.firstMismatch.refFrame, 54, JSON.stringify(a.firstMismatch));
    assert.ok(a.framesExact === 53, `frames 1..53 exact, got ${a.framesExact}`);
  } finally { dispose(r); }
  const cartHost = await openCartFrom(cart), refHost = new FakeCore();
  try {
    const d = await findRecompileDivergence({ cartHost, refHost, refPlatform: "fake", layout: LAYOUT, audio: true, maxFrames: 200 });
    assert.equal(d.diverged, true);
    assert.equal(d.atRefFrame, 54);
    assert.equal(d.audio.refFrame, 54);
    assert.equal(d.lastIdenticalRefFrame, 53);
  } finally { cartHost.destroy?.(); }
});

test("findDiverge audio: an identical cart runs clean, with a stride too", async () => {
  for (const stride of [1, 7]) {
    const cartHost = await openCartFrom(cartBytes()), refHost = new FakeCore();
    try {
      const d = await findRecompileDivergence({ cartHost, refHost, refPlatform: "fake", layout: LAYOUT, audio: true, maxFrames: 30, stride });
      assert.equal(d.diverged, false, JSON.stringify(d));
      assert.equal(d.audio.referenceSilent, false);
      assert.equal(d.conclusion, "no-observed-divergence");
    } finally { cartHost.destroy?.(); }
  }
});

test("a cart that ignores muteMask makes channelDrop unfailable, and 'required' refuses the verdict", async () => {
  const r = await run({ audioControls: ["channelDrop"] }, { cart: cartBytes({ ignoreMask: true }) });
  try {
    const c = r.result.audio.controls.channelDrop;
    assert.equal(c.failed, false);
    assert.match(c.couldNotFail, /ignores muteMask/);
    assert.equal(r.result.verdict, "NOT VERIFIED");
    assert.match(r.result.reasons.join(" "), /audio control channelDrop did NOT fail/);
  } finally { dispose(r); }
});

test("audio:true reports without deciding the verdict; a silent reference is never evidence", async () => {
  const r = await run({ audio: true }, { cart: cartBytes({ silentFrom: 0 }), core: { silent: true } });
  try {
    assert.equal(r.result.verdict, "VERIFIED", "audio:true does not decide");
    assert.equal(r.result.audio.verdict, "AUDIO DIFFERS");
    assert.match(r.result.audio.reasons.join(" "), /SILENT/);
    assert.match(r.result.audio.controls.silence.skipped, /silent/);
  } finally { dispose(r); }
  const r2 = await run({}, { cart: cartBytes({ silentFrom: 0 }), core: { silent: true } });
  try { assert.equal(r2.result.verdict, "NOT VERIFIED"); } finally { dispose(r2); }
});

test("a cart with no audio ring fails 'required'", async () => {
  const r = await run({}, { cart: cartBytes({ noAudio: true }) });
  try {
    assert.equal(r.result.verdict, "NOT VERIFIED");
    assert.match(r.result.audio.reasons.join(" "), /no audio ring/);
  } finally { dispose(r); }
});

test("a reference stream region can be THE compared stream (audioStream)", async () => {
  // Compare the cart's ring against the mono v0 stream: layouts differ, so it is 'similar' mode and fails
  // (the ring carries v1 too); compare the cart's dbg stream through `streams` instead - exact.
  const r = await run({ audio: true, audioStream: "fake_v0_stream" });
  try {
    const a = r.result.audio;
    assert.equal(a.stream, "fake_v0_stream");
    assert.equal(a.refChannels, 1);
    assert.equal(a.mode, "similar");
    assert.equal(a.streams.dbg_v0.exactPct, 100);
  } finally { dispose(r); }
  const miss = await run({ audio: "required", audioStream: "nope" });
  try { assert.match(miss.result.audio.reasons.join(" "), /could not be read/); } finally { dispose(miss); }
});

test("different rates fall back to envelope + spectrum: the same tones pass, a wrong voice does not", async () => {
  const r = await run({ audioControls: ["silence", "shift"] }, { cart: cartBytes({ rate: 48000 }), layout: validateRecompileLayout({ ...LAYOUT, audio: { ...AUDIO_BLOCK, sampleRate: 48000, streams: {} } }) });
  try {
    const a = r.result.audio;
    assert.equal(a.mode, "similar");
    assert.equal(a.cartRate, 48000);
    assert.ok(a.spectral.similarity > 0.9, JSON.stringify(a.spectral));
    assert.ok(a.envelope.correlation > 0.9, JSON.stringify(a.envelope));
    assert.equal(a.verdict, "AUDIO VERIFIED", JSON.stringify(a.reasons));
    assert.equal(a.controls.silence.failed, true);
  } finally { dispose(r); }
  const bad = await run({ audioControls: [] }, { cart: cartBytes({ rate: 48000, silentFrom: 30 }), layout: validateRecompileLayout({ ...LAYOUT, audio: { ...AUDIO_BLOCK, sampleRate: 48000, streams: {} } }) });
  try {
    assert.equal(bad.result.audio.verdict, "AUDIO DIFFERS");
    assert.ok(bad.result.audio.spectral.similarity < 0.9);
  } finally { dispose(bad); }
});

test("scorer units: lag sign, silence, and a count mismatch at its frame", () => {
  const ref = new Float64Array(4000).map((_, i) => Math.sin(i / 7) * 1000 + Math.sin(i / 3.1) * 400);
  const late = new Float64Array(4000);
  for (let i = 5; i < 4000; i++) late[i] = ref[i - 5];
  assert.equal(crossCorrelationLag(ref, late, { maxLag: 50 }).lag, 5);
  const early = ref.slice(5);
  assert.equal(crossCorrelationLag(ref, early, { maxLag: 50 }).lag, -5);
  assert.equal(crossCorrelationLag(new Float64Array(100), ref), null);
  const mk = (n, v) => new Int16Array(n * 2).fill(v);
  const refM = new Map([[1, mk(10, 5)], [2, mk(10, 9)], [3, mk(10, 5)]]);
  const cartM = new Map([[1, mk(10, 5)], [2, mk(11, 9)], [3, mk(10, 5)]]);
  const s = scoreAudio({ ref: refM, cart: cartM, offset: 0, refRate: 100, cartRate: 100 });
  assert.equal(s.countMismatchFrames, 1);
  assert.deepEqual([s.firstCountMismatch.refFrame, s.firstCountMismatch.refSamples, s.firstCountMismatch.cartSamples], [2, 10, 11]);
  assert.equal(s.pass, false);
  const sp = spectralSimilarity([Int16Array.from({ length: 1600 }, (_, i) => Math.sin(i / 5) * 8000)], [new Int16Array(1600)], 2, 2, 48000, 48000);
  assert.equal(sp.similarity, 0, "a silent cart against a sounding reference has no spectral overlap");
  const hdr = new Uint8Array(AUDIO_STREAM.header + 8);
  const dv = new DataView(hdr.buffer);
  dv.setUint32(0, AUDIO_STREAM.magic, true); dv.setUint32(4, 3, true); dv.setUint32(8, 1, true); dv.setUint32(12, 0, true); dv.setUint32(20, 2, true);
  const h = { regionSize: () => hdr.length, readMemory: (_r, o, l) => hdr.slice(o, o + l) };
  const st = readRefStream(h, "x");
  assert.equal(st.samples.length, 2, "count above capacity is truncated to capacity");
  assert.equal(st.dropped, 1, "and reported as dropped");
});
