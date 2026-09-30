// literal-pool.js - resolve literal-pool accesses so symbol-naming density
// stops being evidence. `absolute`: both sides anchor on section symbols and
// sites agree iff (section kind, byte offset, width) agree.
// `anchor-correspondence`: at least one side names each literal, so what is
// checked is a one-to-one correspondence of anchors, site for site.
//
// Plain JS ESM + JSDoc.

export const SECTION_KINDS = Object.freeze({ ".rodata": "rodata", ".rdata": "rodata", ".srodata": "rodata", ".lit4": "rodata", ".lit8": "rodata",
  ".data": "data", ".sdata": "data", ".bss": "bss", ".sbss": "bss", ".text": "text" });

export const ACCESS_WIDTHS = Object.freeze({ lb: 1, lbu: 1, sb: 1, lh: 2, lhu: 2, sh: 2, ll: 4, lw: 4, lwc1: 4, lwl: 4, lwr: 4, lwu: 4, sc: 4, sw: 4,
  swc1: 4, swl: 4, swr: 4, ld: 8, ldc1: 8, ldl: 8, ldr: 8, sd: 8, sdc1: 8, sdl: 8, sdr: 8 });

const HIGH_KINDS = new Set(["R_MIPS_HI16"]);
const LOW_KINDS = new Set(["R_MIPS_LO16"]);
const DIRECT_KINDS = new Set(["R_MIPS_GPREL16", "R_MIPS_LITERAL"]);

export const ABSOLUTE = "absolute";
export const CORRESPONDENCE = "anchor-correspondence";
export const UNRESOLVED = "unresolved";
export const ACCESS = "access";
export const ANCHOR = "anchor";

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** One instruction's relocated reference into a data pool. */
export class PoolAccess {
  constructor({ index, role, section, anchor, offset, width }) { Object.assign(this, { index, role, section, anchor, offset, width }); Object.freeze(this); }
  get slot() { return [this.anchor, this.offset]; }
}

export class PoolComparison {
  constructor({ resolution, agreeing, differing, target_slots, candidate_slots }) {
    Object.assign(this, { resolution, agreeing, differing, target_slots, candidate_slots }); Object.freeze(this);
  }
  get slots_differ() { return this.target_slots !== this.candidate_slots; }
  asDict() { return { resolution: this.resolution, agreeing_sites: this.agreeing.size, differing_sites: this.differing.size, target_slots: this.target_slots, candidate_slots: this.candidate_slots }; }
}

export class PoolReport {
  constructor({ resolution, matches, layout_mismatches, target_slots, candidate_slots }) {
    Object.assign(this, { resolution, matches, layout_mismatches, target_slots, candidate_slots }); Object.freeze(this);
  }
}

const signed16 = (v) => (v & 0x8000 ? v - 0x10000 : v);

/** Every relocated data reference, keyed by instruction index (Map). */
export function poolAccesses(instructions) {
  const accesses = new Map();
  instructions.forEach((item, index) => {
    for (const r of item.relocations) {
      let role, offset, width;
      if (HIGH_KINDS.has(r.kind)) { role = ANCHOR; offset = 0; width = 0; }
      else if (LOW_KINDS.has(r.kind) || DIRECT_KINDS.has(r.kind)) {
        role = ACCESS; offset = signed16(item.word_value & 0xFFFF); width = own(ACCESS_WIDTHS, item.opcode) ? ACCESS_WIDTHS[item.opcode] : 0;
      } else continue;
      const symbol = r.symbol || "";
      accesses.set(index, new PoolAccess({ index, role, section: own(SECTION_KINDS, symbol) ? SECTION_KINDS[symbol] : null, anchor: symbol, offset, width }));
      break;
    }
  });
  return accesses;
}

const slotKey = (s) => JSON.stringify(s);
function slotCount(accesses) { return new Set([...accesses.values()].filter((a) => a.role === ACCESS).map((a) => slotKey(a.slot))).size; }

/** Whether two sites may be judged against each other at all. */
export function comparable(left, right) {
  if (left.role !== right.role) return false;
  return left.role === ACCESS || left.anchor !== right.anchor;
}

/** Decide, per aligned row, whether the two sides read the same slot. */
export function comparePoolAccesses(pairs, { target_accesses, candidate_accesses }) {
  const target_slots = slotCount(target_accesses), candidate_slots = slotCount(candidate_accesses);
  const accessPairs = pairs.filter((p) => p[1].role === ACCESS);
  if (!accessPairs.length) return new PoolComparison({ resolution: UNRESOLVED, agreeing: new Set(), differing: new Set(), target_slots, candidate_slots });
  const agreeing = new Set(), differing = new Set();
  const displacement = new Map();
  const setdefault = (m, k, v) => { if (!m.has(k)) m.set(k, v); return m.get(k); };
  const pairKey = (a, b) => JSON.stringify([a, b]);
  let resolution;
  if (accessPairs.every(([, l, r]) => l.section !== null && r.section !== null)) {
    for (const [row, l, r] of accessPairs) {
      if (l.section === r.section && l.offset === r.offset && l.width === r.width) { agreeing.add(row); setdefault(displacement, pairKey(l.anchor, r.anchor), 0); }
      else differing.add(row);
    }
    resolution = ABSOLUTE;
  } else {
    const forward = new Map(), backward = new Map();
    for (const [row, l, r] of accessPairs) {
      const delta = r.offset - l.offset;
      if (l.width !== r.width) differing.add(row);
      else if (l.anchor === r.anchor) (delta === 0 ? agreeing : differing).add(row);
      else if (setdefault(forward, slotKey(l.slot), slotKey(r.slot)) !== slotKey(r.slot)
        || setdefault(backward, slotKey(r.slot), slotKey(l.slot)) !== slotKey(l.slot)
        || setdefault(displacement, pairKey(l.anchor, r.anchor), delta) !== delta) differing.add(row);
      else agreeing.add(row);
    }
    resolution = CORRESPONDENCE;
  }
  for (const [row, l, r] of pairs) {
    if (l.role !== ANCHOR) continue;
    if (displacement.has(pairKey(l.anchor, r.anchor))) agreeing.add(row); else differing.add(row);
  }
  return new PoolComparison({ resolution, agreeing, differing, target_slots, candidate_slots });
}
