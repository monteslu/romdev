// Self-contained test for the IT214 sample decompressor in src/it.js.
//
// The pvsneslib fixtures happen to use uncompressed samples, so this test
// validates the (far more subtle) IT214 decompressor with a synthetic but
// VALID compressed bitstream. The encoder below emits every value at full
// width (nbits+1 bits, top bit clear) so the decoder takes its method-3
// pass-through path and integrates the deltas — exercising the 8-bit and
// 16-bit integrators and the it215 (cmwt==0x215) double-integration.
//
// The expected checksums were captured from the ORIGINAL mmutil C
// decompressor (Load_IT_Sample_CMP, it.c) fed the identical encoded bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Load_IT_Sample_CMP } from '../src/it.js';

// xorshift32 — identical to the reference encoder used to generate expectations
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s >>> 0;
  };
}

class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.nbits = 0; }
  put(value, width) {
    for (let i = 0; i < width; i++) {
      this.cur |= ((value >> i) & 1) << this.nbits;
      if (++this.nbits === 8) { this.bytes.push(this.cur & 0xff); this.cur = 0; this.nbits = 0; }
    }
  }
  finish() { if (this.nbits) { this.bytes.push(this.cur & 0xff); this.cur = 0; this.nbits = 0; } return this.bytes; }
}

// Build a block-framed compressed stream (u16 length + body, repeated).
function encodeStream(seed, sampLen, bit16) {
  const rng = makeRng(seed);
  const nbits = bit16 ? 16 : 8;
  const width = nbits + 1;
  const cap = bit16 ? 0x4000 : 0x8000;
  const mask = (Math.pow(2, nbits) - 1) >>> 0;
  const half = Math.pow(2, nbits - 1);
  const out = [];
  let remaining = sampLen;
  while (remaining > 0) {
    const blockSamples = remaining < cap ? remaining : cap;
    const bw = new BitWriter();
    for (let i = 0; i < blockSamples; i++) {
      const d = (rng() % (2 * half)) - half; // signed delta
      bw.put(d & mask, width); // bit `nbits` stays 0 -> not a width-change cmd
    }
    const body = bw.finish();
    const size = body.length & 0xffff;
    out.push(size & 0xff, (size >> 8) & 0xff);
    for (const b of body) out.push(b);
    remaining -= blockSamples;
  }
  return new Uint8Array(out);
}

// Minimal reader compatible with Load_IT_CompressedSampleBlock (read16 + read8).
class Reader {
  constructor(b) { this.b = b; this.pos = 0; }
  read8() { const p = this.pos++; return p < this.b.length ? this.b[p] : 0; }
  read16() { return (this.read8() | (this.read8() << 8)) & 0xffff; }
}

function decode(seed, sampLen, cmwt, bit16) {
  const stream = encodeStream(seed, sampLen, bit16);
  const dest = bit16 ? new Uint16Array(sampLen) : new Uint8Array(sampLen);
  const err = Load_IT_Sample_CMP(new Reader(stream), dest, sampLen, cmwt, bit16);
  assert.equal(err, 0, 'decompress should succeed');
  let sum = 0n;
  for (let x = 0; x < sampLen; x++) sum = (sum * 131n + BigInt(dest[x])) & 0xffffffffn;
  return sum;
}

// Expectations captured from the C decompressor (seed 7 in all cases).
const CASES = [
  { bit16: false, cmwt: 0x214, sampLen: 5, sum: 3854772795n },
  { bit16: false, cmwt: 0x214, sampLen: 100, sum: 298576463n },
  { bit16: false, cmwt: 0x214, sampLen: 1000, sum: 1231404375n },
  { bit16: false, cmwt: 0x215, sampLen: 5, sum: 4087798358n },
  { bit16: false, cmwt: 0x215, sampLen: 100, sum: 102498853n },
  { bit16: false, cmwt: 0x215, sampLen: 1000, sum: 2546541605n },
  { bit16: true, cmwt: 0x214, sampLen: 5, sum: 1782393915n },
  { bit16: true, cmwt: 0x214, sampLen: 100, sum: 1663105103n },
  { bit16: true, cmwt: 0x214, sampLen: 1000, sum: 718859095n },
  { bit16: true, cmwt: 0x215, sampLen: 5, sum: 964173142n },
  { bit16: true, cmwt: 0x215, sampLen: 100, sum: 2525502757n },
  { bit16: true, cmwt: 0x215, sampLen: 1000, sum: 2045596709n },
];

for (const c of CASES) {
  const label = `${c.bit16 ? '16bit' : '8bit'} cmwt=0x${c.cmwt.toString(16)} len=${c.sampLen}`;
  test(`Load_IT_Sample_CMP matches C reference: ${label}`, () => {
    assert.equal(decode(7, c.sampLen, c.cmwt, c.bit16), c.sum);
  });
}

test('Load_IT_Sample_CMP: integrator wraps within s8/s16 (deterministic, non-trivial)', () => {
  // a long stream must not produce all-128/all-32768 (i.e. deltas integrate)
  const stream = encodeStream(42, 500, false);
  const dest = new Uint8Array(500);
  Load_IT_Sample_CMP(new Reader(stream), dest, 500, 0x214, false);
  const allSame = dest.every((v) => v === dest[0]);
  assert.equal(allSame, false, 'decoded data should vary');
});
