// Z80 T-state cost model for the SMS/GG backend, from the mnemonic and
// operand text exactly as the IR index prints it.
//
// Conditional control flow has two costs (taken / not taken): cost() returns
// the pair and the emitter charges the difference on the branching arm.
// Figures are the Zilog UM0080 timing tables (the SMS adds no wait states),
// with the undocumented index-half forms checked against genesis_plus_gx's
// cc_xy table, which the Zilog manual does not cover.
//
// Ported from the earlier Python emitter's cycle tables; the WAT the backend emits depends on
// every value here, so it is kept rule for rule.
//
// Plain JS ESM + JSDoc.

const IDX = /^\((i[xy])[+-][^)]+\)$/;
const isidx = (t) => IDX.test(t);
const isxy = (t) => t === "ix" || t === "iy" || t === "ixh" || t === "ixl" || t === "iyh" || t === "iyl";

const R8 = new Set(["a", "b", "c", "d", "e", "h", "l"]);
const R16 = new Set(["bc", "de", "hl", "sp", "ix", "iy", "af"]);

const FIXED = {
  nop: 4, halt: 4, di: 4, ei: 4, rlca: 4, rrca: 4, rla: 4, rra: 4, daa: 4, cpl: 4, scf: 4, ccf: 4,
  exx: 4, neg: 8, im: 8, rld: 18, rrd: 18, ldi: 16, ldd: 16, cpi: 16, cpd: 16, ini: 16, ind: 16,
  outi: 16, outd: 16, reti: 14, retn: 14, rst: 11,
};

/** Repeating block ops: 21 T for an iteration that repeats, 16 T for the last. */
const REPEAT = { ldir: [21, 16], lddr: [21, 16], cpir: [21, 16], cpdr: [21, 16], inir: [21, 16], indr: [21, 16], otir: [21, 16], otdr: [21, 16] };
const ALU8 = new Set(["add", "adc", "sub", "sbc", "and", "or", "xor", "cp"]);
const CB = new Set(["rlc", "rrc", "rl", "rr", "sla", "sra", "sll", "srl"]);

function alu8(o) {
  if (isidx(o)) return 19;
  if (o === "(hl)") return 7;
  if (R8.has(o)) return 4;
  if (isxy(o)) return 9;
  return 7;
}

function ld(o) {
  const d = o[0], s = o[1];
  if (isidx(d) || isidx(s)) return 19;
  if (R16.has(d) || R16.has(s)) {
    if (d === "sp" && s === "hl") return 6;
    if (d === "sp" && (s === "ix" || s === "iy")) return 10;
    if (d.startsWith("(") || s.startsWith("(")) {
      const reg = R16.has(d) ? d : s;
      if (reg === "hl") return 16;
      if (reg === "ix" || reg === "iy") return 20;
      return 20;
    }
    if (R16.has(d) && R16.has(s)) return 8;
    if (d === "ix" || d === "iy") return 14;
    return 10;
  }
  if (d === "a" && (s === "(bc)" || s === "(de)")) return 7;
  if ((d === "(bc)" || d === "(de)") && s === "a") return 7;
  if (d === "a" && s.startsWith("(") && s !== "(hl)") return 13;
  if (d.startsWith("(") && d !== "(hl)" && s === "a") return 13;
  if (d === "i" || d === "r" || s === "i" || s === "r") return 9;
  if (d === "(hl)" || s === "(hl)") {
    if (!R8.has(s) && d === "(hl)") return 10;
    return 7;
  }
  if (isxy(d) || isxy(s)) return (R8.has(d) || R8.has(s) || (isxy(d) && isxy(s))) ? 9 : 12;
  if (R8.has(d) && R8.has(s)) return 4;
  return 7;
}

function incdec(o) {
  if (isidx(o)) return 23;
  if (o === "(hl)") return 11;
  if (o === "ix" || o === "iy") return 10;
  if (R16.has(o)) return 6;
  if (isxy(o)) return 9;
  return 4;
}

/**
 * [taken, notTaken] T-states for one instruction.
 * @param {string} mnem
 * @param {string} ops
 * @returns {[number, number]}
 */
export function cost(mnem, ops) {
  const m = mnem.toLowerCase();
  const o = ops ? ops.split(",").map((x) => x.trim().toLowerCase()) : [];
  if (m === "djnz") return [13, 8];
  if (Object.hasOwn(FIXED, m)) return [FIXED[m], FIXED[m]];
  if (Object.hasOwn(REPEAT, m)) return REPEAT[m];
  if (m === "ld") { const c = ld(o); return [c, c]; }
  if (ALU8.has(m)) {
    if (o.length === 2 && R16.has(o[0])) {
      if (o[0] === "hl") return m === "add" ? [11, 11] : [15, 15];
      return [15, 15];
    }
    const c = alu8(o[o.length - 1]);
    return [c, c];
  }
  if (m === "inc" || m === "dec") { const c = incdec(o[0]); return [c, c]; }
  if (CB.has(m)) {
    const t = o[0];
    const c = isidx(t) ? 23 : t === "(hl)" ? 15 : 8;
    return [c, c];
  }
  if (m === "bit" || m === "res" || m === "set") {
    const t = o[o.length - 1];
    if (isidx(t)) return m === "bit" ? [20, 20] : [23, 23];
    if (t === "(hl)") return m === "bit" ? [12, 12] : [15, 15];
    return [8, 8];
  }
  if (m === "jp") {
    if (o.length === 1 && o[0].startsWith("(")) return o[0] === "(hl)" ? [4, 4] : [8, 8];
    return [10, 10];
  }
  if (m === "jr") return o.length === 1 ? [12, 12] : [12, 7];
  if (m === "call") return o.length === 1 ? [17, 17] : [17, 10];
  if (m === "ret") return o.length === 0 ? [10, 10] : [11, 5];
  if (m === "push") return (o[0] === "ix" || o[0] === "iy") ? [15, 15] : [11, 11];
  if (m === "pop") return (o[0] !== "ix" && o[0] !== "iy") ? [10, 10] : [14, 14];
  if (m === "ex") {
    if (o[0] === "(sp)") return o[1] === "hl" ? [19, 19] : [23, 23];
    return [4, 4];
  }
  if (m === "in" || m === "out") {
    if (o.length === 2 && (o[0] === "(c)" || o[1] === "(c)")) return [12, 12];
    return [11, 11];
  }
  if (m === "defb" || m === "db" || m === "nop*") return [4, 4];
  // Unknown mnemonic: the flat estimate, so a gap slows pacing slightly
  // instead of freezing the budget.
  return [4, 4];
}

/**
 * genesis_plus_gx's cost where it differs from the published table: INI/IND
 * charge their ex[] cycles unconditionally inside the macro (20 T), and
 * INIR/INDR add the repeat ex[] on top (25 T repeating, 20 T last).
 * @param {string} mnem
 * @param {string} ops
 * @returns {[number, number]}
 */
export function costExact(mnem, ops) {
  const m = mnem.toLowerCase();
  if (m === "ini" || m === "ind") return [20, 20];
  if (m === "inir" || m === "indr") return [25, 20];
  return cost(mnem, ops);
}
