// Motorola-syntax 68k assembly → GNU as source (romdev's m68k-asm front end).
//
// Genesis assembly in romdev is written in Motorola syntax - the dialect of
// the Sega-era toolchains and of every 68k tutorial: `$hex`, `%binary`,
// labels in column 0, `;` and `*` comments, `dc.b`/`dcb.l`/`ds.w`, `org`,
// `equ`, `rept`, `macro` with `\1`..`\9`, `.local` labels, and so on. It is
// assembled by GNU as (m68k-elf-as) from romdev-toolchain-m68k-gcc. GNU as has
// a Motorola-flavoured mode, but it differs in the places that matter (no ORG,
// different operator precedence, different local labels, `if` means a
// structured-control statement), so this front end translates the source
// instead:
//
//   1. Preprocess: read the main file, inline `include`s, expand macros and
//      `rept` blocks, evaluate conditional assembly, track `equ`/`set`
//      constants and local-label scopes. Everything the original syntax
//      decides at parse time is decided here, with the same rules.
//   2. Emit: print each statement in GNU as syntax. Every `org` block becomes
//      its own section, placed at its address by a generated linker script,
//      so blocks may appear in any order and gaps are zero-filled - the flat
//      ROM image Genesis wants. Labels stay relocatable where GNU as can relax
//      against them (branches, PC-relative operands); in any expression GNU as
//      could not relocate (shifts, masks, products, `ds` counts...) a label L
//      is written as `(base + (L - section_start))`, which GNU as resolves to
//      a constant once its layout is final.
//
// The result carries a line map so GNU as and ld diagnostics can be reported
// against the original file and line.
//
// Plain JS ESM + JSDoc.

import {
  parseExpr, foldExpr, evalExpr, printExpr, numText, readIdent, readString, exprSymbols,
  linearReloc, hasReloc, exprUsesPc, ExprError, isRegister,
} from "./expr.js";
import { splitOperands, parseOperand, mapOperand, printOperand, operandExprs } from "./operand.js";
import { peephole } from "./peephole.js";

/** @typedef {import("./expr.js").Expr} Expr */

const SIZE_BYTES = { b: 1, w: 2, l: 4, s: 4, q: 8, d: 8, x: 12, p: 12 };
const MAX_MACRO_DEPTH = 256;
const MAX_INCLUDE_DEPTH = 64;
const MAX_REPT_LINES = 4_000_000;

// Directives whose operand is free text up to a `;` comment.
const FREE_TEXT = new Set(["fail", "echo", "printt", "ttl", "idnt", "comment", "output", "msource", "showoffset", "error", "warning", "print"]);
// Directives that only affect listings or object formats this ROM build does
// not produce; accepted and ignored.
const IGNORED = new Set([
  "list", "nolist", "page", "nopage", "llen", "plen", "spc", "ttl", "idnt", "output",
  "msource", "comment", "showoffset", "opt", "machine", "mc68000", "symdebug", "debug",
  "pushsection", "popsection", "nref", "xref", "cseg", "dseg", "printv", "auto",
]);
const SECTION_DIRECTIVES = new Set(["section", "text", "data", "bss", "code", "code_c", "code_f", "data_c", "data_f", "bss_c", "bss_f"]);
const SHIFT_OPS = new Set(["asl", "asr", "lsl", "lsr", "rol", "ror", "roxl", "roxr"]);
const COND_DIRECTIVES = new Set([
  "if", "ifeq", "ifne", "ifgt", "ifge", "iflt", "ifle", "ifb", "ifnb", "ifc", "ifnc",
  "ifd", "ifnd", "ifdef", "ifndef", "ifmacrod", "ifmacrond", "if1", "if2", "ifp1",
  "else", "elseif", "elif", "endif", "endc",
]);

/**
 * @typedef {Object} SrcLine
 * @property {string} text
 * @property {string} file
 * @property {number} line
 * @property {string} [where]  macro context, e.g. "in macro FOO called from main.s:12"
 */

/**
 * Split one source line into label / mnemonic / operand field.
 * @param {string} raw
 * @param {(name:string)=>boolean} [isMacro]  operand fields of macro calls keep `<...>` groups
 * @returns {{label:string|null, global:boolean, mnem:string|null, ops:string, opsRaw:string} | null}
 */
export function lexLine(raw, isMacro = () => false) {
  const s = raw.replace(/\r$/, "");
  if (/^\s*$/.test(s)) return null;
  if (s[0] === "*" || /^\s*;/.test(s)) return null;
  let i = 0;
  let label = null, global = false;
  if (!/\s/.test(s[0])) {
    // label in column 0 (colon optional)
    const id = readIdent(s, 0) ?? readMacroIdent(s, 0);
    if (!id) {
      // `=` style or junk; let the mnemonic reader see it
      return { label: null, global: false, mnem: "?", ops: s.trim(), opsRaw: s.trim(), bad: true };
    }
    label = id.name;
    i = id.end;
    if (s[i] === ":") { i++; if (s[i] === ":") { global = true; i++; } }
  }
  while (i < s.length && /\s/.test(s[i])) i++;
  if (i >= s.length || s[i] === ";") return { label, global, mnem: null, ops: "", opsRaw: "" };
  // `label = expr` / `label=expr`
  if (label && s[i] === "=") {
    const rest = s.slice(i + 1);
    const f = operandField(rest.replace(/^\s+/, ""), false);
    return { label, global, mnem: "=", ops: f, opsRaw: rest.trim() };
  }
  // mnemonic, or a label that ends in ':' not in column 0
  let j = i;
  while (j < s.length && !/[\s;]/.test(s[j]) && s[j] !== "=") j++;
  let mnem = s.slice(i, j);
  if (!label && mnem.endsWith(":") && mnem.length > 1) {
    label = mnem.replace(/::?$/, "");
    global = mnem.endsWith("::");
    i = j;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length || s[i] === ";") return { label, global, mnem: null, ops: "", opsRaw: "" };
    j = i;
    while (j < s.length && !/[\s;]/.test(s[j]) && s[j] !== "=") j++;
    mnem = s.slice(i, j);
  }
  if (s[j] === "=" && mnem === "") {
    mnem = "=";
    j++;
  } else if (s[j] === "=" && label === null) {
    // `name=expr` written without a label column (indented): a symbol definition
    label = mnem;
    mnem = "=";
    j++;
  }
  let k = j;
  while (k < s.length && /[ \t]/.test(s[k])) k++;
  const rest = s.slice(k);
  const lower = mnem.toLowerCase();
  let ops;
  if (FREE_TEXT.has(lower)) ops = freeText(rest);
  else ops = operandField(rest, isMacro(mnem.replace(/\..*$/, "")));
  return { label, global, mnem, ops, opsRaw: rest };
}

function readMacroIdent(s, i) {
  // labels built from macro arguments may start with characters readIdent rejects
  const m = /^[A-Za-z0-9_.@$\\]+/.exec(s.slice(i));
  return m ? { name: m[0], end: i + m[0].length } : null;
}

/** The operand field: up to a `;` or whitespace outside quotes; whitespace
 *  right after a comma is skipped. */
function operandField(rest, macroCall) {
  let out = "";
  let q = null, angle = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (q) {
      out += c;
      if (c === q) { if (rest[i + 1] === q) { out += q; i++; } else q = null; }
      continue;
    }
    if (macroCall && c === "<" && (out === "" || out.endsWith(","))) { angle++; out += c; continue; }
    if (macroCall && angle && c === ">") {
      if (rest[i + 1] === ">") { out += ">>"; i++; continue; }
      angle--; out += c; continue;
    }
    if (angle) { out += c; continue; }
    if (c === "'" || c === '"') { q = c; out += c; continue; }
    if (c === ";") break;
    if (c === " " || c === "\t") {
      // whitespace ends the field, except right after a comma
      if (out.endsWith(",")) continue;
      break;
    }
    out += c;
  }
  return out;
}

function freeText(rest) {
  let q = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === ";") return rest.slice(0, i).trim();
  }
  return rest.trim();
}

/** Strip one level of quotes from a file name / message operand. */
function unquote(t) {
  const s = t.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s.startsWith("<") && s.endsWith(">")) return s.slice(1, -1);
  return s;
}

function normPath(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/work\//, "").replace(/\/\.\//g, "/");
}

