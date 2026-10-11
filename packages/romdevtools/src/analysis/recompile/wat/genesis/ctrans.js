// C -> WAT partial evaluator over genesis_plus_gx's own CPU handlers.
//
// The Genesis backend does not contain a hand-written 68000 or Z80. It carries
// the ASTs of gpgx's Musashi opcode handlers (m68kops.h) and MAME z80.c
// handlers, extracted once by scripts/recompile-gen/genesis-gpgx.mjs, and
// partially evaluates them here:
//
//   68000: each handler is specialised for ONE opcode word at ONE address.
//     REG_IR is a compile-time constant (so DX/DY/AY resolve to fixed
//     registers), immediates and extension words are read from the ROM
//     (OPER_I_16, absolute and PC-relative addresses become constants),
//     constant loops (movem's register list) unroll, and everything else
//     (registers, raw Musashi flags, memory, cycles) becomes WAT over globals
//     that mirror Musashi's m68ki_cpu fields one for one.
//   Z80: each op/cb/dd/ed/fd/xycb handler becomes one WAT function over the
//     C register struct laid out in linear memory (PAIR unions alias the way
//     they do in C); the prefix tables dispatch through call_indirect.
//
// This is a line-for-line port of the earlier Python translators (the
// verified Python emitter), including its evaluation order and temp
// numbering, so the WAT it produces is identical to the Python output.
//
// Plain JS ESM + JSDoc.

/** @typedef {{b:number, s:boolean, n:string}} IntT */

export class TrError extends Error {}

const T = (b, s, n) => Object.freeze({ b, s, n });
export const U32 = T(32, false, "U32");
export const I32 = T(32, true, "I32");
export const U16 = T(16, false, "U16");
export const I16 = T(16, true, "I16");
export const U8 = T(8, false, "U8");
export const I8 = T(8, true, "I8");
export const PTR = Object.freeze({ ptr: true, n: "ptr" });
export const PAIR = Object.freeze({ pair: true, n: "pair" });

/** C integer conversion of v to type t (Python _norm). */
export function norm(v, t) {
  if (typeof v === "bigint" || !Number.isSafeInteger(v)) {
    const b = BigInt(v);
    return Number(t.s ? BigInt.asIntN(t.b, b) : BigInt.asUintN(t.b, b));
  }
  if (t.b === 32) return t.s ? v | 0 : v >>> 0;
  if (t.b === 16) {
    v &= 0xffff;
    return t.s && v & 0x8000 ? v - 0x10000 : v;
  }
  if (t.b === 8) {
    v &= 0xff;
    return t.s && v & 0x80 ? v - 0x100 : v;
  }
  throw new TrError(`norm ${t.n}`);
}

const promote = (t) => (t.b < 32 ? I32 : t);
function usual(a, b) {
  a = promote(a);
  b = promote(b);
  if (a === U32 || b === U32) return U32;
  return I32;
}

/** A value: compile-time constant (c), WAT expression (w) or pointer (ptr). */
export class V {
  constructor(c = null, w = null, t = I32, ptr = null) {
    this.c = c;
    this.w = w;
    this.t = t;
    this.ptr = ptr;
  }
  e() {
    if (this.ptr !== null) throw new TrError("pointer used as value");
    if (this.c !== null) return `(i32.const ${this.c >>> 0})`;
    return this.w;
  }
  isConst() {
    return this.c !== null;
  }
}
const cv = (v, t = I32) => new V(norm(v, t), null, t);
const vw = (w, t) => new V(null, w, t);
const vp = (p) => new V(null, null, I32, p);

/** Pointer identity the way Python tuple/str/object equality sees it. */
function ptrEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a === "string" || typeof b === "string") return false;
  if (a.k !== b.k) return false;
  if (a.k === "arr") return a.arr === b.arr && a.off === b.off;
  if (a.k === "table") return a.name === b.name;
  return a.addr === b.addr; // 'mem': V object identity
}
function ptrStr(p) {
  if (typeof p === "string") return p;
  if (p.k === "arr") return `('${p.arr}', ${p.off})`;
  if (p.k === "table") return `('table', '${p.name}')`;
  return `('mem', ${p.addr.e()})`;
}

const GLOBAL_FIELDS = {
  cycles: "$mc", refresh_cycles: "$refresh", cycle_end: "$mcend",
  x_flag: "$fx", n_flag: "$fn", not_z_flag: "$fz", v_flag: "$fv", c_flag: "$fc",
  s_flag: "$fs", int_mask: "$imask", int_level: "$ilevel", stopped: "$stopped",
  t1_flag: "$ft1", instr_mode: "$instrmode", run_mode: "$runmode", aerr_enabled: "$dummy",
};

