// Streaming WebAssembly text (WAT) -> binary assembler.
//
// Built for whole-ROM recompiles whose module text is far too large to hold as
// one string (SNES/GBA modules are 1-2GB of text). The input is an iterable or
// async iterable of text chunks of ANY granularity. A splitter finds each
// top-level module field `( ... )` as the chunks arrive; each field is then
// tokenised and encoded on its own, so peak memory is the largest single field
// (one function shard, typically well under a few MB) plus the encoded code.
//
// Encoded function bodies are spilled to a temp file next to the output (or
// kept in memory when no outputPath is given). References to things declared
// LATER in the text (a call to a function further down) are recorded as
// relocations and patched in the final write, which is when every index is
// known. Each reloc is written as a minimal LEB128, so the output is the same
// shape a one-pass assembler would give.
//
// Supported text: the WebAssembly 2.0 core text format for everything a
// recompiler emits. Folded and flat instructions, block/loop/if with labels
// (folded `(then)`/`(else)` and flat `else`/`end` with optional repeated
// labels), br_table, all MVP numeric/memory ops with offset=/align=, sign
// extension, saturating truncation, bulk memory (memory.copy/fill/init,
// data.drop), reference types basics (ref.null/ref.func/ref.is_null,
// table.get/set/size/grow/fill/copy/init, elem.drop), multi-value block types,
// return_call(_indirect), types, imports, exports (inline and standalone),
// globals, tables, elem segments (active/passive/declarative, legacy form),
// data segments (active/passive, string escapes), start, and numeric literals
// in every form (hex, underscores, signs, hex floats, inf/nan payloads). SIMD
// is not supported and is refused by name.
//
// Plain JS ESM + JSDoc, no dependencies.

import { openSync, writeSync, readSync, closeSync, unlinkSync } from "node:fs";

// ---------------------------------------------------------------------------
// Growable byte writer with relocations

/** Growable byte buffer. `relPos`/`relSym` record symbolic index references. */
class W {
  constructor(cap = 4096) {
    this.b = new Uint8Array(cap);
    this.n = 0;
    /** @type {number[]} */ this.relPos = [];
    /** @type {number[]} */ this.relSym = [];
  }
  reset() { this.n = 0; this.relPos.length = 0; this.relSym.length = 0; }
  ensure(k) {
    if (this.n + k <= this.b.length) return;
    let c = this.b.length * 2;
    while (c < this.n + k) c *= 2;
    const nb = new Uint8Array(c);
    nb.set(this.b.subarray(0, this.n));
    this.b = nb;
  }
  u8(x) { if (this.n >= this.b.length) this.ensure(1); this.b[this.n++] = x; }
  u32(x) {
    this.ensure(5);
    x >>>= 0;
    do {
      let byte = x & 0x7f;
      x >>>= 7;
      if (x !== 0) byte |= 0x80;
      this.b[this.n++] = byte;
    } while (x !== 0);
  }
  s32(x) {
    this.ensure(5);
    x |= 0;
    for (;;) {
      const byte = x & 0x7f;
      x >>= 7;
      if ((x === 0 && (byte & 0x40) === 0) || (x === -1 && (byte & 0x40) !== 0)) { this.b[this.n++] = byte; return; }
      this.b[this.n++] = byte | 0x80;
    }
  }
  s64(v) {
    this.ensure(10);
    v = BigInt.asIntN(64, v);
    for (;;) {
      const byte = Number(v & 0x7fn);
      v >>= 7n;
      if ((v === 0n && (byte & 0x40) === 0) || (v === -1n && (byte & 0x40) !== 0)) { this.b[this.n++] = byte; return; }
      this.b[this.n++] = byte | 0x80;
    }
  }
  bytes(u8) { this.ensure(u8.length); this.b.set(u8, this.n); this.n += u8.length; }
  name(s) { const u = Buffer.from(s, "utf8"); this.u32(u.length); this.bytes(u); }
  /** Record a symbolic index to be written (as LEB) at the current position. */
  reloc(sym) { this.relPos.push(this.n); this.relSym.push(sym); }
  view() { return this.b.subarray(0, this.n); }
}

function lebLenU(x) { x >>>= 0; let n = 1; while (x >= 0x80) { x >>>= 7; n++; } return n; }
function lebLenS(x) {
  x |= 0; let n = 1;
  for (;;) { const byte = x & 0x7f; x >>= 7; if ((x === 0 && (byte & 0x40) === 0) || (x === -1 && (byte & 0x40) !== 0)) return n; n++; }
}
function encU(x) { const w = new W(8); w.u32(x); return w.view(); }

// ---------------------------------------------------------------------------
// Top-level field splitter (streaming)

const S_NORMAL = 0, S_STRING = 1, S_STRESC = 2, S_LINECOMMENT = 3, S_BLOCKCOMMENT = 4, S_HEADKW = 5;

/**
 * Splits streamed module text into top-level field strings. Understands
 * strings, `;;` line comments and nested `(; ;)` block comments, all of which
 * may straddle chunk boundaries.
 */
class FieldSplitter {
  constructor(onField) {
    this.onField = onField;
    this.state = S_NORMAL;
    this.depth = 0;
    this.base = -1;          // depth of module fields: 1 inside (module ...), 0 for a bare field list
    this.pendParen = false;  // saw '(' as last char, undecided (could open a block comment)
    this.pendSemi = false;   // NORMAL: saw ';' (may start ';;'); BLOCKCOMMENT: may close ';)'
    this.pendBParen = false; // BLOCKCOMMENT: saw '(' (may nest '(;')
    this.bdepth = 0;
    this.inField = false;
    /** @type {string[]} */ this.pieces = [];
    this.headKw = "";
    this.moduleClosed = false;
  }

  /** @param {string} s */
  feed(s) {
    const n = s.length;
    let start = this.inField ? 0 : -1; // start of current field text within s
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      switch (this.state) {
        case S_NORMAL: {
          if (this.pendParen) {
            this.pendParen = false;
            if (c === 59) { // '(;'
              this.state = S_BLOCKCOMMENT; this.bdepth = 1;
              continue;
            }
            // Commit the paren.
            if (this.base < 0) {
              // Very first form: decide module wrapper vs bare field list.
              this.state = S_HEADKW; this.headKw = "";
              i--; continue;
            }
            this.depth++;
            if (this.depth === this.base + 1 && !this.inField) {
              this.inField = true;
              if (i === 0) { this.pieces.push("("); start = 0; }
              else start = i - 1;
            }
          }
          if (this.pendSemi) {
            this.pendSemi = false;
            if (c === 59) { this.state = S_LINECOMMENT; continue; }
          }
          if (c === 40) { this.pendParen = true; continue; }
          if (c === 41) {
            if (this.depth === 0) throw new Error("WAT: unbalanced ')'");
            this.depth--;
            if (this.inField && this.depth === this.base) {
              const text = this.pieces.length ? this.pieces.join("") + s.slice(start, i + 1) : s.slice(start, i + 1);
              this.pieces.length = 0;
              this.inField = false; start = -1;
              this.onField(text);
            } else if (this.depth === 0 && this.base === 1) {
              this.moduleClosed = true;
            }
            continue;
          }
          if (c === 34) { this.state = S_STRING; continue; }
          if (c === 59) { this.pendSemi = true; continue; }
          if (!this.inField && this.depth === 0 && c > 32 && this.base >= 0 && this.moduleClosed) {
            throw new Error("WAT: text after the end of (module ...)");
          }
          continue;
        }
        case S_STRING:
          if (c === 92) this.state = S_STRESC;
          else if (c === 34) this.state = S_NORMAL;
          continue;
        case S_STRESC:
          this.state = S_STRING;
          continue;
        case S_LINECOMMENT:
          if (c === 10) this.state = S_NORMAL;
          continue;
        case S_BLOCKCOMMENT:
          if (this.pendSemi) { this.pendSemi = false; if (c === 41) { if (--this.bdepth === 0) this.state = S_NORMAL; continue; } }
          if (this.pendBParen) { this.pendBParen = false; if (c === 59) { this.bdepth++; continue; } }
          if (c === 59) this.pendSemi = true;
          else if (c === 40) this.pendBParen = true;
          continue;
        case S_HEADKW: {
          const delim = c <= 32 || c === 40 || c === 41 || c === 34 || c === 59;
          if (!delim) { this.headKw += s[i]; continue; }
          if (this.headKw === "") { if (c <= 32) continue; throw new Error("WAT: expected a keyword after the first '('"); }
          this.state = S_NORMAL;
          if (this.headKw === "module") {
            this.base = 1; this.depth = 1;
          } else {
            // Bare field list: this form is itself a field.
            this.base = 0; this.depth = 1; this.inField = true;
            this.pieces.push("(" + this.headKw);
            start = i;
          }
          i--; // reprocess the delimiter in NORMAL
          continue;
        }
      }
    }
    if (this.inField && start >= 0 && start < n) this.pieces.push(s.slice(start));
  }

  end() {
    if (this.state === S_STRING || this.state === S_STRESC) throw new Error("WAT: unterminated string at end of input");
    if (this.state === S_BLOCKCOMMENT) throw new Error("WAT: unterminated block comment at end of input");
    if (this.pendParen || this.inField || this.depth !== 0) throw new Error("WAT: unexpected end of input (unbalanced parentheses)");
    if (this.base < 0) throw new Error("WAT: empty input");
  }
}

// ---------------------------------------------------------------------------
// Tokeniser (one field at a time)

const T_LP = 1, T_RP = 2, T_ATOM = 3, T_STR = 4;

/**
 * @param {string} src
 * @returns {{k: number[], v: any[]}}
 */
function tokenize(src) {
  const k = []; const v = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c <= 32) { i++; continue; }
    if (c === 40) {
      if (src.charCodeAt(i + 1) === 59) { i = skipBlockComment(src, i); continue; }
      k.push(T_LP); v.push(null); i++; continue;
    }
    if (c === 41) { k.push(T_RP); v.push(null); i++; continue; }
    if (c === 59) {
      if (src.charCodeAt(i + 1) === 59) { const e = src.indexOf("\n", i); i = e < 0 ? n : e + 1; continue; }
      throw new Error(`WAT: stray ';' near: ${src.slice(i, i + 40)}`);
    }
    if (c === 34) { const r = readString(src, i); k.push(T_STR); v.push(r.bytes); i = r.end; continue; }
    let j = i + 1;
    while (j < n) {
      const d = src.charCodeAt(j);
      if (d <= 32 || d === 40 || d === 41 || d === 34 || d === 59) break;
      j++;
    }
    k.push(T_ATOM); v.push(src.slice(i, j));
    i = j;
  }
  return { k, v };
}

