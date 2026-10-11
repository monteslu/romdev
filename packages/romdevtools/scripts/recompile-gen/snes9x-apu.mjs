#!/usr/bin/env node
// Translate snes9x's SPC700 (S-SMP) core into WAT for the SNES WAT
// recompiler and extract the S-DSP's data tables, and write both as
// committed data (src/analysis/recompile/wat/snes/snes9x-apu.json).
//
// The source is snes9x's bapu SMP: smp/core/oppseudo_{misc,mov,pc,read,rmw}.cpp
// (one `case 0xNN:` per opcode, some split into resumable steps with
// `switch(++opcode_cycle)`) and smp/algorithms.cpp (op_adc ... op_ror). The
// 64-byte boot ROM is romdev's own (scripts/spc700-ipl, MIT), never snes9x's
// iplrom.cpp. The SMP files use a small C subset:
// assignments, compound assignments, pre/post increment, if/else, the
// opcode_cycle switch, `break`, casts to int8, and calls to the op_* bus
// helpers. This script parses exactly that subset and REFUSES anything
// else, so an upstream change that goes beyond it fails here instead of
// being translated wrongly.
//
// C semantics kept: every expression is evaluated in 32-bit int; a store
// truncates to the destination's C type (uint8 registers, uint16 temps and
// pc, bool flags become 0/1); call arguments are truncated to the callee's
// parameter type (op_read/op_write take uint16 addresses, op_write a uint8
// datum). The bus helpers themselves ($s_read, $s_write, $s_readpc,
// $s_tick ...) are written by hand in apu-wat.js from smp/memory.cpp and
// smp/timing.cpp, which are not in this subset (struct timers, the DSP).
//
// Recompile time never needs the snes9x source; only this script does.
//
// usage: snes9x-apu.mjs [<snes9x src dir>] [<out.json>] [--check]
//   default src: ${ROMDEV_BUILD_DIR:-<pkg>/build}/snes9x/src (build-snes9x.sh's clone)
//   --check: regenerate in memory and fail if the committed file differs.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..", "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const check = process.argv.includes("--check");
const srcDir = args[0] ||
  path.join(process.env.ROMDEV_BUILD_DIR || path.join(pkg, "build"), "snes9x", "src");
const out = args[1] ||
  path.join(pkg, "src", "analysis", "recompile", "wat", "snes", "snes9x-apu.json");
const smpDir = path.join(srcDir, "apu", "bapu", "smp");

const versions = JSON.parse(readFileSync(path.join(pkg, "scripts", "versions.json"), "utf8"));
const pin = versions.cores?.snes9x ?? versions.snes9x;
const sha = (t) => createHash("sha256").update(t).digest("hex");

// ---------------------------------------------------------------- lexer
const PUNCT = ["<<=", ">>=", "++", "--", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||",
  "+=", "-=", "*=", "/=", "%=", "|=", "&=", "^=", "{", "}", "(", ")", ";", ":", ",", "?",
  "=", "+", "-", "*", "/", "%", "<", ">", "&", "|", "^", "!", "~", "."];

function lex(src) {
  const toks = [];
  let i = 0;
  src = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    let m;
    if ((m = /^0x[0-9a-fA-F]+|^[0-9]+/.exec(src.slice(i, i + 12)))) {
      toks.push({ t: "num", v: Number(m[0]) }); i += m[0].length; continue;
    }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 64)))) {
      toks.push({ t: "id", v: m[0] }); i += m[0].length; continue;
    }
    const p = PUNCT.find((q) => src.startsWith(q, i));
    if (!p) throw new Error(`spc700 gen: unexpected character '${c}' in: ${src.slice(i, i + 40)}`);
    toks.push({ t: "p", v: p }); i += p.length;
  }
  return toks;
}

// ---------------------------------------------------------------- parser
const TYPES = new Set(["int", "unsigned", "uint8", "uint16", "int8", "bool"]);

class Parser {
  constructor(toks) { this.t = toks; this.i = 0; }
  peek(o = 0) { return this.t[this.i + o]; }
  is(v, o = 0) { const k = this.peek(o); return k && k.t !== "num" && k.v === v; }
  next() { const k = this.t[this.i++]; if (!k) throw new Error("spc700 gen: unexpected end"); return k; }
  eat(v) { const k = this.next(); if (k.v !== v) throw new Error(`spc700 gen: expected '${v}', got '${k.v}' near token ${this.i}`); return k; }
  done() { return this.i >= this.t.length; }

