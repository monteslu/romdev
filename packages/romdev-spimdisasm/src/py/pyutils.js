// SPDX-License-Identifier: MIT
// Small Python-compatibility helpers used by the spimdisasm port.

/** Python-style enum. Members are unique frozen objects with .name/.value. */
export function createEnum(enumName, entries, memberMethods = {}, staticMethods = {}) {
  const proto = Object.create(null);
  Object.assign(proto, memberMethods);
  proto.toString = function () {
    return `${enumName}.${this.name}`;
  };
  proto[Symbol.toPrimitive] = function (hint) {
    if (hint === "number") return typeof this.value === "number" ? this.value : NaN;
    return `${enumName}.${this.name}`;
  };
  const e = {};
  const members = [];
  for (const [name, value] of entries) {
    const m = Object.create(proto);
    Object.defineProperty(m, "name", { value: name, enumerable: true });
    Object.defineProperty(m, "value", { value, enumerable: true, writable: false });
    Object.defineProperty(m, "__enumName", { value: enumName });
    Object.freeze(m);
    e[name] = m;
    members.push(m);
  }
  Object.defineProperty(e, "__name", { value: enumName });
  Object.defineProperty(e, "members", { value: Object.freeze(members) });
  Object.defineProperty(e, Symbol.iterator, { value: function* () { yield* members; } });
  Object.defineProperty(e, "fromValueOrNull", {
    value: (v) => {
      for (const m of members) if (m.value === v) return m;
      return null;
    },
  });
  for (const [k, fn] of Object.entries(staticMethods)) {
    Object.defineProperty(e, k, { value: fn });
  }
  return Object.freeze(e);
}

/** Python `str()` of a scalar/enum/None/bool. */
export function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object" && v.__enumName !== undefined) return `${v.__enumName}.${v.name}`;
  return String(v);
}

/** f"{n:0{width}X}" (Python semantics, incl. negative numbers and bigint). */
export function hexU(n, width = 0) {
  let neg = false;
  let s;
  if (typeof n === "bigint") {
    if (n < 0n) { neg = true; n = -n; }
    s = n.toString(16).toUpperCase();
  } else {
    if (n < 0) { neg = true; n = -n; }
    s = n.toString(16).toUpperCase();
  }
  const sign = neg ? "-" : "";
  const padTo = width - sign.length;
  if (s.length < padTo) s = "0".repeat(padTo - s.length) + s;
  return sign + s;
}

/** f"{n:0{width}x}" lowercase. */
export function hexL(n, width = 0) {
  return hexU(n, width).toLowerCase();
}

/** Python floor division for numbers. */
export function floordiv(a, b) {
  return Math.floor(a / b);
}

/** Python modulo (sign of divisor). */
export function pymod(a, b) {
  const r = a % b;
  return r !== 0 && (r < 0) !== (b < 0) ? r + b : r;
}

// Unicode whitespace per Python str.isspace() (bidirectional type WS/B/S or category Zs).
const PY_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

export function isPySpaceChar(ch) {
  return PY_SPACE.has(ch.codePointAt(0));
}

export function anyPySpace(s) {
  for (const ch of s) if (PY_SPACE.has(ch.codePointAt(0))) return true;
  return false;
}

