// git-writer.js - build real, on-disk git repositories from JS for the git
// reader's tests: loose objects, trees, commits, refs (loose and packed),
// index files (v2, v3, v4, with skip-worktree / intent-to-add / stage
// flags), pack files with OFS_DELTA and REF_DELTA entries plus their v2
// .idx, gitfiles (submodules, linked worktrees).
//
// The layout written is git's own, so the repositories are also readable by
// git itself (the oracle comparison in the commit that added src/git/ used
// that); the tests never launch git.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";

const sha1 = (...bufs) => { const h = createHash("sha1"); for (const b of bufs) h.update(b); return h.digest(); };

/** git's offset varint (index v4 prefix lengths, OFS_DELTA distances). */
export function encodeOffsetVarint(value) {
  const out = [value & 127];
  while ((value = Math.floor(value / 128))) { value--; out.unshift(128 | (value & 127)); }
  return Buffer.from(out);
}

function sizeVarint(n) {
  const out = [];
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}

/** A delta from base to target: copy the common prefix and suffix, insert the middle. */
export function makeDelta(base, target) {
  let pre = 0;
  while (pre < base.length && pre < target.length && pre < 0xffffff && base[pre] === target[pre]) pre++;
  let suf = 0;
  while (suf < base.length - pre && suf < target.length - pre && suf < 0xffffff && base[base.length - 1 - suf] === target[target.length - 1 - suf]) suf++;
  const parts = [sizeVarint(base.length), sizeVarint(target.length)];
  const copy = (off, size) => {
    const bytes = [];
    let op = 0x80;
    for (let i = 0; i < 4; i++) { const b = Math.floor(off / 2 ** (8 * i)) & 0xff; if (b) { op |= 1 << i; bytes.push(b); } }
    for (let i = 0; i < 3; i++) { const b = (size >> (8 * i)) & 0xff; if (b) { op |= 0x10 << i; bytes.push(b); } }
    parts.push(Buffer.from([op, ...bytes]));
  };
  if (pre) copy(0, pre);
  for (let i = pre; i < target.length - suf; i += 127) {
    const chunk = target.subarray(i, Math.min(i + 127, target.length - suf));
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  if (suf) copy(base.length - suf, suf);
  return Buffer.concat(parts);
}

const TYPE_NUM = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Tree entry order: names compared as if a directory's name ended in "/". */
function treeOrder(a, b) {
  const ka = Buffer.from(a.name + (a.mode === 0o040000 ? "/" : ""));
  const kb = Buffer.from(b.name + (b.mode === 0o040000 ? "/" : ""));
  return Buffer.compare(ka, kb);
}

export class GitWriter {
  /**
   * @param {string} worktree directory to create the repository in
   * @param {{gitDir?: string, branch?: string, bare?: boolean}} [o] gitDir: put the git dir elsewhere and write a .git FILE
   */
  constructor(worktree, { gitDir = null, branch = "main" } = {}) {
    this.worktree = worktree;
    fs.mkdirSync(worktree, { recursive: true });
    this.gitDir = gitDir ?? path.join(worktree, ".git");
    this.commonDir = this.gitDir;
    for (const d of ["objects/info", "objects/pack", "refs/heads", "refs/tags", "info"]) fs.mkdirSync(path.join(this.gitDir, d), { recursive: true });
    fs.writeFileSync(path.join(this.gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
    fs.writeFileSync(path.join(this.gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n");
    if (gitDir) fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.relative(worktree, gitDir)}\n`);
    this.branch = branch;
    /** @type {Map<string, {mode: number, oid: string, stage?: number, skipWorktree?: boolean, intentToAdd?: boolean, assumeValid?: boolean}>} */
    this.staged = new Map();
    this.extraIndex = []; // unmerged stage entries
    this.objectsWritten = [];
  }

  // ------------------------------------------------------------ objects
  writeObject(type, data) {
    data = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const header = Buffer.from(`${type} ${data.length}\0`);
    const oid = sha1(header, data).toString("hex");
    const p = path.join(this.commonDir, "objects", oid.slice(0, 2), oid.slice(2));
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, zlib.deflateSync(Buffer.concat([header, data])));
      this.objectsWritten.push(oid);
    }
    return oid;
  }

  writeTree(entries) {
    const sorted = [...entries].sort(treeOrder);
    const parts = sorted.map((e) => Buffer.concat([Buffer.from(`${e.mode.toString(8)} ${e.name}\0`), Buffer.from(e.oid, "hex")]));
    return this.writeObject("tree", Buffer.concat(parts));
  }

  /** Build nested trees from a flat Map path -> {mode, oid}. */
  writeTreeFromMap(map) {
    const root = new Map();
    for (const [p, v] of map) {
      if (v.intentToAdd) continue;
      const parts = p.split("/");
      let node = root;
      for (const dir of parts.slice(0, -1)) { if (!node.has(dir)) node.set(dir, new Map()); node = node.get(dir); }
      node.set(parts[parts.length - 1], v);
    }
    const build = (node) => {
      const entries = [];
      for (const [name, v] of node) {
        if (v instanceof Map) entries.push({ name, mode: 0o040000, oid: build(v) });
        else entries.push({ name, mode: v.mode, oid: v.oid });
      }
      return this.writeTree(entries);
    };
    return build(root);
  }

  // ---------------------------------------------------------- worktree
  file(rel, content, { mode = 0o644, stage = true } = {}) {
    const abs = path.join(this.worktree, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    fs.chmodSync(abs, mode);
    if (stage) this.add(rel);
    return abs;
  }

  symlink(rel, target, { stage = true } = {}) {
    const abs = path.join(this.worktree, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.rmSync(abs, { force: true });
    fs.symlinkSync(target, abs);
    if (stage) this.add(rel);
  }

  /** Stage the worktree file at rel (blob + index entry). */
  add(rel, extra = {}) {
    const abs = path.join(this.worktree, rel);
    const st = fs.lstatSync(abs);
    let mode, data;
    if (st.isSymbolicLink()) { mode = 0o120000; data = fs.readlinkSync(abs, { encoding: "buffer" }); }
    else { mode = st.mode & 0o100 ? 0o100755 : 0o100644; data = fs.readFileSync(abs); }
    this.staged.set(rel, { mode, oid: this.writeObject("blob", data), stat: fs.lstatSync(abs, { bigint: true }), ...extra });
  }

  /** Re-record the worktree stat data of every staged path (git update-index --refresh for clean files). */
  refreshStat() {
    for (const [rel, e] of this.staged) {
      if (e.mode === 0o160000) continue;
      try { e.stat = fs.lstatSync(path.join(this.worktree, rel), { bigint: true }); } catch {}
    }
  }

  unstage(rel) { this.staged.delete(rel); }

  /** A gitlink entry (submodule commit) at rel. */
  gitlink(rel, oid) { this.staged.set(rel, { mode: 0o160000, oid }); }

  // ----------------------------------------------------------- commits
  refPath(name) { return path.join(this.commonDir, name); }

  headOid() {
    let t = fs.readFileSync(path.join(this.gitDir, "HEAD"), "utf8").trim();
    for (let i = 0; i < 5 && t.startsWith("ref: "); i++) {
      const name = t.slice(5);
      try { t = fs.readFileSync(this.refPath(name), "utf8").trim(); } catch { return this.packedRef(name); }
    }
    return t || null;
  }

  packedRef(name) {
    try {
      for (const l of fs.readFileSync(path.join(this.commonDir, "packed-refs"), "utf8").split("\n")) {
        const [oid, ref] = l.split(" ");
        if (ref === name) return oid;
      }
    } catch {}
    return null;
  }

  /** Commit the staged entries; moves the current branch (or detached HEAD). Returns the commit id. */
  commit(message, { time = 1577836800 } = {}) {
    const tree = this.writeTreeFromMap(this.staged);
    const parent = this.headOid();
    const sig = `t <t@t> ${time} +0000`;
    const body = `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author ${sig}\ncommitter ${sig}\n\n${message}\n`;
    const oid = this.writeObject("commit", body);
    const head = fs.readFileSync(path.join(this.gitDir, "HEAD"), "utf8").trim();
    if (head.startsWith("ref: ")) this.setRef(head.slice(5), oid);
    else fs.writeFileSync(path.join(this.gitDir, "HEAD"), oid + "\n");
    this.writeIndex();
    return oid;
  }

  setRef(name, oid) {
    const p = this.refPath(name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, oid + "\n");
  }

  detach(oid) { fs.writeFileSync(path.join(this.gitDir, "HEAD"), oid + "\n"); }

  /** Move every loose ref into packed-refs (git pack-refs --all). */
  packRefs() {
    const lines = ["# pack-refs with: peeled fully-peeled sorted "];
    const walk = (dir, prefix) => {
      for (const n of fs.readdirSync(dir).sort()) {
        const p = path.join(dir, n);
        if (fs.statSync(p).isDirectory()) walk(p, prefix + n + "/");
        else { lines.push(`${fs.readFileSync(p, "utf8").trim()} ${prefix}${n}`); fs.rmSync(p); }
      }
    };
    walk(path.join(this.commonDir, "refs"), "refs/");
    fs.writeFileSync(path.join(this.commonDir, "packed-refs"), lines.join("\n") + "\n");
  }

  annotatedTag(name, target, type = "commit") {
    const oid = this.writeObject("tag", `object ${target}\ntype ${type}\ntag ${name}\ntagger t <t@t> 0 +0000\n\nt\n`);
    this.setRef(`refs/tags/${name}`, oid);
    return oid;
  }

  config(text) { fs.appendFileSync(path.join(this.commonDir, "config"), text); }

  // -------------------------------------------------------------- index
  /**
   * Write the index from the staged map (+ unmerged extras).
   * Stat data is what was recorded when each path was staged (or refreshed);
   * statFrom "zero" writes none, as git read-tree does.
   * @param {{version?: number, statFrom?: "recorded"|"zero"}} [o]
   */
  writeIndex({ version = 2, statFrom = "recorded" } = {}) {
    const all = [];
    for (const [p, v] of this.staged) all.push({ path: p, stage: 0, ...v });
    for (const e of this.extraIndex) all.push(e);
    all.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)) || a.stage - b.stage);
    const needExt = all.some((e) => e.skipWorktree || e.intentToAdd);
    if (needExt && version < 3) version = 3;
    const parts = [];
    const head = Buffer.alloc(12);
    head.write("DIRC", 0, "latin1"); head.writeUInt32BE(version, 4); head.writeUInt32BE(all.length, 8);
    parts.push(head);
    let prev = Buffer.alloc(0);
    for (const e of all) {
      const b = Buffer.alloc(62);
      const st = statFrom === "recorded" && e.stage === 0 ? e.stat ?? null : null;
      const u32 = (v) => Number(BigInt.asUintN(32, BigInt(v)));
      if (st) {
        b.writeUInt32BE(u32(st.ctimeNs / 1000000000n), 0); b.writeUInt32BE(u32(st.ctimeNs % 1000000000n), 4);
        b.writeUInt32BE(u32(st.mtimeNs / 1000000000n), 8); b.writeUInt32BE(u32(st.mtimeNs % 1000000000n), 12);
        b.writeUInt32BE(u32(st.dev), 16); b.writeUInt32BE(u32(st.ino), 20);
        b.writeUInt32BE(u32(st.uid), 28); b.writeUInt32BE(u32(st.gid), 32); b.writeUInt32BE(u32(st.size), 36);
      }
      b.writeUInt32BE(e.mode, 24);
      Buffer.from(e.oid, "hex").copy(b, 40);
      const name = Buffer.from(e.path);
      const ext = e.skipWorktree || e.intentToAdd;
      let flags = Math.min(name.length, 0xfff) | (e.stage << 12) | (ext ? 0x4000 : 0) | (e.assumeValid ? 0x8000 : 0);
      b.writeUInt16BE(flags, 60);
      const ent = [b];
      if (version >= 3 && ext) { const f2 = Buffer.alloc(2); f2.writeUInt16BE((e.skipWorktree ? 0x4000 : 0) | (e.intentToAdd ? 0x2000 : 0)); ent.push(f2); }
      if (version === 4) {
        let common = 0;
        while (common < prev.length && common < name.length && prev[common] === name[common]) common++;
        ent.push(encodeOffsetVarint(prev.length - common), name.subarray(common), Buffer.from([0]));
        prev = name;
      } else {
        const len = ent.reduce((n, x) => n + x.length, 0) + name.length;
        const padded = (len + 8) & ~7;
        ent.push(name, Buffer.alloc(padded - len));
      }
      parts.push(...ent);
    }
    const body = Buffer.concat(parts);
    fs.writeFileSync(path.join(this.gitDir, "index"), Buffer.concat([body, sha1(body)]));
  }

  // --------------------------------------------------------------- packs
  /**
   * Move every loose object into one pack. Objects of the same type are
   * chained as deltas: alternating OFS_DELTA and REF_DELTA against the
   * previous object of that type, so both delta kinds are exercised.
   */
  pack({ deltas = true } = {}) {
    const objs = [];
    const objDir = path.join(this.commonDir, "objects");
    for (const d of fs.readdirSync(objDir)) {
      if (!/^[0-9a-f]{2}$/.test(d)) continue;
      for (const f of fs.readdirSync(path.join(objDir, d))) {
        const raw = zlib.inflateSync(fs.readFileSync(path.join(objDir, d, f)));
        const nul = raw.indexOf(0);
        const type = raw.subarray(0, nul).toString().split(" ")[0];
        objs.push({ oid: d + f, type, data: raw.subarray(nul + 1) });
      }
    }
    objs.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.oid < b.oid ? -1 : 1));
    const chunks = [];
    const head = Buffer.alloc(12);
    head.write("PACK", 0, "latin1"); head.writeUInt32BE(2, 4); head.writeUInt32BE(objs.length, 8);
    chunks.push(head);
    let offset = 12;
    const entries = [];
    const lastOfType = new Map();
    let k = 0;
    for (const o of objs) {
      const base = deltas ? lastOfType.get(o.type) : null;
      let typeNum = TYPE_NUM[o.type], payload = o.data, extra = Buffer.alloc(0);
      if (base) {
        const delta = makeDelta(base.data, o.data);
        if (k++ % 2 === 0) { typeNum = 6; extra = encodeOffsetVarint(offset - base.offset); }
        else { typeNum = 7; extra = Buffer.from(base.oid, "hex"); }
        payload = delta;
      }
      const hdr = [];
      let size = payload.length;
      let byte = (typeNum << 4) | (size & 15);
      size = Math.floor(size / 16);
      while (size) { hdr.push(byte | 0x80); byte = size & 0x7f; size = Math.floor(size / 128); }
      hdr.push(byte);
      const entry = Buffer.concat([Buffer.from(hdr), extra, zlib.deflateSync(payload)]);
      entries.push({ oid: o.oid, offset, crc: zlib.crc32(entry) });
      chunks.push(entry);
      lastOfType.set(o.type, { data: o.data, offset, oid: o.oid });
      offset += entry.length;
    }
    const packBody = Buffer.concat(chunks);
    const packSum = sha1(packBody);
    const name = packSum.toString("hex");
    fs.writeFileSync(path.join(objDir, "pack", `pack-${name}.pack`), Buffer.concat([packBody, packSum]));
    entries.sort((a, b) => (a.oid < b.oid ? -1 : 1));
    const idx = [Buffer.from([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2])];
    const fan = Buffer.alloc(1024);
    for (let i = 0; i < 256; i++) fan.writeUInt32BE(entries.filter((e) => parseInt(e.oid.slice(0, 2), 16) <= i).length, i * 4);
    idx.push(fan);
    for (const e of entries) idx.push(Buffer.from(e.oid, "hex"));
    for (const e of entries) { const b = Buffer.alloc(4); b.writeUInt32BE(e.crc); idx.push(b); }
    for (const e of entries) { const b = Buffer.alloc(4); b.writeUInt32BE(e.offset); idx.push(b); }
    idx.push(packSum);
    const idxBody = Buffer.concat(idx);
    fs.writeFileSync(path.join(objDir, "pack", `pack-${name}.idx`), Buffer.concat([idxBody, sha1(idxBody)]));
    for (const d of fs.readdirSync(objDir)) if (/^[0-9a-f]{2}$/.test(d)) fs.rmSync(path.join(objDir, d), { recursive: true });
    return name;
  }

  // ---------------------------------------------------- linked worktrees
  /** A linked worktree at `dir` (git worktree add --detach): own HEAD/index, shared objects/refs. */
  linkedWorktree(dir, name, oid) {
    const gd = path.join(this.commonDir, "worktrees", name);
    fs.mkdirSync(gd, { recursive: true });
    fs.writeFileSync(path.join(gd, "commondir"), "../..\n");
    fs.writeFileSync(path.join(gd, "HEAD"), oid + "\n");
    fs.writeFileSync(path.join(gd, "gitdir"), path.join(dir, ".git") + "\n");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${gd}\n`);
    const w = Object.create(GitWriter.prototype);
    Object.assign(w, { worktree: dir, gitDir: gd, commonDir: this.commonDir, branch: null, staged: new Map(), extraIndex: [], objectsWritten: [] });
    return w;
  }
}
