// 6502 decoder + cycle metadata.
//
// The decoder is pure JS because binutils has NO 6502 target and da65 is a
// whole-file disassembler that cannot be asked for one instruction at a given
// offset without a per-offset flood. That makes it OUR decoder, so it is
// checked against da65's output on a real ROM rather than trusted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeOne, decodeLinear } from "../src/analysis/recompile/decode-6502.js";
import { m6502Cycles, m6502Control, M6502_CYCLE_PROVENANCE }
  from "../src/analysis/recompile/m6502-metadata.js";

const b = (...xs) => Buffer.from(xs);

test("cycle costs match documented 6502 timings", () => {
  const known = { 0x00: 7, 0xa9: 2, 0xad: 4, 0x8d: 4, 0x20: 6, 0x60: 6,
                  0x4c: 3, 0x6c: 5, 0xea: 2, 0x9a: 2, 0xa2: 2, 0x78: 2,
                  0xd8: 2, 0xbd: 4, 0x99: 5, 0xe8: 2, 0xca: 2 };
  for (const [op, want] of Object.entries(known)) {
    assert.equal(m6502Cycles(b(Number(op), 0, 0)), want,
      `opcode 0x${Number(op).toString(16)}`);
  }
});

test("every opcode's byte count equals its declared length", () => {
  // The length used to live in a SEPARATE table from the addressing mode, and
  // the two drifted: LEN said 1 for opcodes the mode table decoded as
  // immediate, so a truncation guard passed with one byte and rendering the
  // operand read undefined. Length is now derived from the mode.
  for (let op = 0; op < 256; op++) {
    const r = decodeOne(b(op, 0x34, 0x12), 0, 0x8000);
    assert.ok(r, `opcode 0x${op.toString(16)} decoded to null`);
    assert.equal(r.bytes.length, r.len,
      `opcode 0x${op.toString(16)}: ${r.bytes.length} bytes but len ${r.len}`);
  }
});

test("a truncated instruction decodes as data, not garbage", () => {
  assert.equal(decodeOne(b(0x4c), 0, 0x8000).mnemonic, ".byte");
  assert.equal(decodeOne(b(0xa9), 0, 0x8000).mnemonic, ".byte");
  assert.equal(decodeOne(Buffer.alloc(0), 0, 0), null);
});

test("control flow: branches resolve against the NEXT pc", () => {
  assert.deepEqual(m6502Control(b(0xd0, 0xfe), 0x8000),
    { kind: "branch", target: 0x8000, fallsThrough: true });
  assert.deepEqual(m6502Control(b(0x4c, 0x34, 0x12), 0x8000),
    { kind: "jump", target: 0x1234, fallsThrough: false });
  assert.deepEqual(m6502Control(b(0x20, 0x00, 0x80), 0x8000),
    { kind: "call", target: 0x8000, fallsThrough: true });
  assert.equal(m6502Control(b(0x60), 0x8000).fallsThrough, false);
  assert.equal(m6502Control(b(0x6c), 0x8000).kind, "jump_indirect");
});

test("decodeLinear tiles a window with no gaps", () => {
  const rom = b(0x78, 0xd8, 0xa2, 0xff, 0x9a, 0xa9, 0x00, 0x8d, 0x00, 0x20);
  const rows = decodeLinear(rom, 0, rom.length, 0x8000);
  assert.deepEqual(rows.map((r) => r.mnem),
    ["sei", "cld", "ldx", "txs", "lda", "sta"]);
  // addresses advance by exactly each instruction's length
  let a = 0x8000;
  for (const r of rows) {
    assert.equal(r.addr, a);
    a += r.bytes.split(" ").length;
  }
});

test("provenance names fceumm", () => {
  assert.match(M6502_CYCLE_PROVENANCE.source, /fceumm/);
});
