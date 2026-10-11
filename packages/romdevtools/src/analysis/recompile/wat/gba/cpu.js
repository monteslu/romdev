// ARM7TDMI instruction semantics for the GBA cart, ported from mGBA.
//
// Every handler here is a line-for-line port of the mGBA 0.11 handler of the
// same name (src/arm/isa-thumb.c, src/arm/isa-arm.c), INCLUDING ITS CYCLE
// ACCOUNTING. The decode (which handler an opcode selects) is mGBA's own table,
// expanded from emitter-arm.h / emitter-thumb.h by the C preprocessor into
// mgba-data.json (scripts/recompile-gen/gba-mgba.mjs), so an opcode can never
// be decoded differently here than in the reference.
//
// Frame-exact agreement with mGBA needs its exact per-instruction cycle
// counts (waitstates per region, prefetch, S/N/I); an approximate cost model
// drifts a frame or two within a minute of gameplay.
//
// A handler is generated for one of two contexts:
//
//   STATIC   the opcode is known at build time. Fields are JS numbers, so
//            decisions like "is rd the pc" are made by the generator and
//            vanish from the output.
//   DYNAMIC  the opcode is only known at run time (the interpreter). Fields
//            are WAT expressions over the local $op.
//
// Machine state (shared with sys.js):
//   REGS          r0-r15 in linear memory (4 bytes each); r15 holds what mGBA's
//                 gprs[ARM_PC] holds during an instruction: exec + 2*width.
//   $pc           address of the NEXT instruction to execute.
//   $n $z $c $v   flags (0/1). $ctl: cpsr bits 0-7 (mode, T, F, I).
//   $thumb        executionMode. $cc: the instruction's currentCycles.
//   $shop $shc    shifterOperand / shifterCarryOut.
//
// The emitted text is identical to the earlier Python emitter's (the differential
// gate). Values follow Python's model: a known value is a JS number, a
// decided condition is a JS boolean, anything else is a WAT expression string.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";

const DATA = JSON.parse(readFileSync(new URL("./mgba-data.json", import.meta.url), "utf8"));
/** 4096 handler names, index ((op >> 16) & 0xFF0) | ((op >> 4) & 0xF) */
export const ARM_TABLE = DATA.armTable;
/** 1024 handler names, index op >> 6 */
export const THUMB_TABLE = DATA.thumbTable;
export const MGBA_DATA = DATA;

/** Linear address of r0; set by the emitter before generating handlers. */
let REGS = 0;
/** @param {number} a */
export function setRegs(a) { REGS = a; }

/** @param {number} op */
export function armIndex(op) {
  return ((op >>> 16) & 0xFF0) | ((op >>> 4) & 0xF);
}

// ---------------------------------------------------------------------------
// symbolic helpers: a value is a JS number (known), a boolean (decided) or a
// WAT expression string
// ---------------------------------------------------------------------------

/** @typedef {number|boolean|string} V */

/** @param {V} x @returns {string} */
function K(x) {
  if (typeof x === "boolean") return `(i32.const ${x ? 1 : 0})`;
  if (typeof x === "number") return `(i32.const ${x >>> 0})`;
  return x;
}

/** @param {V} x */
const isKnown = (x) => typeof x === "number";

/** @param {V} a @param {V} b @returns {boolean|string} */
function EQ(a, b) {
  if (isKnown(a) && isKnown(b)) return (/** @type {number} */ (a) >>> 0) === (/** @type {number} */ (b) >>> 0);
  return `(i32.eq ${K(a)} ${K(b)})`;
}

/** A known int condition (a static opcode bit) is a boolean. @param {V} x */
const B_ = (x) => (isKnown(x) ? Boolean(x) : x);

/** @param {V} cond @param {string} then @param {string} [els] @returns {string} */
function IF(cond, then, els = "") {
  cond = B_(cond);
  if (cond === true) return then;
  if (cond === false) return els;
  if (els) return `(if ${cond} (then ${then}) (else ${els}))`;
  return `(if ${cond} (then ${then}))`;
}

/** @param {V} cond */
function NOT(cond) {
  cond = B_(cond);
  if (typeof cond === "boolean") return !cond;
  return `(i32.eqz ${cond})`;
}

/** @param {V} a @param {V} b */
function AND_(a, b) {
  a = B_(a); b = B_(b);
  if (a === false || b === false) return false;
  if (a === true) return b;
  if (b === true) return a;
  return `(i32.and ${a} ${b})`;
}

/** @param {V} a @param {V} b */
function OR_(a, b) {
  a = B_(a); b = B_(b);
  if (a === true || b === true) return true;
  if (a === false) return b;
  if (b === false) return a;
  return `(i32.or ${a} ${b})`;
}

/** @param {V} a @param {V} b */
function ADD(a, b) {
  if (isKnown(a) && isKnown(b)) return (/** @type {number} */ (a) + /** @type {number} */ (b)) >>> 0;
  if (isKnown(b) && b === 0) return a;
  return `(i32.add ${K(a)} ${K(b)})`;
}

/** @param {V} n */
function REG_ADDR(n) {
  if (isKnown(n)) return `(i32.const ${REGS + 4 * /** @type {number} */ (n)})`;
  return `(i32.add (i32.const ${REGS}) (i32.shl ${n} (i32.const 2)))`;
}

/** @param {V} n */
const R = (n) => `(i32.load ${REG_ADDR(n)})`;
/** @param {V} n @param {V} e */
const W = (n, e) => `(i32.store ${REG_ADDR(n)} ${K(e)})`;

/** @param {V} e */
const addcc = (e) => `(global.set $cc (i32.add (global.get $cc) ${K(e)}))`;

const S16 = () => "(global.get $aseq16)";
const N16 = () => "(global.get $anon16)";
const S32 = () => "(global.get $aseq32)";
const N32 = () => "(global.get $anon32)";

/** n and z from a result (the result must be a cheap expression). @param {string} d */
const NZ = (d) => `(global.set $n (i32.shr_u ${d} (i32.const 31)))` + `(global.set $z (i32.eqz ${d}))`;

/** cpsr flags for an addition. m, n, d are locals/constants (read several times). */
function addFlags(m, n, d) {
  return NZ(d)
    + `(global.set $c (i32.gt_u (i32.add (i32.shr_u ${m} (i32.const 31)) `
    + `(i32.shr_u ${n} (i32.const 31))) (i32.shr_u ${d} (i32.const 31))))`
    + `(global.set $v (i32.and (i32.eqz (i32.shr_u (i32.xor ${m} ${n}) (i32.const 31))) `
    + `(i32.shr_u (i32.xor ${m} ${d}) (i32.const 31))))`;
}

function subFlags(m, n, d) {
  return NZ(d)
    + `(global.set $c (i32.ge_u ${m} ${n}))`
    + `(global.set $v (i32.and (i32.shr_u (i32.xor ${m} ${n}) (i32.const 31)) `
    + `(i32.shr_u (i32.xor ${m} ${d}) (i32.const 31))))`;
}

/** ARM_BORROW_FROM_CARRY: (u64)M >= (u64)N + C. */
function sbcFlags(m, n, d, cin) {
  return NZ(d)
    + `(global.set $c (i64.ge_u (i64.extend_i32_u ${m}) `
    + `(i64.add (i64.extend_i32_u ${n}) (i64.extend_i32_u ${cin}))))`
    + `(global.set $v (i32.and (i32.shr_u (i32.xor ${m} ${n}) (i32.const 31)) `
    + `(i32.shr_u (i32.xor ${m} ${d}) (i32.const 31))))`;
}

// ---------------------------------------------------------------------------
// generator context
// ---------------------------------------------------------------------------

