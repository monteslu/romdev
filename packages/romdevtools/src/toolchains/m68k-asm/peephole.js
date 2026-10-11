// Instruction selection for the m68k-asm front end.
//
// Motorola-syntax 68k assemblers traditionally pick a shorter or faster
// encoding when an operand's value allows it - `clr.l d0` becomes `moveq #0`,
// `adda.w #4,a0` becomes `addq.w #4,a0`, `lea (4,a0),a0` becomes `addq.l`,
// `move.l #$1000,a0` becomes `movea.w`, `cmp #0` becomes `tst`, and so on -
// and they encode `add/sub/cmp/and/or #imm,Dn` as the register form (opcode
// $D07C for `add.w #x,d0`) where GNU as picks the ADDI/SUBI/... form. The
// Genesis sources romdev ships and the ROMs its users built were laid out by
// those rules, so this module reproduces them on top of GNU as: each rule
// below rewrites one instruction before GNU as sees it.
//
// Every rule only changes the encoding, never the result in the destination;
// rules that need an operand's value use the folded constant or, for a label,
// its address from the previous layout pass (the address only chooses the
// encoding; the operand is still emitted symbolically, so a stale address can
// cost a byte, never correctness).
//
// Plain JS ESM + JSDoc.

/** @typedef {import("./operand.js").Operand} Operand */
/** @typedef {import("./expr.js").Expr} Expr */

const SIZE_BITS = { b: 0x00, w: 0x40, l: 0x80 };
const REG_FORM = { add: 0xd000, sub: 0x9000, cmp: 0xb000, and: 0xc000, or: 0x8000 };

const fitsWord = (v) => v >= -32768 && v <= 32767;
const fitsQuick = (v) => v >= 1 && v <= 8;
const isDn = (op) => op?.k === "reg" && /^[dD][0-7]$/.test(op.text);
const isAn = (op) => op?.k === "reg" && /^(?:[aA][0-7]|[sS][pP]|[fF][pP])$/.test(op.text);
const isCcrSr = (op) => op?.k === "reg" && /^(?:ccr|sr)$/i.test(op.text);
const regNum = (op) => {
  const t = op.text.toLowerCase();
  if (t === "sp") return 7;
  if (t === "fp") return 6;
  return Number(t[1]);
};
const sext16 = (v) => ((v & 0xffff) ^ 0x8000) - 0x8000;

/**
 * @param {Object} st      the instruction statement {mnem, size, ops}
 * @param {Object} ctx
 * @param {(e:Expr)=>number|undefined} ctx.val    value of an expression (constant, or label address hint)
 * @param {(e:Expr)=>boolean} ctx.isConst         true when the expression is a plain constant
 * @param {(op:Operand)=>string} ctx.op           print an operand
 * @param {(e:Expr)=>string} ctx.ex               print an expression
 * @returns {string[]|null}  replacement lines (empty = drop the instruction), or null for no change
 */