// Musashi helpers implemented by hand in the runtime (runtime.js); calls to
// them are emitted as WAT calls, everything else is inlined.
const RUNTIME = {
  m68ki_read_8: ["$rd8", 1, true], m68ki_read_16: ["$rd16", 1, true],
  m68ki_read_32: ["$rd32", 1, true],
  m68ki_write_8: ["$wr8", 2, false], m68ki_write_16: ["$wr16", 2, false],
  m68ki_write_32: ["$wr32", 2, false],
  __raw8: ["$raw8", 1, true], __raw16: ["$raw16", 1, true],
  m68ki_set_s_flag: ["$set_s_flag", 1, false],
  m68ki_set_sr: ["$set_sr", 1, false],
  m68ki_check_interrupts: ["$check_int", 0, false],
  UseDivuCycles: ["$use_divu", 2, false], UseDivsCycles: ["$use_divs", 2, false],
  UseMuluCycles: ["$use_mulu", 1, false], UseMulsCycles: ["$use_muls", 1, false],
};
const PC_MOVERS = new Set(["m68ki_set_sr", "m68ki_check_interrupts"]);

const CTYPES = {
  "unsigned int": U32, unsigned: U32, int: I32, "signed int": I32,
  short: I16, "signed short": I16, "unsigned short": U16,
  char: I8, char_s: I8, "signed char": I8, "unsigned char": U8,
  uint: U32, sint: I32, uint32: U32, sint32: I32, uint16: U16,
  sint16: I16, uint8: U8, sint8: I8, long: I32, "unsigned long": U32,
  cpu_memory_map: I32,
};

/** C AST type node (pycparser's shape) -> int type, PTR. */
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

const BIN = { "+": "add", "-": "sub", "*": "mul", "&": "and", "|": "or", "^": "xor", "<<": "shl" };
const CMP = { "==": "eq", "!=": "ne", "<": "lt", ">": "gt", "<=": "le", ">=": "ge" };

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
  if (t === U16) return vw(`(i32.and ${v.w} (i32.const 0xFFFF))`, t);
  if (t === U8) return vw(`(i32.and ${v.w} (i32.const 0xFF))`, t);
  if (t === I16) return vw(`(i32.extend16_s ${v.w})`, t);
  if (t === I8) return vw(`(i32.extend8_s ${v.w})`, t);
  throw new TrError(`conv ${t.n}`);
}

const TMP_RE = /^\(local\.get \$t\d+\)$/;

