// Reference-vector tests for the Game Genie decoders. Each vector is a
// PUBLISHED, authoritative decode — if one of these ever fails, the decoder
// drifted and would emit WRONG addresses (worse than no label), so these are
// the trust anchors for the whole cheat-DB feature.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeRaw,
  decodeNesGameGenie,
  decodeGenesisGameGenie,
  decodeGbGameGenie,
  decodeCode,
  encodeNesGameGenie,
  encodeGenesisGameGenie,
  encodeGbGameGenie,
  encodeCode,
  encodeRaw,
} from "romdev-core-host/gamegenie.js";

test("decodeRaw parses ADDR:VAL and ADDR:VAL:COMPARE", () => {
  assert.deepEqual(decodeRaw("00C7:FF"), { address: 0x00c7, value: 0xff });
  assert.deepEqual(decodeRaw("1234:0A:5C"), { address: 0x1234, value: 0x0a, compare: 0x5c });
  assert.equal(decodeRaw("garbage"), null);
});

test("NES Game Genie: 6-char reference decodes (nesdev)", () => {
  // AAAAAA → $8000 = $00 (all-zero baseline)
  assert.deepEqual(decodeNesGameGenie("AAAAAA"), { address: 0x8000, value: 0x00 });
  // SXIOPO → $91D9 = $AD  (a widely-published reference code)
  assert.deepEqual(decodeNesGameGenie("SXIOPO"), { address: 0x91d9, value: 0xad });
});

test("NES Game Genie: 8-char form yields a compare byte", () => {
  const r = decodeNesGameGenie("SXUZXTSA"); // 8-char form = ROM address + compare byte
  assert.ok(r && typeof r.compare === "number", "8-char decodes a compare byte");
  assert.ok(r.address >= 0x8000, "address in PRG space");
});

test("NES Game Genie: rejects bad length / letters", () => {
  assert.equal(decodeNesGameGenie("ABC"), null);
  assert.equal(decodeNesGameGenie("ABCDE1"), null); // '1' not in GG alphabet
});

test("Genesis Game Genie: verbatim Genesis-Plus-GX decode_cheat", () => {
  // AAAA-AAAA → all zero (baseline from the core's own letter table).
  assert.deepEqual(decodeGenesisGameGenie("AAAA-AAAA"), { address: 0, value: 0 });
  // Real published code decodes into ROM address space + a 16-bit word value.
  const r = decodeGenesisGameGenie("AJ9T-CA5Y");
  assert.equal(r.address, 0x13f74);
  assert.equal(r.value, 0x6002);
});

test("Game Boy Game Genie: devrs reference worked example", () => {
  // 0A1-B9F → reorder D E F C = B 9 F 1, complement high nibble B→4 → $49F1, value $0A
  assert.deepEqual(decodeGbGameGenie("0A1B9F"), { address: 0x49f1, value: 0x0a });
});

test("Game Boy Game Genie: 9-digit form carries a compare byte", () => {
  const r = decodeGbGameGenie("010-CE9-19E");
  assert.ok(r && typeof r.compare === "number", "9-digit decodes a compare");
});

// ── Encoders (cheat CREATION) — the inverse, round-trip verified ──────────
const eq = (a, b) => a.address === b.address && a.value === b.value &&
  ((a.compare == null && b.compare == null) || a.compare === b.compare);

test("encodeNesGameGenie round-trips (decode∘encode = identity on values)", () => {
  for (const p of [
    { address: 0x91d9, value: 0xad },
    { address: 0x8e20, value: 0xa5, compare: 0x85 },
    { address: 0xffff, value: 0xff },
    { address: 0x8000, value: 0x00 },
  ]) {
    const code = encodeNesGameGenie(p);
    assert.ok(code, "encoded");
    assert.ok(eq(decodeNesGameGenie(code), p), `NES round-trip ${JSON.stringify(p)} → ${code}`);
  }
});

test("encodeGenesisGameGenie round-trips", () => {
  for (const p of [{ address: 0x13f74, value: 0x6002 }, { address: 0, value: 0 }, { address: 0x1fffff, value: 0xabcd }]) {
    const code = encodeGenesisGameGenie(p);
    assert.ok(code && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), `shape ${code}`);
    assert.ok(eq(decodeGenesisGameGenie(code), p), `GEN round-trip ${JSON.stringify(p)} → ${code}`);
  }
});

test("encodeGbGameGenie round-trips (6- and 9-digit)", () => {
  for (const p of [{ address: 0x49f1, value: 0x0a }, { address: 0x0002, value: 0xff, compare: 0x3c }]) {
    const code = encodeGbGameGenie(p);
    assert.ok(code, "encoded");
    assert.ok(eq(decodeGbGameGenie(code), p), `GB round-trip ${JSON.stringify(p)} → ${code}`);
  }
});