  block() { // after '{'
    const body = [];
    while (!this.is("}")) body.push(this.stmt());
    this.eat("}");
    return body;
  }
  stmt() {
    if (this.is("{")) { this.next(); return { k: "block", body: this.block() }; }
    if (this.is(";")) { this.next(); return { k: "block", body: [] }; }
    if (this.is("break")) { this.next(); this.eat(";"); return { k: "break" }; }
    if (this.is("return")) { this.next(); const e = this.expr(); this.eat(";"); return { k: "return", e }; }
    if (this.is("if")) {
      this.next(); this.eat("("); const c = this.expr(); this.eat(")");
      const th = this.stmt();
      let el = null;
      if (this.is("else")) { this.next(); el = this.stmt(); }
      return { k: "if", c, th, el };
    }
    if (this.is("switch")) {
      this.next(); this.eat("("); const e = this.expr(); this.eat(")"); this.eat("{");
      const cases = [];
      while (!this.is("}")) {
        this.eat("case");
        const n = this.next();
        if (n.t !== "num") throw new Error("spc700 gen: case label must be a number");
        this.eat(":");
        const body = [];
        while (!this.is("case") && !this.is("}")) body.push(this.stmt());
        cases.push({ n: n.v, body });
      }
      this.eat("}");
      return { k: "switch", e, cases };
    }
    const k0 = this.peek();
    if (k0.t === "id" && TYPES.has(k0.v) && this.peek(1)?.t === "id") {
      this.next();
      const name = this.next().v;
      let init = null;
      if (this.is("=")) { this.next(); init = this.expr(); }
      this.eat(";");
      return { k: "decl", type: k0.v, name, init };
    }
    const e = this.expr();
    this.eat(";");
    return { k: "expr", e };
  }
  expr() { return this.assign(); }
  assign() {
    const l = this.ternary();
    const k = this.peek();
    if (k && k.t === "p" && ["=", "+=", "-=", "*=", "/=", "%=", "|=", "&=", "^=", "<<=", ">>="].includes(k.v)) {
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
    if (k.t === "p" && ["!", "~", "-", "+"].includes(k.v)) { this.next(); return { k: "un", op: k.v, e: this.unary() }; }
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
        if (e.k !== "name") throw new Error("spc700 gen: call of a non-name");
        this.next();
        const a = [];
        while (!this.is(")")) { a.push(this.assign()); if (this.is(",")) this.next(); }
        this.eat(")");
        e = { k: "call", f: e.v, a };
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
    throw new Error(`spc700 gen: unexpected token '${k.v}'`);
  }
}

// ---------------------------------------------------------------- emitter
// Machine state the opcode bodies touch, and the C type of each.
const REGS = {
  "regs.B.a": ["$s_a", 8], "regs.B.y": ["$s_y", 8], "regs.x": ["$s_x", 8], "regs.sp": ["$s_sp", 8],
  "regs.pc": ["$s_pc", 16],
  rd: ["$s_rd", 16], wr: ["$s_wr", 16], dp: ["$s_dp", 16], sp: ["$s_tsp", 16], ya: ["$s_ya", 16], bit: ["$s_bit", 16],
  opcode_cycle: ["$s_ocyc", 32], opcode_number: ["$s_op", 32],
};
const FLAGS = { n: "$s_fn", v: "$s_fv", p: "$s_fp", b: "$s_fb", h: "$s_fh", i: "$s_fi", z: "$s_fz", c: "$s_fc" };
const MASK = { 8: 0xff, 16: 0xffff };
const TYPEBITS = { uint8: 8, uint16: 16, int: 32, unsigned: 32, bool: 1 };
/** algorithm name -> {params: [bits], ret: bits} (filled from algorithms.cpp) */
const ALGO = {};

class Fn {
  constructor(locals = {}) { this.locals = locals; this.ntmp = 0; this.maxtmp = 0; }
  tmp() { const n = this.ntmp++; this.maxtmp = Math.max(this.maxtmp, this.ntmp); return `$t${n}`; }
  free() { this.ntmp--; }
}

const c = (v) => `(i32.const ${v})`;
const maskTo = (bits, w) => (bits === 8 || bits === 16 ? `(i32.and ${w} ${c(MASK[bits])})` : bits === 1 ? `(i32.ne ${w} ${c(0)})` : w);

/** read an lvalue name */
function getName(fn, name) {
  if (fn.locals[name] !== undefined) return `(local.get $${name})`;
  if (REGS[name]) return `(global.get ${REGS[name][0]})`;
  if (name === "regs.ya") return `(i32.or (global.get $s_a) (i32.shl (global.get $s_y) ${c(8)}))`;
  if (name === "regs.p") return "(call $s_getp)";
  const f = /^regs\.p\.([nvpbhizc])$/.exec(name);
  if (f) return `(global.get ${FLAGS[f[1]]})`;
  throw new Error(`spc700 gen: unknown name ${name}`);
}
/** store `w` (an i32 expression) into an lvalue name with C truncation */
function setName(fn, name, w) {
  if (fn.locals[name] !== undefined) return `(local.set $${name} ${maskTo(fn.locals[name], w)})`;
  if (REGS[name]) return `(global.set ${REGS[name][0]} ${maskTo(REGS[name][1], w)})`;
  if (name === "regs.ya") return `(call $s_setya ${w})`;
  if (name === "regs.p") return `(call $s_setp ${w})`;
  const f = /^regs\.p\.([nvpbhizc])$/.exec(name);
  if (f) return `(global.set ${FLAGS[f[1]]} (i32.ne ${w} ${c(0)}))`;
  throw new Error(`spc700 gen: cannot assign ${name}`);
}

const BIN = {
  "+": "i32.add", "-": "i32.sub", "*": "i32.mul", "/": "i32.div_s", "%": "i32.rem_s",
  "<<": "i32.shl", ">>": "i32.shr_s", "&": "i32.and", "|": "i32.or", "^": "i32.xor",
  "==": "i32.eq", "!=": "i32.ne", "<": "i32.lt_s", ">": "i32.gt_s", "<=": "i32.le_s", ">=": "i32.ge_s",
};

const dpAddr = (w) => `(i32.add (i32.shl (global.get $s_fp) ${c(8)}) (i32.and ${w} ${c(0xff)}))`;
const u16 = (w) => `(i32.and ${w} ${c(0xffff)})`;
const u8 = (w) => `(i32.and ${w} ${c(0xff)})`;

/** @returns {{w: string, v: boolean}} v = produces a value */
function call(fn, f, a) {
  const E = (x) => expr(fn, x);
  switch (f) {
    case "op_io": return { w: a.length ? `(call $s_tickn ${E(a[0])})` : "(call $s_tick)", v: false };
    case "op_readpc": return { w: "(call $s_readpc)", v: true };
    case "op_readdp": return { w: `(call $s_read ${dpAddr(E(a[0]))})`, v: true };
    case "op_writedp": return { w: `(call $s_write ${dpAddr(E(a[0]))} ${u8(E(a[1]))})`, v: false };
    case "op_readaddr": return { w: `(call $s_read ${u16(E(a[0]))})`, v: true };
    case "op_writeaddr": return { w: `(call $s_write ${u16(E(a[0]))} ${u8(E(a[1]))})`, v: false };
    case "op_readstack": return { w: "(call $s_readstack)", v: true };
    case "op_writestack": return { w: `(call $s_writestack ${u8(E(a[0]))})`, v: false };
    default: {
      const al = ALGO[f];
      if (!al) throw new Error(`spc700 gen: unknown call ${f}`);
      if (al.params.length !== a.length) throw new Error(`spc700 gen: ${f} arity`);
      return { w: `(call $s_${f} ${a.map((x, i) => maskTo(al.params[i], E(x))).join(" ")})`, v: true };
    }
  }
}

function expr(fn, e) {
  switch (e.k) {
    case "num": return c(e.v);
    case "name": return getName(fn, e.v);
    case "call": {
      const r = call(fn, e.f, e.a);
      if (!r.v) throw new Error(`spc700 gen: void call ${e.f} used as a value`);
      return r.w;
    }
    case "un": {
      const x = expr(fn, e.e);
      if (e.op === "!") return `(i32.eqz ${x})`;
      if (e.op === "~") return `(i32.xor ${x} ${c(-1)})`;
      if (e.op === "-") return `(i32.sub ${c(0)} ${x})`;
      return x;
    }
    case "cast": {
      const x = expr(fn, e.e);
      if (e.ty === "int8") return `(i32.extend8_s ${x})`;
      if (e.ty === "uint8") return u8(x);
      if (e.ty === "uint16") return u16(x);
      if (e.ty === "unsigned" || e.ty === "int") return x;
      if (e.ty === "bool") return `(i32.ne ${x} ${c(0)})`;
      throw new Error(`spc700 gen: cast ${e.ty}`);
    }
    case "bin": {
      if (e.op === "&&") return `(if (result i32) ${expr(fn, e.l)} (then (i32.ne ${expr(fn, e.r)} ${c(0)})) (else ${c(0)}))`;
      if (e.op === "||") return `(if (result i32) ${expr(fn, e.l)} (then ${c(1)}) (else (i32.ne ${expr(fn, e.r)} ${c(0)})))`;
      return `(${BIN[e.op]} ${expr(fn, e.l)} ${expr(fn, e.r)})`;
    }
    case "tern": return `(if (result i32) ${expr(fn, e.c)} (then ${expr(fn, e.a)}) (else ${expr(fn, e.b)}))`;
    case "pre": case "post": {
      if (e.e.k !== "name") throw new Error("spc700 gen: ++/-- of a non-name");
      const d = e.op === "++" ? "i32.add" : "i32.sub";
      const t = fn.tmp();
      let w;
      if (e.k === "pre") {
        w = `(block (result i32) ${setName(fn, e.e.v, `(${d} ${getName(fn, e.e.v)} ${c(1)})`)} ${getName(fn, e.e.v)})`;
      } else {
        w = `(block (result i32) (local.set ${t} ${getName(fn, e.e.v)}) ${setName(fn, e.e.v, `(${d} (local.get ${t}) ${c(1)})`)} (local.get ${t}))`;
      }
      fn.free();
      return w;
    }
    case "assign": throw new Error("spc700 gen: assignment used as a value");
    default: throw new Error(`spc700 gen: expr kind ${e.k}`);
  }
}

/** statements -> WAT; `brk` is what `break` becomes in this context */
function stmts(fn, list, brk) {
  return list.map((s) => stmt(fn, s, brk)).join("\n");
}
function stmt(fn, s, brk) {
  switch (s.k) {
    case "block": return stmts(fn, s.body, brk);
    case "break": return brk;
    case "return": return `(return ${maskTo(fn.ret, expr(fn, s.e))})`;
    case "decl": {
      fn.locals[s.name] = TYPEBITS[s.type];
      return s.init ? setName(fn, s.name, expr(fn, s.init)) : "";
    }
    case "if": return `(if ${expr(fn, s.c)} (then ${stmt(fn, s.th, brk)})${s.el ? ` (else ${stmt(fn, s.el, brk)})` : ""})`;
    case "switch": {
      if (!(s.e.k === "pre" && s.e.op === "++" && s.e.e.k === "name" && s.e.e.v === "opcode_cycle")) throw new Error("spc700 gen: only switch(++opcode_cycle) is supported");
      const head = setName(fn, "opcode_cycle", `(i32.add ${getName(fn, "opcode_cycle")} ${c(1)})`);
      return head + "\n" + s.cases.map((k) => `(if (i32.eq (global.get $s_ocyc) ${c(k.n)}) (then\n${stmts(fn, k.body, brk)}))`).join("\n");
    }
    case "expr": {
      const e = s.e;
      if (e.k === "assign") {
        if (e.l.k !== "name") throw new Error("spc700 gen: assignment to a non-name");
        const r = expr(fn, e.r);
        if (e.op === "=") return setName(fn, e.l.v, r);
        const op = e.op.slice(0, -1);
        return setName(fn, e.l.v, `(${BIN[op]} ${getName(fn, e.l.v)} ${r})`);
      }
      if (e.k === "call") { const r = call(fn, e.f, e.a); return r.v ? `(drop ${r.w})` : r.w; }
      if (e.k === "tern") {
        const side = (x) => (x.k === "call" ? (() => { const r = call(fn, x.f, x.a); return r.v ? `(drop ${r.w})` : r.w; })() : `(drop ${expr(fn, x)})`);
        return `(if ${expr(fn, e.c)} (then ${side(e.a)}) (else ${side(e.b)}))`;
      }
      if (e.k === "pre" || e.k === "post") return `(drop ${expr(fn, e)})`;
      throw new Error(`spc700 gen: expression statement ${e.k}`);
    }
    default: throw new Error(`spc700 gen: statement ${s.k}`);
  }
}

// ---------------------------------------------------------------- algorithms.cpp
const algoSrc = readFileSync(path.join(smpDir, "algorithms.cpp"), "utf8");
const functions = {};
{
  const re = /(uint8|uint16)\s+SMP::(op_[a-z]+)\s*\(([^)]*)\)\s*\{/g;
  let m;
  const found = [];
  while ((m = re.exec(algoSrc))) {
    let depth = 1, j = re.lastIndex;
    while (depth) { if (algoSrc[j] === "{") depth++; else if (algoSrc[j] === "}") depth--; j++; }
    const params = m[3].split(",").map((p) => p.trim().split(/\s+/));
    ALGO[m[2]] = { params: params.map((p) => TYPEBITS[p[0]]), ret: TYPEBITS[m[1]], names: params.map((p) => p[1]), body: algoSrc.slice(re.lastIndex, j - 1) };
    found.push(m[2]);
  }
  const want = ["op_adc", "op_addw", "op_and", "op_cmp", "op_cmpw", "op_eor", "op_or", "op_sbc", "op_subw", "op_inc", "op_dec", "op_asl", "op_lsr", "op_rol", "op_ror"];
  for (const w of want) if (!ALGO[w]) throw new Error(`spc700 gen: ${w} not found in algorithms.cpp`);
  for (const name of found) {
    const al = ALGO[name];
    const locals = {};
    al.names.forEach((n, i) => { locals[n] = al.params[i]; });
    const fn = new Fn(locals);
    fn.ret = al.ret;
    const p = new Parser(lex(al.body));
    const body = [];
    while (!p.done()) body.push(p.stmt());
    const text = stmts(fn, body, "(unreachable)");
    const extra = Object.keys(locals).filter((n) => !al.names.includes(n));
    const tmps = Array.from({ length: fn.maxtmp }, (_, i) => `(local $t${i} i32)`);
    functions[name] = `(func $s_${name} ${al.names.map((n) => `(param $${n} i32)`).join(" ")} (result i32) ${[...extra.map((n) => `(local $${n} i32)`), ...tmps].join(" ")}\n${text}\n(unreachable))`;
  }
}

// ---------------------------------------------------------------- opcodes
const opFiles = ["oppseudo_misc.cpp", "oppseudo_mov.cpp", "oppseudo_pc.cpp", "oppseudo_read.cpp", "oppseudo_rmw.cpp"];
const ops = new Array(256).fill(null);
const multiStep = [];
const fileSha = {};
let maxtmp = 0;
for (const f of opFiles) {
  const src = readFileSync(path.join(smpDir, "core", f), "utf8");
  fileSha[`apu/bapu/smp/core/${f}`] = sha(src);
  const re = /case 0x([0-9a-f]{2}):\s*\{/g;
  let m;
  let last = 0;
  while ((m = re.exec(src))) {
    if (src.slice(last, m.index).trim() !== "") throw new Error(`spc700 gen: ${f}: text between cases: ${src.slice(last, m.index).trim().slice(0, 60)}`);
    let depth = 1, j = re.lastIndex;
    while (depth) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; j++; }
    const op = parseInt(m[1], 16);
    if (ops[op]) throw new Error(`spc700 gen: opcode $${m[1]} defined twice`);
    const p = new Parser(lex(src.slice(re.lastIndex, j - 1)));
    const body = [];
    while (!p.done()) body.push(p.stmt());
    // Shape check: `break` must end the opcode; a switch must be followed
    // only by that break (so every break inside it can end the opcode too).
    const si = body.findIndex((s) => s.k === "switch");
    if (si >= 0) {
      if (!(si === body.length - 2 && body[si + 1].k === "break")) throw new Error(`spc700 gen: $${m[1]}: switch not in tail position`);
      multiStep.push(op);
    }
    const fn = new Fn({});
    ops[op] = stmts(fn, body, "(return)");
    maxtmp = Math.max(maxtmp, fn.maxtmp);
    last = j;
    re.lastIndex = j;
  }
  if (src.slice(last).trim() !== "") throw new Error(`spc700 gen: ${f}: trailing text`);
}
const missing = ops.map((o, i) => (o === null ? i : -1)).filter((i) => i >= 0);
if (missing.length) throw new Error(`spc700 gen: opcodes not defined: ${missing.map((i) => i.toString(16)).join(",")}`);

// ---------------------------------------------------------------- boot ROM
// romdev's own SPC700 boot ROM (scripts/spc700-ipl/ipl.asm, MIT, a clean-room
// reimplementation of the upload protocol), as build-ipl.mjs wrote it. The
// snes9x core is built with the same bytes (scripts/spc700-ipl/install-ipl.mjs).
const iplPath = path.join(pkg, "scripts", "spc700-ipl", "romdev_iplrom.h");
const iplSrc = readFileSync(iplPath, "utf8");
const iplrom = [...iplSrc.replace(/\/\/[^\n]*/g, "").matchAll(/0x([0-9a-f]{2})/gi)].map((x) => parseInt(x[1], 16));
if (iplrom.length !== 64) throw new Error(`spc700 gen: romdev_iplrom.h has ${iplrom.length} bytes, expected 64`);
// Structural invariant: the reset vector points into the boot ROM.
if (iplrom[63] !== 0xff || iplrom[62] < 0xc0) throw new Error("spc700 gen: boot ROM reset vector check failed");

// ---------------------------------------------------------------- SPC_DSP.cpp tables
// The DSP itself is hand-ported in apu-wat.js (pointer-heavy C outside the
// subset above); only its constant tables are data.
const dspSrc = readFileSync(path.join(srcDir, "apu", "bapu", "dsp", "SPC_DSP.cpp"), "utf8");
function cArray(name, n) {
  const at = dspSrc.indexOf(name);
  if (at < 0) throw new Error(`spc700 gen: ${name} not found in SPC_DSP.cpp`);
  const body = dspSrc.slice(dspSrc.indexOf("{", at) + 1, dspSrc.indexOf("};", at))
    .replace(/\/\/[^\n]*/g, "");
  // Elements are integer literals or `simple_counter_range + 1`.
  const scr = /int const simple_counter_range = ([^;]+);/.exec(dspSrc);
  const range = scr ? Function(`return (${scr[1]})`)() : NaN;
  const vals = body.split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
    if (/^-?(0x[0-9a-f]+|\d+)$/i.test(t)) return Number(t);
    const m = /^simple_counter_range\s*\+\s*1$/.exec(t);
    if (m) return range + 1;
    throw new Error(`spc700 gen: ${name}: element '${t}'`);
  });
  if (vals.length !== n) throw new Error(`spc700 gen: ${name} has ${vals.length} elements, expected ${n}`);
  return vals;
}
const gauss = cArray("short const gauss [512]", 512);
const counterRates = cArray("counter_rates [32]", 32);
const counterOffsets = cArray("counter_offsets [32]", 32);
const initialRegs = cArray("initial_regs [SPC_DSP::register_count]", 128);
// Invariants: the gaussian table rises monotonically from 0 to 1305 and its
// mirrored pairs sum to at most 2048 (unit gain); rate 0 never fires.
if (gauss[0] !== 0 || gauss[511] !== 1305 || gauss.some((v, i) => i && v < gauss[i - 1])) throw new Error("spc700 gen: gauss table shape");
if (counterRates[0] !== 30721 || counterRates[31] !== 1 || counterRates[1] !== 2048) throw new Error("spc700 gen: counter_rates shape");

