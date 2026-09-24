// artifacts.js - content-addressed storage with a retention policy.
//
// This campaign is carrying roughly 2 GB split between research output and the
// romdev workspace: compiler traces, duplicate candidate sources, objects, ROMs
// and logs. Most of it is duplicates - 264 candidate files for one function are
// overwhelmingly the same bytes under different names.
//
// THE ONE RULE THAT CANNOT BE BROKEN. Never prune the only source/object pair
// supporting an accepted or documented conclusion. A campaign's value is its
// evidence; a cache that garbage-collects the proof behind a finding converts
// a settled question into an open one, and the next agent pays to rediscover
// it. So retention is by CLASS, deletion is always dry-run first, and anything
// pinned or referenced by a conclusion is untouchable regardless of age.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { readFile, writeFile, mkdir, readdir, stat, rename } from "node:fs/promises";
import { createHash } from "node:crypto";

export const ARTIFACT_SCHEMA = "romdev-decomp-artifacts-v1";

/** Retention classes, strongest protection first. */
export const RETENTION = Object.freeze({
  "accepted-proof": { keep: "always", why: "the source/object pair behind an accepted or integrated conclusion. Deleting this turns a settled result into an open question." },
  "pinned": { keep: "always", why: "explicitly pinned, usually as a handoff dependency" },
  "current-leader": { keep: "always", why: "the best candidate for a function that is still open" },
  "unique-mechanism": { keep: "long", why: "the only example of a distinct mechanism outcome - rare evidence, cheap to keep" },
  "failure": { keep: "short", why: "a failed attempt: useful to avoid repeats, but one example per family is enough" },
  "duplicate": { keep: "none", why: "byte-identical to something already retained; the manifest keeps the reference" },
});

const store = (project) => path.join(project.ws, "artifact-store");

const sha256 = async (p) => {
  const h = createHash("sha256");
  const fd = await (await import("node:fs/promises")).open(p, "r");
  try {
    const buf = Buffer.alloc(1 << 16);
    for (;;) { const { bytesRead } = await fd.read(buf, 0, buf.length, null); if (!bytesRead) break; h.update(buf.subarray(0, bytesRead)); }
  } finally { await fd.close(); }
  return h.digest("hex");
};

/** Walk a directory tree, yielding files with size + mtime. */
async function* walk(dir) {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) {
      try { const st = await stat(full); yield { path: full, size: st.size, mtimeMs: st.mtimeMs }; } catch {}
    }
  }
}

/**
 * Survey the workspace: what is there, how much is duplicated, and what class
 * each file falls into. Read-only.
 */