/** Partial-evaluator state for one opcode at one address. */
export class Arm {
  constructor(ir, pc, fetch16, tables) {
    this.ir = ir;
    this.pc = pc + 2; // REG_PC after the opcode fetch
    this.flushed = null;
    this.fetch16 = fetch16;
    this.tables = tables;
    this.locals = [];
    this.n = 0;
    this.stmts = [];
    this.usesRead = false;
    this.condDepth = 0;
  }
  tmp() {
    this.n += 1;
    const nm = `$t${this.n}`;
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
    this.emit(`(local.set ${t} ${v.w})`);
    return vw(`(local.get ${t})`, v.t);
  }
  flushPc() {
    if (this.pc !== null && this.flushed !== this.pc) {
      this.emit(`(global.set $pc (i32.const ${this.pc >>> 0}))`);
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

/** Musashi handler translator. */
export class Tr {
  /** @param {Arm} arm @param {(name:string)=>any} astOf */
  constructor(arm, astOf) {
    this.a = arm;
    this.astOf = astOf;
    this.inl = 0;
  }

  ctypeOf(node) {
    return ctypeOf(node);
  }

  // ---------------- lvalues ------------------------------------------------
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
    if (node.name.k === "StructRef") return "$dummy";
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
      return `$r${idx}`;
    }
    if (arr === "sp") return `$sp${idx}`;
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
      return vw(`(local.get ${ent.wat})`, ent.t);
    }
    if (lv[0] === "pc") {
      if (a.pc !== null) return cv(a.pc, U32);
      return vw("(global.get $pc)", U32);
    }
    if (lv[0] === "glob") return vw(`(global.get ${ptrStr(lv[1])})`, lv[2]);
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
          a.emit(`(local.set ${ent.wat} ${v.e()})`);
          ent.stale = false;
        } else {
          ent.stale = true;
        }
        return v;
      }
      ent.c = null;
      ent.stale = false;
      a.emit(`(local.set ${ent.wat} ${v.e()})`);
      return vw(`(local.get ${ent.wat})`, ent.t);
    }
    if (lv[0] === "pc") {
      v = conv(v, U32);
      if (v.c !== null) {
        a.pc = v.c >>> 0;
        return v;
      }
      a.emit(`(global.set $pc ${v.e()})`);
      a.pc = null;
      a.flushed = null;
      return vw("(global.get $pc)", U32);
    }
    if (lv[0] === "glob") {
      v = conv(v, lv[2]);
      if (lv[1] === "$dummy") return v;
      a.emit(`(global.set ${ptrStr(lv[1])} ${v.e()})`);
      if (v.c !== null) return v;
      return vw(`(global.get ${ptrStr(lv[1])})`, lv[2]);
    }
    throw new TrError("write_lv");
  }

  // ---------------- expressions ---------------------------------------------
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
        return vw(`(global.get ${f})`, U32);
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
          a.usesTables.add(base.name);
          return vw(`(call $tab_${base.name} ${idx.e()})`, I32);
        }
        // the interpreter (interp.js, Arm.dynReg): a register READ whose number
        // comes from an extension word read at run time (m68ki_get_ea_ix's
        // REG_DA[extension >> 12]) goes through $dar_get
        if (a.dynReg && base.k === "StructRef" && base.name.k === "ID" && base.name.name === "m68k" && base.field.name === "dar") {
          const idx = this.expr(node.subscript, sc);
          if (idx.c === null) return vw(`(call $dar_get (i32.and ${idx.e()} (i32.const 15)))`, U32);
          return this.readLv(["glob", this.regGlobal("dar", idx.c), U32]);
        }
        return this.readLv(["glob", this.ptrOfArrayref(node, sc), U32]);
      }
      case "Cast": {
        const t = this.ctypeOf(node.to_type);
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
        return vw(`(if (result i32) ${c.e()} (then ${xs.join(" ")} ${conv(x, t).e()}) ` +
          `(else ${ys.join(" ")} ${conv(y, t).e()}))`, t);
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
      return vw(`(global.get ${pv.ptr})`, U32);
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
      return vw(`(i32.sub (i32.const 0) ${v.e()})`, t);
    }
    if (op === "~") {
      const t = promote(v.t);
      if (v.c !== null) return cv(~v.c, t);
      return vw(`(i32.xor ${v.e()} (i32.const -1))`, t);
    }
    if (op === "!") {
      if (v.c !== null) return cv(v.c ? 0 : 1);
      return vw(`(i32.eqz ${v.e()})`, I32);
    }
    if (op === "+") return new V(v.c, v.w, promote(v.t));
    throw new TrError(`unary ${op}`);
  }

  arith(op, x, y) {
    if (x.ptr !== null && (op === "+" || op === "-")) {
      if (y.c === null) throw new TrError("dyn ptr arith");
      const base = x.ptr;
      if (typeof base === "string" && base.startsWith("$r")) throw new TrError("ptr arith on reg");
      if (typeof base === "string" || base.k !== "arr") throw new TrError("ptr arith");
      return vp({ k: "arr", arr: base.arr, off: base.off + (op === "+" ? y.c : -y.c) });
    }
    if (op === "<<" || op === ">>") {
      const t = promote(x.t);
      if (x.c !== null && y.c !== null) return cv(fold(op, x.c, y.c, t), t);
      const ins = op === "<<" ? "shl" : t.s ? "shr_s" : "shr_u";
      return vw(`(i32.${ins} ${x.e()} ${y.e()})`, t);
    }
    const t = usual(x.t, y.t);
    if (x.c !== null && y.c !== null) return cv(fold(op, x.c, y.c, t), t);
    if (op in BIN) {
      if (op === "&" && ((x.c !== null && x.c === 0) || (y.c !== null && y.c === 0))) return cv(0, t);
      return vw(`(i32.${BIN[op]} ${x.e()} ${y.e()})`, t);
    }
    if (op === "/") return vw(`(i32.div_${t.s ? "s" : "u"} ${x.e()} ${y.e()})`, t);
    if (op === "%") return vw(`(i32.rem_${t.s ? "s" : "u"} ${x.e()} ${y.e()})`, t);
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
        return vw(`(i32.ne ${y.e()} (i32.const 0))`, I32);
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
      const yb = `(i32.ne ${y.e()} (i32.const 0))`;
      if (op === "&&") return vw(`(if (result i32) ${x.e()} (then ${ys.join(" ")} ${yb}) (else (i32.const 0)))`, I32);
      return vw(`(if (result i32) ${x.e()} (then (i32.const 1)) (else ${ys.join(" ")} ${yb}))`, I32);
    }
    let x = this.expr(node.left, sc);
    const mark = a.stmts.length;
    const y = this.expr(node.right, sc);
    if (a.stmts.length !== mark && x.c === null && x.ptr === null) {
      // the right operand had side effects: pin the left value first
      const t = a.tmp();
      a.stmts.splice(mark, 0, `(local.set ${t} ${x.w})`);
      x = vw(`(local.get ${t})`, x.t);
    }
    if (op in CMP) {
      const t = usual(x.t, y.t);
      if (x.c !== null && y.c !== null) {
        const xa = norm(x.c, t), ya = norm(y.c, t);
        const r = op === "==" ? xa === ya : op === "!=" ? xa !== ya : op === "<" ? xa < ya
          : op === ">" ? xa > ya : op === "<=" ? xa <= ya : xa >= ya;
        return cv(r ? 1 : 0);
      }
      let ins = CMP[op];
      if (ins !== "eq" && ins !== "ne") ins += t.s ? "_s" : "_u";
      return vw(`(i32.${ins} ${x.e()} ${y.e()})`, I32);
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
      a.stmts.splice(mark, 0, `(local.set ${t} ${old.w})`);
      old = vw(`(local.get ${t})`, old.t);
    }
    return this.writeLv(lv, this.arith(op, old, r));
  }

  // ---------------- calls ---------------------------------------------------
  call(node, sc) {
    const a = this.a;
    const name = node.name.k === "ID" ? node.name.name : null;
    const args = node.args ? node.args.exprs : [];
    if (name === "m68ki_read_imm_16" || name === "m68ki_read_imm_8" || name === "m68ki_read_imm_32") {
      if (a.pc === null) throw new TrError("imm read with dynamic pc");
      // fetch16 may answer a WAT expression instead of a number: an
      // extension word read from memory when the arm runs (RAM code whose
      // operands the game patches); anything that needs it constant throws
      const w = (p) => { const x = a.fetch16(p); return typeof x === "string" ? x : `(i32.const ${x})`; };
      let v;
      if (name === "m68ki_read_imm_32") {
        const hi = a.fetch16(a.pc), lo = a.fetch16(a.pc + 2);
        v = typeof hi === "number" && typeof lo === "number" ? hi * 0x10000 + lo
          : `(i32.or (i32.shl ${w(a.pc)} (i32.const 16)) ${w(a.pc + 2)})`;
        a.pc += 4;
      } else {
        v = a.fetch16(a.pc);
        if (name === "m68ki_read_imm_8") v = typeof v === "number" ? v & 0xff : `(i32.and ${v} (i32.const 0xFF))`;
        a.pc += 2;
      }
      return typeof v === "number" ? cv(v, U32) : a.mat(vw(v, U32));
    }
    if (name === "abs") {
      const v = a.mat(this.expr(args[0], sc));
      return vw(`(select (i32.sub (i32.const 0) ${v.e()}) ${v.e()} (i32.lt_s ${v.e()} (i32.const 0)))`, I32);
    }
    if (name !== null && Object.hasOwn(RUNTIME, name)) {
      const [fn, , ret] = RUNTIME[name];
      let vals = [];
      for (const x of args) vals.push(this.expr(x, sc));
      vals = vals.map((v) => (v.c === null ? a.mat(v) : v));
      if (name.startsWith("m68ki_read_") || name.startsWith("m68ki_write_")) a.usesRead = true;
      a.flushPc();
      // m68ki_check_address_error: an odd word/long access leaves the
      // handler here (gpgx longjmps out of it) and takes the address error
      if (/^m68ki_(read|write)_(16|32)$/.test(name) && (vals[0].c === null || vals[0].c & 1)) {
        const odd = vals[0].c === null ? `(i32.and ${vals[0].e()} (i32.const 1))` : "(i32.const 1)";
        a.emit(`(if ${odd} (then (call $address_error ${vals[0].e()} (i32.const ${name.startsWith("m68ki_read") ? 0x10 : 0})) (return)))`);
      }
      const call = `(call ${fn} ${vals.map((v) => v.e()).join(" ")})`;
      if (PC_MOVERS.has(name)) {
        a.pc = null;
        a.flushed = null;
      }
      if (ret) {
        const t = a.tmp();
        a.emit(`(local.set ${t} ${call})`);
        return vw(`(local.get ${t})`, U32);
      }
      a.emit(call);
      return cv(0);
    }
    if (name === "vdp_68k_irq_ack") throw new TrError("irq ack in handler");
    if (name === "longjmp") {
      a.emit("(call $trap)");
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
      const t = this.ctypeOf(p.type);
      const ent = { wat: t !== PTR ? a.tmp() : null, t, c: null, ptr: null, stale: false };
      if (t === PTR) {
        ent.ptr = v.ptr;
      } else {
        v = conv(v, t);
        if (v.c !== null) {
          ent.c = v.c;
          ent.stale = true;
        } else {
          a.emit(`(local.set ${ent.wat} ${v.e()})`);
        }
      }
      scope.vars.set(p.name, ent);
    }
    const rettype = fdecl.type;
    const isVoid = rettype.k === "TypeDecl" && rettype.type.names && rettype.type.names.length === 1 && rettype.type.names[0] === "void";
    const ret = {
      label: `$inl${tag}`, local: isVoid ? null : a.tmp(), used: false,
      t: isVoid ? null : this.ctypeOf(rettype), rv: [], states: [], handler: false,
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
      a.emit(`(block ${ret.label} ${body.join(" ")})`);
    } else {
      for (const s of body) a.stmts.push(s);
    }
    if (isVoid) return cv(0);
    const rvs = ret.rv;
    if (rvs.length && rvs.every((r) => r.c !== null) && new Set(rvs.map((r) => r.c)).size === 1) return rvs[0];
    return vw(`(local.get ${ret.local})`, ret.t);
  }

  // ---------------- statements ------------------------------------------------
  /** Compile a statement; true if control never falls through. */
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
        const t = this.ctypeOf(node.type);
        const ent = { wat: null, t, c: null, ptr: null, stale: false };
        sc.vars.set(node.name, ent);
        if (t !== PTR) ent.wat = a.tmp();
        if (node.init !== null) this.writeLv(["var", ent], this.expr(node.init, sc));
        return false;
      }
      case "Assignment": case "UnaryOp": case "FuncCall": case "BinaryOp": case "ExprList":
      case "Cast": case "ID": case "Constant": case "TernaryOp": {
        const v = this.expr(node, sc);
        if (v.c === null && v.ptr === null && (v.w.startsWith("(if") || v.w.startsWith("(call"))) {
          a.emit(`(drop ${v.w})`);
        }
        return false;
      }
      case "EmptyStatement": return false;
      case "Return": {
        if (node.expr !== null) {
          const v = conv(this.expr(node.expr, sc), ret.t);
          ret.rv.push(v);
          a.emit(`(local.set ${ret.local} ${v.e()})`);
        }
        if (ret.handler) a.flushPc();
        ret.states.push(a.state());
        ret.used = true;
        a.emit(`(br ${ret.label})`);
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
        if (st[0] !== null && st[1] !== st[0]) ss.push(`(global.set $pc (i32.const ${st[0] >>> 0}))`);
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
          if (mg.get(e)[1] === null && kc !== null && st) ss.push(`(local.set ${e.wat} (i32.const ${kc >>> 0}))`);
        }
      }
      const m2 = new Map();
      for (const [e, [, kc, kp, st]] of mg) m2.set(e, [e, kc, kp, kc !== null ? st : false]);
      mg = m2;
    }
    restoreMap(mg);
    a.emit(`(if ${c.e()} (then ${s1.join(" ")}) (else ${s2.join(" ")}))`);
    return t1 && t2;
  }
}