/**
 * Translate Motorola-syntax source into GNU as source.
 *
 * @param {Object} args
 * @param {string} args.source                     main source text
 * @param {string} [args.mainName]                 name reported for the main file (default "main.s")
 * @param {Record<string,string>} [args.includes]  text files reachable by `include`
 * @param {Record<string,unknown>} [args.binaryIncludes]  files reachable by `incbin` (only names are used)
 * @param {Record<string,number>} [args.defines]   predefined constants (`-D`)
 * @param {string[]} [args.incdirs]                extra include directories
 * @param {Map<string,number>|null} [args.hints]    label addresses from a previous layout pass
 * @returns {{
 *   text: string,
 *   lineMap: Array<{file:string, line:number, where?:string}>,
 *   sections: Array<{name:string, base:number, start:string, end:string}>,
 *   errors: Array<{file:string, line:number, message:string, where?:string}>,
 *   warnings: Array<{file:string, line:number, message:string, where?:string}>,
 *   messages: string[],
 *   labels: Map<string, number>,
 *   hintSensitive: boolean,
 * }}  labels: relocatable symbol → section index; hintSensitive: whether any
 *     encoding choice depended on a label address (another pass may change it)
 */
export function translateMotorola(args) {
  const mainName = args.mainName ?? "main.s";
  const includes = args.includes ?? {};
  const binaryNames = new Set(Object.keys(args.binaryIncludes ?? {}).map(normPath));
  const textNames = new Map(Object.keys(includes).map((k) => [normPath(k), k]));
  const incdirs = [...(args.incdirs ?? [])].map(normPath);

  const errors = [];
  const warnings = [];
  const messages = [];

  /** constants known at this point of the source (equ, set, =, rs, NARG...) */
  const consts = new Map();
  /** names defined so far (labels and symbols), for ifd/ifnd */
  const defined = new Set();
  /** symbol definitions that are redefinable (`set`) */
  const setSyms = new Set();
  /** register aliases (equr / reg) */
  const regAlias = new Map();
  const macros = new Map();
  for (const [k, v] of Object.entries(args.defines ?? {})) {
    consts.set(k, v | 0);
    defined.add(k);
  }

  /** emitted statements */
  const stmts = [];
  /** sections: one per org block; section 0 is the implicit block at 0 */
  const sections = [{ base: 0, used: false }];
  let sec = 0;
  /** label name → section index */
  const labelSec = new Map();
  let scope = "__top";
  let scopeSerial = 0;
  const scopeStack = [];
  let uniq = 0;
  let pcSerial = 0;
  let offsetMode = null; // { value } while inside an `offset` block
  let ended = false;

  const condStack = []; // {active, done, parentActive, gas}
  const isActive = () => condStack.every((c) => c.active);
  const inGasCond = () => condStack.some((c) => c.gas && c.parentActive);

  const where = (src) => (src.where ? { where: src.where } : {});
  const err = (src, message) => errors.push({ file: src.file, line: src.line, message, ...where(src) });
  const warn = (src, message) => warnings.push({ file: src.file, line: src.line, message, ...where(src) });

  const lookup = (name) => consts.get(name);
  const isMacroName = (n) => macros.has(n);

  /** Rename local labels and register aliases inside an expression tree. */
  function localName(name) {
    // a symbol spelled like a register (a label called `d1`) is renamed so GNU as
    // does not read it as the register
    if (isRegister(name)) return `__rd_reg_${name}`;
    if (name.startsWith(".")) return `${scope}$${name.slice(1)}`;
    if (/\$$/.test(name)) return `${scope}$${name}`;
    const bs = name.indexOf("\\");
    if (bs > 0) {
      const g = name.slice(0, bs);
      const l = name.slice(bs + 1);
      return l.startsWith(".") ? `${g}$${l.slice(1)}` : `${g}$${l}`;
    }
    return name;
  }
  function scopeExpr(e) {
    if (e.t === "sym") {
      if (e.name === "NARG" || e.name === "narg") return e;
      return { t: "sym", name: localName(e.name) };
    }
    if (e.t === "un") return { t: "un", op: e.op, a: scopeExpr(e.a) };
    if (e.t === "bin") return { t: "bin", op: e.op, a: scopeExpr(e.a), b: scopeExpr(e.b) };
    return e;
  }

  /** Parse + scope + fold an expression; on failure report and return null. */
  function expr(src, text, { mustFold = false, what = "expression" } = {}) {
    if (text == null || text.trim() === "") {
      err(src, `${what} expected`);
      return null;
    }
    try {
      const t = text.trim();
      const { expr: e, end } = parseExpr(t, 0, { registersAreSymbols: true });
      if (end !== t.length) {
        err(src, `junk at end of ${what}: '${t.slice(end)}'`);
        return null;
      }
      const f = foldExpr(scopeExpr(e), lookup);
      if (mustFold && f.t !== "num") {
        err(src, `${what} must be a constant: '${t}'`);
        return null;
      }
      return f;
    } catch (e) {
      if (e instanceof ExprError) { err(src, `${e.message} in '${text.trim()}'`); return null; }
      throw e;
    }
  }

  function push(src, st) {
    st.file = src.file;
    st.line = src.line;
    if (src.where) st.where = src.where;
    st.sec = sec;
    stmts.push(st);
    if (st.k !== "set" && st.k !== "globl" && st.k !== "gasif" && st.k !== "gaselse" && st.k !== "gasendif" && st.k !== "gaselseif") {
      sections[sec].used = true;
    }
    return st;
  }

  function defineLabel(src, rawName, global, withInsn) {
    const name = localName(rawName);
    if (!rawName.startsWith(".") && !/\$$/.test(rawName) && !rawName.includes("\\")) {
      scope = rawName;
    }
    if (offsetMode) {
      setConst(src, name, offsetMode.value, false);
      return;
    }
    if (labelSec.has(name) || (consts.has(name) && !setSyms.has(name))) {
      if (!inGasCond()) { err(src, `symbol ${displayName(name)} redefined`); return; }
    }
    labelSec.set(name, sec);
    defined.add(name);
    push(src, { k: "label", name, withInsn });
    if (global) push(src, { k: "globl", name });
  }

  function setConst(src, name, value, redefinable) {
    if (!redefinable && (labelSec.has(name) || (consts.has(name) && !setSyms.has(name)))) {
      if (!inGasCond()) { err(src, `symbol ${displayName(name)} redefined`); return; }
    }
    if (redefinable) setSyms.add(name);
    if (inGasCond()) consts.delete(name);
    else consts.set(name, value | 0);
    defined.add(name);
    push(src, { k: "set", name, e: { t: "num", v: value | 0 } });
  }

  function defineSymbol(src, name, text, redefinable) {
    const sym = localName(name);
    const e = expr(src, text, { what: "expression" });
    if (!e) return;
    if (!redefinable && (labelSec.has(sym) || (consts.has(sym) && !setSyms.has(sym)) || symDefs.has(sym))) {
      if (!inGasCond()) { err(src, `symbol ${displayName(sym)} redefined`); return; }
    }
    if (redefinable) setSyms.add(sym);
    defined.add(sym);
    let pcLabel = null;
    if (exprUsesPc(e)) pcLabel = newPcLabel();
    if (e.t === "num" && !inGasCond()) consts.set(sym, e.v);
    else consts.delete(sym);
    if (!redefinable) symDefs.set(sym, e);
    push(src, { k: "set", name: sym, e, pcLabel });
  }
  /** non-redefinable symbol definitions (for the relocatable-equ analysis) */
  const symDefs = new Map();

  function newPcLabel() {
    const name = `__rd_pc${pcSerial++}`;
    labelSec.set(name, sec);
    return name;
  }

  // ── conditional assembly ───────────────────────────────────────────────
  function condition(src, kw, ops) {
    // returns true/false, or an Expr to hand to GNU as
    switch (kw) {
      case "if1": case "ifp1": return true;
      case "if2": return false;
      case "ifd": case "ifdef": return defined.has(localName(ops.trim())) || macros.has(ops.trim());
      case "ifnd": case "ifndef": return !(defined.has(localName(ops.trim())) || macros.has(ops.trim()));
      case "ifmacrod": return macros.has(ops.trim());
      case "ifmacrond": return !macros.has(ops.trim());
      case "ifb": return unquote(ops).trim() === "";
      case "ifnb": return unquote(ops).trim() !== "";
      case "ifc": case "ifnc": {
        const parts = splitOperands(ops);
        const a = unquote(parts[0] ?? ""), b = unquote(parts[1] ?? "");
        return kw === "ifc" ? a === b : a !== b;
      }
    }
    const e = expr(src, ops, { what: "condition" });
    if (!e) return false;
    const test = { if: "ne", ifne: "ne", ifeq: "eq", ifgt: "gt", ifge: "ge", iflt: "lt", ifle: "le", elseif: "ne", elif: "ne" }[kw];
    if (e.t === "num") {
      const v = e.v;
      return { ne: v !== 0, eq: v === 0, gt: v > 0, ge: v >= 0, lt: v < 0, le: v <= 0 }[test];
    }
    const zero = { t: "num", v: 0 };
    const cmp = { ne: "!=", eq: "==", gt: ">", ge: ">=", lt: "<", le: "<=" }[test];
    return { t: "bin", op: cmp, a: e, b: zero };
  }

  function handleCond(src, kw, ops) {
    if (kw === "endif" || kw === "endc") {
      const c = condStack.pop();
      if (!c) { err(src, `${kw} without if`); return; }
      if (c.gas && c.parentActive) push(src, { k: "gasendif" });
      return;
    }
    if (kw === "else" || kw === "elseif" || kw === "elif") {
      const c = condStack[condStack.length - 1];
      if (!c) { err(src, `${kw} without if`); return; }
      if (!c.parentActive) return;
      if (c.gas) {
        if (kw === "else") push(src, { k: "gaselse" });
        else {
          const r = condition(src, kw, ops);
          const e = typeof r === "boolean" ? { t: "num", v: r ? 1 : 0 } : r;
          push(src, { k: "gaselseif", e });
        }
        return;
      }
      if (c.done) { c.active = false; return; }
      if (kw === "else") { c.active = true; c.done = true; return; }
      const r = condition(src, kw, ops);
      if (typeof r !== "boolean") { err(src, "elseif condition must be a constant here"); c.active = false; return; }
      c.active = r;
      c.done = r;
      return;
    }
    // a new if
    const parentActive = isActive();
    if (!parentActive) { condStack.push({ active: false, done: true, parentActive: false, gas: false }); return; }
    const r = condition(src, kw, ops);
    if (typeof r === "boolean") {
      condStack.push({ active: r, done: r, parentActive: true, gas: false });
    } else {
      condStack.push({ active: true, done: false, parentActive: true, gas: true });
      push(src, { k: "gasif", e: r });
    }
  }

  // ── macros ─────────────────────────────────────────────────────────────
  function splitMacroArgs(ops) {
    if (ops.trim() === "") return [];
    const out = [];
    let cur = "", q = null, depth = 0, angle = false;
    for (let i = 0; i < ops.length; i++) {
      const c = ops[i];
      if (angle) {
        if (c === ">" && ops[i + 1] === ">") { cur += ">"; i++; continue; }
        if (c === ">") { angle = false; continue; }
        cur += c;
        continue;
      }
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === "<" && cur.trim() === "") { angle = true; continue; }
      if (c === "'" || c === '"') { q = c; cur += c; continue; }
      if (c === "(") depth++;
      if (c === ")") depth--;
      if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  }

  function substitute(text, m, argv, qual, id) {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c !== "\\") { out += c; continue; }
      const n = text[i + 1];
      if (n === undefined) { out += c; continue; }
      if (/[0-9]/.test(n)) {
        out += n === "0" ? (qual ?? "w") : (argv[+n - 1] ?? "");
        i++;
        continue;
      }
      if (n === "@") {
        out += "_" + String(id).padStart(6, "0");
        i++;
        continue;
      }
      if (n === "#") { out += String(argv.length); i++; continue; }
      if (n === "?" && /[0-9]/.test(text[i + 2] ?? "")) {
        out += String((argv[+text[i + 2] - 1] ?? "").length);
        i += 2;
        continue;
      }
      if (n === "<") {
        const close = text.indexOf(">", i + 2);
        if (close > 0) {
          let sym = text.slice(i + 2, close);
          const hex = sym.startsWith("$");
          if (hex) sym = sym.slice(1);
          const v = consts.get(sym);
          if (v !== undefined) {
            out += hex ? (v >>> 0).toString(16).toUpperCase() : String(v);
            i = close;
            continue;
          }
        }
      }
      if (n === "\\") { out += "\\"; i++; continue; }
      // named parameter \name
      const id2 = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1));
      if (id2 && m.params.includes(id2[0])) {
        out += argv[m.params.indexOf(id2[0])] ?? "";
        i += id2[0].length;
        continue;
      }
      out += c;
    }
    return out;
  }

  function expandMacro(src, name, qual, ops, depth) {
    const m = macros.get(name);
    if (depth > MAX_MACRO_DEPTH) { err(src, `macro ${name} nested deeper than ${MAX_MACRO_DEPTH} levels (recursive macro without an exit?)`); return; }
    const argv = splitMacroArgs(ops);
    const id = uniq++;
    const savedNarg = consts.get("NARG");
    const savedCarg = consts.get("CARG");
    consts.set("NARG", argv.length);
    const callerWhere = `in macro ${name} called from ${src.file}:${src.line}` + (src.where ? `, ${src.where}` : "");
    const lines = m.body.map((b, idx) => ({
      text: substitute(b.text, m, argv, qual, id),
      file: m.file,
      line: m.line + 1 + idx,
      where: callerWhere,
    }));
    const condDepth = condStack.length;
    const r = runLines(lines, depth + 1, { inMacro: true });
    if (r === "mexit") {
      while (condStack.length > condDepth) {
        const c = condStack.pop();
        if (c.gas && c.parentActive) push(src, { k: "gasendif" });
      }
    }
    if (savedNarg === undefined) consts.delete("NARG"); else consts.set("NARG", savedNarg);
    if (savedCarg === undefined) consts.delete("CARG"); else consts.set("CARG", savedCarg);
  }

  // ── include files ──────────────────────────────────────────────────────
  function resolveText(name, fromFile) {
    const n = normPath(name);
    const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/") + 1) : "";
    const cands = [n, dir + n, ...incdirs.map((d) => (d ? d.replace(/\/$/, "") + "/" : "") + n)];
    for (const c of cands) if (textNames.has(c)) return textNames.get(c);
    return null;
  }
  function resolveBinary(name, fromFile) {
    const n = normPath(name);
    const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/") + 1) : "";
    const cands = [n, dir + n, ...incdirs.map((d) => (d ? d.replace(/\/$/, "") + "/" : "") + n)];
    for (const c of cands) if (binaryNames.has(c) || textNames.has(c)) return c;
    return null;
  }

  // ── statement handlers ─────────────────────────────────────────────────
  function dataItems(src, size, ops) {
    const items = [];
    for (const part of splitOperands(ops)) {
      const p = part.trim();
      if (p === "") { err(src, "empty data operand"); continue; }
      if ((p[0] === '"' || p[0] === "'") && size === "b") {
        // A string in dc.b emits its bytes. It may also start an expression
        // ("A"+1), so only take it as a string when it is the whole operand.
        try {
          const str = readString(p, 0);
          if (str.end === p.length) { items.push({ bytes: str.bytes }); continue; }
        } catch { /* fall through to expression */ }
      }
      if (size === "s" || size === "d") {
        if (/^[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?$/.test(p)) { items.push({ float: p }); continue; }
      }
      const e = expr(src, p, { what: "data value" });
      if (e) items.push({ e });
    }
    return items;
  }

  function newSection(src, base) {
    sections.push({ base, used: false });
    sec = sections.length - 1;
    if (src) push(src, { k: "section" });
  }

  function statement(src, lx, depth) {
    const raw = lx.mnem;
    const lower = raw.toLowerCase();
    const dot = lower.indexOf(".");
    const base = dot < 0 ? lower : lower.slice(0, dot);
    const ext = dot < 0 ? null : lower.slice(dot + 1);
    const ops = lx.ops;

    // macro call (names are case-sensitive)
    const rawBase = dot < 0 ? raw : raw.slice(0, dot);
    if (macros.has(rawBase)) {
      if (lx.label) defineLabel(src, lx.label, lx.global, false);
      expandMacro(src, rawBase, ext, ops, depth);
      return;
    }

    // symbol definitions that take the label column
    if (base === "equ" || base === "=" || base === "set" || base === "fequ" || raw === "=") {
      if (!lx.label) { err(src, `${raw} needs a symbol name`); return; }
      if (ext && ext !== "l" && ext !== "w" && ext !== "b") { err(src, `floating point ${raw} is not supported`); return; }
      defineSymbol(src, lx.label, ops, base === "set");
      return;
    }
    if (base === "equr" || base === "reg" || base === "equrl") {
      if (!lx.label) { err(src, `${raw} needs a symbol name`); return; }
      regAlias.set(lx.label, ops.trim());
      regAlias.set(lx.label.toLowerCase(), ops.trim());
      return;
    }
    if (base === "rs" || base === "so" || base === "fo") {
      const counter = base === "rs" ? "__RS" : base === "so" ? "__SO" : "__FO";
      const n = expr(src, ops, { mustFold: true, what: `${raw} count` });
      if (!n) return;
      const sz = SIZE_BYTES[ext ?? "w"] ?? 2;
      let cur = consts.get(counter) ?? 0;
      if (base === "fo") {
        cur = (cur - sz * n.v) | 0;
        if (lx.label) setConst(src, localName(lx.label), cur, false);
        setConst(src, counter, cur, true);
      } else {
        if (lx.label) setConst(src, localName(lx.label), cur, false);
        setConst(src, counter, cur + sz * n.v, true);
      }
      return;
    }
    if (base === "rsreset" || base === "clrso" || base === "clrfo") {
      setConst(src, base === "rsreset" ? "__RS" : base === "clrso" ? "__SO" : "__FO", 0, true);
      if (lx.label) defineLabel(src, lx.label, lx.global, false);
      return;
    }
    if (base === "rsset" || base === "setso" || base === "setfo") {
      const n = expr(src, ops, { mustFold: true, what: `${raw} value` });
      if (n) setConst(src, base === "rsset" ? "__RS" : base === "setso" ? "__SO" : "__FO", n.v, true);
      return;
    }
    if (base === "rseven") {
      const cur = consts.get("__RS") ?? 0;
      setConst(src, "__RS", (cur + 1) & ~1, true);
      return;
    }
    if (base === "cargs") {
      const parts = splitOperands(ops);
      let off = 4;
      if (parts[0]?.startsWith("#")) {
        const n = expr(src, parts.shift().slice(1), { mustFold: true, what: "cargs offset" });
        if (n) off = n.v;
      }
      for (const p of parts) {
        const m = /^([^.]+)(?:\.([bwl]))?$/.exec(p.trim());
        if (!m) { err(src, `bad cargs entry '${p}'`); continue; }
        setConst(src, localName(m[1]), off, false);
        off += m[2] === "l" ? 4 : 2;
      }
      return;
    }
    if (base === "macro") {
      // handled by runLines (needs the following lines)
      return;
    }
    if (base === "ttl" && lx.label) return;

    // a label on any other line
    if (lx.label) {
      const insn = !isDirective(base);
      defineLabel(src, lx.label, lx.global, insn);
    }

    if (offsetMode) {
      // inside `offset`: only space-reserving directives advance the counter
      if (base === "ds" || base === "dx" || base === "rs") {
        const n = expr(src, ops, { mustFold: true, what: "ds count" });
        if (n) offsetMode.value += (SIZE_BYTES[ext ?? "w"] ?? 2) * n.v;
        return;
      }
      if (base === "even") { offsetMode.value = (offsetMode.value + 1) & ~1; return; }
      if (SECTION_DIRECTIVES.has(base) || base === "org") { offsetMode = null; }
      else if (IGNORED.has(base) || base === "xdef" || base === "public") return;
      else { err(src, `'${raw}' is not allowed inside an offset block (only labels and ds)`); return; }
    }

    switch (base) {
      case "org": {
        const e = expr(src, ops, { mustFold: true, what: "org address" });
        if (!e) return;
        newSection(src, e.v >>> 0);
        return;
      }
      case "offset": {
        let start = offsetMode?.value ?? 0;
        if (ops.trim()) {
          const e = expr(src, ops, { mustFold: true, what: "offset start" });
          if (e) start = e.v;
        }
        offsetMode = { value: start };
        return;
      }
      case "dc": case "db": case "dw": case "dl": {
        const size = base === "db" ? "b" : base === "dw" ? "w" : base === "dl" ? "l" : (ext ?? "w");
        if (!SIZE_BYTES[size]) { err(src, `bad size .${size} for ${raw}`); return; }
        if (size === "x" || size === "p") { err(src, `${raw}: extended/packed floating point is not supported`); return; }
        const items = dataItems(src, size, ops);
        const st = push(src, { k: "data", size, items });
        if (items.some((it) => it.e && exprUsesPc(it.e))) st.pcLabel = newPcLabel();
        return;
      }
      case "dcb": case "blk": {
        const size = ext ?? "w";
        if (!SIZE_BYTES[size] || SIZE_BYTES[size] > 8 || size === "s" || size === "d") { err(src, `bad size .${size} for ${raw}`); return; }
        const parts = splitOperands(ops);
        const n = expr(src, parts[0], { what: `${raw} count` });
        const fill = parts[1] !== undefined ? expr(src, parts[1], { what: `${raw} fill` }) : { t: "num", v: 0 };
        if (!n || !fill) return;
        const st = push(src, { k: "fill", size, count: n, fill });
        if (exprUsesPc(n) || exprUsesPc(fill)) st.pcLabel = newPcLabel();
        return;
      }
      case "ds": case "dx": {
        const size = ext ?? "w";
        if (!SIZE_BYTES[size]) { err(src, `bad size .${size} for ${raw}`); return; }
        const n = expr(src, ops, { what: `${raw} count` });
        if (!n) return;
        const st = push(src, { k: "space", size, count: n });
        if (exprUsesPc(n)) st.pcLabel = newPcLabel();
        return;
      }
      case "even": push(src, { k: "align", bytes: 2, fill: 0 }); return;
      case "odd": push(src, { k: "align", bytes: 2, fill: 0 }); push(src, { k: "data", size: "b", items: [{ e: { t: "num", v: 0 } }] }); return;
      case "align": {
        const e = expr(src, ops, { mustFold: true, what: "align bit count" });
        if (e) push(src, { k: "align", bytes: 2 ** Math.max(0, Math.min(16, e.v)), fill: 0 });
        return;
      }
      case "cnop": {
        const parts = splitOperands(ops);
        const off = expr(src, parts[0], { mustFold: true, what: "cnop offset" });
        const al = expr(src, parts[1] ?? "", { mustFold: true, what: "cnop alignment" });
        if (!off || !al) return;
        push(src, { k: "cnop", offset: off.v, align: al.v });
        return;
      }
      case "include": case "incsrc": {
        const name = unquote(ops);
        const key = resolveText(name, src.file);
        if (key == null) {
          err(src, `could not open <${name}> for input (pass it in includes/sources)`);
          return;
        }
        if (depth > MAX_INCLUDE_DEPTH) { err(src, `include nested deeper than ${MAX_INCLUDE_DEPTH} levels`); return; }
        const text = includes[key];
        const lines = String(text).split("\n").map((t, i) => ({ text: t, file: key, line: i + 1, ...(src.where ? { where: src.where } : {}) }));
        runLines(lines, depth + 1, {});
        return;
      }
      case "incdir": {
        incdirs.push(normPath(unquote(ops)));
        return;
      }
      case "incbin": {
        const parts = splitOperands(ops);
        const name = unquote(parts[0] ?? "");
        const key = resolveBinary(name, src.file);
        if (key == null) {
          err(src, `could not open <${name}> for input (pass it in binaryIncludes)`);
          return;
        }
        const off = parts[1] !== undefined ? expr(src, parts[1], { mustFold: true, what: "incbin offset" }) : null;
        const len = parts[2] !== undefined ? expr(src, parts[2], { mustFold: true, what: "incbin length" }) : null;
        push(src, { k: "incbin", path: key, off: off?.v, len: len?.v });
        return;
      }
      case "xdef": case "public": case "globl": case "global": {
        for (const p of splitOperands(ops)) if (p.trim()) push(src, { k: "globl", name: localName(p.trim()) });
        return;
      }
      case "weak": {
        for (const p of splitOperands(ops)) if (p.trim()) push(src, { k: "weak", name: localName(p.trim()) });
        return;
      }
      case "end": ended = true; return;
      case "fail": case "error": err(src, unquote(ops) || "fail directive"); return;
      case "warning": warn(src, unquote(ops)); return;
      case "echo": case "printt": case "print": {
        for (const p of splitOperands(ops)) messages.push(unquote(p));
        return;
      }
      case "assert": {
        const parts = splitOperands(ops);
        const e = expr(src, parts[0], { what: "assert condition" });
        if (!e) return;
        const msg = parts[1] ? unquote(parts[1]) : `assertion failed: ${parts[0]}`;
        if (e.t === "num") { if (e.v === 0) err(src, msg); return; }
        push(src, { k: "assert", e, msg });
        return;
      }
      case "inline": scopeStack.push(scope); scope = `__inline${++scopeSerial}`; return;
      case "einline":
        if (!scopeStack.length) { err(src, "einline without inline"); return; }
        scope = scopeStack.pop();
        return;
      case "local": scope = `__local${++scopeSerial}`; return;
      case "rorg": err(src, "rorg is not supported; use org"); return;
      case "comm": case "lcomm": err(src, `${raw} is not supported in a flat ROM build; use ds in your RAM block or equ addresses`); return;
      case "mexit": case "endm": case "endr": case "rept": case "rem": case "erem": case "iif":
        return; // handled by runLines
    }
    if (SECTION_DIRECTIVES.has(base)) return; // one flat image: section names have no effect
    if (IGNORED.has(base)) return;
    if (base === "dr") { err(src, "dr.* (relative data) is not supported"); return; }
    if (lx.bad) { err(src, `cannot parse line '${src.text.trim()}'`); return; }

    // an instruction
    instruction(src, base, ext, raw, ops);
  }

  function isDirective(base) {
    return base === "dc" || base === "db" || base === "dw" || base === "dl" || base === "dcb" ||
      base === "blk" || base === "ds" || base === "dx" || base === "even" || base === "odd" ||
      base === "align" || base === "cnop" || base === "incbin" || base === "org" || base === "include" ||
      base === "offset" || IGNORED.has(base) || SECTION_DIRECTIVES.has(base) || COND_DIRECTIVES.has(base) ||
      base === "xdef" || base === "public" || base === "end" || base === "rept" || base === "endr" ||
      base === "macro" || base === "endm" || base === "rem" || base === "inline" || base === "einline" ||
      base === "local" || base === "fail" || base === "assert" || base === "echo" || base === "printt";
  }

  function aliasRegs(text) {
    if (regAlias.size === 0) return text;
    return text.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (w) => regAlias.get(w) ?? w);
  }

  function instruction(src, base, ext, raw, opsText) {
    let opTexts = opsText.trim() === "" ? [] : splitOperands(aliasRegs(opsText));
    let mnem = base;
    let size = ext;
    // `lsl d0` (shift a data register by one)
    if (SHIFT_OPS.has(base) && opTexts.length === 1 && /^[dD][0-7]$/.test(opTexts[0].trim())) {
      opTexts = ["#1", opTexts[0]];
    }
    // exg has no size in GNU as
    if (base === "exg" && size === "l") size = null;
    const ops = opTexts.map((t) => {
      const op = parseOperand(t);
      return mapOperand(op, (e) => {
        try {
          return foldExpr(scopeExpr(e), lookup);
        } catch (x) {
          if (x instanceof ExprError) { err(src, x.message); return e; }
          throw x;
        }
      });
    });
    for (const op of ops) {
      if (op.k === "raw") {
        // scope local labels in the raw text too
        op.text = op.text.replace(/(^|[^A-Za-z0-9_$%)\]])(\.[A-Za-z_][A-Za-z0-9_]*|[0-9]+\$)/g, (m0, pre, l) => pre + localName(l));
      }
    }
    const st = push(src, { k: "insn", mnem, size, ops });
    if (ops.some((op) => operandExprs(op).some(exprUsesPc))) st.pcLabel = newPcLabel();
  }

  // ── the line loop ──────────────────────────────────────────────────────
  /**
   * @param {SrcLine[]} lines
   * @param {number} depth
   * @param {{inMacro?:boolean}} ctx
   * @returns {"mexit"|undefined}
   */
  function runLines(lines, depth, ctx) {
    for (let i = 0; i < lines.length; i++) {
      if (ended) return;
      const src = lines[i];
      const lx = lexLine(src.text, isMacroName);
      if (!lx) continue;
      const lowerM = (lx.mnem ?? "").toLowerCase();
      const baseM = lowerM.replace(/\..*$/, "");

      // rem ... erem block comment
      if (baseM === "rem" && isActive()) {
        while (i < lines.length && lexLine(lines[i].text)?.mnem?.toLowerCase() !== "erem") i++;
        continue;
      }

      // conditional assembly is tracked even in skipped regions
      if (COND_DIRECTIVES.has(baseM)) {
        if (lx.label && isActive()) defineLabel(src, lx.label, lx.global, false);
        handleCond(src, baseM, lx.ops);
        continue;
      }
      if (baseM === "iif") {
        if (!isActive()) continue;
        if (lx.label) defineLabel(src, lx.label, lx.global, false);
        // iif <expr> <statement>
        const opsRaw = lx.opsRaw;
        let j = 0;
        let q = null, depthP = 0;
        for (; j < opsRaw.length; j++) {
          const c = opsRaw[j];
          if (q) { if (c === q) q = null; continue; }
          if (c === "'" || c === '"') { q = c; continue; }
          if (c === "(") depthP++;
          if (c === ")") depthP--;
          if (/\s/.test(c) && depthP === 0) break;
        }
        const condText = opsRaw.slice(0, j);
        const stmtText = opsRaw.slice(j);
        const r = condition(src, "ifne", condText);
        if (typeof r === "boolean") {
          if (r) runLines([{ ...src, text: "\t" + stmtText.trim() }], depth, ctx);
        } else {
          condStack.push({ active: true, done: false, parentActive: true, gas: true });
          push(src, { k: "gasif", e: r });
          runLines([{ ...src, text: "\t" + stmtText.trim() }], depth, ctx);
          condStack.pop();
          push(src, { k: "gasendif" });
        }
        continue;
      }

      // macro definitions: `name macro` or `macro name`
      if (baseM === "macro") {
        let name = lx.label;
        let params = [];
        if (!name) {
          const parts = splitOperands(lx.ops);
          name = (parts.shift() ?? "").trim();
          params = parts.map((p) => p.trim()).filter(Boolean);
        } else if (lx.ops.trim()) {
          params = splitOperands(lx.ops).map((p) => p.trim()).filter(Boolean);
        }
        const body = [];
        let nest = 0;
        let j = i + 1;
        for (; j < lines.length; j++) {
          const l2 = lexLine(lines[j].text);
          const m2 = (l2?.mnem ?? "").toLowerCase();
          if (m2 === "macro") nest++;
          if (m2 === "endm") { if (nest === 0) break; nest--; }
          body.push(lines[j]);
        }
        if (j >= lines.length) err(src, `macro ${name} has no endm`);
        if (isActive()) {
          if (!name) err(src, "macro needs a name");
          else macros.set(name, { body, params, file: src.file, line: src.line, where: src.where });
        }
        i = j;
        continue;
      }

      if (!isActive()) continue;

      if (baseM === "mexit") {
        if (!ctx.inMacro) { err(src, "mexit outside a macro"); continue; }
        if (inGasCond()) err(src, "mexit inside an address-dependent condition is not supported");
        return "mexit";
      }
      if (baseM === "endm") { err(src, "endm without macro"); continue; }
      if (baseM === "endr") { err(src, "endr without rept"); continue; }

      if (baseM === "rept") {
        const parts = splitOperands(lx.ops);
        const body = [];
        let nest = 0;
        let j = i + 1;
        for (; j < lines.length; j++) {
          const l2 = lexLine(lines[j].text, isMacroName);
          const m2 = (l2?.mnem ?? "").toLowerCase();
          if (m2 === "rept") nest++;
          if (m2 === "endr") { if (nest === 0) break; nest--; }
          body.push(lines[j]);
        }
        if (j >= lines.length) err(src, "rept has no endr");
        i = j;
        if (lx.label) defineLabel(src, lx.label, lx.global, false);
        const n = expr(src, parts[0], { mustFold: true, what: "rept count" });
        if (!n) continue;
        const count = Math.max(0, n.v);
        if (count * Math.max(1, body.length) > MAX_REPT_LINES) { err(src, `rept expands to more than ${MAX_REPT_LINES} lines`); continue; }
        const counterSym = parts[1]?.trim();
        const savedN = consts.get("REPTN");
        for (let r = 0; r < count; r++) {
          consts.set("REPTN", r);
          if (counterSym) { consts.set(counterSym, r); setSyms.add(counterSym); defined.add(counterSym); }
          const res = runLines(body, depth, ctx);
          if (res === "mexit") { if (savedN === undefined) consts.delete("REPTN"); else consts.set("REPTN", savedN); return res; }
          if (ended) break;
        }
        if (savedN === undefined) consts.set("REPTN", -1); else consts.set("REPTN", savedN);
        continue;
      }

      if (lx.mnem === null) {
        if (lx.label) defineLabel(src, lx.label, lx.global, false);
        continue;
      }
      statement(src, lx, depth);
      if (ended) return;
    }
    return undefined;
  }

  consts.set("REPTN", -1);
  const mainLines = String(args.source).split("\n").map((t, i) => ({ text: t, file: mainName, line: i + 1 }));
  runLines(mainLines, 0, {});
  if (condStack.length) {
    const last = mainLines.length;
    errors.push({ file: mainName, line: last, message: `${condStack.length} conditional block(s) not closed (missing endif/endc)` });
  }

  const out = emit({ stmts, sections, labelSec, symDefs, setSyms, hints: args.hints ?? null, frozen: args.frozen ?? null, allNames: defined });
  return { ...out, errors: [...errors, ...out.emitErrors], warnings: [...warnings, ...out.emitWarnings], messages };
}

