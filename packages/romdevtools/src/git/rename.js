// rename.js - git's rename detection (diffcore-rename.c + diffcore-delta.c)
// for the staged side of `git status`, which pairs a deleted path with an
// added one into a single "R  old -> new" line.
//
// Ported steps, in git's order:
//   1. exact renames: identical blob ids (a source is used once; a candidate
//      with the same basename is preferred);
//   2. basename matches: a remaining source and destination whose basenames
//      are each unique on their side pair when similarity >= the midpoint
//      between the minimum score and 100%;
//   3. the inexact matrix: every remaining (source, destination) pair scored
//      by git's span-hash similarity, the best 4 per destination kept,
//      assigned greedily from the highest score down.
// Only regular files (and symlinks with symlinks) take part, as in git.
//
// Plain JS ESM + JSDoc.

const MAX_SCORE = 60000;
const DEFAULT_RENAME_SCORE = 30000; // 50%
const NUM_CANDIDATE_PER_DST = 4;
const HASHBASE = 107927;

const isReg = (m) => (m & 0o170000) === 0o100000;

/** git's gather_stats -> is the buffer binary? */
export function isBinary(buf) {
  // diff_filespec_is_binary: a NUL in the first 8000 bytes.
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** span hash counts: Map hashval -> byte count (diffcore-delta.c hash_chars). */
export function spanHash(buf, isText) {
  const map = new Map();
  let n = 0, accum1 = 0, accum2 = 0;
  const sz = buf.length;
  for (let i = 0; i < sz; i++) {
    const c = buf[i];
    const old1 = accum1;
    if (isText && c === 13 && i + 1 < sz && buf[i + 1] === 10) continue;
    accum1 = ((accum1 << 7) ^ (accum2 >>> 25)) >>> 0;
    accum2 = ((accum2 << 7) ^ (old1 >>> 25)) >>> 0;
    accum1 = (accum1 + c) >>> 0;
    if (++n < 64 && c !== 10) continue;
    const hashval = ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE;
    map.set(hashval, (map.get(hashval) ?? 0) + n);
    n = 0; accum1 = 0; accum2 = 0;
  }
  if (n > 0) {
    const hashval = ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE;
    map.set(hashval, (map.get(hashval) ?? 0) + n);
  }
  return map;
}

/** diffcore_count_changes -> {srcCopied, literalAdded}. */
function countChanges(srcHash, dstHash) {
  let srcCopied = 0, literalAdded = 0;
  for (const [h, sc] of srcHash) {
    const dc = dstHash.get(h) ?? 0;
    if (sc < dc) { literalAdded += dc - sc; srcCopied += sc; } else srcCopied += dc;
  }
  for (const [h, dc] of dstHash) if (!srcHash.has(h)) literalAdded += dc;
  return { srcCopied, literalAdded };
}

const basename = (p) => p.slice(p.lastIndexOf("/") + 1);

/**
 * Detect renames between deleted (`srcs`) and added (`dsts`) entries.
 * Each item: {path, mode, oid}. `readBlob(oid)` returns the blob Buffer.
 * Returns [{src, dst}] pairs.
 * @param {{renameLimit?: number, minScore?: number}} [opts]
 */
export function detectRenames(srcs, dsts, readBlob, { renameLimit = 1000, minScore = DEFAULT_RENAME_SCORE } = {}) {
  const pairs = [];
  if (!srcs.length || !dsts.length) return pairs;
  const srcUsed = new Array(srcs.length).fill(false);
  const dstUsed = new Array(dsts.length).fill(false);

  // 1. exact renames
  const byOid = new Map();
  srcs.forEach((s, i) => { if (!byOid.has(s.oid)) byOid.set(s.oid, []); byOid.get(s.oid).push(i); });
  dsts.forEach((d, j) => {
    const cands = byOid.get(d.oid);
    if (!cands) return;
    let best = -1, bestScore = -1;
    for (const i of cands) {
      if (srcUsed[i]) continue;
      const s = srcs[i];
      if (isReg(s.mode) !== isReg(d.mode)) continue;
      const score = basename(s.path) === basename(d.path) ? 1 : 0;
      if (score > bestScore) { best = i; bestScore = score; if (score === 1) break; }
    }
    if (best >= 0) { srcUsed[best] = true; dstUsed[j] = true; pairs.push({ src: srcs[best], dst: d }); }
  });

  const cache = new Map();
  const info = (e) => {
    let x = cache.get(e.oid);
    if (!x) {
      const data = readBlob(e.oid);
      x = { size: data.length, data, hash: null };
      cache.set(e.oid, x);
    }
    return x;
  };
  const similarity = (s, d) => {
    if (!isReg(s.mode) || !isReg(d.mode)) return 0;
    const a = info(s), b = info(d);
    const maxSize = Math.max(a.size, b.size), baseSize = Math.min(a.size, b.size);
    const deltaSize = maxSize - baseSize;
    if (maxSize * (MAX_SCORE - minScore) < deltaSize * MAX_SCORE) return 0;
    if (!a.hash) a.hash = spanHash(a.data, !isBinary(a.data));
    if (!b.hash) b.hash = spanHash(b.data, !isBinary(b.data));
    const { srcCopied } = countChanges(a.hash, b.hash);
    if (!b.size) return 0;
    return Math.floor(srcCopied * MAX_SCORE / maxSize);
  };

  // 2. basename matches (unique basenames on both sides)
  const remainingSrc = srcs.map((s, i) => i).filter((i) => !srcUsed[i]);
  const remainingDst = dsts.map((d, j) => j).filter((j) => !dstUsed[j]);
  if (remainingSrc.length && remainingDst.length) {
    const count = (list, arr) => { const m = new Map(); for (const k of list) { const b = basename(arr[k].path); m.set(b, (m.get(b) ?? 0) + 1); } return m; };
    const srcB = count(remainingSrc, srcs), dstB = count(remainingDst, dsts);
    const dstByBase = new Map();
    for (const j of remainingDst) dstByBase.set(basename(dsts[j].path), j);
    const threshold = minScore + Math.floor((MAX_SCORE - minScore) / 2);
    for (const i of remainingSrc) {
      const b = basename(srcs[i].path);
      if (srcB.get(b) !== 1 || dstB.get(b) !== 1) continue;
      const j = dstByBase.get(b);
      if (dstUsed[j]) continue;
      const score = similarity(srcs[i], dsts[j]);
      if (score < threshold) continue;
      srcUsed[i] = true; dstUsed[j] = true;
      pairs.push({ src: srcs[i], dst: dsts[j] });
    }
  }

  // 3. inexact matrix
  const rs = srcs.map((s, i) => i).filter((i) => !srcUsed[i]);
  const rd = dsts.map((d, j) => j).filter((j) => !dstUsed[j]);
  if (!rs.length || !rd.length) return pairs;
  if (renameLimit > 0 && rs.length * rd.length > renameLimit * renameLimit) return pairs;
  const mx = [];
  for (const j of rd) {
    const best = [];
    for (const i of rs) {
      const score = similarity(srcs[i], dsts[j]);
      if (score < minScore) continue;
      const nameScore = basename(srcs[i].path) === basename(dsts[j].path) ? 1 : 0;
      best.push({ i, j, score, nameScore });
    }
    best.sort(scoreCompare);
    mx.push(...best.slice(0, NUM_CANDIDATE_PER_DST));
  }
  mx.sort(scoreCompare);
  for (const m of mx) {
    if (srcUsed[m.i] || dstUsed[m.j]) continue;
    srcUsed[m.i] = true; dstUsed[m.j] = true;
    pairs.push({ src: srcs[m.i], dst: dsts[m.j] });
  }
  return pairs;
}

/** git's score_compare: higher score first, then same-basename first. Stable otherwise. */
function scoreCompare(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  return b.nameScore - a.nameScore;
}
