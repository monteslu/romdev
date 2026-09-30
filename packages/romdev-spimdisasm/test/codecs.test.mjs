// Tests for src/py/codecs.js: CPython-faithful strict byte decoding.
import { test } from "node:test";
import assert from "node:assert/strict";

import { pyDecode, pyCanDecode, normalizeEncoding, pyNormalizeEncodingName, UnicodeDecodeError, LookupError } from "../src/py/codecs.js";
import * as DEC from "../src/py/cjk-tables-jp.js";
import * as ENC from "./data/cjk-encmap-jp.js";

const U = (...b) => Uint8Array.from(b);

function load(t) {
    const buf = Buffer.from(t.data, "base64");
    const a = new Uint16Array(t.length);
    for (let i = 0; i < t.length; i++) a[i] = buf.readUInt16LE(i * 2);
    return { a, idx: t.index };
}
function look(t, hi, lo, invalid) {
    const e = t.idx[hi];
    if (!e) return -1;
    const [o, b, top] = e;
    if (lo < b || lo > top) return -1;
    const v = t.a[o + lo - b];
    return v === invalid ? -1 : v;
}
function entries(t) {
    const out = [];
    for (let c1 = 0; c1 < 256; c1++) {
        const e = t.idx[c1];
        if (!e) continue;
        for (let c2 = e[1]; c2 <= e[2]; c2++) {
            const u = t.a[e[0] + c2 - e[1]];
            if (u !== 0xfffe) out.push([c1, c2, u]);
        }
    }
    return out;
}
function expectError(bytes, enc, start, end, reason) {
    assert.throws(() => pyDecode(bytes, enc), (e) => {
        assert.ok(e instanceof UnicodeDecodeError, String(e));
        if (start !== undefined) assert.equal(e.start, start);
        if (end !== undefined) assert.equal(e.end, end);
        if (reason !== undefined) assert.equal(e.reason, reason);
        return true;
    });
}

test("generated tables have the C array sizes of CPython mappings_jp.h", () => {
    assert.equal(DEC.jisx0208_decmap.length, 6956);
    assert.equal(DEC.jisx0212_decmap.length, 6179);
    assert.equal(DEC.cp932ext_decmap.length, 969);
    assert.equal(ENC.jisxcommon_encmap.length, 22016);
    assert.equal(ENC.cp932ext_encmap.length, 9686);
    for (const t of [DEC.jisx0208_decmap, DEC.jisx0212_decmap, DEC.cp932ext_decmap, ENC.jisxcommon_encmap, ENC.cp932ext_encmap]) {
        assert.equal(t.index.length, 256);
        assert.equal(Buffer.from(t.data, "base64").length, t.length * 2);
    }
    // Defined code counts (non-UNIINV cells): JIS X 0208 has 6879, JIS X 0212 6067.
    assert.equal(entries(load(DEC.jisx0208_decmap)).length, 6879);
    assert.equal(entries(load(DEC.jisx0212_decmap)).length, 6067);
    assert.equal(entries(load(DEC.cp932ext_decmap)).length, 933);
});

test("JIS X 0208 and JIS X 0212 decode maps are exact inverses of CPython's jisxcommon encode map", () => {
    const enc = load(ENC.jisxcommon_encmap);
    for (const [name, flag] of [["jisx0208_decmap", 0], ["jisx0212_decmap", 0x8000]]) {
        const all = entries(load(DEC[name]));
        const bad = all.filter(([c1, c2, u]) => look(enc, u >> 8, u & 0xff, 0xffff) !== (((c1 << 8) | c2) | flag));
        assert.deepEqual(bad, [], name);
        // every cell lies in the 94x94 plane
        assert.ok(all.every(([c1, c2]) => c1 >= 0x21 && c1 <= 0x7e && c2 >= 0x21 && c2 <= 0x7e), name);
    }
});

test("cp932ext decode entries either round-trip or are documented duplicates/JIS-overrides", () => {
    const dec = load(DEC.cp932ext_decmap);
    const enc = load(ENC.cp932ext_encmap);
    let roundTrip = 0;
    let duplicate = 0;
    let noExtEncoding = 0;
    for (const [c1, c2, u] of entries(dec)) {
        const code = look(enc, u >> 8, u & 0xff, 0xffff);
        if (code === ((c1 << 8) | c2)) roundTrip++;
        else if (code === -1) noExtEncoding++;
        else {
            // The canonical code must decode back to the same character.
            assert.equal(look(dec, code >> 8, code & 0xff, 0xfffe), u);
            duplicate++;
        }
    }
    assert.deepEqual({ roundTrip, duplicate, noExtEncoding }, { roundTrip: 454, duplicate: 388, noExtEncoding: 91 });
});