function displayName(name) {
  const d = name.indexOf("$");
  if (d > 0 && !name.endsWith("$")) return "." + name.slice(d + 1);
  if (d > 0) return name.slice(d + 1);
  return name;
}

// ────────────────────────────────────────────────────────────────────────────
// Emit
// ────────────────────────────────────────────────────────────────────────────

const BUILTIN_SYMS = new Set(["NARG", "REPTN", "CARG", "__RS", "__SO", "__FO"]);

function emit({ stmts, sections, labelSec, symDefs, setSyms, hints, frozen, allNames }) {
  // Which symbols are relocatable (label-like): labels, plus non-redefinable
  // symbols defined as `label ± constant`. Everything else is absolute.
  const reloc = new Map(labelSec); // name → section
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, e] of symDefs) {
      if (reloc.has(name) || setSyms.has(name)) continue;
      const lin = linearReloc(e, (n) => reloc.has(n) || n === "*");
      if (!lin || lin.size !== 1) continue;
      const [[sym, k]] = [...lin];
      if (k !== 1 || sym === "*") continue;
      reloc.set(name, reloc.get(sym));
      changed = true;
    }
  }
  const isReloc = (n) => reloc.has(n);

  // Label addresses from the previous layout pass (null on the first pass).
  // They only steer encoding choices; `hintSensitive` records whether any
  // choice depended on a label's address, so the caller knows whether another
  // pass can change the output.
  let hintSensitive = false;
  /** synthetic labels standing for constant branch targets → their address */
  const atConst = new Map();
  const emitWarnings = [];
  const pcAsSym = (e, st) => {
    if (e.t === "pc") return st.pcLabel ? { t: "sym", name: st.pcLabel } : e;
    if (e.t === "un") return { ...e, a: pcAsSym(e.a, st) };
    if (e.t === "bin") return { ...e, a: pcAsSym(e.a, st), b: pcAsSym(e.b, st) };
    return e;
  };
  const insnCtx = {
    hasHints: !!hints,
    frozenStmt: (st) => !!frozen?.has(st.idx),
    labelSection: (e) => {
      const lin = linearReloc(e, (n) => isReloc(n));
      return lin && lin.size === 1 ? reloc.get([...lin.keys()][0]) : undefined;
    },
    /** displacement of a branch at st.brLabel to e, from the previous layout */
    branchDisp: (e, st) => {
      hintSensitive = true;
      if (!hints || frozen?.has(st.idx) || !st.brLabel || !hints.has(st.brLabel)) return undefined;
      const t = evalExpr(e, (n) => (hints.has(n) ? hints.get(n) | 0 : undefined));
      return t === undefined ? undefined : t - ((hints.get(st.brLabel) | 0) + 2);
    },
    exprText: (e, st) => exprText(e, st),
    // A constant PC-relative displacement names the target ADDRESS in
    // Motorola syntax (GNU as would take it as the raw displacement), so it is
    // written relative to the section start for GNU as to compute.
    pcTarget: (e, st) => `(${startSym(st.sec)}+(${printExpr(e)}-${numText(sections[st.sec].base)}))`,
    isRelocExpr: (e) => hasReloc(e, isReloc),
    simpleLabel: (e) => {
      const lin = linearReloc(e, (n) => isReloc(n) || n === "*");
      return !!(lin && lin.size === 1 && [...lin.values()][0] === 1 && !lin.has("*"));
    },
    val: (e, st) => {
      if (e.t === "num") return e.v;
      if (!hasReloc(e, isReloc)) return undefined;
      if (e.t === "sym" && atConst.has(e.name)) return atConst.get(e.name);
      hintSensitive = true;
      if (!hints || frozen?.has(st.idx)) return undefined;
      return evalExpr(pcAsSym(e, st), (n) => (atConst.has(n) ? atConst.get(n) : hints.has(n) ? hints.get(n) | 0 : undefined));
    },
  };

  // Section bookkeeping: keep only sections that hold something.
  const secName = (i) => `.rd${i}`;
  const startSym = (i) => `__rd_s${i}`;
  const endSym = (i) => `__rd_e${i}`;
  const usedSecs = sections.map((s, i) => ({ ...s, i })).filter((s) => s.used);

  const lines = [];
  const lineMap = [];
  /** emitted text per statement index, so layout passes can compare them */
  const stmtText = [];
  let curIdx = -1;
  const out = (text, st) => {
    if (curIdx >= 0) stmtText[curIdx] = (stmtText[curIdx] ?? "") + text + "\n";
    lines.push(text);
    lineMap.push(st ? { file: st.file, line: st.line, ...(st.where ? { where: st.where } : {}) } : { file: "", line: 0 });
  };

  /** Absolute form of a relocatable symbol: base + (sym - section start). */
  const absSym = (name) => {
    const s = reloc.get(name);
    const base = sections[s]?.base ?? 0;
    return `(${numText(base)}+(${name}-${startSym(s)}))`;
  };

  /** Print an expression: simple label±constant stays relocatable, anything
   *  else that mentions a label is rewritten into absolute form. */
  const undefinedSeen = new Set();
  const emitErrors = [];
  const exprText = (e, st, { allowReloc = true } = {}) => {
    for (const n of exprSymbols(e)) {
      if (allNames.has(n) || n.startsWith("__rd_") || BUILTIN_SYMS.has(n)) continue;
      const key = `${n}@${st.file}:${st.line}`;
      if (undefinedSeen.has(key)) continue;
      undefinedSeen.add(key);
      emitErrors.push({ file: st.file, line: st.line, message: `undefined symbol ${displayName(n)}`, ...(st.where ? { where: st.where } : {}) });
    }
    const pcText = st.pcLabel ?? ".";
    const isR = (n) => isReloc(n);
    if (!hasReloc(e, isR)) return printExpr(e, { pcText });
    if (allowReloc) {
      const lin = linearReloc(e, (n) => isR(n) || n === "*");
      if (lin && lin.size === 1 && [...lin.values()][0] === 1) return printExpr(e, { pcText });
    }
    return printExpr(e, {
      symText: (n) => (isR(n) ? absSym(n) : n),
      pcText: st.pcLabel ? absSym(st.pcLabel) : ".",
    });
  };

  // An unsized bra/bcc whose target label directly follows is dropped: it
  // cannot be encoded as a short branch and does nothing (Motorola-syntax
  // assemblers remove it the same way).
  const branchToNext = (idx, sized = false) => {
    const st = stmts[idx];
    if (sized ? !(st.size === "s" || st.size === "b") : st.size) return false;
    if (st.mnem === "jmp" && !sized && st.ops.length === 1 && st.ops[0].k === "abs") {
      // jmp becomes bra (and so disappears) unless the target is in the first
      // 32KB, where it stays an absolute short jump
      const v = insnCtx.val(st.ops[0].e, st);
      if (v === undefined || (v >= 0 && v <= 0x7fff)) return false;
    } else if (!RELAX_BRANCH[st.mnem] || st.mnem === "bsr" || st.ops.length !== 1) return false;
    const op = st.ops[0];
    if (op.k !== "abs" || op.size || op.e.t !== "sym" || !isReloc(op.e.name)) return false;
    for (let j = idx + 1; j < stmts.length; j++) {
      const n = stmts[j];
      if (n.k === "set" || n.k === "globl" || n.k === "weak") continue;
      if (n.k !== "label" || n.sec !== st.sec) return false;
      if (n.name === op.e.name) return true;
    }
    return false;
  };

  let curSec = -1;
  const parity = new Map(); // section → maybe-odd flag
  const enter = (i, st) => {
    if (curSec === i) return;
    curSec = i;
    out(`\t.section\t${secName(i)},"ax"`, st);
    if (!parity.has(i)) {
      out(`${startSym(i)}:`, st);
      parity.set(i, (sections[i].base & 1) === 1);
    }
  };

  // pending labels on an instruction line are emitted after the auto-align
  for (let idx = 0; idx < stmts.length; idx++) {
    const st = stmts[idx];
    curIdx = idx;
    st.idx = idx;
    if (st.k === "section") continue;
    if (st.k === "set") {
      const text = st.pcLabel ? exprText(st.e, st, { allowReloc: true }) : exprText(st.e, st, { allowReloc: !setSyms.has(st.name) });
      if (st.pcLabel) { enter(st.sec, st); out(`${st.pcLabel}:`, st); }
      out(`\t.set\t${st.name}, ${text}`, st);
      continue;
    }
    if (st.k === "globl") { out(`\t.globl\t${st.name}`, st); continue; }
    if (st.k === "weak") { out(`\t.weak\t${st.name}`, st); continue; }
    if (st.k === "gasif") { out(`\t.if\t${exprText(st.e, st, { allowReloc: false })}`, st); continue; }
    if (st.k === "gaselseif") { out(`\t.elseif\t${exprText(st.e, st, { allowReloc: false })}`, st); continue; }
    if (st.k === "gaselse") { out(`\t.else`, st); continue; }
    if (st.k === "gasendif") { out(`\t.endif`, st); continue; }
    if (st.k === "assert") {
      out(`\t.if\t(${exprText(st.e, st, { allowReloc: false })})==0`, st);
      out(`\t.error\t${JSON.stringify(st.msg)}`, st);
      out(`\t.endif`, st);
      continue;
    }

    enter(st.sec, st);
    const odd = parity.get(st.sec);
    switch (st.k) {
      case "label": {
        if (st.withInsn && odd) {
          out(`\t.balign\t2,0`, st);
          parity.set(st.sec, false);
        }
        out(`${st.name}:`, st);
        break;
      }
      case "insn": {
        if (branchToNext(idx)) break;
        if (branchToNext(idx, true)) {
          // a short branch cannot reach the next instruction; it does nothing,
          // so it becomes a two-byte no-op (keeping the layout). `lea (a6),a6`
          // is the encoding the classic assemblers use here.
          if (odd) { out(`\t.balign\t2,0`, st); parity.set(st.sec, false); }
          out("\tlea\t(a6),a6", st);
          emitWarnings.push({ file: st.file, line: st.line, message: "short branch to the following instruction turned into a nop", ...(st.where ? { where: st.where } : {}) });
          break;
        }
        if (odd) { out(`\t.balign\t2,0`, st); parity.set(st.sec, false); }
        if (st.pcLabel) out(`${st.pcLabel}:`, st);
        // A branch or call to a constant address: GNU as would take the number
        // as a raw displacement, so name the address relative to this block.
        if ((BRANCH_RE.test(st.mnem) || st.mnem === "jsr" || st.mnem === "jmp") && st.ops.length >= 1) {
          const ti = st.ops.length - 1;
          const op = st.ops[ti];
          if (op.k === "abs" && op.e.t === "num") {
            const name = `__rd_at${idx}`;
            out(`\t.set\t${name}, (${startSym(st.sec)}+(${numText(op.e.v)}-${numText(sections[st.sec].base)}))`, st);
            reloc.set(name, st.sec);
            atConst.set(name, op.e.v);
            st.ops = st.ops.map((o, i) => (i === ti ? { ...o, e: { t: "sym", name } } : o));
          }
        }
        // a branch or call into another org block needs its own address to
        // pick a displacement size
        const crossBranch = (RELAX_BRANCH[st.mnem] || st.mnem === "jsr" || st.mnem === "jmp") && !st.size && st.ops.length === 1;
        const crossSrc = PCREL_SRC.test(st.mnem) && (st.ops.length === 2 || st.mnem === "pea");
        const farCall = (st.mnem === "bra" || st.mnem === "bsr") && !st.size && st.ops.length === 1;
        if ((crossBranch || crossSrc || farCall) &&
            st.ops[0].k === "abs" && !st.ops[0].size && insnCtx.simpleLabel(st.ops[0].e) &&
            (farCall || insnCtx.labelSection(st.ops[0].e) !== st.sec)) {
          st.brLabel = `__rd_b${idx}`;
          reloc.set(st.brLabel, st.sec);
          out(`${st.brLabel}:`, st);
        }
        for (const l of insnLines(st, insnCtx)) out("\t" + l, st);
        parity.set(st.sec, false);
        break;
      }
      case "data": {
        // `*` inside a data list is the address of that item, so an item
        // using it gets its own label
        const dir = { b: ".byte", w: ".word", l: ".long", q: ".quad", s: ".single", d: ".double" }[st.size];
        let vals = [];
        const flush = () => {
          for (let k = 0; k < vals.length; k += 32) out(`\t${dir}\t${vals.slice(k, k + 32).join(",")}`, st);
          vals = [];
        };
        let count = 0;
        st.items.forEach((it, k) => {
          if (it.bytes) { for (const b of it.bytes) vals.push(String(b)); count += it.bytes.length; return; }
          if (it.float) { vals.push(it.float); count++; return; }
          if (it.e.t === "num") {
            const range = { b: [-128, 255], w: [-32768, 65535] }[st.size];
            if (range && (it.e.v < range[0] || it.e.v > range[1])) {
              out(`\t.error\t"data out of range: ${it.e.v} does not fit dc.${st.size}"`, st);
            }
            vals.push(numText(st.size === "b" ? it.e.v & 0xff : st.size === "w" ? it.e.v & 0xffff : it.e.v));
          } else if (exprUsesPc(it.e)) {
            flush();
            const lab = `${st.pcLabel}_${k}`;
            reloc.set(lab, st.sec);
            out(`${lab}:`, st);
            vals.push(exprText(it.e, { ...st, pcLabel: lab }));
          } else vals.push(exprText(it.e, st));
          count++;
        });
        flush();
        if (st.size === "b" && (count & 1)) parity.set(st.sec, true);
        break;
      }
      case "fill": {
        if (st.pcLabel) out(`${st.pcLabel}:`, st);
        const sz = SIZE_BYTES[st.size];
        const dir = { b: ".byte", w: ".word", l: ".long", q: ".quad" }[st.size];
        if (st.fill.t !== "num") {
          // .fill needs a constant value; repeat the data directive instead
          // (a vector table filled with a handler address, say)
          if (st.count.t !== "num") { out(`\t.error\t"dcb with a label fill value needs a constant count"`, st); break; }
          out(`\t.rept\t${Math.max(0, st.count.v)}`, st);
          // the fill value is truncated to the element size, as dcb always has
          const fillText = sz < 4 ? `(${exprText(st.fill, st, { allowReloc: false })})&${sz === 1 ? "0xff" : "0xffff"}` : exprText(st.fill, st);
          out(`\t${dir}\t${fillText}`, st);
          out(`\t.endr`, st);
        } else if (st.count.t !== "num") {
          const v = st.fill.v & (sz === 1 ? 0xff : sz === 2 ? 0xffff : 0xffffffff);
          const same = sz === 1 || [...Array(sz)].every((_, k) => ((v >>> (8 * k)) & 0xff) === (v & 0xff));
          if (!same) { out(`\t.error\t"dcb with a computed count needs a fill value made of one repeated byte"`, st); break; }
          out(`\t.space\t(${exprText(st.count, st, { allowReloc: false })})*${sz},${v & 0xff}`, st);
        } else {
          out(`\t.fill\t${Math.max(0, st.count.v)},${sz},${numText(st.fill.v)}`, st);
        }
        if (sz & 1 && !(st.count.t === "num" && (st.count.v & 1) === 0)) parity.set(st.sec, true);
        break;
      }
      case "space": {
        if (st.pcLabel) out(`${st.pcLabel}:`, st);
        const sz = SIZE_BYTES[st.size];
        const n = exprText(st.count, st, { allowReloc: false });
        out(`\t.space\t${sz === 1 ? n : `(${n})*${sz}`}`, st);
        if (sz & 1 && !(st.count.t === "num" && (st.count.v & 1) === 0)) parity.set(st.sec, true);
        break;
      }
      case "align": {
        out(`\t.balign\t${st.bytes},${st.fill}`, st);
        if (st.bytes >= 2) parity.set(st.sec, false);
        break;
      }
      case "cnop": {
        if (st.align >= 2) out(`\t.balign\t2,0`, st);
        if (st.align > 2) out(`\t.balignw\t${st.align},0x4e71`, st);
        if (st.offset > 0) {
          if (st.offset & 1) out(`\t.fill\t${st.offset},1,0`, st);
          else out(`\t.fill\t${st.offset / 2},2,0x4e71`, st);
        }
        parity.set(st.sec, (st.offset & 1) === 1 || st.align < 2 ? true : false);
        break;
      }
      case "incbin": {
        let t = `\t.incbin\t"/work/${st.path}"`;
        if (st.off !== undefined) t += `,${st.off}`;
        if (st.len !== undefined) t += `,${st.len}`;
        out(t, st);
        parity.set(st.sec, true);
        break;
      }
    }
  }
  // end markers (global, so the link map reports where each block ends)
  for (const s of usedSecs) {
    out(`\t.section\t${secName(s.i)},"ax"`, null);
    if (!parity.has(s.i)) out(`${startSym(s.i)}:`, null);
    out(`\t.globl\t${endSym(s.i)}`, null);
    out(`${endSym(s.i)}:`, null);
  }
  return {
    text: lines.join("\n") + "\n",
    lineMap,
    sections: usedSecs.map((s) => ({ name: secName(s.i), base: s.base, start: startSym(s.i), end: endSym(s.i) })),
    labels: reloc,
    hintSensitive,
    stmtText,
    emitWarnings,
    emitErrors,
  };
}

