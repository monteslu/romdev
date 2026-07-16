// SNES (65816) readability floor — regression guard.
//
// disasm({target:'project'}) on a 65816 cart used to emit byte-exact but 0%
// READABLE output: every instruction floored to `.byte`. Three compounding bugs:
//   1. da65's `--comments 4` appends an ASCII gutter after the byte hex, and the
//      meta regex anchored the byte capture to end-of-line → it matched ZERO
//      code lines → the heal loop couldn't tell code from data → whole-region
//      `.byte` floor.
//   2. A single whole-region da65 pass let one span's `.a8/.i8` width state leak
//      across a data gap into the next span → operand widths wrong → cascade.
//   3. Data mis-decoded as code (rizin over-claiming a function) desynced the
//      stream with no bounded recovery.
// The fix disassembles each code span INDEPENDENTLY (re-seeding width per span),
// dumps the gaps as `.byte`, heals each span to byte-exact, and stitches. This
// suite asserts a mixed code+data 65816 region round-trips byte-exact AND stays
// readable (well above the old 0% floor) — so the floor can't silently return.

import { test } from "node:test";
import assert from "node:assert/strict";

import { reassembleForPlatform } from "../src/toolchains/common/reassemble.js";

// A tiny, self-contained 65816 region: real boot code, a data blob, then more
// code. Byte layout is deterministic so the code spans are exact.
function buildRegion() {
  const bytes = [];
  const emit = (...b) => bytes.push(...b);

  // ── code span A @ offset 0 (post-reset 8-bit A/X) ──
  emit(0x78);             // sei
  emit(0xD8);             // cld
  emit(0x18);             // clc
  emit(0xFB);             // xce           (native mode)
  emit(0xC2, 0x30);       // rep #$30
  emit(0xE2, 0x20);       // sep #$20
  emit(0xA9, 0x56);       // lda #$56      (8-bit immediate)
  emit(0xEA);             // nop
  emit(0x60);             // rts
  const codeAEnd = bytes.length;

  // ── data blob (must NOT be decoded as code) ──
  const dataStart = bytes.length;
  for (let i = 0; i < 32; i++) emit((i * 7 + 3) & 0xFF);
  const dataEnd = bytes.length;

  // ── code span B ──
  const codeBStart = bytes.length;
  emit(0xA2, 0x00, 0x00); // ldx #$0000
  emit(0xE8);             // inx
  emit(0x8D, 0x00, 0x21); // sta $2100
  emit(0x6B);             // rtl
  const codeBEnd = bytes.length;

  // pad the region out a little (trailing data)
  while (bytes.length < 0x80) emit(0x00);

  return {
    bytes: new Uint8Array(bytes),
    spans: [ { start: 0, end: codeAEnd }, { start: codeBStart, end: codeBEnd } ],
    dataStart, dataEnd,
  };
}

test("SNES 65816: a mixed code+data region reassembles BYTE-EXACT and stays readable (no 0% floor)", async () => {
  const { bytes, spans } = buildRegion();
  const r = await reassembleForPlatform({
    platform: "snes",
    bytes,
    startAddress: 0x8000,
    codeSpans: spans,
  });

  // Byte-exact is the hard contract.
  assert.equal(r.ok, true, `expected byte-exact round-trip, got note: ${r.note}`);
  assert.equal(r.bytes.length, bytes.length);

  // Readability must clear the old floor by a wide margin. The region is mostly
  // code by line count, so this should be high; assert >50% to catch any
  // regression back toward the `.byte` floor without being brittle.
  assert.ok(r.readablePercent > 50, `readable ${r.readablePercent}% — regressed toward the 0% floor`);

  // Real instructions must appear as mnemonics, not `.byte` — proving the code
  // spans were disassembled as code (the whole point). The boot sequence and the
  // second span's store are unambiguous.
  assert.match(r.source, /\bsei\b/i, "boot `sei` did not decode as code");
  assert.match(r.source, /\bxce\b/i, "boot `xce` did not decode as code");
  assert.match(r.source, /\bsta\b.*\$2100/i, "span B `sta $2100` did not decode as code");

  // The data blob must stay `.byte` (not mis-decoded as code): its first byte is
  // 0x03, and the source must carry a `.byte` line — the fix's data/code split.
  assert.match(r.source, /\.byte/, "data blob was not emitted as `.byte`");
});

test("SNES 65816: an all-data region emits clean `.byte` and is byte-exact (empty code map)", async () => {
  // No code spans → the whole region is data.
  const bytes = new Uint8Array(64);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 5) & 0xFF;

  const r = await reassembleForPlatform({
    platform: "snes",
    bytes,
    startAddress: 0x8000,
    codeSpans: [], // empty = all data (distinct from null = "decode everything")
  });

  assert.equal(r.ok, true, `all-data region must be byte-exact, got note: ${r.note}`);
  assert.equal(r.readablePercent, 100, "an all-data region has no code lines → 100% trivially (0 of 0)");
  assert.ok(/\.byte/.test(r.source), "all-data region should be a `.byte` dump");
});
