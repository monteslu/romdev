// py.js - small helpers that reproduce the Python semantics m2c relies on
// (integer arithmetic, number formatting, string methods, containers), so the
// module-by-module port can stay a line-for-line translation.
//
// Porting conventions used across src/:
// - Identifiers keep m2c's Python names (snake_case functions, methods and
//   attributes; CamelCase classes) so the port can be diffed against upstream.
// - Python ints are JS Numbers. Every bitwise operation that can see a value
//   outside int32 goes through band/bor/bxor/shl/shr below (JS operators
//   truncate to 32 bits). `//` is floordiv, `%` is pymod.
// - Frozen value dataclasses are interned (see intern()), so `===` and Map
//   keys give Python's value equality and hashing.
// - `assert` becomes pyassert(), raising AssertionError.

export class AssertionError extends Error {
  constructor(message) {
    super(message ?? "");
    this.name = "AssertionError";
  }
}
export class ValueError extends Error {
  constructor(message) {
    super(message ?? "");
    this.name = "ValueError";
  }
}
export class IndexError extends Error {
  constructor(message) {
    super(message ?? "");
    this.name = "IndexError";
  }
}
export class KeyError extends Error {
  constructor(message) {
    super(message ?? "");
    this.name = "KeyError";
  }
}

/** Python `assert cond, msg`. */
export function pyassert(cond, msg) {
  if (!cond) throw new AssertionError(msg === undefined ? "" : String(msg));
}

// ---------------------------------------------------------------- integers

const I32_MIN = -0x80000000;
const I32_MAX = 0x7fffffff;
const isI32 = (x) => x >= I32_MIN && x <= I32_MAX;

function toBig(x) {
  if (typeof x === "bigint") return x;
  if (!Number.isInteger(x)) throw new TypeError(`integer expected, got ${x}`);
  return BigInt(x);
}
/**
 * Python ints beyond 2**53 (64-bit register/double bit patterns) are kept as
 * BigInt so no bits are lost; everything in the safe range is a Number.
 */
function fromBig(b) {
  const n = Number(b);
  return Number.isSafeInteger(n) ? n : b;
}
export function normint(b) {
  return typeof b === "bigint" ? fromBig(b) : b;
}

/** Python `a & b` for arbitrary-size ints. */
export function band(a, b) {
  if (isI32(a) && isI32(b)) return a & b;
  if (a >= 0 && b >= 0 && a <= 0xffffffff && b <= 0xffffffff) return (a & b) >>> 0;
  return fromBig(toBig(a) & toBig(b));
}
/** Python `a | b`. */
export function bor(a, b) {
  if (isI32(a) && isI32(b)) return a | b;
  if (a >= 0 && b >= 0 && a <= 0xffffffff && b <= 0xffffffff) return (a | b) >>> 0;
  return fromBig(toBig(a) | toBig(b));
}
/** Python `a ^ b`. */
export function bxor(a, b) {
  if (isI32(a) && isI32(b)) return a ^ b;
  if (a >= 0 && b >= 0 && a <= 0xffffffff && b <= 0xffffffff) return (a ^ b) >>> 0;
  return fromBig(toBig(a) ^ toBig(b));
}
/** Python `~a`. */
export function bnot(a) {
  if (typeof a === "bigint") return normint(-a - 1n);
  return -a - 1;
}
/** Python `a << n`. */
export function shl(a, n) {
  if (n < 0) throw new ValueError("negative shift count");
  if (n < 31 && isI32(a)) {
    const r = a * 2 ** n;
    if (Number.isSafeInteger(r)) return r;
  }
  return fromBig(toBig(a) << toBig(n));
}
/** Python `a >> n` (arithmetic, floors). */
export function shr(a, n) {
  if (n < 0) throw new ValueError("negative shift count");
  if (isI32(a)) return n >= 32 ? (a < 0 ? -1 : 0) : a >> n;
  return fromBig(toBig(a) >> toBig(n));
}
/** Python `a // b`. */
export function floordiv(a, b) {
  if (b === 0) throw new Error("ZeroDivisionError: integer division or modulo by zero");
  if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) {
    const q = Math.floor(a / b);
    // Guard against rounding in the float division for large operands.
    if (Math.abs(a) < 2 ** 52 && Math.abs(b) < 2 ** 52) return q;
    const A = BigInt(a), B = BigInt(b);
    let r = A / B;
    if ((A % B !== 0n) && ((A < 0n) !== (B < 0n))) r -= 1n;
    return Number(r);
  }
  return Math.floor(a / b);
}
/** Python `a % b` for ints (result has the sign of b). */
export function pymod(a, b) {
  if (b === 0) throw new Error("ZeroDivisionError: integer division or modulo by zero");
  if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) {
    const r = a % b;
    return r !== 0 && (r < 0) !== (b < 0) ? r + b : r === 0 ? 0 : r;
  }
  const r = a % b;
  return r !== 0 && (r < 0) !== (b < 0) ? r + b : r;
}
/** Python float `%` (math.fmod with divisor sign). */
export function pyfmod(a, b) {
  const r = a % b;
  return r !== 0 && (r < 0) !== (b < 0) ? r + b : r;
}