function skipBlockComment(src, i) {
  let depth = 0;
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 40 && src.charCodeAt(i + 1) === 59) { depth++; i += 2; continue; }
    if (c === 59 && src.charCodeAt(i + 1) === 41) { depth--; i += 2; if (depth === 0) return i; continue; }
    i++;
  }
  throw new Error("WAT: unterminated block comment");
}

function hexVal(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

/** Decode a WAT string literal starting at the opening quote into bytes. */
function readString(src, i) {
  const n = src.length;
  let j = i + 1;
  let simple = true;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 34) break;
    if (c === 92) { simple = false; j += 2; continue; }
    j++;
  }
  if (j >= n) throw new Error("WAT: unterminated string");
  if (simple) return { bytes: new Uint8Array(Buffer.from(src.slice(i + 1, j), "utf8")), end: j + 1 };
  // Escapes present: decode byte by byte. Upper bound on output size: j-i.
  const out = new Uint8Array(j - i);
  let o = 0;
  let p = i + 1;
  while (p < j) {
    const c = src.charCodeAt(p);
    if (c !== 92) {
      if (c < 0x80) { out[o++] = c; p++; continue; }
      // Non-ASCII: encode the code point as UTF-8.
      const cp = src.codePointAt(p);
      const u = Buffer.from(String.fromCodePoint(cp), "utf8");
      out.set(u, o); o += u.length; p += cp > 0xffff ? 2 : 1;
      continue;
    }
    const e = src.charCodeAt(p + 1);
    const h1 = hexVal(e);
    if (h1 >= 0 && p + 2 < j + 1) {
      const h2 = hexVal(src.charCodeAt(p + 2));
      if (h2 >= 0) { out[o++] = (h1 << 4) | h2; p += 3; continue; }
    }
    switch (e) {
      case 116: out[o++] = 9; p += 2; continue;   // \t
      case 110: out[o++] = 10; p += 2; continue;  // \n
      case 114: out[o++] = 13; p += 2; continue;  // \r
      case 34: out[o++] = 34; p += 2; continue;   // \"
      case 39: out[o++] = 39; p += 2; continue;   // \'
      case 92: out[o++] = 92; p += 2; continue;   // \\
      case 117: {                                 // \u{hex}
        const close = src.indexOf("}", p);
        const cp = parseInt(src.slice(p + 3, close).replace(/_/g, ""), 16);
        const u = Buffer.from(String.fromCodePoint(cp), "utf8");
        out.set(u, o); o += u.length; p = close + 1;
        continue;
      }
      default:
        throw new Error(`WAT: bad string escape '\\${src[p + 1]}'`);
    }
  }
  // Must re-check end since a "\"" escape inside may have made the scan above
  // skip correctly; j is the true closing quote.
  return { bytes: out.slice(0, o), end: j + 1 };
}

// ---------------------------------------------------------------------------
// Numeric literals

function clean(s) { return s.indexOf("_") >= 0 ? s.replace(/_/g, "") : s; }

/** Parse an integer literal for a 32-bit context; returns the value as int32. */
export function parseI32(s) {
  const t = clean(s);
  let neg = false, p = 0;
  if (t[0] === "-") { neg = true; p = 1; } else if (t[0] === "+") p = 1;
  let v;
  if (t[p] === "0" && (t[p + 1] === "x" || t[p + 1] === "X")) {
    const h = t.slice(p + 2);
    if (!/^[0-9a-fA-F]+$/.test(h)) throw new Error(`WAT: bad i32 literal '${s}'`);
    v = parseInt(h, 16);
  } else {
    const d = t.slice(p);
    if (!/^[0-9]+$/.test(d)) throw new Error(`WAT: bad i32 literal '${s}'`);
    v = Number(d);
  }
  if (neg) {
    if (v > 0x80000000) throw new Error(`WAT: i32 literal out of range '${s}'`);
    return (-v) | 0;
  }
  if (v > 0xffffffff) throw new Error(`WAT: i32 literal out of range '${s}'`);
  return v | 0;
}

/** Parse an unsigned integer (index, offset=, align=, limits). */
function parseU32(s) {
  const t = clean(s);
  let v;
  if (t[0] === "0" && (t[1] === "x" || t[1] === "X")) v = parseInt(t.slice(2), 16);
  else if (/^[0-9]+$/.test(t)) v = Number(t);
  else v = NaN;
  if (!(v >= 0 && v <= 0xffffffff)) throw new Error(`WAT: expected an unsigned integer, got '${s}'`);
  return v;
}

/** Parse an integer literal for a 64-bit context; returns a BigInt. */
export function parseI64(s) {
  const t = clean(s);
  let neg = false, p = 0;
  if (t[0] === "-") { neg = true; p = 1; } else if (t[0] === "+") p = 1;
  const body = t.slice(p);
  if (!/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(body)) throw new Error(`WAT: bad i64 literal '${s}'`);
  let v = BigInt(body);
  if (neg) v = -v;
  if (v < -(1n << 63n) || v >= (1n << 64n)) throw new Error(`WAT: i64 literal out of range '${s}'`);
  return BigInt.asIntN(64, v);
}

const F64BUF = new DataView(new ArrayBuffer(8));

/** Round M * 2^E (M >= 0 BigInt) to the nearest float with `prec` mantissa bits and min normal exponent `emin`. Returns a Number (exact in double). */
function roundBinary(M, E, prec, emin, emax) {
  if (M === 0n) return 0;
  const bl = M.toString(2).length;
  let e = bl - 1 + E; // exponent of the leading bit
  let p = prec;
  if (e < emin) p = prec - (emin - e);
  if (p < 0) return 0;
  const shift = bl - p;
  let m = M;
  let ee = E;
  if (shift > 0) {
    const q = m >> BigInt(shift);
    const rem = m - (q << BigInt(shift));
    const half = 1n << BigInt(shift - 1);
    let r = q;
    if (rem > half || (rem === half && (q & 1n) === 1n)) r = q + 1n;
    m = r; ee = E + shift;
  }
  if (m === 0n) return 0;
  // exponent overflow check
  const bl2 = m.toString(2).length;
  if (bl2 - 1 + ee > emax) return Infinity;
  // m has <= 53 bits: exact as Number; scale by 2^ee in safe steps.
  let x = Number(m);
  while (ee > 0) { const k = Math.min(ee, 1000); x *= 2 ** k; ee -= k; }
  while (ee < 0) { const k = Math.min(-ee, 1000); x /= 2 ** k; ee += k; }
  return x;
}

function parseHexFloat(t, is32) {
  // t: hex float without sign, like 0x1.8p+47 or 0xABC or 0x1p-3
  const m = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?[0-9]+))?$/.exec(t);
  if (!m) throw new Error(`WAT: bad hex float '${t}'`);
  const ip = m[1] || "", fp = m[2] || "";
  if (!ip && !fp) throw new Error(`WAT: bad hex float '${t}'`);
  const M = BigInt("0x" + (ip + fp || "0"));
  const E = (m[3] ? parseInt(m[3], 10) : 0) - 4 * fp.length;
  return is32 ? roundBinary(M, E, 24, -126, 127) : roundBinary(M, E, 53, -1022, 1023);
}

