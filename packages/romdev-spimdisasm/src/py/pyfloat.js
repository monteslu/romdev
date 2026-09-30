// SPDX-License-Identifier: MIT
//
// Python float formatting, reproduced exactly.
//
// formatG(x, p) == Python `format(x, f".{p}g")`
// floatRepr(x)  == Python `repr(x)`
//
// Both follow CPython's Python/pystrtod.c `format_float_short`. `formatG`
// needs dtoa mode 2 (correctly rounded to `p` significant digits, ties to
// even on the exact binary value), which is computed here from the exact
// decimal expansion of the double with BigInt arithmetic. Number#toPrecision
// can not be used for this since it rounds exact ties away from zero.
// `floatRepr` needs dtoa mode 0 (shortest round-trip digits), which is what
// Number#toExponential() without an argument produces.

const scratch = new DataView(new ArrayBuffer(8));

/**
 * Split a finite, non-zero double into [mantissa (BigInt), exponent] with
 * |x| == mantissa * 2**exponent.
 * @param {number} x
 * @returns {[bigint, number]}
 */
function decompose(x) {
    scratch.setFloat64(0, x);
    const bits = scratch.getBigUint64(0);
    const biasedExp = Number((bits >> 52n) & 0x7FFn);
    let mant = bits & 0xFFFFFFFFFFFFFn;
    if (biasedExp === 0) {
        return [mant, -1074];
    }
    mant |= 0x10000000000000n;
    return [mant, biasedExp - 1075];
}

/**
 * Exact decimal digits of |x| (finite, non-zero).
 * Returns {digits, decpt} with |x| == 0.digits * 10**decpt, digits has no
 * leading zeros (it may have trailing zeros).
 * @param {number} x
 */
function exactDecimal(x) {
    const [mant, exp] = decompose(Math.abs(x));
    let digits;
    let pow10 = 0;
    if (exp >= 0) {
        digits = (mant << BigInt(exp)).toString();
    } else {
        const k = -exp;
        digits = (mant * 5n ** BigInt(k)).toString();
        pow10 = -k;
    }
    // value == digits * 10**pow10 == 0.digits * 10**(pow10 + len)
    return { digits, decpt: pow10 + digits.length };
}

/**
 * dtoa mode 2: round |x| to `ndigits` significant digits, ties to even.
 * Returns {digits, decpt} with trailing zeros stripped (like _Py_dg_dtoa),
 * |rounded| == 0.digits * 10**decpt.
 * @param {number} x finite non-zero
 * @param {number} ndigits >= 1
 */
function dtoaMode2(x, ndigits) {
    const { digits, decpt } = exactDecimal(x);
    let outDigits;
    let outDecpt = decpt;
    if (digits.length <= ndigits) {
        outDigits = digits;
    } else {
        const kept = digits.slice(0, ndigits);
        const rest = digits.slice(ndigits);
        let roundUp;
        const first = rest.charCodeAt(0) - 48;
        if (first > 5) {
            roundUp = true;
        } else if (first < 5) {
            roundUp = false;
        } else {
            // first digit is 5: tie only if everything after is zero
            let allZero = true;
            for (let i = 1; i < rest.length; i++) {
                if (rest.charCodeAt(i) !== 48) {
                    allZero = false;
                    break;
                }
            }
            if (!allZero) {
                roundUp = true;
            } else {
                const lastKept = kept.charCodeAt(kept.length - 1) - 48;
                roundUp = (lastKept % 2) === 1;
            }
        }
        if (roundUp) {
            const bumped = (BigInt(kept) + 1n).toString();
            if (bumped.length > kept.length) {
                // 999 -> 1000
                outDecpt += 1;
            }
            outDigits = bumped;
        } else {
            outDigits = kept;
        }
    }
    outDigits = outDigits.replace(/0+$/, "");
    if (outDigits === "") {
        outDigits = "0";
    }
    return { digits: outDigits, decpt: outDecpt };
}

/**
 * dtoa mode 0: shortest round-trip digits.
 * @param {number} x finite non-zero
 */