/** Python `hex(n)`. */
export function hex(n) {
  if (typeof n === "bigint") return n < 0n ? "-0x" + (-n).toString(16) : "0x" + n.toString(16);
  return n < 0 ? "-0x" + (-n).toString(16) : "0x" + n.toString(16);
}

/**
 * Python `int(s, base)`. base 0 honours 0x/0o/0b prefixes (and rejects
 * leading zeros on decimals, like Python). Underscores between digits allowed.
 */
export function int_(s, base = 10) {
  if (typeof s === "number") {
    if (!Number.isFinite(s)) throw new ValueError(`cannot convert float ${s} to integer`);
    return Math.trunc(s);
  }
  if (typeof s === "boolean") return s ? 1 : 0;
  const orig = s;
  let t = String(s).trim();
  let neg = false;
  if (t.startsWith("-")) { neg = true; t = t.slice(1); } else if (t.startsWith("+")) t = t.slice(1);
  let b = base;
  const low = t.toLowerCase();
  if (b === 0) {
    if (low.startsWith("0x")) { b = 16; t = t.slice(2); }
    else if (low.startsWith("0o")) { b = 8; t = t.slice(2); }
    else if (low.startsWith("0b")) { b = 2; t = t.slice(2); }
    else {
      b = 10;
      if (/^0+[1-9_]/.test(t) && !/^0+(_0+)*$/.test(t)) throw new ValueError(`invalid literal for int() with base 0: '${orig}'`);
    }
    if (t.startsWith("_")) t = t.slice(1);
  } else if (b === 16 && low.startsWith("0x")) t = t.slice(2);
  else if (b === 8 && low.startsWith("0o")) t = t.slice(2);
  else if (b === 2 && low.startsWith("0b")) t = t.slice(2);
  if (!t || t.startsWith("_") || t.endsWith("_") || t.includes("__")) throw new ValueError(`invalid literal for int() with base ${base}: '${orig}'`);
  t = t.replace(/_/g, "");
  const digits = "0123456789abcdefghijklmnopqrstuvwxyz".slice(0, b);
  for (const c of t.toLowerCase()) if (!digits.includes(c)) throw new ValueError(`invalid literal for int() with base ${base}: '${orig}'`);
  let v;
  if (t.length <= 12 || (b === 16 && t.length <= 13)) v = parseInt(t, b);
  else {
    let big = 0n;
    const B = BigInt(b);
    for (const c of t.toLowerCase()) big = big * B + BigInt(digits.indexOf(c));
    v = fromBig(neg ? -big : big);
    return v;
  }
  return neg ? -v : v;
}

/** Python bool(int(...)) style truthiness for common values. */
export function truthy(x) {
  if (x === null || x === undefined || x === false || x === 0 || x === "" || x === 0n) return false;
  if (Array.isArray(x)) return x.length > 0;
  if (x instanceof Map || x instanceof Set) return x.size > 0;
  return true;
}

// ---------------------------------------------------------------- floats

/** Python `repr(float)` / `str(float)`. */
export function float_repr(x) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const e = x.toExponential(); // shortest round-trip digits
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(e);
  const sign = m[1];
  const digits = m[2] + (m[3] ?? "");
  const exp = parseInt(m[4], 10);
  if (exp < -4 || exp >= 16) {
    const mant = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
    const es = Math.abs(exp) < 10 ? "0" + Math.abs(exp) : String(Math.abs(exp));
    return `${sign}${mant}e${exp < 0 ? "-" : "+"}${es}`;
  }
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  if (digits.length <= exp + 1) return `${sign}${digits}${"0".repeat(exp + 1 - digits.length)}.0`;
  return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
}