// jsr/jmp to a plain label become GNU as's relaxing jbsr/jra, which pick
// bsr/bra when the target is in reach (the Motorola-syntax assemblers this
// source style comes from do the same). Explicitly sized or PC-relative forms
// are left alone.
const RELAX_BRANCH = {
  bra: "jra", bsr: "jbsr", bhi: "jhi", bls: "jls", bcc: "jcc", bhs: "jcc", bcs: "jcs", blo: "jcs",
  bne: "jne", beq: "jeq", bvc: "jvc", bvs: "jvs", bpl: "jpl", bmi: "jmi", bge: "jge", blt: "jlt",
  bgt: "jgt", ble: "jle",
};

// Instructions whose first operand is a source that may be PC-relative on the 68000.
const PCREL_SRC = /^(?:move|movea|add|adda|sub|suba|and|or|cmp|cmpa|muls|mulu|divs|divu|chk|lea|pea|movem)$/;

const BRANCH_RE = /^(?:b(?:ra|sr|hi|ls|cc|hs|cs|lo|ne|eq|vc|vs|pl|mi|ge|lt|gt|le|t|f)|db(?:ra|t|f|hi|ls|cc|hs|cs|lo|ne|eq|vc|vs|pl|mi|ge|lt|gt|le)|j(?:ra|bsr|hi|ls|cc|cs|ne|eq|vc|vs|pl|mi|ge|lt|gt|le))$/;

