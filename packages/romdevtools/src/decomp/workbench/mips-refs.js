// mips-refs.js - resolve %hi/%lo address arithmetic and classify the words a
// shift moved.
//
// Two properties a generalized resolver has to model:
//   - Signed %lo wraps into %hi: IDO splits the low 16 bits off as a SIGNED
//     add immediate and folds the borrow into the high half, so %hi(addr) is
//     one greater than addr >> 16 whenever %lo(addr) is negative. An
//     insertion can move %lo across 0xFFF0/0x0000 while its paired lui
//     (correctly) does not move; the signed arithmetic keeps that legible.
//   - Value-first classification misattributes text: a %lo immediate that
//     moved by exactly the shift delta is numerically identical to a data
//     pointer. This module classifies by SECTION first, decoding a text word
//     before ever comparing its value.
//
// Everything reads raw big-endian words, never a disassembly: a shift census
// runs before a candidate compiles, often against bytes with no debug info.
//
// Plain JS ESM + JSDoc.

import { ValueError, sorted } from "./py.js";

export const OPCODE_J = 0x02;
export const OPCODE_JAL = 0x03;
export const OPCODE_LUI = 0x0F;
export const OPCODE_SPECIAL = 0x00;

const signed = (n) => (n > 0 ? `+${n}` : String(n));

/** The %hi(addr) field: the lui immediate IDO's assembler emits. */
export function hi16For(addr) {
  return Math.floor((addr + 0x8000) / 0x10000) & 0xFFFF;
}

/** The %lo(addr) field, as the signed value it arithmetically is. */
export function lo16For(addr) {
  const lo = addr & 0xFFFF;
  return lo >= 0x8000 ? lo - 0x10000 : lo;
}

/** Rebuild the 32-bit address one lui/%lo pair encodes. */
export function compose(hi, lo) {
  const signedLo = lo16For(lo & 0xFFFF);
  return ((((hi & 0xFFFF) * 0x10000) + signedLo) % 0x100000000 + 0x100000000) % 0x100000000;
}

/** value % 4: a "pointer" that is not a multiple of 4 cannot be one. */
export function alignment(value) {
  return ((value % 4) + 4) % 4;
}

/** What one 32-bit big-endian instruction word says about an address. */
export class WordRef {
  constructor({ kind, raw, opcode, rs = null, rt = null, imm16 = null, simm16 = null, target26 = null }) {
    Object.assign(this, { kind, raw, opcode, rs, rt, imm16, simm16, target26 });
    Object.freeze(this);
  }

  /** The full 32-bit jump target, or null off a non-jump word. */
  target({ region }) {
    if (this.target26 === null) return null;
    return (((region >>> 0) & 0xF0000000) >>> 0) + this.target26 * 4;
  }

  asDict() {
    return { kind: this.kind, raw: this.raw, opcode: this.opcode, rs: this.rs, rt: this.rt, imm16: this.imm16, simm16: this.simm16, target26: this.target26 };
  }
}

/** Classify one big-endian 32-bit word by its instruction shape. */
export function decodeWord(word) {
  word = word >>> 0;
  const opcode = word >>> 26;
  if (opcode === OPCODE_J || opcode === OPCODE_JAL) {
    return new WordRef({ kind: opcode === OPCODE_JAL ? "jal" : "j", raw: word, opcode, target26: word & 0x3FFFFFF });
  }
  if (opcode === OPCODE_LUI) {
    return new WordRef({ kind: "lui", raw: word, opcode, rt: (word >>> 16) & 0x1F, imm16: word & 0xFFFF });
  }
  if (opcode === OPCODE_SPECIAL) return new WordRef({ kind: "other", raw: word, opcode });
  const imm16 = word & 0xFFFF;
  return new WordRef({ kind: "imm16", raw: word, opcode, rs: (word >>> 21) & 0x1F, rt: (word >>> 16) & 0x1F, imm16, simm16: imm16 >= 0x8000 ? imm16 - 0x10000 : imm16 });
}