/** Python `str()` of a value, as used in f-strings. */
export function str(x) {
  if (x === null || x === undefined) return "None";
  if (x === true) return "True";
  if (x === false) return "False";
  if (typeof x === "number") return Number.isInteger(x) && !Object.is(x, -0) && Math.abs(x) < 1e21 && !x.__float ? String(x) : String(x);
  if (typeof x === "string") return x;
  if (typeof x === "bigint") return x.toString();
  if (typeof x.__str__ === "function") return x.__str__();
  if (Array.isArray(x)) return "[" + x.map(repr).join(", ") + "]";
  return String(x);
}

/** Python `repr()` for the simple cases m2c prints. */
export function repr(x) {
  if (typeof x === "string") return pyStrRepr(x);
  if (x === null || x === undefined) return "None";
  if (x === true) return "True";
  if (x === false) return "False";
  if (typeof x === "number") return String(x);
  if (Array.isArray(x)) return "[" + x.map(repr).join(", ") + "]";
  if (x && typeof x.__repr__ === "function") return x.__repr__();
  return str(x);
}

/** Python repr of a str. */
export function pyStrRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += "\\" + q;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else if (c >= 0x80 && c < 0xa0) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + q;
}

// Round a non-negative finite float to `prec` digits after the point, as
// Python's correctly-rounded formatting does (round-half-even on the exact
// binary value). Returns the digit string (no point) and the exponent shift.
function exactDecimal(x) {
  // Exact decimal expansion of a finite double, as [digits, pointPos] where
  // value = 0.digits * 10^pointPos ... we instead return integer + scale.
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e2;
  if (expBits === 0) e2 = -1074;
  else { mant |= 1n << 52n; e2 = expBits - 1075; }
  // value = mant * 2^e2
  if (e2 >= 0) return { num: mant << BigInt(e2), scale: 0 };
  // mant * 2^e2 = mant * 5^-e2 / 10^-e2
  return { num: mant * 5n ** BigInt(-e2), scale: -e2 };
}

function roundDigits(num, scale, keepScale) {
  // num / 10^scale, rounded to keepScale decimal places, half-even. Returns BigInt of value*10^keepScale.
  if (keepScale >= scale) return num * 10n ** BigInt(keepScale - scale);
  const div = 10n ** BigInt(scale - keepScale);
  let q = num / div;
  const r = num % div;
  const twice = r * 2n;
  if (twice > div || (twice === div && q % 2n === 1n)) q += 1n;
  return q;
}

/** Python `format(x, ".Nf")` for floats. */
export function format_fixed(x, prec) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const neg = x < 0 || Object.is(x, -0);
  const { num, scale } = exactDecimal(Math.abs(x));
  const q = roundDigits(num, scale, prec);
  let s = q.toString();
  if (prec > 0) {
    s = s.padStart(prec + 1, "0");
    s = s.slice(0, s.length - prec) + "." + s.slice(s.length - prec);
  }
  return (neg ? "-" : "") + s;
}

/** Python `format(x, ".Ne")` for floats. */
export function format_exp(x, prec, upper = false) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  let digits, exp;
  if (ax === 0) { digits = "0".repeat(prec + 1); exp = 0; }
  else {
    const { num, scale } = exactDecimal(ax);
    // number of integer digits
    const intDigits = num.toString().length - scale; // exponent of leading digit + 1
    exp = intDigits - 1;
    let q = roundDigits(num, scale, prec - exp);
    if (q.toString().length > prec + 1) { exp += 1; q = roundDigits(num, scale, prec - exp); }
    digits = q.toString();
  }
  const mant = prec > 0 ? digits[0] + "." + digits.slice(1) : digits;
  const es = Math.abs(exp) < 10 ? "0" + Math.abs(exp) : String(Math.abs(exp));
  return (neg ? "-" : "") + mant + (upper ? "E" : "e") + (exp < 0 ? "-" : "+") + es;
}

/** Python `format(x, ".Ng")` for floats (no '#' flag). */
export function format_general(x, prec = 6, upper = false) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  if (prec === 0) prec = 1;
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const es = format_exp(x, prec - 1);
  const exp = parseInt(es.slice(es.indexOf("e") + 1), 10);
  let s;
  if (exp >= -4 && exp < prec) {
    s = format_fixed(x, prec - 1 - exp);
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  } else {
    let [mant, e] = es.split("e");
    if (mant.includes(".")) mant = mant.replace(/0+$/, "").replace(/\.$/, "");
    s = mant + "e" + e;
  }
  return upper ? s.toUpperCase() : s;
}

