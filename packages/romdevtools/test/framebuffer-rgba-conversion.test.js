// framebufferToRgba fast paths (romdev-core-runner present.js) — the per-tick
// window conversion. The 32bpp formats take a word-at-a-time swizzle and the
// caller can reuse the output buffer across ticks (a fresh 3.7MB Buffer.alloc
// per tick on a 1280x720 wasmcart cart was ~220MB/s of zeroing + GC churn).
// These tests pin the swizzle byte-for-byte against hand-computed pixels and
// the dense-path/byte-path equivalence on non-dense pitches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { framebufferToRgba } from "romdev-core-runner";

const XRGB8888 = 1;          // RETRO_PIXEL_FORMAT_XRGB8888
const RGBA8888 = 0x52474241; // ROMDEV_PIXEL_FORMAT_RGBA8888

test("XRGB8888 dense path: swizzles to RGBA with alpha forced", () => {
  // One pixel: XRGB little-endian bytes are B,G,R,X.
  const pixels = new Uint8Array([0x33 /*B*/, 0x22 /*G*/, 0x11 /*R*/, 0x00 /*X*/]);
  const out = framebufferToRgba({ width: 1, height: 1, pitch: 4, format: XRGB8888, pixels });
  assert.deepEqual([...out], [0x11, 0x22, 0x33, 0xff], "R,G,B,A bytes");
});

test("RGBA8888 dense path: passthrough with alpha forced", () => {
  const pixels = new Uint8Array([0x11, 0x22, 0x33, 0x00]); // alpha 0 in (GL target)
  const out = framebufferToRgba({ width: 1, height: 1, pitch: 4, format: RGBA8888, pixels });
  assert.deepEqual([...out], [0x11, 0x22, 0x33, 0xff]);
});

test("non-dense pitch falls back to the byte path and agrees with the dense path", () => {
  // 2x2 XRGB image with 4 bytes of row padding (pitch 12).
  const px = (b, g, r) => [b, g, r, 0];
  const row0 = [...px(1, 2, 3), ...px(4, 5, 6), 0, 0, 0, 0];
  const row1 = [...px(7, 8, 9), ...px(10, 11, 12), 0, 0, 0, 0];
  const padded = new Uint8Array([...row0, ...row1]);
  const dense = new Uint8Array([...px(1, 2, 3), ...px(4, 5, 6), ...px(7, 8, 9), ...px(10, 11, 12)]);
  const a = framebufferToRgba({ width: 2, height: 2, pitch: 12, format: XRGB8888, pixels: padded });
  const b = framebufferToRgba({ width: 2, height: 2, pitch: 8, format: XRGB8888, pixels: dense });
  assert.deepEqual([...a], [...b], "padded and dense inputs produce the same RGBA");
});

test("output buffer reuse: same instance back when the size matches, fresh when it doesn't", () => {
  const fb = { width: 2, height: 2, pitch: 8, format: XRGB8888, pixels: new Uint8Array(16) };
  const first = framebufferToRgba(fb);
  const second = framebufferToRgba(fb, first);
  assert.equal(second, first, "matching-size scratch buffer is reused");
  const bigger = framebufferToRgba({ ...fb, width: 4, pitch: 16, pixels: new Uint8Array(32) }, first);
  assert.notEqual(bigger, first, "size change allocates fresh instead of corrupting");
  assert.equal(bigger.length, 4 * 2 * 4);
});

test("unaligned source falls back to the byte path (no Uint32Array throw)", () => {
  const backing = new Uint8Array(4 + 1);
  const pixels = backing.subarray(1); // byteOffset 1 — not 4-byte aligned
  pixels.set([0x33, 0x22, 0x11, 0x00]);
  const out = framebufferToRgba({ width: 1, height: 1, pitch: 4, format: XRGB8888, pixels });
  assert.deepEqual([...out], [0x11, 0x22, 0x33, 0xff]);
});