/** [ent, c, ptr, stale] per variable in scope order (innermost first). */
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

// ===========================================================================
// 68000 entry point
// ===========================================================================

/**
 * Translate the Musashi handler for opcode `ir` at `pc`.
 * @param {object} m68k  hydrated m68k data (gpgx-data.js)
 * @param {number} ir
 * @param {number} pc
 * @param {(p:number)=>number} fetch16
 * @returns {{body:string, nlocals:number}}  body ends with $pc set and the base cycles added
 */
export function translateM68k(m68k, ir, pc, fetch16, o = {}) {
  const arm = new Arm(ir, pc, fetch16, m68k.tables);
  // o.dynReg (the interpreter only): register numbers from run-time extension words
  if (o.dynReg) arm.dynReg = true;
  arm.usesTables = new Set();
  const fd = m68k.astOf(m68k.handlerName(ir));
  const tr = new Tr(arm, m68k.astOf);
  const ret = { label: "$H", local: null, used: false, t: null, rv: [], states: [], handler: true };
  const term = tr.block(fd.body, new Scope(null), ret);
  if (!term) arm.flushPc();
  let body = arm.stmts;
  if (ret.used) body = [`(block $H ${body.join(" ")})`];
  const cyc = m68k.tables.m68ki_cycles[ir];
  if (cyc) body.push(`(global.set $mc (i32.add (global.get $mc) (i32.const ${cyc})))`);
  if (arm.usesRead) body.unshift(`(global.set $ir (i32.const ${ir}))`);
  return { body: body.join(" "), nlocals: arm.locals.length };
}

