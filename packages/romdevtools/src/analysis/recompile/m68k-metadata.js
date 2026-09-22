// 68000 metadata over the EXISTING binutils m68k decoder - not a second
// decoder, and not a hand-authored table.
//
// Cycles are EXTRACTED from gpgx's own m68ki_cycles.h by
// scripts/generate-m68k-cycle-tables.mjs. That provenance is the point: a
// later "verified against gpgx" check is only meaningful because the table
// came from the core rather than from a datasheet someone retyped.
//
// The 68000 has no prefix bytes, so unlike Z80 this is one lookup on the full
// 16-bit opcode word.
import data from "./m68k-cycle-tables.json" with { type: "json" };

export const M68K_CYCLE_PROVENANCE = {
  source: data.source,
  unit: "68000 cycles",
  note: data.note,
  entries: data.entries,
};

/**
 * Cycles for the instruction whose first word is bytes[0..1] (big-endian).
 * Returns null when the opcode word is not a legal instruction, which the
 * caller must treat as "unknown", never as zero.
 */
export function m68kCycles(bytes) {
  if (bytes.length < 2) return null;
  const op = (bytes[0] << 8) | bytes[1];
  const c = data.cycles[op];
  // 0 in gpgx's table means "no such opcode", not "free". Reporting it as a
  // real cost would make a recompiler's scanline budget silently wrong.
  // Note 0x4AFC (the ILLEGAL instruction) legitimately stores 4 - that is its
  // exception-entry cost, and it IS a real opcode.
  return c > 0 ? c : null;
}

// Control-flow classification. The recompiler needs kind/targets/fallthrough/
// conditional; it lowers from mnemonic+ops itself and does not need flags.
const BRANCH_CC = new Set([
  "bhi", "bls", "bcc", "bcs", "bne", "beq", "bvc", "bvs",
  "bpl", "bmi", "bge", "blt", "bgt", "ble",
]);

// Mnemonics that must NOT be suffix-stripped: the trailing letter is part of
// the name, not a size. Stripping turned `rts` into `rt` and classified a
// return as an ordinary transfer - caught by the module's own self-test, which
// is why that test asserts on rts specifically.
const WHOLE = new Set(["rts", "rte", "rtr", "bls", "bcs", "bvs", "bmi", "jsr", "bsr"]);

/** Strip binutils' size suffix: beqs/beqw/beql -> beq, movel -> move. */
function baseMnem(m) {
  if (WHOLE.has(m)) return m;
  return m.replace(/(s|w|l|b)$/, "");
}

export function m68kControl(mnem, ops, addr, len) {
  const m = (mnem || "").toLowerCase();
  const b = baseMnem(m);
  const next = addr + len;
  const target = () => {
    const t = /(?:^|[\s,])0x([0-9a-f]+)/i.exec(ops || "");
    return t ? [parseInt(t[1], 16)] : [];
  };
  if (b === "bra" || m.startsWith("bra")) {
    return { kind: "jump", targets: target(), fallthrough: null, conditional: false };
  }
  if (b === "bsr" || m.startsWith("bsr")) {
    return { kind: "call", targets: target(), fallthrough: next, conditional: false };
  }
  if (BRANCH_CC.has(b)) {
    return { kind: "branch", targets: target(), fallthrough: next, conditional: true };
  }
  if (b === "jmp") {
    return { kind: "jump", targets: target(), fallthrough: null, conditional: false };
  }
  if (b === "jsr") {
    return { kind: "call", targets: target(), fallthrough: next, conditional: false };
  }
  if (b === "rts" || b === "rte" || b === "rtr") {
    return { kind: "ret", targets: [], fallthrough: null, conditional: false };
  }
  // dbcc: decrement-and-branch, always conditional, always falls through.
  if (m.startsWith("db")) {
    return { kind: "branch", targets: target(), fallthrough: next, conditional: true };
  }
  return { kind: "transfer", targets: [], fallthrough: next, conditional: false };
}
