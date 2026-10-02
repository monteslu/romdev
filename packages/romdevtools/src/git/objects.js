// objects.js - read a git object database without git: loose objects,
// pack files (v2/v3 packs, v1/v2 .idx, OFS_DELTA and REF_DELTA chains),
// alternates, and the object-count / prefix queries git's abbreviation
// logic needs.
//
// Reads are positioned (fs.readSync on the pack fd) and bounded by the next
// entry's offset, so a 100MB pack is never slurped to resolve one tree.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";

export const OBJ_COMMIT = 1, OBJ_TREE = 2, OBJ_BLOB = 3, OBJ_TAG = 4, OBJ_OFS_DELTA = 6, OBJ_REF_DELTA = 7;
const TYPE_NAMES = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const NAME_TYPES = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Hash an object the way git does: "<type> <size>\0<content>". */
export function hashObject(type, data, algo = "sha1") {
  const h = createHash(algo);
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest("hex");
}

/** Apply a git delta to `base`. */
export function applyDelta(base, delta) {
  let p = 0;
  const readSize = () => {
    let r = 0, s = 0, b;
    do { b = delta[p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80);
    return r;
  };
  const srcSize = readSize();
  if (srcSize !== base.length) throw new Error(`delta base size ${srcSize} != ${base.length}`);
  const dstSize = readSize();
  const out = Buffer.allocUnsafe(dstSize);
  let o = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let off = 0, size = 0;
      if (op & 0x01) off += delta[p++];
      if (op & 0x02) off += delta[p++] << 8;
      if (op & 0x04) off += delta[p++] << 16;
      if (op & 0x08) off += delta[p++] * 0x1000000;
      if (op & 0x10) size += delta[p++];
      if (op & 0x20) size += delta[p++] << 8;
      if (op & 0x40) size += delta[p++] << 16;
      if (size === 0) size = 0x10000;
      if (off + size > base.length || o + size > dstSize) throw new Error("delta copy out of range");
      base.copy(out, o, off, off + size);
      o += size;
    } else if (op) {
      if (o + op > dstSize) throw new Error("delta insert out of range");
      delta.copy(out, o, p, p + op);
      p += op; o += op;
    } else throw new Error("delta opcode 0 is reserved");
  }
  if (o !== dstSize) throw new Error(`delta produced ${o} bytes, expected ${dstSize}`);
  return out;
}

class PackIndex {
  constructor(idxPath, hashLen) {
    this.idxPath = idxPath;
    this.packPath = idxPath.replace(/\.idx$/, ".pack");
    this.hashLen = hashLen;
    const buf = fs.readFileSync(idxPath);
    this.buf = buf;
    if (buf.readUInt32BE(0) === 0xff744f63) {
      const version = buf.readUInt32BE(4);
      if (version !== 2) throw new Error(`unsupported pack index version ${version} (${idxPath})`);
      this.version = 2;
      this.fanoutAt = 8;
    } else { this.version = 1; this.fanoutAt = 0; }
    this.count = buf.readUInt32BE(this.fanoutAt + 255 * 4);
    if (this.version === 2) {
      this.namesAt = this.fanoutAt + 1024;
      this.crcAt = this.namesAt + this.count * hashLen;
      this.offAt = this.crcAt + this.count * 4;
      this.bigAt = this.offAt + this.count * 4;
    } else {
      this.entriesAt = this.fanoutAt + 1024;
    }
    this.fd = null;
    this.sortedOffsets = null;
    this.packSize = null;
  }

  nameAt(i) {
    return this.version === 2
      ? this.buf.subarray(this.namesAt + i * this.hashLen, this.namesAt + (i + 1) * this.hashLen)
      : this.buf.subarray(this.entriesAt + i * (4 + this.hashLen) + 4, this.entriesAt + (i + 1) * (4 + this.hashLen));
  }

  offsetAt(i) {
    if (this.version === 1) return this.buf.readUInt32BE(this.entriesAt + i * (4 + this.hashLen));
    const v = this.buf.readUInt32BE(this.offAt + i * 4);
    if (!(v & 0x80000000)) return v;
    const k = v & 0x7fffffff;
    return Number(this.buf.readBigUInt64BE(this.bigAt + k * 8));
  }