/**
 * Python `format(value, spec)` for int/float/str values and the common
 * format-spec features ([[fill]align][sign][#][0][width][,][.precision][type]).
 */
export function format(value, spec = "") {
  if (!spec) return str(value);
  const m = /^(?:(.)?([<>=^]))?([+\- ])?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/su.exec(spec);
  if (!m) throw new ValueError(`Invalid format specifier '${spec}'`);
  let [, fill, align, sign, alt, zero, width, grouping, precision, type] = m;
  const w = width ? parseInt(width, 10) : 0;
  const p = precision !== undefined ? parseInt(precision, 10) : undefined;
  if (zero && !align) { fill = "0"; align = "="; }
  fill = fill ?? " ";
  let body, prefix = "", isNum = typeof value === "number" || typeof value === "bigint";
  if (typeof value === "string") {
    body = p !== undefined ? value.slice(0, p) : value;
    align = align ?? "<";
  } else {
    let v = value;
    let neg = false;
    if (typeof v === "boolean") v = v ? 1 : 0;
    const t = type ?? (Number.isInteger(v) && !(value && value.__isFloat) ? "d" : "g_repr");
    if (["d", "x", "X", "o", "b", "c", "n"].includes(t)) {
      let n = typeof v === "bigint" ? v : BigInt(v);
      if (n < 0n) { neg = true; n = -n; }
      if (t === "x") body = n.toString(16);
      else if (t === "X") body = n.toString(16).toUpperCase();
      else if (t === "o") body = n.toString(8);
      else if (t === "b") body = n.toString(2);
      else if (t === "c") body = String.fromCodePoint(Number(n));
      else body = n.toString();
      if (alt) prefix = t === "x" ? "0x" : t === "X" ? "0X" : t === "o" ? "0o" : t === "b" ? "0b" : "";
      if (grouping) body = body.replace(/\B(?=(\d{3})+(?!\d))/g, grouping);
    } else {
      let f = Number(v);
      if (f < 0 || Object.is(f, -0)) { neg = true; f = -f; }
      if (t === "f" || t === "F") body = format_fixed(f, p ?? 6);
      else if (t === "e" || t === "E") body = format_exp(f, p ?? 6, t === "E");
      else if (t === "g" || t === "G") body = format_general(f, p ?? 6, t === "G");
      else if (t === "%") body = format_fixed(f * 100, p ?? 6) + "%";
      else body = p !== undefined ? format_general(f, p) : float_repr(f);
      if (t === "F" || t === "E" || t === "G") body = body.toUpperCase();
    }
    const signStr = neg ? "-" : sign === "+" ? "+" : sign === " " ? " " : "";
    prefix = signStr + prefix;
    align = align ?? ">";
  }
  const len = [...(prefix + body)].length;
  if (w <= len) return prefix + body;
  const pad = w - len;
  if (align === "=" && isNum) return prefix + fill.repeat(pad) + body;
  if (align === "<") return prefix + body + fill.repeat(pad);
  if (align === "^") return fill.repeat(Math.floor(pad / 2)) + prefix + body + fill.repeat(pad - Math.floor(pad / 2));
  return fill.repeat(pad) + prefix + body;
}

