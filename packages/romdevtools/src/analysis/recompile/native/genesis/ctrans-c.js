// C partial evaluator over genesis_plus_gx's own 68000 handlers.
//
// The same evaluation as ../../wat/genesis/ctrans.js (which emits WAT): each
// Musashi handler is specialised for ONE opcode word at ONE address. REG_IR
// is a constant (so DX/DY/AY resolve to fixed registers), immediates and
// extension words are read from the ROM, absolute and PC-relative addresses
// fold to constants, movem's register list unrolls, and what is left
// (registers, the raw Musashi flags, memory, cycles) becomes C over gpgx's
// real `m68k` struct. The output is compiled next to Musashi (m68kcpu.h is
// included), so helper calls go to Musashi's own inline functions:
// m68ki_read_16 still checks for address errors and m68ki_set_sr still takes
// pending interrupts, exactly as the interpreter does.
//
// Every value is a uint32 C expression holding the 32-bit pattern, as an i32
// is in WAT; the C integer type the source had is tracked beside it and
// decides signed/unsigned shifts, compares, division and narrowing - the
// same rules ctrans.js applies. Shift counts are masked to 5 bits like
// WebAssembly's (the reference core is WASM).
//
// LICENSE: the output is code derived from Genesis Plus GX (non-commercial).
//
// Plain JS ESM + JSDoc.

import { TrError, norm, U32, I32, U16, I16, U8, I8, PTR } from "../../wat/genesis/ctrans.js";

const promote = (t) => (t.b < 32 ? I32 : t);
function usual(a, b) {
  a = promote(a);
  b = promote(b);
  if (a === U32 || b === U32) return U32;
  return I32;
}

const hex = (v) => "0x" + (v >>> 0).toString(16) + "u";

/** A value: constant (c), C expression (w) or pointer (ptr). */
class V {
  constructor(c = null, w = null, t = I32, ptr = null) {
    this.c = c;
    this.w = w;
    this.t = t;
    this.ptr = ptr;
  }
  e() {
    if (this.ptr !== null) throw new TrError("pointer used as value");
    if (this.c !== null) return hex(this.c);
    return this.w;
  }
}
const cv = (v, t = I32) => new V(norm(v, t), null, t);
const vw = (w, t) => new V(null, w, t);
const vp = (p) => new V(null, null, I32, p);

function ptrEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a === "string" || typeof b === "string") return false;
  if (a.k !== b.k) return false;
  if (a.k === "arr") return a.arr === b.arr && a.off === b.off;
  if (a.k === "table") return a.name === b.name;
  return a.addr === b.addr;
}
function ptrStr(p) {
  if (typeof p === "string") return p;
  throw new TrError("pointer to non-register");
}

// Musashi fields -> C lvalues (the ones ctrans.js keeps as WAT globals)
const GLOBAL_FIELDS = {
  cycles: "m68k.cycles", refresh_cycles: "m68k.refresh_cycles", cycle_end: "m68k.cycle_end",
  x_flag: "m68k.x_flag", n_flag: "m68k.n_flag", not_z_flag: "m68k.not_z_flag", v_flag: "m68k.v_flag", c_flag: "m68k.c_flag",
  s_flag: "m68k.s_flag", int_mask: "m68k.int_mask", int_level: "m68k.int_level", stopped: "m68k.stopped",
  t1_flag: "m68k.t1_flag", instr_mode: "m68k.instr_mode", run_mode: "m68k.run_mode", aerr_enabled: "m68k.aerr_enabled",
};
/** signed int fields: read through (uint32), written through (int). */
const SIGNED_FIELDS = new Set(["m68k.cycles", "m68k.refresh_cycles"]);
const readField = (f) => (SIGNED_FIELDS.has(f) ? `((uint32)${f})` : f);

// Musashi helpers called, not inlined: [C name, argc, returns]
const RUNTIME = {
  m68ki_read_8: ["m68ki_read_8", 1, true], m68ki_read_16: ["m68ki_read_16", 1, true],
  m68ki_read_32: ["m68ki_read_32", 1, true],
  m68ki_write_8: ["m68ki_write_8", 2, false], m68ki_write_16: ["m68ki_write_16", 2, false],
  m68ki_write_32: ["m68ki_write_32", 2, false],
  __raw8: ["RD_RAW8", 1, true], __raw16: ["RD_RAW16", 1, true],
  m68ki_set_s_flag: ["m68ki_set_s_flag", 1, false],
  m68ki_set_sr: ["m68ki_set_sr", 1, false],
  m68ki_check_interrupts: ["m68ki_check_interrupts", 0, false],
  UseDivuCycles: ["rd_UseDivuCycles", 2, false], UseDivsCycles: ["rd_UseDivsCycles", 2, false],
  UseMuluCycles: ["rd_UseMuluCycles", 1, false], UseMulsCycles: ["rd_UseMulsCycles", 1, false],
};
const PC_MOVERS = new Set(["m68ki_set_sr", "m68ki_check_interrupts"]);
/** Calls that reach I/O handlers (a write may re-enter the CPU, see blocks.js). */
const WRITES = new Set(["m68ki_write_8", "m68ki_write_16", "m68ki_write_32"]);