// ===========================================================================
// Z80 (MAME z80.c): Musashi's evaluator retargeted, every Z80 field is memory
// ===========================================================================

export const ZREGS = 0x20100 + 0x40; // after the VDP registers (see runtime.js)
const PAIRS = ["pc", "sp", "af", "bc", "de", "hl", "ix", "iy", "wz", "af2", "bc2", "de2", "hl2"];
const BYTES = ["r", "r2", "iff1", "iff2", "halt", "im", "i", "nmi_state", "nmi_pending", "irq_state", "after_ei"];
export const ZOFF = {};
PAIRS.forEach((p, k) => { ZOFF[p] = 4 * k; });
BYTES.forEach((b, k) => { ZOFF[b] = 52 + k; });
ZOFF.cycles = 64;
const SCRATCH = 68; // 4 bytes for a local PAIR (ex (sp),hl)

const ZTYPES = {
  UINT8: U8, INT8: I8, UINT16: U16, INT16: I16, UINT32: U32, INT32: I32,
  unsigned: U32, "unsigned int": U32, int: I32, "unsigned char": U8, char_s: I8,
  char: I8, short: I16, "unsigned short": U16, PAIR,
};
class ZTypeKey extends Error {}
function ztype(node) {
  if (node.k === "PtrDecl") return PTR;
  if (node.k === "TypeDecl" || node.k === "Typename") return ztype(node.type);
  if (node.k === "IdentifierType") {
    const t = ZTYPES[node.names.join(" ")];
    if (!t) throw new ZTypeKey(node.names.join(" "));
    return t;
  }
  throw new TrError(`ztype ${node.k}`);
}