test("shift_jis: every lead/trail byte class behaves like CPython DECODER(shift_jis)", () => {
    for (let c = 0; c < 256; c++) {
        const single = pyCanDecode(U(c), "shift_jis");
        assert.equal(single, c < 0x80 || (c >= 0xa1 && c <= 0xdf), `single 0x${c.toString(16)}`);
    }
    // Leads 0x81-0x9F, 0xE0-0xEA; trails 0x40-0x7E, 0x80-0xFC.
    const lead = (c) => (c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xea);
    let decodable = 0;
    for (let c1 = 0x80; c1 <= 0xff; c1++) {
        for (let c2 = 0; c2 <= 0xff; c2++) {
            const ok = pyCanDecode(U(c1, c2), "shift_jis");
            const singleOk = c1 >= 0xa1 && c1 <= 0xdf;
            if (!lead(c1)) {
                // two independent single bytes
                assert.equal(ok, singleOk && pyCanDecode(U(c2), "shift_jis"));
                continue;
            }
            const trailOk = (c2 >= 0x40 && c2 <= 0x7e) || (c2 >= 0x80 && c2 <= 0xfc);
            if (!trailOk) assert.equal(ok, false, `0x${c1.toString(16)} 0x${c2.toString(16)}`);
            if (ok) decodable++;
        }
    }
    // JIS X 0208's 6879 codes, all reachable through Shift-JIS
    assert.equal(decodable, 6879);
});

test("shift_jis hand cases", () => {
    // "テスト" in Shift-JIS
    assert.equal(pyDecode(U(0x83, 0x65, 0x83, 0x58, 0x83, 0x67), "shift_jis"), "テスト");
    // 0x5C and 0x7E pass through as ASCII (non-STRICT_BUILD)
    assert.equal(pyDecode(U(0x5c, 0x7e), "shift_jis"), "\\~");
    // halfwidth katakana
    assert.equal(pyDecode(U(0xa1, 0xb1, 0xdf), "shift_jis"), "｡ｱﾟ");
    // 0x815F is FULLWIDTH REVERSE SOLIDUS in CPython (JIS0208.TXT says U+005C)
    assert.equal(pyDecode(U(0x81, 0x5f), "shift_jis"), "＼");
    // lead byte followed by an invalid trail
    expectError(U(0x41, 0x83, 0x20), "shift_jis", 1, 2, "illegal multibyte sequence");
    expectError(U(0x83, 0x7f), "shift_jis", 0, 1, "illegal multibyte sequence");
    // unmapped cell inside the valid trail range (row 0x85 is empty in JIS X 0208)
    expectError(U(0x85, 0x40), "shift_jis", 0, 1, "illegal multibyte sequence");
    // lone lead byte at the end
    expectError(U(0x41, 0x42, 0x83), "shift_jis", 2, 3, "incomplete multibyte sequence");
    // bytes that are never valid in shift_jis
    for (const b of [0x80, 0xa0, 0xeb, 0xf0, 0xfd, 0xfe, 0xff]) expectError(U(0x41, b, 0x41), "shift_jis", 1, 2, "illegal multibyte sequence");
});

test("euc_jp hand cases", () => {
    // "日本" in EUC-JP
    assert.equal(pyDecode(U(0xc6, 0xfc, 0xcb, 0xdc), "euc_jp"), "日本");
    // SS2 halfwidth katakana
    assert.equal(pyDecode(U(0x8e, 0xb1), "euc_jp"), "ｱ");
    expectError(U(0x8e, 0xa0), "euc_jp", 0, 1);
    // SS3 JIS X 0212: 0x8F 0xB0 0xA1 = U+4E02
    assert.equal(pyDecode(U(0x8f, 0xb0, 0xa1), "euc_jp"), "丂");
    // JIS X 0212 0x2237 is U+007E in CPython (glibc says U+FF5E)
    assert.equal(pyDecode(U(0x8f, 0xa2, 0xb7), "euc_jp"), "~");
    expectError(U(0x8f, 0xa1, 0xa1), "euc_jp", 0, 1, "illegal multibyte sequence");
    expectError(U(0x8f, 0xb0), "euc_jp", 0, 2, "incomplete multibyte sequence");
    // FULL-WIDTH REVERSE SOLIDUS special case
    assert.equal(pyDecode(U(0xa1, 0xc0), "euc_jp"), "＼");
    // C1 single bytes are rejected by CPython (glibc accepts them)
    expectError(U(0x80), "euc_jp", 0, 1);
    expectError(U(0x90, 0xa1), "euc_jp", 0, 1);
    expectError(U(0xc6), "euc_jp", 0, 1, "incomplete multibyte sequence");
});