const CTYPES = {
  "unsigned int": U32, unsigned: U32, int: I32, "signed int": I32,
  short: I16, "signed short": I16, "unsigned short": U16,
  char: I8, char_s: I8, "signed char": I8, "unsigned char": U8,
  uint: U32, sint: I32, uint32: U32, sint32: I32, uint16: U16,
  sint16: I16, uint8: U8, sint8: I8, long: I32, "unsigned long": U32,
  cpu_memory_map: I32,
};
function ctypeOf(node) {
  if (node.k === "PtrDecl") return PTR;
  if (node.k === "TypeDecl") return ctypeOf(node.type);
  if (node.k === "IdentifierType") {
    const n = node.names.join(" ");
    const t = CTYPES[n];
    if (!t) throw new TrError(`type ${n}`);
    return t;
  }
  if (node.k === "Typename") return ctypeOf(node.type);
  throw new TrError(`type ${node.k}`);
}

const BIN = { "+": "+", "-": "-", "*": "*", "&": "&", "|": "|", "^": "^" };

function fold(op, x, y, t) {
  let r;
  switch (op) {
    case "+": r = x + y; break;
    case "-": r = x - y; break;
    case "*": r = Math.imul(x, y); break;
    case "&": r = x & y; break;
    case "|": r = x | y; break;
    case "^": r = x ^ y; break;
    case "<<": r = (x >>> 0) << (y & 31); break;
    case ">>": r = t.s ? x >> (y & 31) : (x >>> 0) >>> (y & 31); break;
    case "/":
      if (y === 0) throw new TrError("div0");
      r = t.s ? Math.trunc(x / y) : Math.floor((x >>> 0) / (y >>> 0));
      break;
    case "%":
      if (y === 0) throw new TrError("mod0");
      r = t.s ? x - Math.trunc(x / y) * y : (x >>> 0) % (y >>> 0);
      break;
    default: throw new TrError(op);
  }
  return norm(r, t);
}

function conv(v, t) {
  if (v.ptr !== null) return v;
  if (v.c !== null) return new V(norm(v.c, t), null, t);
  if (t.b === 32) return vw(v.w, t);
  if (t === U16) return vw(`(${v.w} & 0xffffu)`, t);
  if (t === U8) return vw(`(${v.w} & 0xffu)`, t);
  if (t === I16) return vw(`((uint32)(int32)(int16_t)${v.w})`, t);
  if (t === I8) return vw(`((uint32)(int32)(int8_t)${v.w})`, t);
  throw new TrError(`conv ${t.n}`);
}

const TMP_RE = /^t\d+$/;

/** Partial-evaluator state for one opcode at one address. */
export class CArm {
  constructor(ir, pc, fetch16, tables, prefix) {
    this.ir = ir;
    this.pc = pc + 2;
    this.flushed = null;
    this.fetch16 = fetch16;
    this.tables = tables;
    this.prefix = prefix;
    this.locals = [];
    this.n = 0;
    this.stmts = [];
    this.usesRead = false;
    this.writes = 0;
    this.calls = 0;
    this.pcMoved = false;
    this.maxPc = pc + 2;
    this.condDepth = 0;
  }
  tmp() {
    this.n += 1;
    const nm = `t${this.n}`;
    this.locals.push(nm);
    return nm;
  }
  emit(s) {
    this.stmts.push(s);
  }
  mat(v) {
    if (v.c !== null || v.ptr !== null) return v;
    if (TMP_RE.test(v.w)) return v;
    const t = this.tmp();
    this.emit(`${t} = ${v.w};`);
    return vw(t, v.t);
  }
  flushPc() {
    if (this.pc !== null && this.flushed !== this.pc) {
      this.emit(`m68k.pc = ${hex(this.pc)};`);
      this.flushed = this.pc;
    }
  }
  state() {
    return [this.pc, this.flushed];
  }
}
const stEq = (a, b) => a[0] === b[0] && a[1] === b[1];

class Scope {
  constructor(parent = null) {
    this.vars = new Map();
    this.parent = parent;
  }
  find(name) {
    for (let s = this; s; s = s.parent) {
      const e = s.vars.get(name);
      if (e) return e;
    }
    return null;
  }
}