const ZRUNTIME = {
  romdev_z80_rm: ["$z80_rm", true], romdev_z80_wm: ["$z80_wm", false],
  ROP: ["$z80_rop", true], ARG: ["$z80_arg", true], ARG16: ["$z80_arg16", true],
  z80_readport: ["$z80_port_r", true], z80_writeport: ["$z80_port_w", false],
};
const ZTABLES = { cb: 1, dd: 2, ed: 3, fd: 4, xycb: 5 };
const ZHANDLER_RE = /^(op|cb|dd|ed|fd|xycb)_[0-9a-f]{2}$/;
const CC_NAMES = ["cc_op", "cc_cb", "cc_ed", "cc_xy", "cc_xycb", "cc_ex"];

class ZArm extends Arm {
  constructor(layout) {
    super(0, 0, null, {});
    this.pc = null;
    this.layout = layout;
  }
}

class ZTr extends Tr {
  constructor(arm, astOf, cc) {
    super(arm, astOf);
    this.cc = cc;
  }

  ctypeOf(node) {
    try {
      return ztype(node);
    } catch (e) {
      if (e instanceof ZTypeKey || e instanceof TrError) return ctypeOf(node);
      throw e;
    }
  }

  zaddr(node, sc) {
    const L = this.a.layout;
    const path = [];
    let n = node;
    while (n.k === "StructRef") {
      path.push(n.field.name);
      n = n.name;
    }
    path.reverse();
    let base;
    const isZ = n.k === "ID" && n.name === "Z80";
    if (isZ) {
      base = cv(L.ZREGS, U32);
    } else {
      const pv = this.expr(n, sc);
      if (pv.ptr === null || typeof pv.ptr === "string" || pv.ptr.k !== "mem") throw new TrError("struct base");
      base = pv.ptr.addr;
    }
    let off = 0, t, k = 0;
    if (isZ) {
      const f = path[0];
      if (!(f in ZOFF)) throw new TrError(`z80 field ${f}`);
      off = ZOFF[f];
      k = 1;
      t = PAIRS.includes(f) ? PAIR : f === "cycles" ? U32 : U8;
    } else {
      t = PAIR;
    }
    const rest = path.slice(k);
    if (t === PAIR && rest.length) {
      if (rest.length === 1 && rest[0] === "d") {
        t = U32;
      } else if (rest[0] === "w") {
        t = U16;
        const o = { l: 0, h: 2 }[rest[1]];
        if (o === undefined) throw new TrError(`pair field ${rest}`);
        off += o;
      } else if (rest[0] === "b") {
        t = U8;
        const o = { l: 0, h: 1, h2: 2, h3: 3 }[rest[1]];
        if (o === undefined) throw new TrError(`pair field ${rest}`);
        off += o;
      } else {
        throw new TrError(`pair field ${rest}`);
      }
    }
    if (base.c !== null) return [cv(base.c + off, U32), t];
    return [vw(`(i32.add ${base.e()} (i32.const ${off}))`, U32), t];
  }