test("cp932 hand cases", () => {
    assert.equal(pyDecode(U(0x80, 0xa0, 0xfd, 0xfe, 0xff), "cp932"), "\u0080");
    // NEC row 13 circled one
    assert.equal(pyDecode(U(0x87, 0x40), "cp932"), "①");
    // user-defined area maps into the PUA
    assert.equal(pyDecode(U(0xf0, 0x40), "cp932"), "");
    // 0x815F is FULLWIDTH REVERSE SOLIDUS in cp932 too (cp932ext entry)
    assert.equal(pyDecode(U(0x81, 0x5f), "cp932"), "＼");
    expectError(U(0x81), "cp932", 0, 1, "incomplete multibyte sequence");
});

test("ascii, latin_1 and utf_8 strictness", () => {
    assert.equal(pyDecode(U(0x41, 0x7f), "ascii"), "A\x7f");
    expectError(U(0x41, 0x80), "ascii", 1, 2, "ordinal not in range(128)");
    assert.equal(pyDecode(U(0xe9, 0xff), "latin_1"), "éÿ");
    assert.equal(pyDecode(U(0xe6, 0x97, 0xa5), "utf-8"), "日");
    assert.equal(pyDecode(U(0xf0, 0x9f, 0x98, 0x80), "utf8"), "\u{1f600}");
    expectError(U(0xc0, 0x80), "utf-8", 0, 1, "invalid start byte"); // overlong
    expectError(U(0xed, 0xa0, 0x80), "utf-8", 0, 1, "invalid continuation byte"); // surrogate
    expectError(U(0xf4, 0x90, 0x80, 0x80), "utf-8", 0, 1, "invalid continuation byte"); // > U+10FFFF
    expectError(U(0xe6, 0x97), "utf-8", 0, 2, "unexpected end of data");
});

test("encoding names resolve like codecs.lookup", () => {
    assert.equal(normalizeEncoding("SHIFT-JIS"), "shift_jis");
    assert.equal(normalizeEncoding("Shift_JIS"), "shift_jis");
    assert.equal(normalizeEncoding("sjis"), "shift_jis");
    assert.equal(normalizeEncoding("EUC-JP"), "euc_jp");
    assert.equal(normalizeEncoding("ujis"), "euc_jp");
    assert.equal(normalizeEncoding("ASCII"), "ascii");
    assert.equal(normalizeEncoding("us-ascii"), "ascii");
    assert.equal(normalizeEncoding("UTF-8"), "utf_8");
    assert.equal(normalizeEncoding("latin1"), "latin_1");
    assert.equal(normalizeEncoding("MS932"), "cp932");
    assert.equal(normalizeEncoding("windows-31j"), "cp932");
    assert.equal(normalizeEncoding("windows-31j", { pythonVersion: "3.12" }), null);
    assert.equal(pyNormalizeEncodingName("  -euc--jp;# "), "euc_jp");
    assert.equal(normalizeEncoding("EUC-CN"), null);
    assert.throws(() => pyDecode(U(0x41), "no-such-codec"), LookupError);
});

test("perturbing one byte flips a successful decode into an error", () => {
    const good = U(0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x00);
    assert.equal(pyCanDecode(good, "shift_jis"), true);
    const bad = Uint8Array.from(good);
    bad[3] = 0x7f; // trail byte out of range
    assert.equal(pyCanDecode(bad, "shift_jis"), false);
    const eucGood = U(0xc6, 0xfc, 0xcb, 0xdc);
    assert.equal(pyCanDecode(eucGood, "euc_jp"), true);
    const eucBad = Uint8Array.from(eucGood);
    eucBad[1] = 0x41;
    assert.equal(pyCanDecode(eucBad, "euc_jp"), false);
});