export class G {
  /**
   * @param {boolean} isStatic
   * @param {{op?: number, thumb?: boolean}} [o]
   */
  constructor(isStatic, o = {}) {
    this.static = isStatic;
    this.op = o.op ?? 0;
    this.thumb = !!o.thumb;
  }

  /** @param {number} lo @param {number} n @returns {V} */
  f(lo, n) {
    const mask = (1 << n) - 1; // n <= 16 everywhere
    if (this.static) return (this.op >>> lo) & mask;
    if (lo === 0) return `(i32.and (local.get $op) (i32.const ${mask}))`;
    return `(i32.and (i32.shr_u (local.get $op) (i32.const ${lo})) `
      + `(i32.const ${mask}))`;
  }

  /** @param {number} b @returns {V} */
  bit(b) {
    if (this.static) return (this.op >>> b) & 1;
    return `(i32.and (i32.shr_u (local.get $op) (i32.const ${b})) (i32.const 1))`;
  }

  /** -> [setup code, value]. Known values pass through; expressions are
   * stored in a local so they are evaluated once.
   * @param {string} name @param {V} val @returns {[string, V]} */
  hold(name, val) {
    if (isKnown(val)) return ["", val];
    return [`(local.set $${name} ${val})`, `(local.get $${name})`];
  }
}

// Locals every handler may use; the emitter declares them in each function
// that contains handlers.
const LOCALS = ["op", "rd", "rn", "rm", "rs", "imm", "a", "b", "d", "e", "addr",
  "sv", "sh", "rot", "mask", "res", "hi", "lo", "x"];
const LOCALS64 = ["q"];

export function localDecls() {
  return LOCALS.map((n) => `(local $${n} i32)`).join(" ") + " "
    + LOCALS64.map((n) => `(local $${n} i64)`).join(" ");
}

// ---------------------------------------------------------------------------
// THUMB
// ---------------------------------------------------------------------------

const writePcThumb = () => addcc("(call $thumb_write_pc)");
const writePcArm = () => addcc("(call $arm_write_pc)");
const writePcByMode = () => addcc("(if (result i32) (global.get $thumb) (then (call $thumb_write_pc)) "
  + "(else (call $arm_write_pc)))");

const THUMB_LOAD_POST = addcc(`(i32.sub ${N16()} ${S16()})`);
const THUMB_STORE_POST = THUMB_LOAD_POST;

// Condition codes over the flag globals, as mGBA's ARM_COND_* macros.
const _n = "(global.get $n)", _z = "(global.get $z)", _c = "(global.get $c)", _v = "(global.get $v)";
/** @type {Record<string, string>} */
export const COND = {
  EQ: _z, NE: `(i32.eqz ${_z})`, CS: _c, CC: `(i32.eqz ${_c})`,
  MI: _n, PL: `(i32.eqz ${_n})`, VS: _v, VC: `(i32.eqz ${_v})`,
  HI: `(i32.and ${_c} (i32.eqz ${_z}))`, LS: `(i32.or (i32.eqz ${_c}) ${_z})`,
  GE: `(i32.eq ${_n} ${_v})`, LT: `(i32.ne ${_n} ${_v})`,
  GT: `(i32.and (i32.eqz ${_z}) (i32.eq ${_n} ${_v}))`,
  LE: `(i32.or ${_z} (i32.ne ${_n} ${_v}))`,
};

const DATA5 = new Set(["AND", "EOR", "LSL2", "LSR2", "ASR2", "ADC", "SBC", "ROR", "TST",
  "NEG", "CMP2", "CMN", "ORR", "MUL", "BIC", "MVN"]);
const BCONDS = new Set(["BEQ", "BNE", "BCS", "BCC", "BMI", "BPL", "BVS", "BVC", "BLS", "BHI",
  "BGE", "BLT", "BGT", "BLE"]);

/**
 * Body of one Thumb handler (after the prefetch-cycle prologue).
 * @param {string} name @param {G} g @returns {string}
 */
