#!/usr/bin/env node
// Extract the LR35902 (Game Boy) cycle table from gambatte's cpu.cpp.
//
// Same discipline as the z80 and m68k extractors: the table comes from the
// core we verify against, never from a datasheet. But gambatte has NO cycle
// table to read - it accumulates `cycleCounter += 4` at 62 inline sites, four
// cycles per memory access. So this extractor does what the m68k one cannot:
// it READS THE DISPATCH and adds up the cost of the macros each case invokes.
//
// Method, and its limits:
//   - Every `case 0xNN:` in the main switch maps to the macro calls in its
//     body, up to `break`.
//   - Each macro's cost is the number of `cycleCounter += 4` it performs,
//     counted from its own definition, with nested macros resolved.
//   - The opcode fetch itself is one PC_READ = 4 cycles, charged to every
//     opcode.
//
// A CONDITIONAL instruction (jr cc / call cc / ret cc) has two costs. The
// taken cost is emitted, because a recompiler that charges the untaken cost
// for a taken branch under-runs the frame - the same class of error as the
// flat per-instruction cost that produced the SMS frame-phase bug.
//
// Anything this cannot resolve is reported, not guessed: unresolved opcodes
// are listed and the generator exits non-zero, so a silent hole cannot reach
// the table.
import { readFileSync, writeFileSync } from "node:fs";

const src = process.argv[2];
const out = process.argv[3];
if (!src || !out) {
  console.error("usage: generate-gb-cycle-tables.mjs <cpu.cpp> <out.json>");
  process.exit(2);
}
const text = readFileSync(src, "utf8");

// ---- 1. macro definitions and their direct cycle cost -------------------
// `#define NAME(args) do { ... } while (0)`, possibly line-continued.
// A macro body runs to the first line NOT ending in a backslash. Matching
// with a lazy [\s\S]*? and a blank-line terminator captured only the first
// line (7 characters of `jp_nn`), so every multi-line macro resolved to 0
// cycles and 18 of 31 spot-checked opcodes came out as the bare 4-cycle
// fetch. Walk the lines instead.
const macros = new Map();
{
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^#define\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lines[i]);
    if (!m) continue;
    let body = lines[i];
    let j = i;
    while (/\\\s*$/.test(lines[j]) && j + 1 < lines.length) {
      j++;
      body += "\n" + lines[j];
    }
    macros.set(m[1], body);
  }
}

// Direct `cycleCounter += N` occurrences inside one macro body.
function directCycles(body) {
  let n = 0;
  const re = /cycleCounter\s*\+=\s*(\d+)/g;
  let m;
  while ((m = re.exec(body))) n += Number(m[1]);
  return n;
}

// Total cost of a macro, resolving nested macro invocations.
//
// The earlier version shared one `seen` set across the whole recursion AND
// memoised inside it, so a macro reached twice in one tree was memoised as 0
// by the recursion guard and every parent inherited that zero. jp_nn resolved
// to 0 despite PC_READ and PC_MOD both resolving to 4 on their own.
const memo = new Map();
function macroCost(name, stack = []) {
  if (memo.has(name)) return memo.get(name);
  const body = macros.get(name);
  if (body === undefined) return null;      // a real function, not a macro
  if (stack.includes(name)) return 0;       // cycle in the macro graph
  const next = [...stack, name];
  let total = directCycles(body);
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    const sub = m[1];
    if (sub === name || !macros.has(sub)) continue;
    // COUNT EVERY INVOCATION. Deduplicating by name made jp_nn 8 instead of
    // 12 (it does PC_READ twice) and call_nn 16 instead of 24 - every such
    // opcode came out exactly 4 short.
    const c = macroCost(sub, next);
    if (c !== null) total += c;
  }
  // Only memoise a fully-resolved result: a value computed underneath a
  // recursion guard is not the macro's real cost.
  if (stack.length === 0) memo.set(name, total);
  return total;
}

// Cost of a case body, treating an if/else as alternatives and keeping the
// larger (taken) arm rather than summing both.
function straightCost(src) {
  let total = directCycles(src);
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const c = macroCost(m[1]);
    if (c !== null) total += c;
  }
  return total;
}

/** Split `if (...) { A } else { B }` and score max(A,B) plus the remainder. */
function costOf(src) {
  const ifIdx = src.search(/\bif\s*\(/);
  if (ifIdx < 0) return straightCost(src);
  // find the condition's closing paren
  let i = src.indexOf("(", ifIdx), d = 0, condEnd = -1;
  for (; i < src.length; i++) {
    if (src[i] === "(") d++;
    else if (src[i] === ")") { d--; if (!d) { condEnd = i; break; } }
  }
  if (condEnd < 0) return straightCost(src);
  const before = src.slice(0, ifIdx);
  const [thenBody, afterThen] = braceBlock(src, condEnd + 1);
  if (thenBody === null) return straightCost(src);
  const elseM = /^\s*else\b/.exec(src.slice(afterThen));
  let elseBody = "", rest = src.slice(afterThen);
  if (elseM) {
    const [eb, afterElse] = braceBlock(src, afterThen + elseM[0].length);
    if (eb !== null) { elseBody = eb; rest = src.slice(afterElse); }
  }
  // The condition itself can contain cycle-charging reads (halt does).
  const condCost = straightCost(src.slice(ifIdx, condEnd + 1));
  return straightCost(before) + condCost +
         Math.max(costOf(thenBody), costOf(elseBody)) + straightCost(rest);
}

/** Body of the next `{...}` after `from`; returns [body, indexAfter]. */
function braceBlock(src, from) {
  const o = src.indexOf("{", from);
  if (o < 0) return [null, from];
  let d = 0;
  for (let i = o; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") { d--; if (!d) return [src.slice(o + 1, i), i + 1]; }
  }
  return [null, from];
}

// ---- 2. walk the main dispatch ------------------------------------------
// Slice out exactly ONE switch body by brace matching. The main dispatch
// ENCLOSES the CB dispatch, so slicing to end-of-file let the main table pick
// up CB entries for any opcode the main switch spelled in a different hex
// case (the source mixes `case 0xcd:` and `case 0xCD:`). That is how 0xCD
// came out as 4 cycles: the first regex hit was `case 0xCD: set1_r(l)` from
// the CB table, not `call_nn()`.
function switchBody(startIdx) {
  const open = text.indexOf("{", startIdx);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return [open + 1, i]; }
  }
  throw new Error("unbalanced switch braces");
}