  /** Index of the first name >= oid (binary search inside the fanout bucket). */
  lowerBound(oid) {
    const first = oid[0];
    let lo = first === 0 ? 0 : this.buf.readUInt32BE(this.fanoutAt + (first - 1) * 4);
    let hi = this.buf.readUInt32BE(this.fanoutAt + first * 4);
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (Buffer.compare(this.nameAt(mid), oid) < 0) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  find(oid) {
    const i = this.lowerBound(oid);
    if (i < this.count && this.nameAt(i).equals(oid)) return this.offsetAt(i);
    return -1;
  }

  open() {
    if (this.fd === null) {
      this.fd = fs.openSync(this.packPath, "r");
      this.packSize = fs.fstatSync(this.fd).size;
    }
    return this.fd;
  }

  /** End of the entry at `offset` (the next entry's start, or the trailer). */
  entryEnd(offset) {
    if (!this.sortedOffsets) {
      const a = new Float64Array(this.count);
      for (let i = 0; i < this.count; i++) a[i] = this.offsetAt(i);
      a.sort();
      this.sortedOffsets = a;
    }
    const a = this.sortedOffsets;
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (a[mid] <= offset) lo = mid + 1; else hi = mid; }
    this.open();
    return lo < a.length ? a[lo] : this.packSize - this.hashLen;
  }

  read(pos, len) {
    const fd = this.open();
    const b = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const r = fs.readSync(fd, b, got, len - got, pos + got);
      if (r === 0) break;
      got += r;
    }
    return got === len ? b : b.subarray(0, got);
  }

  close() { if (this.fd !== null) { try { fs.closeSync(this.fd); } catch {} this.fd = null; } }
}

/** The object directories: the repo's own plus objects/info/alternates (recursively). */
function objectDirs(objectsDir, seen = new Set()) {
  const real = path.resolve(objectsDir);
  if (seen.has(real)) return [];
  seen.add(real);
  const out = [real];
  let alt;
  try { alt = fs.readFileSync(path.join(real, "info", "alternates"), "utf8"); } catch { return out; }
  for (let line of alt.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("\"")) line = JSON.parse(line);
    const p = path.isAbsolute(line) ? line : path.join(real, line);
    out.push(...objectDirs(p, seen));
  }
  return out;
}

export class ObjectStore {
  /**
   * @param {string} objectsDir the repository's objects/ directory
   * @param {"sha1"|"sha256"} [algo]
   */
  constructor(objectsDir, algo = "sha1") {
    this.algo = algo;
    this.hashLen = algo === "sha256" ? 32 : 20;
    this.hexLen = this.hashLen * 2;
    this.dirs = objectDirs(objectsDir);
    this._packs = null;
    this.cache = new Map(); // key -> {type, data}
    this.cacheBytes = 0;
  }

  get packs() {
    if (this._packs) return this._packs;
    const packs = [];
    for (const d of this.dirs) {
      let names;
      try { names = fs.readdirSync(path.join(d, "pack")); } catch { continue; }
      for (const n of names.sort()) {
        if (!n.endsWith(".idx")) continue;
        const idx = path.join(d, "pack", n);
        if (!fs.existsSync(idx.replace(/\.idx$/, ".pack"))) continue;
        packs.push(new PackIndex(idx, this.hashLen));
      }
    }
    this._packs = packs;
    return packs;
  }

  close() { if (this._packs) for (const p of this._packs) p.close(); }

  remember(key, obj) {
    if (obj.data.length > 4 << 20) return;
    this.cache.set(key, obj);
    this.cacheBytes += obj.data.length;
    while (this.cacheBytes > 64 << 20 || this.cache.size > 4096) {
      const [k, v] = this.cache.entries().next().value;
      this.cache.delete(k);
      this.cacheBytes -= v.data.length;
    }
  }