export function thumb(name, g) {
  const f = (lo, n) => g.f(lo, n);
  /** @type {string[]} */
  const out = [];
  const A = (s) => { out.push(s); };

  const imm5Fields = () => {
    const [s1, imm] = g.hold("imm", f(6, 5));
    const [s2, rd] = g.hold("rd", f(0, 3));
    const [s3, rm] = g.hold("rm", f(3, 3));
    A(s1 + s2 + s3);
    return [imm, rd, rm];
  };

  if (name === "LSL1" || name === "LSR1" || name === "ASR1") {
    const [imm, rd, rm] = imm5Fields();
    A(`(local.set $a ${R(rm)})`);
    const a = "(local.get $a)";
    if (name === "LSL1") {
      A(IF(EQ(imm, 0), W(rd, a),
        `(global.set $c (i32.and (i32.shr_u ${a} (i32.sub (i32.const 32) ${K(imm)})) (i32.const 1)))`
        + W(rd, `(i32.shl ${a} ${K(imm)})`)));
    } else if (name === "LSR1") {
      A(IF(EQ(imm, 0),
        `(global.set $c (i32.shr_u ${a} (i32.const 31)))` + W(rd, 0),
        `(global.set $c (i32.and (i32.shr_u ${a} (i32.sub ${K(imm)} (i32.const 1))) (i32.const 1)))`
        + W(rd, `(i32.shr_u ${a} ${K(imm)})`)));
    } else {
      A(IF(EQ(imm, 0),
        `(global.set $c (i32.shr_u ${a} (i32.const 31)))`
        + W(rd, `(i32.shr_s ${a} (i32.const 31))`),
        `(global.set $c (i32.and (i32.shr_u ${a} (i32.sub ${K(imm)} (i32.const 1))) (i32.const 1)))`
        + W(rd, `(i32.shr_s ${a} ${K(imm)})`)));
    }
    A(`(local.set $d ${R(rd)})` + NZ("(local.get $d)"));
    return out.join("");
  }

  if (["LDR1", "LDRB1", "LDRH1", "STR1", "STRB1", "STRH1"].includes(name)) {
    const [imm, rd, rm] = imm5Fields();
    const scale = ({ LDR1: 4, STR1: 4, LDRH1: 2, STRH1: 2 })[name] ?? 1;
    const off = !isKnown(imm) ? `(i32.mul ${K(imm)} (i32.const ${scale}))` : /** @type {number} */ (imm) * scale;
    A(`(local.set $addr ${K(ADD(R(rm), off))})`);
    const addr = "(local.get $addr)";
    if (name.startsWith("LDR")) {
      const fn = ({ LDR1: "$ld32", LDRB1: "$ld8", LDRH1: "$ld16" })[name];
      A(W(rd, `(call ${fn} ${addr} (i32.const 1))`));
      A(THUMB_LOAD_POST);
    } else {
      const fn = ({ STR1: "$st32", STRB1: "$st8", STRH1: "$st16" })[name];
      A(`(call ${fn} ${addr} ${R(rd)} (i32.const 1))`);
      A(THUMB_STORE_POST);
    }
    return out.join("");
  }

  if (["ADD3", "SUB3", "ADD1", "SUB1"].includes(name)) {
    const [s1, rd] = g.hold("rd", f(0, 3));
    const [s2, rn] = g.hold("rn", f(3, 3));
    A(s1 + s2);
    if (name === "ADD3" || name === "SUB3") {
      const [s3, rm] = g.hold("rm", f(6, 3));
      A(s3);
      A(`(local.set $b ${R(rm)})`);
    } else {
      A(`(local.set $b ${K(f(6, 3))})`);
    }
    A(`(local.set $a ${R(rn)})`);
    const a = "(local.get $a)", b = "(local.get $b)";
    if (name.startsWith("ADD")) {
      A(`(local.set $d (i32.add ${a} ${b}))` + W(rd, "(local.get $d)") + addFlags(a, b, "(local.get $d)"));
    } else {
      A(`(local.set $d (i32.sub ${a} ${b}))` + W(rd, "(local.get $d)") + subFlags(a, b, "(local.get $d)"));
    }
    return out.join("");
  }

  if (["ADD2", "CMP1", "MOV1", "SUB2"].includes(name)) {
    const [s1, rd] = g.hold("rd", f(8, 3));
    A(s1);
    const imm = f(0, 8);
    if (name === "MOV1") {
      A(W(rd, imm));
      A(NZ(K(imm)));
      return out.join("");
    }
    A(`(local.set $a ${R(rd)})(local.set $b ${K(imm)})`);
    const a = "(local.get $a)", b = "(local.get $b)";
    if (name === "ADD2") {
      A(`(local.set $d (i32.add ${a} ${b}))` + W(rd, "(local.get $d)") + addFlags(a, b, "(local.get $d)"));
    } else if (name === "SUB2") {
      A(`(local.set $d (i32.sub ${a} ${b}))` + W(rd, "(local.get $d)") + subFlags(a, b, "(local.get $d)"));
    } else {
      A(`(local.set $d (i32.sub ${a} ${b}))` + subFlags(a, b, "(local.get $d)"));
    }
    return out.join("");
  }

  if (DATA5.has(name)) {
    const [s1, rd] = g.hold("rd", f(0, 3));
    const [s2, rn] = g.hold("rn", f(3, 3));
    A(s1 + s2);
    A(`(local.set $a ${R(rd)})(local.set $b ${R(rn)})`);
    const a = "(local.get $a)", b = "(local.get $b)", d = "(local.get $d)";
    if (["AND", "EOR", "ORR", "BIC"].includes(name)) {
      const op = ({
        AND: `(i32.and ${a} ${b})`, EOR: `(i32.xor ${a} ${b})`,
        ORR: `(i32.or ${a} ${b})`,
        BIC: `(i32.and ${a} (i32.xor ${b} (i32.const -1)))`,
      })[name];
      A(`(local.set $d ${op})` + W(rd, d) + NZ(d));
    } else if (name === "MVN") {
      A(`(local.set $d (i32.xor ${b} (i32.const -1)))` + W(rd, d) + NZ(d));
    } else if (name === "TST") {
      A(`(local.set $d (i32.and ${a} ${b}))` + NZ(d));
    } else if (["LSL2", "LSR2", "ASR2", "ROR"].includes(name)) {
      A("(local.set $sh (i32.and (local.get $b) (i32.const 255)))");
      const sh = "(local.get $sh)";
      let body;
      if (name === "LSL2") {
        body = IF(`(i32.lt_u ${sh} (i32.const 32))`,
          `(global.set $c (i32.and (i32.shr_u ${a} (i32.sub (i32.const 32) ${sh})) (i32.const 1)))`
          + `(local.set $a (i32.shl ${a} ${sh}))`,
          IF(`(i32.gt_u ${sh} (i32.const 32))`, "(global.set $c (i32.const 0))",
            `(global.set $c (i32.and ${a} (i32.const 1)))`)
          + "(local.set $a (i32.const 0))");
      } else if (name === "LSR2") {
        body = IF(`(i32.lt_u ${sh} (i32.const 32))`,
          `(global.set $c (i32.and (i32.shr_u ${a} (i32.sub ${sh} (i32.const 1))) (i32.const 1)))`
          + `(local.set $a (i32.shr_u ${a} ${sh}))`,
          IF(`(i32.gt_u ${sh} (i32.const 32))`, "(global.set $c (i32.const 0))",
            `(global.set $c (i32.shr_u ${a} (i32.const 31)))`)
          + "(local.set $a (i32.const 0))");
      } else if (name === "ASR2") {
        body = IF(`(i32.lt_u ${sh} (i32.const 32))`,
          `(global.set $c (i32.and (i32.shr_u ${a} (i32.sub ${sh} (i32.const 1))) (i32.const 1)))`
          + `(local.set $a (i32.shr_s ${a} ${sh}))`,
          `(global.set $c (i32.shr_u ${a} (i32.const 31)))`
          + `(local.set $a (i32.shr_s ${a} (i32.const 31)))`);
      } else {
        body = "(local.set $rot (i32.and (local.get $sh) (i32.const 31)))"
          + IF("(i32.gt_s (local.get $rot) (i32.const 0))",
            `(global.set $c (i32.and (i32.shr_u ${a} (i32.sub (local.get $rot) (i32.const 1))) (i32.const 1)))`
            + `(local.set $a (i32.rotr ${a} (local.get $rot)))`,
            `(global.set $c (i32.shr_u ${a} (i32.const 31)))`);
      }
      A(IF(sh, body + W(rd, a)));
      A(addcc(1));
      A(`(local.set $d ${R(rd)})` + NZ(d));
    } else if (name === "ADC") {
      A(`(local.set $d (i32.add (i32.add ${a} ${b}) (global.get $c)))` + W(rd, d) + addFlags(a, b, d));
    } else if (name === "SBC") {
      A("(local.set $e (i32.xor (global.get $c) (i32.const 1)))"
        + `(local.set $d (i32.sub (i32.sub ${a} ${b}) (local.get $e)))` + W(rd, d)
        + sbcFlags(a, b, d, "(local.get $e)"));
    } else if (name === "NEG") {
      A(`(local.set $d (i32.sub (i32.const 0) ${b}))` + W(rd, d) + subFlags("(i32.const 0)", b, d));
    } else if (name === "CMP2") {
      A(`(local.set $d (i32.sub ${a} ${b}))` + subFlags(a, b, d));
    } else if (name === "CMN") {
      A(`(local.set $d (i32.add ${a} ${b}))` + addFlags(a, b, d));
    } else if (name === "MUL") {
      A(addcc(`(call $mul_wait_s ${a} (i32.const 0))`));
      A(`(local.set $d (i32.mul ${a} ${b}))` + W(rd, d) + NZ(d));
      A(addcc(`(i32.sub ${N16()} ${S16()})`));
    }
    return out.join("");
  }

  const n4 = name.slice(0, 4);
  if (n4 === "ADD4" || n4 === "CMP3" || n4 === "MOV3") {
    const h1 = Number(name[4]), h2 = Number(name[5]);
    let rd = !h1 ? f(0, 3) : (g.static ? 8 | /** @type {number} */ (f(0, 3)) : `(i32.or ${f(0, 3)} (i32.const 8))`);
    let rm = !h2 ? f(3, 3) : (g.static ? 8 | /** @type {number} */ (f(3, 3)) : `(i32.or ${f(3, 3)} (i32.const 8))`);
    let s1, s2;
    [s1, rd] = g.hold("rd", rd);
    [s2, rm] = g.hold("rm", rm);
    A(s1 + s2);
    const pcw = h1 ? IF(EQ(rd, 15), writePcThumb()) : "";
    if (name.startsWith("ADD4")) {
      A(W(rd, `(i32.add ${R(rd)} ${R(rm)})`) + pcw);
    } else if (name.startsWith("MOV3")) {
      A(W(rd, R(rm)) + pcw);
    } else {
      A(`(local.set $a ${R(rd)})(local.set $b ${R(rm)})`
        + "(local.set $d (i32.sub (local.get $a) (local.get $b)))"
        + subFlags("(local.get $a)", "(local.get $b)", "(local.get $d)"));
    }
    return out.join("");
  }

  if (["LDR3", "LDR4", "STR3", "ADD5", "ADD6"].includes(name)) {
    const [s1, rd] = g.hold("rd", f(8, 3));
    A(s1);
    let imm = f(0, 8);
    imm = g.static ? /** @type {number} */ (imm) << 2 : `(i32.shl ${imm} (i32.const 2))`;
    if (name === "LDR3") {
      A(W(rd, `(call $ld32 (i32.add (i32.and ${R(15)} (i32.const -4)) ${K(imm)}) (i32.const 1))`));
      A(THUMB_LOAD_POST);
    } else if (name === "LDR4") {
      A(W(rd, `(call $ld32 (i32.add ${R(13)} ${K(imm)}) (i32.const 1))`));
      A(THUMB_LOAD_POST);
    } else if (name === "STR3") {
      A(`(call $st32 (i32.add ${R(13)} ${K(imm)}) ${R(rd)} (i32.const 1))`);
      A(THUMB_STORE_POST);
    } else if (name === "ADD5") {
      A(W(rd, `(i32.add (i32.and ${R(15)} (i32.const -4)) ${K(imm)})`));
    } else {
      A(W(rd, `(i32.add ${R(13)} ${K(imm)})`));
    }
    return out.join("");
  }

  if (["LDR2", "LDRB2", "LDRH2", "LDRSB", "LDRSH", "STR2", "STRB2", "STRH2"].includes(name)) {
    const [s1, rm] = g.hold("rm", f(6, 3));
    const [s2, rd] = g.hold("rd", f(0, 3));
    const [s3, rn] = g.hold("rn", f(3, 3));
    A(s1 + s2 + s3);
    A(`(local.set $addr (i32.add ${R(rn)} ${R(rm)}))`);
    const addr = "(local.get $addr)";
    if (name === "LDR2") A(W(rd, `(call $ld32 ${addr} (i32.const 1))`));
    else if (name === "LDRB2") A(W(rd, `(call $ld8 ${addr} (i32.const 1))`));
    else if (name === "LDRH2") A(W(rd, `(call $ld16 ${addr} (i32.const 1))`));
    else if (name === "LDRSB") A(W(rd, `(i32.extend8_s (call $ld8 ${addr} (i32.const 1)))`));
    else if (name === "LDRSH") {
      A(W(rd, `(if (result i32) (i32.and ${addr} (i32.const 1)) `
        + `(then (i32.extend8_s (call $ld16 ${addr} (i32.const 1)))) `
        + `(else (i32.extend16_s (call $ld16 ${addr} (i32.const 1)))))`));
    } else if (name === "STR2") A(`(call $st32 ${addr} ${R(rd)} (i32.const 1))`);
    else if (name === "STRB2") A(`(call $st8 ${addr} ${R(rd)} (i32.const 1))`);
    else A(`(call $st16 ${addr} ${R(rd)} (i32.const 1))`);
    A(THUMB_LOAD_POST);
    return out.join("");
  }

  if (["LDMIA", "STMIA", "POP", "POPR", "PUSH", "PUSHR"].includes(name)) {
    let s1, rn;
    if (name === "LDMIA" || name === "STMIA") [s1, rn] = g.hold("rn", f(8, 3));
    else [s1, rn] = ["", 13];
    A(s1);
    let rs = f(0, 8);
    if (name === "POPR") rs = g.static ? /** @type {number} */ (rs) | 0x8000 : `(i32.or ${rs} (i32.const 32768))`;
    if (name === "PUSHR") rs = g.static ? /** @type {number} */ (rs) | 0x4000 : `(i32.or ${rs} (i32.const 16384))`;
    let s2;
    [s2, rs] = g.hold("rs", rs);
    A(s2);
    const load = name === "LDMIA" || name === "POP" || name === "POPR";
    const direction = name.startsWith("PUSH") ? 3 : 0;
    const fn = load ? "$ldm" : "$stm";
    A(`(local.set $addr (call ${fn} ${R(rn)} ${K(rs)} (i32.const ${direction}) (i32.const 1)))`);
    A(THUMB_LOAD_POST);
    if (name === "LDMIA") {
      A(IF(EQ(rs, 0), writePcThumb()));
      if (g.static) {
        if (!((1 << /** @type {number} */ (rn)) & /** @type {number} */ (rs))) A(W(rn, "(local.get $addr)"));
      } else {
        A(`(if (i32.eqz (i32.and (i32.shl (i32.const 1) ${rn}) ${rs})) (then ${W(rn, "(local.get $addr)")}))`);
      }
    } else if (name === "STMIA") {
      A(W(rn, "(local.get $addr)"));
    } else if (name === "POPR") {
      A(W(13, "(local.get $addr)"));
      A(writePcThumb());
    } else {
      A(W(13, "(local.get $addr)"));
    }
    return out.join("");
  }

  if (BCONDS.has(name)) {
    const cond = COND[name.slice(1)];
    if (g.static) {
      let imm = g.op & 0xFF;
      if (imm & 0x80) imm -= 256;
      A(IF(cond, W(15, `(i32.add ${R(15)} (i32.const ${imm << 1}))`) + writePcThumb()));
    } else {
      A(IF(cond, W(15, `(i32.add ${R(15)} (i32.shl (i32.extend8_s (local.get $op)) (i32.const 1)))`)
        + writePcThumb()));
    }
    return out.join("");
  }

  if (name === "ADD7" || name === "SUB4") {
    let imm = f(0, 7);
    imm = g.static ? /** @type {number} */ (imm) << 2 : `(i32.shl ${imm} (i32.const 2))`;
    const op = name === "ADD7" ? "i32.add" : "i32.sub";
    A(W(13, `(${op} ${R(13)} ${K(imm)})`));
    return out.join("");
  }

  if (name === "B") {
    if (g.static) {
      let imm = (g.op & 0x7FF) << 5;
      imm = (imm & 0x8000 ? imm - 0x10000 : imm) >> 4;
      A(W(15, `(i32.add ${R(15)} (i32.const ${imm}))`));
    } else {
      A(W(15, `(i32.add ${R(15)} (i32.shr_s (i32.extend16_s (i32.shl (i32.and (local.get $op) (i32.const 2047)) (i32.const 5))) (i32.const 4)))`));
    }
    A(writePcThumb());
    return out.join("");
  }

  if (name === "BL1") {
    if (g.static) {
      let imm = (g.op & 0x7FF) << 5;
      imm = (imm & 0x8000 ? imm - 0x10000 : imm) * 128;
      A(W(14, `(i32.add ${R(15)} (i32.const ${imm}))`));
    } else {
      A(W(14, `(i32.add ${R(15)} (i32.shl (i32.extend16_s (i32.shl (i32.and (local.get $op) (i32.const 2047)) (i32.const 5))) (i32.const 7)))`));
    }
    return out.join("");
  }

  if (name === "BL2") {
    let imm = f(0, 11);
    imm = g.static ? /** @type {number} */ (imm) << 1 : `(i32.shl ${imm} (i32.const 1))`;
    A(`(local.set $a ${R(15)})`);
    A(W(15, `(i32.add ${R(14)} ${K(imm)})`));
    A(W(14, "(i32.sub (local.get $a) (i32.const 1))"));
    A(writePcThumb());
    return out.join("");
  }

  if (name === "BX") {
    const [s1, rm] = g.hold("rm", f(3, 4));
    A(s1);
    A(`(local.set $a ${R(rm)})`);
    A("(call $set_exec_mode (i32.and (local.get $a) (i32.const 1)))");
    A(W(15, "(i32.and (local.get $a) (i32.const -2))"));
    A(writePcByMode());
    return out.join("");
  }

  if (name === "SWI") {
    A(`(call $swi16 ${K(f(0, 8))})`);
    return out.join("");
  }

  if (name === "BKPT") {
    A("(call $raise_undef)(global.set $cc (i32.const 0))");
    return out.join("");
  }

  if (name === "ILL") {
    A(`(call $illegal ${g.static ? K(g.op) : "(local.get $op)"})`);
    return out.join("");
  }

  throw new Error(`gba cpu: no Thumb handler '${name}'`);
}