/** Python `"%..." % args` printf-style formatting (subset). */
export function percent(fmt, args) {
  if (!Array.isArray(args)) args = [args];
  let i = 0;
  return fmt.replace(/%([-+ #0]*)(\d+|\*)?(?:\.(\d+))?([diouxXeEfFgGcrs%])/g, (_, flags, width, prec, conv) => {
    if (conv === "%") return "%";
    let spec = "";
    if (flags.includes("-")) spec += "<";
    if (flags.includes("+")) spec += "+";
    else if (flags.includes(" ")) spec += " ";
    if (flags.includes("#")) spec += "#";
    if (flags.includes("0") && !flags.includes("-")) spec += "0";
    if (width === "*") width = String(args[i++]);
    if (width) spec += width;
    if (prec !== undefined) spec += "." + prec;
    const v = args[i++];
    if (conv === "s") return format(str(v), spec);
    if (conv === "r") return format(repr(v), spec);
    const c = conv === "i" || conv === "u" ? "d" : conv;
    return format(v, spec + c);
  });
}

// ---------------------------------------------------------------- strings

/** Python `str.isspace()`. */
export function isspace(s) {
  return s.length > 0 && /^\s+$/u.test(s);
}
/** Python `str.isdigit()` (ASCII digits). */
export function isdigit(s) {
  return s.length > 0 && /^[0-9]+$/.test(s);
}
/** Python `str.isalnum()` (ASCII). */
export function isalnum(s) {
  return s.length > 0 && /^[A-Za-z0-9]+$/.test(s);
}
/** Python `str.isidentifier()` (ASCII subset). */
export function isidentifier(s) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}
/** Python `str.split()` with no separator. */
export function split_ws(s, maxsplit = -1) {
  const out = [];
  let rest = s.replace(/^\s+/, "");
  while (rest) {
    if (maxsplit >= 0 && out.length === maxsplit) { out.push(rest); return out; }
    const m = /\s/.exec(rest);
    if (!m) { out.push(rest); break; }
    out.push(rest.slice(0, m.index));
    rest = rest.slice(m.index).replace(/^\s+/, "");
  }
  return out;
}
/** Python `str.split(sep, maxsplit)`. */
export function split(s, sep, maxsplit = -1) {
  if (sep === undefined || sep === null) return split_ws(s, maxsplit);
  const parts = s.split(sep);
  if (maxsplit < 0 || parts.length <= maxsplit + 1) return parts;
  return [...parts.slice(0, maxsplit), parts.slice(maxsplit).join(sep)];
}
/** Python `str.rsplit(sep, maxsplit)`. */
export function rsplit(s, sep, maxsplit = -1) {
  const parts = s.split(sep);
  if (maxsplit < 0 || parts.length <= maxsplit + 1) return parts;
  const keep = parts.length - maxsplit;
  return [parts.slice(0, keep).join(sep), ...parts.slice(keep)];
}
/** Python `str.partition(sep)`. */
export function partition(s, sep) {
  const i = s.indexOf(sep);
  if (i < 0) return [s, "", ""];
  return [s.slice(0, i), sep, s.slice(i + sep.length)];
}
/** Python `str.rpartition(sep)`. */
export function rpartition(s, sep) {
  const i = s.lastIndexOf(sep);
  if (i < 0) return ["", "", s];
  return [s.slice(0, i), sep, s.slice(i + sep.length)];
}
const PY_WS = " \t\n\r\x0b\x0c\x1c\x1d\x1e\x1f\x85\xa0";
function charsSet(chars) {
  return chars === undefined || chars === null ? null : new Set(chars);
}
/** Python `str.strip(chars)`. */
export function strip(s, chars) {
  return rstrip(lstrip(s, chars), chars);
}
/** Python `str.lstrip(chars)`. */
export function lstrip(s, chars) {
  const set = charsSet(chars);
  let i = 0;
  while (i < s.length && (set ? set.has(s[i]) : PY_WS.includes(s[i]) || /\s/u.test(s[i]))) i++;
  return s.slice(i);
}
/** Python `str.rstrip(chars)`. */
export function rstrip(s, chars) {
  const set = charsSet(chars);
  let i = s.length;
  while (i > 0 && (set ? set.has(s[i - 1]) : PY_WS.includes(s[i - 1]) || /\s/u.test(s[i - 1]))) i--;
  return s.slice(0, i);
}
/** Python `str.splitlines()`. */
export function splitlines(s, keepends = false) {
  const out = [];
  const re = /\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    out.push(s.slice(last, keepends ? m.index + m[0].length : m.index));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
/** Python `str.count(sub)`. */
export function count(s, sub) {
  if (!sub) return s.length + 1;
  let n = 0;
  let i = 0;
  while ((i = s.indexOf(sub, i)) >= 0) { n++; i += sub.length; }
  return n;
}
/** Python slice with negative indices, for strings and arrays. */
export function slice(x, start, end) {
  const n = x.length;
  const norm = (v, d) => (v === undefined || v === null ? d : v < 0 ? Math.max(0, n + v) : Math.min(v, n));
  return x.slice(norm(start, 0), norm(end, n));
}
/** Python `x[i]` with negative index support (throws IndexError). */
export function at(x, i) {
  const j = i < 0 ? x.length + i : i;
  if (j < 0 || j >= x.length) throw new IndexError("index out of range");
  return x[j];
}

/** Python `ljust` / `rjust`. */
export function ljust(s, w, fill = " ") {
  return s.length >= w ? s : s + fill.repeat(w - s.length);
}
export function rjust(s, w, fill = " ") {
  return s.length >= w ? s : fill.repeat(w - s.length) + s;
}

// ---------------------------------------------------------------- containers

/** Python `collections.defaultdict` over a Map. */
export class DefaultMap extends Map {
  constructor(factory, entries) {
    super(entries);
    this.factory = factory;
  }
  get(key) {
    if (!super.has(key)) {
      const v = this.factory();
      super.set(key, v);
      return v;
    }
    return super.get(key);
  }
  /** Python dict.get(key) on a defaultdict: no insertion; undefined if missing. */
  peek(key) {
    return super.get(key);
  }
}

/** Python `list.index(x)` raising ValueError. */
export function list_index(arr, x) {
  const i = arr.indexOf(x);
  if (i < 0) throw new ValueError(`${str(x)} is not in list`);
  return i;
}

/** Python `max(iterable, key=...)` (first maximal element wins). */
export function max_by(items, key) {
  let best, bestK, first = true;
  for (const it of items) {
    const k = key(it);
    if (first || compare(k, bestK) > 0) { best = it; bestK = k; first = false; }
  }
  if (first) throw new ValueError("max() arg is an empty sequence");
  return best;
}
/** Python `min(iterable, key=...)` (first minimal element wins). */
export function min_by(items, key) {
  let best, bestK, first = true;
  for (const it of items) {
    const k = key(it);
    if (first || compare(k, bestK) < 0) { best = it; bestK = k; first = false; }
  }
  if (first) throw new ValueError("min() arg is an empty sequence");
  return best;
}

/** Python rich comparison for numbers, strings, booleans, and tuples (arrays). */
export function compare(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = compare(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === "boolean") a = a ? 1 : 0;
  if (typeof b === "boolean") b = b ? 1 : 0;
  if (a && typeof a.__lt__ === "function") return a.__lt__(b) ? -1 : b.__lt__(a) ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") {
    // Python compares by code point.
    if (a === b) return 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const ca = a.codePointAt(i), cb = b.codePointAt(i);
      if (ca !== cb) return ca < cb ? -1 : 1;
    }
    return a.length - b.length;
  }
  if (a === null || a === undefined || b === null || b === undefined) throw new TypeError("'<' not supported with None");
  return a < b ? -1 : a > b ? 1 : 0;
}
/** Python `sorted(items, key=..., reverse=...)` (stable). */
export function sorted(items, key = (x) => x, reverse = false) {
  const arr = [...items].map((v, i) => [key(v), i, v]);
  arr.sort((x, y) => {
    const c = compare(x[0], y[0]);
    if (c !== 0) return reverse ? -c : c;
    return x[1] - y[1];
  });
  return arr.map((x) => x[2]);
}