/** Python str.split() with no arguments. */
export function splitWs(s) {
  const out = [];
  let cur = "";
  let inWord = false;
  for (const ch of s) {
    if (PY_SPACE.has(ch.codePointAt(0))) {
      if (inWord) { out.push(cur); cur = ""; inWord = false; }
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

/** Python str.strip() with no arguments. */
export function pyStrip(s) {
  const chars = Array.from(s);
  let a = 0;
  let b = chars.length;
  while (a < b && PY_SPACE.has(chars[a].codePointAt(0))) a++;
  while (b > a && PY_SPACE.has(chars[b - 1].codePointAt(0))) b--;
  return chars.slice(a, b).join("");
}

/** Python str.strip(chars). */
export function pyStripChars(s, chars) {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

/**
 * Python int(s, base) for base 0 or 16/10. Throws ValueError-like Error on failure.
 * Returns a Number (safe for the 32/48-bit values spimdisasm deals with).
 */
export class ValueError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "ValueError";
  }
}

export function pyInt(str, base = 10) {
  if (typeof str !== "string") throw new TypeError("pyInt expects a string");
  let s = pyStrip(str);
  let sign = 1;
  if (s.startsWith("+")) s = s.slice(1);
  else if (s.startsWith("-")) { sign = -1; s = s.slice(1); }
  let b = base;
  const lower = s.toLowerCase();
  if (base === 0) {
    if (lower.startsWith("0x")) { b = 16; s = s.slice(2); }
    else if (lower.startsWith("0o")) { b = 8; s = s.slice(2); }
    else if (lower.startsWith("0b")) { b = 2; s = s.slice(2); }
    else {
      b = 10;
      // base 0 disallows leading zeros in non-zero decimal numbers
      if (/^0+[1-9]/.test(s.replace(/_/g, ""))) throw new ValueError(`invalid literal for int() with base 0: '${str}'`);
    }
    if (s.startsWith("_")) s = s.slice(1);
  } else if (base === 16 && lower.startsWith("0x")) {
    s = s.slice(2);
    if (s.startsWith("_")) s = s.slice(1);
  } else if (base === 8 && lower.startsWith("0o")) {
    s = s.slice(2);
  } else if (base === 2 && lower.startsWith("0b")) {
    s = s.slice(2);
  }
  if (s.length === 0 || s.startsWith("_") || s.endsWith("_") || s.includes("__")) {
    throw new ValueError(`invalid literal for int() with base ${base}: '${str}'`);
  }
  s = s.replace(/_/g, "");
  const digits = "0123456789abcdefghijklmnopqrstuvwxyz".slice(0, b);
  let v = 0n;
  const bb = BigInt(b);
  for (const ch of s.toLowerCase()) {
    const d = digits.indexOf(ch);
    if (d < 0) throw new ValueError(`invalid literal for int() with base ${base}: '${str}'`);
    v = v * bb + BigInt(d);
  }
  if (sign < 0) v = -v;
  if (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(v);
  return v;
}

/** Stable sort by key (Python sorted is stable). Returns a new array. */
export function sortedBy(arr, keyFn) {
  const tmp = arr.map((x, i) => [keyFn(x), i, x]);
  tmp.sort((a, b) => {
    const c = pyCompare(a[0], b[0]);
    return c !== 0 ? c : a[1] - b[1];
  });
  return tmp.map((t) => t[2]);
}

/** Python ordering compare for numbers/strings/bigints/arrays (tuples). */
export function pyCompare(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = pyCompare(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === "string" && typeof b === "string") {
    // Python compares by code point
    const aa = Array.from(a, (c) => c.codePointAt(0));
    const bb = Array.from(b, (c) => c.codePointAt(0));
    return pyCompare(aa, bb);
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** sorted(set_of_ints) */
export function sortedNumbers(iterable) {
  return Array.from(iterable).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Resolve Python negative index for `del list[i]` / `list[i]`. */
export function pyIndex(len, i) {
  if (i < 0) i += len;
  if (i < 0 || i >= len) throw new RangeError("list index out of range");
  return i;
}

/** Map.get with default */
export function mapGet(m, k, dflt = null) {
  return m.has(k) ? m.get(k) : dflt;
}

/** Enum-ish equality for rabbitizer enums (which may or may not be singletons). */
export function enumValue(x) {
  if (x === null || x === undefined) return x;
  if (typeof x === "object" && "value" in x) return x.value;
  return x;
}

export function sameEnum(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === "object" && typeof b === "object") {
    if (a.value !== b.value) return false;
    const ta = a.enumType ?? a.__enumName;
    const tb = b.enumType ?? b.__enumName;
    if (ta !== undefined && tb !== undefined) return ta === tb;
    return a.name === b.name;
  }
  return false;
}
