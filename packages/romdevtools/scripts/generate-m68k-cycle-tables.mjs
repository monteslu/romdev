#!/usr/bin/env node
// Extract the 68000 cycle table from gpgx's own m68ki_cycles.h.
//
// Same discipline as generate-z80-cycle-tables.mjs: the table is EXTRACTED from
// the core we verify against, never hand-authored from a datasheet. That is
// what makes a later "0 differences" check meaningful rather than circular.
//
// Source form: `static const unsigned char m68ki_cycles[0x10000] = { 8*7, ... }`
// indexed by the full 16-bit opcode word. The `*7` is gpgx's internal clock
// scaling (its master clock runs 7x the 68k cycle), so we divide it back out
// and store real 68000 cycles.
import { readFileSync, writeFileSync } from "node:fs";

const src = process.argv[2];
const out = process.argv[3];
if (!src || !out) {
  console.error("usage: generate-m68k-cycle-tables.mjs <m68ki_cycles.h> <out.json>");
  process.exit(2);
}

const text = readFileSync(src, "utf8");
const open = text.indexOf("{");
const close = text.lastIndexOf("}");
if (open < 0 || close < 0) throw new Error("no brace-delimited table found");

const body = text.slice(open + 1, close);
const cycles = [];
for (const tok of body.split(",")) {
  const t = tok.trim();
  if (!t) continue;
  const m = /^(\d+)\s*\*\s*(\d+)$/.exec(t) || /^(\d+)$/.exec(t);
  if (!m) throw new Error(`unparsable table entry: ${JSON.stringify(t)}`);
  const raw = Number(m[1]);
  const scale = m[2] ? Number(m[2]) : 1;
  if (scale !== 7 && scale !== 1) throw new Error(`unexpected scale ${scale}`);
  cycles.push(raw);
}

if (cycles.length !== 0x10000) {
  throw new Error(`expected 65536 entries, parsed ${cycles.length}`);
}

// Sanity, not trust: spot-check opcodes whose timings are documented and
// stable. nop=4, rts=16, move.l d0,d1=4. If gpgx ever restructures the table
// these fail loudly instead of silently shipping wrong timing.
const CHECKS = [[0x4e71, 4, "nop"], [0x4e75, 16, "rts"], [0x2200, 4, "move.l d0,d1"]];
for (const [op, want, name] of CHECKS) {
  if (cycles[op] !== want) {
    throw new Error(`${name} (0x${op.toString(16)}) = ${cycles[op]}, expected ${want}`);
  }
}

const nonzero = cycles.filter((c) => c > 0).length;
writeFileSync(out, JSON.stringify({
  isa: "m68k",
  source: "gpgx m68ki_cycles.h",
  note: "real 68000 cycles; gpgx's *7 master-clock scaling divided out",
  entries: 0x10000,
  nonzero,
  cycles,
}));
console.log(`  m68k cycles: ${cycles.length} entries, ${nonzero} nonzero, ${CHECKS.length} spot-checks passed -> ${out}`);