/** Python `range(...)` as an array. */
export function range(a, b, step = 1) {
  if (b === undefined) { b = a; a = 0; }
  const out = [];
  if (step > 0) for (let i = a; i < b; i += step) out.push(i);
  else for (let i = a; i > b; i += step) out.push(i);
  return out;
}
/** Python `zip(a, b, ...)` as an array (truncates to the shortest). */
export function zip(...arrs) {
  const n = Math.min(...arrs.map((a) => a.length));
  const out = [];
  for (let i = 0; i < n; i++) out.push(arrs.map((a) => a[i]));
  return out;
}
/** Python `enumerate`. */
export function enumerate(arr, start = 0) {
  return [...arr].map((v, i) => [i + start, v]);
}
/** Python `any` / `all` over an iterable of values. */
export function any(it) {
  for (const x of it) if (truthy(x)) return true;
  return false;
}
export function all(it) {
  for (const x of it) if (!truthy(x)) return false;
  return true;
}

// ---------------------------------------------------------------- value interning

let internSeq = 0;
const internTables = new Map();

/**
 * Canonicalise a frozen value object: the first instance with a given class
 * and field key is returned for every later construction, so `===` and Map
 * keys behave like Python's dataclass __eq__/__hash__.
 * Call from a constructor as `return intern(this, [fields...])`.
 */
