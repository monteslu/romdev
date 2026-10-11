// 68k operand parsing for the Motorola-syntax front end (m68k-asm).
//
// An instruction operand is split into the parts GNU as needs to see in a
// fixed shape - registers, size suffixes, and the expressions inside. Only the
// expressions are rewritten (folded, renamed, made absolute where needed); the
// addressing-mode skeleton is printed back in the Motorola form GNU as accepts
// with --register-prefix-optional.
//
// Shapes:
//   #expr                     immediate
//   Dn / An / sr / ccr / usp  register
//   d0-d3/a0/a5               register list
//   (An) (An)+ -(An)          indirect, post-increment, pre-decrement
//   expr(An) (expr,An)        displacement
//   expr(An,Xn) (expr,An,Xn)  indexed (Xn may carry .w/.l; a bare Xn is .w)
//   expr(pc) (expr,pc[,Xn])   PC-relative
//   expr  expr.w  expr.l  (expr).w  (expr).l   absolute / branch target
//
// Anything the parser cannot read is passed through as raw text, so GNU as
// reports the problem in its own words.
//
// Plain JS ESM + JSDoc.

import { parseExpr, isRegister, readIdent, ExprError } from "./expr.js";

/** @typedef {import("./expr.js").Expr} Expr */
/** @typedef {{reg:string, size?:string, scale?:string}} IndexReg */
/**
 * @typedef {{k:"imm", e:Expr} | {k:"reg", text:string} | {k:"reglist", text:string} |
 *   {k:"ind", reg:string} | {k:"postinc", reg:string} | {k:"predec", reg:string} |
 *   {k:"disp", e:Expr|null, base:string, index:IndexReg|null} |
 *   {k:"abs", e:Expr, size:string|null} | {k:"raw", text:string}} Operand
 */

const REG_RE = /^(?:[dDaA][0-7]|[sS][pP]|[fF][pP])$/;
const SPECIAL_RE = /^(?:[sS][rR]|[cC][cC][rR]|[uU][sS][pP]|[sS][sS][pP])$/;
const REGLIST_RE = /^(?:(?:[dDaA][0-7]|[sS][pP]|[fF][pP])(?:-(?:[dDaA][0-7]|[sS][pP]|[fF][pP]))?)(?:\/(?:(?:[dDaA][0-7]|[sS][pP]|[fF][pP])(?:-(?:[dDaA][0-7]|[sS][pP]|[fF][pP]))?))*$/;
const RANGE_SHORT_RE = /^([dDaA])([0-7])-([0-7])$/; // d0-7 → d0-d7

/** Split an operand field at top-level commas (outside quotes and parentheses). */
export function splitOperands(text) {
  const out = [];
  let depth = 0, start = 0, q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q) { if (text[i + 1] === q) i++; else q = null; }
      continue;
    }
    if (c === "'" || c === '"') {
      // a quote right after an identifier character is part of a name in no
      // Motorola dialect we support; treat every quote as a string start
      q = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last.length || out.length) out.push(last);
  return out;
}

/** Normalise a register list (`d0-7/a0` → `d0-d7/a0`) or return null. */
function regList(text) {
  const parts = text.split("/").map((p) => {
    const m = RANGE_SHORT_RE.exec(p);
    return m ? `${m[1]}${m[2]}-${m[1]}${m[3]}` : p;
  });
  const t = parts.join("/");
  return REGLIST_RE.test(t) ? t : null;
}

/** Parse an index register `Xn[.w|.l][*scale]`. */
function indexReg(text) {
  const m = /^([dDaA][0-7]|[sS][pP]|[fF][pP])(?:\.([wWlL]))?(?:\*([1248]))?$/.exec(text.trim());
  if (!m) return null;
  return { reg: m[1], size: m[2] ? m[2].toLowerCase() : undefined, scale: m[3] };
}

/**
 * Parse an operand. Never throws: an operand it cannot read comes back as
 * `{k:"raw"}`.
 * @param {string} text
 * @returns {Operand}
 */
export function parseOperand(text) {
  const t = text.trim();
  try {
    return parseOperandStrict(t);
  } catch (e) {
    if (e instanceof ExprError) return { k: "raw", text: t };
    throw e;
  }
}

