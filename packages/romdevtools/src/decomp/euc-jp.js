// euc-jp.js - EUC-JP encoding as Python's `euc_jp` codec does it (asm-processor
// --output-enc=euc-jp, and `iconv --to-code=EUC-JP` in a project's asm rule).
//
// JS has an EUC-JP decoder (WHATWG) but no encoder. The table is the inverse
// of that decoder over every two-byte JIS X 0208 code and the SS2 half-width
// katakana, with the rows where WHATWG's JIS X 0208 index differs from the
// JIS X 0208 mapping CPython (and iconv) use put back. WHATWG-only extension
// rows (NEC row 13, the IBM/NEC selected extensions) are left unencodable, as
// in CPython.
let table = null;

// EUC-JP bytes -> the code point CPython/iconv decode them to, where WHATWG differs.
const JISX0208_OVERRIDES = [
  [0xa1c1, 0x301c], // WAVE DASH (WHATWG: FULLWIDTH TILDE)
  [0xa1c2, 0x2016], // DOUBLE VERTICAL LINE (WHATWG: PARALLEL TO)
  [0xa1dd, 0x2212], // MINUS SIGN (WHATWG: FULLWIDTH HYPHEN-MINUS)
  [0xa1f1, 0x00a2], // CENT SIGN (WHATWG: FULLWIDTH CENT SIGN)
  [0xa1f2, 0x00a3], // POUND SIGN (WHATWG: FULLWIDTH POUND SIGN)
  [0xa2cc, 0x00ac], // NOT SIGN (WHATWG: FULLWIDTH NOT SIGN)
];

function build() {
  const map = new Map();
  const dec = new TextDecoder("euc-jp");
  const excluded = (b1) => b1 === 0xad || (b1 >= 0xf9 && b1 <= 0xfe);
  for (let b1 = 0xa1; b1 <= 0xfe; b1++) {
    if (excluded(b1)) continue;
    for (let b2 = 0xa1; b2 <= 0xfe; b2++) {
      const s = dec.decode(Uint8Array.of(b1, b2));
      if (s.length !== 1 || s === "\ufffd") continue;
      const cp = s.codePointAt(0);
      if (!map.has(cp)) map.set(cp, [b1, b2]);
    }
  }
  for (const [code, cp] of JISX0208_OVERRIDES) {
    for (const [k, v] of map) if (v[0] === code >> 8 && v[1] === (code & 0xff)) map.delete(k);
    map.set(cp, [code >> 8, code & 0xff]);
  }
  for (let b = 0xa1; b <= 0xdf; b++) map.set(0xff61 + (b - 0xa1), [0x8e, b]); // half-width katakana
  return map;
}

/** Encode a JS string to EUC-JP bytes; throws on an unencodable character. */
export function eucJpEncode(s) {
  const out = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { out.push(cp); continue; }
    table ??= build();
    const b = table.get(cp);
    if (!b) throw Object.assign(new Error(`'euc_jp' codec can't encode character U+${cp.toString(16).toUpperCase().padStart(4, "0")}`), { code: "ENCODE_ERROR" });
    out.push(...b);
  }
  return Buffer.from(out);
}