/** One named [lo, hi) window in the 32-bit address space. */
export class NamedRange {
  constructor(name, lo, hi) {
    if (typeof name === "object" && name !== null) ({ name, lo, hi } = name);
    Object.assign(this, { name, lo, hi });
    Object.freeze(this);
  }
}

/** One address or address range accepted as authentic, with why. */
export class WhitelistEntry {
  constructor({ lo, hi, reason }) {
    Object.assign(this, { lo, hi, reason });
    Object.freeze(this);
  }
  static exact(addr, { reason }) { return new WhitelistEntry({ lo: addr, hi: addr + 1, reason }); }
}

/** Named address windows plus an explain-away whitelist. */
export class RangeModel {
  constructor({ windows = [], whitelist = [] } = {}) {
    this.windows = Object.freeze([...windows]);
    this.whitelist = Object.freeze([...whitelist]);
    Object.freeze(this);
  }

  /** [window_name, whitelisted, reason] for one value; first window wins. */
  classifyValue(value) {
    let window = null;
    for (const c of this.windows) { if (c.lo <= value && value < c.hi) { window = c.name; break; } }
    for (const e of this.whitelist) if (e.lo <= value && value < e.hi) return [window, true, e.reason];
    return [window, false, null];
  }
}

/** The N64 CPU's fixed-mapping segments, in RangeModel priority order. */
export function defaultN64Windows() {
  return [
    new NamedRange("cart", 0xB0000000, 0xC0000000),
    new NamedRange("kseg1", 0xA0000000, 0xC0000000),
    new NamedRange("kseg0", 0x80000000, 0xA0000000),
    new NamedRange("segmented", 0x00000000, 0x08000000),
  ];
}

/** One [start, end) ROM-offset span and how its words should read. */
export class RegionSpec {
  constructor({ start, end, kind }) { Object.assign(this, { start, end, kind }); Object.freeze(this); }
}

/** One [start, end) ROM-offset span whose words are caller-generated. */
export class GeneratedSpec {
  constructor({ start, end, label }) { Object.assign(this, { start, end, label }); Object.freeze(this); }
}

/** One word whose value differs between the two images, and why. */
export class DifferingWord {
  constructor({ offset, old, new: nw, label }) { Object.assign(this, { offset, old, new: nw, label }); Object.freeze(this); }
  asDict() { return { offset: this.offset, old: this.old, new: this.new, label: this.label }; }
}

/** One word that did not move, but holds a value shaped like it should. */
export class StaleCandidate {
  constructor({ offset, value, alignment: al, window, whitelisted, reason }) {
    Object.assign(this, { offset, value, alignment: al, window, whitelisted, reason });
    Object.freeze(this);
  }
  asDict() { return { offset: this.offset, value: this.value, alignment: this.alignment, window: this.window, whitelisted: this.whitelisted, reason: this.reason }; }
}

/** The full paired-word classification of one base/shifted image pair. */
export class WordCensus {
  constructor({ delta, insertion_offset, total_words, counts, differing_total, unexplained_total, stale_total, unexplained, stale }) {
    Object.assign(this, { delta, insertion_offset, total_words, counts, differing_total, unexplained_total, stale_total, unexplained, stale });
    Object.freeze(this);
  }
  asDict() {
    return {
      delta: this.delta, insertion_offset: this.insertion_offset, total_words: this.total_words,
      counts: { ...this.counts }, differing_total: this.differing_total, unexplained_total: this.unexplained_total,
      stale_total: this.stale_total, unexplained: this.unexplained.map((x) => x.asDict()), stale: this.stale.map((x) => x.asDict()),
    };
  }
}

