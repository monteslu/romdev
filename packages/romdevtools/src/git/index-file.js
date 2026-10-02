// index-file.js - parse git's index ("DIRC") file, versions 2, 3 and 4.
//
// v2: fixed entries padded to 8 bytes. v3: adds the extended-flags word
// (skip-worktree, intent-to-add). v4: no padding, each path prefix-compressed
// against the previous one with git's offset varint. Extensions are skipped
// except two that change what the entry list MEANS:
//   - "link" (split index): the entries live partly in a sharedindex file;
//     that layout is merged here so callers always see the full list.
//   - "sdir" (sparse index): some entries are directories (mode 040000,
//     skip-worktree). Callers expand them through the tree they name.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";

export const CE_STAGEMASK = 0x3000;
export const CE_VALID = 0x8000;
export const CE_EXTENDED = 0x4000;
export const CE_SKIP_WORKTREE = 0x4000; // in flags2
export const CE_INTENT_TO_ADD = 0x2000; // in flags2

/**
 * @typedef {object} IndexEntry
 * @property {string} path UTF-8 path
 * @property {number} stage 0..3
 * @property {number} mode
 * @property {string} oid hex
 * @property {number} ctimeS @property {number} ctimeNs
 * @property {number} mtimeS @property {number} mtimeNs
 * @property {number} dev @property {number} ino
 * @property {number} uid @property {number} gid
 * @property {number} size
 * @property {boolean} assumeValid
 * @property {boolean} skipWorktree
 * @property {boolean} intentToAdd
 */

function decodeVarint(buf, p) {
  let c = buf[p++];
  let val = c & 127;
  while (c & 128) {
    val += 1;
    c = buf[p++];
    val = val * 128 + (c & 127);
  }
  return [val, p];
}

/**
 * Parse an index file buffer.
 * @param {Buffer} buf
 * @param {{hashLen?: number}} [opts]
 * @returns {{version: number, entries: IndexEntry[], sparse: boolean, splitLink: {oid: string, deleteBits: Buffer, replaceBits: Buffer}|null}}
 */
export function parseIndex(buf, { hashLen = 20 } = {}) {
  if (buf.toString("latin1", 0, 4) !== "DIRC") throw new Error("not a git index (bad signature)");
  const version = buf.readUInt32BE(4);
  if (version < 2 || version > 4) throw new Error(`unsupported index version ${version}`);
  const n = buf.readUInt32BE(8);
  const entries = [];
  let p = 12;
  let prevName = Buffer.alloc(0);
  const headerLen = 40 + hashLen + 2; // 10 x u32, hash, flags
  for (let i = 0; i < n; i++) {
    const start = p;
    const e = {
      ctimeS: buf.readUInt32BE(p), ctimeNs: buf.readUInt32BE(p + 4),
      mtimeS: buf.readUInt32BE(p + 8), mtimeNs: buf.readUInt32BE(p + 12),
      dev: buf.readUInt32BE(p + 16), ino: buf.readUInt32BE(p + 20),
      mode: buf.readUInt32BE(p + 24), uid: buf.readUInt32BE(p + 28), gid: buf.readUInt32BE(p + 32),
      size: buf.readUInt32BE(p + 36),
      oid: buf.toString("hex", p + 40, p + 40 + hashLen),
    };
    const flags = buf.readUInt16BE(p + 40 + hashLen);
    p += headerLen;
    let flags2 = 0;
    if (flags & CE_EXTENDED) {
      if (version < 3) throw new Error("extended index entry in a v2 index");
      flags2 = buf.readUInt16BE(p);
      p += 2;
    }
    let nameBuf;
    if (version === 4) {
      let strip;
      [strip, p] = decodeVarint(buf, p);
      const nul = buf.indexOf(0, p);
      nameBuf = Buffer.concat([prevName.subarray(0, prevName.length - strip), buf.subarray(p, nul)]);
      p = nul + 1;
      prevName = nameBuf;
    } else {
      const nul = buf.indexOf(0, p);
      nameBuf = buf.subarray(p, nul);
      // entry length = (header + name + 8) & ~7
      p = start + ((p - start + nameBuf.length + 8) & ~7);
    }
    e.path = nameBuf.toString("utf8");
    e.stage = (flags & CE_STAGEMASK) >> 12;
    e.assumeValid = !!(flags & CE_VALID);
    e.skipWorktree = !!(flags2 & CE_SKIP_WORKTREE);
    e.intentToAdd = !!(flags2 & CE_INTENT_TO_ADD);
    entries.push(e);
  }
  let sparse = false, splitLink = null;
  const end = buf.length - hashLen;
  while (p + 8 <= end) {
    const sig = buf.toString("latin1", p, p + 4);
    const size = buf.readUInt32BE(p + 4);
    const body = buf.subarray(p + 8, p + 8 + size);
    if (sig === "sdir") sparse = true;
    else if (sig === "link") {
      const oid = body.toString("hex", 0, hashLen);
      let q = hashLen;
      const readEwah = () => {
        // EWAH bitmap: u32 bit count, u32 word count, words (u64), u32 rlw position.
        const bits = body.readUInt32BE(q);
        const words = body.readUInt32BE(q + 4);
        const start = q;
        q += 8 + words * 8 + 4;
        return { bits, words, raw: body.subarray(start, q) };
      };
      const del = q < body.length ? readEwah() : null;
      const rep = q < body.length ? readEwah() : null;
      splitLink = { oid, deleteBits: del ? decodeEwah(del.raw) : [], replaceBits: rep ? decodeEwah(rep.raw) : [] };
    } else if (sig[0] >= "A" && sig[0] <= "Z") {
      // optional extension - skip
    } else if (!["TREE", "REUC", "UNTR", "FSMN", "EOIE", "IEOT"].includes(sig)) {
      throw new Error(`index uses required extension '${sig}' this reader does not understand`);
    }
    p += 8 + size;
  }
  return { version, entries, sparse, splitLink };
}