/** Musashi handler translator (C). */
export class CTr {
  /** @param {CArm} arm @param {(name:string)=>any} astOf */
  constructor(arm, astOf) {
    this.a = arm;
    this.astOf = astOf;
    this.inl = 0;
  }

  lbl(name) { return `${this.a.prefix}${name}`; }

  lval(node, sc) {
    if (node.k === "ID") {
      const ent = sc.find(node.name);
      if (!ent) throw new TrError(`unknown lvalue ${node.name}`);
      return ["var", ent];
    }
    if (node.k === "StructRef") {
      const f = this.field(node);
      if (f === "pc") return ["pc"];
      return ["glob", f, U32];
    }
    if (node.k === "ArrayRef") return ["glob", this.ptrOfArrayref(node, sc), U32];
    if (node.k === "UnaryOp" && node.op === "*") {
      const pv = this.expr(node.expr, sc);
      if (pv.ptr === null) throw new TrError("deref non-pointer");
      return ["glob", pv.ptr, U32];
    }
    throw new TrError(`lvalue ${node.k}`);
  }

  field(node) {
    if (node.name.k === "StructRef") {
      // m68k.poll.detected and friends: gpgx's bus-poll detection state (the
      // WAT backend drops these; here they are the real struct fields)
      const path = [];
      let n = node;
      while (n.k === "StructRef") { path.unshift(n.field.name); n = n.name; }
      if (!(n.k === "ID" && n.name === "m68k") || path[0] !== "poll") throw new TrError("nested struct field");
      return `m68k.${path.join(".")}`;
    }
    const base = node.name;
    if (!(base.k === "ID" && base.name === "m68k")) throw new TrError("structref base");
    const f = node.field.name;
    if (f === "pc" || f === "ir") return f;
    if (f in GLOBAL_FIELDS) return GLOBAL_FIELDS[f];
    throw new TrError(`field ${f}`);
  }

  regGlobal(arr, idx) {
    if (arr === "dar") {
      if (!(idx >= 0 && idx < 16)) throw new TrError("dar idx");
      return `m68k.dar[${idx}]`;
    }
    if (arr === "sp") {
      if (!(idx >= 0 && idx < 5)) throw new TrError("sp idx");
      return `m68k.sp[${idx}]`;
    }
    throw new TrError(arr);
  }

  ptrOfArrayref(node, sc) {
    const base = node.name;
    const idx = this.expr(node.subscript, sc);
    if (idx.c === null) throw new TrError("dynamic register index");
    if (base.k === "StructRef" && base.name.k === "ID" && base.name.name === "m68k") {
      return this.regGlobal(base.field.name, idx.c);
    }
    const bv = this.expr(base, sc);
    if (bv.ptr && typeof bv.ptr === "object") {
      if (bv.ptr.k !== "arr") throw new TrError("arrayref base");
      return this.regGlobal(bv.ptr.arr, bv.ptr.off + idx.c);
    }
    throw new TrError("arrayref base");
  }

  readLv(lv) {
    const a = this.a;
    if (lv[0] === "var") {
      const ent = lv[1];
      if (ent.ptr !== null) return vp(ent.ptr);
      if (ent.c !== null) return new V(ent.c, null, ent.t);
      return vw(ent.c_name, ent.t);
    }
    if (lv[0] === "pc") {
      if (a.pc !== null) return cv(a.pc, U32);
      return vw("m68k.pc", U32);
    }
    if (lv[0] === "glob") return vw(readField(ptrStr(lv[1])), lv[2]);
    throw new TrError("read_lv");
  }

  writeLv(lv, v) {
    const a = this.a;
    if (lv[0] === "var") {
      const ent = lv[1];
      if (ent.t === PTR) {
        if (v.ptr === null) throw new TrError("ptr assign");
        ent.ptr = v.ptr;
        return v;
      }
      v = conv(v, ent.t);
      if (v.c !== null) {
        ent.c = v.c;
        if (a.condDepth) {
          a.emit(`${ent.c_name} = ${v.e()};`);
          ent.stale = false;
        } else {
          ent.stale = true;
        }
        return v;
      }
      ent.c = null;
      ent.stale = false;
      a.emit(`${ent.c_name} = ${v.e()};`);
      return vw(ent.c_name, ent.t);
    }
    if (lv[0] === "pc") {
      v = conv(v, U32);
      if (v.c !== null) {
        a.pc = v.c >>> 0;
        return v;
      }
      a.emit(`m68k.pc = ${v.e()};`);
      a.pc = null;
      a.flushed = null;
      return vw("m68k.pc", U32);
    }
    if (lv[0] === "glob") {
      v = conv(v, lv[2]);
      const f = ptrStr(lv[1]);
      a.emit(SIGNED_FIELDS.has(f) ? `${f} = (int)${v.e()};` : `${f} = ${v.e()};`);
      if (v.c !== null) return v;
      return vw(readField(f), lv[2]);
    }
    throw new TrError("write_lv");
  }