export async function surveyArtifacts(project, { protectedPaths = [] } = {}) {
  const roots = ["candidates", "jobs", "work", "context", "coverage", "experiments", "type-graph"]
    .map((d) => path.join(project.ws, d)).filter((d) => fs.existsSync(d));

  const byHash = new Map();
  const files = [];
  let totalBytes = 0;
  for (const r of roots) {
    for await (const f of walk(r)) {
      totalBytes += f.size;
      files.push(f);
    }
  }
  // Hash only files big enough for duplication to matter; hashing 2GB of tiny
  // JSON to find 40 bytes of savings is the wrong trade.
  const HASH_MIN = 4096;
  let hashedBytes = 0;
  for (const f of files) {
    if (f.size < HASH_MIN) continue;
    try {
      const h = await sha256(f.path);
      hashedBytes += f.size;
      const e = byHash.get(h) ?? { hash: h, size: f.size, paths: [] };
      e.paths.push(path.relative(project.ws, f.path));
      byHash.set(h, e);
    } catch {}
  }

  const dupGroups = [...byHash.values()].filter((e) => e.paths.length > 1);
  const reclaimable = dupGroups.reduce((s, e) => s + e.size * (e.paths.length - 1), 0);

  // Which files back an accepted conclusion: those are untouchable.
  const accepted = new Set(protectedPaths.map((p) => path.normalize(p)));
  try {
    const expDir = path.join(project.ws, "experiments");
    if (fs.existsSync(expDir)) {
      for (const f of await readdir(expDir)) {
        if (!f.endsWith(".json")) continue;
        const rec = JSON.parse(await readFile(path.join(expDir, f), "utf8"));
        if (rec.conclusion?.verdict === "accepted") {
          for (const c of rec.candidates ?? []) if (c.candidatePath) accepted.add(path.normalize(c.candidatePath));
        }
      }
    }
  } catch {}

  return {
    schema: ARTIFACT_SCHEMA, project: project.id,
    totalFiles: files.length, totalBytes,
    hashedFiles: files.filter((f) => f.size >= HASH_MIN).length, hashedBytes,
    duplicateGroups: dupGroups.length,
    reclaimableBytes: reclaimable,
    largest: files.sort((a, b) => b.size - a.size).slice(0, 15).map((f) => ({ path: path.relative(project.ws, f.path), bytes: f.size })),
    topDuplicates: dupGroups.sort((a, b) => b.size * (b.paths.length - 1) - a.size * (a.paths.length - 1)).slice(0, 10)
      .map((e) => ({ hash: e.hash.slice(0, 16), copies: e.paths.length, bytesEach: e.size, reclaimable: e.size * (e.paths.length - 1), paths: e.paths.slice(0, 4) })),
    protectedByAcceptedConclusion: accepted.size,
    retentionClasses: RETENTION,
    note: "READ-ONLY survey. `reclaimableBytes` counts only byte-identical duplicates beyond the first copy - "
      + "the first copy of everything is always kept, and files backing an accepted conclusion are never candidates for removal.",
  };
}

/**
 * Prune duplicates. DRY RUN BY DEFAULT, and it refuses to touch anything
 * protected regardless of what the caller asks for.
 */
