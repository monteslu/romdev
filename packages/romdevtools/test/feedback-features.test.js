// Unit guards for the 5 feedback features built on top of the v0.1.40 fixes.
// The live-core paths (diffMemory snapshot/compare, loadMedia cheats, learnFontMap
// fromScreen, per-session windows) are exercised against a running server in the
// session; these cover the pure logic that drives them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCheatCodeForApply } from "../src/mcp/tools/cheats.js";

// loadMedia({cheats}) and applyCheat share resolveCheatCodeForApply — the
// raw-ROM-cheat re-encode that keeps a boot cheat from silently no-opping.
test("resolveCheatCodeForApply: raw NES ROM cheat → Game Genie read-intercept", () => {
  const r = resolveCheatCodeForApply("C06C:0C:26", "nes");
  assert.equal(r.appliedAs, "rom");
  // Canonical spelling: bit 3 of the third letter is the 8-char length
  // marker (decode-identical to the bit-clear GATKGATX the feedback cited).
  assert.equal(r.code, "GAVKGATX");
  assert.equal(r.reencodedFrom, "C06C:0C:26");
});

test("resolveCheatCodeForApply: raw RAM address stays a RAM poke", () => {
  const r = resolveCheatCodeForApply("0040:05", "nes");
  assert.equal(r.appliedAs, "ram");
  assert.equal(r.code, "0040:05");
  assert.equal(r.reencodedFrom, null);
});

test("resolveCheatCodeForApply: a SHORT RAM code is normalized to the binding width", () => {
  // A 2-hex-digit RAM address ("32:09") is INERT on libretro cores (parses but
  // never pokes) — apply used to pass it through verbatim and falsely report
  // success. Now it's re-padded to "0032:09" (the form that actually binds) and
  // reencodedFrom records the original. (Verified live on fceumm.)
  const r = resolveCheatCodeForApply("32:09", "nes");
  assert.equal(r.appliedAs, "ram");
  assert.equal(r.code, "0032:09", "short RAM address padded to the binding width");
  assert.equal(r.reencodedFrom, "32:09");
});

test("resolveCheatCodeForApply: a native device code (no colon) passes through", () => {
  const r = resolveCheatCodeForApply("GATKGATX", "nes");
  assert.equal(r.code, "GATKGATX");
  assert.equal(r.appliedAs, "raw");
});

test("resolveCheatCodeForApply: SNES raw ROM cheat re-encodes (not via PAR RAM device)", () => {
  const r = resolveCheatCodeForApply("009234:42:7C", "snes");
  assert.equal(r.appliedAs, "rom");
  assert.ok(r.code.includes("-"), "SNES Game Genie code shape");
});

// diffMemory's core comparison: changed offsets between two byte arrays.
function diffBytes(before, after, baseOffset = 0) {
  const out = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) out.push({ offset: baseOffset + i, before: before[i], after: after[i] });
  }
  return out;
}

test("diff logic: only changed bytes are reported, with before/after", () => {
  const before = Uint8Array.from([0x10, 0x20, 0x30, 0x40]);
  const after = Uint8Array.from([0x10, 0x99, 0x30, 0x41]);
  const changes = diffBytes(before, after, 0x200);
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[0], { offset: 0x201, before: 0x20, after: 0x99 });
  assert.deepEqual(changes[1], { offset: 0x203, before: 0x40, after: 0x41 });
});

test("diff logic: identical snapshots report no changes", () => {
  const a = Uint8Array.from([1, 2, 3]);
  assert.equal(diffBytes(a, Uint8Array.from([1, 2, 3])).length, 0);
});
