// Motorola-syntax expressions for the 68k assembler front end (m68k-asm).
//
// romdev's Genesis assembly is written in Motorola syntax ($hex, %binary,
// @octal, 'chars', `*` for the current address) and assembled by GNU as. GNU
// as reads a different expression language: its operator precedence differs
// (it binds `*` tighter than `&`, and puts the comparisons on the same level as
// `+`), it uses `.` for the current address, and it evaluates in 64 bits. So
// the front end parses every expression itself, folds what it can with 32-bit
// two's-complement arithmetic, and prints the rest fully parenthesised for GNU
// as. The grammar and the folding rules below follow the Motorola-syntax
// convention the shipped sources were written against:
//
//   (tightest)  unary - ~ ! +
//               << >>
//               &
//               ^
//               |
//               * / %
//               + -
//               < > <= >=
//               == != (also = and <>)
//               &&
//   (loosest)   ||
//
// Comparisons and logical operators yield -1 for true and 0 for false.
// Strings inside expressions are character constants, packed big-endian.
//
// Plain JS ESM + JSDoc.

/** @typedef {{t:"num", v:number} | {t:"sym", name:string} | {t:"pc"} |
 *   {t:"un", op:string, a:Expr} | {t:"bin", op:string, a:Expr, b:Expr}} Expr */

const ID_START = /[A-Za-z_.@]/;
const ID_CHAR = /[A-Za-z0-9_$%]/;

/** 68k register names. An identifier that is a register name is not a symbol,
 *  which is how the operand parser tells `(a0)` from `(expr)`. */
export const REGISTER_RE = /^(?:[dDaA][0-7]|[sS][pP]|[pP][cC]|[sS][rR]|[cC][cC][rR]|[uU][sS][pP]|[sS][sS][pP]|[fF][pP]|[zZ][pP][cC])$/;

/** True when `name` names a 68k register (case-insensitive). */
export function isRegister(name) {
  return REGISTER_RE.test(name);
}

/** Error thrown by the parser; `pos` is the offset inside the parsed text. */
export class ExprError extends Error {
  constructor(message, pos) {
    super(message);
    this.pos = pos;
  }
}

/**
 * Read an identifier starting at `s[i]`, Motorola rules: starts with a letter,
 * `_`, `.` (local label) or `@`; continues with letters, digits, `_`, `$`, `%`.
 * A `global\local` reference is read as one token. A local label made of
 * digits plus a trailing `$` (`1$`) is also accepted.
 * @returns {{name:string, end:number} | null}
 */
export function readIdent(s, i) {
  const c = s[i];
  if (c === undefined) return null;
  let j = i;
  if (/[0-9]/.test(c)) {
    // `123$` local label
    let k = i;
    while (k < s.length && /[0-9A-Za-z_]/.test(s[k])) k++;
    if (s[k] === "$" && !ID_CHAR.test(s[k + 1] ?? "")) return { name: s.slice(i, k + 1), end: k + 1 };
    return null;
  }
  if (!ID_START.test(c)) return null;
  if (c === "@" && /[0-7]/.test(s[i + 1] ?? "")) return null; // @17 is octal
  j++;
  while (j < s.length && ID_CHAR.test(s[j])) j++;
  // global\local reference
  if (s[j] === "\\" && ID_START.test(s[j + 1] ?? "") && c !== ".") {
    const loc = readIdent(s, j + 1);
    if (loc) return { name: s.slice(i, loc.end), end: loc.end };
  }
  if (j - i === 1 && (c === "." || c === "@" || c === "_")) return null;
  return { name: s.slice(i, j), end: j };
}

/**
 * Decode the body of a quoted string (Motorola rules: a doubled quote is one
 * quote character; backslash is an ordinary character). `s[i]` is the opening
 * quote.
 * @returns {{bytes:number[], end:number}}
 */
export function readString(s, i) {
  const q = s[i];
  const bytes = [];
  let j = i + 1;
  for (;;) {
    if (j >= s.length) throw new ExprError(`missing closing ${q}`, i);
    const ch = s[j];
    if (ch === q) {
      if (s[j + 1] === q) { bytes.push(q.charCodeAt(0)); j += 2; continue; }
      j++;
      break;
    }
    const code = ch.charCodeAt(0);
    if (code > 0xff) {
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
    } else bytes.push(code);
    j++;
  }
  return { bytes, end: j };
}