export function peephole(st, ctx) {
  const m = st.mnem;
  const ops = st.ops;
  const size = st.size;
  const imm = ops[0]?.k === "imm" ? ops[0] : null;
  const v = imm ? ctx.val(imm.e) : undefined;
  const sz = (d) => size ?? d;

  // clr.l Dn → moveq #0,Dn
  if (m === "clr" && size === "l" && ops.length === 1 && isDn(ops[0])) {
    return [`moveq\t#0,${ctx.op(ops[0])}`];
  }

  // move.l / movea.? #x,An
  if ((m === "move" || m === "movea") && imm && ops.length === 2 && isAn(ops[1]) && v !== undefined) {
    const s = sz("w");
    if (v === 0 || (s === "w" && sext16(v) === 0)) return [`suba.l\t${ctx.op(ops[1])},${ctx.op(ops[1])}`];
    if (s === "l" && fitsWord(v)) return [`movea.w\t#${ctx.ex(imm.e)},${ctx.op(ops[1])}`];
  }

  // move.l #x,Dn - moveq and its two-instruction forms
  if (m === "move" && size === "l" && imm && ops.length === 2 && isDn(ops[1]) && v !== undefined) {
    const d = ctx.op(ops[1]);
    if (v >= -128 && v <= 127) return [`moveq\t#${ctx.ex(imm.e)},${d}`];
    if (ctx.isConst(imm.e)) {
      if ((v & 1) === 0 && (v >> 1) >= -128 && (v >> 1) <= 127) return [`moveq\t#${v >> 1},${d}`, `add.w\t${d},${d}`];
      const hi = v >> 16, lo = v & 0xffff;
      if (lo === 0 && hi >= 1 && hi <= 127) return [`moveq\t#${hi},${d}`, `swap\t${d}`];
      if (lo === 0xffff && hi >= -128 && hi <= -2) return [`moveq\t#${hi},${d}`, `swap\t${d}`];
    }
  }

  // adda/suba/add/sub #x,An
  if ((m === "adda" || m === "suba" || m === "add" || m === "sub") && imm && ops.length === 2 && isAn(ops[1]) && v !== undefined) {
    const s = sz("w");
    const a = ctx.op(ops[1]);
    const eff = s === "w" ? sext16(v) : v;
    const add = m === "adda" || m === "add";
    if (eff === 0) return [];
    if (fitsQuick(v) && fitsQuick(eff)) return [`${add ? "addq" : "subq"}.${s}\t#${ctx.ex(imm.e)},${a}`];
    // lea (d,An),An when the written value fits a word (`adda.w #$ffff` stays
    // as it is; `suba.w #$8000` too, since its sign-extended meaning is +32768)
    const delta = add ? v : -v;
    if (fitsWord(delta) && (add || s === "l" || fitsWord(v))) {
      const disp = ctx.isConst(imm.e) ? String(delta) : add ? ctx.ex(imm.e) : `-(${ctx.ex(imm.e)})`;
      return [`lea\t(${disp},${a}),${a}`];
    }
  }

  // cmp/cmpa.l #x,An → cmpa.w
  if ((m === "cmp" || m === "cmpa") && size === "l" && imm && ops.length === 2 && isAn(ops[1]) && v !== undefined && fitsWord(v)) {
    return [`cmpa.w\t#${ctx.ex(imm.e)},${ctx.op(ops[1])}`];
  }

  if (imm && ops.length === 2 && !isAn(ops[1]) && !isCcrSr(ops[1]) && v !== undefined) {
    const s = sz("w");
    const dst = ctx.op(ops[1]);
    const val = s === "b" ? ((v & 0xff) ^ 0x80) - 0x80 : s === "w" ? sext16(v) : v;
    if ((m === "addi" || m === "subi") && fitsQuick(v)) return [`${m === "addi" ? "addq" : "subq"}.${s}\t#${ctx.ex(imm.e)},${dst}`];
    if ((m === "add" || m === "sub") && fitsQuick(v)) return [`${m === "add" ? "addq" : "subq"}.${s}\t#${ctx.ex(imm.e)},${dst}`];
    if ((m === "cmp" || m === "cmpi") && val === 0) return [`tst.${s}\t${dst}`];
    if ((m === "or" || m === "ori") && val === 0) return [`tst.${s}\t${dst}`];
    if ((m === "eor" || m === "eori") && val === 0) return [`tst.${s}\t${dst}`];
    if ((m === "eor" || m === "eori") && val === -1) return [`not.${s}\t${dst}`];
    // andi only when the operand is written as the all-ones mask of its size
    // ($ff/$ffff/-1); `andi.w #-1` is left alone, as the classic assemblers do
    if ((m === "andi" || (m === "and" && !isDn(ops[1]))) && v === { b: 0xff, w: 0xffff, l: -1 }[s]) return [`tst.${s}\t${dst}`];
  }

  // add/sub/cmp/and/or #imm,Dn: register form, encoded directly
  if (REG_FORM[m] !== undefined && imm && ops.length === 2 && isDn(ops[1])) {
    const s = sz("w");
    if (SIZE_BITS[s] === undefined) return null;
    if (v !== undefined && (s === "b" ? v < -128 || v > 255 : s === "w" ? v < -32768 || v > 65535 : false)) return null; // out of range: reported by the caller
    if ((m === "add" || m === "sub") && v !== undefined && fitsQuick(v)) {
      return [`${m === "add" ? "addq" : "subq"}.${s}\t#${ctx.ex(imm.e)},${ctx.op(ops[1])}`];
    }
    const opcode = REG_FORM[m] | (regNum(ops[1]) << 9) | SIZE_BITS[s] | 0x3c;
    const out = [`.word\t0x${opcode.toString(16)}`];
    if (s === "b") {
      if (ctx.isConst(imm.e)) out.push(`.word\t0x${(v & 0xff).toString(16)}`);
      else out.push(`.byte\t0`, `.byte\t${ctx.ex(imm.e)}`);
    } else if (s === "w") {
      out.push(ctx.isConst(imm.e) ? `.word\t0x${(v & 0xffff).toString(16)}` : `.word\t${ctx.ex(imm.e)}`);
    } else {
      out.push(ctx.isConst(imm.e) ? `.long\t0x${(v >>> 0).toString(16)}` : `.long\t${ctx.ex(imm.e)}`);
    }
    return out;
  }

  // lea forms on the same register
  if (m === "lea" && ops.length === 2 && isAn(ops[1])) {
    const a = ops[1];
    const an = ctx.op(a);
    if (ops[0].k === "abs" && !ops[0].size && ctx.isConst(ops[0].e) && ctx.val(ops[0].e) === 0) return [`suba.l\t${an},${an}`];
    const same = (r) => r && r.toLowerCase().replace(/^sp$/, "a7").replace(/^fp$/, "a6") === an.replace(/^sp$/, "a7").replace(/^fp$/, "a6");
    if (ops[0].k === "ind" && same(ops[0].reg)) return [];
    if (ops[0].k === "disp" && !ops[0].index && same(ops[0].base) && ops[0].e) {
      const d = ctx.val(ops[0].e);
      if (d === 0) return [];
      if (d !== undefined && fitsQuick(d)) return [`addq.l\t#${ctx.ex(ops[0].e)},${an}`];
      if (d !== undefined && fitsQuick(-d)) return [`subq.l\t#${-d},${an}`];
    }
  }

  // asl.? #1,Dn → add.? Dn,Dn
  if (m === "asl" && imm && ops.length === 2 && isDn(ops[1]) && v === 1) {
    const d = ctx.op(ops[1]);
    return [`add.${sz("w")}\t${d},${d}`];
  }

  // movem loading a single address register → move
  if (m === "movem" && ops.length === 2) {
    const one = ops[1].k === "reg" && isAn(ops[1]) ? ops[1] : (ops[1].k === "reglist" && /^(?:[aA][0-7]|[sS][pP]|[fF][pP])$/.test(ops[1].text) ? { k: "reg", text: ops[1].text } : null);
    if (one && ops[0].k !== "reg" && ops[0].k !== "reglist") return [`move.${sz("w")}\t${ctx.op(ops[0])},${ctx.op(one)}`];
  }

  return null;
}
