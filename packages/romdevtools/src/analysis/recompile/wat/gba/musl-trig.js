// musl's double sin() and cos() (src/math/sin.c, cos.c, __sin.c, __cos.c,
// __rem_pio2.c; FreeBSD msun origin), statement for statement in JS doubles.
//
// Why: mGBA's sinc resampler (src/util/interpolator.c) fills its sinc and
// window tables with the C library's sin()/cos() at startup, and romdev's
// mGBA core is an Emscripten build, so that library is musl. JS Math.sin /
// Math.cos are NOT musl: over the 65537 entries of each table they differ in
// the last bit 148 (sinc) and 598 (window) times, and one ulp in a kernel
// weight moves a resampled sample. Every operation below is a single IEEE
// double operation (no fused multiply-add: WebAssembly has none, and JS has
// none), so this port returns musl's bits exactly.
//
// Only the argument range the tables use is needed (|x| < 2^20 * pi/2, the
// "medium" reduction); the large-argument path (__rem_pio2_large) is refused.
// The coefficients come from mgba-audio.json (extracted from the musl source
// by scripts/recompile-gen/gba-mgba-audio.mjs).
//
// musl is MIT licensed.
//
// Plain JS ESM + JSDoc.

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
/** high word of a double (GET_HIGH_WORD) */
function hi(x) { f64[0] = x; return u32[1] >>> 0; }

/**
 * @param {Record<string, number>} k musl constants: S1-S6, C1-C6, pio4,
 *   invpio2, pio2_1, pio2_1t, pio2_2, pio2_2t, pio2_3, pio2_3t, toint
 */