  expr(node, sc) {
    const a = this.a;
    if (node === null || node === undefined) throw new TrError("expr NoneType");
    switch (node.k) {
      case "Constant": return constant(node);
      case "ID": {
        const ent = sc.find(node.name);
        if (ent) return this.readLv(["var", ent]);
        if (Object.hasOwn(a.tables, node.name)) return vp({ k: "table", name: node.name });
        throw new TrError(`unknown id ${node.name}`);
      }
      case "StructRef": {
        if (node.name.k === "ID" && node.name.name === "m68k" && (node.field.name === "dar" || node.field.name === "sp")) {
          return vp({ k: "arr", arr: node.field.name, off: 0 });
        }
        const f = this.field(node);
        if (f === "ir") return cv(a.ir, U32);
        if (f === "pc") return this.readLv(["pc"]);
        return vw(readField(f), U32);
      }
      case "ArrayRef": {
        const base = node.name;
        if (base.k === "ID" && Object.hasOwn(a.tables, base.name)) {
          const idx = this.expr(node.subscript, sc);
          const tab = a.tables[base.name];
          if (idx.c !== null) {
            const i = idx.c < 0 ? tab.length + idx.c : idx.c;
            if (i < 0 || i >= tab.length) throw new TrError(`table index ${base.name}[${idx.c}]`);
            return cv(tab[i], I32);
          }
          return vw(`((uint32)${base.name}[${idx.e()}])`, I32);
        }
        return this.readLv(["glob", this.ptrOfArrayref(node, sc), U32]);
      }
      case "Cast": {
        const t = ctypeOf(node.to_type);
        const v = this.expr(node.expr, sc);
        if (t === PTR) return v;
        return conv(v, t);
      }
      case "UnaryOp": return this.unary(node, sc);
      case "BinaryOp": return this.binary(node, sc);
      case "Assignment": return this.assign(node, sc);
      case "TernaryOp": {
        const c = this.expr(node.cond, sc);
        if (c.c !== null) return this.expr(c.c ? node.iftrue : node.iffalse, sc);
        const st0 = a.state();
        const sv = a.stmts;
        a.stmts = [];
        a.condDepth += 1;
        const x = this.expr(node.iftrue, sc);
        const xs = a.stmts;
        a.stmts = [];
        const st1 = a.state();
        [a.pc, a.flushed] = st0;
        const y = this.expr(node.iffalse, sc);
        a.condDepth -= 1;
        const ys = a.stmts;
        a.stmts = sv;
        if (!stEq(a.state(), st1)) throw new TrError("ternary pc divergence");
        const t = usual(x.t, y.t);
        const arm = (ss, v) => (ss.length ? `({ ${ss.join(" ")} ${conv(v, t).e()}; })` : conv(v, t).e());
        return vw(`((${c.e()}) ? ${arm(xs, x)} : ${arm(ys, y)})`, t);
      }
      case "FuncCall": return this.call(node, sc);
      case "ExprList": {
        let v = null;
        for (const e of node.exprs) v = this.expr(e, sc);
        return v;
      }
      default: throw new TrError(`expr ${node.k}`);
    }
  }

  unary(node, sc) {
    const a = this.a;
    const op = node.op;
    if (op === "&") {
      const e = node.expr;
      if (e.k === "ArrayRef") return vp(this.ptrOfArrayref(e, sc));
      if (e.k === "StructRef") return vp(this.field(e));
      throw new TrError("address-of");
    }
    if (op === "*") {
      const pv = this.expr(node.expr, sc);
      if (pv.ptr === null || typeof pv.ptr !== "string") throw new TrError("deref");
      return vw(readField(pv.ptr), U32);
    }
    if (op === "p++" || op === "p--" || op === "++" || op === "--") {
      const lv = this.lval(node.expr, sc);
      let old = this.readLv(lv);
      if (old.ptr !== null) throw new TrError("ptr incdec");
      const post = op[0] === "p";
      old = post ? a.mat(old) : old;
      const nv = this.arith(op.includes("+") ? "+" : "-", old, cv(1));
      const stored = this.writeLv(lv, nv);
      return post ? old : stored;
    }
    const v = this.expr(node.expr, sc);
    if (op === "-") {
      const t = promote(v.t);
      if (v.c !== null) return cv(-v.c, t);
      return vw(`(0u - ${v.e()})`, t);
    }
    if (op === "~") {
      const t = promote(v.t);
      if (v.c !== null) return cv(~v.c, t);
      return vw(`(~${v.e()})`, t);
    }
    if (op === "!") {
      if (v.c !== null) return cv(v.c ? 0 : 1);
      return vw(`((uint32)!${v.e()})`, I32);
    }
    if (op === "+") return new V(v.c, v.w, promote(v.t));
    throw new TrError(`unary ${op}`);
  }

