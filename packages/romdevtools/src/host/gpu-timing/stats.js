// Summary statistics for per-frame timing series. Plain JS ESM + JSDoc.

/** Round to 3 decimals (microsecond resolution for ms values). */
export const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

/**
 * min / mean / p50 / p95 / p99 / max of the finite values (nulls skipped),
 * plus how many there were. p95 is the nearest-rank percentile.
 * @param {Array<number|null>} xs
 */
export function summary(xs) {
  const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pct = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  return { n: v.length, min: r3(v[0]), mean: r3(mean), p50: r3(pct(50)), p95: r3(pct(95)), p99: r3(pct(99)), max: r3(v[v.length - 1]) };
}

export const median = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

export const mean = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};

/** The index of the largest finite value, or -1. */
export function argmax(xs) {
  let at = -1, best = -Infinity;
  xs.forEach((x, i) => { if (x != null && Number.isFinite(x) && x > best) { best = x; at = i; } });
  return at;
}