/**
 * Parse one Motorola-syntax expression starting at `pos` in `text`.
 * Stops at the first character that cannot continue the expression (a comma,
 * a closing parenthesis that is not ours, an addressing-mode `(`, end of text).
 * Register names are not expressions: meeting one throws, so the operand
 * parser can try an addressing mode instead (directive operands pass
 * registersAreSymbols, where `d1` can only be a symbol).
 * @param {string} text
 * @param {number} [pos]
 * @param {{registersAreSymbols?:boolean}} [opts]
 * @returns {{expr:Expr, end:number}}
 */
export function parseExpr(text, pos = 0, opts = {}) {
  let i = pos;
  const peek = (str) => text.startsWith(str, i);

  function primary() {
    const c = text[i];
    if (c === undefined) throw new ExprError("expression expected", i);
    if (c === "(") {
      const open = i;
      i++;
      const e = lor();
      if (text[i] !== ")") throw new ExprError("missing closing parenthesis", open);
      i++;
      return e;
    }
    // Numbers: $hex, %binary, @octal, decimal, and 0x hex (the GNU spelling,
    // accepted as a convenience). An underscore between digits is a digit
    // separator ($7000_0083).
    if (c === "$") return number(i + 1, /[0-9A-Fa-f]/, 16, "hex digits expected after $");
    if (c === "%" && /[01]/.test(text[i + 1] ?? "")) return number(i + 1, /[01]/, 2);
    if (c === "@" && /[0-7]/.test(text[i + 1] ?? "")) return number(i + 1, /[0-7]/, 8);
    if (c === "0" && /[xX]/.test(text[i + 1] ?? "") && /[0-9A-Fa-f]/.test(text[i + 2] ?? "")) return number(i + 2, /[0-9A-Fa-f]/, 16);
    if (/[0-9]/.test(c)) {
      const loc = readIdent(text, i);
      if (loc) { i = loc.end; return { t: "sym", name: loc.name }; }
      const n = number(i, /[0-9]/, 10);
      if (/[.eE]/.test(text[i] ?? "") && /[0-9]/.test(text[i + 1] ?? "")) {
        throw new ExprError("floating point constants are only allowed in dc.s/dc.d", i);
      }
      return n;
    }
    if (c === "'" || c === '"') {
      const str = readString(text, i);
      if (str.bytes.length > 4) throw new ExprError("character constant longer than 4 bytes", i);
      let v = 0;
      for (const b of str.bytes) v = ((v << 8) | b) >>> 0;
      i = str.end;
      return { t: "num", v: v | 0 };
    }
    if (c === "*" ) {
      i++;
      return { t: "pc" };
    }
    const id = readIdent(text, i);
    if (id) {
      if (isRegister(id.name) && !opts.registersAreSymbols) throw new ExprError(`register ${id.name} is not an expression`, i);
      i = id.end;
      return { t: "sym", name: id.name };
    }
    throw new ExprError(`unexpected '${c}' in expression`, i);
  }

  function number(start, digitRe, base, emptyMsg) {
    let j = start;
    let digits = "";
    while (j < text.length) {
      if (digitRe.test(text[j])) { digits += text[j]; j++; continue; }
      if (text[j] === "_" && digits && digitRe.test(text[j + 1] ?? "")) { j++; continue; }
      break;
    }
    if (!digits) throw new ExprError(emptyMsg ?? "digits expected", i);
    const v = parseBig(digits, base, i);
    i = j;
    return { t: "num", v };
  }

  function unary() {
    const c = text[i];
    if (c === "-") { i++; return { t: "un", op: "-", a: primary2() }; }
    if (c === "+") { i++; return primary2(); }
    if (c === "~") { i++; return { t: "un", op: "~", a: primary2() }; }
    if (c === "!") { i++; return { t: "un", op: "!", a: primary2() }; }
    return primary();
  }
  // A unary operator applies to a primary that may itself carry a unary operator
  // (`--5`, `-~x`).
  function primary2() {
    const c = text[i];
    if (c === "-" || c === "+" || c === "~" || c === "!") return unary();
    return primary();
  }

  function binLevel(next, ops) {
    return () => {
      let a = next();
      for (;;) {
        const op = ops.find((o) => peek(o) && !ambiguous(o));
        if (!op) return a;
        i += op.length;
        const b = next();
        a = { t: "bin", op: normOp(op), a, b };
      }
    };
  }
  // `<` must not swallow `<<`/`<=`/`<>`, `>` must not swallow `>>`/`>=`,
  // `&` must not swallow `&&`, `|` must not swallow `||`, `=` not `==`.
  function ambiguous(op) {
    const nx = text[i + op.length];
    if (op === "<") return nx === "<" || nx === "=" || nx === ">";
    if (op === ">") return nx === ">" || nx === "=";
    if (op === "&") return nx === "&";
    if (op === "|") return nx === "|";
    if (op === "=") return nx === "=";
    if (op === "!") return nx === "=";
    return false;
  }

  const shift = binLevel(unary, ["<<", ">>"]);
  const band = binLevel(shift, ["&"]);
  const bxor = binLevel(band, ["^", "~"]);
  const bor = binLevel(bxor, ["|", "!"]);
  const mul = binLevel(bor, ["*", "//", "/", "%"]);
  const add = binLevel(mul, ["+", "-"]);
  const rel = binLevel(add, ["<=", ">=", "<", ">"]);
  const eq = binLevel(rel, ["==", "!=", "<>", "="]);
  const land = binLevel(eq, ["&&"]);
  const lor = binLevel(land, ["||"]);

  const expr = lor();
  return { expr, end: i };
}