// ---------------------------------------------------------------------------
// ARM
// ---------------------------------------------------------------------------

const ARM_LOAD_POST_NOPC = addcc(`(i32.sub ${N32()} ${S32()})`);

/** 32-bit rotate right of a known value. */
const rotr32 = (v, r) => (r ? ((v >>> r) | (v << (32 - r))) >>> 0 : v >>> 0);

/**
 * mGBA's addressing mode 1 shifters: set $shop and $shc. A register shift
 * charges one cycle straight to cpu->cycles (not currentCycles).
 * @param {string} kind @param {G} g
 */
function shifter(kind, g) {
  const f = (lo, n) => g.f(lo, n);
  if (kind === "I") {
    const rot = f(8, 4);
    const imm = f(0, 8);
    if (g.static) {
      const rotate = /** @type {number} */ (rot) << 1;
      if (rotate === 0) return `(global.set $shop (i32.const ${imm}))(global.set $shc (global.get $c))`;
      const v = rotr32(/** @type {number} */ (imm), rotate);
      return `(global.set $shop (i32.const ${v}))(global.set $shc (i32.const ${v >>> 31}))`;
    }
    return `(local.set $rot (i32.shl ${rot} (i32.const 1)))`
      + IF("(i32.eqz (local.get $rot))",
        `(global.set $shop ${imm})(global.set $shc (global.get $c))`,
        `(global.set $shop (i32.rotr ${imm} (local.get $rot)))`
        + "(global.set $shc (i32.shr_u (global.get $shop) (i32.const 31)))");
  }
  const [s1, rm] = g.hold("rm", f(0, 4));
  const out = [s1];
  const regshift = g.bit(4);
  // register-specified shift
  const rsCode = [];
  const [s2, rs] = g.hold("rs", f(8, 4));
  rsCode.push(s2);
  rsCode.push("(global.set $cycles (i32.add (global.get $cycles) (i32.const 1)))");
  rsCode.push(`(local.set $sv ${R(rm)})`);
  rsCode.push(IF(EQ(rm, 15), "(local.set $sv (i32.add (local.get $sv) (i32.const 4)))"));
  rsCode.push(`(local.set $sh (i32.and ${R(rs)} (i32.const 255)))`);
  let sv = "(local.get $sv)";
  const sh = "(local.get $sh)";
  if (kind === "LSL") {
    rsCode.push(IF(`(i32.eqz ${sh})`,
      `(global.set $shop ${sv})(global.set $shc (global.get $c))`,
      IF(`(i32.lt_s ${sh} (i32.const 32))`,
        `(global.set $shop (i32.shl ${sv} ${sh}))`
        + `(global.set $shc (i32.and (i32.shr_s ${sv} (i32.sub (i32.const 32) ${sh})) (i32.const 1)))`,
        IF(`(i32.eq ${sh} (i32.const 32))`,
          `(global.set $shop (i32.const 0))(global.set $shc (i32.and ${sv} (i32.const 1)))`,
          "(global.set $shop (i32.const 0))(global.set $shc (i32.const 0))"))));
  } else if (kind === "LSR") {
    rsCode.push(IF(`(i32.eqz ${sh})`,
      `(global.set $shop ${sv})(global.set $shc (global.get $c))`,
      IF(`(i32.lt_s ${sh} (i32.const 32))`,
        `(global.set $shop (i32.shr_u ${sv} ${sh}))`
        + `(global.set $shc (i32.and (i32.shr_u ${sv} (i32.sub ${sh} (i32.const 1))) (i32.const 1)))`,
        IF(`(i32.eq ${sh} (i32.const 32))`,
          `(global.set $shop (i32.const 0))(global.set $shc (i32.shr_u ${sv} (i32.const 31)))`,
          "(global.set $shop (i32.const 0))(global.set $shc (i32.const 0))"))));
  } else if (kind === "ASR") {
    rsCode.push(IF(`(i32.eqz ${sh})`,
      `(global.set $shop ${sv})(global.set $shc (global.get $c))`,
      IF(`(i32.lt_s ${sh} (i32.const 32))`,
        `(global.set $shop (i32.shr_s ${sv} ${sh}))`
        + `(global.set $shc (i32.and (i32.shr_s ${sv} (i32.sub ${sh} (i32.const 1))) (i32.const 1)))`,
        IF(`(i32.shr_u ${R(rm)} (i32.const 31))`,
          "(global.set $shop (i32.const -1))(global.set $shc (i32.const 1))",
          "(global.set $shop (i32.const 0))(global.set $shc (i32.const 0))"))));
  } else {
    rsCode.push("(local.set $rot (i32.and (local.get $sh) (i32.const 31)))");
    rsCode.push(IF(`(i32.eqz ${sh})`,
      `(global.set $shop ${sv})(global.set $shc (global.get $c))`,
      IF("(local.get $rot)",
        `(global.set $shop (i32.rotr ${sv} (local.get $rot)))`
        + `(global.set $shc (i32.and (i32.shr_s ${sv} (i32.sub (local.get $rot) (i32.const 1))) (i32.const 1)))`,
        `(global.set $shop ${sv})(global.set $shc (i32.shr_u ${sv} (i32.const 31)))`)));
  }
  // immediate shift
  const imCode = [];
  const [s3, imm] = g.hold("imm", f(7, 5));
  imCode.push(s3);
  imCode.push(`(local.set $sv ${R(rm)})`);
  sv = "(local.get $sv)";
  if (kind === "LSL") {
    imCode.push(IF(EQ(imm, 0),
      `(global.set $shop ${sv})(global.set $shc (global.get $c))`,
      `(global.set $shop (i32.shl ${sv} ${K(imm)}))`
      + `(global.set $shc (i32.and (i32.shr_s ${sv} (i32.sub (i32.const 32) ${K(imm)})) (i32.const 1)))`));
  } else if (kind === "LSR") {
    imCode.push(IF(NOT(EQ(imm, 0)),
      `(global.set $shop (i32.shr_u ${sv} ${K(imm)}))`
      + `(global.set $shc (i32.and (i32.shr_s ${sv} (i32.sub ${K(imm)} (i32.const 1))) (i32.const 1)))`,
      `(global.set $shop (i32.const 0))(global.set $shc (i32.shr_u ${sv} (i32.const 31)))`));
  } else if (kind === "ASR") {
    imCode.push(IF(NOT(EQ(imm, 0)),
      `(global.set $shop (i32.shr_s ${sv} ${K(imm)}))`
      + `(global.set $shc (i32.and (i32.shr_s ${sv} (i32.sub ${K(imm)} (i32.const 1))) (i32.const 1)))`,
      `(global.set $shc (i32.shr_u ${sv} (i32.const 31)))(global.set $shop (i32.shr_s ${sv} (i32.const 31)))`));
  } else {
    imCode.push(IF(NOT(EQ(imm, 0)),
      `(global.set $shop (i32.rotr ${sv} ${K(imm)}))`
      + `(global.set $shc (i32.and (i32.shr_s ${sv} (i32.sub ${K(imm)} (i32.const 1))) (i32.const 1)))`,
      `(global.set $shop (i32.or (i32.shl (global.get $c) (i32.const 31)) (i32.shr_u ${sv} (i32.const 1))))`
      + `(global.set $shc (i32.and ${sv} (i32.const 1)))`));
  }
  out.push(IF(regshift, rsCode.join(""), imCode.join("")));
  return out.join("");
}