  lval(node, sc) {
    if (node.k === "StructRef") {
      const [addr, t] = this.zaddr(node, sc);
      return ["mem", addr, t];
    }
    if (node.k === "ID") {
      const ent = sc.find(node.name);
      if (!ent) {
        if (node.name === "EA") return ["glob", "$zEA", U32];
        if (node.name === "z80_last_fetch") return ["glob", "$z80_last_fetch", U8];
        throw new TrError(`unknown z80 lvalue ${node.name}`);
      }
      return ["var", ent];
    }
    throw new TrError(`z80 lvalue ${node.k}`);
  }

  readLv(lv) {
    if (lv[0] === "mem") {
      const [, addr, t] = lv;
      if (t === PAIR) return vp({ k: "mem", addr });
      const op = t === U8 ? "i32.load8_u" : t === U16 ? "i32.load16_u" : t === U32 ? "i32.load" : null;
      if (!op) throw new TrError(`z80 load ${t.n}`);
      return vw(`(${op} ${addr.e()})`, t);
    }
    if (lv[0] === "var" && lv[1].t === PAIR) return vp({ k: "mem", addr: cv(lv[1].addr, U32) });
    return super.readLv(lv);
  }

  writeLv(lv, v) {
    const a = this.a;
    if (lv[0] === "mem") {
      const [, addr, t] = lv;
      if (t === PAIR) {
        if (v.ptr === null || typeof v.ptr === "string" || v.ptr.k !== "mem") throw new TrError("pair assign");
        a.emit(`(i32.store ${addr.e()} (i32.load ${v.ptr.addr.e()}))`);
        return v;
      }
      v = conv(v, t);
      const op = t === U8 ? "i32.store8" : t === U16 ? "i32.store16" : t === U32 ? "i32.store" : null;
      if (!op) throw new TrError(`z80 store ${t.n}`);
      if (v.c === null) v = a.mat(v);
      a.emit(`(${op} ${addr.e()} ${v.e()})`);
      return v;
    }
    if (lv[0] === "glob") {
      v = conv(v, lv[2]);
      if (v.c === null) v = a.mat(v);
      a.emit(`(global.set ${lv[1]} ${v.e()})`);
      return v;
    }
    if (lv[0] === "var" && lv[1].t === PAIR) {
      if (v.ptr === null || typeof v.ptr === "string" || v.ptr.k !== "mem") throw new TrError("pair var assign");
      a.emit(`(i32.store (i32.const ${lv[1].addr}) (i32.load ${v.ptr.addr.e()}))`);
      return v;
    }
    return super.writeLv(lv, v);
  }

  expr(node, sc) {
    const a = this.a;
    if (node === null || node === undefined) throw new TrError("expr NoneType");
    if (node.k === "StructRef") {
      const [addr, t] = this.zaddr(node, sc);
      return this.readLv(["mem", addr, t]);
    }
    if (node.k === "ID" && sc.find(node.name) === null) {
      if (node.name === "EA" || node.name === "z80_last_fetch") return this.readLv(this.lval(node, sc));
      if (node.name === "TRUE") return cv(1);
      if (node.name === "FALSE") return cv(0);
    }
    if (node.k === "ArrayRef" && node.name.k === "ID") {
      const nm = node.name.name;
      const L = a.layout;
      const idx = this.expr(node.subscript, sc);
      if (Object.hasOwn(L.tabs, nm)) {
        const base = L.tabs[nm];
        if (idx.c !== null) return vw(`(i32.load8_u (i32.const ${base + idx.c}))`, U8);
        return vw(`(i32.load8_u (i32.add (i32.const ${base}) ${idx.e()}))`, U8);
      }
      if (nm === "cc" || nm.startsWith("Z80")) throw new TrError("table ref");
    }
    if (node.k === "ArrayRef" && node.name.k === "ArrayRef") {
      const inner = node.name;
      if (inner.name.k === "ID" && inner.name.name === "cc") {
        const ti = this.expr(inner.subscript, sc);
        const idx = this.expr(node.subscript, sc);
        const tname = CC_NAMES[ti.c];
        if (idx.c !== null) return cv(this.cc[tname][idx.c], I32);
        const base = a.layout.cc[tname];
        return vw(`(i32.load16_u (i32.add (i32.const ${base}) (i32.shl ${idx.e()} (i32.const 1))))`, I32);
      }
    }
    if (node.k === "ID" && node.name.startsWith("Z80_TABLE_")) {
      const suf = node.name.slice(10);
      const i = ["op", "cb", "ed", "xy", "xycb", "ex"].indexOf(suf);
      if (i >= 0) return cv(i);
      const d = { dd: 3, fd: 3 }[suf];
      if (d === undefined) throw new TrError(`z80 table ${suf}`);
      return cv(d);
    }
    if (node.k === "Cast" && node.to_type.type.k === "PtrDecl") return this.expr(node.expr, sc);
    return super.expr(node, sc);
  }

