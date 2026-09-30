// py.js - the small set of language semantics the workbench port needs to
// reproduce its reports value-for-value: ordering, integer parsing, string
// splitting and number formatting that differ between the language the
// diagnostics were first written in and JavaScript.
//
// Conventions for every module under src/decomp/workbench/:
//   - one JS module per original module, same name with '_' -> '-';
//   - functions are camelCase; constants keep UPPER_SNAKE; classes PascalCase;
//   - record objects keep their snake_case field AND computed-property names
//     (getters), because those names are the report keys;
//   - a record is a class whose constructor takes one object of fields.
//
// Plain JS ESM + JSDoc.

/** A float that must print with a decimal point (2.0, not 2). */
export class PyFloat {
  /** @param {number} value */
  constructor(value) { this.value = value; }
  valueOf() { return this.value; }
  toString() { return floatRepr(this.value); }
  toJSON() { return this.value; }
}

/** repr() of a float: shortest round-trip digits, always a '.' or exponent. */
export function floatRepr(x) {
  x = Number(x);
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (Object.is(x, -0)) return "-0.0";
  const abs = Math.abs(x);
  if (abs !== 0 && (abs >= 1e16 || abs < 1e-4)) {
    // exponent form, mantissa with shortest digits
    let [m, e] = x.toExponential().split("e");
    const exp = Number(e);
    const sign = exp < 0 ? "-" : "+";
    const digits = String(Math.abs(exp)).padStart(2, "0");
    return `${m}e${sign}${digits}`;
  }
  const s = String(x);
  if (/e/.test(s)) {
    // JS switches to exponent at 1e21; expand the plain decimal form.
    return BigInt(Math.round(x)).toString() + ".0";
  }
  return s.includes(".") ? s : `${s}.0`;
}

/** str() of an int or float the way the original formatted it. */
export function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (v instanceof PyFloat) return floatRepr(v.value);
  return String(v);
}

/**
 * Three-way comparison with the original's ordering rules: numbers (and
 * booleans as 0/1) numerically, strings by code point, arrays
 * lexicographically. None/undefined sort nowhere in the original (it raises);
 * here they sort first so a latent defect is visible rather than a crash.
 */