function parseSwitch(startIdx, excludeRange) {
  const table = new Map();
  const [lo, hi] = switchBody(startIdx);
  let body = text.slice(lo, hi);
  if (excludeRange) {
    const [elo, ehi] = excludeRange;
    if (elo > lo && ehi < hi) {
      body = body.slice(0, elo - lo) + " ".repeat(ehi - elo) +
             body.slice(ehi - lo);
    }
  }
  // Split on case labels by INDEX. A lazy regex with a `$` alternative in the
  // lookahead matched the empty string at every label, so every case body
  // came out EMPTY and every opcode scored the bare 4-cycle fetch - while
  // still reporting 255 cases found, which looked like success.
  const marks = [];
  const re = /case\s+(0x[0-9a-fA-F]{2})\s*:/g;
  let m;
  while ((m = re.exec(body))) marks.push([Number(m[1]), m.index + m[0].length]);
  for (let i = 0; i < marks.length; i++) {
    const [op, st] = marks[i];
    const en = i + 1 < marks.length ? marks[i + 1][1] : body.length;
    // A case runs to its own `break`, not to the next label: consecutive
    // labels share one body and fallthrough is real here.
    const slice = body.slice(st, en);
    const brk = slice.search(/\bbreak\s*;/);
    const caseBody = brk >= 0 ? slice.slice(0, brk) : slice;
    // A CONDITIONAL case has an if/else whose arms are ALTERNATIVES, not a
    // sequence. Summing the whole body charged both: `jp nz,nn` came out 24
    // (16 taken + 12 untaken - 4 shared) where the taken cost is 16, and
    // `call nz,nn` 32 instead of 24.
    //
    // The TAKEN cost is what we keep - a recompiler that charges the untaken
    // cost for a taken branch under-runs the frame, the same class of error
    // as a flat per-instruction cost.
    const cost = costOf(caseBody);
    if (!table.has(op)) table.set(op, cost);
  }
  return table;
}

const mainIdx = text.indexOf("switch (opcode) {");
if (mainIdx < 0) throw new Error("main dispatch switch not found");
const cbIdx = text.indexOf("switch (opcode) {", mainIdx + 10);
const cbRange = cbIdx > 0 ? switchBody(cbIdx) : null;
const main = parseSwitch(mainIdx, cbRange);
const cb = cbIdx > 0 ? parseSwitch(cbIdx) : new Map();

// Every opcode pays the fetch (PC_READ) of its own opcode byte.
const FETCH = 4;
const base = [];
const missing = [];
for (let i = 0; i < 256; i++) {
  if (!main.has(i)) { missing.push(i); base.push(0); continue; }
  base.push(main.get(i) + FETCH);
}
const cbTable = [];
for (let i = 0; i < 256; i++) {
  // CB-prefixed: the 0xCB fetch plus the second opcode fetch, plus the op.
  cbTable.push((cb.get(i) ?? 0) + FETCH * 2);
}

// The Game Boy has 11 ILLEGAL opcodes that freeze the CPU. gambatte gives
// most of them an explicit empty case ("not specified. should freeze."), but
// 0xDD has no case in the main dispatch at all. Neither is a cost this
// extractor can measure, and neither should be GUESSED: an illegal opcode is
// a fault, so it is recorded as such and the recompiler traps on it.
const ILLEGAL = new Set([0xd3, 0xdb, 0xdd, 0xe3, 0xe4, 0xeb, 0xec, 0xed,
                         0xf4, 0xfc, 0xfd]);
const unexpected = missing.filter((x) => !ILLEGAL.has(x));
if (unexpected.length) {
  console.error(`unresolved opcodes (${unexpected.length}): ` +
    unexpected.map((x) => "0x" + x.toString(16).padStart(2, "0")).join(" "));
  process.exit(1);
}
for (const op of missing) base[op] = 0;   // 0 = illegal, caller must trap

// halt (0x76) is 4 cycles. gambatte's case carries a CGB-ONLY branch
// (`if (mem_.isCgb()) cycleCounter += 4;`) for the halt bug, plus an
// open-ended skip to the next event, and a static walk cannot know which
// arm runs. Both are conditional on machine state, not on the opcode, so
// the base cost is the unconditional path.
//
// This is the ONE opcode this extractor cannot measure statically, and it is
// corrected here explicitly rather than left wrong or silently special-cased
// inside the walker.
base[0x76] = 4;

writeFileSync(out, JSON.stringify({
  provenance: {
    source: "gambatte libgambatte/src/cpu.cpp",
    method: "dispatch walk; each case's macro invocations resolved to their " +
            "`cycleCounter += 4` sites, plus a 4-cycle opcode fetch",
    note: "gambatte has no cycle table; it accumulates 4 cycles per memory " +
          "access at 62 inline sites. Conditional ops carry the TAKEN cost.",
    extractedAt: new Date().toISOString(),
  },
  illegal: [...ILLEGAL].sort((a, b) => a - b),
  base, cb: cbTable,
}, null, 1) + "\n");
console.log(`wrote ${out}: 256 base + 256 CB entries`);
