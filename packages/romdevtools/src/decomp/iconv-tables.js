// iconv-tables.js - encoders that reproduce glibc iconv's UTF-8 -> SHIFT-JIS /
// EUC-JP / EUC-CN conversions, byte for byte, for a project's
// `... | iconv --to-code=X | ...` build step.
//
// JS has decoders for these (WHATWG) but no encoders. Each table is the
// inverse of the WHATWG decoder restricted to the code ranges glibc's charset
// actually covers, plus the handful of code points where glibc maps
// differently. Every table was checked against glibc iconv over all of the
// BMP (test/decomp-wasm-toolchain.test.js pins representative entries).
let cache = new Map();

// glibc SHIFT_JIS = JIS X 0201 (Roman + half-width katakana) + JIS X 0208.
// WHATWG's Shift_JIS adds NEC row 13 (lead 0x87), the NEC-selected IBM
// extensions (0xED/0xEE) and IBM extensions (0xFA-0xFC); glibc has none.
const SJIS_LEADS = (b) => (b >= 0x81 && b <= 0x84) || (b >= 0x88 && b <= 0x9f) || (b >= 0xe0 && b <= 0xea);
const SJIS_OVERRIDES = [
  [0x00a2, [0x81, 0x91]], [0x00a3, [0x81, 0x92]], [0x00a5, [0x5c]], [0x00ac, [0x81, 0xca]],
  [0x2016, [0x81, 0x61]], [0x203e, [0x7e]], [0x2212, [0x81, 0x7c]], [0x301c, [0x81, 0x60]],
];
// Code points WHATWG maps into JIS X 0208 cells glibc gives to the override
// characters instead (glibc also keeps U+FFE0-U+FFE2 on those cells).
const SJIS_DROP = [0xff5e, 0x2225, 0xff0d];

// glibc EUC-JP = ASCII + C1 controls (single bytes 0x80-0x8D, 0x90-0x9F) +
// JIS X 0208 + half-width katakana (0x8E) + JIS X 0212 (0x8F).
const EUCJP_OVERRIDES = [
  [0x00a5, [0x5c]], [0x203e, [0x7e]],
  [0x00a2, [0xa1, 0xf1]], [0x00a3, [0xa1, 0xf2]], [0x00ac, [0xa2, 0xcc]],
  [0x2016, [0xa1, 0xc2]], [0x2212, [0xa1, 0xdd]], [0x301c, [0xa1, 0xc1]],
];
// (Unlike SHIFT_JIS, glibc EUC-JP has no mapping at all for U+FFE0-U+FFE2.)
const EUCJP_DROP = [0xff5e, 0x2225, 0xff0d, 0xffe0, 0xffe1, 0xffe2];

// glibc EUC-CN = ASCII + GB 2312 (iconvdata/gb2312.c, generated from the
// Unicode consortium's GB2312.TXT). Its cells are the GB 2312 code chart: rows
// 0xA1-0xA9 (symbols) and 0xB0-0xF7 (hanzi) with these partial rows, every
// other listed row full (0xA1-0xFE). WHATWG's GBK decoder agrees on every one
// of those 7445 cells except two, where GB2312.TXT keeps the GB 2312 reading.
// There are no C1 single bytes: glibc rejects 0x80-0xA0 outright.
const GB2312_ROWS = [[0xa1, 0xa9], [0xb0, 0xf7]];
const GB2312_PARTIAL = {
  0xa2: [[0xb1, 0xe2], [0xe5, 0xee], [0xf1, 0xfc]], 0xa4: [[0xa1, 0xf3]], 0xa5: [[0xa1, 0xf6]],
  0xa6: [[0xa1, 0xb8], [0xc1, 0xd8]], 0xa7: [[0xa1, 0xc1], [0xd1, 0xf1]], 0xa8: [[0xa1, 0xba], [0xc5, 0xe9]],
  0xa9: [[0xa4, 0xef]], 0xd7: [[0xa1, 0xf9]],
};
const GB2312_OVERRIDES = [[0x30fb, [0xa1, 0xa4]], [0x2015, [0xa1, 0xaa]]]; // GBK: U+00B7, U+2014

function invert(label, candidates) {
  const dec = new TextDecoder(label);
  const map = new Map();
  for (const bytes of candidates) {
    const s = dec.decode(Uint8Array.from(bytes));
    if (s.length !== 1 || s === "\ufffd") continue;
    const cp = s.charCodeAt(0);
    if (cp < 0x80) continue;
    if (!map.has(cp)) map.set(cp, bytes);
  }
  return map;
}