  readPacked(pack, offset, depth = 0) {
    const key = pack.packPath + "@" + offset;
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (depth > 10000) throw new Error("delta chain too deep");
    const end = pack.entryEnd(offset);
    const raw = pack.read(offset, end - offset);
    let p = 0;
    let b = raw[p++];
    const type = (b >> 4) & 7;
    let size = b & 15, shift = 4;
    while (b & 0x80) { b = raw[p++]; size += (b & 0x7f) * 2 ** shift; shift += 7; }
    let obj;
    if (type === OBJ_OFS_DELTA) {
      b = raw[p++];
      let rel = b & 0x7f;
      while (b & 0x80) { b = raw[p++]; rel = (rel + 1) * 128 + (b & 0x7f); }
      const base = this.readPacked(pack, offset - rel, depth + 1);
      const delta = zlib.inflateSync(raw.subarray(p));
      obj = { type: base.type, data: applyDelta(base.data, delta) };
    } else if (type === OBJ_REF_DELTA) {
      const baseOid = raw.subarray(p, p + this.hashLen).toString("hex");
      p += this.hashLen;
      const base = this.read(baseOid, depth + 1);
      if (!base) throw new Error(`missing delta base ${baseOid}`);
      const delta = zlib.inflateSync(raw.subarray(p));
      obj = { type: base.type, data: applyDelta(base.data, delta) };
    } else if (TYPE_NAMES[type]) {
      const data = zlib.inflateSync(raw.subarray(p));
      if (data.length !== size) throw new Error(`pack object size ${data.length} != ${size}`);
      obj = { type: TYPE_NAMES[type], data };
    } else throw new Error(`bad pack object type ${type} at ${offset} in ${pack.packPath}`);
    this.remember(key, obj);
    return obj;
  }

  readLoose(oidHex) {
    for (const d of this.dirs) {
      let buf;
      try { buf = fs.readFileSync(path.join(d, oidHex.slice(0, 2), oidHex.slice(2))); } catch { continue; }
      const raw = zlib.inflateSync(buf);
      const nul = raw.indexOf(0);
      const [type, sizeStr] = raw.subarray(0, nul).toString("latin1").split(" ");
      const data = raw.subarray(nul + 1);
      if (Number(sizeStr) !== data.length) throw new Error(`loose object ${oidHex} is corrupt`);
      return { type, data };
    }
    return null;
  }

  /** Read an object by hex id -> {type, data} or null when absent. */
  read(oidHex, depth = 0) {
    oidHex = oidHex.toLowerCase();
    const hit = this.cache.get(oidHex);
    if (hit) return hit;
    const oid = Buffer.from(oidHex, "hex");
    for (const pack of this.packs) {
      const off = pack.find(oid);
      if (off >= 0) { const o = this.readPacked(pack, off, depth); return o; }
    }
    const o = this.readLoose(oidHex);
    if (o) this.remember(oidHex, o);
    return o;
  }

  has(oidHex) {
    const oid = Buffer.from(oidHex, "hex");
    for (const pack of this.packs) if (pack.find(oid) >= 0) return true;
    for (const d of this.dirs) if (fs.existsSync(path.join(d, oidHex.slice(0, 2), oidHex.slice(2)))) return true;
    return false;
  }

  /** Read and require a type. */
  readTyped(oidHex, type) {
    const o = this.read(oidHex);
    if (!o) throw new Error(`object ${oidHex} not found`);
    if (o.type !== type) throw new Error(`object ${oidHex} is a ${o.type}, not a ${type}`);
    return o.data;
  }

  /** Peel tags until a non-tag object. */
  peel(oidHex) {
    for (let i = 0; i < 64; i++) {
      const o = this.read(oidHex);
      if (!o) return null;
      if (o.type !== "tag") return { oid: oidHex, type: o.type };
      const m = /^object ([0-9a-f]+)/.exec(o.data.toString("latin1"));
      if (!m) return null;
      oidHex = m[1];
    }
    return null;
  }

  /** A commit's root tree id. */
  commitTree(commitOid) {
    const peeled = this.peel(commitOid);
    if (!peeled || peeled.type !== "commit") throw new Error(`${commitOid} is not a commit`);
    const data = this.readTyped(peeled.oid, "commit");
    const m = /^tree ([0-9a-f]+)/.exec(data.toString("latin1"));
    if (!m) throw new Error(`commit ${commitOid} has no tree`);
    return m[1];
  }

  /** Parse a tree object -> [{mode, name, oid}]; names are UTF-8 decoded. */
  readTree(treeOid) {
    const data = this.readTyped(treeOid, "tree");
    const out = [];
    let p = 0;
    while (p < data.length) {
      const sp = data.indexOf(0x20, p);
      const nul = data.indexOf(0, sp);
      const mode = parseInt(data.toString("latin1", p, sp), 8);
      const name = data.toString("utf8", sp + 1, nul);
      const oid = data.toString("hex", nul + 1, nul + 1 + this.hashLen);
      out.push({ mode, name, oid });
      p = nul + 1 + this.hashLen;
    }
    return out;
  }

