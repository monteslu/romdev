// campaign-survey.js - reading a campaign directory that never had a
// manifest. No registry: a survey is a reading of the directory as it is now
// (paths, counts, content hashes taken at read time), reads only documents
// the workbench already defines, counts everything else, and never guesses
// which artifact is the base.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { ValueError, sorted, maxBy } from "./py.js";
import { fileSha256 } from "./campaign.js";

export const SURVEY_SCHEMA = "decomp-workbench-campaign-survey-v1";
export const DEFAULT_BUDGET = 40000;
const SOURCE_SUFFIXES = new Set([".c", ".h", ".i", ".s"]);
const OBJECT_SUFFIXES = new Set([".o", ".obj", ".elf"]);
const DUMP_SUFFIXES = new Set([".objdump", ".dis", ".dis2", ".dump", ".txt"]);
const NOTE_SUFFIXES = new Set([".md"]);
const SKIP = new Set([".git", "__pycache__", ".mypy_cache", ".ruff_cache", ".venv"]);

export class CampaignSurveyError extends ValueError { constructor(m) { super(m); this.kind = "CampaignSurveyError"; } }

function stamp(seconds) {
  const d = new Date(seconds * 1000);
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())}T${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}Z`;
}
const mtime = (p) => { try { const s = fs.statSync(p, { bigint: true }); return Number(s.mtimeNs / 1000000000n) + Number(s.mtimeNs % 1000000000n) * 1e-9; } catch { return 0.0; } };
const suffixOf = (p) => { const b = path.basename(p); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i) : ""; };

class Stage {
  constructor(name) { Object.assign(this, { name, files: 0, sources: 0, objects: 0, dumps: 0, notes: [], modified: 0.0, newest_source: null, newest_object: null }); }
  asDict() {
    return { name: this.name, files: this.files, sources: this.sources, objects: this.objects, dumps: this.dumps, notes: sorted(this.notes),
      modified: this.modified ? stamp(this.modified) : null, newest_source: this.newest_source, newest_object: this.newest_object };
  }
}

function* iterate(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current).map((n) => path.join(current, n)); } catch { continue; }
    for (const entry of entries) {
      if (SKIP.has(path.basename(entry))) continue;
      let lst, st;
      try { lst = fs.lstatSync(entry); } catch { continue; }
      try { st = fs.statSync(entry); } catch { st = null; }
      if (st && st.isDirectory() && !lst.isSymbolicLink()) { stack.push(entry); continue; }
      if (st && st.isFile()) yield entry;
    }
  }
}

function walk(root, budget) {
  const stages = new Map();
  const top = new Stage(".");
  let seen = 0, capped = false;
  for (const p of iterate(root)) {
    seen += 1;
    if (seen > budget) { capped = true; break; }
    const parts = path.relative(root, p).split(path.sep);
    const key = parts.length > 1 ? parts[0] : ".";
    let stage = top;
    if (key !== ".") { if (!stages.has(key)) stages.set(key, new Stage(key)); stage = stages.get(key); }
    let modified;
    try { fs.statSync(p); modified = mtime(p); } catch { continue; }
    stage.files += 1;
    stage.modified = Math.max(stage.modified, modified);
    const suffix = suffixOf(p).toLowerCase();
    if (SOURCE_SUFFIXES.has(suffix)) { stage.sources += 1; if (stage.newest_source === null || modified >= mtime(stage.newest_source)) stage.newest_source = p; }
    else if (OBJECT_SUFFIXES.has(suffix)) { stage.objects += 1; if (stage.newest_object === null || modified >= mtime(stage.newest_object)) stage.newest_object = p; }
    else if (DUMP_SUFFIXES.has(suffix)) stage.dumps += 1;
    else if (NOTE_SUFFIXES.has(suffix)) stage.notes.push(path.basename(p));
  }
  return [sorted([...stages.values()], (s) => -s.modified), top, seen, capped];
}

function rglob(root, test) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let names;
    try { names = fs.readdirSync(cur); } catch { continue; }
    for (const n of names) {
      const p = path.join(cur, n);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (test(n, st)) out.push(p);
      if (st.isDirectory()) stack.push(p);
    }
  }
  return sorted(out);
}

async function findingsLogs(root, budget) {
  let notes;
  try { notes = await import("./notes.js"); } catch { return []; }
  const { NOTES_SUFFIX, mergedView } = notes;
  const found = [];
  for (const sidecar of rglob(root, (n) => n.endsWith(NOTES_SUFFIX)).slice(0, budget)) {
    let st; try { st = fs.statSync(sidecar); } catch { continue; }
    if (!st.isDirectory()) continue;
    const log = path.join(path.dirname(sidecar), path.basename(sidecar).slice(0, -NOTES_SUFFIX.length));
    let view;
    try { view = await mergedView(log); } catch (e) { if (e?.kind === "NoteError" || e?.name === "NoteError") continue; throw e; }
    found.push({ log, entries: view.entries.length, pending: view.pending.length, merged: view.merged.length, duplicate_ids: [...view.duplicate_ids] });
  }
  return found;
}

function documents(root, schema, fields) {
  const found = [];
  for (const p of rglob(root, (n, st) => n.endsWith(".json") && st.isFile())) {
    let payload;
    try { if (fs.statSync(p).size > (4 << 20)) continue; payload = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.schema !== schema) continue;
    const reduced = { path: p };
    for (const name of fields) reduced[name] = payload[name] ?? null;
    found.push(reduced);
  }
  return found;
}

/** Read one campaign directory and return what is there, not what it means. */
export async function surveyCampaign(root, { budget = DEFAULT_BUDGET, base = null } = {}) {
  let SWEEP_SCHEMA = "decomp-workbench-sweep-v1";
  try { SWEEP_SCHEMA = (await import("./sweep.js")).SWEEP_SCHEMA ?? SWEEP_SCHEMA; } catch { /* the schema name is stable */ }
  const location = String(root);
  let isDir = false; try { isDir = fs.statSync(location).isDirectory(); } catch { /* absent */ }
  if (!isDir) {
    throw new CampaignSurveyError(`${location} is not a directory. \`campaign survey\` reads a campaign working directory -- the one holding the stage directories. For a manifest \`campaign run\` wrote, use \`campaign status\`.`);
  }
  const [stages, top, seen, capped] = walk(location, budget);
  const sweeps = documents(location, SWEEP_SCHEMA, ["generator", "base", "variant_count", "coverage"]);
  const gates = documents(location, "decomp-workbench-instrument-gate-v1", ["profile", "pass", "recorded"]);
  const manifests = rglob(location, (n, st) => n === "manifest.json").filter((p) => p.split(path.sep).includes("campaigns"));
  let pinned = null;
  if (base !== null && base !== undefined) {
    const pinnedPath = String(base);
    let ok = false; try { ok = fs.statSync(pinnedPath).isFile(); } catch { /* absent */ }
    if (!ok) throw new CampaignSurveyError(`--base does not exist: ${pinnedPath}`);
    pinned = { path: pinnedPath, sha256: fileSha256(pinnedPath), modified: stamp(mtime(pinnedPath)) };
  }
  const all = [...stages, top];
  const srcs = all.map((s) => s.newest_source).filter(Boolean);
  const objs = all.map((s) => s.newest_object).filter(Boolean);
  const newestSource = srcs.length ? maxBy(srcs, mtime) : null;
  const newestObject = objs.length ? maxBy(objs, mtime) : null;
  return {
    schema: SURVEY_SCHEMA, root: location, stages: stages.map((s) => s.asDict()), top_level: top.asDict(), stage_count: stages.length,
    files_seen: seen, budget, truncated: capped, findings_logs: await findingsLogs(location, budget), sweeps, instrument_gates: gates,
    workbench_manifests: manifests, newest_source: newestSource, newest_object: newestObject, base: pinned,
    reading: "A survey is a reading of this directory as it is now: paths, counts, and hashes taken at read time. Nothing is stored, so nothing here can be a stale claim -- and nothing here guesses which artifact is the base.",
  };
}