test("encodeRaw formats ADDR:VAL[:COMPARE], padding the address to a binding width", () => {
  // The address is padded to >=4 hex digits: a short `AA:VV` RAM code is INERT on
  // libretro cores (parses but never pokes), so a zero-page address MUST be 4
  // digits to actually bind. See encodeRaw's doc.
  assert.equal(encodeRaw({ address: 0x00c7, value: 0xff }), "00C7:FF");
  assert.equal(encodeRaw({ address: 0x32, value: 0x09 }), "0032:09");
  assert.equal(encodeRaw({ address: 0x1234, value: 0x0a, compare: 0x5c }), "1234:0A:5C");
  // ROM/16-bit addresses are already 4 digits → unchanged; wide addresses keep
  // their width (rounded to an even digit count).
  assert.equal(encodeRaw({ address: 0x8000, value: 0x09 }), "8000:09");
  assert.equal(encodeRaw({ address: 0xff1234, value: 0x09 }), "FF1234:09");
});

test("encodeCode style + platform dispatch, always round-trips", () => {
  // gamegenie style on NES → letter code that decodes back.
  const gg = encodeCode({ address: 0x91d9, value: 0xad }, "nes", "gamegenie");
  assert.ok(eq(decodeCode(gg, "nes"), { address: 0x91d9, value: 0xad }));
  // raw style → ADDR:VAL on any platform (address padded to a binding width).
  assert.equal(encodeCode({ address: 0x00c7, value: 0xff }, "snes", "raw"), "00C7:FF");
  // platform with no GG scheme falls back to raw.
  assert.ok(encodeCode({ address: 0x10, value: 1 }, "sms").includes(":"));
});

// ── Device detection + the non-Game-Genie devices ────────────────────────
test("decodeWithDevice labels the cheat device per platform", async () => {
  const { decodeWithDevice } = await import("romdev-core-host/gamegenie.js");
  assert.equal(decodeWithDevice("SXIOPO", "nes").device, "game-genie");
  assert.equal(decodeWithDevice("00C7:FF", "nes").device, "raw");
  assert.equal(decodeWithDevice("7E0DBF63", "snes").device, "pro-action-replay");
  assert.equal(decodeWithDevice("DDC2-64A7", "snes").device, "game-genie");
  assert.equal(decodeWithDevice("0102CBC0", "gb").device, "gameshark");
  assert.equal(decodeWithDevice("0A1-B9F", "gb").device, "game-genie");
});

test("SNES Pro Action Replay decodes AAAAAAVV (no scramble)", async () => {
  const { decodeProActionReplay } = await import("romdev-core-host/gamegenie.js");
  assert.deepEqual(decodeProActionReplay("7E0DBF63", "snes"), { address: 0x7e0dbf, value: 0x63 });
});

test("SNES Game Genie descrambles (snes9x alphabet), round-trips", async () => {
  const { decodeSnesGameGenie, encodeSnesGameGenie } = await import("romdev-core-host/gamegenie.js");
  const d = decodeSnesGameGenie("D3E6-E4A4");
  assert.ok(d && d.address != null);
  // It's a SCRAMBLE, not raw hex — must not equal the naive hex slice.
  assert.notEqual(d.address, 0xd3e6e4);
  // Round-trip.
  const code = encodeSnesGameGenie(d);
  assert.deepEqual(decodeSnesGameGenie(code), d);
});

test("GB GameShark decodes TTVVAAAA (LE address), round-trips", async () => {
  const { decodeGbGameShark, encodeGbGameShark } = await import("romdev-core-host/gamegenie.js");
  const d = decodeGbGameShark("0102CBC0");
  assert.equal(d.value, 0x02);
  assert.equal(d.address, 0xc0cb); // little-endian
  assert.deepEqual(decodeGbGameShark(encodeGbGameShark(d)), d);
});

test("encodeForDevice labels what it produced + nativeDevicesFor", async () => {
  const { encodeForDevice, nativeDevicesFor } = await import("romdev-core-host/gamegenie.js");
  assert.deepEqual(nativeDevicesFor("snes"), ["pro-action-replay", "game-genie"]);
  assert.deepEqual(nativeDevicesFor("gb"), ["game-genie", "gameshark"]);
  const par = encodeForDevice({ address: 0x7e0dbf, value: 0x63 }, "snes", "pro-action-replay");
  assert.equal(par.device, "pro-action-replay");
  assert.equal(par.code, "7E0DBF63");
  const gg = encodeForDevice({ address: 0x91d9, value: 0xad }, "nes");
  assert.equal(gg.device, "game-genie");
});

test("decodeCode dispatches by platform and falls back on raw", () => {
  // ADDR:VAL always wins regardless of platform.
  assert.deepEqual(decodeCode("00C7:FF", "nes"), { address: 0x00c7, value: 0xff });
  // Letter code routes to the platform decoder.
  assert.deepEqual(decodeCode("SXIOPO", "nes"), { address: 0x91d9, value: 0xad });
  // gbc shares the GB decoder.
  assert.deepEqual(decodeCode("0A1B9F", "gbc"), { address: 0x49f1, value: 0x0a });
  // A letter code on a platform with no decoder → null (skipped, not guessed).
  assert.equal(decodeCode("SXIOPO", "snes"), null);
});
