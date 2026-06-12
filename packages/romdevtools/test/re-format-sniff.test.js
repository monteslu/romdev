// re-format-sniff.test.js — A6: container/format sniffing for the RE engine.
// SMD-interleaved Genesis dumps scramble every byte under a flat read; the
// sniff must detect + reverse the interleave (and leave plain ROMs alone).

import { test } from "node:test";
import assert from "node:assert/strict";

import { deinterleaveSmd } from "../src/analysis/analyze.js";

/** Forward-interleave a flat ROM into SMD layout (the inverse of the fix), so we
 * can round-trip: flat → SMD → deinterleave → flat. */
function makeSmd(flat) {
  const blocks = flat.length / 0x4000;
  const out = new Uint8Array(512 + flat.length);
  out[8] = 0xaa; out[9] = 0xbb; // SMD magic
  const body = out.subarray(512);
  for (let b = 0; b < blocks; b++) {
    const base = b * 0x4000;
    for (let i = 0; i < 0x2000; i++) {
      body[base + i] = flat[base + i * 2 + 1];        // odd bytes → first 8KB
      body[base + 0x2000 + i] = flat[base + i * 2];   // even bytes → second 8KB
    }
  }
  return out;
}

test("A6: SMD round-trip — deinterleave reverses the interleave exactly", () => {
  // A 32KB flat ROM with a recognizable pattern (byte value = offset & 0xff).
  const flat = new Uint8Array(0x8000);
  for (let i = 0; i < flat.length; i++) flat[i] = i & 0xff;

  const smd = makeSmd(flat);
  assert.equal(smd.length, 512 + flat.length, "SMD = 512 header + body");

  const back = deinterleaveSmd(smd);
  assert.ok(back, "detected as SMD");
  assert.equal(back.length, flat.length, "header stripped");
  assert.deepEqual([...back], [...flat], "deinterleave reproduces the flat ROM byte-for-byte");
});

test("A6: a plain flat ROM is NOT mistaken for SMD (no magic)", () => {
  const flat = new Uint8Array(0x8000);
  for (let i = 0; i < flat.length; i++) flat[i] = i & 0xff;
  assert.equal(deinterleaveSmd(flat), null, "no 512 header + no magic → not SMD");
});

test("A6: a (N*16KB)+512 sized blob without the magic is left alone", () => {
  // Right size to be SMD, but no 0xAA/0xBB magic → must NOT deinterleave (avoid
  // corrupting a legitimately-sized flat ROM).
  const blob = new Uint8Array(512 + 0x8000);
  assert.equal(deinterleaveSmd(blob), null);
});

test("A6: too-small input returns null", () => {
  assert.equal(deinterleaveSmd(new Uint8Array(100)), null);
});