const lj = (v, n) => String(v).padEnd(n);

/** Render the survey: the stages by recency, then what the directory knows. */
export function surveyLines(report, { limit = 20 } = {}) {
  const lines = [`campaign survey: ${report.root}`, `${report.stage_count} stage director(ies), ${report.files_seen} file(s) read`];
  if (report.truncated) lines.push(`TRUNCATED: the walk stopped at ${report.budget} files. Counts below are a lower bound; raise --budget to read the rest.`);
  if (report.base) lines.push("", `base (pinned by --base): ${report.base.path}`, `  sha256 ${report.base.sha256}  modified ${report.base.modified}`);
  lines.push("", " modified              stage           files  src   obj   notes");
  for (const stage of report.stages.slice(0, limit)) {
    const notes = stage.notes.slice(0, 2).join(",") || "-";
    lines.push(` ${lj(stage.modified || "-", 21)} ${lj(stage.name.slice(0, 15), 15)} ${lj(stage.files, 6)} ${lj(stage.sources, 5)} ${lj(stage.objects, 5)} ${notes}`);
  }
  if (report.stage_count > limit) lines.push(` ... ${report.stage_count - limit} older stage(s)`);
  for (const log of report.findings_logs) {
    lines.push("", `findings log: ${log.log}`, `  ${log.entries} entr(ies) in the log, ${log.pending} pending in the sidecar, ${log.merged} merged`);
    if (log.duplicate_ids.length) lines.push(`  warning: ${log.duplicate_ids.join(", ")} are pending and already in the log`);
  }
  if (report.sweeps.length) {
    lines.push("", `sweeps (${report.sweeps.length}):`);
    for (const item of report.sweeps.slice(0, limit)) {
      const coverage = item.coverage || {};
      lines.push(`  ${lj(item.generator === null ? "None" : item.generator, 10)} ${item.variant_count === null ? "None" : item.variant_count} variant(s)  ${coverage.vocabulary ?? "?"}  ${item.path}`);
    }
  }
  if (report.instrument_gates.length) {
    lines.push("", `instrument gates (${report.instrument_gates.length}):`);
    for (const item of report.instrument_gates.slice(0, limit)) {
      lines.push(`  ${item.pass ? "PASS" : "FAIL"}  ${lj(item.profile === null ? "None" : item.profile, 14)} ${item.recorded === null ? "None" : item.recorded}  ${item.path}`);
    }
  } else {
    lines.push("", "instrument gates: none recorded. If any trace in this directory came from an instrumented toolchain, its identity gate is not on file -- `decomp-workbench instrument gate`.");
  }
  if (report.workbench_manifests.length) {
    lines.push("", "campaign manifests (read these with `campaign status`):");
    for (const item of report.workbench_manifests.slice(0, limit)) lines.push(`  ${item}`);
  }
  lines.push("", `reading: ${report.reading}`);
  const ns = report.newest_source, no = report.newest_object;
  if (ns || no) {
    lines.push("", "the newest artifacts found, which may or may not be the base:");
    if (ns) lines.push(`  source  ${ns}`);
    if (no) { lines.push(`  object  ${no}`); lines.push(`  next: decomp-workbench score ${no} --target-object TARGET --symbol NAME`); }
  }
  return lines;
}