function dtoaMode0(x) {
    const s = Math.abs(x).toExponential();
    const eIdx = s.indexOf("e");
    const mantissa = s.slice(0, eIdx).replace(".", "");
    const exp10 = parseInt(s.slice(eIdx + 1), 10);
    let digits = mantissa.replace(/0+$/, "");
    if (digits === "") {
        digits = "0";
    }
    return { digits, decpt: exp10 + 1 };
}

/**
 * Port of the digit layout part of CPython's format_float_short.
 * @param {boolean} negative
 * @param {string} digits
 * @param {number} decpt
 * @param {boolean} useExp
 * @param {boolean} addDot0IfInteger
 */
function layout(negative, digits, decpt, useExp, addDot0IfInteger) {
    const digitsLen = digits.length;
    let vdigitsEnd = digitsLen;
    let exp = 0;
    if (useExp) {
        exp = decpt - 1;
        decpt = 1;
    }
    const vdigitsStart = decpt <= 0 ? decpt - 1 : 0;
    if (!useExp && addDot0IfInteger) {
        vdigitsEnd = vdigitsEnd > decpt ? vdigitsEnd : decpt + 1;
    } else {
        vdigitsEnd = vdigitsEnd > decpt ? vdigitsEnd : decpt;
    }

    let out = negative ? "-" : "";
    if (decpt <= 0) {
        out += "0".repeat(decpt - vdigitsStart);
        out += ".";
        out += "0".repeat(0 - decpt);
    } else {
        out += "0".repeat(0 - vdigitsStart);
    }

    if (0 < decpt && decpt <= digitsLen) {
        out += digits.slice(0, decpt);
        out += ".";
        out += digits.slice(decpt);
    } else {
        out += digits;
    }

    if (digitsLen < decpt) {
        out += "0".repeat(decpt - digitsLen);
        out += ".";
        out += "0".repeat(vdigitsEnd - decpt);
    } else {
        out += "0".repeat(vdigitsEnd - digitsLen);
    }

    if (out.endsWith(".")) {
        out = out.slice(0, -1);
    }

    if (useExp) {
        const sign = exp < 0 ? "-" : "+";
        const mag = Math.abs(exp).toString().padStart(2, "0");
        out += `e${sign}${mag}`;
    }
    return out;
}

function nonFinite(x) {
    if (Number.isNaN(x)) {
        return "nan";
    }
    return x < 0 ? "-inf" : "inf";
}

/**
 * Python `format(x, f".{precision}g")`.
 * @param {number} x
 * @param {number} precision
 * @returns {string}
 */
export function formatG(x, precision) {
    if (!Number.isFinite(x)) {
        return nonFinite(x);
    }
    if (precision === 0) {
        precision = 1;
    }
    const negative = x < 0 || Object.is(x, -0);
    let digits;
    let decpt;
    if (x === 0) {
        digits = "0";
        decpt = 1;
    } else {
        ({ digits, decpt } = dtoaMode2(x, precision));
    }
    const useExp = decpt <= -4 || decpt > precision;
    return layout(negative, digits, decpt, useExp, false);
}

/**
 * Python `repr(x)` for a float.
 * @param {number} x
 * @returns {string}
 */
export function floatRepr(x) {
    if (!Number.isFinite(x)) {
        return nonFinite(x);
    }
    const negative = x < 0 || Object.is(x, -0);
    let digits;
    let decpt;
    if (x === 0) {
        digits = "0";
        decpt = 1;
    } else {
        ({ digits, decpt } = dtoaMode0(x));
    }
    const useExp = decpt <= -4 || decpt > 16;
    return layout(negative, digits, decpt, useExp, true);
}

/**
 * struct.unpack(">f", struct.pack(">I", word))[0], widened to a double.
 * @param {number} word
 * @returns {number}
 */
export function wordToFloat(word) {
    scratch.setUint32(0, word >>> 0);
    return scratch.getFloat32(0);
}

/**
 * struct.unpack(">d", struct.pack(">Q", qword))[0].
 * @param {bigint} qword
 * @returns {number}
 */
export function qwordToDouble(qword) {
    scratch.setBigUint64(0, BigInt.asUintN(64, BigInt(qword)));
    return scratch.getFloat64(0);
}
