#!/usr/bin/env node
// Extract the 6502 cycle table from fceumm's own x6502.c.
//
// Same discipline as the z80/m68k/gb extractors: the table comes from the
// core romdev verifies against, never hand-authored from a datasheet.
//
// Source form: `static const uint8_t CycTable[256] = { ... }` with /*0xNN*/
// row comments. fceumm charges page-cross and branch-taken penalties
// separately at run time, so these are BASE costs.
import { readFileSync, writeFileSync } from "node:fs";

const src = process.argv[2], out = process.argv[3];
if (!src || !out) {
  console.error("usage: generate-6502-cycle-tables.mjs <x6502.c> <out.json>");
  process.exit(2);
}
const text = readFileSync(src, "utf8");
const i = text.indexOf("CycTable[256]");
if (i < 0) throw new Error("CycTable not found");
const open = text.indexOf("{", i), close = text.indexOf("};", open);
const body = text.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
const cycles = body.split(",").map((t) => t.trim()).filter(Boolean).map(Number);
if (cycles.length !== 256) {
  throw new Error(`expected 256 entries, parsed ${cycles.length}`);
}
if (cycles.some((c) => !Number.isInteger(c) || c < 2 || c > 8)) {
  throw new Error("entry outside the plausible 2..8 range");
}
writeFileSync(out, JSON.stringify({
  provenance: {
    source: "fceumm src/x6502.c CycTable[256]",
    method: "verbatim table extraction",
    note: "BASE costs; fceumm adds page-cross and branch-taken penalties " +
          "separately at run time.",
    extractedAt: new Date().toISOString(),
  },
  base: cycles,
}, null, 1) + "\n");
console.log(`wrote ${out}: 256 entries`);
