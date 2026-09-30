// SPDX-License-Identifier: MIT
//
// Byte decoders that behave exactly like CPython's `bytes.decode(encoding)`
// in strict mode, for the codecs spimdisasm projects use.
//
// The Japanese codecs are line-by-line ports of CPython's
// Modules/cjkcodecs/_codecs_jp.c DECODER(euc_jp), DECODER(shift_jis) and
// DECODER(cp932) (non-STRICT_BUILD paths, which is how CPython is built),
// driven by the decode maps generated from CPython's mappings_jp.h (see
// scripts/gen-cjk-tables.mjs). Error reporting follows
// Modules/cjkcodecs/multibytecodec.c: a codec return value e > 0 is an
// "illegal multibyte sequence" covering [pos, pos+e), running out of input
// mid-character is an "incomplete multibyte sequence" covering the rest.
//
// The decoders were checked between CPython 3.12 and 3.13: the only
// differences in _codecs_jp.c are in the euc_jis_2004 and shift_jis_2004
// ENCODERS, so decoding is identical. The alias table differs (3.13 adds
// "windows_31j" -> cp932), which `pythonVersion` selects.

import * as T from "./cjk-tables-jp.js";

export class LookupError extends Error {
    constructor(message) {
        super(message);
        this.name = "LookupError";
    }
}

export class UnicodeDecodeError extends Error {
    /**
     * @param {string} encoding
     * @param {Uint8Array} object
     * @param {number} start
     * @param {number} end
     * @param {string} reason
     */
    constructor(encoding, object, start, end, reason) {
        const b = object[start];
        let msg;
        if (end - start === 1 && b !== undefined) {
            msg = `'${encoding}' codec can't decode byte 0x${b.toString(16).padStart(2, "0")} in position ${start}: ${reason}`;
        } else {
            msg = `'${encoding}' codec can't decode bytes in position ${start}-${end - 1}: ${reason}`;
        }
        super(msg);
        this.name = "UnicodeDecodeError";
        this.encoding = encoding;
        this.object = object;
        this.start = start;
        this.end = end;
        this.reason = reason;
    }
}

// ---------------------------------------------------------------------------
// Encoding names

// Subset of CPython Lib/encodings/aliases.py for the implemented codecs.
const ALIASES_COMMON = {
    "646": "ascii",
    "ansi_x3.4_1968": "ascii",
    "ansi_x3_4_1968": "ascii",
    "ansi_x3.4_1986": "ascii",
    "cp367": "ascii",
    "csascii": "ascii",
    "ibm367": "ascii",
    "iso646_us": "ascii",
    "iso_646.irv_1991": "ascii",
    "iso_ir_6": "ascii",
    "us": "ascii",
    "us_ascii": "ascii",

    "932": "cp932",
    "ms932": "cp932",
    "mskanji": "cp932",
    "ms_kanji": "cp932",

    "eucjp": "euc_jp",
    "ujis": "euc_jp",
    "u_jis": "euc_jp",

    "8859": "latin_1",
    "cp819": "latin_1",
    "csisolatin1": "latin_1",
    "ibm819": "latin_1",
    "iso8859": "latin_1",
    "iso8859_1": "latin_1",
    "iso_8859_1": "latin_1",
    "iso_8859_1_1987": "latin_1",
    "iso_ir_100": "latin_1",
    "l1": "latin_1",
    "latin": "latin_1",
    "latin1": "latin_1",

    "csshiftjis": "shift_jis",
    "shiftjis": "shift_jis",
    "sjis": "shift_jis",
    "s_jis": "shift_jis",
    "x_mac_japanese": "shift_jis",

    "u8": "utf_8",
    "utf": "utf_8",
    "utf8": "utf_8",
    "utf8_ucs2": "utf_8",
    "utf8_ucs4": "utf_8",
    "cp65001": "utf_8",
};
const ALIASES_313 = { "windows_31j": "cp932" };

const CODEC_NAMES = new Set(["ascii", "latin_1", "utf_8", "euc_jp", "shift_jis", "cp932"]);