export function muslTrig(k) {
  const { S1, S2, S3, S4, S5, S6, C1, C2, C3, C4, C5, C6 } = k;
  const { pio4, invpio2, pio2_1, pio2_1t, pio2_2, pio2_2t, pio2_3, pio2_3t, toint } = k;

  /** __sin(x, y, iy) */
  function ksin(x, y, iy) {
    const z = x * x;
    const w = z * z;
    const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
    const v = z * x;
    if (iy === 0) return x + v * (S1 + z * r);
    return x - ((z * (0.5 * y - v * r) - y) - v * S1);
  }

  /** __cos(x, y) */
  function kcos(x, y) {
    const z = x * x;
    let w = z * z;
    const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
    const hz = 0.5 * z;
    w = 1.0 - hz;
    return w + (((1.0 - w) - hz) + (z * r - x * y));
  }

  /** __rem_pio2(x, y) -> n, y[0..1] */
  function remPio2(x, y) {
    f64[0] = x;
    const sign = u32[1] >>> 31;
    const ix = u32[1] & 0x7fffffff;
    let z;
    medium: {
      if (ix <= 0x400f6a7a) {
        if ((ix & 0xfffff) === 0x921fb) break medium;
        if (ix <= 0x4002d97c) {
          if (!sign) { z = x - pio2_1; y[0] = z - pio2_1t; y[1] = (z - y[0]) - pio2_1t; return 1; }
          z = x + pio2_1; y[0] = z + pio2_1t; y[1] = (z - y[0]) + pio2_1t; return -1;
        }
        if (!sign) { z = x - 2 * pio2_1; y[0] = z - 2 * pio2_1t; y[1] = (z - y[0]) - 2 * pio2_1t; return 2; }
        z = x + 2 * pio2_1; y[0] = z + 2 * pio2_1t; y[1] = (z - y[0]) + 2 * pio2_1t; return -2;
      }
      if (ix <= 0x401c463b) {
        if (ix <= 0x4015fdbc) {
          if (ix === 0x4012d97c) break medium;
          if (!sign) { z = x - 3 * pio2_1; y[0] = z - 3 * pio2_1t; y[1] = (z - y[0]) - 3 * pio2_1t; return 3; }
          z = x + 3 * pio2_1; y[0] = z + 3 * pio2_1t; y[1] = (z - y[0]) + 3 * pio2_1t; return -3;
        }
        if (ix === 0x401921fb) break medium;
        if (!sign) { z = x - 4 * pio2_1; y[0] = z - 4 * pio2_1t; y[1] = (z - y[0]) - 4 * pio2_1t; return 4; }
        z = x + 4 * pio2_1; y[0] = z + 4 * pio2_1t; y[1] = (z - y[0]) + 4 * pio2_1t; return -4;
      }
      if (!(ix < 0x413921fb)) throw new Error("musl-trig: argument outside the medium reduction range");
    }
    // medium: rint(x/(pi/2))
    let fn = x * invpio2 + toint - toint;
    let n = fn | 0;
    let r = x - fn * pio2_1;
    let w = fn * pio2_1t;
    if (r - w < -pio4) { n--; fn--; r = x - fn * pio2_1; w = fn * pio2_1t; }
    else if (r - w > pio4) { n++; fn++; r = x - fn * pio2_1; w = fn * pio2_1t; }
    y[0] = r - w;
    let ey = (hi(y[0]) >>> 20) & 0x7ff;
    const ex = ix >>> 20;
    if (ex - ey > 16) {
      let t = r;
      w = fn * pio2_2;
      r = t - w;
      w = fn * pio2_2t - ((t - r) - w);
      y[0] = r - w;
      ey = (hi(y[0]) >>> 20) & 0x7ff;
      if (ex - ey > 49) {
        t = r;
        w = fn * pio2_3;
        r = t - w;
        w = fn * pio2_3t - ((t - r) - w);
        y[0] = r - w;
      }
    }
    y[1] = (r - y[0]) - w;
    return n;
  }

  const yy = [0, 0];
  /** @param {number} x */
  function sin(x) {
    const ix = hi(x) & 0x7fffffff;
    if (ix <= 0x3fe921fb) {
      if (ix < 0x3e500000) return x;
      return ksin(x, 0.0, 0);
    }
    if (ix >= 0x7ff00000) return x - x;
    const n = remPio2(x, yy);
    switch (n & 3) {
      case 0: return ksin(yy[0], yy[1], 1);
      case 1: return kcos(yy[0], yy[1]);
      case 2: return -ksin(yy[0], yy[1], 1);
      default: return -kcos(yy[0], yy[1]);
    }
  }
  /** @param {number} x */
  function cos(x) {
    const ix = hi(x) & 0x7fffffff;
    if (ix <= 0x3fe921fb) {
      if (ix < 0x3e46a09e) return 1.0;
      return kcos(x, 0);
    }
    if (ix >= 0x7ff00000) return x - x;
    const n = remPio2(x, yy);
    switch (n & 3) {
      case 0: return kcos(yy[0], yy[1]);
      case 1: return -ksin(yy[0], yy[1], 1);
      case 2: return -kcos(yy[0], yy[1]);
      default: return ksin(yy[0], yy[1], 1);
    }
  }
  return { sin, cos };
}

/**
 * mInterpolatorSincInit's two tables (interpolator.c), as mGBA fills them:
 * x and y advance by repeated addition, exactly as the C loop does.
 * @param {{sin: (x: number) => number, cos: (x: number) => number}} m
 * @param {number} resolution  mSINC_RESOLUTION
 * @param {number} width       mSINC_WIDTH
 * @param {[number, number, number]} win  the Nuttall window's three coefficients
 * @param {number} pi          M_PI
 * @returns {{sinc: Float64Array, window: Float64Array}}
 */
export function sincTables(m, resolution, width, win, pi) {
  const samples = resolution * width;
  const dy = pi / samples;
  let y = dy;
  const dx = dy * width;
  let x = dx;
  const sinc = new Float64Array(samples + 1);
  const window = new Float64Array(samples + 1);
  sinc[0] = 0;
  window[0] = 1;
  for (let i = 1; i <= samples; ++i, x += dx, y += dy) {
    sinc[i] = x < width ? m.sin(x) / x : 0.0;
    window[i] = win[0] + win[1] * m.cos(y) + win[2] * m.cos(2 * y);
  }
  return { sinc, window };
}