function normOp(op) {
  if (op === "<>") return "!=";
  if (op === "=") return "==";
  if (op === "!") return "|"; // `!` as a binary operator is inclusive or
  if (op === "~") return "^"; // `~` as a binary operator is exclusive or
  if (op === "//") return "%";
  return op;
}

function parseBig(digits, base, pos) {
  let v = 0n;
  const B = BigInt(base);
  for (const d of digits) v = v * B + BigInt(parseInt(d, base));
  if (v > 0xffffffffn) throw new ExprError("constant does not fit in 32 bits", pos);
  return Number(BigInt.asIntN(32, v));
}

/**
 * Fold an expression to a 32-bit constant using `lookup(name)` for symbol
 * values (return undefined when unknown). `*` never folds.
 * @param {Expr} e
 * @param {(name:string)=>number|undefined} lookup
 * @returns {number|undefined}
 */
export function evalExpr(e, lookup) {
  switch (e.t) {
    case "num": return e.v;
    case "pc": return undefined;
    case "sym": {
      const v = lookup(e.name);
      return v === undefined ? undefined : v | 0;
    }
    case "un": {
      const a = evalExpr(e.a, lookup);
      if (a === undefined) return undefined;
      if (e.op === "-") return (-a) | 0;
      if (e.op === "~") return ~a;
      if (e.op === "!") return a ? 0 : -1;
      return undefined;
    }
    case "bin": {
      const a = evalExpr(e.a, lookup);
      const b = evalExpr(e.b, lookup);
      if (a === undefined || b === undefined) return undefined;
      switch (e.op) {
        case "+": return (a + b) | 0;
        case "-": return (a - b) | 0;
        case "*": return Math.imul(a, b);
        case "/": if (b === 0) throw new ExprError("division by zero", 0); return (a / b) | 0;
        case "%": if (b === 0) throw new ExprError("division by zero", 0); return (a % b) | 0;
        case "<<": return b >= 32 || b < 0 ? 0 : (a << b) | 0;
        case ">>": return b >= 32 || b < 0 ? (a < 0 ? -1 : 0) : a >> b;
        case "&": return a & b;
        case "^": return a ^ b;
        case "|": return a | b;
        case "<": return a < b ? -1 : 0;
        case ">": return a > b ? -1 : 0;
        case "<=": return a <= b ? -1 : 0;
        case ">=": return a >= b ? -1 : 0;
        case "==": return a === b ? -1 : 0;
        case "!=": return a !== b ? -1 : 0;
        case "&&": return a && b ? -1 : 0;
        case "||": return a || b ? -1 : 0;
      }
      return undefined;
    }
  }
  return undefined;
}

/**
 * Replace every symbol with a known constant value by that number, and fold
 * constant subtrees. Unknown symbols and `*` stay symbolic.
 * @param {Expr} e
 * @param {(name:string)=>number|undefined} lookup
 * @returns {Expr}
 */