/** if (rd == PC && _ARMModeHasSPSR(cpsr.priv)) { cpsr = spsr; _ARMReadCPSR } */
const spsrRestore = () => "(call $cpsr_from_spsr)";

const hasSpsr = () => "(i32.and (i32.ne (i32.and (global.get $ctl) (i32.const 31)) (i32.const 31)) "
  + "(i32.ne (i32.and (global.get $ctl) (i32.const 31)) (i32.const 16)))";

/** ARM_*_S: `if (rd == ARM_PC && _ARMModeHasSPSR(cpsr.priv)) cpsr = spsr; else <flags>`. */
function sBody(rd, fl) {
  const c = EQ(rd, 15);
  if (c === false) return fl;
  return IF(AND_(c, hasSpsr()), spsrRestore(), fl);
}

const ALU_OPS = ["AND", "EOR", "SUB", "RSB", "ADD", "ADC", "SBC", "RSC", "TST", "TEQ",
  "CMP", "CMN", "ORR", "MOV", "BIC", "MVN"];
const ALU_I = new Set([...ALU_OPS, ...ALU_OPS.map((o) => o + "S")]);

/** @param {string} name @param {G} g */
function alu(name, g) {
  let base, kind;
  if (name.endsWith("I") && ALU_I.has(name.slice(0, -1))) {
    base = name.slice(0, -1); kind = "I";
  } else {
    [base, kind] = name.split("_");
  }
  let setf = base.endsWith("S") && ALU_OPS.includes(base.slice(0, -1));
  const op = setf ? base.slice(0, -1) : base;
  const sOnly = ["TST", "TEQ", "CMP", "CMN"].includes(op);
  if (sOnly) setf = true;
  const out = [shifter(kind, g)];
  const A = (s) => { out.push(s); };
  const [s1, rd] = g.hold("rd", g.f(12, 4));
  const [s2, rn] = g.hold("rn", g.f(16, 4));
  A(s1 + s2);
  A(`(local.set $a ${R(rn)})`);
  // n += 4 when rn is pc and the shift is register-specified
  if (kind !== "I") {
    A(IF(AND_(EQ(rn, 15), EQ(g.bit(4), 1)), "(local.set $a (i32.add (local.get $a) (i32.const 4)))"));
  }
  const a = "(local.get $a)", so = "(global.get $shop)", d = "(local.get $d)";
  let body = ({
    AND: `(i32.and ${a} ${so})`, EOR: `(i32.xor ${a} ${so})`,
    SUB: `(i32.sub ${a} ${so})`, RSB: `(i32.sub ${so} ${a})`,
    ADD: `(i32.add ${a} ${so})`,
    ADC: `(i32.add (i32.add ${a} ${so}) (global.get $c))`,
    SBC: `(i32.sub (i32.sub ${a} ${so}) (i32.xor (global.get $c) (i32.const 1)))`,
    RSC: `(i32.sub (i32.sub ${so} ${a}) (i32.xor (global.get $c) (i32.const 1)))`,
    TST: `(i32.and ${a} ${so})`, TEQ: `(i32.xor ${a} ${so})`,
    CMP: `(i32.sub ${a} ${so})`, CMN: `(i32.add ${a} ${so})`,
    ORR: `(i32.or ${a} ${so})`, MOV: so,
    BIC: `(i32.and ${a} (i32.xor ${so} (i32.const -1)))`,
    MVN: `(i32.xor ${so} (i32.const -1))`,
  })[op];
  // carry-in for SBC/RSC is captured BEFORE the write (mGBA evaluates
  // !cpu->cpsr.c in both the body and the S_BODY, with no flag change
  // between them).
  if (op === "SBC" || op === "RSC") {
    A("(local.set $e (i32.xor (global.get $c) (i32.const 1)))");
    body = op === "SBC" ? `(i32.sub (i32.sub ${a} ${so}) (local.get $e))`
      : `(i32.sub (i32.sub ${so} ${a}) (local.get $e))`;
  }
  A(`(local.set $d ${body})`);
  if (!sOnly) A(W(rd, d));
  if (setf) {
    let fl;
    if (op === "ADD" || op === "ADC" || op === "CMN") fl = addFlags(a, so, d);
    else if (op === "SUB" || op === "CMP") fl = subFlags(a, so, d);
    else if (op === "RSB") fl = subFlags(so, a, d);
    else if (op === "SBC") fl = sbcFlags(a, so, d, "(local.get $e)");
    else if (op === "RSC") fl = sbcFlags(so, a, d, "(local.get $e)");
    else fl = NZ(d) + "(global.set $c (global.get $shc))";
    A(sBody(rd, fl));
  }
  if (!sOnly) A(IF(EQ(rd, 15), writePcByMode()));
  return out.join("");
}

