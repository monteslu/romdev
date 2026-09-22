// The m68k cycle table and control classifier.
//
// Both halves have already produced a wrong answer once each, so both are
// asserted here rather than spot-checked by hand:
//   - `rts` was classified as an ordinary transfer, because the size-suffix
//     stripper turned it into `rt`. A recompiler would have fallen through a
//     return.
//   - a 0 entry means "no such opcode", NOT "free". Reporting 0 as a cost
//     makes a scanline budget silently wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { m68kCycles, m68kControl, M68K_CYCLE_PROVENANCE } from "../src/analysis/recompile/m68k-metadata.js";

const w = (op) => Buffer.from([(op >> 8) & 0xff, op & 0xff]);

test("cycles come from gpgx, not a datasheet", () => {
  assert.equal(M68K_CYCLE_PROVENANCE.source, "gpgx m68ki_cycles.h");
  assert.equal(M68K_CYCLE_PROVENANCE.entries, 0x10000);
});

test("documented timings", () => {
  assert.equal(m68kCycles(w(0x4e71)), 4, "nop");
  assert.equal(m68kCycles(w(0x4e75)), 16, "rts");
  assert.equal(m68kCycles(w(0x2200)), 4, "move.l d0,d1");
});

test("unknown opcodes are null, never 0", () => {
  // Find a genuinely absent entry and confirm it reports unknown rather than
  // a free instruction.
  let found = null;
  for (let op = 0; op < 0x10000; op++) {
    if (m68kCycles(w(op)) === null) { found = op; break; }
  }
  assert.notEqual(found, null, "expected at least one illegal opcode word");
  assert.equal(m68kCycles(w(found)), null);
});

test("control flow: returns are returns", () => {
  for (const m of ["rts", "rte", "rtr"]) {
    const r = m68kControl(m, "", 0, 2);
    assert.equal(r.kind, "ret", `${m} must classify as ret`);
    assert.equal(r.fallthrough, null, `${m} must not fall through`);
  }
});

test("control flow: calls, jumps, conditional branches", () => {
  assert.equal(m68kControl("jsr", "0x400", 0, 4).kind, "call");
  assert.equal(m68kControl("bsr", "0x40", 0, 2).kind, "call");
  assert.equal(m68kControl("braw", "0xc", 0, 4).kind, "jump");
  assert.equal(m68kControl("jmp", "0x400", 0, 4).kind, "jump");
  for (const m of ["beqs", "bnes", "bls", "bcs", "bvs", "bmi", "bges"]) {
    const r = m68kControl(m, "0x20", 0, 2);
    assert.equal(r.kind, "branch", `${m}`);
    assert.equal(r.conditional, true, `${m} is conditional`);
    assert.equal(r.fallthrough, 2, `${m} falls through`);
  }
});

test("control flow: dbcc decrements and branches", () => {
  const r = m68kControl("dbra", "0x10", 0, 4);
  assert.equal(r.kind, "branch");
  assert.equal(r.conditional, true);
});

test("ordinary instructions fall through with no target", () => {
  const r = m68kControl("movel", "%d0,%d1", 0, 2);
  assert.equal(r.kind, "transfer");
  assert.equal(r.fallthrough, 2);
  assert.deepEqual(r.targets, []);
});
