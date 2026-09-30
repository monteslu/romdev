// levenshtein.js - Levenshtein.opcodes(s1, s2) as the `Levenshtein` package
// (maxbachmann, a wrapper over rapidfuzz) computes it: the permuter's
// --algorithm levenshtein path. A port of rapidfuzz's reference
// implementation (rapidfuzz/distance/Levenshtein_py.py: common-affix
// stripping, Hyyrö's bit-parallel matrix, the documented backtrack order) and
// of Editops.as_opcodes (_initialize_py.py). Sequences are arrays of
// comparable values; bit vectors are BigInts (Python ints).

function commonAffix(s1, s2) {
  let prefix = 0;
  while (prefix < s1.length && prefix < s2.length && s1[prefix] === s2[prefix]) prefix++;
  let suffix = 0;
  while (suffix < s1.length - prefix && suffix < s2.length - prefix
    && s1[s1.length - 1 - suffix] === s2[s2.length - 1 - suffix]) suffix++;
  return [prefix, suffix];
}

function matrix(s1, s2) {
  if (!s1.length) return [s2.length, [], []];
  let VP = (1n << BigInt(s1.length)) - 1n;
  let VN = 0n;
  let currDist = s1.length;
  const mask = 1n << BigInt(s1.length - 1);
  const block = new Map();
  let x = 1n;
  for (const ch1 of s1) {
    block.set(ch1, (block.get(ch1) ?? 0n) | x);
    x <<= 1n;
  }
  const matrixVP = [], matrixVN = [];
  for (const ch2 of s2) {
    const X = block.get(ch2) ?? 0n;
    const D0 = (((X & VP) + VP) ^ VP) | X | VN;
    let HP = VN | ~(D0 | VP);
    let HN = D0 & VP;
    if (HP & mask) currDist += 1;
    if (HN & mask) currDist -= 1;
    HP = (HP << 1n) | 1n;
    HN = HN << 1n;
    VP = HN | ~(D0 | HP);
    VN = HP & D0;
    matrixVP.push(VP);
    matrixVN.push(VN);
  }
  return [currDist, matrixVP, matrixVN];
}

/** Levenshtein.editops(s1, s2): [tag, src_pos, dest_pos][] */
export function editops(s1, s2) {
  const [prefix, suffix] = commonAffix(s1, s2);
  const a = s1.slice(prefix, s1.length - suffix);
  const b = s2.slice(prefix, s2.length - suffix);
  let [dist, VP, VN] = matrix(a, b);
  if (dist === 0) return [];
  const ops = new Array(dist);
  let col = a.length, row = b.length;
  while (row !== 0 && col !== 0) {
    if (VP[row - 1] & (1n << BigInt(col - 1))) {
      dist--; col--;
      ops[dist] = ["delete", col + prefix, row + prefix];
    } else {
      row--;
      if (row && (VN[row - 1] & (1n << BigInt(col - 1)))) {
        dist--;
        ops[dist] = ["insert", col + prefix, row + prefix];
      } else {
        col--;
        if (a[col] !== b[row]) {
          dist--;
          ops[dist] = ["replace", col + prefix, row + prefix];
        }
      }
    }
  }
  while (col !== 0) { dist--; col--; ops[dist] = ["delete", col + prefix, row + prefix]; }
  while (row !== 0) { dist--; row--; ops[dist] = ["insert", col + prefix, row + prefix]; }
  return ops;
}

/** Editops.as_opcodes: [tag, i1, i2, j1, j2][] covering both sequences. */
export function opcodes(s1, s2) {
  const ops = editops(s1, s2);
  const srcLen = s1.length, destLen = s2.length;
  const blocks = [];
  let src = 0, dest = 0, i = 0;
  while (i < ops.length) {
    if (src < ops[i][1] || dest < ops[i][2]) {
      blocks.push(["equal", src, ops[i][1], dest, ops[i][2]]);
      src = ops[i][1];
      dest = ops[i][2];
    }
    const srcBegin = src, destBegin = dest;
    const tag = ops[i][0];
    while (i < ops.length && ops[i][0] === tag && src === ops[i][1] && dest === ops[i][2]) {
      if (tag === "replace") { src++; dest++; }
      else if (tag === "insert") dest++;
      else if (tag === "delete") src++;
      i++;
    }
    blocks.push([tag, srcBegin, src, destBegin, dest]);
  }
  if (src < srcLen || dest < destLen) blocks.push(["equal", src, srcLen, dest, destLen]);
  return blocks;
}