export function intern(obj, parts) {
  const cls = obj.constructor;
  let table = internTables.get(cls);
  if (!table) internTables.set(cls, (table = new Map()));
  const key = parts.map(internKeyPart).join("\u0001");
  const hit = table.get(key);
  if (hit) return hit;
  Object.defineProperty(obj, "__iid", { value: ++internSeq, enumerable: false });
  table.set(key, obj);
  return obj;
}
function internKeyPart(p) {
  if (p === null || p === undefined) return "N";
  switch (typeof p) {
    case "number": return Object.is(p, -0) ? "n-0" : "n" + p;
    case "string": return "s" + p;
    case "boolean": return p ? "T" : "F";
    case "bigint": return "b" + p;
    default:
      if (Array.isArray(p)) return "[" + p.map(internKeyPart).join(",") + "]";
      if (p.__iid !== undefined) return "#" + p.__iid;
      if (p.__enum_key !== undefined) return "E" + p.__enum_key;
      throw new TypeError("intern: unhashable field " + p?.constructor?.name);
  }
}

/** Deep copy of plain data / class instances (Python copy.deepcopy). */
export function deepcopy(x, memo = new Map()) {
  if (x === null || typeof x !== "object") return x;
  if (memo.has(x)) return memo.get(x);
  if (x.__iid !== undefined) return x; // interned immutables
  if (Array.isArray(x)) {
    const out = [];
    memo.set(x, out);
    for (const v of x) out.push(deepcopy(v, memo));
    return out;
  }
  if (x instanceof Map) {
    const out = new (x.constructor)();
    if (x.factory) out.factory = x.factory;
    memo.set(x, out);
    for (const [k, v] of x) out.set(deepcopy(k, memo), deepcopy(v, memo));
    return out;
  }
  if (x instanceof Set) {
    const out = new Set();
    memo.set(x, out);
    for (const v of x) out.add(deepcopy(v, memo));
    return out;
  }
  const out = Object.create(Object.getPrototypeOf(x));
  memo.set(x, out);
  for (const k of Object.keys(x)) out[k] = deepcopy(x[k], memo);
  return out;
}

/** Shallow copy of a class instance (Python copy.copy / dataclasses.replace base). */
export function shallowcopy(x) {
  const out = Object.create(Object.getPrototypeOf(x));
  Object.assign(out, x);
  return out;
}

// ---------------------------------------------------------------- Python equality / hashing

const objIds = new WeakMap();
let nextObjId = 0;
/** Stable identity number for an object (Python id()). */
export function objId(o) {
  let id = objIds.get(o);
  if (id === undefined) {
    id = ++nextObjId;
    objIds.set(o, id);
  }
  return id;
}

/**
 * A string key that is equal for two values iff Python's `==` holds (and
 * therefore their hashes agree). Classes opt into structural (dataclass
 * eq=True) equality with a static `__eq_fields` array naming the compared
 * fields, or a custom `__pykey()` method; interned values compare by
 * identity-of-canonical-instance; everything else is identity.
 */
export function pykey(x) {
  if (x === null || x === undefined) return "N";
  switch (typeof x) {
    case "number":
      return "n" + (Object.is(x, -0) ? 0 : x);
    case "boolean":
      return x ? "n1" : "n0";
    case "string":
      return "s" + x.length + ":" + x;
    case "bigint":
      return "n" + x;
    case "function":
      return "@" + objId(x);
  }
  if (Array.isArray(x)) return "(" + x.map(pykey).join(",") + ")";
  if (x.__iid !== undefined) return "#" + x.__iid;
  if (typeof x.__pykey === "function") return x.__pykey();
  const ctor = x.constructor;
  if (ctor && Object.prototype.hasOwnProperty.call(ctor, "__eq_fields")) {
    return ctor.name + "{" + ctor.__eq_fields.map((k) => pykey(x[k])).join(",") + "}";
  }
  return "@" + objId(x);
}

/** Python `a == b`. */
export function pyeq(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return a == b;
  if (typeof a !== "object" || typeof b !== "object") return a === b || (typeof a === typeof b ? false : pykey(a) === pykey(b));
  if (typeof a.equals === "function") return a.equals(b);
  return pykey(a) === pykey(b);
}

/** Python `x in arr` for a list, with Python equality. */
export function pyin(x, arr) {
  for (const y of arr) if (pyeq(x, y)) return true;
  return false;
}