function parseOperandStrict(t) {
  if (t.startsWith("#")) {
    const { expr, end } = parseExpr(t, 1);
    if (end !== t.length) throw new ExprError("junk after immediate", end);
    return { k: "imm", e: expr };
  }
  if (REG_RE.test(t)) return { k: "reg", text: t };
  if (SPECIAL_RE.test(t)) return { k: "reg", text: t };
  if (/[/-]/.test(t) && !/[()#$%@'"+*]/.test(t)) {
    const rl = regList(t);
    if (rl) return { k: "reglist", text: rl };
  }
  let m = /^-\(\s*([aA][0-7]|[sS][pP]|[fF][pP])\s*\)$/.exec(t);
  if (m) return { k: "predec", reg: m[1] };
  m = /^\(\s*([aA][0-7]|[sS][pP]|[fF][pP])\s*\)(\+)?$/.exec(t);
  if (m) return m[2] ? { k: "postinc", reg: m[1] } : { k: "ind", reg: m[1] };

  if (t.startsWith("(")) {
    // (list) form: (expr,An[,Xn]) (expr,pc[,Xn]) (An,Xn) (expr).w (expr).l (expr)
    const close = matchParen(t, 0);
    if (close > 0) {
      const inner = t.slice(1, close);
      const after = t.slice(close + 1);
      const items = splitOperands(inner);
      const hasReg = items.some((it) => isBaseOrIndex(it));
      if (hasReg) {
        if (after !== "") throw new ExprError("junk after addressing mode", close + 1);
        return listForm(items, null);
      }
      // A parenthesised expression: absolute with an optional size, or the
      // start of a longer expression / a displacement form `(expr)(An)`.
    }
  }
  // expr, expr.w, expr.l, expr(An...), expr(pc...)
  const { expr, end } = parseExpr(t, 0);
  const rest = t.slice(end);
  if (rest === "") return { k: "abs", e: expr, size: null };
  const sz = /^\.([wWlL])$/.exec(rest);
  if (sz) return { k: "abs", e: expr, size: sz[1].toLowerCase() };
  if (rest.startsWith("(")) {
    const close = matchParen(rest, 0);
    if (close === rest.length - 1) {
      const items = splitOperands(rest.slice(1, close));
      if (items.length >= 1 && isBaseOrIndex(items[0])) return listForm(items, expr);
    }
  }
  throw new ExprError("cannot parse operand", end);
}

function isBaseOrIndex(it) {
  const s = it.trim();
  return /^([dDaA][0-7]|[sS][pP]|[fF][pP]|[pP][cC]|[zZ][pP][cC])(\.[wWlL])?(\*[1248])?$/.test(s);
}

/** Build a displacement / indexed operand from `(items)` with an optional outer displacement. */
function listForm(items, outer) {
  let disp = outer;
  const regs = [];
  for (const it of items) {
    const s = it.trim();
    if (isBaseOrIndex(s)) regs.push(s);
    else {
      if (disp) throw new ExprError("two displacements", 0);
      const { expr, end } = parseExpr(s, 0);
      if (end !== s.length) throw new ExprError("junk in displacement", end);
      disp = expr;
    }
  }
  if (regs.length === 0 || regs.length > 2) throw new ExprError("bad register list in operand", 0);
  const base = regs[0].replace(/\.[wWlL]$/, "");
  if (!/^([aA][0-7]|[sS][pP]|[fF][pP]|[pP][cC]|[zZ][pP][cC])$/.test(base)) {
    // (Dn) alone is not an addressing mode; (d,Dn) neither
    throw new ExprError("base register must be an address register or pc", 0);
  }
  let index = null;
  if (regs.length === 2) {
    index = indexReg(regs[1]);
    if (!index) throw new ExprError("bad index register", 0);
  }
  return { k: "disp", e: disp, base, index };
}

/** Index of the parenthesis matching the one at `start`, or -1. */
export function matchParen(s, start) {
  let depth = 0, q = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) { if (s[i + 1] === q) i++; else q = null; } continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Visit every expression inside an operand. */
export function operandExprs(op) {
  if (op.k === "imm" || op.k === "abs") return [op.e];
  if (op.k === "disp" && op.e) return [op.e];
  return [];
}

/** Return a copy of the operand with each expression replaced by `f(expr)`. */
export function mapOperand(op, f) {
  if (op.k === "imm") return { ...op, e: f(op.e) };
  if (op.k === "abs") return { ...op, e: f(op.e) };
  if (op.k === "disp" && op.e) return { ...op, e: f(op.e) };
  return op;
}

/**
 * Print an operand for GNU as. `ex(expr)` prints an expression.
 * @param {Operand} op
 * @param {(e:Expr)=>string} ex
 */
export function printOperand(op, ex) {
  switch (op.k) {
    case "imm": return "#" + ex(op.e);
    case "reg": return op.text.toLowerCase();
    case "reglist": return op.text.toLowerCase();
    case "ind": return `(${op.reg.toLowerCase()})`;
    case "postinc": return `(${op.reg.toLowerCase()})+`;
    case "predec": return `-(${op.reg.toLowerCase()})`;
    case "abs": return op.size ? `(${ex(op.e)}).${op.size}` : ex(op.e);
    case "disp": {
      const parts = [];
      if (op.e) parts.push(ex(op.e));
      parts.push(op.base.toLowerCase());
      if (op.index) {
        // An unsized index register is a word index (Motorola default);
        // GNU as would take it as a long.
        let s = op.index.reg.toLowerCase() + "." + (op.index.size ?? "w");
        if (op.index.scale) s += "*" + op.index.scale;
        parts.push(s);
      }
      return "(" + parts.join(",") + ")";
    }
    case "raw": return rawToGas(op.text);
  }
  return "";
}

/**
 * Best-effort conversion of an operand the parser could not read: Motorola
 * number prefixes become GNU as ones. GNU as then reports any real error.
 */
export function rawToGas(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j++;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$" && /[0-9A-Fa-f]/.test(text[i + 1] ?? "") && !/[A-Za-z0-9_]/.test(text[i - 1] ?? "")) {
      let j = i + 1;
      while (j < text.length && /[0-9A-Fa-f]/.test(text[j])) j++;
      out += "0x" + text.slice(i + 1, j);
      i = j;
      continue;
    }
    if (c === "%" && /[01]/.test(text[i + 1] ?? "") && !/[A-Za-z0-9_)]/.test(text[i - 1] ?? "")) {
      let j = i + 1;
      while (j < text.length && /[01]/.test(text[j])) j++;
      out += "0b" + text.slice(i + 1, j);
      i = j;
      continue;
    }
    const id = readIdent(text, i);
    if (id) { out += id.name; i = id.end; continue; }
    out += c;
    i++;
  }
  return out;
}

export { isRegister };
