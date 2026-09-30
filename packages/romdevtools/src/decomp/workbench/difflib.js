// difflib.js - the longest-matching-block sequence aligner the comparison
// reports are defined by (no junk heuristic), reproduced block for block so
// edit scripts, distances and alignments come out identical.
//
// Plain JS ESM + JSDoc.

/** Sequence aligner over arrays of strings (or other ===-comparable keys). */
export class SequenceMatcher {
  /** autojunk: drop elements of b that occur in more than 1% of a 200+ item b, as the default matcher does. */
  constructor(a = [], b = [], { autojunk = false } = {}) {
    this.a = a; this.b = b;
    this.matchingBlocks = null; this.opcodes = null;
    const b2j = new Map();
    b.forEach((elt, i) => { let l = b2j.get(elt); if (!l) { l = []; b2j.set(elt, l); } l.push(i); });
    if (autojunk && b.length >= 200) {
      const ntest = Math.floor(b.length / 100) + 1;
      for (const [elt, idxs] of [...b2j]) if (idxs.length > ntest) b2j.delete(elt);
    }
    this.b2j = b2j;
  }

  findLongestMatch(alo, ahi, blo, bhi) {
    const { a, b, b2j } = this;
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map();
    const nothing = [];
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map();
      for (const j of b2j.get(a[i]) ?? nothing) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = newj2len;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti--; bestj--; bestsize++; }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  }

  getMatchingBlocks() {
    if (this.matchingBlocks) return this.matchingBlocks;
    const la = this.a.length, lb = this.b.length;
    const queue = [[0, la, 0, lb]];
    const blocks = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = x;
      if (k) {
        blocks.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    let i1 = 0, j1 = 0, k1 = 0;
    const out = [];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else { if (k1) out.push([i1, j1, k1]); i1 = i2; j1 = j2; k1 = k2; }
    }
    if (k1) out.push([i1, j1, k1]);
    out.push([la, lb, 0]);
    this.matchingBlocks = out;
    return out;
  }

  /** [[tag, i1, i2, j1, j2], ...] with tags replace/delete/insert/equal. */
  getOpcodes() {
    if (this.opcodes) return this.opcodes;
    let i = 0, j = 0;
    const answer = [];
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      let tag = "";
      if (i < ai && j < bj) tag = "replace";
      else if (i < ai) tag = "delete";
      else if (j < bj) tag = "insert";
      if (tag) answer.push([tag, i, ai, j, bj]);
      i = ai + size; j = bj + size;
      if (size) answer.push(["equal", ai, i, bj, j]);
    }
    this.opcodes = answer;
    return answer;
  }
}

/** get_grouped_opcodes(n): change clusters with up to n lines of context. */
export function groupedOpcodes(matcher, n = 3) {
  let codes = matcher.getOpcodes().map((c) => [...c]);
  if (!codes.length) codes = [["equal", 0, 1, 0, 1]];
  if (codes[0][0] === "equal") { const [tag, i1, i2, j1, j2] = codes[0]; codes[0] = [tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2]; }
  if (codes.at(-1)[0] === "equal") { const [tag, i1, i2, j1, j2] = codes.at(-1); codes[codes.length - 1] = [tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]; }
  const nn = n + n;
  const groups = [];
  let group = [];
  for (let [tag, i1, i2, j1, j2] of codes) {
    if (tag === "equal" && i2 - i1 > nn) {
      group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
      groups.push(group);
      group = [];
      i1 = Math.max(i1, i2 - n); j1 = Math.max(j1, j2 - n);
    }
    group.push([tag, i1, i2, j1, j2]);
  }
  if (group.length && !(group.length === 1 && group[0][0] === "equal")) groups.push(group);
  return groups;
}

function unifiedRange(start, stop) {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return `${beginning}`;
  if (!length) beginning -= 1;
  return `${beginning},${length}`;
}

/** unified_diff(a, b, fromfile, tofile, lineterm="", n) with the default (autojunk) matcher. */
export function unifiedDiff(a, b, { fromfile = "", tofile = "", fromfiledate = "", tofiledate = "", n = 3, lineterm = "\n" } = {}) {
  const out = [];
  let started = false;
  for (const group of groupedOpcodes(new SequenceMatcher(a, b, { autojunk: true }), n)) {
    if (!started) {
      started = true;
      out.push(`--- ${fromfile}${fromfiledate ? "\t" + fromfiledate : ""}${lineterm}`);
      out.push(`+++ ${tofile}${tofiledate ? "\t" + tofiledate : ""}${lineterm}`);
    }
    const first = group[0], last = group.at(-1);
    out.push(`@@ -${unifiedRange(first[1], last[2])} +${unifiedRange(first[3], last[4])} @@${lineterm}`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") { for (const line of a.slice(i1, i2)) out.push(" " + line); continue; }
      if (tag === "replace" || tag === "delete") for (const line of a.slice(i1, i2)) out.push("-" + line);
      if (tag === "replace" || tag === "insert") for (const line of b.slice(j1, j2)) out.push("+" + line);
    }
  }
  return out;
}