  arith(op, x, y) {
    if (x.ptr !== null && (op === "+" || op === "-")) {
      if (y.c === null) throw new TrError("dyn ptr arith");
      const base = x.ptr;
      if (typeof base === "string") throw new TrError("ptr arith on reg");
      if (base.k !== "arr") throw new TrError("ptr arith");
      return vp({ k: "arr", arr: base.arr, off: base.off + (op === "+" ? y.c : -y.c) });
    }
    if (op === "<<" || op === ">>") {
      const t = promote(x.t);
      if (x.c !== null && y.c !== null) return cv(fold(op, x.c, y.c, t), t);
      const cnt = y.c !== null ? String(y.c & 31) : `(${y.e()} & 31u)`;
      if (op === "<<") return vw(`(${x.e()} << ${cnt})`, t);
      return vw(t.s ? `((uint32)((int32)${x.e()} >> ${cnt}))` : `(${x.e()} >> ${cnt})`, t);
    }
    const t = usual(x.t, y.t);
    if (x.c !== null && y.c !== null) return cv(fold(op, x.c, y.c, t), t);
    if (op in BIN) {
      if (op === "&" && ((x.c !== null && x.c === 0) || (y.c !== null && y.c === 0))) return cv(0, t);
      return vw(`(${x.e()} ${BIN[op]} ${y.e()})`, t);
    }
    if (op === "/") return vw(t.s ? `((uint32)((int32)${x.e()} / (int32)${y.e()}))` : `(${x.e()} / ${y.e()})`, t);
    if (op === "%") return vw(t.s ? `((uint32)((int32)${x.e()} % (int32)${y.e()}))` : `(${x.e()} % ${y.e()})`, t);
    throw new TrError(`arith ${op}`);
  }

  binary(node, sc) {
    const a = this.a;
    const op = node.op;
    if (op === "&&" || op === "||") {
      const x = this.expr(node.left, sc);
      if (x.c !== null) {
        if ((op === "&&" && !x.c) || (op === "||" && x.c)) return cv(op === "&&" ? 0 : 1);
        const y = this.expr(node.right, sc);
        if (y.c !== null) return cv(y.c ? 1 : 0);
        return vw(`((uint32)(${y.e()} != 0u))`, I32);
      }
      const sv = a.stmts;
      a.stmts = [];
      const st0 = a.state();
      a.condDepth += 1;
      const y = this.expr(node.right, sc);
      a.condDepth -= 1;
      const ys = a.stmts;
      a.stmts = sv;
      if (!stEq(a.state(), st0)) throw new TrError("&& pc divergence");
      const yb = ys.length ? `({ ${ys.join(" ")} (uint32)(${y.e()} != 0u); })` : `((uint32)(${y.e()} != 0u))`;
      if (op === "&&") return vw(`((${x.e()}) ? ${yb} : 0u)`, I32);
      return vw(`((${x.e()}) ? 1u : ${yb})`, I32);
    }
    let x = this.expr(node.left, sc);
    const mark = a.stmts.length;
    const y = this.expr(node.right, sc);
    if (a.stmts.length !== mark && x.c === null && x.ptr === null) {
      const t = a.tmp();
      a.stmts.splice(mark, 0, `${t} = ${x.w};`);
      x = vw(t, x.t);
    }
    if (op === "==" || op === "!=" || op === "<" || op === ">" || op === "<=" || op === ">=") {
      const t = usual(x.t, y.t);
      if (x.c !== null && y.c !== null) {
        const xa = norm(x.c, t), ya = norm(y.c, t);
        const r = op === "==" ? xa === ya : op === "!=" ? xa !== ya : op === "<" ? xa < ya
          : op === ">" ? xa > ya : op === "<=" ? xa <= ya : xa >= ya;
        return cv(r ? 1 : 0);
      }
      if (op === "==" || op === "!=" || !t.s) return vw(`((uint32)(${x.e()} ${op} ${y.e()}))`, I32);
      return vw(`((uint32)((int32)${x.e()} ${op} (int32)${y.e()}))`, I32);
    }
    return this.arith(op, x, y);
  }

  assign(node, sc) {
    const a = this.a;
    const lv = this.lval(node.lvalue, sc);
    if (node.op === "=") return this.writeLv(lv, this.expr(node.rvalue, sc));
    const op = node.op.slice(0, -1);
    let old = this.readLv(lv);
    const mark = a.stmts.length;
    const r = this.expr(node.rvalue, sc);
    if (a.stmts.length !== mark && old.c === null && old.ptr === null) {
      const t = a.tmp();
      a.stmts.splice(mark, 0, `${t} = ${old.w};`);
      old = vw(t, old.t);
    }
    return this.writeLv(lv, this.arith(op, old, r));
  }