export function pyCmp(a, b) {
  if (a instanceof PyFloat) a = a.value;
  if (b instanceof PyFloat) b = b.value;
  if (typeof a === "boolean") a = a ? 1 : 0;
  if (typeof b === "boolean") b = b ? 1 : 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { const c = pyCmp(a[i], b[i]); if (c) return c; }
    return a.length - b.length < 0 ? -1 : a.length === b.length ? 0 : 1;
  }
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "string" && typeof b === "string") return strCmp(a, b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Code-point string comparison (UTF-16 code units differ above the BMP). */
export function strCmp(a, b) {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i), y = b.codePointAt(i);
    if (x !== y) return x < y ? -1 : 1;
    if (x > 0xffff) i++;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/** sorted(items, key=..., reverse=...) - stable, like the original. */
export function sorted(items, key = (x) => x, reverse = false) {
  const decorated = [...items].map((v, i) => [key(v), i, v]);
  decorated.sort((x, y) => {
    const c = pyCmp(x[0], y[0]);
    // reverse=True keeps equal elements in original order (stable reverse).
    return c !== 0 ? (reverse ? -c : c) : x[1] - y[1];
  });
  return decorated.map((d) => d[2]);
}

/** min(items, key=...) returning the FIRST minimal element. */
export function minBy(items, key = (x) => x) {
  let best, bestKey, first = true;
  for (const v of items) { const k = key(v); if (first || pyCmp(k, bestKey) < 0) { best = v; bestKey = k; first = false; } }
  if (first) throw new Error("min() arg is an empty sequence");
  return best;
}

/** max(items, key=...) returning the FIRST maximal element. */
export function maxBy(items, key = (x) => x) {
  let best, bestKey, first = true;
  for (const v of items) { const k = key(v); if (first || pyCmp(k, bestKey) > 0) { best = v; bestKey = k; first = false; } }
  if (first) throw new Error("max() arg is an empty sequence");
  return best;
}

/** int(text, base) with the original's accepted spellings; throws on junk. */
export function pyInt(text, base = 10) {
  if (typeof text === "number") return Math.trunc(text);
  let s = String(text).trim().replace(/_(?=[0-9a-fA-F])/g, "");
  let sign = 1;
  if (s.startsWith("-")) { sign = -1; s = s.slice(1); } else if (s.startsWith("+")) s = s.slice(1);
  let digits = s, radix = base;
  if (base === 0) {
    if (/^0[xX]/.test(s)) { radix = 16; digits = s.slice(2); }
    else if (/^0[oO]/.test(s)) { radix = 8; digits = s.slice(2); }
    else if (/^0[bB]/.test(s)) { radix = 2; digits = s.slice(2); }
    else {
      radix = 10;
      // base 0 refuses a leading zero on a non-zero decimal ("010").
      if (/^0+[1-9]/.test(s)) throw new ValueError(`invalid literal for int() with base 0: '${text}'`);
    }
  } else if (base === 16 && /^0[xX]/.test(s)) digits = s.slice(2);
  else if (base === 8 && /^0[oO]/.test(s)) digits = s.slice(2);
  else if (base === 2 && /^0[bB]/.test(s)) digits = s.slice(2);
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz".slice(0, radix);
  if (!digits.length || ![...digits.toLowerCase()].every((c) => alphabet.includes(c))) {
    throw new ValueError(`invalid literal for int() with base ${base}: '${text}'`);
  }
  const big = BigInt(sign < 0 ? "-0" : "0") + [...digits.toLowerCase()].reduce((acc, c) => acc * BigInt(radix) + BigInt(alphabet.indexOf(c)), 0n);
  const v = Number(sign < 0 ? -big : big);
  return v;
}

/** The original's ValueError, so ported handlers can catch the same class. */
export class ValueError extends Error {
  constructor(message) { super(message); this.name = "ValueError"; }
}

/** str.splitlines(): every line boundary the original recognises, no ends. */
export function splitlines(text) {
  const out = [];
  const re = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) { out.push(text.slice(last, m.index)); last = m.index + m[0].length; }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const PY_WS = " \t\n\r\v\f\x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";

/** str.strip()/lstrip()/rstrip() with no argument, or with a character set. */
export function strip(s, chars = null) { return rstrip(lstrip(s, chars), chars); }
export function lstrip(s, chars = null) { const set = chars ?? PY_WS; let i = 0; while (i < s.length && set.includes(s[i])) i++; return s.slice(i); }
export function rstrip(s, chars = null) { const set = chars ?? PY_WS; let j = s.length; while (j > 0 && set.includes(s[j - 1])) j--; return s.slice(0, j); }

/** str.split() with no separator: runs of whitespace, no empty fields. */
export function splitWs(s, maxsplit = -1) {
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && PY_WS.includes(s[i])) i++;
    if (i >= n) break;
    if (maxsplit >= 0 && out.length === maxsplit) { out.push(rstrip(s.slice(i))); return out; }
    let j = i;
    while (j < n && !PY_WS.includes(s[j])) j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

/** Floor division and modulo with the original's sign rules. */
export function floorDiv(a, b) { return Math.floor(a / b); }
export function pyMod(a, b) { const r = a % b; return r !== 0 && (r < 0) !== (b < 0) ? r + b : r; }

/** round() with ties to even, like the original's built-in. */
export function pyRound(x, ndigits = 0) {
  const m = 10 ** ndigits;
  const y = x * m;
  const f = Math.floor(y);
  const diff = y - f;
  let r;
  if (Math.abs(diff - 0.5) < 1e-12) r = f % 2 === 0 ? f : f + 1;
  else r = Math.round(y);
  return r / m;
}

/** Format an integer the way `{value:#x}`, `{value:08x}`, `{value:x}` do. */
export function hex(value, width = 0, { prefix = false, upper = false } = {}) {
  const neg = value < 0;
  let s = Math.abs(value).toString(16);
  if (upper) s = s.toUpperCase();
  const p = prefix ? (upper ? "0X" : "0x") : "";
  // Width in the original counts the sign and prefix.
  const pad = Math.max(0, width - (neg ? 1 : 0) - p.length);
  return (neg ? "-" : "") + p + s.padStart(pad, "0");
}

/** `{value:.Nf}` */
export function fixed(value, n) {
  // Both round the exact binary value; they differ only on an exact tie,
  // where toFixed rounds up and the original rounds to even.
  const x = Number(value);
  if (!Number.isFinite(x)) return x !== x ? "nan" : x > 0 ? "inf" : "-inf";
  const s = x.toFixed(n);
  const exact = Math.abs(x).toFixed(Math.min(100, n + 60));
  const tail = exact.slice(exact.indexOf(".") + 1 + n);
  if (!/^50*$/.test(tail)) return s;
  const lastDigit = n === 0 ? Math.trunc(Math.abs(x)) % 10 : Number(exact[exact.indexOf(".") + n]);
  if (lastDigit % 2 === 0) {
    // Keep the even digit: truncate instead of rounding up.
    const kept = exact.slice(0, exact.indexOf(".") + (n ? 1 + n : 0));
    return (x < 0 ? "-" : "") + kept;
  }
  return s;
}

/** `{value:.N%}` */
export function percent(value, n = 0) { return `${(Number(value) * 100).toFixed(n)}%`; }

/**
 * A mapping with the original's dict semantics: insertion order for EVERY key
 * type (plain JS objects reorder integer-like keys), and keys compared by
 * value, including tuple keys (arrays), which are keyed by their JSON text.
 */
export class PyDict {
  constructor(entries = []) { this._m = new Map(); for (const [k, v] of entries) this.set(k, v); }
  static _k(k) { return Array.isArray(k) ? `\u0000${JSON.stringify(k)}` : k; }
  get size() { return this._m.size; }
  has(k) { return this._m.has(PyDict._k(k)); }
  get(k, dflt = undefined) { const e = this._m.get(PyDict._k(k)); return e === undefined ? dflt : e[1]; }
  set(k, v) { const kk = PyDict._k(k); const e = this._m.get(kk); if (e) e[1] = v; else this._m.set(kk, [k, v]); return this; }
  setdefault(k, v) { if (!this.has(k)) this.set(k, v); return this.get(k); }
  delete(k) { return this._m.delete(PyDict._k(k)); }
  *keys() { for (const [k] of this._m.values()) yield k; }
  *values() { for (const [, v] of this._m.values()) yield v; }
  *entries() { for (const [k, v] of this._m.values()) yield [k, v]; }
  [Symbol.iterator]() { return this.keys(); }
}

/** A set with value semantics for tuple (array) members. */
export class PySet {
  constructor(items = []) { this._m = new Map(); for (const v of items) this.add(v); }
  get size() { return this._m.size; }
  add(v) { this._m.set(PyDict._k(v), v); return this; }
  has(v) { return this._m.has(PyDict._k(v)); }
  delete(v) { return this._m.delete(PyDict._k(v)); }
  *values() { yield* this._m.values(); }
  [Symbol.iterator]() { return this._m.values(); }
}

/** Counter-like tally into a PyDict preserving first-seen order. */
export function counter(items) {
  const d = new PyDict();
  for (const v of items) d.set(v, (d.get(v) ?? 0) + 1);
  return d;
}

/** Counter.most_common(): count descending, first-seen order among ties. */
export function mostCommon(d, n = undefined) {
  const out = sorted([...d.entries()], (e) => e[1], true);
  return n === undefined ? out : out.slice(0, n);
}

/** dataclasses.replace(record, **changes). */
export function replace(record, changes) {
  return Object.freeze(Object.assign(Object.create(Object.getPrototypeOf(record)), record, changes));
}

/** Deep value equality, the way dataclass/tuple/list `==` compares. */
export function pyEq(a, b) {
  if (a === b) return true;
  if (a instanceof PyFloat) a = a.value;
  if (b instanceof PyFloat) b = b.value;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "boolean" || typeof b === "boolean") return Number(a) === Number(b) && typeof a !== "object" && typeof b !== "object";
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => pyEq(v, b[i]));
  if (a instanceof PyDict && b instanceof PyDict) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a.entries()) { if (!b.has(k) || !pyEq(v, b.get(k))) return false; }
    return true;
  }
  if (a instanceof PySet && b instanceof PySet) return a.size === b.size && [...a].every((v) => b.has(v));
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && pyEq(a[k], b[k]));
}