/** @param {string} name @param {G} g */
function mul(name, g) {
  const out = [];
  const A = (s) => { out.push(s); };
  const two = ["MLA", "SMLAL", "SMULL", "UMLAL", "UMULL"].some((p) => name.startsWith(p));
  const setf = name.endsWith("S") && name !== "MLA" && name !== "MUL";
  const base = setf ? name.slice(0, -1) : name;
  if (!two) { // MUL
    const [s1, rd] = g.hold("rd", g.f(16, 4));
    const [s2, rs] = g.hold("rs", g.f(8, 4));
    const [s3, rm] = g.hold("rm", g.f(0, 4));
    A(s1 + s2 + s3);
    let body = addcc(`(call $mul_wait_s ${R(rs)} (i32.const 0))`)
      + `(local.set $d (i32.mul ${R(rm)} ${R(rs)}))` + W(rd, "(local.get $d)");
    if (setf) body += NZ("(local.get $d)") + "(global.set $c (global.get $shc))";
    A(IF(NOT(EQ(rd, 15)), body));
    A(addcc(`(i32.sub ${N32()} ${S32()})`));
    return out.join("");
  }
  const [s1, rd] = g.hold("rd", g.f(12, 4));
  const [s2, rdhi] = g.hold("rn", g.f(16, 4));
  const [s3, rs] = g.hold("rs", g.f(8, 4));
  const [s4, rm] = g.hold("rm", g.f(0, 4));
  A(s1 + s2 + s3 + s4);
  const signed = base === "MLA" || base === "SMLAL" || base === "SMULL";
  const wait = ({ MLA: 1, SMLAL: 2, SMULL: 1, UMLAL: 2, UMULL: 1 })[base];
  const wfn = signed ? "$mul_wait_s" : "$mul_wait_u";
  let body = addcc(`(call ${wfn} ${R(rs)} (i32.const ${wait}))`);
  if (base === "MLA") {
    body += `(local.set $d (i32.add (i32.mul ${R(rm)} ${R(rs)}) ${R(rd)}))` + W(rdhi, "(local.get $d)");
    const fl = NZ("(local.get $d)") + "(global.set $c (global.get $shc))";
    // ARM_NEUTRAL_S tests rd (bits 12-15), which this branch knows is not
    // the pc, so it is always the plain flag update.
    if (setf) body += fl;
  } else {
    const ext = signed ? "i64.extend_i32_s" : "i64.extend_i32_u";
    body += `(local.set $q (i64.mul (${ext} ${R(rm)}) (${ext} ${R(rs)})))`;
    if (base === "SMLAL" || base === "UMLAL") {
      body += `(local.set $q (i64.add (local.get $q) (i64.extend_i32_u ${R(rd)})))`
        + `(local.set $hi (i32.add ${R(rdhi)} (i32.wrap_i64 (i64.shr_${signed ? "s" : "u"} (local.get $q) (i64.const 32)))))`
        + "(local.set $lo (i32.wrap_i64 (local.get $q)))"
        + W(rd, "(local.get $lo)") + W(rdhi, "(local.get $hi)");
    } else {
      body += "(local.set $lo (i32.wrap_i64 (local.get $q)))"
        + "(local.set $hi (i32.wrap_i64 (i64.shr_u (local.get $q) (i64.const 32))))"
        + W(rd, "(local.get $lo)") + W(rdhi, "(local.get $hi)");
    }
    if (setf) {
      // ARM_NEUTRAL_HI_S(DLO, DHI): n from hi, z from hi|lo, reading the
      // REGISTERS for the non-accumulate forms and the locals otherwise
      if (base === "SMLAL" || base === "UMLAL") {
        body += "(global.set $n (i32.shr_u (local.get $hi) (i32.const 31)))"
          + `(global.set $z (i32.eqz (i32.or (local.get $hi) ${R(rd)})))`;
      } else {
        body += `(global.set $n (i32.shr_u ${R(rdhi)} (i32.const 31)))`
          + `(global.set $z (i32.eqz (i32.or ${R(rdhi)} ${R(rd)})))`;
      }
    }
  }
  A(IF(AND_(NOT(EQ(rdhi, 15)), NOT(EQ(rd, 15))), body));
  A(addcc(`(i32.sub ${N32()} ${S32()})`));
  return out.join("");
}

