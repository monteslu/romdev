// pow.js - the C library pow() CPython's float `**` calls, so the permuter's
// reorder weights `(dist + 1) ** -1.5` are the same doubles upstream computes.
//
// glibc (and musl) implement pow with the ARM optimized-routines algorithm
// (Szabolcs Nagy, 2018): a table-driven log with a ~15-bit tail, a scaled
// y*log(x), and a table-driven exp. That algorithm is ported here step for
// step, with every intermediate a double exactly as in C (JS evaluates double
// arithmetic without contraction or extended precision, like the C source
// compiled with -ffp-contract=off). The source has two code paths selected by
// __FP_FAST_FMA; glibc on x86-64 ships both and picks the FMA one at load time
// on CPUs with FMA. Both are here (`fma: true` uses an exactly rounded fused
// multiply-add), and test/pow.test.js checks them against the host libm.
//
// V8's Math.pow / `**` is a different algorithm with its own last-bit
// behaviour, which is why the permuter does not use it for these weights.
import { POW_LOG, EXP } from "./pow-data.js";

const buf = new DataView(new ArrayBuffer(8));
const asuint64 = (d) => { buf.setFloat64(0, d); return buf.getBigUint64(0); };
const asdouble = (u) => { buf.setBigUint64(0, BigInt.asUintN(64, u)); return buf.getFloat64(0); };
const top12 = (d) => Number(asuint64(d) >> 52n);

// -- exact fused multiply-add ------------------------------------------------

/** A finite double as sign * M * 2**E with M a BigInt (0 for zero). */
function split(d) {
  const u = asuint64(d);
  const sign = u >> 63n ? -1n : 1n;
  const e = Number((u >> 52n) & 0x7ffn);
  const f = u & 0xfffffffffffffn;
  if (e === 0) return [sign * f, -1074];
  return [sign * (f | (1n << 52n)), e - 1075];
}

/** Round sign-carrying integer M * 2**E to the nearest double (ties to even). */
function roundToDouble(M, E) {
  if (M === 0n) return 0;
  const neg = M < 0n;
  let m = neg ? -M : M;
  let e = E;
  const len = m.toString(2).length;
  // target 53 significant bits (subnormals: exponent floor -1074)
  let drop = len - 53;
  if (e + drop < -1074) drop = -1074 - e;
  if (drop > 0) {
    const half = 1n << BigInt(drop - 1);
    const rem = m & ((1n << BigInt(drop)) - 1n);
    m >>= BigInt(drop);
    e += drop;
    if (rem > half || (rem === half && (m & 1n))) m += 1n;
  } else if (drop < 0) {
    m <<= BigInt(-drop);
    e += drop;
  }
  // m * 2**e now fits (m may have become 2**53 after rounding; Number handles it exactly)
  const v = Number(m) * 2 ** e;
  return neg ? -v : v;
}

/** fma(a, b, c) = a*b + c with a single rounding. */
export function fma(a, b, c) {
  const [ma, ea] = split(a), [mb, eb] = split(b), [mc, ec] = split(c);
  const ep = ea + eb;
  const e = Math.min(ep, ec);
  const M = ((ma * mb) << BigInt(ep - e)) + (mc << BigInt(ec - e));
  if (M === 0n) return (a * b) + c; // signed-zero rules
  return roundToDouble(M, e);
}

// -- the algorithm -------------------------------------------------------------

const OFF = 0x3fe6955500000000n;
const T_LOG = POW_LOG.tab;
const A = POW_LOG.poly;
const N_EXP = 128n;
const [C2, C3, C4, C5] = EXP.poly;

function log_inline(ix, useFma) {
  const tmp = BigInt.asUintN(64, ix - OFF);
  const i = Number((tmp >> 45n) % 128n);
  const k = Number(BigInt.asIntN(64, tmp) >> 52n);
  const iz = BigInt.asUintN(64, ix - (tmp & (0xfffn << 52n)));
  const z = asdouble(iz);
  const kd = k;
  const [invc, logc, logctail] = T_LOG[i];
  let r, rhi, rlo;
  if (useFma) {
    r = fma(z, invc, -1.0);
  } else {
    const zhi = asdouble((iz + (1n << 31n)) & (BigInt.asUintN(64, -1n) << 32n));
    const zlo = z - zhi;
    rhi = zhi * invc - 1.0;
    rlo = zlo * invc;
    r = rhi + rlo;
  }
  const t1 = useFma ? fma(kd, POW_LOG.ln2hi, logc) : kd * POW_LOG.ln2hi + logc;
  const t2 = t1 + r;
  const lo1 = useFma ? fma(kd, POW_LOG.ln2lo, logctail) : kd * POW_LOG.ln2lo + logctail;
  const lo2 = t1 - t2 + r;
  const ar = A[0] * r;
  const ar2 = r * ar;
  const ar3 = r * ar2;
  let hi, lo3, lo4;
  if (useFma) {
    hi = t2 + ar2;
    lo3 = fma(ar, r, -ar2);
    lo4 = t2 - hi + ar2;
  } else {
    const arhi = A[0] * rhi;
    const arhi2 = rhi * arhi;
    hi = t2 + arhi2;
    lo3 = rlo * (ar + arhi);
    lo4 = t2 - hi + arhi2;
  }
  let lo;
  if (useFma) {
    const inner = fma(ar2, fma(r, A[6], A[5]), fma(r, A[4], A[3]));
    const outer = fma(ar2, inner, fma(r, A[2], A[1]));
    lo = fma(ar3, outer, lo1 + lo2 + lo3 + lo4);
  } else {
    const p = ar3 * (A[1] + r * A[2] + ar2 * (A[3] + r * A[4] + ar2 * (A[5] + r * A[6])));
    lo = lo1 + lo2 + lo3 + lo4 + p;
  }
  const y = hi + lo;
  const tail = hi - y + lo;
  return [y, tail];
}

