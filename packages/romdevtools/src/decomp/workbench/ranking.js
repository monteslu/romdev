// ranking.js - stamp a closeness ranking with the tree it was measured
// against, and check a stamped ranking against the tree in front of you.
//
// A ranking is a measurement and it decays: every function that matches,
// every source edit that moves a word, changes the ordering it encodes. A
// ranking that records the tree hash it was computed against can be checked,
// so a consumer can say "this ordering is a measurement of a different tree"
// instead of quietly trusting it. Nothing here recomputes a ranking.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { revParseHead } from "../../git/index.js";
import { randomBytes } from "node:crypto";
import { ValueError, strip } from "./py.js";
import { dumps } from "./pyjson.js";

export const RANKING_STAMP_SCHEMA = "decomp-workbench-ranking-stamp-v1";
export const STAMP_KEY = "stamp";
export const STATUSES = Object.freeze(["fresh", "unstamped", "unknown", "stale", "missing"]);

const expand = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);

/** ISO-8601 UTC with seconds and a Z suffix, the original's stamp spelling. */
export function timestamp(moment) {
  return moment.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const utcNow = () => new Date();

/**
 * The project's current commit (what `git rev-parse HEAD` prints), or null
 * when it cannot be read. Read by romdev's pure-JS git reader - no git
 * process. `readHead` is injectable for tests.
 */
export function gitHead(root, { readHead = revParseHead } = {}) {
  let head;
  try {
    head = readHead(String(root));
  } catch {
    return null;
  }
  head = strip(head ?? "");
  return head || null;
}

/** What tree a ranking was measured against, and when. */
export class RankingStamp {
  constructor({ tree_hash, generated_at }) { this.tree_hash = tree_hash; this.generated_at = generated_at; Object.freeze(this); }
  asDict() { return { schema: RANKING_STAMP_SCHEMA, tree_hash: this.tree_hash, generated_at: this.generated_at }; }
}

/** The stamp a ranking now carries, and whether the file changed. */
export class StampResult {
  constructor({ path: p, stamp, changed }) { this.path = p; this.stamp = stamp; this.changed = changed; Object.freeze(this); }
  asDict() {
    return { schema: RANKING_STAMP_SCHEMA, path: String(this.path), tree_hash: this.stamp.tree_hash, generated_at: this.stamp.generated_at, changed: this.changed };
  }
}

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

/** Read a ranking as a mutable document, whatever spelling it uses. */
function document(p, label = p) {
  const payload = JSON.parse(fs.readFileSync(p, "utf8"));
  if (Array.isArray(payload)) return { functions: payload };
  if (payload && typeof payload === "object") return { ...payload };
  throw new ValueError(`${label}: a ranking must be a JSON list or object`);
}

/** The stamp a ranking carries, or null when it carries none. */
export function readStamp(p, { cwd = process.cwd() } = {}) {
  const source = path.resolve(cwd, expand(String(p)));
  if (!isFile(source)) return null;
  let doc;
  try { doc = document(source); } catch { return null; }
  const raw = doc[STAMP_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { tree_hash: treeHash, generated_at: generatedAt } = raw;
  if (typeof treeHash !== "string" || !strip(treeHash)) return null;
  return new RankingStamp({ tree_hash: treeHash, generated_at: typeof generatedAt === "string" ? generatedAt : "" });
}

/** Replace one file's contents, or leave the old contents in place. */
export function writeAtomic(p, text, { rename = fs.renameSync } = {}) {
  const temporary = path.join(path.dirname(p), `tmp${randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
    rename(temporary, p);
  } catch (e) {
    try { fs.unlinkSync(temporary); } catch { /* already gone */ }
    throw e;
  }
}

/**
 * Record the tree a ranking was measured against, idempotently. Re-stamping
 * the same tree keeps the original generated_at; the rewrite is atomic; a
 * bare-list ranking is wrapped under `functions`.
 */
export function stampRanking(p, treeHash, { now = utcNow, rename, cwd = process.cwd() } = {}) {
  const target = expand(String(p));
  const file = path.resolve(cwd, target);
  if (!strip(treeHash)) throw new ValueError("a ranking stamp needs a non-empty tree hash");
  const doc = document(file, target);
  const existing = readStamp(file);
  if (existing !== null && existing.tree_hash === treeHash) return new StampResult({ path: target, stamp: existing, changed: false });
  const stamp = new RankingStamp({ tree_hash: treeHash, generated_at: timestamp(now()) });
  doc[STAMP_KEY] = stamp.asDict();
  writeAtomic(file, dumps(doc, { indent: 2, sortKeys: false }) + "\n", { rename });
  return new StampResult({ path: target, stamp, changed: true });
}

/** Whether a ranking describes the tree the caller is standing in. */
export class Freshness {
  constructor({ path: p, status, stamp = null, current_hash = null }) {
    this.path = p; this.status = status; this.stamp = stamp; this.current_hash = current_hash; Object.freeze(this);
  }
  get fresh() { return this.status === "fresh"; }
  get message() {
    const stamped = this.stamp ? this.stamp.tree_hash.slice(0, 12) : "(none)";
    const head = this.current_hash ? this.current_hash.slice(0, 12) : "(unknown)";
    if (this.status === "fresh") return `ranking ${this.path} is stamped for the current tree ${head}`;
    if (this.status === "missing") return `ranking ${this.path} does not exist`;
    if (this.status === "unstamped") {
      return `ranking ${this.path} carries no tree stamp, so its drift from this tree cannot be measured. `
        + "Stamp it where it is generated: `decomp-workbench ranking stamp <path>`";
    }
    if (this.status === "unknown") {
      return `ranking ${this.path} is stamped for tree ${stamped}, but this project's HEAD could not be read, so the two cannot be compared`;
    }
    return `ranking ${this.path} was measured against tree ${stamped}, but HEAD is ${head}. A closeness ranking decays within hours -- `
      + "a function that matched is still in it, and the ordering it encodes is a measurement of a different tree. "
      + "Regenerate it before trusting the order";
  }
  asDict() {
    return { schema: RANKING_STAMP_SCHEMA, path: String(this.path), status: this.status, fresh: this.fresh,
      tree_hash: this.stamp ? this.stamp.tree_hash : null, generated_at: this.stamp ? this.stamp.generated_at : null,
      current_hash: this.current_hash, message: this.message };
  }
}

/** Compare a ranking's stamp with the tree hash the caller is on. */
export function checkRankingFresh(p, currentHash, { cwd = process.cwd() } = {}) {
  const target = expand(String(p));
  const file = path.resolve(cwd, target);
  if (!isFile(file)) return new Freshness({ path: target, status: "missing", current_hash: currentHash });
  const stamp = readStamp(file);
  if (stamp === null) return new Freshness({ path: target, status: "unstamped", current_hash: currentHash });
  if (currentHash === null || currentHash === undefined) return new Freshness({ path: target, status: "unknown", stamp, current_hash: null });
  return new Freshness({ path: target, status: stamp.tree_hash === currentHash ? "fresh" : "stale", stamp, current_hash: currentHash });
}

/** One freshness verdict for a human reading a terminal. */
export function renderFreshness(f) {
  const lines = [
    `ranking ${f.path}`,
    `  status          ${f.status}`,
    `  stamped tree    ${f.stamp ? f.stamp.tree_hash : "-"}`,
    `  generated at    ${f.stamp ? f.stamp.generated_at : "-"}`,
    `  current HEAD    ${f.current_hash || "(unknown)"}`,
  ];
  if (!f.fresh) lines.push(`  warning         ${f.message}`);
  return lines;
}

/** The loud line: only for a ranking that contradicts, or cannot be compared to, the tree. */
export function freshnessWarning(f) {
  if (["fresh", "missing", "unstamped"].includes(f.status)) return null;
  return `WARNING: ${f.message}`;
}

/** The quiet line for a ranking nobody has stamped yet. */
export function freshnessNote(f) {
  if (f.status !== "unstamped") return null;
  return `note: ${f.message}`;
}