/**
 * Print one instruction (possibly as several lines, or none).
 * @param {object} st
 * @param {object} c  {exprText, isReloc, val(e), simpleLabel(e)}
 * @returns {string[]}
 */
function insnLines(st, c) {
  let mnem = st.mnem;
  const ops = st.ops;
  const ex = (e) => c.exprText(e, st);
  const val = (e) => c.val(e, st);
  const isBranch = BRANCH_RE.test(mnem) || mnem === "jsr" || mnem === "jmp";

  /** Print operand `op` (the same object as in st.ops, or a register). */
  const opText = (op) => {
    // a constant PC-relative displacement names a target address
    if (op.k === "disp" && op.e && /^pc$/i.test(op.base) && !c.isRelocExpr(op.e)) {
      return printOperand({ ...op, e: { t: "sym", name: c.pcTarget(op.e, st) } }, (e) => (e.t === "sym" ? e.name : ex(e)));
    }
    if (op.k === "abs" && !op.size && !isBranch && c.isRelocExpr(op.e)) {
      // a label in the first 32KB takes the short absolute form
      const v = val(op.e);
      if (v !== undefined && v >= -32768 && v <= 32767) return `(${ex(op.e)}).w`;
      if (op === ops[0] && st.brLabel) {
        // a source operand in another org block: PC-relative when it reaches
        // (GNU as only does this by itself within one section)
        const d = c.branchDisp(op.e, st);
        if (d !== undefined && d >= -32768 && d <= 32767) return `(${ex(op.e)},pc)`;
      }
    }
    return printOperand(op, ex);
  };

  const rep = peephole(st, {
    val,
    // with a previous layout's addresses in hand a label's value counts as
    // known (the convergence check in m68k-asm.js keeps this honest)
    isConst: (e) => e.t === "num" || (c.hasHints && !c.frozenStmt(st) && val(e) !== undefined),
    op: opText,
    ex,
  });
  if (rep) return rep;

  // immediate range check (byte: -128..255, word: -32768..65535)
  if (ops[0]?.k === "imm" && ops[0].e.t === "num" && (st.size === "b" || st.size === "w")) {
    const v = ops[0].e.v;
    const ok = st.size === "b" ? v >= -128 && v <= 255 : v >= -32768 && v <= 65535;
    if (!ok && !/^(?:moveq|addq|subq|trap|stop|link|bkpt)$/.test(mnem)) return [`.error\t"immediate operand out of range for .${st.size}"`];
  }

  // Byte-sized immediates are encoded in the low byte of the extension word
  // with the high byte clear.
  const byteImm = st.size === "b" || (ops.length === 2 && ops[1].k === "reg" && /^ccr$/i.test(ops[1].text));
  const printOps = ops.map((op, i) => {
    if (i === 0 && op.k === "imm" && byteImm && op.e.t === "num") return "#" + numText(op.e.v & 0xff);
    return null;
  });

  const simpleTarget = !st.size && ops.length === 1 && ops[0].k === "abs" && !ops[0].size && c.simpleLabel(ops[0].e);
  const cross = simpleTarget && c.labelSection(ops[0].e) !== st.sec;
  if ((mnem === "bra" || mnem === "bsr") && simpleTarget && st.brLabel) {
    // A bra/bsr that cannot reach a target in the first 32KB becomes jmp/jsr
    // with a short absolute address (GNU as would pick an absolute long).
    const v = val(ops[0].e);
    const d = c.branchDisp(ops[0].e, st);
    if (v !== undefined && v >= 0 && v <= 0x7fff && d !== undefined && (d < -32768 || d > 32767)) {
      return [`${mnem === "bra" ? "jmp" : "jsr"}\t(${ex(ops[0].e)}).w`];
    }
  }
  if (st.brLabel && cross && (RELAX_BRANCH[mnem] || mnem === "jsr" || mnem === "jmp")) {
    // into another org block: GNU as cannot relax across sections, so the size
    // comes from the previous layout (a word branch until one exists)
    const v = mnem === "jsr" || mnem === "jmp" ? val(ops[0].e) : undefined;
    const d = c.branchDisp(ops[0].e, st);
    const base = mnem === "jsr" ? "bsr" : mnem === "jmp" ? "bra" : mnem;
    if (v !== undefined && v >= 0 && v <= 0x7fff) printOps[0] = `(${ex(ops[0].e)}).w`;
    else if (d !== undefined && d !== 0 && d >= -128 && d <= 127) mnem = base + ".s";
    else if (d === undefined || (d >= -32768 && d <= 32767)) mnem = base + ".w";
    else mnem = RELAX_BRANCH[base] ?? mnem;
  } else if (RELAX_BRANCH[mnem] && simpleTarget) {
    // An unsized branch to a label picks the shortest form that reaches (GNU
    // as only relaxes its j* spellings; a plain `bra` is always a word branch).
    mnem = RELAX_BRANCH[mnem];
  } else if ((mnem === "jsr" || mnem === "jmp") && simpleTarget) {
    // A target in the first 32KB is reached with an absolute short address;
    // anything else becomes bsr/bra when in range (jbsr/jra relax that way).
    const v = val(ops[0].e);
    if (v !== undefined && v >= 0 && v <= 0x7fff) printOps[0] = `(${ex(ops[0].e)}).w`;
    else mnem = mnem === "jsr" ? "jbsr" : "jra";
  }
  const m = st.size ? `${mnem}.${st.size}` : mnem;
  const text = ops.map((op, i) => printOps[i] ?? opText(op)).join(",");
  return [text ? `${m}\t${text}` : m];
}