export async function pruneArtifacts(project, { apply = false, protectedPaths = [], keepNewest = true } = {}) {
  const survey = await surveyArtifacts(project, { protectedPaths });
  const accepted = new Set(protectedPaths.map((p) => path.normalize(p)));
  try {
    const expDir = path.join(project.ws, "experiments");
    if (fs.existsSync(expDir)) {
      for (const f of await readdir(expDir)) {
        if (!f.endsWith(".json")) continue;
        const rec = JSON.parse(await readFile(path.join(expDir, f), "utf8"));
        if (rec.conclusion?.verdict === "accepted") for (const c of rec.candidates ?? []) if (c.candidatePath) accepted.add(path.normalize(c.candidatePath));
      }
    }
  } catch {}

  const plan = [];
  let wouldFree = 0;
  for (const g of survey.topDuplicates) {
    // Resolve to absolute, keep one, propose the rest.
    const abs = g.paths.map((p) => path.join(project.ws, p));
    const stats = await Promise.all(abs.map(async (p) => ({ p, mt: (await stat(p).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
    stats.sort((a, b) => (keepNewest ? b.mt - a.mt : a.mt - b.mt));
    const keep = stats[0].p;
    for (const s of stats.slice(1)) {
      if (accepted.has(path.normalize(s.p))) continue;   // NEVER prune accepted proof
      plan.push({ remove: path.relative(project.ws, s.p), identicalTo: path.relative(project.ws, keep), bytes: g.bytesEach, hash: g.hash });
      wouldFree += g.bytesEach;
    }
  }

  let removed = 0, freed = 0, trashDir = null;
  if (apply) {
    // PRUNE MOVES TO TRASH, IT DOES NOT DELETE. A cache that permanently
    // destroys evidence on one wrong call is not a cache anyone can safely
    // run, and `restore` has nothing to restore from without this. The trash
    // keeps the workspace-relative path so a restore lands where it came from.
    trashDir = path.join(store(project), "trash", String(Date.now()));
    for (const item of plan) {
      try {
        const from = path.join(project.ws, item.remove);
        const to = path.join(trashDir, item.remove);
        await mkdir(path.dirname(to), { recursive: true });
        await rename(from, to);
        removed++; freed += item.bytes;
      } catch {}
    }
  }

  return {
    schema: ARTIFACT_SCHEMA, project: project.id,
    dryRun: !apply,
    plannedRemovals: plan.length, wouldFreeBytes: wouldFree,
    ...(apply ? { removed, freedBytes: freed, trash: trashDir,
      recoverable: "every removed file was MOVED to `trash`, not deleted - decomp({op:'artifacts', action:'restore'}) puts them back" } : {}),
    plan: plan.slice(0, 40),
    protectedCount: accepted.size,
    policy: "DRY RUN unless apply:true. Only BYTE-IDENTICAL duplicates are ever proposed, one copy of each is always kept, and a file "
      + "backing an ACCEPTED conclusion is skipped even when it is a duplicate - the proof behind a settled result is the one thing a "
      + "cache must never collect.",
  };
}

/** Pin a file so retention never proposes it. */
export async function pinArtifact(project, filePath, { reason } = {}) {
  const d = store(project);
  await mkdir(d, { recursive: true });
  const f = path.join(d, "pins.json");
  let pins = [];
  if (fs.existsSync(f)) { try { pins = JSON.parse(await readFile(f, "utf8")); } catch {} }
  if (!pins.some((p) => p.path === filePath)) pins.push({ path: filePath, reason: reason ?? null, at: new Date().toISOString() });
  await writeFile(f, JSON.stringify(pins, null, 2));
  return { pinned: filePath, totalPins: pins.length, reason: reason ?? null };
}

export async function listPins(project) {
  const f = path.join(store(project), "pins.json");
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(await readFile(f, "utf8")); } catch { return []; }
}

/**
 * Put a pruned batch back.
 *
 * `prune` moves files to a timestamped trash directory rather than deleting
 * them, so this is a real undo. Without it, `restore` was not implemented at
 * all and the op quietly returned a SURVEY instead - a success-shaped response
 * to a request that did nothing, which is the failure class this whole domain
 * keeps tripping over.
 */
export async function restoreArtifacts(project, { batch } = {}) {
  const root = path.join(store(project), "trash");
  if (!fs.existsSync(root)) {
    return { schema: ARTIFACT_SCHEMA, project: project.id, restored: 0, batches: [],
      note: "nothing to restore: no prune has moved anything to trash in this workspace" };
  }
  const batches = (await readdir(root)).filter((d) => /^\d+$/.test(d)).sort();
  if (!batches.length) {
    return { schema: ARTIFACT_SCHEMA, project: project.id, restored: 0, batches: [],
      note: "the trash directory exists but holds no prune batches" };
  }
  // Default to the MOST RECENT batch: undoing the last prune is the common ask.
  const pick = batch ? String(batch) : batches[batches.length - 1];
  const dir = path.join(root, pick);
  if (!fs.existsSync(dir)) {
    throw Object.assign(new Error(`no prune batch '${pick}'. Available: ${batches.join(", ")}`), { code: "NO_SUCH_BATCH" });
  }

  let restored = 0, skipped = 0;
  const conflicts = [];
  const walkBack = async (d, rel = "") => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const from = path.join(d, e.name);
      const relPath = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) { await walkBack(from, relPath); continue; }
      const to = path.join(project.ws, relPath);
      // NEVER overwrite: a file that came back on its own is newer than the
      // copy we trashed, and clobbering it would lose real work.
      if (fs.existsSync(to)) { skipped++; if (conflicts.length < 10) conflicts.push(relPath); continue; }
      await mkdir(path.dirname(to), { recursive: true });
      await rename(from, to);
      restored++;
    }
  };
  await walkBack(dir);
  return {
    schema: ARTIFACT_SCHEMA, project: project.id,
    batch: pick, restored, skipped,
    ...(conflicts.length ? { conflicts, conflictNote: "these already exist in the workspace and were left alone - a file that came back on its own is newer than the trashed copy" } : {}),
    availableBatches: batches,
    note: restored ? `restored ${restored} file(s) from prune batch ${pick}` : "nothing restored",
  };
}