const data = {
  provenance: {
    source: "snes9x",
    url: pin?.url ?? "https://github.com/libretro/snes9x.git",
    commit: pin?.commit ?? null,
    files: {
      ...fileSha,
      "apu/bapu/smp/algorithms.cpp": sha(algoSrc),
      "apu/bapu/dsp/SPC_DSP.cpp": sha(dspSrc),
    },
    generator: "scripts/recompile-gen/snes9x-apu.mjs",
    iplrom: { source: "scripts/spc700-ipl/ipl.asm", license: "MIT (romdev)", sha256: sha(iplSrc), note: "romdev's own SPC700 boot ROM, a clean-room reimplementation of the boot upload protocol; not from snes9x" },
    note: "snes9x is under the snes9x license (non-commercial); this is a mechanical translation of its SMP core used only to build carts compared against the snes9x reference.",
  },
  iplrom,
  multiStep,
  opTemps: maxtmp,
  functions,
  ops,
  dsp: { gauss, counterRates, counterOffsets, initialRegs },
};
const text = JSON.stringify(data, null, 1) + "\n";
if (check) {
  const cur = readFileSync(out, "utf8");
  if (cur !== text) { console.error(`${out} is stale; rerun without --check`); process.exit(1); }
  console.log(`${out} up to date`);
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out} (${ops.length} opcodes, ${multiStep.length} multi-step, ${Object.keys(functions).length} helpers)`);
}