function classifyTextWord(old, nw, delta) {
  const opO = old >>> 26, opN = nw >>> 26;
  if (opO === opN && (opO === OPCODE_J || opO === OPCODE_JAL)) {
    if ((nw & 0x3FFFFFF) - (old & 0x3FFFFFF) === Math.floor(delta / 4)) return "j26-tracks";
  }
  if (opO === opN) {
    const immD = (nw & 0xFFFF) - (old & 0xFFFF);
    const topSame = (old >>> 16) === (nw >>> 16);
    if (opO === OPCODE_LUI && topSame && (immD === 1 || immD === -0xFFFF)) return "hi16-adjust";
    if (topSame && (immD === delta || immD === delta - 0x10000)) return "lo16-tracks";
  }
  if (nw - old === delta) return "abs32-tracks";
  return "unexplained";
}

function classifyValueWord(old, nw, delta) {
  return nw - old === delta ? "abs32-tracks" : "unexplained";
}

function spanLookup(spans) {
  const ordered = sorted(spans, (s) => s[0]);
  return [ordered.map((s) => s[0]), ordered];
}

function bisectRight(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x < arr[mid]) hi = mid; else lo = mid + 1; }
  return lo;
}

function labelAt(offset, starts, ordered) {
  const index = bisectRight(starts, offset) - 1;
  if (index >= 0 && offset < ordered[index][1]) return ordered[index][2];
  return null;
}

/** Refuse a pair whose size does not account for the declared delta. */
export function checkImageDelta(base, shifted, { delta }) {
  if (base.length % 4 || shifted.length % 4) throw new ValueError("both images must be a whole number of 32-bit words");
  if (shifted.length - base.length !== delta) {
    throw new ValueError(`shifted image is ${signed(shifted.length - base.length)} bytes longer than base, not the declared delta ${signed(delta)}`);
  }
}

/** Pair two images word-by-word and classify every difference. */
export function buildWordCensus(base, shifted, { insertion_offset, delta, regions = [], generated = [], default_kind = "data", moved_range = null, range_model = null, detail_cap = 60 }) {
  checkImageDelta(base, shifted, { delta });
  const [regionStarts, regionSpans] = spanLookup(regions.map((r) => [r.start, r.end, r.kind]));
  const [genStarts, genSpans] = spanLookup(generated.map((g) => [g.start, g.end, g.label]));
  const counts = new Map();
  const unexplained = [], stale = [];
  let staleTotal = 0;
  const bv = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const sv = Buffer.isBuffer(shifted) ? shifted : Buffer.from(shifted);
  const nWords = Math.floor(base.length / 4);
  for (let index = 0; index < nWords; index++) {
    const offset = index * 4;
    const so = offset >= insertion_offset ? offset + delta : offset;
    const old = bv.readUInt32BE(offset);
    const nw = sv.readUInt32BE(so);
    if (old === nw) {
      if (moved_range !== null && moved_range[0] <= old && old < moved_range[1]) {
        staleTotal += 1;
        if (stale.length < detail_cap) {
          let window = null, whitelisted = null, reason = null;
          if (range_model !== null) [window, whitelisted, reason] = range_model.classifyValue(old);
          stale.push(new StaleCandidate({ offset, value: old, alignment: alignment(old), window, whitelisted: !!whitelisted, reason }));
        }
      }
      continue;
    }
    let label = labelAt(offset, genStarts, genSpans);
    if (label === null) {
      const kind = labelAt(offset, regionStarts, regionSpans) || default_kind;
      label = (kind === "text" ? classifyTextWord : classifyValueWord)(old, nw, delta);
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (label === "unexplained" && unexplained.length < detail_cap) unexplained.push(new DifferingWord({ offset, old, new: nw, label }));
  }
  const sortedCounts = Object.fromEntries(sorted([...counts.entries()], (e) => e[0]));
  return new WordCensus({
    delta, insertion_offset, total_words: nWords, counts: sortedCounts,
    differing_total: [...counts.values()].reduce((a, b) => a + b, 0),
    unexplained_total: counts.get("unexplained") ?? 0, stale_total: staleTotal,
    unexplained: Object.freeze(unexplained), stale: Object.freeze(stale),
  });
}
export { classifyTextWord as _classifyTextWord };