function* sjisCandidates() {
  for (let b = 0xa1; b <= 0xdf; b++) yield [b];
  for (let a = 0x81; a <= 0xef; a++) {
    if (!SJIS_LEADS(a)) continue;
    for (let b = 0x40; b <= 0xfc; b++) if (b !== 0x7f) yield [a, b];
  }
}
function* eucjp0208Candidates() {
  for (let a = 0xa1; a <= 0xfe; a++) for (let b = 0xa1; b <= 0xfe; b++) yield [a, b];
  for (let b = 0xa1; b <= 0xdf; b++) yield [0x8e, b];
}
function* eucjp0212Candidates() {
  // Rows 0xF3-0xFE of the 0x8F plane are IBM extensions glibc does not have.
  for (let a = 0xa1; a <= 0xf2; a++) for (let b = 0xa1; b <= 0xfe; b++) yield [0x8f, a, b];
}

function* gb2312Candidates() {
  for (const [lo, hi] of GB2312_ROWS) for (let a = lo; a <= hi; a++) {
    for (const [c0, c1] of GB2312_PARTIAL[a] ?? [[0xa1, 0xfe]]) for (let b = c0; b <= c1; b++) yield [a, b];
  }
}

function build(name) {
  let map;
  if (name === "shiftjis") {
    map = invert("shift_jis", sjisCandidates());
    for (const c of SJIS_DROP) map.delete(c);
    for (const [c, b] of SJIS_OVERRIDES) map.set(c, b);
  } else if (name === "eucjp") {
    map = invert("euc-jp", eucjp0208Candidates());
    // glibc has no NEC row 13 (0xAD) or IBM extension rows (0xF9-0xFE); a
    // character WHATWG places there comes from JIS X 0212 (0x8F) instead.
    for (const [c, b] of [...map]) {
      if (b[0] === 0xad || (b[0] >= 0xf9 && b[0] <= 0xfe)) map.delete(c);
    }
    for (const c of EUCJP_DROP) map.delete(c);
    for (const [c, b] of invert("euc-jp", eucjp0212Candidates())) if (!map.has(c)) map.set(c, b);
    for (const c of EUCJP_DROP) if (map.get(c)?.[0] !== 0x8f) map.delete(c);
    for (const [c, b] of EUCJP_OVERRIDES) map.set(c, b);
    for (let c = 0x80; c <= 0x9f; c++) if (c !== 0x8e && c !== 0x8f) map.set(c, [c]);
  } else if (name === "euccn") {
    map = invert("gbk", gb2312Candidates());
    for (const [, b] of GB2312_OVERRIDES) for (const [c, v] of [...map]) if (v[0] === b[0] && v[1] === b[1]) map.delete(c);
    for (const [c, b] of GB2312_OVERRIDES) map.set(c, b);
  } else throw new Error(`no table for ${name}`);
  return map;
}

/** Normalised charset name, or null if this module has no table for it. */
export function tableName(encoding) {
  const n = String(encoding).toLowerCase().replace(/[_-]/g, "");
  if (["shiftjis", "sjis", "mskanji", "csshiftjis"].includes(n)) return "shiftjis";
  if (["eucjp", "ujis"].includes(n)) return "eucjp";
  if (["euccn", "gb2312", "cseuccn", "csgb2312"].includes(n)) return "euccn";
  return null;
}

/** Encode text as glibc iconv would to `encoding`; throws on an unencodable character (iconv without -c). */
export function iconvEncode(text, encoding) {
  const name = tableName(encoding);
  if (!name) throw new Error(`no encoder for ${encoding}`);
  let map = cache.get(name);
  if (!map) { map = build(name); cache.set(name, map); }
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    if (cp < 0x80) { out.push(cp); continue; }
    const b = map.get(cp);
    if (!b) throw Object.assign(new Error(`cannot convert U+${cp.toString(16).toUpperCase().padStart(4, "0")} to ${encoding}`), { code: "ICONV_ILLEGAL" });
    out.push(...b);
  }
  return Buffer.from(out);
}

/** Dev-time check helper: the full table for an encoding (code point -> bytes). */
export function iconvTable(encoding) {
  const name = tableName(encoding);
  let map = cache.get(name);
  if (!map) { map = build(name); cache.set(name, map); }
  return map;
}