function exp_inline(x, xtail, useFma) {
  const abstop = top12(x) & 0x7ff;
  if (abstop - top12(2 ** -54) >= top12(512.0) - top12(2 ** -54) || abstop < top12(2 ** -54)) {
    throw new RangeError("pow.js: exp argument outside the range this port handles (|y*log x| in [2^-54, 512))");
  }
  let kd = useFma ? fma(EXP.invln2N, x, EXP.shift) : EXP.invln2N * x + EXP.shift;
  const ki = asuint64(kd);
  kd -= EXP.shift;
  let r = useFma ? fma(kd, EXP.negln2loN, fma(kd, EXP.negln2hiN, x)) : x + kd * EXP.negln2hiN + kd * EXP.negln2loN;
  r += xtail;
  const idx = Number(2n * (ki % N_EXP));
  const top = BigInt.asUintN(64, ki << 45n);
  const tail = asdouble(EXP.tab[idx]);
  const sbits = BigInt.asUintN(64, EXP.tab[idx + 1] + top);
  const r2 = r * r;
  const scale = asdouble(sbits);
  if (useFma) {
    const tmp = fma(r2 * r2, fma(r, C5, C4), fma(r2, fma(r, C3, C2), tail + r));
    return fma(scale, tmp, scale);
  }
  const tmp = tail + r + r2 * (C2 + r * C3) + r2 * r2 * (C4 + r * C5);
  return scale + scale * tmp;
}

/**
 * pow(x, y) for a positive normal x and a y with 2^-54 <= |y log x| < 512
 * (every weight the permuter computes). Other inputs throw rather than guess.
 * @param {number} x
 * @param {number} y
 * @param {{fma?: boolean}} [opts] the __FP_FAST_FMA code path
 */
export function libmPow(x, y, { fma: useFma = hostUsesFma() } = {}) {
  if (!(x > 0) || !Number.isFinite(x) || x < 2 ** -1022 || !Number.isFinite(y)) {
    throw new RangeError("pow.js: positive normal x and finite y only");
  }
  if (x === 1) return 1;
  const topy = top12(y) & 0x7ff;
  if (topy - 0x3be >= 0x43e - 0x3be) throw new RangeError("pow.js: |y| outside [2^-65, 2^63)");
  const ix = asuint64(x);
  const iy = asuint64(y);
  const [hi, lo] = log_inline(ix, useFma);
  let ehi, elo;
  if (useFma) {
    ehi = y * hi;
    elo = fma(y, lo, fma(y, hi, -ehi));
  } else {
    const yhi = asdouble(iy & (BigInt.asUintN(64, -1n) << 27n));
    const ylo = y - yhi;
    const lhi = asdouble(asuint64(hi) & (BigInt.asUintN(64, -1n) << 27n));
    const llo = hi - lhi + lo;
    ehi = yhi * lhi;
    elo = ylo * lhi + y * llo;
  }
  return exp_inline(ehi, elo, useFma);
}

let hostFma = null;
/**
 * Which pow code path the platform's C library runs. glibc on x86-64 selects
 * its FMA build when the CPU has FMA and AVX2; override with
 * ROMDEV_PERMUTER_POW=fma|generic.
 */
export function hostUsesFma() {
  if (hostFma != null) return hostFma;
  const env = process.env.ROMDEV_PERMUTER_POW;
  if (env === "fma" || env === "generic") return (hostFma = env === "fma");
  hostFma = false;
  if (process.arch === "x64" && process.platform === "linux") {
    try {
      const flags = /^flags\s*:\s*(.*)$/m.exec(readCpuinfo())?.[1]?.split(/\s+/) ?? [];
      hostFma = flags.includes("fma") && flags.includes("avx2");
    } catch { /* keep generic */ }
  } else if (process.arch === "arm64") {
    hostFma = true; // AArch64 always has fused multiply-add
  }
  return hostFma;
}

import { readFileSync } from "node:fs";
function readCpuinfo() { return readFileSync("/proc/cpuinfo", "utf8"); }

/** (dist + 1) ** -1.5 as upstream computes it. */
export function powNeg15(x) { return libmPow(x, -1.5); }