  call(node, sc) {
    const a = this.a;
    const name = node.name.k === "ID" ? node.name.name : null;
    const args = node.args ? node.args.exprs : [];
    if (name === "m68ki_read_imm_16" || name === "m68ki_read_imm_8" || name === "m68ki_read_imm_32") {
      if (a.pc === null) throw new TrError("imm read with dynamic pc");
      const w = (p) => { const x = a.fetch16(p); if (typeof x !== "number") throw new TrError("dynamic extension word"); return x; };
      let v;
      if (name === "m68ki_read_imm_32") {
        v = w(a.pc) * 0x10000 + w(a.pc + 2);
        a.pc += 4;
      } else {
        v = w(a.pc);
        if (name === "m68ki_read_imm_8") v &= 0xff;
        a.pc += 2;
      }
      if (a.pc > a.maxPc) a.maxPc = a.pc;
      return cv(v, U32);
    }
    if (name === "abs") {
      const v = a.mat(this.expr(args[0], sc));
      return vw(`(((int32)${v.e()} < 0) ? (0u - ${v.e()}) : ${v.e()})`, I32);
    }
    if (name !== null && Object.hasOwn(RUNTIME, name)) {
      const [fn, , ret] = RUNTIME[name];
      let vals = [];
      for (const x of args) vals.push(this.expr(x, sc));
      vals = vals.map((v) => (v.c === null ? a.mat(v) : v));
      if (name.startsWith("m68ki_read_") || name.startsWith("m68ki_write_")) a.usesRead = true;
      a.flushPc();
      if (WRITES.has(name)) a.writes++;
      a.calls++;
      const callText = `${fn}(${vals.map((v) => v.e()).join(", ")})`;
      if (PC_MOVERS.has(name)) {
        a.pc = null;
        a.flushed = null;
        a.pcMoved = true;
      }
      if (ret) {
        const t = a.tmp();
        a.emit(`${t} = ${callText};`);
        return vw(t, U32);
      }
      a.emit(`${callText};`);
      return cv(0);
    }
    if (name === "vdp_68k_irq_ack") throw new TrError("irq ack in handler");
    if (name === "longjmp") {
      a.emit("longjmp(m68k.aerr_trap, 1);");
      return cv(0);
    }
    return this.inline(name, args, sc);
  }

