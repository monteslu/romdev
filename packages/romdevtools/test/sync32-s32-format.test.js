// The .s32 container format, checked against real carts built by the SDK's
// own Python (tools/mks32.py).
//
// This is an ORACLE test: every fixture is a cart the native SDK produced, so
// a drift in our header packing shows up as a byte difference against a file
// we did not write. The header is 64 bytes of offsets and a CRC — the kind of
// thing that is either exactly right or silently loads garbage on hardware,
// which is why it is pinned to real output rather than to itself.
//
// Fixtures live in the sibling sync32-sdk checkout. When it is absent (a CI
// box, a fresh clone) the test SKIPS rather than fails: it is a parity check
// against an external tree, not a contract romdev can satisfy alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { packS32, elfSymbolAddress, crc32 } from "../src/toolchains/sync32/s32-format.js";

const SDK = process.env.SYNC32_SDK ?? path.join(os.homedir(), "code", "cliemu", "sync32-sdk");
const PLANES = path.join(SDK, "examples", "planes");
const have = existsSync(path.join(PLANES, "planes.elf")) && existsSync(path.join(PLANES, "planes.s32e"));

test("crc32 matches zlib.crc32 on known vectors", () => {
  assert.equal(crc32(new TextEncoder().encode("")), 0);
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array([0, 0, 0, 0])), 0x2144df1c);
});

test("elfSymbolAddress rejects a non-ELF buffer", () => {
  assert.throws(() => elfSymbolAddress(new Uint8Array([1, 2, 3, 4]), "_start"), /not an ELF/);
});

test("packS32 refuses an entry outside the image (wrong linker script for the mode)", (t) => {
  if (!have) return t.skip("sync32-sdk fixtures not present");
  const elf = new Uint8Array(readFileSync(path.join(PLANES, "planes.elf")));
  // planes.elf is linked for RAM (base 0x20030000); packing it as xip
  // (0x10100000) puts _start far past the end of the image.
  assert.throws(
    () => packS32({ image: new Uint8Array(64), elf, mode: "xip", title: "x", id: "x" }),
    /outside the xip image/,
  );
});

test("packS32 reproduces the SDK's own planes.s32e byte for byte", (t) => {
  if (!have) return t.skip("sync32-sdk fixtures not present");
  const elf = new Uint8Array(readFileSync(path.join(PLANES, "planes.elf")));
  const want = new Uint8Array(readFileSync(path.join(PLANES, "planes.s32e")));

  // Read the parameters back out of the reference so the test states the
  // format's own contract rather than hardcoding what we think it is.
  const dv = new DataView(want.buffer, want.byteOffset, want.byteLength);
  const imgOff = dv.getUint32(16, true);
  const imgLen = dv.getUint32(20, true);
  const image = want.subarray(imgOff, imgOff + imgLen);
  const strip = (a, b) => new TextDecoder().decode(want.subarray(a, b)).replace(/\0+$/, "");

  const got = packS32({
    image, elf,
    mode: want[28] === 0 ? "ram" : "xip",
    video: want[29] === 0 ? "240" : "180",
    api: dv.getUint16(6, true),
    title: strip(32, 48),
    id: strip(48, 56),
  }).bytes;

  assert.equal(got.length, want.length, "total size");
  const at = got.findIndex((b, i) => b !== want[i]);
  assert.equal(at, -1, at === -1 ? "identical" : `first difference at byte ${at} (header is 0-63)`);
});