export function foldExpr(e, lookup) {
  const v = evalExpr(e, lookup);
  if (v !== undefined) return { t: "num", v };
  if (e.t === "un") return { t: "un", op: e.op, a: foldExpr(e.a, lookup) };
  if (e.t === "bin") return { t: "bin", op: e.op, a: foldExpr(e.a, lookup), b: foldExpr(e.b, lookup) };
  return e;
}

/** Collect symbol names referenced by an expression. */
export function exprSymbols(e, out = new Set()) {
  if (e.t === "sym") out.add(e.name);
  else if (e.t === "un") exprSymbols(e.a, out);
  else if (e.t === "bin") { exprSymbols(e.a, out); exprSymbols(e.b, out); }
  return out;
}

/** True when the expression mentions `*`. */
export function exprUsesPc(e) {
  if (e.t === "pc") return true;
  if (e.t === "un") return exprUsesPc(e.a);
  if (e.t === "bin") return exprUsesPc(e.a) || exprUsesPc(e.b);
  return false;
}

/** Rename symbols through `map(name) → name`. */
export function renameSymbols(e, map) {
  if (e.t === "sym") return { t: "sym", name: map(e.name) };
  if (e.t === "un") return { t: "un", op: e.op, a: renameSymbols(e.a, map) };
  if (e.t === "bin") return { t: "bin", op: e.op, a: renameSymbols(e.a, map), b: renameSymbols(e.b, map) };
  return e;
}

/**
 * Linear form of an expression over relocatable symbols: returns the symbol
 * coefficients when the expression is a sum of constant terms and symbols
 * combined only with + and - (and constant multipliers of zero symbols),
 * otherwise null. `isReloc(name)` says which symbols are relocatable.
 * @returns {Map<string, number> | null}
 */
export function linearReloc(e, isReloc) {
  const out = new Map();
  const add = (name, k) => out.set(name, (out.get(name) ?? 0) + k);
  function walk(x, sign) {
    if (x.t === "num") return true;
    if (x.t === "pc") { add("*", sign); return true; }
    if (x.t === "sym") { if (isReloc(x.name)) add(x.name, sign); return true; }
    if (x.t === "un") {
      if (x.op === "-") return walk(x.a, -sign);
      return !hasReloc(x.a, isReloc);
    }
    if (x.t === "bin") {
      if (x.op === "+") return walk(x.a, sign) && walk(x.b, sign);
      if (x.op === "-") return walk(x.a, sign) && walk(x.b, -sign);
      return !hasReloc(x, isReloc);
    }
    return false;
  }
  if (!walk(e, 1)) return null;
  for (const [k, v] of out) if (v === 0) out.delete(k);
  return out;
}

/** True when the expression references a relocatable symbol or `*`. */
export function hasReloc(e, isReloc) {
  if (e.t === "pc") return true;
  if (e.t === "sym") return isReloc(e.name);
  if (e.t === "un") return hasReloc(e.a, isReloc);
  if (e.t === "bin") return hasReloc(e.a, isReloc) || hasReloc(e.b, isReloc);
  return false;
}

/**
 * Print an expression for GNU as. `symText(name)` returns the text for a
 * symbol (so the caller can rewrite labels into absolute form); `pcText`
 * replaces `*`.
 * @param {Expr} e
 * @param {{symText?:(name:string)=>string, pcText?:string}} [o]
 * @returns {string}
 */
export function printExpr(e, o = {}) {
  const symText = o.symText ?? ((n) => n);
  switch (e.t) {
    case "num": return numText(e.v);
    case "pc": return o.pcText ?? ".";
    case "sym": return symText(e.name);
    case "un": return `(${e.op}${printExpr(e.a, o)})`;
    case "bin": return `(${printExpr(e.a, o)}${e.op}${printExpr(e.b, o)})`;
  }
  return "0";
}

/** A 32-bit constant as GNU as text: small values in decimal, others in hex. */
export function numText(v) {
  if (v >= -9 && v <= 9) return v < 0 ? `(${v})` : String(v);
  if (v < 0) return `(-0x${(-v >>> 0).toString(16)})`;
  return "0x" + (v >>> 0).toString(16);
}
