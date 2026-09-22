// LR35902 (Game Boy) cycle + control metadata.
//
// The cycle table is EXTRACTED from gambatte by
// scripts/generate-gb-cycle-tables.mjs, so these assertions are a check on
// the EXTRACTOR, not a restatement of it: the expected values come from the
// documented LR35902 timings that every Game Boy reference agrees on, and
// they are independent of gambatte's source.
//
// This caught four real extractor bugs while it was being written: macro
// bodies truncated at the first line, the nested CB switch bleeding into the
// main table, case bodies coming back EMPTY from a lazy regex (while still
// reporting 255 cases found), and macro invocations deduplicated by name so
// `jp_nn` counted one PC_READ instead of two.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gbCycles, gbControl, GB_ILLEGAL, GB_CYCLE_PROVENANCE }
  from "../src/analysis/recompile/gb-metadata.js";

const b = (...xs) => Buffer.from(xs);

test("base cycle costs match documented LR35902 timings", () => {
  const known = {
    0x00: 4, 0x01: 12, 0x02: 8, 0x06: 8, 0x08: 20, 0x0a: 8, 0x18: 12,
    0x21: 12, 0x22: 8, 0x31: 12, 0x32: 8, 0x36: 12, 0x3e: 8, 0x40: 4,
    0x46: 8, 0x70: 8, 0x76: 4, 0x80: 4, 0x86: 8, 0xc1: 12, 0xc3: 16,
    0xc5: 16, 0xc9: 16, 0xcd: 24, 0xe0: 12, 0xe2: 8, 0xea: 16, 0xf0: 12,
    0xf9: 8, 0xfa: 16, 0xfe: 8,
  };
  for (const [op, want] of Object.entries(known)) {
    assert.equal(gbCycles(b(Number(op), 0, 0)), want,
      `opcode 0x${Number(op).toString(16)}`);
  }
});

test("ALU register ops are 4, (hl) forms are 8", () => {
  for (const base of [0x80, 0x88, 0x90, 0x98, 0xa0, 0xa8, 0xb0, 0xb8]) {
    for (let r = 0; r < 8; r++) {
      if (r === 6) assert.equal(gbCycles(b(base + r)), 8);
      else assert.equal(gbCycles(b(base + r)), 4);
    }
  }
});

test("CB-prefixed: 8 for registers, 16 for (hl), 12 for bit n,(hl)", () => {
  for (let i = 0; i < 256; i++) {
    const want = (i & 7) !== 6 ? 8 : (i >= 0x40 && i < 0x80 ? 12 : 16);
    assert.equal(gbCycles(b(0xcb, i)), want, `CB 0x${i.toString(16)}`);
  }
});

test("conditional ops carry the TAKEN cost, not the sum of both arms", () => {
  // gambatte writes these as if/else whose arms are ALTERNATIVES. Summing the
  // body charged both: jp nz,nn came out 24 where the taken cost is 16.
  const taken = {
    0x20: 12, 0x28: 12, 0x30: 12, 0x38: 12,   // jr cc,n
    0xc2: 16, 0xca: 16, 0xd2: 16, 0xda: 16,   // jp cc,nn
    0xc4: 24, 0xcc: 24, 0xd4: 24, 0xdc: 24,   // call cc,nn
    0xc0: 20, 0xc8: 20, 0xd0: 20, 0xd8: 20,   // ret cc
  };
  for (const [op, want] of Object.entries(taken)) {
    assert.equal(gbCycles(b(Number(op), 0, 0)), want,
      `conditional 0x${Number(op).toString(16)}`);
  }
});

test("illegal opcodes report null rather than an invented cost", () => {
  assert.equal(GB_ILLEGAL.size, 11);
  for (const op of GB_ILLEGAL) assert.equal(gbCycles(b(op)), null);
  // and a legal neighbour still resolves
  assert.equal(gbCycles(b(0xd2, 0, 0)), 16);
});

test("a truncated instruction reports null, not a wrong cost", () => {
  assert.equal(gbCycles(b(0xcb)), null);   // CB with no second byte
  assert.equal(gbCycles(Buffer.alloc(0)), null);
});

test("control flow: relative branches resolve against the NEXT pc", () => {
  // jr -2 at $150 targets $150 itself (the classic self-loop)
  assert.deepEqual(gbControl(b(0x18, 0xfe), 0x150),
    { kind: "jump", target: 0x150, fallsThrough: false });
  // jr nz,+4 at $200 -> $206, and it falls through
  assert.deepEqual(gbControl(b(0x20, 0x04), 0x200),
    { kind: "branch", target: 0x206, fallsThrough: true });
});

test("control flow: absolute, call, return, rst", () => {
  assert.deepEqual(gbControl(b(0xc3, 0x56, 0x01), 0x101),
    { kind: "jump", target: 0x156, fallsThrough: false });
  assert.deepEqual(gbControl(b(0xcd, 0x00, 0x20), 0x150),
    { kind: "call", target: 0x2000, fallsThrough: true });
  assert.equal(gbControl(b(0xc9), 0x150).kind, "return");
  assert.equal(gbControl(b(0xc9), 0x150).fallsThrough, false);
  // conditional ret DOES fall through
  assert.equal(gbControl(b(0xc0), 0x150).fallsThrough, true);
  // rst 38 -> $38
  assert.deepEqual(gbControl(b(0xff), 0x100),
    { kind: "call", target: 0x38, fallsThrough: true });
  // jp (hl) is indirect: no static target
  assert.equal(gbControl(b(0xe9), 0x150).kind, "jump_indirect");
});

test("provenance names gambatte and the extraction method", () => {
  assert.match(GB_CYCLE_PROVENANCE.source, /gambatte/);
  assert.match(GB_CYCLE_PROVENANCE.method, /dispatch|cycleCounter/);
});