/** Exact comparison of a decimal string (digits, optional fraction/exponent) with a finite double. -1/0/1. */
function cmpDecimalWithDouble(dec, d) {
  const m = /^([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(dec);
  const digits = (m[1] || "") + (m[2] || "");
  let e10 = (m[3] ? parseInt(m[3], 10) : 0) - (m[2] || "").length;
  let num = BigInt(digits || "0"), den = 1n;
  if (e10 >= 0) num *= 10n ** BigInt(e10); else den = 10n ** BigInt(-e10);
  // d = mant * 2^exp exactly
  F64BUF.setFloat64(0, d);
  const hi = F64BUF.getUint32(0), lo = F64BUF.getUint32(4);
  const bexp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp;
  if (bexp === 0) exp = -1074; else { mant |= 1n << 52n; exp = bexp - 1075; }
  let dn = mant, dd = 1n;
  if (exp >= 0) dn <<= BigInt(exp); else dd <<= BigInt(-exp);
  const l = num * dd, r = dn * den;
  return l < r ? -1 : l > r ? 1 : 0;
}

/** Correctly rounded decimal -> f32 (avoids the double-rounding trap of fround(Number(s))). */
function decimalToF32(t) {
  const d = Number(t);
  if (!Number.isFinite(d)) return d;
  const f = Math.fround(d);
  if (f === d) return f;
  // Neighbour on the other side of d.
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  f32[0] = f;
  const bits = u32[0];
  if (Math.abs(d) > Math.abs(f)) u32[0] = bits + 1; else u32[0] = bits - 1;
  const g = f32[0];
  const mid = (f + g) / 2;
  if (d !== mid) return f;
  // d landed exactly on a midpoint: decide by the exact decimal.
  const c = cmpDecimalWithDouble(t.replace(/^[+-]/, ""), Math.abs(mid));
  const fa = Math.abs(f), ga = Math.abs(g);
  const lo = Math.min(fa, ga), hiv = Math.max(fa, ga);
  let r;
  if (c < 0) r = lo; else if (c > 0) r = hiv;
  else {
    // true tie: round to even mantissa
    f32[0] = lo; r = (u32[0] & 1) === 0 ? lo : hiv;
  }
  return d < 0 ? -r : r;
}

/** @returns {number} uint32 bit pattern */
export function parseF32Bits(s) {
  let t = clean(s);
  let neg = false;
  if (t[0] === "-") { neg = true; t = t.slice(1); } else if (t[0] === "+") t = t.slice(1);
  const sign = neg ? 0x80000000 : 0;
  if (t === "inf") return (sign | 0x7f800000) >>> 0;
  if (t === "nan") return (sign | 0x7fc00000) >>> 0;
  if (t.startsWith("nan:0x")) {
    const payload = parseInt(t.slice(6), 16);
    if (!(payload > 0 && payload < 0x800000)) throw new Error(`WAT: bad f32 nan payload '${s}'`);
    return (sign | 0x7f800000 | payload) >>> 0;
  }
  let v;
  if (t[0] === "0" && (t[1] === "x" || t[1] === "X")) v = parseHexFloat(t, true);
  else {
    if (!/^[0-9]+(\.[0-9]*)?([eE][+-]?[0-9]+)?$/.test(t)) throw new Error(`WAT: bad f32 literal '${s}'`);
    v = decimalToF32(t);
  }
  const f = new Float32Array([v]);
  return (new Uint32Array(f.buffer)[0] | sign) >>> 0;
}

/** @returns {Uint8Array} 8 little-endian bytes */
export function parseF64Bytes(s) {
  let t = clean(s);
  let neg = false;
  if (t[0] === "-") { neg = true; t = t.slice(1); } else if (t[0] === "+") t = t.slice(1);
  const dv = new DataView(new ArrayBuffer(8));
  if (t === "inf") dv.setFloat64(0, Infinity, true);
  else if (t === "nan") { dv.setUint32(4, 0x7ff80000, true); dv.setUint32(0, 0, true); }
  else if (t.startsWith("nan:0x")) {
    const p = BigInt("0x" + t.slice(6));
    if (!(p > 0n && p < (1n << 52n))) throw new Error(`WAT: bad f64 nan payload '${s}'`);
    const bits = (0x7ffn << 52n) | p;
    dv.setBigUint64(0, bits, true);
  } else {
    let v;
    if (t[0] === "0" && (t[1] === "x" || t[1] === "X")) v = parseHexFloat(t, false);
    else {
      if (!/^[0-9]+(\.[0-9]*)?([eE][+-]?[0-9]+)?$/.test(t)) throw new Error(`WAT: bad f64 literal '${s}'`);
      v = Number(t);
    }
    dv.setFloat64(0, v, true);
  }
  if (neg) dv.setUint8(7, dv.getUint8(7) | 0x80);
  return new Uint8Array(dv.buffer);
}

// ---------------------------------------------------------------------------
// Opcode table

const I_NONE = 0, I_LOCAL = 1, I_GLOBAL = 2, I_FUNC = 3, I_LABEL = 4, I_BRTABLE = 5, I_MEM = 6,
  I_I32 = 7, I_I64 = 8, I_F32 = 9, I_F64 = 10, I_CALLIND = 11, I_SELECT = 12, I_MEMIDX = 13,
  I_MEMCOPY = 14, I_MEMINIT = 15, I_DATA = 16, I_TABLE = 17, I_TABLEINIT = 18, I_TABLECOPY = 19,
  I_ELEM = 20, I_REFNULL = 21;

/** name -> [opcode, immediateKind, naturalAlignLog2 | prefix] */
const OPS = new Map();
function op(name, code, imm = I_NONE, align = 0, prefix = 0) { OPS.set(name, { code, imm, align, prefix }); }

op("unreachable", 0x00); op("nop", 0x01);
op("br", 0x0c, I_LABEL); op("br_if", 0x0d, I_LABEL); op("br_table", 0x0e, I_BRTABLE);
op("return", 0x0f); op("call", 0x10, I_FUNC); op("call_indirect", 0x11, I_CALLIND);
op("return_call", 0x12, I_FUNC); op("return_call_indirect", 0x13, I_CALLIND);
op("drop", 0x1a); op("select", 0x1b, I_SELECT);
op("local.get", 0x20, I_LOCAL); op("local.set", 0x21, I_LOCAL); op("local.tee", 0x22, I_LOCAL);
op("global.get", 0x23, I_GLOBAL); op("global.set", 0x24, I_GLOBAL);
op("table.get", 0x25, I_TABLE); op("table.set", 0x26, I_TABLE);
op("i32.load", 0x28, I_MEM, 2); op("i64.load", 0x29, I_MEM, 3); op("f32.load", 0x2a, I_MEM, 2); op("f64.load", 0x2b, I_MEM, 3);
op("i32.load8_s", 0x2c, I_MEM, 0); op("i32.load8_u", 0x2d, I_MEM, 0); op("i32.load16_s", 0x2e, I_MEM, 1); op("i32.load16_u", 0x2f, I_MEM, 1);
op("i64.load8_s", 0x30, I_MEM, 0); op("i64.load8_u", 0x31, I_MEM, 0); op("i64.load16_s", 0x32, I_MEM, 1); op("i64.load16_u", 0x33, I_MEM, 1);
op("i64.load32_s", 0x34, I_MEM, 2); op("i64.load32_u", 0x35, I_MEM, 2);
op("i32.store", 0x36, I_MEM, 2); op("i64.store", 0x37, I_MEM, 3); op("f32.store", 0x38, I_MEM, 2); op("f64.store", 0x39, I_MEM, 3);
op("i32.store8", 0x3a, I_MEM, 0); op("i32.store16", 0x3b, I_MEM, 1);
op("i64.store8", 0x3c, I_MEM, 0); op("i64.store16", 0x3d, I_MEM, 1); op("i64.store32", 0x3e, I_MEM, 2);
op("memory.size", 0x3f, I_MEMIDX); op("memory.grow", 0x40, I_MEMIDX);
op("i32.const", 0x41, I_I32); op("i64.const", 0x42, I_I64); op("f32.const", 0x43, I_F32); op("f64.const", 0x44, I_F64);
{
  const names = [
    "i32.eqz", "i32.eq", "i32.ne", "i32.lt_s", "i32.lt_u", "i32.gt_s", "i32.gt_u", "i32.le_s", "i32.le_u", "i32.ge_s", "i32.ge_u",
    "i64.eqz", "i64.eq", "i64.ne", "i64.lt_s", "i64.lt_u", "i64.gt_s", "i64.gt_u", "i64.le_s", "i64.le_u", "i64.ge_s", "i64.ge_u",
    "f32.eq", "f32.ne", "f32.lt", "f32.gt", "f32.le", "f32.ge",
    "f64.eq", "f64.ne", "f64.lt", "f64.gt", "f64.le", "f64.ge",
    "i32.clz", "i32.ctz", "i32.popcnt", "i32.add", "i32.sub", "i32.mul", "i32.div_s", "i32.div_u", "i32.rem_s", "i32.rem_u",
    "i32.and", "i32.or", "i32.xor", "i32.shl", "i32.shr_s", "i32.shr_u", "i32.rotl", "i32.rotr",
    "i64.clz", "i64.ctz", "i64.popcnt", "i64.add", "i64.sub", "i64.mul", "i64.div_s", "i64.div_u", "i64.rem_s", "i64.rem_u",
    "i64.and", "i64.or", "i64.xor", "i64.shl", "i64.shr_s", "i64.shr_u", "i64.rotl", "i64.rotr",
    "f32.abs", "f32.neg", "f32.ceil", "f32.floor", "f32.trunc", "f32.nearest", "f32.sqrt", "f32.add", "f32.sub", "f32.mul", "f32.div",
    "f32.min", "f32.max", "f32.copysign",
    "f64.abs", "f64.neg", "f64.ceil", "f64.floor", "f64.trunc", "f64.nearest", "f64.sqrt", "f64.add", "f64.sub", "f64.mul", "f64.div",
    "f64.min", "f64.max", "f64.copysign",
    "i32.wrap_i64", "i32.trunc_f32_s", "i32.trunc_f32_u", "i32.trunc_f64_s", "i32.trunc_f64_u",
    "i64.extend_i32_s", "i64.extend_i32_u", "i64.trunc_f32_s", "i64.trunc_f32_u", "i64.trunc_f64_s", "i64.trunc_f64_u",
    "f32.convert_i32_s", "f32.convert_i32_u", "f32.convert_i64_s", "f32.convert_i64_u", "f32.demote_f64",
    "f64.convert_i32_s", "f64.convert_i32_u", "f64.convert_i64_s", "f64.convert_i64_u", "f64.promote_f32",
    "i32.reinterpret_f32", "i64.reinterpret_f64", "f32.reinterpret_i32", "f64.reinterpret_i64",
    "i32.extend8_s", "i32.extend16_s", "i64.extend8_s", "i64.extend16_s", "i64.extend32_s",
  ];
  names.forEach((nm, idx) => op(nm, 0x45 + idx));
  const sat = ["i32.trunc_sat_f32_s", "i32.trunc_sat_f32_u", "i32.trunc_sat_f64_s", "i32.trunc_sat_f64_u",
    "i64.trunc_sat_f32_s", "i64.trunc_sat_f32_u", "i64.trunc_sat_f64_s", "i64.trunc_sat_f64_u"];
  sat.forEach((nm, idx) => op(nm, idx, I_NONE, 0, 0xfc));
}
op("ref.null", 0xd0, I_REFNULL); op("ref.is_null", 0xd1); op("ref.func", 0xd2, I_FUNC);
op("memory.init", 8, I_MEMINIT, 0, 0xfc); op("data.drop", 9, I_DATA, 0, 0xfc);
op("memory.copy", 10, I_MEMCOPY, 0, 0xfc); op("memory.fill", 11, I_MEMIDX, 0, 0xfc);
op("table.init", 12, I_TABLEINIT, 0, 0xfc); op("elem.drop", 13, I_ELEM, 0, 0xfc);
op("table.copy", 14, I_TABLECOPY, 0, 0xfc); op("table.grow", 15, I_TABLE, 0, 0xfc);
op("table.size", 16, I_TABLE, 0, 0xfc); op("table.fill", 17, I_TABLE, 0, 0xfc);
// Legacy spellings some emitters (and older WABT output) still use.
const ALIASES = {
  get_local: "local.get", set_local: "local.set", tee_local: "local.tee", get_global: "global.get", set_global: "global.set",
  current_memory: "memory.size", grow_memory: "memory.grow", "i32.wrap/i64": "i32.wrap_i64",
  "i64.extend_s/i32": "i64.extend_i32_s", "i64.extend_u/i32": "i64.extend_i32_u",
  "i32.trunc_s/f32": "i32.trunc_f32_s", "i32.trunc_u/f32": "i32.trunc_f32_u", "i32.trunc_s/f64": "i32.trunc_f64_s", "i32.trunc_u/f64": "i32.trunc_f64_u",
  "i64.trunc_s/f32": "i64.trunc_f32_s", "i64.trunc_u/f32": "i64.trunc_f32_u", "i64.trunc_s/f64": "i64.trunc_f64_s", "i64.trunc_u/f64": "i64.trunc_f64_u",
  "f32.convert_s/i32": "f32.convert_i32_s", "f32.convert_u/i32": "f32.convert_i32_u", "f32.convert_s/i64": "f32.convert_i64_s", "f32.convert_u/i64": "f32.convert_i64_u",
  "f64.convert_s/i32": "f64.convert_i32_s", "f64.convert_u/i32": "f64.convert_i32_u", "f64.convert_s/i64": "f64.convert_i64_s", "f64.convert_u/i64": "f64.convert_i64_u",
  "f32.demote/f64": "f32.demote_f64", "f64.promote/f32": "f64.promote_f32",
  "i32.reinterpret/f32": "i32.reinterpret_f32", "i64.reinterpret/f64": "i64.reinterpret_f64",
  "f32.reinterpret/i32": "f32.reinterpret_i32", "f64.reinterpret/i64": "f64.reinterpret_i64",
};
for (const [a, b] of Object.entries(ALIASES)) OPS.set(a, OPS.get(b));

const VALTYPES = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b, funcref: 0x70, externref: 0x6f, anyfunc: 0x70 };
const REFTYPES = { funcref: 0x70, externref: 0x6f, anyfunc: 0x70, func: 0x70, extern: 0x6f };
const BLOCK_KW = new Set(["block", "loop", "if"]);

function valtype(s) {
  const t = VALTYPES[s];
  if (t === undefined) throw new Error(`WAT: unknown value type '${s}'`);
  return t;
}

// ---------------------------------------------------------------------------
// Symbol spaces

const SP_FUNC = 0, SP_GLOBAL = 1, SP_TYPE = 2, SP_TYPEKEY = 3, SP_TABLE = 4, SP_MEMORY = 5, SP_DATA = 6, SP_ELEM = 7;
const SPACE_NAMES = ["func", "global", "type", "type signature", "table", "memory", "data", "elem"];

function sigKey(params, results) { return params.join(",") + ">" + results.join(","); }

// ---------------------------------------------------------------------------
// Code storage (encoded bodies before the final write)

class MemStore {
  constructor() { this.chunks = []; this.size = 0; }
  append(u8) { const off = this.size; this.chunks.push(u8.slice()); this.size += u8.length; return off; }
  /** Iterate stored bodies in order. */
  *bodies() { for (const c of this.chunks) yield c; }
  close() {}
}

class FileStore {
  constructor(path) {
    this.path = path;
    this.fd = openSync(path, "w+");
    this.size = 0;
    this.lens = [];
  }
  append(u8) { const off = this.size; let w = 0; while (w < u8.length) w += writeSync(this.fd, u8, w, u8.length - w, off + w); this.size += u8.length; this.lens.push(u8.length); return off; }
  *bodies() {
    let pos = 0;
    let buf = new Uint8Array(1 << 20);
    for (const len of this.lens) {
      if (len > buf.length) buf = new Uint8Array(len);
      let r = 0;
      while (r < len) { const k = readSync(this.fd, buf, r, len - r, pos + r); if (k <= 0) throw new Error("WAT assembler: short read from code spill file"); r += k; }
      pos += len;
      yield buf.subarray(0, len);
    }
  }
  close() { try { closeSync(this.fd); } catch { /* already closed */ } try { unlinkSync(this.path); } catch { /* gone */ } }
}

class GrowU32 {
  constructor() { this.a = new Uint32Array(1 << 16); this.n = 0; }
  push(x) { if (this.n === this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = x; }
}

// ---------------------------------------------------------------------------
// Output sink

class Out {
  constructor(path) {
    this.path = path;
    this.fd = path ? openSync(path, "w") : -1;
    this.buf = new Uint8Array(1 << 22);
    this.n = 0;
    this.total = 0;
    this.mem = path ? null : [];
  }
  write(u8) {
    this.total += u8.length;
    if (u8.length > this.buf.length - this.n) this.flush();
    if (u8.length > this.buf.length) { this.raw(u8); return; }
    this.buf.set(u8, this.n); this.n += u8.length;
  }
  raw(u8) {
    if (this.mem) { this.mem.push(u8.slice()); return; }
    let w = 0; while (w < u8.length) w += writeSync(this.fd, u8, w, u8.length - w);
  }
  flush() { if (this.n) { this.raw(this.buf.subarray(0, this.n)); this.n = 0; } }
  close() {
    this.flush();
    if (this.fd >= 0) closeSync(this.fd);
    if (this.mem) {
      const all = new Uint8Array(this.total);
      let o = 0; for (const c of this.mem) { all.set(c, o); o += c.length; }
      return all;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// The module assembler

class Assembler {
  constructor(opts) {
    this.opts = opts;
    this.types = [];            // explicit: {params, results, key}
    this.typeNames = new Map(); // $name -> index
    this.implicitKeys = new Map(); // key -> {params, results, order}
    this.imports = [];          // {module, field, kind, desc...}
    this.funcs = [];            // {name, typeRef|null, params, results, imported}
    this.funcNames = new Map();
    this.nFuncImports = 0;
    this.tables = []; this.tableNames = new Map(); this.nTableImports = 0;
    this.mems = []; this.memNames = new Map(); this.nMemImports = 0;
    this.globals = []; this.globalNames = new Map(); this.nGlobalImports = 0;
    this.exports = [];          // {name, kind, sym|index}
    this.start = null;
    this.elems = []; this.elemNames = new Map();
    this.datas = []; this.dataNames = new Map();
    this.syms = []; this.symMap = new Map();
    this.store = opts.outputPath ? new FileStore(opts.outputPath + ".code.tmp") : new MemStore();
    this.bodyMeta = [];         // per defined func: [rawLen, relocStart, relocEnd]
    this.bodyRelPos = new GrowU32();
    this.bodyRelSym = new GrowU32();
    this.nDefinedFuncs = 0;     // bodies seen
    this.usesDataCount = false;
    this.w = new W(1 << 16);
    this.funcDecls = 0;         // functions declared (imports + defined)
  }

  // --- symbols ---------------------------------------------------------------
  sym(space, name) {
    const key = space + "\u0000" + name;
    let id = this.symMap.get(key);
    if (id === undefined) { id = this.syms.length; this.syms.push({ space, name }); this.symMap.set(key, id); }
    return id;
  }

  /** Current index for a name in a space, or -1 if not (yet) declared. */
  known(space, name) {
    let m;
    switch (space) {
      case SP_FUNC: m = this.funcNames; break;
      case SP_GLOBAL: m = this.globalNames; break;
      case SP_TYPE: m = this.typeNames; break;
      case SP_TABLE: m = this.tableNames; break;
      case SP_MEMORY: m = this.memNames; break;
      case SP_DATA: m = this.dataNames; break;
      case SP_ELEM: m = this.elemNames; break;
      default: return -1;
    }
    const v = m.get(name);
    return v === undefined ? -1 : v;
  }

  resolveSym(id) {
    const s = this.syms[id];
    if (s.space === SP_TYPEKEY) return this.typeIndexForKey(s.name);
    const v = this.known(s.space, s.name);
    if (v < 0) throw new Error(`WAT: unknown ${SPACE_NAMES[s.space]} '${s.name}'`);
    return v;
  }

  /** Write an index reference: a number literal, or a $name (known now or relocated). */
  writeRef(w, space, tok) {
    if (tok[0] === "$") {
      const v = this.known(space, tok);
      if (v >= 0) w.u32(v); else w.reloc(this.sym(space, tok));
    } else w.u32(parseU32(tok));
  }

  // --- types -----------------------------------------------------------------
  finalizeTypes() {
    if (this.finalTypes) return;
    const explicitByKey = new Map();
    this.types.forEach((t, i) => { if (!explicitByKey.has(t.key)) explicitByKey.set(t.key, i); });
    const list = this.types.slice();
    const keyIndex = new Map(explicitByKey);
    for (const [key, t] of this.implicitKeys) {
      if (!keyIndex.has(key)) { keyIndex.set(key, list.length); list.push(t); }
    }
    this.finalTypes = list;
    this.keyIndex = keyIndex;
  }
  typeIndexForKey(key) { this.finalizeTypes(); return this.keyIndex.get(key); }
  useImplicit(params, results) {
    const key = sigKey(params, results);
    if (!this.implicitKeys.has(key)) this.implicitKeys.set(key, { params, results, key });
    return key;
  }

  // --- field dispatch ----------------------------------------------------------
  field(text) {
    const t = tokenize(text);
    const c = { k: t.k, v: t.v, i: 0 };
    this.expectLP(c);
    const kw = this.atom(c);
    switch (kw) {
      case "type": return this.fType(c);
      case "import": return this.fImport(c);
      case "func": return this.fFunc(c);
      case "table": return this.fTable(c);
      case "memory": return this.fMemory(c);
      case "global": return this.fGlobal(c);
      case "export": return this.fExport(c);
      case "start": return this.fStart(c);
      case "elem": return this.fElem(c);
      case "data": return this.fData(c);
      case "rec": throw new Error("WAT: (rec ...) GC types are not supported");
      default: throw new Error(`WAT: unknown module field '${kw}'`);
    }
  }

  // --- token helpers -----------------------------------------------------------
  expectLP(c) { if (c.k[c.i] !== T_LP) throw this.err(c, "expected '('"); c.i++; }
  expectRP(c) { if (c.k[c.i] !== T_RP) throw this.err(c, "expected ')'"); c.i++; }
  atom(c) { if (c.k[c.i] !== T_ATOM) throw this.err(c, "expected a keyword or value"); return c.v[c.i++]; }
  optId(c) { if (c.k[c.i] === T_ATOM && c.v[c.i][0] === "$") return c.v[c.i++]; return null; }
  /** Is the next token '(' followed by atom kw? */
  isForm(c, kw) { return c.k[c.i] === T_LP && c.k[c.i + 1] === T_ATOM && c.v[c.i + 1] === kw; }
  str(c) { if (c.k[c.i] !== T_STR) throw this.err(c, "expected a string"); return c.v[c.i++]; }
  err(c, msg) {
    const ctx = [];
    for (let j = Math.max(0, c.i - 6); j < Math.min(c.k.length, c.i + 6); j++) {
      ctx.push(c.k[j] === T_LP ? "(" : c.k[j] === T_RP ? ")" : c.k[j] === T_STR ? '"..."' : c.v[j]);
    }
    return new Error(`WAT: ${msg} near: ${ctx.join(" ")}${this.curFunc ? ` (in func ${this.curFunc})` : ""}`);
  }
  skipForm(c) {
    let d = 0;
    do { if (c.k[c.i] === T_LP) d++; else if (c.k[c.i] === T_RP) d--; c.i++; } while (d > 0 && c.i < c.k.length);
  }

  /** (export "name")* inline exports; returns list of names. */
  inlineExports(c) {
    const out = [];
    while (this.isForm(c, "export")) { c.i += 2; out.push(Buffer.from(this.str(c)).toString("utf8")); this.expectRP(c); }
    return out;
  }
  inlineImport(c) {
    if (!this.isForm(c, "import")) return null;
    c.i += 2;
    const module = this.str(c), field = this.str(c);
    this.expectRP(c);
    return { module, field };
  }

  /** typeuse: (type x)? (param ...)* (result ...)*; returns {typeRef, params, results, paramNames} */
  typeUse(c, allowNames = true) {
    let typeRef = null;
    if (this.isForm(c, "type")) { c.i += 2; typeRef = this.atom(c); this.expectRP(c); }
    const params = [], results = [], paramNames = [];
    while (this.isForm(c, "param")) {
      c.i += 2;
      if (c.k[c.i] === T_ATOM && c.v[c.i][0] === "$") {
        if (!allowNames) throw this.err(c, "named param not allowed here");
        paramNames[params.length] = c.v[c.i++];
        params.push(valtype(this.atom(c)));
      } else {
        while (c.k[c.i] === T_ATOM) params.push(valtype(this.atom(c)));
      }
      this.expectRP(c);
    }
    while (this.isForm(c, "result")) {
      c.i += 2;
      while (c.k[c.i] === T_ATOM) results.push(valtype(this.atom(c)));
      this.expectRP(c);
    }
    if (typeRef !== null && !params.length && !results.length) {
      const idx = typeRef[0] === "$" ? this.typeNames.get(typeRef) : parseU32(typeRef);
      if (idx !== undefined && this.types[idx]) return { typeRef, params: this.types[idx].params, results: this.types[idx].results, paramNames, fromType: true };
      return { typeRef, params: null, results: null, paramNames, fromType: true };
    }
    return { typeRef, params, results, paramNames, fromType: false };
  }

  // --- fields ------------------------------------------------------------------
  fType(c) {
    const name = this.optId(c);
    this.expectLP(c);
    if (this.atom(c) !== "func") throw this.err(c, "only (type (func ...)) is supported");
    const params = [], results = [];
    while (this.isForm(c, "param")) { c.i += 2; if (c.k[c.i] === T_ATOM && c.v[c.i][0] === "$") c.i++; while (c.k[c.i] === T_ATOM) params.push(valtype(this.atom(c))); this.expectRP(c); }
    while (this.isForm(c, "result")) { c.i += 2; while (c.k[c.i] === T_ATOM) results.push(valtype(this.atom(c))); this.expectRP(c); }
    this.expectRP(c); this.expectRP(c);
    if (this.finalTypes) throw new Error("WAT: type declared after types were finalised");
    if (name) this.typeNames.set(name, this.types.length);
    this.types.push({ params, results, key: sigKey(params, results) });
  }

  fImport(c) {
    const module = this.str(c), field = this.str(c);
    this.expectLP(c);
    const kind = this.atom(c);
    const name = this.optId(c);
    this.importDesc(c, kind, name, { module, field }, []);
    this.expectRP(c); this.expectRP(c);
  }

  importDesc(c, kind, name, imp, exports) {
    if (kind === "func") {
      if (this.nDefinedFuncsDeclared) throw this.err(c, "function import after a function definition");
      const tu = this.typeUse(c);
      const idx = this.funcDecls++;
      if (name) this.funcNames.set(name, idx);
      const f = { name, typeRef: tu.typeRef, params: tu.params, results: tu.results, imported: true };
      if (!tu.fromType) f.key = this.useImplicit(tu.params, tu.results);
      this.funcs.push(f);
      this.nFuncImports++;
      this.imports.push({ ...imp, kind: 0, func: f });
      for (const e of exports) this.exports.push({ name: e, kind: 0, index: idx });
    } else if (kind === "memory") {
      const lim = this.limits(c);
      const idx = this.mems.length;
      if (name) this.memNames.set(name, idx);
      this.mems.push({ lim, imported: true });
      this.nMemImports++;
      this.imports.push({ ...imp, kind: 2, lim });
      for (const e of exports) this.exports.push({ name: e, kind: 2, index: idx });
    } else if (kind === "global") {
      const gt = this.globalType(c);
      const idx = this.globals.length;
      if (name) this.globalNames.set(name, idx);
      this.globals.push({ gt, imported: true });
      this.nGlobalImports++;
      this.imports.push({ ...imp, kind: 3, gt });
      for (const e of exports) this.exports.push({ name: e, kind: 3, index: idx });
    } else if (kind === "table") {
      const lim = this.limits(c);
      const rt = REFTYPES[this.atom(c)];
      const idx = this.tables.length;
      if (name) this.tableNames.set(name, idx);
      this.tables.push({ lim, rt, imported: true });
      this.nTableImports++;
      this.imports.push({ ...imp, kind: 1, lim, rt });
      for (const e of exports) this.exports.push({ name: e, kind: 1, index: idx });
    } else throw this.err(c, `unsupported import kind '${kind}'`);
  }

  limits(c) {
    const min = parseU32(this.atom(c));
    let max = null, shared = false;
    if (c.k[c.i] === T_ATOM && /^[0-9]/.test(c.v[c.i])) max = parseU32(this.atom(c));
    if (c.k[c.i] === T_ATOM && c.v[c.i] === "shared") { shared = true; c.i++; }
    return { min, max, shared };
  }

  globalType(c) {
    if (this.isForm(c, "mut")) { c.i += 2; const t = valtype(this.atom(c)); this.expectRP(c); return { t, mut: 1 }; }
    return { t: valtype(this.atom(c)), mut: 0 };
  }

  fFunc(c) {
    const name = this.optId(c);
    const exports = this.inlineExports(c);
    const imp = this.inlineImport(c);
    if (imp) { this.importDesc(c, "func", name, imp, exports); this.expectRP(c); return; }
    this.nDefinedFuncsDeclared = true;
    const tu = this.typeUse(c);
    if (tu.params === null) throw this.err(c, `function ${name || ""} uses (type ${tu.typeRef}) before that type is declared`);
    const idx = this.funcDecls++;
    if (name) this.funcNames.set(name, idx);
    const f = { name, typeRef: tu.typeRef, params: tu.params, results: tu.results, imported: false };
    if (!tu.fromType) f.key = this.useImplicit(tu.params, tu.results);
    this.funcs.push(f);
    for (const e of exports) this.exports.push({ name: e, kind: 0, index: idx });
    // locals
    const localNames = new Map();
    tu.paramNames.forEach((n, i) => { if (n) localNames.set(n, i); });
    const localTypes = [];
    let nloc = tu.params.length;
    while (this.isForm(c, "local")) {
      c.i += 2;
      if (c.k[c.i] === T_ATOM && c.v[c.i][0] === "$") {
        localNames.set(c.v[c.i++], nloc++);
        localTypes.push(valtype(this.atom(c)));
      } else {
        while (c.k[c.i] === T_ATOM) { localTypes.push(valtype(this.atom(c))); nloc++; }
      }
      this.expectRP(c);
    }
    const w = this.w;
    w.reset();
    // local declarations: runs of equal types
    const runs = [];
    for (const t of localTypes) {
      if (runs.length && runs[runs.length - 1][1] === t) runs[runs.length - 1][0]++;
      else runs.push([1, t]);
    }
    w.u32(runs.length);
    for (const [n, t] of runs) { w.u32(n); w.u8(t); }
    this.curFunc = name || `#${idx}`;
    const fc = { locals: localNames, nlocals: nloc, labels: [] };
    this.instrs(c, w, fc, true);
    this.expectRP(c);
    w.u8(0x0b);
    this.curFunc = null;
    // spill
    const relStart = this.bodyRelPos.n;
    for (let j = 0; j < w.relPos.length; j++) { this.bodyRelPos.push(w.relPos[j]); this.bodyRelSym.push(w.relSym[j]); }
    this.store.append(w.view());
    this.bodyMeta.push(w.n, relStart, this.bodyRelPos.n);
    this.nDefinedFuncs++;
  }

  fTable(c) {
    const name = this.optId(c);
    const exports = this.inlineExports(c);
    const imp = this.inlineImport(c);
    if (imp) { this.importDesc(c, "table", name, imp, exports); this.expectRP(c); return; }
    const idx = this.tables.length;
    if (name) this.tableNames.set(name, idx);
    if (c.k[c.i] === T_ATOM && REFTYPES[c.v[c.i]] !== undefined && c.v[c.i] !== "func" && this.isForm({ k: c.k, v: c.v, i: c.i + 1 }, "elem")) {
      // (table $t funcref (elem $a $b ...))
      const rt = REFTYPES[this.atom(c)];
      c.i += 2;
      const items = [];
      while (c.k[c.i] === T_ATOM) items.push(this.atom(c));
      this.expectRP(c);
      this.tables.push({ lim: { min: items.length, max: items.length }, rt });
      const off = new W(8); off.u8(0x41); off.s32(0); off.u8(0x0b);
      this.elems.push({ mode: "active", table: idx, offset: off, funcs: items });
    } else {
      const lim = this.limits(c);
      const rt = REFTYPES[this.atom(c)];
      if (rt === undefined) throw this.err(c, "expected a table reference type");
      this.tables.push({ lim, rt });
    }
    for (const e of exports) this.exports.push({ name: e, kind: 1, index: idx });
    this.expectRP(c);
  }

  fMemory(c) {
    const name = this.optId(c);
    const exports = this.inlineExports(c);
    const imp = this.inlineImport(c);
    if (imp) { this.importDesc(c, "memory", name, imp, exports); this.expectRP(c); return; }
    const idx = this.mems.length;
    if (name) this.memNames.set(name, idx);
    if (this.isForm(c, "data")) {
      c.i += 2;
      const parts = [];
      while (c.k[c.i] === T_STR) parts.push(this.str(c));
      this.expectRP(c);
      const len = parts.reduce((a, p) => a + p.length, 0);
      const pages = Math.ceil(len / 65536);
      this.mems.push({ lim: { min: pages, max: pages } });
      const off = new W(8); off.u8(0x41); off.s32(0); off.u8(0x0b);
      this.datas.push({ mode: "active", mem: idx, offset: off, parts, len });
    } else {
      this.mems.push({ lim: this.limits(c) });
    }
    for (const e of exports) this.exports.push({ name: e, kind: 2, index: idx });
    this.expectRP(c);
  }

  fGlobal(c) {
    const name = this.optId(c);
    const exports = this.inlineExports(c);
    const imp = this.inlineImport(c);
    if (imp) { this.importDesc(c, "global", name, imp, exports); this.expectRP(c); return; }
    const gt = this.globalType(c);
    const init = new W(16);
    this.instrs(c, init, { locals: new Map(), nlocals: 0, labels: [] }, false);
    init.u8(0x0b);
    this.expectRP(c);
    const idx = this.globals.length;
    if (name) this.globalNames.set(name, idx);
    this.globals.push({ gt, init });
    for (const e of exports) this.exports.push({ name: e, kind: 3, index: idx });
  }

  fExport(c) {
    const name = Buffer.from(this.str(c)).toString("utf8");
    this.expectLP(c);
    const kw = this.atom(c);
    const ref = this.atom(c);
    this.expectRP(c); this.expectRP(c);
    const kinds = { func: [0, SP_FUNC], table: [1, SP_TABLE], memory: [2, SP_MEMORY], global: [3, SP_GLOBAL] };
    const k = kinds[kw];
    if (!k) throw this.err(c, `unknown export kind '${kw}'`);
    if (ref[0] === "$") this.exports.push({ name, kind: k[0], sym: this.sym(k[1], ref) });
    else this.exports.push({ name, kind: k[0], index: parseU32(ref) });
  }

  fStart(c) {
    const ref = this.atom(c);
    this.expectRP(c);
    this.start = ref[0] === "$" ? { sym: this.sym(SP_FUNC, ref) } : { index: parseU32(ref) };
  }

  offsetExpr(c) {
    const w = new W(16);
    const fc = { locals: new Map(), nlocals: 0, labels: [] };
    if (this.isForm(c, "offset")) {
      c.i += 2;
      this.instrs(c, w, fc, false);
      this.expectRP(c);
    } else {
      this.folded(c, w, fc);
    }
    w.u8(0x0b);
    return w;
  }

  fElem(c) {
    const name = this.optId(c);
    const idx = this.elems.length;
    if (name) this.elemNames.set(name, idx);
    let mode = "passive", table = 0, offset = null;
    if (c.k[c.i] === T_ATOM && c.v[c.i] === "declare") { c.i++; mode = "declare"; }
    else {
      if (this.isForm(c, "table")) {
        c.i += 2; const t = this.atom(c); this.expectRP(c);
        table = t[0] === "$" ? this.tableNames.get(t) : parseU32(t);
        if (table === undefined) throw this.err(c, `unknown table ${t}`);
        mode = "active";
      } else if (c.k[c.i] === T_ATOM && c.v[c.i][0] === "$" && this.tableNames.has(c.v[c.i]) && c.k[c.i + 1] === T_LP) {
        table = this.tableNames.get(this.atom(c)); mode = "active";
      }
      if (c.k[c.i] === T_LP && c.v[c.i + 1] !== "item" && c.v[c.i + 1] !== "ref.func" && c.v[c.i + 1] !== "ref.null") {
        offset = this.offsetExpr(c); mode = "active";
      }
    }
    // element list
    const funcs = [];
    if (c.k[c.i] === T_ATOM && (c.v[c.i] === "func" || c.v[c.i] === "funcref")) {
      const kw = this.atom(c);
      if (kw === "funcref") {
        while (c.k[c.i] === T_LP) funcs.push(this.elemExprFunc(c));
      } else {
        while (c.k[c.i] === T_ATOM) funcs.push(this.atom(c));
      }
    } else {
      while (c.k[c.i] === T_ATOM) funcs.push(this.atom(c));
      while (c.k[c.i] === T_LP) funcs.push(this.elemExprFunc(c));
    }
    this.expectRP(c);
    this.elems.push({ mode, table, offset, funcs });
  }

  elemExprFunc(c) {
    this.expectLP(c);
    let kw = this.atom(c);
    let wrapped = false;
    if (kw === "item") { wrapped = true; this.expectLP(c); kw = this.atom(c); }
    if (kw !== "ref.func") throw this.err(c, "only ref.func element expressions are supported");
    const f = this.atom(c);
    this.expectRP(c);
    if (wrapped) this.expectRP(c);
    return f;
  }

  fData(c) {
    const name = this.optId(c);
    const idx = this.datas.length;
    if (name) this.dataNames.set(name, idx);
    let mem = 0, offset = null, mode = "passive";
    if (this.isForm(c, "memory")) {
      c.i += 2; const m = this.atom(c); this.expectRP(c);
      mem = m[0] === "$" ? this.memNames.get(m) : parseU32(m);
      mode = "active";
    } else if (c.k[c.i] === T_ATOM && c.v[c.i][0] === "$" && this.memNames.has(c.v[c.i])) {
      mem = this.memNames.get(this.atom(c)); mode = "active";
    }
    if (c.k[c.i] === T_LP) { offset = this.offsetExpr(c); mode = "active"; }
    const parts = [];
    let len = 0;
    while (c.k[c.i] === T_STR) { const s = this.str(c); parts.push(s); len += s.length; }
    this.expectRP(c);
    this.datas.push({ mode, mem, offset, parts, len });
  }

  // --- instructions ------------------------------------------------------------

  /**
   * Encode an instruction sequence until ')' (or end of tokens, or a flat
   * 'end'/'else' which the caller consumes).
   */
  instrs(c, w, fc, isFuncBody) {
    const k = c.k, v = c.v;
    for (;;) {
      const t = k[c.i];
      if (t === T_RP || t === undefined) return;
      if (t === T_LP) { this.folded(c, w, fc); continue; }
      if (t !== T_ATOM) throw this.err(c, "unexpected string in instruction sequence");
      const kw = v[c.i];
      if (kw === "end" || kw === "else") return;
      this.flat(c, w, fc);
    }
  }

  labelDepth(c, fc, tok) {
    if (tok[0] === "$") {
      const L = fc.labels;
      for (let j = L.length - 1; j >= 0; j--) if (L[j] === tok) return L.length - 1 - j;
      throw this.err(c, `unknown label ${tok}`);
    }
    return parseU32(tok);
  }

  /** Parse a block type after the (optional) label; write it. */
  blockType(c, w) {
    const k = c.k, v = c.v;
    let typeRef = null;
    if (k[c.i] === T_LP && k[c.i + 1] === T_ATOM && v[c.i + 1] === "type") { c.i += 2; typeRef = this.atom(c); this.expectRP(c); }
    let params = null, results = null;
    while (k[c.i] === T_LP && k[c.i + 1] === T_ATOM && v[c.i + 1] === "param") {
      c.i += 2; params = params || [];
      if (k[c.i] === T_ATOM && v[c.i][0] === "$") throw this.err(c, "block params cannot be named");
      while (k[c.i] === T_ATOM) params.push(valtype(this.atom(c)));
      this.expectRP(c);
    }
    while (k[c.i] === T_LP && k[c.i + 1] === T_ATOM && v[c.i + 1] === "result") {
      c.i += 2; results = results || [];
      while (k[c.i] === T_ATOM) results.push(valtype(this.atom(c)));
      this.expectRP(c);
    }
    if (typeRef !== null) {
      if (typeRef[0] === "$") {
        const idx = this.typeNames.get(typeRef);
        if (idx !== undefined) w.s32(idx); else throw this.err(c, `unknown type ${typeRef}`);
      } else w.s32(parseU32(typeRef));
      return;
    }
    if (!params && (!results || results.length === 0)) { w.u8(0x40); return; }
    if (!params && results.length === 1) { w.u8(results[0]); return; }
    const key = this.useImplicit(params || [], results || []);
    w.reloc(this.sym(SP_TYPEKEY, key));
  }

  /** Folded instruction starting at '('. */
  folded(c, w, fc) {
    const k = c.k, v = c.v;
    c.i++; // (
    if (k[c.i] !== T_ATOM) throw this.err(c, "expected an instruction name after '('");
    const kw = v[c.i++];
    if (BLOCK_KW.has(kw)) {
      const label = this.optId(c);
      if (kw === "if") {
        // blocktype comes first textually, but the condition is emitted first
        const btStart = c.i;
        // skip the blocktype forms
        while (k[c.i] === T_LP && k[c.i + 1] === T_ATOM && (v[c.i + 1] === "type" || v[c.i + 1] === "param" || v[c.i + 1] === "result")) this.skipForm(c);
        while (k[c.i] === T_LP && !(k[c.i + 1] === T_ATOM && (v[c.i + 1] === "then"))) this.folded(c, w, fc);
        const afterCond = c.i;
        c.i = btStart;
        w.u8(0x04);
        this.blockType(c, w);
        c.i = afterCond;
        fc.labels.push(label);
        if (!(k[c.i] === T_LP && v[c.i + 1] === "then")) throw this.err(c, "folded if needs (then ...)");
        c.i += 2;
        this.instrs(c, w, fc, false);
        this.expectRP(c);
        if (k[c.i] === T_LP && k[c.i + 1] === T_ATOM && v[c.i + 1] === "else") {
          c.i += 2;
          w.u8(0x05);
          this.instrs(c, w, fc, false);
          this.expectRP(c);
        }
        fc.labels.pop();
        w.u8(0x0b);
        this.expectRP(c);
        return;
      }
      w.u8(kw === "block" ? 0x02 : 0x03);
      this.blockType(c, w);
      fc.labels.push(label);
      this.instrs(c, w, fc, false);
      fc.labels.pop();
      w.u8(0x0b);
      this.expectRP(c);
      return;
    }
    const d = OPS.get(kw);
    if (!d) throw this.unknownOp(c, kw);
    const immStart = c.i;
    // skip immediates: atoms and (type|param|result ...) forms
    for (;;) {
      if (k[c.i] === T_ATOM) { c.i++; continue; }
      if (k[c.i] === T_LP && k[c.i + 1] === T_ATOM && (v[c.i + 1] === "type" || v[c.i + 1] === "param" || v[c.i + 1] === "result")) { this.skipForm(c); continue; }
      break;
    }
    // operands
    while (k[c.i] === T_LP) this.folded(c, w, fc);
    if (k[c.i] !== T_RP) throw this.err(c, `expected ')' to close (${kw} ...)`);
    const end = c.i;
    c.i = immStart;
    this.writeOp(c, w, fc, d, kw);
    if (c.i !== immStart && c.i > end) throw this.err(c, "immediate parse overran");
    c.i = end + 1;
  }

  unknownOp(c, kw) {
    if (/^(v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./.test(kw)) return this.err(c, `SIMD instruction '${kw}' is not supported by this assembler`);
    return this.err(c, `unknown instruction '${kw}'`);
  }

  /** Flat instruction at an atom. */
  flat(c, w, fc) {
    const k = c.k, v = c.v;
    const kw = v[c.i++];
    if (BLOCK_KW.has(kw)) {
      const label = this.optId(c);
      w.u8(kw === "block" ? 0x02 : kw === "loop" ? 0x03 : 0x04);
      this.blockType(c, w);
      fc.labels.push(label);
      this.instrs(c, w, fc, false);
      if (kw === "if" && k[c.i] === T_ATOM && v[c.i] === "else") {
        c.i++;
        if (k[c.i] === T_ATOM && v[c.i][0] === "$") c.i++;
        w.u8(0x05);
        this.instrs(c, w, fc, false);
      }
      if (!(k[c.i] === T_ATOM && v[c.i] === "end")) throw this.err(c, `expected 'end' for ${kw}`);
      c.i++;
      if (k[c.i] === T_ATOM && v[c.i][0] === "$" && v[c.i] === label) c.i++;
      fc.labels.pop();
      w.u8(0x0b);
      return;
    }
    const d = OPS.get(kw);
    if (!d) { c.i--; throw this.unknownOp(c, kw); }
    this.writeOp(c, w, fc, d, kw);
  }

  /** Write opcode + immediates, parsing immediates from c.i (advances c.i past them). */
  writeOp(c, w, fc, d, kw) {
    const k = c.k, v = c.v;
    if (d.prefix) { w.u8(d.prefix); w.u32(d.code); } else w.u8(d.code);
    switch (d.imm) {
      case I_NONE: return;
      case I_I32: w.s32(parseI32(this.atom(c))); return;
      case I_LOCAL: {
        const t = this.atom(c);
        if (t[0] === "$") { const x = fc.locals.get(t); if (x === undefined) throw this.err(c, `unknown local ${t}`); w.u32(x); }
        else w.u32(parseU32(t));
        return;
      }
      case I_GLOBAL: this.writeRef(w, SP_GLOBAL, this.atom(c)); return;
      case I_FUNC: this.writeRef(w, SP_FUNC, this.atom(c)); return;
      case I_LABEL: w.u32(this.labelDepth(c, fc, this.atom(c))); return;
      case I_MEM: {
        let offset = 0, align = d.align;
        if (k[c.i] === T_ATOM && (v[c.i][0] === "$" || /^[0-9]/.test(v[c.i]))) {
          const m = this.atom(c);
          if ((m[0] === "$" ? this.memNames.get(m) : parseU32(m)) !== 0) throw this.err(c, "multi-memory is not supported");
        }
        while (k[c.i] === T_ATOM) {
          const t = v[c.i];
          if (t.startsWith("offset=")) { offset = parseU32(t.slice(7)); c.i++; }
          else if (t.startsWith("align=")) {
            const a = parseU32(t.slice(6));
            if (a === 0 || (a & (a - 1)) !== 0) throw this.err(c, `alignment must be a power of two: ${t}`);
            align = 31 - Math.clz32(a); c.i++;
          } else break;
        }
        w.u32(align); w.u32(offset);
        return;
      }
      case I_BRTABLE: {
        const labels = [];
        while (k[c.i] === T_ATOM && (v[c.i][0] === "$" || /^[0-9]/.test(v[c.i]))) labels.push(this.labelDepth(c, fc, v[c.i++]));
        if (!labels.length) throw this.err(c, "br_table needs at least a default label");
        w.u32(labels.length - 1);
        for (const l of labels) w.u32(l);
        return;
      }
      case I_I64: w.s64(parseI64(this.atom(c))); return;
      case I_F32: {
        const bits = parseF32Bits(this.atom(c));
        w.ensure(4); w.b[w.n++] = bits & 0xff; w.b[w.n++] = (bits >>> 8) & 0xff; w.b[w.n++] = (bits >>> 16) & 0xff; w.b[w.n++] = (bits >>> 24) & 0xff;
        return;
      }
      case I_F64: w.bytes(parseF64Bytes(this.atom(c))); return;
      case I_CALLIND: {
        let table = "0";
        if (k[c.i] === T_ATOM) table = this.atom(c);
        const tu = this.typeUse(c, false);
        if (tu.typeRef !== null) {
          if (tu.typeRef[0] === "$") {
            const x = this.typeNames.get(tu.typeRef);
            if (x !== undefined) w.u32(x); else w.reloc(this.sym(SP_TYPE, tu.typeRef));
          } else w.u32(parseU32(tu.typeRef));
        } else {
          w.reloc(this.sym(SP_TYPEKEY, this.useImplicit(tu.params, tu.results)));
        }
        this.writeRef(w, SP_TABLE, table);
        return;
      }
      case I_SELECT: {
        const types = [];
        while (k[c.i] === T_LP && k[c.i + 1] === T_ATOM && v[c.i + 1] === "result") {
          c.i += 2; while (k[c.i] === T_ATOM) types.push(valtype(this.atom(c))); this.expectRP(c);
        }
        if (types.length) { w.b[w.n - 1] = 0x1c; w.u32(types.length); for (const t of types) w.u8(t); }
        return;
      }
      case I_MEMIDX:
        if (k[c.i] === T_ATOM && (v[c.i][0] === "$" || /^[0-9]/.test(v[c.i]))) c.i++;
        w.u8(0);
        return;
      case I_MEMCOPY:
        while (k[c.i] === T_ATOM && (v[c.i][0] === "$" || /^[0-9]/.test(v[c.i]))) c.i++;
        w.u8(0); w.u8(0);
        return;
      case I_MEMINIT:
        this.usesDataCount = true;
        this.writeRef(w, SP_DATA, this.atom(c)); w.u8(0);
        return;
      case I_DATA:
        this.usesDataCount = true;
        this.writeRef(w, SP_DATA, this.atom(c));
        return;
      case I_TABLE: {
        let t = "0";
        if (k[c.i] === T_ATOM && (v[c.i][0] === "$" || /^[0-9]/.test(v[c.i]))) t = this.atom(c);
        this.writeRef(w, SP_TABLE, t);
        return;
      }
      case I_TABLEINIT: {
        const a = this.atom(c);
        if (k[c.i] === T_ATOM) { const b = this.atom(c); this.writeRef(w, SP_ELEM, b); this.writeRef(w, SP_TABLE, a); }
        else { this.writeRef(w, SP_ELEM, a); w.u32(0); }
        return;
      }
      case I_TABLECOPY: {
        let a = "0", b = "0";
        if (k[c.i] === T_ATOM) { a = this.atom(c); b = this.atom(c); }
        this.writeRef(w, SP_TABLE, a); this.writeRef(w, SP_TABLE, b);
        return;
      }
      case I_ELEM: this.writeRef(w, SP_ELEM, this.atom(c)); return;
      case I_REFNULL: {
        const t = REFTYPES[this.atom(c)];
        if (t === undefined) throw this.err(c, "ref.null needs func or extern");
        w.u8(t);
        return;
      }
      default: throw this.err(c, `internal: immediate kind ${d.imm} for ${kw}`);
    }
  }

  // --- final write ---------------------------------------------------------------

  /** Write a small encoded chunk with its relocs resolved. */
  resolved(wch) {
    if (!wch.relPos.length) return wch.view();
    const out = new W(wch.n + wch.relPos.length * 5);
    let p = 0;
    for (let j = 0; j < wch.relPos.length; j++) {
      out.bytes(wch.b.subarray(p, wch.relPos[j]));
      const s = this.syms[wch.relSym[j]];
      const val = this.resolveSym(wch.relSym[j]);
      if (s.space === SP_TYPEKEY) out.s32(val); else out.u32(val);
      p = wch.relPos[j];
    }
    out.bytes(wch.b.subarray(p, wch.n));
    return out.view();
  }

  section(out, id, w) {
    out.write(new Uint8Array([id]));
    out.write(encU(w.n));
    out.write(w.view());
  }

  finish() {
    const out = new Out(this.opts.outputPath);
    try {
      this.finalizeTypes();
      const types = this.finalTypes;
      out.write(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
      // Resolve every symbol once (and report unknowns before writing code).
      const symVal = new Int32Array(this.syms.length);
      for (let j = 0; j < this.syms.length; j++) symVal[j] = this.resolveSym(j);
      const funcTypeIdx = (f) => {
        if (f.typeRef !== null) {
          const x = f.typeRef[0] === "$" ? this.typeNames.get(f.typeRef) : parseU32(f.typeRef);
          if (x === undefined) throw new Error(`WAT: unknown type ${f.typeRef}`);
          return x;
        }
        return this.keyIndex.get(f.key);
      };
      // type
      if (types.length) {
        const w = new W();
        w.u32(types.length);
        for (const t of types) { w.u8(0x60); w.u32(t.params.length); for (const p of t.params) w.u8(p); w.u32(t.results.length); for (const r of t.results) w.u8(r); }
        this.section(out, 1, w);
      }
      // import
      if (this.imports.length) {
        const w = new W();
        w.u32(this.imports.length);
        for (const im of this.imports) {
          w.u32(im.module.length); w.bytes(im.module); w.u32(im.field.length); w.bytes(im.field);
          w.u8(im.kind);
          if (im.kind === 0) w.u32(funcTypeIdx(im.func));
          else if (im.kind === 1) { w.u8(im.rt); this.writeLimits(w, im.lim); }
          else if (im.kind === 2) this.writeLimits(w, im.lim);
          else { w.u8(im.gt.t); w.u8(im.gt.mut); }
        }
        this.section(out, 2, w);
      }
      // function
      const defined = this.funcs.filter((f) => !f.imported);
      if (defined.length !== this.nDefinedFuncs) throw new Error("WAT: internal function count mismatch");
      if (defined.length) {
        const w = new W();
        w.u32(defined.length);
        for (const f of defined) w.u32(funcTypeIdx(f));
        this.section(out, 3, w);
      }
      // table
      const dTables = this.tables.filter((t) => !t.imported);
      if (dTables.length) {
        const w = new W();
        w.u32(dTables.length);
        for (const t of dTables) { w.u8(t.rt); this.writeLimits(w, t.lim); }
        this.section(out, 4, w);
      }
      // memory
      const dMems = this.mems.filter((m) => !m.imported);
      if (dMems.length) {
        const w = new W();
        w.u32(dMems.length);
        for (const m of dMems) this.writeLimits(w, m.lim);
        this.section(out, 5, w);
      }
      // global
      const dGlobals = this.globals.filter((g) => !g.imported);
      if (dGlobals.length) {
        const w = new W();
        w.u32(dGlobals.length);
        for (const g of dGlobals) { w.u8(g.gt.t); w.u8(g.gt.mut); w.bytes(this.resolved(g.init)); }
        this.section(out, 6, w);
      }
      // export
      if (this.exports.length) {
        const w = new W();
        w.u32(this.exports.length);
        const seen = new Set();
        for (const e of this.exports) {
          if (seen.has(e.name)) throw new Error(`WAT: duplicate export name "${e.name}"`);
          seen.add(e.name);
          w.name(e.name); w.u8(e.kind);
          w.u32(e.sym !== undefined ? symVal[e.sym] : e.index);
        }
        this.section(out, 7, w);
      }
      // start
      if (this.start) {
        const w = new W();
        w.u32(this.start.sym !== undefined ? symVal[this.start.sym] : this.start.index);
        this.section(out, 8, w);
      }
      // element
      if (this.elems.length) {
        const w = new W();
        w.u32(this.elems.length);
        const fidx = (f) => (f[0] === "$" ? this.resolveSym(this.sym(SP_FUNC, f)) : parseU32(f));
        for (const e of this.elems) {
          if (e.mode === "active") {
            if (e.table === 0) { w.u32(0); w.bytes(this.resolved(e.offset)); }
            else { w.u32(2); w.u32(e.table); w.bytes(this.resolved(e.offset)); w.u8(0); }
          } else if (e.mode === "passive") { w.u32(1); w.u8(0); }
          else { w.u32(3); w.u8(0); }
          w.u32(e.funcs.length);
          for (const f of e.funcs) w.u32(fidx(f));
        }
        this.section(out, 9, w);
      }
      // datacount
      if (this.usesDataCount) { const w = new W(); w.u32(this.datas.length); this.section(out, 12, w); }
      // code: sizes first
      const meta = this.bodyMeta;
      const relPos = this.bodyRelPos.a, relSym = this.bodyRelSym.a;
      const nb = meta.length / 3;
      const bodySizes = new Float64Array(nb);
      let codeLen = lebLenU(nb);
      for (let f = 0; f < nb; f++) {
        let size = meta[3 * f];
        for (let r = meta[3 * f + 1]; r < meta[3 * f + 2]; r++) {
          const s = this.syms[relSym[r]];
          size += s.space === SP_TYPEKEY ? lebLenS(symVal[relSym[r]]) : lebLenU(symVal[relSym[r]]);
        }
        bodySizes[f] = size;
        codeLen += lebLenU(size) + size;
      }
      let codeBytes = 0;
      if (nb) {
        out.write(new Uint8Array([10]));
        out.write(encU(codeLen));
        out.write(encU(nb));
        const tmp = new W(16);
        let f = 0;
        for (const body of this.store.bodies()) {
          out.write(encU(bodySizes[f]));
          let p = 0;
          for (let r = meta[3 * f + 1]; r < meta[3 * f + 2]; r++) {
            const pos = relPos[r];
            if (pos > p) out.write(body.subarray(p, pos));
            tmp.reset();
            const sid = relSym[r];
            if (this.syms[sid].space === SP_TYPEKEY) tmp.s32(symVal[sid]); else tmp.u32(symVal[sid]);
            out.write(tmp.view().slice());
            p = pos;
          }
          if (p < body.length) out.write(body.subarray(p));
          f++;
        }
        codeBytes = codeLen;
      }
      // data
      let dataBytes = 0;
      if (this.datas.length) {
        const hdrs = [];
        let len = lebLenU(this.datas.length);
        for (const d of this.datas) {
          const h = new W();
          if (d.mode === "active") {
            if (d.mem === 0) h.u32(0); else { h.u32(2); h.u32(d.mem); }
            h.bytes(this.resolved(d.offset));
          } else h.u32(1);
          h.u32(d.len);
          hdrs.push(h);
          len += h.n + d.len;
        }
        out.write(new Uint8Array([11]));
        out.write(encU(len));
        out.write(encU(this.datas.length));
        this.datas.forEach((d, j) => { out.write(hdrs[j].view()); for (const p of d.parts) out.write(p); dataBytes += d.len; });
      }
      // name section (function names)
      if (this.opts.names !== false) {
        const named = [];
        this.funcs.forEach((f, j) => { if (f.name) named.push([j, f.name.slice(1)]); });
        if (named.length) {
          const sub = new W();
          sub.u32(named.length);
          for (const [j, nm] of named) { sub.u32(j); sub.name(nm); }
          const w = new W();
          w.name("name");
          w.u8(1); w.u32(sub.n); w.bytes(sub.view());
          this.section(out, 0, w);
        }
      }
      // extra custom sections
      for (const cs of this.opts.customSections || []) {
        const data = typeof cs.data === "string" ? new Uint8Array(Buffer.from(cs.data, "utf8")) : cs.data;
        const w = new W(data.length + 64);
        w.name(cs.name);
        w.bytes(data);
        this.section(out, 0, w);
      }
      const mem = out.close();
      return {
        bytes: mem,
        size: out.total,
        functions: this.funcs.length,
        definedFunctions: nb,
        codeBytes,
        dataBytes,
        types: types.length,
        globals: this.globals.length,
      };
    } finally {
      this.store.close();
      if (out.fd >= 0) { try { closeSync(out.fd); } catch { /* closed */ } }
    }
  }

  writeLimits(w, lim) {
    const flag = (lim.max !== null && lim.max !== undefined ? 1 : 0) | (lim.shared ? 2 : 0);
    w.u8(flag); w.u32(lim.min);
    if (flag & 1) w.u32(lim.max);
  }
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Assemble WAT text into a wasm binary.
 *
 * @param {string | Iterable<string> | AsyncIterable<string>} source
 *   The module text: one string, or chunks of any size (a generator that
 *   yields function by function is the intended use).
 * @param {object} [opts]
 * @param {string} [opts.outputPath]  write the binary here (streamed; encoded
 *   bodies spill to `<outputPath>.code.tmp`, removed afterwards). Without it
 *   the binary is returned as `bytes`.
 * @param {boolean} [opts.names=true]  emit a `name` section with function names
 *   (trap stack traces then name the function).
 * @param {{name: string, data: Uint8Array | string}[]} [opts.customSections]
 *   extra custom sections appended at the end (e.g. `romdev.recompile`).
 * @param {(info: {fields: number, textChars: number}) => void} [opts.onProgress]
 * @returns {Promise<{bytes: Uint8Array | null, size: number, functions: number,
 *   definedFunctions: number, codeBytes: number, dataBytes: number, types: number,
 *   globals: number, textChars: number, fields: number}>}
 */
export async function assembleWat(source, opts = {}) {
  const asm = new Assembler(opts);
  let fields = 0, textChars = 0;
  const splitter = new FieldSplitter((text) => {
    fields++;
    asm.field(text);
    if (opts.onProgress && (fields & 1023) === 0) opts.onProgress({ fields, textChars });
  });
  try {
    if (typeof source === "string") { textChars += source.length; splitter.feed(source); }
    else if (source && typeof source[Symbol.asyncIterator] === "function") {
      for await (const chunk of source) { textChars += chunk.length; splitter.feed(chunk); }
    } else if (source && typeof source[Symbol.iterator] === "function") {
      for (const chunk of source) { textChars += chunk.length; splitter.feed(chunk); }
    } else throw new Error("assembleWat: source must be a string or an (async) iterable of strings");
    splitter.end();
  } catch (e) {
    asm.store.close();
    throw e;
  }
  const res = asm.finish();
  return { ...res, textChars, fields };
}

/** Synchronous convenience for small modules (tests, tiny carts). Returns the bytes. */
export function assembleWatSync(text, opts = {}) {
  const asm = new Assembler({ ...opts, outputPath: undefined });
  const splitter = new FieldSplitter((t) => asm.field(t));
  splitter.feed(text);
  splitter.end();
  return asm.finish().bytes;
}
