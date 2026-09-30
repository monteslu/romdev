#!/usr/bin/env node
// Translate snes9x's SuperFX (GSU) instruction set into WAT for the SNES WAT
// recompiler, and write it as committed data
// (src/analysis/recompile/wat/snes/snes9x-superfx.json).
//
// The source is snes9x's fxinst.cpp (one `static void fx_xxx (void)` per
// instruction handler, most of them built from macros in fxinst.cpp and
// fxinst.h, plus the 1024-entry fx_OpcodeTable and the fx_PlotTable).
// This script runs the conditionals of those two files with snes9x's own
// settings (#if 0 / #ifdef / #ifndef / #else; CHECK_LIMITS and
// FX_DO_ROMBUFFER defined, DEBUGGER and FX_ADDRESS_CHECK not), collects the
// #defines and expands them with the shared C preprocessor
// (lib/c-preprocessor.mjs: function-like macros, ## pasting), parses the
// handler bodies (a small C subset: declarations, assignments and compound
// assignments, pre/post increment, if/else, return, casts, the GSU struct's
// fields, register and byte pointers) and emits WAT that keeps C's semantics: every expression is
// 32-bit with C's usual arithmetic conversions (a uint32 operand makes a
// comparison, shift or division unsigned; uint8 and casts promote to int),
// and a store truncates to the destination's C type. Anything outside the
// subset is REFUSED, so an upstream change fails here instead of being
// translated wrongly.
//
// fxemu.cpp (the register space, bank tables, screen pointers and the
// per-line scheduling) is pointer-heavy glue and is hand-ported in
// wat/snes/superfx.js; its source hash is recorded here so --check notices
// an upstream change to it, and its numeric constants are extracted.
//
// Recompile time never needs the snes9x source; only this script does.
//
// usage: snes9x-superfx.mjs [<snes9x src dir>] [<out.json>] [--check]
//   default src: ${ROMDEV_BUILD_DIR:-<pkg>/build}/snes9x/src (build-snes9x.sh's clone)
//   --check: regenerate in memory and fail if the committed file differs.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lex, parseDefine, expandTokens } from "./lib/c-preprocessor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..", "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const check = process.argv.includes("--check");
const srcDir = args[0] ||
  path.join(process.env.ROMDEV_BUILD_DIR || path.join(pkg, "build"), "snes9x", "src");
const out = args[1] ||
  path.join(pkg, "src", "analysis", "recompile", "wat", "snes", "snes9x-superfx.json");

const versions = JSON.parse(readFileSync(path.join(pkg, "scripts", "versions.json"), "utf8"));
const pin = versions.cores?.snes9x ?? versions.snes9x;
const sha = (t) => createHash("sha256").update(t).digest("hex");
const fail = (m) => { throw new Error(`superfx gen: ${m}`); };

const instH = readFileSync(path.join(srcDir, "fxinst.h"), "utf8");
const instC = readFileSync(path.join(srcDir, "fxinst.cpp"), "utf8");
const emuC = readFileSync(path.join(srcDir, "fxemu.cpp"), "utf8");
const emuH = readFileSync(path.join(srcDir, "fxemu.h"), "utf8");

// ---------------------------------------------------------------- lexer
// The C lexer and macro expander are shared (lib/c-preprocessor.mjs); the
// handler parser below wants integer tokens as numbers.
const numeric = (toks) => toks.map((k) => {
  if (k.t !== "num") return k;
  const v = Number(k.v);
  if (!Number.isInteger(v)) fail(`unsupported number '${k.v}'`);
  return { ...k, v };
});

// ---------------------------------------------------------------- preprocessor
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
// snes9x's own configuration of these files (fxinst.cpp / fxinst.h).
const DEFINED = new Set(["CHECK_LIMITS", "FX_DO_ROMBUFFER", "BRANCH_DELAY_RELATIVE"]);
const UNDEFINED = new Set(["DEBUGGER", "FX_ADDRESS_CHECK"]);