/** Decode an EWAH-compressed bitmap into the list of set bit positions. */
function decodeEwah(raw) {
  const bitCount = raw.readUInt32BE(0);
  const words = raw.readUInt32BE(4);
  const out = [];
  let q = 8, bit = 0, w = 0;
  while (w < words) {
    const rlw = raw.readBigUInt64BE(q); q += 8; w++;
    const runBit = Number(rlw & 1n);
    const runLen = Number((rlw >> 1n) & 0xffffffffn);
    const lit = Number(rlw >> 33n);
    if (runBit) for (let k = 0; k < runLen * 64; k++) out.push(bit + k);
    bit += runLen * 64;
    for (let k = 0; k < lit; k++) {
      const word = raw.readBigUInt64BE(q); q += 8; w++;
      for (let b = 0; b < 64; b++) if ((word >> BigInt(b)) & 1n) out.push(bit + b);
      bit += 64;
    }
  }
  return out.filter((b) => b < bitCount);
}

/**
 * Read the index of a git dir, merging a split index's shared part.
 * Missing index -> empty entry list (a fresh repository).
 */
export function readIndex(gitDir, { hashLen = 20, indexFile = null } = {}) {
  const file = indexFile ?? path.join(gitDir, "index");
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { if (e.code === "ENOENT") return { version: null, entries: [], sparse: false, mtime: null }; throw e; }
  const st = fs.statSync(file, { bigint: true });
  const parsed = parseIndex(buf, { hashLen });
  let entries = parsed.entries;
  if (parsed.splitLink) {
    const shared = parseIndex(fs.readFileSync(path.join(gitDir, `sharedindex.${parsed.splitLink.oid}`)), { hashLen });
    // git: shared entries, with deleted ones dropped and replaced ones taking
    // the NEXT split-index entry in order; remaining split entries are new.
    const del = new Set(parsed.splitLink.deleteBits);
    const rep = new Set(parsed.splitLink.replaceBits);
    const own = parsed.entries;
    let k = 0;
    const merged = [];
    shared.entries.forEach((e, i) => {
      if (rep.has(i)) { const r = own[k++]; merged.push({ ...r, path: r.path || e.path }); return; }
      if (del.has(i)) return;
      merged.push(e);
    });
    for (; k < own.length; k++) merged.push(own[k]);
    merged.sort((a, b) => cmpPath(a.path, b.path) || a.stage - b.stage);
    entries = merged;
  }
  return { version: parsed.version, entries, sparse: parsed.sparse, mtime: { s: Number(st.mtimeNs / 1000000000n), ns: Number(st.mtimeNs % 1000000000n) } };
}

/** Byte-order (UTF-8) comparison of two JS strings: compare by code point. */
export function cmpPath(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x === y) continue;
    // Surrogates (astral code points) sort after every BMP character in UTF-8 order.
    const xs = x >= 0xd800 && x <= 0xdfff, ys = y >= 0xd800 && y <= 0xdfff;
    if (xs !== ys) return xs ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
