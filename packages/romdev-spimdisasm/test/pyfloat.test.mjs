import { test } from "node:test";
import assert from "node:assert/strict";

import { formatG, floatRepr, wordToFloat, qwordToDouble } from "../src/py/pyfloat.js";

// Expected strings are derived from CPython's format_float_short
// (Python/pystrtod.c) with dtoa mode 2 for '.Ng' and mode 0 for repr.

test("formatG .10g basics", () => {
    const cases = [
        [0, "0"],
        [-0, "-0"],
        [1, "1"],
        [-1, "-1"],
        [100, "100"],
        [0.5, "0.5"],
        [1.5, "1.5"],
        [1234567890, "1234567890"],
        [1e10, "1e+10"],
        [12345678901, "1.23456789e+10"],
        [0.0001, "0.0001"],
        [0.00001, "1e-05"],
        [1.5e20, "1.5e+20"],
        [1e100, "1e+100"],
        [1e-100, "1e-100"],
        [Infinity, "inf"],
        [-Infinity, "-inf"],
        [NaN, "nan"],
    ];
    for (const [x, want] of cases) {
        assert.equal(formatG(x, 10), want, `formatG(${x}, 10)`);
    }
});

test("formatG rounds exact ties to even, unlike toPrecision", () => {
    // 2**-15 == 3.0517578125e-05 exactly: 11 digits, the 11th is a 5 tie,
    // previous digit 2 is even so it stays.
    assert.equal(formatG(2 ** -15, 10), "3.051757812e-05");
    assert.notEqual((2 ** -15).toPrecision(10), "3.051757812e-05");
    // 3 * 2**-15 == 9.1552734375e-05 exactly: tie with odd previous digit.
    assert.equal(formatG(3 * 2 ** -15, 10), "9.155273438e-05");
    // 2**-16 == 1.52587890625e-05: not a tie (rest is "25").
    assert.equal(formatG(2 ** -16, 10), "1.525878906e-05");
    // 2.5 at .1g: tie, 2 even -> 2; 3.5 -> 4
    assert.equal(formatG(2.5, 1), "2");
    assert.equal(formatG(3.5, 1), "4");
    assert.equal(formatG(0.125, 2), "0.12");
    assert.equal(formatG(0.375, 2), "0.38");
});

test("formatG on float32 values widened to double (.float path)", () => {
    assert.equal(formatG(wordToFloat(0x3DCCCCCD), 10), "0.1000000015");
    assert.equal(formatG(wordToFloat(0x3F800000), 10), "1");
    assert.equal(formatG(wordToFloat(0xBF800000), 10), "-1");
    assert.equal(formatG(wordToFloat(0x80000000), 10), "-0");
    assert.equal(formatG(wordToFloat(0x7F7FFFFF), 10), "3.402823466e+38");
    assert.equal(formatG(wordToFloat(0x00000001), 10), "1.401298464e-45");
    // float32 0.0001 == 9.99999974737875...e-05, so it goes exponential
    assert.equal(formatG(wordToFloat(0x38D1B717), 10), "9.999999747e-05");
    assert.equal(formatG(wordToFloat(0x40490FDB), 10), "3.141592741");
    assert.equal(formatG(wordToFloat(0x7F800000), 10), "inf");
    // 999999.9999 area: carry that bumps the exponent
    assert.equal(formatG(9999999999.5, 10), "1e+10");
    assert.equal(formatG(0.999999999975, 10), "1");
});

test("formatG .18g (.double path)", () => {
    assert.equal(formatG(0.1, 18), "0.100000000000000006");
    assert.equal(formatG(1 / 3, 18), "0.333333333333333315");
    assert.equal(formatG(2 ** 60, 18), "1.15292150460684698e+18");
    assert.equal(formatG(1, 18), "1");
    assert.equal(formatG(3.141592653589793, 18), "3.14159265358979312");
    assert.equal(formatG(1e-5, 18), "1.00000000000000008e-05");
    assert.equal(formatG(qwordToDouble(0x3FF0000000000000n), 18), "1");
});

test("floatRepr", () => {
    const cases = [
        [0, "0.0"],
        [-0, "-0.0"],
        [1, "1.0"],
        [100, "100.0"],
        [1.5, "1.5"],
        [0.1, "0.1"],
        [0.0001, "0.0001"],
        [0.00001, "1e-05"],
        [1e15, "1000000000000000.0"],
        [1e16, "1e+16"],
        [1.5e20, "1.5e+20"],
        [123456789012345680, "1.2345678901234568e+17"],
        [1e22, "1e+22"],
        [5e-324, "5e-324"],
        [1.7976931348623157e308, "1.7976931348623157e+308"],
        [Infinity, "inf"],
        [-Infinity, "-inf"],
        [NaN, "nan"],
    ];
    for (const [x, want] of cases) {
        assert.equal(floatRepr(x), want, `floatRepr(${x})`);
    }
});

test("wordToFloat / qwordToDouble", () => {
    assert.equal(wordToFloat(0x3F800000), 1);
    assert.equal(wordToFloat(0xC0000000), -2);
    assert.equal(wordToFloat(0x3DCCCCCD), Math.fround(0.1));
    assert.equal(qwordToDouble(0x3FF0000000000000n), 1);
    assert.equal(qwordToDouble(0xC000000000000000n), -2);
    assert.equal(qwordToDouble(0x3FB999999999999An), 0.1);
    assert.ok(Object.is(qwordToDouble(0x8000000000000000n), -0));
});