/** Python's str.isalnum() for a single character (Unicode-aware). */
function isAlnum(c) {
    return /^[\p{L}\p{Nd}\p{Nl}\p{No}]$/u.test(c);
}

/**
 * CPython encodings.normalize_encoding(): non-alphanumerics except '.' are
 * collapsed into single underscores, leading/trailing ones dropped,
 * non-ASCII alphanumerics dropped.
 */
export function pyNormalizeEncodingName(encoding) {
    const chars = [];
    let punct = false;
    for (const c of encoding) {
        if (isAlnum(c) || c === ".") {
            if (punct && chars.length) chars.push("_");
            if (c.charCodeAt(0) < 0x80) chars.push(c);
            punct = false;
        } else {
            punct = true;
        }
    }
    return chars.join("");
}

/**
 * Resolve an encoding name the way codecs.lookup() does (lowercase, then
 * normalize_encoding, then the alias table). Returns the canonical codec
 * module name (e.g. "shift_jis") or null when the codec is not implemented
 * here.
 * @param {string} name
 * @param {{pythonVersion?: string}} [opts]
 * @returns {string|null}
 */
export function normalizeEncoding(name, opts = {}) {
    const ver = opts.pythonVersion ?? "3.13";
    const norm = pyNormalizeEncodingName(String(name).toLowerCase());
    const aliases = ver === "3.12" ? ALIASES_COMMON : { ...ALIASES_COMMON, ...ALIASES_313 };
    const aliased = aliases[norm] ?? aliases[norm.replace(/\./g, "_")];
    for (const cand of aliased !== undefined ? [aliased, norm] : [norm]) {
        if (CODEC_NAMES.has(cand)) return cand;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Decode map access (mirrors cjkcodecs.h _TRYMAP_DEC)

const UNIINV = 0xfffe;

function loadTable(t) {
    const buf = Buffer.from(t.data, "base64");
    const arr = new Uint16Array(t.length);
    for (let i = 0; i < t.length; i++) arr[i] = buf.readUInt16LE(i * 2);
    return { map: arr, index: t.index };
}

let tables = null;
function getTables() {
    if (tables === null) {
        tables = {
            jisx0208: loadTable(T.jisx0208_decmap),
            jisx0212: loadTable(T.jisx0212_decmap),
            cp932ext: loadTable(T.cp932ext_decmap),
        };
    }
    return tables;
}

/** TRYMAP_DEC(charset, c1, c2): returns the code point or -1. */
function trymapDec(tbl, c1, c2) {
    const ent = tbl.index[c1];
    if (ent === null || ent === undefined) return -1;
    const [off, bottom, top] = ent;
    if (c2 < bottom || c2 > top) return -1;
    const v = tbl.map[off + c2 - bottom];
    return v === UNIINV ? -1 : v;
}

// Internal decoder protocol: each decoder returns either the decoded
// string, or {pos, err} where err > 0 means "illegal multibyte sequence"
// of err bytes at pos, and err === TOOFEW means incomplete input at pos.
const TOOFEW = -2;

function decodeEucJp(b) {
    const t = getTables();
    const out = [];
    let i = 0;
    const n = b.length;
    while (i < n) {
        const c = b[i];
        if (c < 0x80) {
            out.push(c);
            i += 1;
            continue;
        }
        if (c === 0x8e) {
            if (n - i < 2) return { pos: i, err: TOOFEW };
            const c2 = b[i + 1];
            if (c2 >= 0xa1 && c2 <= 0xdf) {
                out.push(0xfec0 + c2);
                i += 2;
            } else {
                return { pos: i, err: 1 };
            }
        } else if (c === 0x8f) {
            if (n - i < 3) return { pos: i, err: TOOFEW };
            const c2 = b[i + 1];
            const c3 = b[i + 2];
            const d = trymapDec(t.jisx0212, c2 ^ 0x80, c3 ^ 0x80);
            if (d >= 0) {
                out.push(d);
                i += 3;
            } else {
                return { pos: i, err: 1 };
            }
        } else {
            if (n - i < 2) return { pos: i, err: TOOFEW };
            const c2 = b[i + 1];
            if (c === 0xa1 && c2 === 0xc0) {
                // FULL-WIDTH REVERSE SOLIDUS
                out.push(0xff3c);
            } else {
                const d = trymapDec(t.jisx0208, c ^ 0x80, c2 ^ 0x80);
                if (d >= 0) out.push(d);
                else return { pos: i, err: 1 };
            }
            i += 2;
        }
    }
    return cpsToString(out);
}

function decodeShiftJis(b) {
    const t = getTables();
    const out = [];
    let i = 0;
    const n = b.length;
    while (i < n) {
        const c = b[i];
        if (c < 0x80) {
            out.push(c);
        } else if (c >= 0xa1 && c <= 0xdf) {
            // JISX0201_K_DECODE
            out.push(0xfec0 + c);
        } else if ((c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xea)) {
            if (n - i < 2) return { pos: i, err: TOOFEW };
            let c2 = b[i + 1];
            if (c2 < 0x40 || (c2 > 0x7e && c2 < 0x80) || c2 > 0xfc) return { pos: i, err: 1 };
            let c1 = c < 0xe0 ? c - 0x81 : c - 0xc1;
            c2 = c2 < 0x80 ? c2 - 0x40 : c2 - 0x41;
            c1 = 2 * c1 + (c2 < 0x5e ? 0 : 1) + 0x21;
            c2 = (c2 < 0x5e ? c2 : c2 - 0x5e) + 0x21;
            // Both are `unsigned char` in C; values stay within 0..255 here.
            c1 &= 0xff;
            c2 &= 0xff;
            if (c1 === 0x21 && c2 === 0x40) {
                // FULL-WIDTH REVERSE SOLIDUS
                out.push(0xff3c);
                i += 2;
                continue;
            }
            const d = trymapDec(t.jisx0208, c1, c2);
            if (d >= 0) {
                out.push(d);
                i += 2;
                continue;
            }
            return { pos: i, err: 1 };
        } else {
            return { pos: i, err: 1 };
        }
        i += 1; // JIS X 0201
    }
    return cpsToString(out);
}

function decodeCp932(b) {
    const t = getTables();
    const out = [];
    let i = 0;
    const n = b.length;
    while (i < n) {
        let c = b[i];
        if (c <= 0x80) {
            out.push(c);
            i += 1;
            continue;
        } else if (c >= 0xa0 && c <= 0xdf) {
            out.push(c === 0xa0 ? 0xf8f0 : 0xfec0 + c);
            i += 1;
            continue;
        } else if (c >= 0xfd) {
            // Windows compatibility
            out.push(0xf8f1 - 0xfd + c);
            i += 1;
            continue;
        }

        if (n - i < 2) return { pos: i, err: TOOFEW };
        let c2 = b[i + 1];

        const e = trymapDec(t.cp932ext, c, c2);
        if (e >= 0) {
            out.push(e);
        } else if ((c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xea)) {
            if (c2 < 0x40 || (c2 > 0x7e && c2 < 0x80) || c2 > 0xfc) return { pos: i, err: 1 };
            c = c < 0xe0 ? c - 0x81 : c - 0xc1;
            c2 = c2 < 0x80 ? c2 - 0x40 : c2 - 0x41;
            c = (2 * c + (c2 < 0x5e ? 0 : 1) + 0x21) & 0xff;
            c2 = ((c2 < 0x5e ? c2 : c2 - 0x5e) + 0x21) & 0xff;
            const d = trymapDec(t.jisx0208, c, c2);
            if (d >= 0) out.push(d);
            else return { pos: i, err: 1 };
        } else if (c >= 0xf0 && c <= 0xf9) {
            if ((c2 >= 0x40 && c2 <= 0x7e) || (c2 >= 0x80 && c2 <= 0xfc)) {
                out.push(0xe000 + 188 * (c - 0xf0) + (c2 < 0x80 ? c2 - 0x40 : c2 - 0x41));
            } else {
                return { pos: i, err: 1 };
            }
        } else {
            return { pos: i, err: 1 };
        }
        i += 2;
    }
    return cpsToString(out);
}

function decodeAscii(b) {
    let s = "";
    for (let i = 0; i < b.length; i++) {
        if (b[i] >= 0x80) throw new UnicodeDecodeError("ascii", b, i, i + 1, "ordinal not in range(128)");
        s += String.fromCharCode(b[i]);
    }
    return s;
}

function decodeLatin1(b) {
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
}

/** Strict UTF-8 as in CPython Objects/stringlib/codecs.h + unicodeobject.c. */
function decodeUtf8(b) {
    const out = [];
    const n = b.length;
    let i = 0;
    const fail = (start, end, reason) => {
        throw new UnicodeDecodeError("utf-8", b, start, end, reason);
    };
    while (i < n) {
        const c = b[i];
        if (c < 0x80) {
            out.push(c);
            i++;
            continue;
        }
        let need;
        let lo = 0x80;
        let hi = 0xbf;
        let cp;
        if (c >= 0xc2 && c <= 0xdf) {
            need = 1;
            cp = c & 0x1f;
        } else if (c >= 0xe0 && c <= 0xef) {
            need = 2;
            cp = c & 0x0f;
            if (c === 0xe0) lo = 0xa0;
            if (c === 0xed) hi = 0x9f; // no surrogates
        } else if (c >= 0xf0 && c <= 0xf4) {
            need = 3;
            cp = c & 0x07;
            if (c === 0xf0) lo = 0x90;
            if (c === 0xf4) hi = 0x8f;
        } else {
            fail(i, i + 1, "invalid start byte");
        }
        for (let k = 1; k <= need; k++) {
            if (i + k >= n) fail(i, n, "unexpected end of data");
            const cc = b[i + k];
            const l = k === 1 ? lo : 0x80;
            const h = k === 1 ? hi : 0xbf;
            if (cc < l || cc > h) fail(i, i + k, "invalid continuation byte");
            cp = (cp << 6) | (cc & 0x3f);
        }
        out.push(cp);
        i += need + 1;
    }
    return cpsToString(out);
}

const MB_DECODERS = {
    euc_jp: decodeEucJp,
    shift_jis: decodeShiftJis,
    cp932: decodeCp932,
};

// Display names used in UnicodeDecodeError messages (codec.name).
const DISPLAY = { ascii: "ascii", latin_1: "latin-1", utf_8: "utf-8", euc_jp: "euc_jp", shift_jis: "shift_jis", cp932: "cp932" };

function cpsToString(cps) {
    let s = "";
    for (let i = 0; i < cps.length; i += 4096) s += String.fromCodePoint(...cps.slice(i, i + 4096));
    return s;
}

/**
 * CPython `bytes.decode(encoding)` (errors="strict").
 * @param {Uint8Array|number[]} bytes
 * @param {string} encoding
 * @param {{pythonVersion?: string}} [opts]
 * @returns {string}
 * @throws {UnicodeDecodeError|LookupError}
 */
export function pyDecode(bytes, encoding, opts = {}) {
    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    const codec = normalizeEncoding(encoding, opts);
    if (codec === null) throw new LookupError(`unknown encoding: ${encoding}`);
    switch (codec) {
        case "ascii":
            return decodeAscii(b);
        case "latin_1":
            return decodeLatin1(b);
        case "utf_8":
            return decodeUtf8(b);
        default: {
            const r = MB_DECODERS[codec](b);
            if (typeof r === "string") return r;
            if (r.err === TOOFEW) {
                throw new UnicodeDecodeError(DISPLAY[codec], b, r.pos, b.length, "incomplete multibyte sequence");
            }
            throw new UnicodeDecodeError(DISPLAY[codec], b, r.pos, r.pos + r.err, "illegal multibyte sequence");
        }
    }
}

/** Convenience: true if pyDecode would succeed. */
export function pyCanDecode(bytes, encoding, opts = {}) {
    try {
        pyDecode(bytes, encoding, opts);
        return true;
    } catch (e) {
        if (e instanceof UnicodeDecodeError) return false;
        throw e;
    }
}
