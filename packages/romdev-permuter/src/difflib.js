// difflib.js - the parts of Python's difflib the permuter uses: SequenceMatcher
// (isjunk=None; autojunk as given) with get_opcodes / get_grouped_opcodes, and
// unified_diff. A line-for-line port of CPython Lib/difflib.py, because the
// scorer's penalties are computed from these exact opcodes.
//
// Elements are compared through a key function (identity by default); the
// permuter's diff compares source lines by their stripped text.

export class SequenceMatcher {
  /**
   * @param {{autojunk?: boolean, key?: (x:any) => any}} [opts]
   */
  constructor({ autojunk = true, key = (x) => x } = {}) {
    this.autojunk = autojunk;
    this.key = key;
    this.a = this.b = null;
    this.ka = this.kb = null;
  }

  set_seqs(a, b) { this.set_seq1(a); this.set_seq2(b); }

  set_seq1(a) {
    if (a === this.a) return;
    this.a = a;
    this.ka = a.map(this.key);
    this.matching_blocks = this.opcodes = null;
  }

  set_seq2(b) {
    if (b === this.b) return;
    this.b = b;
    this.kb = b.map(this.key);
    this.matching_blocks = this.opcodes = null;
    this.fullbcount = null;
    this.__chain_b();
  }

  __chain_b() {
    const b = this.kb;
    /** @type {Map<any, number[]>} */
    const b2j = new Map();
    b.forEach((elt, i) => {
      let indices = b2j.get(elt);
      if (!indices) { indices = []; b2j.set(elt, indices); }
      indices.push(i);
    });
    this.b2j = b2j;
    this.bjunk = new Set(); // isjunk is always None here
    this.bpopular = new Set();
    const n = b.length;
    if (this.autojunk && n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of b2j) if (idxs.length > ntest) this.bpopular.add(elt);
      for (const elt of this.bpopular) b2j.delete(elt);
    }
  }

  find_longest_match(alo, ahi, blo, bhi) {
    const a = this.ka, b = this.kb, b2j = this.b2j;
    const isbjunk = (x) => this.bjunk.has(x);
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
    while (besti > alo && bestj > blo && !isbjunk(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && !isbjunk(b[bestj + bestsize]) && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize++;
    }
    while (besti > alo && bestj > blo && isbjunk(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && isbjunk(b[bestj + bestsize]) && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  }

  get_matching_blocks() {
    if (this.matching_blocks != null) return this.matching_blocks;
    const la = this.a.length, lb = this.b.length;
    const queue = [[0, la, 0, lb]];
    const matching_blocks = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const x = this.find_longest_match(alo, ahi, blo, bhi);
      const [i, j, k] = x;
      if (k) {
        matching_blocks.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    matching_blocks.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    let i1 = 0, j1 = 0, k1 = 0;
    const non_adjacent = [];
    for (const [i2, j2, k2] of matching_blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) non_adjacent.push([i1, j1, k1]);
        i1 = i2; j1 = j2; k1 = k2;
      }
    }
    if (k1) non_adjacent.push([i1, j1, k1]);
    non_adjacent.push([la, lb, 0]);
    this.matching_blocks = non_adjacent;
    return this.matching_blocks;
  }

  get_opcodes() {
    if (this.opcodes != null) return this.opcodes;
    let i = 0, j = 0;
    const answer = [];
    this.opcodes = answer;
    for (const [ai, bj, size] of this.get_matching_blocks()) {
      let tag = "";
      if (i < ai && j < bj) tag = "replace";
      else if (i < ai) tag = "delete";
      else if (j < bj) tag = "insert";
      if (tag) answer.push([tag, i, ai, j, bj]);
      i = ai + size; j = bj + size;
      if (size) answer.push(["equal", ai, i, bj, j]);
    }
    return answer;
  }

  *get_grouped_opcodes(n = 3) {
    let codes = this.get_opcodes().map((c) => c.slice());
    if (!codes.length) codes = [["equal", 0, 1, 0, 1]];
    if (codes[0][0] === "equal") {
      const [tag, i1, i2, j1, j2] = codes[0];
      codes[0] = [tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
    }
    if (codes[codes.length - 1][0] === "equal") {
      const [tag, i1, i2, j1, j2] = codes[codes.length - 1];
      codes[codes.length - 1] = [tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
    }
    const nn = n + n;
    let group = [];
    for (let [tag, i1, i2, j1, j2] of codes) {
      if (tag === "equal" && i2 - i1 > nn) {
        group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
        yield group;
        group = [];
        i1 = Math.max(i1, i2 - n);
        j1 = Math.max(j1, j2 - n);
      }
      group.push([tag, i1, i2, j1, j2]);
    }
    if (group.length && !(group.length === 1 && group[0][0] === "equal")) yield group;
  }
}

function formatRangeUnified(start, stop) {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return `${beginning}`;
  if (!length) beginning -= 1;
  return `${beginning},${length}`;
}

/**
 * difflib.unified_diff(a, b, fromfile, tofile, lineterm="") with an optional
 * element key (the permuter's diff compares lines by their stripped text).
 * @returns {string[]}
 */
export function unified_diff(a, b, { fromfile = "", tofile = "", n = 3, lineterm = "\n", key } = {}) {
  const out = [];
  let started = false;
  const sm = new SequenceMatcher({ autojunk: true, key });
  sm.set_seqs(a, b);
  for (const group of sm.get_grouped_opcodes(n)) {
    if (!started) {
      started = true;
      out.push(`--- ${fromfile}${lineterm}`);
      out.push(`+++ ${tofile}${lineterm}`);
    }
    const first = group[0], last = group[group.length - 1];
    out.push(`@@ -${formatRangeUnified(first[1], last[2])} +${formatRangeUnified(first[3], last[4])} @@${lineterm}`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        for (const line of a.slice(i1, i2)) out.push(" " + line);
        continue;
      }
      if (tag === "replace" || tag === "delete") for (const line of a.slice(i1, i2)) out.push("-" + line);
      if (tag === "replace" || tag === "insert") for (const line of b.slice(j1, j2)) out.push("+" + line);
    }
  }
  return out;
}
