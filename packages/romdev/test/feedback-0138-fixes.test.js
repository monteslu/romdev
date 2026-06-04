// Regression guards for the 2026-06-04 feedback batch (v0.1.37 session notes):
//  1. findEncodedText cpuAddress was a flat prgOffset+$8000 → wrong/overflowing
//     on banked NES; must report the real in-bank CPU address + bank.
//  2. A raw ADDR:VAL:COMPARE cheat on a ROM address must become the native
//     ROM-patch (Game Genie) code so the core installs a read-intercept.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nesFileOffsetToCpu } from "../src/mcp/tools/font-map.js";
import { decodeCode, encodeForDevice, nativeDevicesFor } from "../src/cheats/gamegenie.js";

// ── 1. NES banked cpuAddress ────────────────────────────────────────────────

test("nesFileOffsetToCpu: banked ROM byte maps to the in-bank CPU addr, not a +$8000 overflow", () => {
  // Rygar: mapper 2, 8 × 16KB PRG = 128KB. The feedback's byte: prg offset
  // 0xDE03 (raw .nes offset 0xDE13) → bank 3, CPU $9E03. The OLD code gave
  // $15E03 (0xDE03 + 0x8000) — a non-address > $FFFF.
  const prgSize = 8 * 16384;
  const r = nesFileOffsetToCpu(0xDE03 + 16, prgSize);
  assert.ok(r, "should map an in-PRG offset");
  assert.equal(r.bank, 3, "byte is in bank 3");
  assert.equal(r.cpuAddress, "$9E03", "in-bank CPU address (was $15E03)");
});

test("nesFileOffsetToCpu: the FIXED top bank maps to $C000-$FFFF", () => {
  const prgSize = 8 * 16384;
  // Last bank (bank 7) starts at prg offset 7*0x4000 = 0x1C000; offset +0x1234.
  const r = nesFileOffsetToCpu(0x1C000 + 0x1234 + 16, prgSize);
  assert.equal(r.bank, 7);
  assert.equal(r.cpuAddress, "$D234", "fixed top bank is at $C000 + inBank");
});

test("nesFileOffsetToCpu: NROM-128 (single bank) maps at $C000", () => {
  const r = nesFileOffsetToCpu(0x0010 + 0x0003, 16384); // prg offset 3
  assert.equal(r.bank, 0);
  assert.equal(r.cpuAddress, "$C003");
});

test("nesFileOffsetToCpu: offset outside PRG returns null", () => {
  assert.equal(nesFileOffsetToCpu(8, 16384), null);       // inside header
  assert.equal(nesFileOffsetToCpu(0x4010, 16384), null);  // past a 16KB PRG
});

// ── 2. raw ROM cheat → native device re-encode ──────────────────────────────

test("a raw ADDR:VAL:COMPARE on an NES ROM address re-encodes to the working Game Genie code", () => {
  // The exact feedback case: raw "C06C:0C:26" silently no-ops (treated as a RAM
  // poke), while the Game Genie "GATKGATX" of the SAME patch works. Confirm the
  // re-encode path produces GATKGATX so applyCheat can install a read-intercept.
  const raw = "C06C:0C:26";
  const decoded = decodeCode(raw, "nes");
  assert.deepEqual(
    { address: decoded.address, value: decoded.value, compare: decoded.compare },
    { address: 0xC06C, value: 0x0C, compare: 0x26 },
  );
  const dev = nativeDevicesFor("nes").find((d) => d !== "raw");
  const enc = encodeForDevice(decoded, "nes", dev);
  assert.equal(enc.device, "game-genie");
  assert.equal(enc.code, "GATKGATX", "re-encoded ROM patch matches the known-good GG code");
});