/** Run the conditionals and collect #defines; returns {text, macros}. */
function preprocess(src, macros) {
  const lines = stripComments(src).replace(/\\\r?\n/g, " ").split("\n");
  const outl = [];
  const stack = []; // {active, taken}
  const active = () => stack.every((s) => s.active);
  for (const raw of lines) {
    const l = raw.trim();
    let m;
    if ((m = /^#\s*(ifdef|ifndef)\s+(\w+)/.exec(l))) {
      const name = m[2];
      let def;
      if (DEFINED.has(name) || macros.has(name)) def = true;
      else if (UNDEFINED.has(name)) def = false;
      else if (name === "_FXINST_H_" || name === "_FXEMU_H_") def = false;
      else fail(`#${m[1]} ${name}: unknown configuration symbol`);
      const on = m[1] === "ifdef" ? def : !def;
      stack.push({ active: on, taken: on });
      outl.push("");
      continue;
    }
    if ((m = /^#\s*if\s+(.*)$/.exec(l))) {
      const e = m[1].trim();
      if (e !== "0" && e !== "1") fail(`#if ${e}: only #if 0 / #if 1 are supported`);
      stack.push({ active: e === "1", taken: e === "1" });
      outl.push("");
      continue;
    }
    if (/^#\s*else\b/.test(l)) {
      const s = stack.at(-1); if (!s) fail("#else without #if");
      s.active = !s.taken; s.taken = true;
      outl.push("");
      continue;
    }
    if (/^#\s*endif\b/.test(l)) { if (!stack.pop()) fail("#endif without #if"); outl.push(""); continue; }
    if (!active()) { outl.push(""); continue; }
    if ((m = /^#\s*define\s+(.*)$/.exec(l))) {
      const mac = parseDefine(lex(m[1]), "in fxinst");
      macros.set(mac.name, mac);
      DEFINED.add(mac.name);
      outl.push("");
      continue;
    }
    if (/^#\s*include\b/.test(l)) { outl.push(""); continue; }
    if (l.startsWith("#")) fail(`unsupported directive: ${l}`);
    outl.push(raw);
  }
  if (stack.length) fail("unterminated #if");
  return outl.join("\n");
}

const macros = new Map([["FALSE", parseDefine(lex("FALSE 0"))], ["TRUE", parseDefine(lex("TRUE 1"))]]);
preprocess(instH, macros);
const cText = preprocess(instC, macros);

// ---------------------------------------------------------------- parser
const TYPES = new Set(["uint32", "int32", "uint16", "int16", "uint8", "int8", "bool8"]);

class Parser {
  constructor(toks) { this.t = toks; this.i = 0; }
  peek(o = 0) { return this.t[this.i + o]; }
  is(v, o = 0) { const k = this.peek(o); return k && k.t !== "num" && k.v === v; }
  next() { const k = this.t[this.i++]; if (!k) fail("unexpected end"); return k; }
  eat(v) { const k = this.next(); if (k.v !== v) fail(`expected '${v}', got '${k.v}' near token ${this.i}`); return k; }
  done() { return this.i >= this.t.length; }
  block() {
    const body = [];
    while (!this.is("}")) body.push(this.stmt());
    this.eat("}");
    return body;
  }
  stmt() {
    if (this.is("{")) { this.next(); return { k: "block", body: this.block() }; }
    if (this.is(";")) { this.next(); return { k: "block", body: [] }; }
    if (this.is("return")) { this.next(); this.eat(";"); return { k: "return" }; }
    if (this.is("if")) {
      this.next(); this.eat("("); const c = this.expr(); this.eat(")");
      const th = this.stmt();
      let el = null;
      if (this.is("else")) { this.next(); el = this.stmt(); }
      return { k: "if", c, th, el };
    }
    const k0 = this.peek();
    if (k0.t === "id" && TYPES.has(k0.v)) {
      this.next();
      const decls = [];
      for (;;) {
        let ptr = false;
        if (this.is("*")) { this.next(); ptr = true; }
        const name = this.next();
        if (name.t !== "id") fail(`declaration of '${name.v}'`);
        let init = null;
        if (this.is("=")) { this.next(); init = this.assign(); }
        decls.push({ type: ptr ? `${k0.v}*` : k0.v, name: name.v, init });
        if (this.is(",")) { this.next(); continue; }
        break;
      }
      this.eat(";");
      return { k: "decl", decls };
    }
    const e = this.expr();
    this.eat(";");
    return { k: "expr", e };
  }
  expr() {
    const e = this.assign();
    if (this.is(",")) fail("comma operator");
    return e;
  }
  assign() {
    const l = this.ternary();
    const k = this.peek();
    if (k && k.t === "p" && ["=", "+=", "-=", "*=", "|=", "&=", "^=", "<<=", ">>="].includes(k.v)) {
      this.next();
      const r = this.assign();
      return { k: "assign", op: k.v, l, r };
    }
    return l;
  }
  ternary() {
    const c = this.bin(0);
    if (this.is("?")) {
      this.next(); const a = this.assign(); this.eat(":"); const b = this.assign();
      return { k: "tern", c, a, b };
    }
    return c;
  }
  bin(level) {
    const LV = [["||"], ["&&"], ["|"], ["^"], ["&"], ["==", "!="], ["<", ">", "<=", ">="], ["<<", ">>"], ["+", "-"], ["*", "/", "%"]];
    if (level >= LV.length) return this.unary();
    let l = this.bin(level + 1);
    for (;;) {
      const k = this.peek();
      if (k && k.t === "p" && LV[level].includes(k.v)) {
        this.next();
        l = { k: "bin", op: k.v, l, r: this.bin(level + 1) };
      } else return l;
    }
  }
  unary() {
    const k = this.peek();
    if (k.t === "p" && ["!", "~", "-", "+", "*", "&"].includes(k.v)) { this.next(); return { k: "un", op: k.v, e: this.unary() }; }
    if (k.t === "p" && (k.v === "++" || k.v === "--")) { this.next(); return { k: "pre", op: k.v, e: this.unary() }; }
    if (k.v === "(" && this.peek(1)?.t === "id" && TYPES.has(this.peek(1).v) && this.is(")", 2)) {
      this.next(); const ty = this.next().v; this.eat(")");
      return { k: "cast", ty, e: this.unary() };
    }
    return this.postfix();
  }
  postfix() {
    let e = this.primary();
    for (;;) {
      if (this.is("(")) {
        if (e.k !== "name") fail("call of a non-name");
        this.next(); this.eat(")");
        e = { k: "call", f: e.v };
      } else if (this.is("[")) {
        this.next(); const i = this.expr(); this.eat("]");
        e = { k: "index", b: e, i };
      } else if (this.is("++") || this.is("--")) {
        e = { k: "post", op: this.next().v, e };
      } else return e;
    }
  }
  primary() {
    const k = this.next();
    if (k.t === "num") return { k: "num", v: k.v };
    if (k.v === "(") { const e = this.expr(); this.eat(")"); return e; }
    if (k.t === "id") {
      let name = k.v;
      while (this.is(".")) { this.next(); name += "." + this.next().v; }
      return { k: "name", v: name };
    }
    fail(`unexpected token '${k.v}'`);
  }
}

// ---------------------------------------------------------------- emitter
// The GSU struct (fxinst.h FxRegs_s) fields the handlers touch -> C type.
// Scalars become WAT globals $fx_<field>; the arrays and pointers are
// modelled below. `@NAME@` placeholders are linear-memory addresses that
// superfx.js fills in at emit time.
const FIELDS = {
  vColorReg: "uint32", vPlotOptionReg: "uint32", vStatusReg: "uint32", vPrgBankReg: "uint32",
  vRomBankReg: "uint32", vRamBankReg: "uint32", vCacheBaseReg: "uint32", vCacheFlags: "uint32",
  vLastRamAdr: "uint32", vRomBuffer: "uint8", vPipe: "uint8", vSign: "uint32", vZero: "uint32",
  vCarry: "uint32", vOverflow: "int32", bCacheActive: "uint8", vCounter: "uint32", vInstCount: "uint32",
  vScreenHeight: "uint32", vScreenRealHeight: "uint32", vMode: "uint32",
};
// Byte pointers into ROM/RAM, kept as a (base, mask) pair: the bank table
// entry decides both (superfx.js $fx_romtab / $fx_ramtab).
const BANKPTRS = { pvRamBank: "ram", pvRomBank: "rom", pvPrgBank: "prg" };
const REGPTRS = { pvSreg: "$fx_sreg", pvDreg: "$fx_dreg" };

const TYPEINFO = {
  uint32: { t: "u32" }, int32: { t: "s32" }, uint16: { t: "s32", mask: 0xffff }, int16: { t: "s32", sext: 16 },
  uint8: { t: "s32", mask: 0xff }, int8: { t: "s32", sext: 8 }, bool8: { t: "s32", mask: 0xff },
};
const c = (v) => `(i32.const ${v})`;
/** C store truncation for a declared type. */
function trunc(type, w) {
  const ti = TYPEINFO[type];
  if (!ti) return w;
  if (ti.mask) return `(i32.and ${w} ${c(ti.mask)})`;
  if (ti.sext) return `(i32.extend${ti.sext}_s ${w})`;
  return w;
}
/** Read type of a declared C type after integer promotion. */
const rtype = (type) => (type.endsWith("*") ? "ptr" : TYPEINFO[type].t);

class Fn {
  constructor(name) { this.name = name; this.locals = {}; this.ntmp = 0; this.maxtmp = 0; this.calls = new Set(); }
  tmp() { const n = this.ntmp++; this.maxtmp = Math.max(this.maxtmp, this.ntmp); return `$t${n}`; }
  free() { this.ntmp--; }
}

const regAddr = (idx) => (idx.k === "const"
  ? { w: `(i32.const @AVREG@)`, off: 4 * idx.v }
  : { w: `(i32.add (i32.const @AVREG@) (i32.shl ${idx.w} ${c(2)}))`, off: 0 });
const ld = (a) => `(i32.load${a.off ? ` offset=${a.off}` : ""} ${a.w})`;
const st = (a, w) => `(i32.store${a.off ? ` offset=${a.off}` : ""} ${a.w} ${w})`;
const ld8 = (a) => `(i32.load8_u${a.off ? ` offset=${a.off}` : ""} ${a.w})`;
const st8 = (a, w) => `(i32.store8${a.off ? ` offset=${a.off}` : ""} ${a.w} ${w})`;

/** Constant-fold a numeric expression node, or null. */
function constOf(e) {
  if (e.k === "num") return e.v;
  if (e.k === "un" && e.op === "-" && constOf(e.e) !== null) return -constOf(e.e);
  if (e.k === "un" && e.op === "~" && constOf(e.e) !== null) return ~constOf(e.e);
  if (e.k === "cast" && (e.ty === "int32" || e.ty === "uint32")) return constOf(e.e);
  if (e.k === "bin") {
    const a = constOf(e.l), b = constOf(e.r);
    if (a === null || b === null) return null;
    switch (e.op) {
      case "+": return a + b; case "-": return a - b; case "*": return a * b;
      case "<<": return a << b; case "|": return a | b; case "&": return a & b;
      default: return null;
    }
  }
  return null;
}

/**
 * Resolve an lvalue: {kind, get(), set(w)} with C truncation on set.
 * Kinds: local, field, reg (register array element), byte (uint8 array
 * element), regptr (pvSreg/pvDreg), bankptr (pvRamBank/pvRomBank/pvPrgBank).
 */
function lvalue(fn, e) {
  if (e.k === "name") {
    if (fn.locals[e.v] !== undefined) {
      const ty = fn.locals[e.v];
      return { kind: "local", t: rtype(ty), get: () => `(local.get $${e.v})`, set: (w) => `(local.set $${e.v} ${trunc(ty, w)})` };
    }
    const f = /^GSU\.(\w+)$/.exec(e.v);
    if (f && FIELDS[f[1]]) {
      const ty = FIELDS[f[1]];
      return { kind: "field", t: rtype(ty), get: () => `(global.get $fx_${f[1]})`, set: (w) => `(global.set $fx_${f[1]} ${trunc(ty, w)})` };
    }
    if (f && REGPTRS[f[1]]) {
      const g = REGPTRS[f[1]];
      return { kind: "regptr", t: "regptr", get: () => `(global.get ${g})`, set: (w) => `(global.set ${g} ${w})` };
    }
    if (f && BANKPTRS[f[1]]) {
      const b = BANKPTRS[f[1]];
      return { kind: "bankptr", bank: b, t: "bankptr" };
    }
    fail(`${fn.name}: unknown name ${e.v}`);
  }
  if (e.k === "un" && e.op === "*") {
    const p = expr(fn, e.e);
    if (p.t !== "regptr") fail(`${fn.name}: dereference of a ${p.t}`);
    const a = regAddr({ k: "dyn", w: p.w });
    return { kind: "reg", t: "u32", get: () => ld(a), set: (w) => st(a, w) };
  }
  if (e.k === "index") {
    const bn = e.b.k === "name" ? e.b.v : null;
    const ic = constOf(e.i);
    if (bn === "GSU.avReg") {
      const a = regAddr(ic !== null ? { k: "const", v: ic } : { k: "dyn", w: expr(fn, e.i).w });
      if (ic !== null && (ic < 0 || ic > 15)) fail(`${fn.name}: avReg[${ic}]`);
      return { kind: "reg", t: "u32", get: () => ld(a), set: (w) => st(a, w) };
    }
    if (bn === "GSU.pvRegisters") {
      const a = ic !== null ? { w: "(i32.const @FXREG@)", off: ic } : { w: `(i32.add (i32.const @FXREG@) ${expr(fn, e.i).w})`, off: 0 };
      return { kind: "byte", t: "s32", get: () => ld8(a), set: (w) => st8(a, w) };
    }
    if (bn && /^GSU\./.test(bn) && BANKPTRS[bn.slice(4)]) {
      const b = BANKPTRS[bn.slice(4)];
      const a = { w: `(i32.add (global.get $fx_${b}base) (i32.and ${expr(fn, e.i).w} (global.get $fx_${b}mask)))`, off: 0 };
      return { kind: "byte", t: "s32", get: () => ld8(a), set: (w) => st8(a, w) };
    }
    if (bn === "GSU.apvScreen" || bn === "GSU.x") {
      const tab = bn === "GSU.x" ? "@XTAB@" : "@APVTAB@";
      const a = { w: `(i32.add (i32.const ${tab}) (i32.shl ${expr(fn, e.i).w} ${c(2)}))`, off: 0 };
      return { kind: "tab", t: bn === "GSU.x" ? "s32" : "ptr", get: () => ld(a), set: () => fail(`${fn.name}: store to ${bn}`) };
    }
    // a local byte pointer: a[k]
    if (bn && fn.locals[bn] && fn.locals[bn].endsWith("*")) {
      if (fn.locals[bn] !== "uint8*") fail(`${fn.name}: ${bn} is ${fn.locals[bn]}`);
      const a = ic !== null ? { w: `(local.get $${bn})`, off: ic } : { w: `(i32.add (local.get $${bn}) ${expr(fn, e.i).w})`, off: 0 };
      if (ic !== null && ic < 0) fail(`${fn.name}: negative index`);
      return { kind: "byte", t: "s32", get: () => ld8(a), set: (w) => st8(a, w) };
    }
    fail(`${fn.name}: index into ${bn ?? e.b.k}`);
  }
  fail(`${fn.name}: not an lvalue (${e.k})`);
}

const ARITH = { "+": "i32.add", "-": "i32.sub", "*": "i32.mul", "&": "i32.and", "|": "i32.or", "^": "i32.xor", "<<": "i32.shl" };
const CMP = { "==": ["i32.eq", "i32.eq"], "!=": ["i32.ne", "i32.ne"], "<": ["i32.lt_s", "i32.lt_u"], ">": ["i32.gt_s", "i32.gt_u"], "<=": ["i32.le_s", "i32.le_u"], ">=": ["i32.ge_s", "i32.ge_u"] };

/** C usual arithmetic conversions for two promoted operand types. */
function common(a, b, what) {
  if (a === "u32" || b === "u32") return "u32";
  if (a === "s32" && b === "s32") return "s32";
  fail(`${what}: operands ${a}, ${b}`);
}

/** @returns {{w: string, t: "u32"|"s32"|"ptr"|"regptr"}} */
function expr(fn, e) {
  switch (e.k) {
    case "num": return { w: c(e.v | 0), t: e.v > 0x7fffffff ? "u32" : "s32" };
    case "name": case "index": {
      const lv = lvalue(fn, e);
      if (lv.kind === "bankptr") fail(`${fn.name}: bank pointer ${e.v} used as a value`);
      return { w: lv.get(), t: lv.t };
    }
    case "call": {
      fn.calls.add(e.f);
      fail(`${fn.name}: call of ${e.f} used as a value`);
      break;
    }
    case "un": {
      if (e.op === "&") {
        if (e.e.k === "index" && e.e.b.k === "name" && e.e.b.v === "GSU.avReg") {
          const ic = constOf(e.e.i);
          return { w: ic !== null ? c(ic) : expr(fn, e.e.i).w, t: "regptr" };
        }
        fail(`${fn.name}: address of something other than a register`);
      }
      if (e.op === "*") { const lv = lvalue(fn, e); return { w: lv.get(), t: lv.t }; }
      if ((e.op === "~" || e.op === "-") && constOf(e) !== null) return { w: c(constOf(e) | 0), t: "s32" };
      const x = expr(fn, e.e);
      if (x.t !== "u32" && x.t !== "s32") fail(`${fn.name}: unary ${e.op} of ${x.t}`);
      if (e.op === "!") return { w: `(i32.eqz ${x.w})`, t: "s32" };
      if (e.op === "~") return { w: `(i32.xor ${x.w} ${c(-1)})`, t: x.t };
      if (e.op === "-") return { w: `(i32.sub ${c(0)} ${x.w})`, t: x.t };
      return x;
    }
    case "cast": {
      const x = expr(fn, e.e);
      if (x.t !== "u32" && x.t !== "s32") fail(`${fn.name}: cast of ${x.t}`);
      const ti = TYPEINFO[e.ty];
      if (!ti) fail(`${fn.name}: cast to ${e.ty}`);
      return { w: trunc(e.ty, x.w), t: ti.t };
    }
    case "bin": {
      // an integer constant expression (the flag masks: ~(FLG_ALT1 | FLG_ALT2 | FLG_B))
      const k = constOf(e);
      if (k !== null && Math.abs(k) <= 0x7fffffff) return { w: c(k | 0), t: "s32" };
      if (e.op === "&&" || e.op === "||") {
        const l = expr(fn, e.l), r = expr(fn, e.r);
        return e.op === "&&"
          ? { w: `(if (result i32) ${l.w} (then (i32.ne ${r.w} ${c(0)})) (else ${c(0)}))`, t: "s32" }
          : { w: `(if (result i32) ${l.w} (then ${c(1)}) (else (i32.ne ${r.w} ${c(0)})))`, t: "s32" };
      }
      const l = expr(fn, e.l), r = expr(fn, e.r);
      if (CMP[e.op]) {
        if (l.t === "regptr" && r.t === "regptr" && (e.op === "==" || e.op === "!=")) return { w: `(${CMP[e.op][0]} ${l.w} ${r.w})`, t: "s32" };
        const t = common(l.t, r.t, `${fn.name} ${e.op}`);
        return { w: `(${CMP[e.op][t === "u32" ? 1 : 0]} ${l.w} ${r.w})`, t: "s32" };
      }
      if ((e.op === "+" || e.op === "-") && l.t === "ptr") {
        if (r.t !== "s32" && r.t !== "u32") fail(`${fn.name}: pointer ${e.op} ${r.t}`);
        return { w: `(${ARITH[e.op]} ${l.w} ${r.w})`, t: "ptr" };
      }
      if (e.op === "+" && r.t === "ptr" && (l.t === "s32" || l.t === "u32")) return { w: `(i32.add ${l.w} ${r.w})`, t: "ptr" };
      if (e.op === ">>") {
        if (l.t !== "u32" && l.t !== "s32") fail(`${fn.name}: shift of ${l.t}`);
        return { w: `(${l.t === "u32" ? "i32.shr_u" : "i32.shr_s"} ${l.w} ${r.w})`, t: l.t };
      }
      if (e.op === "<<") {
        if (l.t !== "u32" && l.t !== "s32") fail(`${fn.name}: shift of ${l.t}`);
        return { w: `(i32.shl ${l.w} ${r.w})`, t: l.t };
      }
      if (e.op === "/" || e.op === "%") fail(`${fn.name}: division`);
      const t = common(l.t, r.t, `${fn.name} ${e.op}`);
      return { w: `(${ARITH[e.op]} ${l.w} ${r.w})`, t };
    }
    case "tern": {
      const cc = expr(fn, e.c), a = expr(fn, e.a), b = expr(fn, e.b);
      const t = common(a.t, b.t, `${fn.name} ?:`);
      return { w: `(if (result i32) ${cc.w} (then ${a.w}) (else ${b.w}))`, t };
    }
    case "pre": case "post": {
      const lv = lvalue(fn, e.e);
      if (lv.t !== "u32" && lv.t !== "s32") fail(`${fn.name}: ++/-- of ${lv.t}`);
      const d = e.op === "++" ? "i32.add" : "i32.sub";
      if (e.k === "pre") return { w: `(block (result i32) ${lv.set(`(${d} ${lv.get()} ${c(1)})`)} ${lv.get()})`, t: lv.t };
      const t = fn.tmp();
      const w = `(block (result i32) (local.set ${t} ${lv.get()}) ${lv.set(`(${d} (local.get ${t}) ${c(1)})`)} (local.get ${t}))`;
      fn.free();
      return { w, t: lv.t };
    }
    case "assign": {
      // an assignment used as a value (a chain): store, then read the
      // stored lvalue back (C: the value of the left operand after it)
      const s = assignStmt(fn, e);
      const lv = lvalue(fn, e.l);
      if (lv.kind === "bankptr") fail(`${fn.name}: bank pointer assignment used as a value`);
      return { w: `(block (result i32) ${s} ${lv.get()})`, t: lv.t };
    }
    default: fail(`${fn.name}: expression kind ${e.k}`);
  }
}

/** An assignment statement. */
function assignStmt(fn, e) {
  const lv = lvalue(fn, e.l);
  if (lv.kind === "bankptr") {
    if (e.op !== "=") fail(`${fn.name}: compound assignment to a bank pointer`);
    const r = e.r;
    const tab = r.k === "index" && r.b.k === "name" ? r.b.v : null;
    if (lv.bank === "ram" ? tab !== "GSU.apvRamBank" : tab !== "GSU.apvRomBank") fail(`${fn.name}: ${lv.bank} bank pointer from ${tab}`);
    return `(call $fx_set${lv.bank}bank ${expr(fn, r.i).w})`;
  }
  if (lv.kind === "regptr") {
    if (e.op !== "=") fail(`${fn.name}: compound assignment to a register pointer`);
    const r = expr(fn, e.r);
    if (r.t !== "regptr") fail(`${fn.name}: register pointer from ${r.t}`);
    return lv.set(r.w);
  }
  const r = expr(fn, e.r);
  if (e.op === "=") {
    if (lv.t === "ptr" ? r.t !== "ptr" : (r.t !== "u32" && r.t !== "s32")) fail(`${fn.name}: assign ${r.t} to ${lv.t}`);
    return lv.set(r.w);
  }
  const op = e.op.slice(0, -1);
  const l = { w: lv.get(), t: lv.t };
  if (l.t === "ptr" || r.t === "ptr" || r.t === "regptr") fail(`${fn.name}: compound pointer assignment`);
  let w;
  if (op === ">>") w = `(${l.t === "u32" ? "i32.shr_u" : "i32.shr_s"} ${l.w} ${r.w})`;
  else if (op === "<<") w = `(i32.shl ${l.w} ${r.w})`;
  else { common(l.t, r.t, `${fn.name} ${e.op}`); w = `(${ARITH[op]} ${l.w} ${r.w})`; }
  return lv.set(w);
}

// the fxemu.cpp functions a handler may call (hand-ported in superfx.js)
const EXTERNAL_CALLS = { fx_flushCache: "$fx_flushCache", fx_computeScreenPointers: "$fx_computeScreenPointers" };

function stmts(fn, list) { return list.map((s) => stmt(fn, s)).filter(Boolean).join("\n"); }
function stmt(fn, s) {
  switch (s.k) {
    case "block": return stmts(fn, s.body);
    case "return": return "(return)";
    case "decl": {
      const parts = [];
      for (const d of s.decls) {
        if (fn.locals[d.name] !== undefined && fn.locals[d.name] !== d.type) fail(`${fn.name}: ${d.name} redeclared as ${d.type}`);
        if (d.type.endsWith("*") && d.type !== "uint8*") fail(`${fn.name}: pointer type ${d.type}`);
        fn.locals[d.name] = d.type;
        if (d.init) parts.push(assignStmt(fn, { op: "=", l: { k: "name", v: d.name }, r: d.init }));
      }
      return parts.join("\n");
    }
    case "if": {
      const cc = expr(fn, s.c);
      if (cc.t !== "u32" && cc.t !== "s32" && cc.t !== "regptr") fail(`${fn.name}: condition of ${cc.t}`);
      const th = stmt(fn, s.th), el = s.el ? stmt(fn, s.el) : "";
      return `(if ${cc.w} (then ${th})${el ? ` (else ${el})` : ""})`;
    }
    case "expr": {
      const e = s.e;
      if (e.k === "assign") return assignStmt(fn, e);
      if (e.k === "call") {
        if (EXTERNAL_CALLS[e.f]) return `(call ${EXTERNAL_CALLS[e.f]})`;
        if (/^fx_\w+$/.test(e.f)) { fn.calls.add(e.f); return `(call $${e.f})`; }
        fail(`${fn.name}: call of ${e.f}`);
      }
      if (e.k === "pre" || e.k === "post") return `(drop ${expr(fn, e).w})`;
      fail(`${fn.name}: expression statement ${e.k}`);
      break;
    }
    default: fail(`${fn.name}: statement ${s.k}`);
  }
}

// ---------------------------------------------------------------- handlers
const functions = {};
const fnRe = /static\s+void\s+(fx_\w+)\s*\(\s*void\s*\)\s*\{/g;
let m;
while ((m = fnRe.exec(cText))) {
  let depth = 1, j = fnRe.lastIndex;
  while (depth) { if (cText[j] === "{") depth++; else if (cText[j] === "}") depth--; j++; }
  const name = m[1];
  if (functions[name]) fail(`${name} defined twice`);
  const toks = numeric(expandTokens(lex(cText.slice(fnRe.lastIndex, j - 1)), macros));
  const p = new Parser(toks);
  const body = [];
  while (!p.done()) body.push(p.stmt());
  const fn = new Fn(name);
  const text = stmts(fn, body);
  const locals = [...Object.keys(fn.locals).map((n) => `(local $${n} i32)`), ...Array.from({ length: fn.maxtmp }, (_, i) => `(local $t${i} i32)`)];
  functions[name] = { wat: `(func $${name} ${locals.join(" ")}\n${text})`, calls: [...fn.calls] };
  fnRe.lastIndex = j;
}
for (const [n, f] of Object.entries(functions)) for (const k of f.calls) if (!functions[k]) fail(`${n} calls ${k}, which is not a handler`);

// ---------------------------------------------------------------- tables
function initList(name) {
  const at = cText.indexOf(name);
  if (at < 0) fail(`${name} not found`);
  const body = cText.slice(cText.indexOf("{", at) + 1, cText.indexOf("};", at));
  return body.split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
    const mm = /^&(fx_\w+)$/.exec(t);
    if (!mm) fail(`${name}: element '${t}'`);
    if (!functions[mm[1]]) fail(`${name}: ${mm[1]} is not a handler`);
    return mm[1];
  });
}
const opcodeTable = initList("(*fx_OpcodeTable[]) (void) =");
const plotTable = initList("(*fx_PlotTable[]) (void) =");
if (opcodeTable.length !== 1024) fail(`fx_OpcodeTable has ${opcodeTable.length} entries, expected 1024`);
if (plotTable.length !== 10) fail(`fx_PlotTable has ${plotTable.length} entries, expected 10`);
// Structural invariants: stop at $00 in every ALT table, plot/rpix at $4C
// in ALT0/ALT2 and ALT1/ALT3 (fx_readRegisterSpace overrides these four
// entries by mode), IWT/LM/SM at $F0.
for (let a = 0; a < 4; a++) if (opcodeTable[a * 256] !== "fx_stop") fail("stop not at $00");
if (opcodeTable[0x04c] !== plotTable[0] || opcodeTable[0x14c] !== plotTable[5]) fail("plot/rpix not at $4C");
if (opcodeTable[0x0f0] !== "fx_iwt_r0" || opcodeTable[0x1f0] !== "fx_lm_r0" || opcodeTable[0x2f0] !== "fx_sm_r0") fail("$F0 row");

// The instruction step and the pipe (fxinst.h), which superfx.js's
// $fx_run follows by hand: check they are still what it implements.
const tokText = (t) => t.map((x) => x.v).join(" ");
const want = {
  FETCHPIPE: "{ PIPE = PRGBANK ( R15 ) ; }",
  FX_STEP: "{ uint32 vOpcode = ( uint32 ) PIPE ; FETCHPIPE ; ( * fx_OpcodeTable [ ( GSU . vStatusReg & 0x300 ) | vOpcode ] ) ( ) ; }",
};
for (const [k, v] of Object.entries(want)) {
  const got = tokText(macros.get(k).body).replace(/768/g, "0x300");
  if (got !== v) fail(`${k} changed: ${got}`);
}
// fx_run: the loop superfx.js implements
if (!/GSU\.vCounter = nInstructions;\s*while \(TF\(G\) && \(GSU\.vCounter-- > 0\)\)\s*FX_STEP;/.test(stripComments(instC))) fail("fx_run's loop changed");

// ---------------------------------------------------------------- fxemu.cpp constants
const emu = stripComments(emuC);
const spd = /SuperFX\.speedPerLine = \(uint32\) \((\d+) \* \(\(1\.0 \/ \(float\) Memory\.ROMFramesPerSecond\) \/ \(\(float\) \(Timings\.V_Max\)\)\)\);/.exec(emu);
if (!spd) fail("speedPerLine formula changed");
const arr = (name) => {
  const mm = new RegExp(`static const uint32\\s+${name}\\[\\]\\s*=\\s*\\{([^}]*)\\}`).exec(emu);
  if (!mm) fail(`${name} not found in fxemu.cpp`);
  return mm[1].split(",").map((s) => Number(s.trim()));
};
const avHeight = arr("avHeight"), avMult = arr("avMult");
if (avHeight.join() !== "128,160,192,256" || avMult.join() !== "16,32,32,64") fail("avHeight/avMult changed");
const clsr = /\(Memory\.FillRAM\[0x3000 \+ GSU_CLSR\] & 1\) \? \(SuperFX\.speedPerLine \* 5 \/ 2\) : SuperFX\.speedPerLine\) \* Settings\.SuperFXClockMultiplier \/ 100/.test(emu);
if (!clsr) fail("S9xSuperFXExec's speed expression changed");

const data = {
  provenance: {
    source: "snes9x",
    url: pin?.url ?? "https://github.com/libretro/snes9x.git",
    commit: pin?.commit ?? null,
    files: { "fxinst.cpp": sha(instC), "fxinst.h": sha(instH), "fxemu.cpp": sha(emuC), "fxemu.h": sha(emuH) },
    generator: "scripts/recompile-gen/snes9x-superfx.mjs",
    note: "snes9x is under the snes9x license (non-commercial); this is a mechanical translation of its SuperFX instruction handlers used only to build carts compared against the snes9x reference. fxemu.cpp is hand-ported in superfx.js; its hash is here so a change to it is noticed.",
  },
  speedConstant: Number(spd[1]),
  avHeight,
  avMult,
  opcodeTable,
  plotTable,
  functions: Object.fromEntries(Object.entries(functions).map(([k, v]) => [k, v.wat])),
};
const text = JSON.stringify(data, null, 1) + "\n";
if (check) {
  const cur = readFileSync(out, "utf8");
  if (cur !== text) { console.error(`${out} is stale; rerun without --check`); process.exit(1); }
  console.log(`${out} up to date`);
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out} (${Object.keys(functions).length} handlers, ${opcodeTable.length} opcode entries)`);
}