  /** Flatten a tree recursively into Map path -> {mode, oid} (no tree entries). */
  flattenTree(treeOid, prefix = "", out = new Map()) {
    for (const e of this.readTree(treeOid)) {
      const p = prefix + e.name;
      if ((e.mode & 0o170000) === 0o040000) this.flattenTree(e.oid, p + "/", out);
      else out.set(p, { mode: e.mode, oid: e.oid });
    }
    return out;
  }

  /** Resolve "<tree-ish>:<path>" style lookups: the entry at `relPath` under tree `treeOid`. */
  lookupPath(treeOid, relPath) {
    const parts = relPath.split("/").filter(Boolean);
    let cur = { mode: 0o040000, oid: treeOid };
    for (const part of parts) {
      if ((cur.mode & 0o170000) !== 0o040000) return null;
      const e = this.readTree(cur.oid).find((x) => x.name === part);
      if (!e) return null;
      cur = e;
    }
    return cur;
  }

  /**
   * git's repo_approximate_object_count(): the objects in packs (a
   * multi-pack-index counts for the packs it covers). Loose objects are not
   * counted, exactly as git does not count them.
   */
  approximateObjectCount() {
    let count = 0;
    for (const d of this.dirs) {
      const midx = readMidx(path.join(d, "pack", "multi-pack-index"));
      const covered = new Set(midx ? midx.packNames.map((n) => n.replace(/\.(pack|idx)$/, "")) : []);
      if (midx) count += midx.count;
      for (const p of this.packs) {
        if (path.dirname(path.dirname(p.idxPath)) !== d) continue;
        if (covered.has(path.basename(p.idxPath).replace(/\.idx$/, ""))) continue;
        count += p.count;
      }
    }
    return count;
  }

  /**
   * Hex length of the longest prefix `oidHex` shares with ANY other object
   * in the database (0 when none shares even one digit).
   */
  longestSharedPrefix(oidHex) {
    const oid = Buffer.from(oidHex, "hex");
    let best = 0;
    const common = (a) => {
      const h = a.toString("hex");
      let i = 0;
      while (i < h.length && h[i] === oidHex[i]) i++;
      return i;
    };
    for (const pack of this.packs) {
      const i = pack.lowerBound(oid);
      for (const j of [i - 1, i, i + 1]) {
        if (j < 0 || j >= pack.count) continue;
        const name = pack.nameAt(j);
        if (name.equals(oid)) continue;
        best = Math.max(best, common(name));
      }
    }
    const dir2 = oidHex.slice(0, 2);
    for (const d of this.dirs) {
      let names;
      try { names = fs.readdirSync(path.join(d, dir2)); } catch { continue; }
      for (const n of names) {
        if (n.length !== this.hexLen - 2 || dir2 + n === oidHex) continue;
        const full = dir2 + n;
        let i = 0;
        while (i < full.length && full[i] === oidHex[i]) i++;
        best = Math.max(best, i);
      }
    }
    return best;
  }
}

/** Minimal multi-pack-index reader: object count + covered pack names. */
function readMidx(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (buf.toString("latin1", 0, 4) !== "MIDX") return null;
  const chunks = buf[6];
  const packCount = buf.readUInt32BE(8);
  const table = new Map();
  for (let i = 0; i <= chunks; i++) {
    const at = 12 + i * 12;
    table.set(buf.toString("latin1", at, at + 4), Number(buf.readBigUInt64BE(at + 4)));
  }
  const ids = [...table.entries()].sort((a, b) => a[1] - b[1]);
  const startOf = (id) => table.get(id);
  const endOf = (id) => { const k = ids.findIndex(([x]) => x === id); return ids[k + 1]?.[1] ?? buf.length; };
  const pnam = startOf("PNAM");
  const names = pnam !== undefined ? buf.toString("utf8", pnam, endOf("PNAM")).split("\0").filter(Boolean).slice(0, packCount) : [];
  const oidf = startOf("OIDF");
  const count = oidf !== undefined ? buf.readUInt32BE(oidf + 255 * 4) : 0;
  return { count, packNames: names };
}

export { TYPE_NAMES, NAME_TYPES };
