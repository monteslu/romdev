// toml.js - a TOML 1.0 reader for project configuration files. Tables,
// arrays of tables, inline tables, dotted and quoted keys, every string form,
// integers in all four bases, floats, booleans and date-times. Errors carry
// the position the way the standard reader reports it: "<message> (at line
// L, column C)". Integers beyond 2^53 are BigInt; date-times are returned as
// their text in a TomlDateTime wrapper.
//
// Plain JS ESM + JSDoc.

export class TOMLDecodeError extends Error {
  constructor(msg, src, pos) {
    let line = 1, col = 1;
    for (let i = 0; i < pos && i < src.length; i++) { if (src[i] === "\n") { line++; col = 1; } else col++; }
    super(pos >= src.length ? `${msg} (at end of document)` : `${msg} (at line ${line}, column ${col})`);
    this.name = "TOMLDecodeError";
    Object.assign(this, { msg, pos, lineno: line, colno: col });
  }
}

export class TomlDateTime {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
  toJSON() { return this.text; }
}

const BARE_KEY = /[A-Za-z0-9_-]/;
const WS = " \t";
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})(?:[Tt ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|z|[+-]\d{2}:\d{2})?)?|^(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/;
const ILLEGAL = (c) => { const x = c.charCodeAt(0); return (x < 0x20 && c !== "\t") || x === 0x7f; };

/** Parse a TOML document into plain objects (arrays of tables are arrays). */
export function parseToml(src) {
  src = src.replace(/^\ufeff/, "");
  let i = 0;
  const root = {};
  const defined = new Set();      // explicitly defined tables ([x])
  const frozen = new Set();       // inline tables and static arrays: may not be extended
  const aotArrays = new Set();
  let current = root;
  const err = (m, at = i) => { throw new TOMLDecodeError(m, src, at); };
  const skipWs = () => { while (i < src.length && WS.includes(src[i])) i++; };
  const skipComment = () => {
    if (src[i] === "#") {
      i++;
      while (i < src.length && src[i] !== "\n") {
        if (ILLEGAL(src[i]) && src[i] !== "\r") err(`Illegal character ${JSON.stringify(src[i])}`);
        i++;
      }
    }
  };
  const expectLineEnd = () => {
    skipWs(); skipComment();
    if (i >= src.length) return;
    if (src[i] === "\r" && src[i + 1] === "\n") { i += 2; return; }
    if (src[i] === "\n") { i++; return; }
    err("Expected newline or end of document after a statement");
  };
  const parseKeyPart = () => {
    if (src[i] === '"') return parseBasicString(false);
    if (src[i] === "'") return parseLiteralString(false);
    const start = i;
    while (i < src.length && BARE_KEY.test(src[i])) i++;
    if (i === start) err("Invalid initial character for a key part");
    return src.slice(start, i);
  };
  const parseKey = () => {
    const parts = [parseKeyPart()];
    skipWs();
    while (src[i] === ".") { i++; skipWs(); parts.push(parseKeyPart()); skipWs(); }
    return parts;
  };
  const hexEsc = (n) => {
    const h = src.slice(i, i + n);
    if (!new RegExp(`^[0-9A-Fa-f]{${n}}$`).test(h)) err("Invalid hex value");
    const cp = parseInt(h, 16);
    if ((cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) err("Escaped character is not a Unicode scalar value");
    i += n;
    return String.fromCodePoint(cp);
  };
  function parseBasicString(allowMulti = true) {
    const multi = allowMulti && src.startsWith('"""', i);
    i += multi ? 3 : 1;
    if (multi && src[i] === "\n") i++; else if (multi && src.startsWith("\r\n", i)) i += 2;
    let out = "";
    for (;;) {
      if (i >= src.length) err("Unterminated string");
      const c = src[i];
      if (!multi && c === "\n") err("Unterminated string");
      if (multi && src.startsWith('"""', i)) {
        let q = 3; while (src[i + q] === '"' && q < 5) q++;
        out += '"'.repeat(q - 3); i += q; return out;
      }
      if (!multi && c === '"') { i++; return out; }
      if (c === "\\") {
        i++;
        const e = src[i];
        if (multi && (e === "\n" || e === " " || e === "\t" || e === "\r")) {
          let j = i; while (WS.includes(src[j])) j++;
          if (src[j] === "\n" || src.startsWith("\r\n", j)) { i = j; while (i < src.length && (WS.includes(src[i]) || src[i] === "\n" || src[i] === "\r")) i++; continue; }
          err('Unescaped "\\" in a string');
        }
        i++;
        const map = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
        if (e in map) out += map[e];
        else if (e === "u") out += hexEsc(4);
        else if (e === "U") out += hexEsc(8);
        else err('Unescaped "\\" in a string', i - 2);
        continue;
      }
      if (ILLEGAL(c) && !(multi && (c === "\n" || (c === "\r" && src[i + 1] === "\n")))) err(`Illegal character ${JSON.stringify(c)}`);
      out += c; i++;
    }
  }
  function parseLiteralString(allowMulti = true) {
    const multi = allowMulti && src.startsWith("'''", i);
    i += multi ? 3 : 1;
    if (multi && src[i] === "\n") i++; else if (multi && src.startsWith("\r\n", i)) i += 2;
    const start = i;
    for (;;) {
      if (i >= src.length) err("Unterminated string");
      const c = src[i];
      if (!multi && c === "\n") err("Unterminated string");
      if (multi && src.startsWith("'''", i)) {
        let q = 3; while (src[i + q] === "'" && q < 5) q++;
        const s = src.slice(start, i) + "'".repeat(q - 3); i += q; return s;
      }
      if (!multi && c === "'") { const s = src.slice(start, i); i++; return s; }
      if (ILLEGAL(c) && !(multi && (c === "\n" || (c === "\r" && src[i + 1] === "\n")))) err(`Illegal character ${JSON.stringify(c)}`);
      i++;
    }
  }
  const skipArrayWs = () => {
    for (;;) {
      skipWs(); skipComment();
      if (src[i] === "\n") { i++; continue; }
      if (src.startsWith("\r\n", i)) { i += 2; continue; }
      return;
    }
  };
  function parseValue() {
    const c = src[i];
    if (c === '"') return parseBasicString();
    if (c === "'") return parseLiteralString();
    if (c === "[") {
      i++;
      const arr = [];
      for (;;) {
        skipArrayWs();
        if (src[i] === "]") { i++; frozen.add(arr); return arr; }
        arr.push(parseValue());
        skipArrayWs();
        if (src[i] === ",") { i++; continue; }
        if (src[i] === "]") { i++; frozen.add(arr); return arr; }
        err("Unclosed array");
      }
    }
    if (c === "{") {
      i++;
      const tbl = {};
      const local = new Set();
      skipWs();
      if (src[i] === "}") { i++; frozen.add(tbl); return tbl; }
      for (;;) {
        skipWs();
        const at = i;
        const key = parseKey();
        if (src[i] !== "=") err("Expected '=' after a key in a key/value pair");
        i++; skipWs();
        let t = tbl;
        for (const part of key.slice(0, -1)) {
          if (!(part in t)) { t[part] = {}; local.add(t[part]); }
          else if (!local.has(t[part])) err("Cannot overwrite a value", at);
          t = t[part];
        }
        const last = key.at(-1);
        if (Object.prototype.hasOwnProperty.call(t, last)) err("Cannot overwrite a value", at);
        t[last] = parseValue();
        skipWs();
        if (src[i] === ",") { i++; continue; }
        if (src[i] === "}") { i++; frozen.add(tbl); for (const x of local) frozen.add(x); return tbl; }
        err("Unclosed inline table");
      }
    }
    const rest = src.slice(i);
    let m;
    if ((m = /^(true|false)(?![A-Za-z0-9_-])/.exec(rest))) { i += m[1].length; return m[1] === "true"; }
    if ((m = DATETIME_RE.exec(rest)) && (m[1] || m[4])) {
      const text = m[0];
      i += text.length;
      return new TomlDateTime(text);
    }
    if ((m = /^[+-]?(inf|nan)(?![A-Za-z0-9_])/.exec(rest))) {
      i += m[0].length;
      return m[1] === "nan" ? NaN : m[0].startsWith("-") ? -Infinity : Infinity;
    }
    if ((m = /^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|^0o[0-7](?:_?[0-7])*|^0b[01](?:_?[01])*/.exec(rest))) {
      i += m[0].length;
      return intOut(BigInt(m[0].replace(/_/g, "")));
    }
    if ((m = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/.exec(rest)) && m[0] && /\d/.test(m[0])) {
      const text = m[0];
      const next = src[i + text.length];
      if (next !== undefined && /[A-Za-z0-9_.:]/.test(next)) err("Invalid value");
      i += text.length;
      const clean = text.replace(/_/g, "");
      if (/[.eE]/.test(clean)) return Number(clean);
      return intOut(BigInt(clean));
    }
    err("Invalid value");
  }
  const intOut = (b) => (b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b);
  const isTable = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof TomlDateTime);
  const openTable = (keys, at, { array = false } = {}) => {
    let t = root;
    for (const [n, part] of keys.entries()) {
      const lastPart = n === keys.length - 1;
      if (lastPart && array) {
        if (!(part in t)) { t[part] = []; aotArrays.add(t[part]); }
        const arr = t[part];
        if (!Array.isArray(arr) || !aotArrays.has(arr)) err("Cannot overwrite a value", at);
        const tbl = {}; arr.push(tbl); return tbl;
      }
      if (!(part in t)) t[part] = {};
      let v = t[part];
      if (Array.isArray(v)) { if (!aotArrays.has(v)) err("Cannot overwrite a value", at); v = v.at(-1); }
      if (!isTable(v) || frozen.has(v)) err("Cannot overwrite a value", at);
      if (lastPart) {
        if (defined.has(v)) err("Cannot declare a table twice", at);
        defined.add(v);
      }
      t = v;
    }
    return t;
  };
  const dottedDefined = new Set();
  while (i < src.length) {
    skipWs();
    if (src[i] === "\n") { i++; continue; }
    if (src.startsWith("\r\n", i)) { i += 2; continue; }
    if (src[i] === "#") { skipComment(); continue; }
    if (i >= src.length) break;
    const at = i;
    if (src[i] === "[") {
      const array = src[i + 1] === "[";
      i += array ? 2 : 1;
      skipWs();
      const key = parseKey();
      if (array) { if (!src.startsWith("]]", i)) err("Expected ']]' at the end of an array declaration"); i += 2; }
      else { if (src[i] !== "]") err("Expected ']' at the end of a table declaration"); i++; }
      for (const d of dottedDefined) if (d === key.join("\u0000")) err("Cannot declare a table twice", at);
      current = openTable(key, at, { array });
      expectLineEnd();
      continue;
    }
    const key = parseKey();
    if (src[i] !== "=") err("Expected '=' after a key in a key/value pair");
    i++; skipWs();
    let t = current;
    for (const part of key.slice(0, -1)) {
      if (!(part in t)) { t[part] = {}; }
      else if (!isTable(t[part]) || frozen.has(t[part]) || defined.has(t[part])) err("Cannot overwrite a value", at);
      t = t[part];
    }
    const last = key.at(-1);
    if (Object.prototype.hasOwnProperty.call(t, last)) err("Cannot overwrite a value", at);
    if (i >= src.length || src[i] === "\n" || src[i] === "#") err("Invalid value");
    t[last] = parseValue();
    if (key.length > 1) dottedDefined.add(key.slice(0, -1).join("\u0000"));
    expectLineEnd();
  }
  return root;
}