/** sum() of booleans/numbers. */
export function sum(items) { let t = 0; for (const v of items) t += typeof v === "boolean" ? (v ? 1 : 0) : Number(v); return t; }

/** Truthiness with the original's rules (empty containers are false). */
export function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Number.isNaN(v)) return false;
  if (v instanceof PyFloat) return v.value !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set || v instanceof PyDict || v instanceof PySet) return v.size > 0;
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.keys(v).length > 0;
  return true;
}

/** Escape a literal for use inside a RegExp. */
export function reEscape(s) { return s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"); }

/** re.fullmatch(pattern, text) for a JS RegExp. */
export function fullmatch(re, text) {
  const flags = re.flags.replace(/[gy]/g, "");
  const anchored = new RegExp(`^(?:${re.source})$`, flags);
  return anchored.exec(text);
}

/** re.match(pattern, text): anchored at the start only. */
export function match(re, text) {
  const flags = re.flags.replace(/[gy]/g, "") + "y";
  const sticky = new RegExp(re.source, flags);
  sticky.lastIndex = 0;
  return sticky.exec(text);
}

/** repr() of a str, for messages that embed `{value!r}`. */
export function strRepr(s) {
  if (s === null || s === undefined) return "None";
  if (typeof s !== "string") return pyStr(s);
  const useDouble = s.includes("'") && !s.includes('"');
  const q = useDouble ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += `\\${q}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return q + out + q;
}

/** Errors a command reports as `error: ...` exit 2 (ValueError and OSError). */
export function isInputError(e) { return e instanceof ValueError || e?.name === "ValueError" || (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code)); }

/** Human wording for a filesystem error, the way the original printed it. */
export function osErrorText(e, cwd = process.cwd()) {
  // Paths read relative to the working directory (the project root), the
  // way a command typed in that directory names them.
  const shown = typeof e?.path === "string" && e.path.startsWith("/") && (e.path + "/").startsWith(cwd.replace(/\/?$/, "/")) ? e.path.slice(cwd.replace(/\/?$/, "/").length) || "." : e?.path;
  if (e?.code === "ENOENT") return `[Errno 2] No such file or directory: '${shown}'`;
  if (e?.code === "EISDIR") return `[Errno 21] Is a directory: '${shown}'`;
  if (e?.code === "EACCES") return `[Errno 13] Permission denied: '${shown}'`;
  if (e?.code === "EEXIST") return `[Errno 17] File exists: '${shown}'`;
  if (e?.code === "ENOTDIR") return `[Errno 20] Not a directory: '${shown}'`;
  return e?.message ?? String(e);
}
