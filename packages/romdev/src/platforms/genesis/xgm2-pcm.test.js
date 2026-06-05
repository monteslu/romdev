// Genesis XGM2 PCM encoder: WAV parse → resample → 8-bit signed → 256-pad.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWav, resampleLinear, wavToXgm2Pcm, emitXgm2PcmC } from "./xgm2-pcm.js";

// Build a minimal 16-bit mono PCM WAV from a sample array.
function makeWav(samples, sampleRate) {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);        // fmt chunk size
  buf.writeUInt16LE(1, 20);         // PCM
  buf.writeUInt16LE(1, 22);         // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);         // block align
  buf.writeUInt16LE(16, 34);        // bits
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  return buf;
}

test("parseWav reads rate/channels/bits and normalizes 16-bit to float", () => {
  const wav = makeWav([0, 16384, -16384, 32767, -32768], 22050);
  const { samples, sampleRate, channels, bits } = parseWav(wav);
  assert.equal(sampleRate, 22050);
  assert.equal(channels, 1);
  assert.equal(bits, 16);
  assert.equal(samples.length, 5);
  assert.ok(Math.abs(samples[1] - 0.5) < 0.01, "16384/32768 ≈ 0.5");
  assert.ok(Math.abs(samples[3] - 1.0) < 0.01, "full-scale ≈ 1.0");
});

test("parseWav rejects non-RIFF input", () => {
  assert.throws(() => parseWav(Buffer.from("not a wav at all here....")), /RIFF\/WAVE/);
});

test("resampleLinear changes length by the rate ratio", () => {
  const src = new Float32Array(100).fill(0.5);
  const down = resampleLinear(src, 26600, 13300); // half
  assert.equal(down.length, 50);
  assert.ok(Math.abs(down[10] - 0.5) < 1e-6, "flat signal stays flat");
  const same = resampleLinear(src, 13300, 13300);
  assert.equal(same, src, "equal rates return the same array");
});

test("wavToXgm2Pcm: 8-bit signed, 13.3kHz, length padded to 256", () => {
  // 13300 samples at 13300 Hz → resampling to 13300 is a no-op → 13300 samples,
  // padded up to the next multiple of 256.
  const samples = new Array(13300).fill(0).map((_, i) => (i % 2 ? 32767 : -32768));
  const wav = makeWav(samples, 13300);
  const r = wavToXgm2Pcm(wav);
  assert.equal(r.rate, 13300);
  assert.equal(r.sourceRate, 13300);
  assert.equal(r.sampleCount, 13300);
  assert.equal(r.paddedBytes % 256, 0, "padded to a 256 multiple");
  assert.equal(r.paddedBytes, Math.ceil(13300 / 256) * 256);
  // Full-scale alternating → ±127 in signed 8-bit (we scale by 127, so -1.0 →
  // -127 = byte 0x81, +1.0 → +127 = 0x7f). Symmetric, no DC offset.
  assert.equal(r.pcm[0], 0x81, "-32768 → -127");
  assert.equal(r.pcm[1], 0x7f, "32767 → +127");
  // Tail is zero-padded (silence).
  assert.equal(r.pcm[r.paddedBytes - 1], 0x00);
});

test("wavToXgm2Pcm halfRate targets 6.65kHz and halves the sample count", () => {
  const samples = new Array(13300).fill(8192);
  const wav = makeWav(samples, 13300);
  const full = wavToXgm2Pcm(wav, { halfRate: false });
  const half = wavToXgm2Pcm(wav, { halfRate: true });
  assert.equal(full.rate, 13300);
  assert.equal(half.rate, 6650);
  assert.ok(half.sampleCount < full.sampleCount * 0.6, "half-rate has ~half the samples");
});

test("wavToXgm2Pcm pcm16 input needs a pcmRate, then resamples", () => {
  const raw = Buffer.alloc(200); // 100 s16 samples of silence
  assert.throws(() => wavToXgm2Pcm(raw, { format: "pcm16" }), /pcmRate/);
  const r = wavToXgm2Pcm(raw, { format: "pcm16", pcmRate: 26600 });
  assert.equal(r.rate, 13300);
  assert.equal(r.paddedBytes, 256, "100 samples → resampled to ~50 → padded to 256");
});

test("emitXgm2PcmC declares a 256-aligned array + LEN define", () => {
  const pcm = new Uint8Array(256);
  const c = emitXgm2PcmC(pcm, "sfx_jump", 13300);
  assert.match(c, /__attribute__\(\(aligned\(256\)\)\)/);
  assert.match(c, /#define SFX_JUMP_LEN 256/);
  assert.match(c, /const u8 sfx_jump\[256\]/);
});