/**
 * -> [setup, value] of an addressing mode 2 scaled-register offset:
 * LSL rm<<I; LSR I ? rm>>I : 0; ASR I ? rm>>I : rm>>31; ROR I ? ror : RRX.
 * @param {G} g @param {string} kind @returns {[string, string]}
 */
function lsAddr2(g, kind) {
  const [s1, rm] = g.hold("rm", g.f(0, 4));
  const imm = g.f(7, 5);
  const rmv = R(rm);
  if (isKnown(imm)) {
    let v;
    if (kind === "LSL") v = `(i32.shl ${rmv} (i32.const ${imm}))`;
    else if (kind === "LSR") v = imm ? `(i32.shr_u ${rmv} (i32.const ${imm}))` : "(i32.const 0)";
    else if (kind === "ASR") v = `(i32.shr_s ${rmv} (i32.const ${imm || 31}))`;
    else {
      v = imm ? `(i32.rotr ${rmv} (i32.const ${imm}))`
        : `(i32.or (i32.shl (global.get $c) (i32.const 31)) (i32.shr_u ${rmv} (i32.const 1)))`;
    }
    return [s1, v];
  }
  const s2 = `(local.set $sh ${imm})`;
  const sh = "(local.get $sh)";
  let v;
  if (kind === "LSL") v = `(i32.shl ${rmv} ${sh})`;
  else if (kind === "LSR") v = `(if (result i32) ${sh} (then (i32.shr_u ${rmv} ${sh})) (else (i32.const 0)))`;
  else if (kind === "ASR") v = `(if (result i32) ${sh} (then (i32.shr_s ${rmv} ${sh})) (else (i32.shr_s ${rmv} (i32.const 31))))`;
  else {
    v = `(if (result i32) ${sh} (then (i32.rotr ${rmv} ${sh})) `
      + `(else (i32.or (i32.shl (global.get $c) (i32.const 31)) (i32.shr_u ${rmv} (i32.const 1)))))`;
  }
  return [s1 + s2, v];
}

const LS_OPS = ["LDRBT", "STRBT", "LDRT", "STRT", "LDRSB", "LDRSH", "LDRH", "STRH",
  "LDRB", "STRB", "LDR", "STR"];

/**
 * LDR/STR/LDRB/STRB (mode 2), LDRH/STRH/LDRSB/LDRSH (mode 3), T forms.
 *
 * DEFINE_LOAD_STORE_INSTRUCTION_EX_ARM: d = gprs[rd] (+4 for pc); address =
 * ADDRESS; a LOAD writes back before its body, a STORE after. The register
 * T forms keep mGBA's own reading: ADDRESS is the shifted register value and
 * the writeback is rn -/+ rm (unshifted).
 * @param {string} name @param {G} g
 */
function armLs(name, g) {
  const f = (lo, n) => g.f(lo, n);
  const out = [];
  const A = (s) => { out.push(s); };
  const [s1, rn] = g.hold("rn", f(16, 4));
  const [s2, rd] = g.hold("rd", f(12, 4));
  A(s1 + s2);
  let opn = LS_OPS[LS_OPS.length - 1], rest = "";
  for (const o of LS_OPS) {
    if (name.startsWith(o)) { opn = o; rest = name.slice(o.length); break; }
  }
  const load = opn.startsWith("LDR");
  const tform = opn.endsWith("T");
  const mode3 = ["LDRH", "STRH", "LDRSB", "LDRSH"].includes(opn);
  let flags, setup, offv, regT, kind;
  if (mode3) {
    if (rest.startsWith("I")) {
      flags = rest.slice(1);
      if (g.static) offv = ((g.op >>> 4) & 0xF0) | (g.op & 0xF);
      else {
        offv = "(i32.or (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 240)) "
          + "(i32.and (local.get $op) (i32.const 15)))";
      }
      setup = "";
    } else {
      flags = rest;
      const [s3, rm] = g.hold("rm", f(0, 4));
      setup = s3; offv = R(rm);
    }
    regT = false;
  } else {
    if (rest.startsWith("I")) {
      kind = "I"; flags = rest.slice(1);
      setup = ""; offv = f(0, 12);
    } else {
      kind = rest.slice(1, 4);
      flags = rest.slice(5);
      [setup, offv] = lsAddr2(g, kind);
    }
    regT = tform && kind !== "I";
  }
  const P = flags.includes("P") && !tform;
  const U = flags.includes("U");
  const Wb = flags.includes("W");
  A(setup);
  A(`(local.set $imm ${K(offv)})`);
  const op = U ? "add" : "sub";
  A(`(local.set $d ${R(rd)})`);
  A(IF(EQ(rd, 15), "(local.set $d (i32.add (local.get $d) (i32.const 4)))"));
  let wb;
  if (regT) {
    const rmr = g.static ? R(g.f(0, 4)) : R("(local.get $rm)");
    A("(local.set $addr (local.get $imm))");
    wb = W(rn, `(i32.${op} ${R(rn)} ${rmr})`) + IF(EQ(rn, 15), writePcArm());
  } else if (P) {
    A(`(local.set $addr (i32.${op} ${R(rn)} (local.get $imm)))`);
    wb = Wb ? (W(rn, "(local.get $addr)") + IF(EQ(rn, 15), writePcArm())) : "";
  } else {
    A(`(local.set $addr ${R(rn)})`);
    wb = W(rn, `(i32.${op} ${R(rn)} (local.get $imm))`) + IF(EQ(rn, 15), writePcArm());
  }
  const addr = "(local.get $addr)";
  if (load) {
    A(wb);
    if (tform) A("(local.set $e (global.get $priv))(call $set_priv (i32.const 16))");
    const v = ({
      LDR: `(call $ld32 ${addr} (i32.const 1))`,
      LDRT: `(call $ld32 ${addr} (i32.const 1))`,
      LDRB: `(call $ld8 ${addr} (i32.const 1))`,
      LDRBT: `(call $ld8 ${addr} (i32.const 1))`,
      LDRH: `(call $ld16 ${addr} (i32.const 1))`,
      LDRSB: `(i32.extend8_s (call $ld8 ${addr} (i32.const 1)))`,
      LDRSH: `(if (result i32) (i32.and ${addr} (i32.const 1)) `
        + `(then (i32.extend8_s (call $ld16 ${addr} (i32.const 1)))) `
        + `(else (i32.extend16_s (call $ld16 ${addr} (i32.const 1)))))`,
    })[opn];
    if (tform) A(`(local.set $x ${v})(call $set_priv (local.get $e))` + W(rd, "(local.get $x)"));
    else A(W(rd, v));
    A(ARM_LOAD_POST_NOPC + IF(EQ(rd, 15), writePcArm()));
  } else {
    const fn = ({ STR: "$st32", STRT: "$st32", STRB: "$st8", STRBT: "$st8", STRH: "$st16" })[opn];
    if (tform) {
      A(`(local.set $x ${R(rd)})(local.set $e (global.get $priv))(call $set_priv (i32.const 16))`);
      A(`(call ${fn} ${addr} (local.get $x) (i32.const 1))(call $set_priv (local.get $e))`);
    } else {
      A(`(call ${fn} ${addr} (local.get $d) (i32.const 1))`);
    }
    A(ARM_LOAD_POST_NOPC);
    A(wb);
  }
  return out.join("");
}