  unary(node, sc) {
    if (node.op === "&" && node.expr.k === "StructRef") {
      const [addr] = this.zaddr(node.expr, sc);
      return vp({ k: "mem", addr });
    }
    if (node.op === "&" && node.expr.k === "ID") {
      const ent = sc.find(node.expr.name);
      if (ent && ent.t === PAIR) return vp({ k: "mem", addr: cv(ent.addr, U32) });
    }
    return super.unary(node, sc);
  }

  call(node, sc) {
    const a = this.a;
    if (node.name.k === "UnaryOp" && node.name.op === "*") {
      // (*Z80cb[op])()
      const ar = node.name.expr;
      const tname = ar.name.name.slice(3);
      const idx = this.expr(ar.subscript, sc);
      const base = a.layout.tbase + ZTABLES[tname] * 256;
      a.emit(`(call_indirect (type $voidT) (i32.add (i32.const ${base}) ${idx.e()}))`);
      return cv(0);
    }
    const name = node.name.k === "ID" ? node.name.name : null;
    const args = node.args ? node.args.exprs : [];
    if (name !== null && Object.hasOwn(ZRUNTIME, name)) {
      const [fn, ret] = ZRUNTIME[name];
      const vals = args.map((x) => this.expr(x, sc)).map((v) => (v.c === null ? a.mat(v) : v));
      const c = `(call ${fn} ${vals.map((v) => v.e()).join(" ")})`;
      if (ret) {
        const t = a.tmp();
        a.emit(`(local.set ${t} ${c})`);
        return vw(`(local.get ${t})`, U32);
      }
      a.emit(c);
      return cv(0);
    }
    if (name && ZHANDLER_RE.test(name)) {
      a.emit(`(call $z_${name})`);
      return cv(0);
    }
    if (name === "illegal_1" || name === "illegal_2") return cv(0);
    return this.inline(name, args, sc);
  }

  block(node, sc, ret) {
    const a = this.a;
    if (node && node.k === "Decl") {
      const t = ztype(node.type);
      if (t === PAIR) {
        const ent = { wat: null, t, c: null, ptr: null, stale: false, addr: a.layout.ZREGS + SCRATCH };
        sc.vars.set(node.name, ent);
        a.emit(`(i32.store (i32.const ${ent.addr}) (i32.const 0))`);
        return false;
      }
      const ent = { wat: a.tmp(), t, c: null, ptr: null, stale: false };
      sc.vars.set(node.name, ent);
      if (node.init !== null) this.writeLv(["var", ent], this.expr(node.init, sc));
      return false;
    }
    return super.block(node, sc, ret);
  }
}

/** The Z80 handler names in dispatch-table order (op, cb, dd, ed, fd, xycb). */
export function z80HandlerNames() {
  const hex = (i) => i.toString(16).padStart(2, "0");
  const names = [];
  for (const p of ["op", "cb", "dd", "ed", "fd", "xycb"]) for (let i = 0; i < 256; i++) names.push(`${p}_${hex(i)}`);
  return names;
}

/**
 * Translate one Z80 handler into a WAT function `$z_<name>`.
 * @param {object} z80  hydrated z80 data (gpgx-data.js)
 * @param {string} name
 * @param {{ZREGS:number, tabs:Record<string,number>, cc:Record<string,number>, tbase:number}} layout
 */
export function translateZ80(z80, name, layout) {
  const arm = new ZArm(layout);
  arm.usesTables = new Set();
  const tr = new ZTr(arm, z80.astOf, z80.cc);
  const fd = z80.astOf(name);
  const ret = { label: "$H", local: null, used: false, t: null, rv: [], states: [], handler: false };
  tr.block(fd.body, new Scope(null), ret);
  let body = arm.stmts.join(" ");
  if (ret.used) body = `(block $H ${body})`;
  const locs = arm.locals.map((n) => `(local ${n} i32)`).join(" ");
  return `  (func $z_${name} ${locs}\n    ${body})\n`;
}