  inline(name, args, sc) {
    const a = this.a;
    const fd = this.astOf(name);
    this.inl += 1;
    const tag = this.inl;
    const scope = new Scope(null);
    const fdecl = fd.decl.type;
    const params = (fdecl.args ? fdecl.args.params : []).filter((p) => p.k !== "Typename");
    if (params.length !== args.length) throw new TrError(`${name}: arg count`);
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      let v = this.expr(args[i], sc);
      const t = ctypeOf(p.type);
      const ent = { c_name: t !== PTR ? a.tmp() : null, t, c: null, ptr: null, stale: false };
      if (t === PTR) {
        ent.ptr = v.ptr;
      } else {
        v = conv(v, t);
        if (v.c !== null) {
          ent.c = v.c;
          ent.stale = true;
        } else {
          a.emit(`${ent.c_name} = ${v.e()};`);
        }
      }
      scope.vars.set(p.name, ent);
    }
    const rettype = fdecl.type;
    const isVoid = rettype.k === "TypeDecl" && rettype.type.names && rettype.type.names.length === 1 && rettype.type.names[0] === "void";
    const ret = {
      label: this.lbl(`inl${tag}`), local: isVoid ? null : a.tmp(), used: false,
      t: isVoid ? null : ctypeOf(rettype), rv: [], states: [], handler: false,
    };
    const sv = a.stmts;
    a.stmts = [];
    const items = fd.body.block_items || [];
    let tailv = null;
    let term = false;
    const inner = new Scope(scope);
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (k === items.length - 1 && it.k === "Return" && !ret.used) {
        if (it.expr !== null) tailv = conv(this.expr(it.expr, inner), ret.t);
        break;
      }
      if (this.block(it, inner, ret)) {
        term = true;
        break;
      }
    }
    const body = a.stmts;
    a.stmts = sv;
    if (tailv !== null && !ret.used) {
      for (const s of body) a.stmts.push(s);
      return tailv;
    }
    if (ret.used) {
      const states = ret.states.concat(term ? [] : [a.state()]);
      const keys = new Set(states.map((s) => `${s[0]},${s[1]}`));
      if (keys.size > 1) throw new TrError(`${name}: divergent pc at returns`);
      if (states.length) [a.pc, a.flushed] = states[0];
      a.emit(`{ ${body.join(" ")} } ${ret.label}: ;`);
    } else {
      for (const s of body) a.stmts.push(s);
    }
    if (isVoid) return cv(0);
    const rvs = ret.rv;
    if (rvs.length && rvs.every((r) => r.c !== null) && new Set(rvs.map((r) => r.c)).size === 1) return rvs[0];
    return vw(ret.local, ret.t);
  }

  block(node, sc, ret) {
    const a = this.a;
    if (node === null || node === undefined) return false;
    switch (node.k) {
      case "Compound": {
        const inner = new Scope(sc);
        for (const it of node.block_items || []) if (this.block(it, inner, ret)) return true;
        return false;
      }
      case "Decl": {
        const t = ctypeOf(node.type);
        const ent = { c_name: null, t, c: null, ptr: null, stale: false };
        sc.vars.set(node.name, ent);
        if (t !== PTR) ent.c_name = a.tmp();
        if (node.init !== null) this.writeLv(["var", ent], this.expr(node.init, sc));
        return false;
      }
      case "Assignment": case "UnaryOp": case "FuncCall": case "BinaryOp": case "ExprList":
      case "Cast": case "ID": case "Constant": case "TernaryOp": {
        const v = this.expr(node, sc);
        if (v.c === null && v.ptr === null && v.w.includes("({")) {
          a.emit(`(void)${v.w};`);
        }
        return false;
      }
      case "EmptyStatement": return false;
      case "Return": {
        if (node.expr !== null) {
          const v = conv(this.expr(node.expr, sc), ret.t);
          ret.rv.push(v);
          a.emit(`${ret.local} = ${v.e()};`);
        }
        if (ret.handler) a.flushPc();
        ret.states.push(a.state());
        ret.used = true;
        a.emit(`goto ${ret.label};`);
        return true;
      }
      case "If": return this.ifStmt(node, sc, ret);
      case "For": {
        const inner = new Scope(sc);
        if (node.init !== null) {
          if (node.init.k === "DeclList") for (const d of node.init.decls) this.block(d, inner, ret);
          else this.expr(node.init, inner);
        }
        for (let i = 0; ; i++) {
          if (i >= 1000) throw new TrError("loop too long");
          const c = this.expr(node.cond, inner);
          if (c.c === null) throw new TrError("dynamic loop condition");
          if (!c.c) break;
          if (this.block(node.stmt, inner, ret)) throw new TrError("return inside loop");
          if (node.next !== null) this.expr(node.next, inner);
        }
        return false;
      }
      case "DoWhile": {
        if (this.block(node.stmt, sc, ret)) return true;
        const c = this.expr(node.cond, sc);
        if (c.c === null || c.c) throw new TrError("do-while");
        return false;
      }
      default: throw new TrError(`stmt ${node.k}`);
    }
  }

  ifStmt(node, sc, ret) {
    const a = this.a;
    const c = this.expr(node.cond, sc);
    if (c.c !== null) return this.block(c.c ? node.iftrue : node.iffalse, sc, ret);
    const st0 = a.state();
    const consts0 = snapshot(sc);
    const sv = a.stmts;
    a.stmts = [];
    const t1 = this.block(node.iftrue, sc, ret);
    const s1 = a.stmts, st1 = a.state();
    const c1 = snapshot(sc);
    restore(consts0);
    [a.pc, a.flushed] = st0;
    a.stmts = [];
    const t2 = this.block(node.iffalse, sc, ret);
    const s2 = a.stmts, st2 = a.state();
    const c2 = snapshot(sc);
    a.stmts = sv;
    const live = [];
    if (!t1) live.push(st1);
    if (!t2) live.push(st2);
    if (live.length === 2 && !stEq(st1, st2)) {
      for (const [st, ss] of [[st1, s1], [st2, s2]]) {
        if (st[0] !== null && st[1] !== st[0]) ss.push(`m68k.pc = ${hex(st[0])};`);
      }
      a.pc = null;
      a.flushed = null;
    } else if (live.length) {
      [a.pc, a.flushed] = live[0];
    }
    let mg = merge(t1 ? null : c1, t2 ? null : c2);
    if (mg !== null) {
      for (const [cb, ss, tt] of [[c1, s1, t1], [c2, s2, t2]]) {
        if (tt) continue;
        for (const [e, kc, , st] of cb) {
          if (mg.get(e)[1] === null && kc !== null && st) ss.push(`${e.c_name} = ${hex(kc)};`);
        }
      }
      const m2 = new Map();
      for (const [e, [, kc, kp, st]] of mg) m2.set(e, [e, kc, kp, kc !== null ? st : false]);
      mg = m2;
    }
    restoreMap(mg);
    a.emit(`if (${c.e()}) { ${s1.join(" ")} } else { ${s2.join(" ")} }`);
    return t1 && t2;
  }
}