/** LDM/STM with every mGBA addressing variant, S (user-bank) forms included. */
function armLsm(name, g) {
  const out = [];
  const A = (s) => { out.push(s); };
  const load = name.startsWith("LDM");
  let rest = name.slice(3);
  const S = rest.startsWith("S");
  if (S) rest = rest.slice(1);
  const Wb = rest.endsWith("W");
  const direction = ({ IA: 0, IB: 1, DA: 2, DB: 3 })[rest.slice(0, 2)];
  const [s1, rn] = g.hold("rn", g.f(16, 4));
  const [s2, rs] = g.hold("rs", g.f(0, 16));
  A(s1 + s2);
  const rsv = K(rs);
  const pcIn = isKnown(rs) ? Boolean(/** @type {number} */ (rs) & 0x8000)
    : `(i32.ne (i32.and ${rsv} (i32.const 32768)) (i32.const 0))`;
  const nonempty = isKnown(rs) ? rs !== 0 : `(i32.ne ${rsv} (i32.const 0))`;
  const banked = AND_(NOT(pcIn), nonempty); // ARM_MS_PRE_load's test
  if (S) {
    if (load) A(IF(banked, "(local.set $e (global.get $priv))(call $set_priv (i32.const 31))"));
    else A("(local.set $e (global.get $priv))(call $set_priv (i32.const 31))");
  }
  const fn = load ? "$ldm" : "$stm";
  A(`(local.set $addr (call ${fn} ${R(rn)} ${rsv} (i32.const ${direction}) (i32.const 1)))`);
  if (Wb) {
    if (load) {
      if (isKnown(rs) && isKnown(rn)) {
        if (!((1 << /** @type {number} */ (rn)) & /** @type {number} */ (rs))) A(W(rn, "(local.get $addr)"));
      } else {
        A(`(if (i32.eqz (i32.and (i32.shl (i32.const 1) ${K(rn)}) ${rsv})) `
          + `(then ${W(rn, "(local.get $addr)")}))`);
      }
    } else {
      A(W(rn, "(local.get $addr)"));
    }
  }
  if (S) {
    if (load) A(IF(banked, "(call $set_priv (local.get $e))", IF(hasSpsr(), spsrRestore())));
    else A("(call $set_priv (local.get $e))");
  }
  A(ARM_LOAD_POST_NOPC);
  if (load) A(IF(OR_(pcIn, NOT(nonempty)), writePcByMode()));
  return out.join("");
}

const ALU_RE = /^(AND|EOR|SUB|RSB|ADD|ADC|SBC|RSC|TST|TEQ|CMP|CMN|ORR|MOV|BIC|MVN)(S?)(_LSL|_LSR|_ASR|_ROR|I)$/;
const MULS = new Set(["MUL", "MULS", "MLA", "MLAS", "SMLAL", "SMLALS", "SMULL", "SMULLS",
  "UMLAL", "UMLALS", "UMULL", "UMULLS"]);

/**
 * Body of one ARM handler (after the condition test and prefetch prologue).
 * @param {string} name @param {G} g @returns {string}
 */
export function arm(name, g) {
  const f = (lo, n) => g.f(lo, n);
  if (ALU_RE.test(name)) return alu(name, g);
  if (MULS.has(name)) return mul(name, g);
  if (name.startsWith("LDM") || name.startsWith("STM")) return armLsm(name, g);
  if (name.startsWith("LDR") || name.startsWith("STR")) return armLs(name, g);
  if (name === "SWP" || name === "SWPB") {
    const [s1, rm] = g.hold("rm", f(0, 4));
    const [s2, rd] = g.hold("rd", f(12, 4));
    const [s3, rn] = g.hold("rn", f(16, 4));
    const [ld, st] = name === "SWP" ? ["$ld32", "$st32"] : ["$ld8", "$st8"];
    return s1 + s2 + s3 + `(local.set $d (call ${ld} ${R(rn)} (i32.const 1)))`
      + `(call ${st} ${R(rn)} ${R(rm)} (i32.const 1))` + W(rd, "(local.get $d)");
  }
  if (name === "B" || name === "BL") {
    const offe = g.static ? `(i32.const ${(g.op << 8) >> 6})`
      : "(i32.shr_s (i32.shl (local.get $op) (i32.const 8)) (i32.const 6))";
    const lr = name === "BL" ? W(14, `(i32.sub ${R(15)} (i32.const 4))`) : "";
    return lr + W(15, `(i32.add ${R(15)} ${offe})`) + writePcArm();
  }
  if (name === "BX") {
    const [s1, rm] = g.hold("rm", f(0, 4));
    return s1 + `(local.set $a ${R(rm)})`
      + "(call $set_exec_mode (i32.and (local.get $a) (i32.const 1)))"
      + W(15, "(i32.and (local.get $a) (i32.const -2))") + writePcByMode();
  }
  if (name === "MRS" || name === "MRSR") {
    const [s1, rd] = g.hold("rd", f(12, 4));
    const src = name === "MRS" ? "(call $pack_cpsr)" : "(global.get $spsr)";
    return s1 + W(rd, src);
  }
  if (["MSR", "MSRI", "MSRR", "MSRRI"].includes(name)) {
    let opnd;
    if (name === "MSR" || name === "MSRR") {
      const [s1, rm] = g.hold("rm", f(0, 4));
      opnd = s1 + `(local.set $a ${R(rm)})`;
    } else {
      const rot = f(8, 4), imm = f(0, 8);
      if (g.static) {
        const r = /** @type {number} */ (rot) << 1;
        const v = r ? rotr32(/** @type {number} */ (imm), r) : imm;
        opnd = `(local.set $a (i32.const ${v}))`;
      } else {
        opnd = `(local.set $a (i32.rotr ${imm} (i32.shl ${rot} (i32.const 1))))`;
      }
    }
    const cbit = g.bit(16), fbit = g.bit(19);
    let maskc;
    if (g.static) maskc = `(i32.const ${((cbit ? 0xFF : 0) | (fbit ? 0xFF000000 : 0)) >>> 0})`;
    else {
      maskc = `(i32.or (i32.mul ${cbit} (i32.const 255)) `
        + `(i32.mul ${fbit} (i32.const -16777216)))`;
    }
    const fn = name === "MSR" || name === "MSRI" ? "$msr_cpsr" : "$msr_spsr";
    return opnd + `(call ${fn} (local.get $a) ${maskc})`;
  }
  if (name === "SWI") return `(call $swi16 ${K(f(16, 8))})`;
  const opv = g.static ? K(g.op) : "(local.get $op)";
  if (name === "LDC" || name === "STC") return ""; // ARM_STUB: logged only
  if (name === "MRC" || name === "MCR" || name === "CDP") {
    // Coprocessors on the GBA core: cp0 CDP (a no-op log) and cp14 MRC/MCR
    // (read returns the open bus). Everything else is ARM_ILL.
    const cp = f(8, 4);
    if (name === "CDP") return IF(EQ(cp, 0), "", `(call $illegal ${opv})`);
    if (name === "MCR") return IF(EQ(cp, 14), "", `(call $illegal ${opv})`);
    const [s1, rd] = g.hold("rd", f(12, 4));
    return s1 + IF(EQ(cp, 14), W(rd, "(call $load_bad)"), `(call $illegal ${opv})`);
  }
  if (name === "ILL") return `(call $illegal ${opv})`;
  if (name === "BKPT") return "(call $raise_undef)(global.set $cc (i32.const 0))";
  throw new Error(`gba cpu: no ARM handler '${name}'`);
}