/** dict with Python key semantics (see pykey). Map-like API; iteration yields [key, value]. */
export class PyDict {
  constructor(entries) {
    this._m = new Map();
    if (entries) for (const [k, v] of entries) this.set(k, v);
  }
  get size() {
    return this._m.size;
  }
  has(k) {
    return this._m.has(pykey(k));
  }
  get(k) {
    const e = this._m.get(pykey(k));
    return e === undefined ? undefined : e[1];
  }
  set(k, v) {
    const key = pykey(k);
    const e = this._m.get(key);
    if (e) e[1] = v;
    else this._m.set(key, [k, v]);
    return this;
  }
  delete(k) {
    return this._m.delete(pykey(k));
  }
  clear() {
    this._m.clear();
  }
  *keys() {
    for (const e of this._m.values()) yield e[0];
  }
  *values() {
    for (const e of this._m.values()) yield e[1];
  }
  *entries() {
    for (const e of this._m.values()) yield [e[0], e[1]];
  }
  [Symbol.iterator]() {
    return this.entries();
  }
}

/** defaultdict with Python key semantics. */
export class DefaultPyDict extends PyDict {
  constructor(factory, entries) {
    super(entries);
    this.factory = factory;
  }
  get(k) {
    const key = pykey(k);
    const e = this._m.get(key);
    if (e) return e[1];
    const v = this.factory();
    this._m.set(key, [k, v]);
    return v;
  }
  peek(k) {
    return super.get(k);
  }
}

/** set with Python element semantics (see pykey). Iteration yields elements in insertion order. */
export class PySet {
  constructor(items) {
    this._m = new Map();
    if (items) for (const x of items) this.add(x);
  }
  get size() {
    return this._m.size;
  }
  has(x) {
    return this._m.has(pykey(x));
  }
  add(x) {
    const key = pykey(x);
    if (!this._m.has(key)) this._m.set(key, x);
    return this;
  }
  delete(x) {
    return this._m.delete(pykey(x));
  }
  clear() {
    this._m.clear();
  }
  values() {
    return this._m.values();
  }
  [Symbol.iterator]() {
    return this._m.values();
  }
}

// ---------------------------------------------------------------- dataclasses

/** Default-value marker for a dataclass field built by a factory (field(default_factory=...)). */
export function factory(fn) {
  return { __factory: fn };
}

function isKw(x) {
  return x !== null && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype;
}

/**
 * Python dataclass __init__: `static __fields = [[name], [name, default], [name, factory(fn)]]`
 * on the class; constructors call `dcinit(this, args)` with their rest args.
 * Accepts positional args in field order, optionally followed by (or replaced by)
 * a plain object of keyword args.
 */
export function dcinit(self, args) {
  const fields = self.constructor.__fields;
  let kw = null;
  if (args.length && isKw(args[args.length - 1])) {
    kw = args[args.length - 1];
    args = args.slice(0, -1);
  }
  if (args.length > fields.length) throw new TypeError(`${self.constructor.name}: too many positional arguments`);
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const name = f[0];
    let v;
    if (i < args.length) v = args[i];
    else if (kw && Object.prototype.hasOwnProperty.call(kw, name)) v = kw[name];
    else if (f.length < 2) throw new TypeError(`${self.constructor.name}: missing required argument '${name}'`);
    else v = f[1] !== null && typeof f[1] === "object" && f[1].__factory ? f[1].__factory() : f[1];
    self[name] = v === undefined ? null : v;
  }
  if (kw) for (const k of Object.keys(kw)) if (!fields.some((f) => f[0] === k)) throw new TypeError(`${self.constructor.name}: unexpected keyword argument '${k}'`);
}

/** dataclasses.replace(obj, **changes) */
export function dcreplace(obj, changes) {
  const kw = {};
  for (const f of obj.constructor.__fields) kw[f[0]] = obj[f[0]];
  Object.assign(kw, changes);
  return new obj.constructor(kw);
}

/** Object.hasOwn for plain-object dicts (Python `key in dict`). */
export function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Python round() (round-half-even) for floats to int. */
export function pyround(x) {
  const r = Math.round(x);
  if (Math.abs(x % 1) === 0.5) return 2 * Math.round(x / 2);
  return r;
}

/** Python int.bit_length() */
export function bit_length(n) {
  if (n < 0) n = -n;
  if (n === 0) return 0;
  if (n < 2 ** 31) return 32 - Math.clz32(n);
  return BigInt(n).toString(2).length;
}