function snapshot(sc) {
  const out = [];
  for (let s = sc; s; s = s.parent) for (const e of s.vars.values()) out.push([e, e.c, e.ptr, e.stale]);
  return out;
}
function restore(snap) {
  for (const [e, c, p, st] of snap) {
    e.c = c;
    e.ptr = p;
    e.stale = st;
  }
}
function restoreMap(mg) {
  if (mg === null) return;
  for (const [e, c, p, st] of mg.values()) {
    e.c = c;
    e.ptr = p;
    e.stale = st;
  }
}
function merge(a, b) {
  const toMap = (s) => new Map(s.map((r) => [r[0], r]));
  if (a === null) return b === null ? null : toMap(b);
  if (b === null) return toMap(a);
  const bm = toMap(b);
  const out = new Map();
  for (const [e, c, p, st] of a) {
    const [, c2, p2, st2] = bm.get(e);
    out.set(e, [e, c === c2 ? c : null, ptrEq(p, p2) ? p : null, st || st2]);
    if (!ptrEq(p, p2)) throw new TrError("pointer divergence");
  }
  return out;
}

function constant(node) {
  const raw = node.value;
  if (node.type === "char") return cv(charCode(raw));
  let s = raw.toLowerCase();
  const uns = s.includes("u");
  s = s.replace(/[ul]+$/, "");
  let v;
  if (s.startsWith("0") && s.length > 1 && s[1] >= "0" && s[1] <= "9") v = BigInt("0o" + s.slice(1));
  else if (/^(0x[0-9a-f]+|0b[01]+|0o[0-7]+|[0-9]+)$/.test(s)) v = BigInt(s);
  else throw new TrError(`constant ${raw}`);
  if (uns || v > 0x7fffffffn) return cv(v, U32);
  return cv(v, I32);
}
function charCode(lit) {
  const s = lit.slice(1, -1);
  if (s[0] !== "\\") return s.codePointAt(0);
  const m = { n: 10, t: 9, r: 13, 0: 0, "\\": 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11 };
  if (s[1] === "x") return parseInt(s.slice(2), 16);
  if (/^[0-7]+$/.test(s.slice(1))) return parseInt(s.slice(1), 8);
  if (s[1] in m) return m[s[1]];
  throw new TrError(`char ${lit}`);
}

/**
 * Translate the Musashi handler for opcode `ir` at `pc` to C.
 * @param {object} m68k hydrated m68k data (../../wat/genesis/gpgx-data.js)
 * @param {number} ir
 * @param {number} pc
 * @param {(p:number)=>number} fetch16
 * @param {string} prefix label prefix unique within the enclosing C function
 * @returns {{body:string, locals:string[], cycles:number, nextPc:number|null, length:number, usesRead:boolean, writes:number, pcMoved:boolean}}
 *   body: the handler without its base cycles; nextPc: the constant pc after
 *   it (null when it ends with a dynamic or two-way pc, set in the body)
 */
export function translateM68kC(m68k, ir, pc, fetch16, prefix) {
  const arm = new CArm(ir, pc, fetch16, m68k.tables, prefix);
  const fd = m68k.astOf(m68k.handlerName(ir));
  const tr = new CTr(arm, m68k.astOf);
  const ret = { label: `${prefix}H`, local: null, used: false, t: null, rv: [], states: [], handler: true };
  const term = tr.block(fd.body, new Scope(null), ret);
  // Where the handler can end: every return, plus falling off the end. One
  // constant pc for all of them is a static successor; anything else is a
  // dynamic pc, which then must be in m68k.pc on every path (the returns
  // flush it; the fall-through is flushed here).
  const ends = ret.states.map((s) => s[0]).concat(term ? [] : [arm.pc]);
  const nextPc = ends.length && ends.every((p) => p !== null && p === ends[0]) ? ends[0] : null;
  if (nextPc === null && !term) arm.flushPc();
  let body = arm.stmts;
  if (ret.used) body = [`{ ${body.join(" ")} } ${prefix}H: ;`];
  const cyc = m68k.tables.m68ki_cycles[ir];
  return {
    body: body.join(" "),
    locals: arm.locals,
    cycles: cyc,
    nextPc,
    length: arm.maxPc - pc,
    usesRead: arm.usesRead,
    calls: arm.calls,
    ir,
    handler: m68k.handlerName(ir),
    writes: arm.writes,
    pcMoved: arm.pcMoved,
    flushed: arm.flushed,
  };
}
