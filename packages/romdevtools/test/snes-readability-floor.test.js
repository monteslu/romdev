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
//
// The span path + speculative gap recovery is CROSS-SYSTEM: it runs for every
// cc65-family platform, not just SNES. The 6502 cases at the bottom guard that
// nes/c64/atari/pce/lynx/gametank get the code/data split + gap recovery too
// (they skip the M/X width machinery, which is 65816-only).

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
  emit(0xC2, 0x30);       // rep #$30      → A + X/Y 16-bit
  emit(0xA9, 0x34, 0x12); // lda #$1234    (16-bit immediate — width tracking must catch this)
  emit(0xE2, 0x20);       // sep #$20      → A 8-bit again
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

test("SNES 65816: M/X width is tracked through rep/sep (a 16-bit immediate after `rep` decodes at full width)", async () => {
  const { bytes, spans } = buildRegion();
  const r = await reassembleForPlatform({ platform: "snes", bytes, startAddress: 0x8000, codeSpans: spans });

  assert.equal(r.ok, true, `expected byte-exact, got note: ${r.note}`);
  // After `rep #$30`, `A9 34 12` is `lda #$1234` (3 bytes, 16-bit A). Without
  // width tracking da65 decodes `lda #$34` (8-bit) + a spurious op — the exact
  // desync Jay reported. The 16-bit immediate proves the tracker widened A.
  assert.match(r.source, /\blda\b\s+#\$1234\b/i, "16-bit `lda #$1234` after `rep #$30` did not decode — width desync regressed");
  // And after `sep #$20`, the following `lda #$56` must be 8-bit again.
  assert.match(r.source, /\blda\b\s+#\$56\b/i, "8-bit `lda #$56` after `sep #$20` did not decode — width did not re-narrow");
});

test("SNES 65816: width set by a rep SEVERAL instructions back is honored (full dataflow, not just the next op)", async () => {
  // rep #$30 widens A+X; then a run of non-immediate ops; THEN a width-dependent
  // immediate. The rep-only segmenter got the immediate right only if it was the
  // first thing after the rep — full per-instruction dataflow must carry the
  // width across the intervening ops.
  const bytes = [];
  const emit = (...b) => bytes.push(...b);
  emit(0xC2, 0x30);       // rep #$30      → A + X/Y 16-bit
  emit(0xEA);             // nop
  emit(0xEA);             // nop
  emit(0x18);             // clc
  emit(0x29, 0xFF, 0x00); // and #$00FF    (16-bit A — width was set 4 ops back)
  emit(0xA9, 0x34, 0x12); // lda #$1234    (16-bit A)
  emit(0x6B);             // rtl
  while (bytes.length < 0x20) emit(0xEA);

  const r = await reassembleForPlatform({
    platform: "snes",
    bytes: new Uint8Array(bytes),
    startAddress: 0x8000,
    codeSpans: [{ start: 0, end: bytes.length }],
  });
  assert.equal(r.ok, true, `expected byte-exact, got note: ${r.note}`);
  assert.match(r.source, /\band\b\s+#\$00FF\b/i, "16-bit `and #$00FF` (width set several ops earlier) mis-decoded");
  assert.match(r.source, /\blda\b\s+#\$1234\b/i, "16-bit `lda #$1234` mis-decoded");
  assert.doesNotMatch(r.source, /\bbrk\b/i, "a `brk` misdecode survived — full width dataflow failed");
});

test("SNES 65816: a span ENTERED in 16-bit mode (no leading rep/sep) infers its entry width", async () => {
  // A function whose caller left X in 16-bit mode, entered with NO leading
  // rep/sep to re-sync. `A2 00 00` is `ldx #$0000` (16-bit, 3 bytes); at the
  // default 8-bit entry it mis-decodes as `ldx #$00` + `brk` (00) + a shifted
  // stream. Entry-width inference (fewest brk/cop/wdm symptoms) must pick 16-bit
  // and decode `ldx #$0000` correctly.
  const bytes = [];
  const emit = (...b) => bytes.push(...b);
  emit(0xA2, 0x00, 0x00); // ldx #$0000   (16-bit index — the tell)
  emit(0x86, 0x80);       // stx $80
  emit(0x86, 0x82);       // stx $82
  emit(0xE2, 0x10);       // sep #$10     (X→8-bit, so the tail is unambiguous)
  emit(0xA2, 0x05);       // ldx #$05
  emit(0x6B);             // rtl
  while (bytes.length < 0x20) emit(0xEA); // nop pad

  const r = await reassembleForPlatform({
    platform: "snes",
    bytes: new Uint8Array(bytes),
    startAddress: 0x8000,
    codeSpans: [{ start: 0, end: bytes.length }],
  });
  assert.equal(r.ok, true, `expected byte-exact, got note: ${r.note}`);
  assert.match(r.source, /\bldx\b\s+#\$0000\b/i, "16-bit `ldx #$0000` at span entry did not decode — entry-width inference failed");
  assert.doesNotMatch(r.source, /\bbrk\b/i, "a `brk` misdecode survived — entry width was not inferred");
});

test("SNES 65816: a small reachable-code gap between two code spans is recovered (speculative decode)", async () => {
  // rizin misses code entered only via branches (a dispatch loop). Model that: a
  // real code routine that is NOT in the supplied code spans, sandwiched between
  // two spans that ARE. It must come out as instructions, not a `.byte` blob.
  const bytes = [];
  const emit = (...b) => bytes.push(...b);
  // span 1 (declared code)
  emit(0xE2, 0x20);       // sep #$20
  emit(0x60);             // rts
  const span1End = bytes.length;
  // GAP — real code, NOT declared (the "missed dispatch loop")
  const gapStart = bytes.length;
  emit(0xA9, 0x01);       // lda #$01
  emit(0x8D, 0x00, 0x21); // sta $2100
  emit(0x20); emit(bytes.length + 4 + 3 & 0xFF, 0x80); // jsr (to span2, low bytes approximate — value irrelevant to decode)
  emit(0x60);             // rts
  const gapEnd = bytes.length;
  // span 2 (declared code)
  const span2Start = bytes.length;
  emit(0xEA);             // nop
  emit(0x6B);             // rtl
  const span2End = bytes.length;
  while (bytes.length < 0x40) emit(0x00);

  const r = await reassembleForPlatform({
    platform: "snes",
    bytes: new Uint8Array(bytes),
    startAddress: 0x8000,
    codeSpans: [ { start: 0, end: span1End }, { start: span2Start, end: span2End } ],
  });
  void gapStart; void gapEnd;

  assert.equal(r.ok, true, `expected byte-exact, got note: ${r.note}`);
  // The gap's `sta $2100` must appear as an instruction — proof the gap was
  // speculatively decoded and kept (it round-tripped), not dumped as `.byte`.
  assert.match(r.source, /\bsta\b.*\$2100/i, "reachable-code gap was not recovered (still a `.byte` blob)");
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

// ── Cross-system: the span-based path + speculative gap recovery is NOT
// SNES-only. It runs for every cc65-family platform (6502: nes/c64/atari/pce/
// lynx/gametank). 6502 has no M/X width state, so the width machinery is a no-op
// there, but the code/data split + gap recovery apply. These guard that the 6502
// path stays byte-exact AND recovers reachable code the analysis engine missed.

test("6502 (NES): span-based reassembly is byte-exact and separates code from data", async () => {
  const bytes = [];
  const emit = (...b) => bytes.push(...b);
  emit(0xA9, 0x01);       // lda #$01
  emit(0x8D, 0x00, 0x20); // sta $2000
  emit(0x60);             // rts
  const codeEnd = bytes.length;
  for (let i = 0; i < 24; i++) emit((i * 11 + 7) & 0xFF); // data blob
  while (bytes.length < 0x30) emit(0x00);

  const r = await reassembleForPlatform({
    platform: "nes",
    bytes: new Uint8Array(bytes),
    startAddress: 0x8000,
    codeSpans: [{ start: 0, end: codeEnd }],
  });
  assert.equal(r.ok, true, `NES span reassembly must be byte-exact, got note: ${r.note}`);
  assert.match(r.source, /\bsta\b.*\$2000/i, "NES code span did not decode as instructions");
  assert.match(r.source, /\.byte/, "NES data blob was not emitted as `.byte`");
});

test("6502 (NES): a reachable-code gap between two code spans is recovered (cross-system gap decode)", async () => {
  // The gap is real code the analysis engine didn't mark as a function (entered
  // only via a branch). Same speculative-decode fix as SNES, on a 6502 core.
  const bytes = [];
  const emit = (...b) => bytes.push(...b);
  emit(0xA9, 0x01); emit(0x60);           // span 1: lda #$01 / rts
  const s1 = bytes.length;
  emit(0x8D, 0x34, 0x12); emit(0x60);     // GAP (real code): sta $1234 / rts
  const gapEnd = bytes.length;
  emit(0xEA); emit(0x60);                 // span 2: nop / rts
  const s2s = gapEnd, s2e = bytes.length;
  while (bytes.length < 0x30) emit(0x00);

  const r = await reassembleForPlatform({
    platform: "nes",
    bytes: new Uint8Array(bytes),
    startAddress: 0x8000,
    codeSpans: [{ start: 0, end: s1 }, { start: s2s, end: s2e }],
  });
  assert.equal(r.ok, true, `expected byte-exact, got note: ${r.note}`);
  assert.match(r.source, /\bsta\b.*\$1234/i, "6502 reachable-code gap was not recovered (still a `.byte` blob)");
});
