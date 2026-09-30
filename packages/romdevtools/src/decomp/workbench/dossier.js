// dossier.js - append-only, machine-queryable records of tested and
// falsified hypotheses. Each entry's id is the hash of its canonical body,
// so a record cannot be edited without the file saying so.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ValueError, splitlines } from "./py.js";
import { exclusiveFileLock } from "./evidence.js";
import { canonicalJson } from "./campaign.js";
import { loadsJson } from "./json-error.js";

export const DOSSIER_ENTRY_SCHEMA = "decomp-workbench-dossier-entry-v1";
export const DOSSIER_REPORT_SCHEMA = "decomp-workbench-dossier-v1";
export const RESULTS = Object.freeze(new Set(["falsified", "supported", "inconclusive"]));

function line(value, { field, limit }) {
  const normalized = splitlines(value.replace(/\x00/g, "")).join(" ").trim();
  if (!normalized || normalized.length > limit) throw new ValueError(`${field} must be one non-empty line up to ${limit} characters`);
  return normalized;
}

const idOf = (body) => createHash("sha256").update(Buffer.from(canonicalJson(body), "utf8")).digest("hex").slice(0, 24);

function validatedBody(value, { where }) {
  const result = value.result;
  if (!RESULTS.has(result)) throw new ValueError(`${where}.result must be falsified, supported, or inconclusive`);
  const doNotRepeat = value.do_not_repeat;
  if (typeof doNotRepeat !== "boolean") throw new ValueError(`${where}.do_not_repeat must be a boolean`);
  const evidence = value.evidence;
  if (!Array.isArray(evidence)) throw new ValueError(`${where}.evidence must be a list of strings`);
  if (evidence.some((i) => typeof i !== "string")) throw new ValueError(`${where}.evidence must contain only strings`);
  const normalized = {};
  for (const [field, limit] of [["function", 160], ["hypothesis", 500], ["lever", 240], ["outcome", 500]]) {
    const raw = value[field];
    if (typeof raw !== "string") throw new ValueError(`${where}.${field} must be a string`);
    const clean = line(raw, { field: `${where}.${field}`, limit });
    if (clean !== raw) throw new ValueError(`${where}.${field} is not canonically normalized`);
    normalized[field] = clean;
  }
  const cleanEvidence = evidence.map((item, index) => line(item, { field: `${where}.evidence[${index}]`, limit: 500 }));
  if (cleanEvidence.some((v, i) => v !== evidence[i])) throw new ValueError(`${where}.evidence is not canonically normalized`);
  return { function: normalized.function, hypothesis: normalized.hypothesis, lever: normalized.lever, result, outcome: normalized.outcome,
    do_not_repeat: doNotRepeat, evidence: cleanEvidence };
}

/** Append one canonical record with an ID independent of wall-clock time. */
export function appendEntry(p, { function: fn, hypothesis, lever, result, outcome, do_not_repeat, evidence = [] }) {
  const body = validatedBody({ function: fn, hypothesis, lever, result, outcome, do_not_repeat, evidence: [...evidence] }, { where: "entry" });
  const identifier = idOf(body);
  const entry = { schema: DOSSIER_ENTRY_SCHEMA, id: identifier, recorded_at_unix: Date.now() / 1000, ...body };
  const destination = String(p);
  fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
  const lock = path.join(path.dirname(destination), `.${path.basename(destination)}.lock`);
  exclusiveFileLock(lock, () => {
    const [existing] = readDossier(destination);
    if (existing.some((i) => i.id === identifier)) throw new ValueError(`dossier already contains entry ${identifier}`);
    const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o644);
    try { fs.writeSync(fd, canonicalJson(entry) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  });
  return entry;
}

/** Read an append-only dossier, tolerating only a torn final line. */
export function readDossier(p) {
  const location = String(p);
  if (!fs.existsSync(location)) return [[], []];
  const contents = fs.readFileSync(location, "utf8");
  const lines = splitlines(contents);
  const finalTorn = lines.length > 0 && !(contents.endsWith("\n") || contents.endsWith("\r"));
  const entries = [], warnings = [], seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const index = i + 1, text = lines[i];
    if (!text.trim()) continue;
    let value;
    try { value = loadsJson(text); } catch (e) {
      if (e.name !== "JSONDecodeError") throw e;
      if (index === lines.length && finalTorn) { warnings.push(`ignored torn final dossier line ${index}`); break; }
      throw new ValueError(`malformed dossier line ${index}: ${e.message}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== DOSSIER_ENTRY_SCHEMA) throw new ValueError(`dossier line ${index} is not a ${DOSSIER_ENTRY_SCHEMA} record`);
    const id = value.id;
    if (typeof id !== "string" || id.length !== 24 || /[^0-9a-f]/.test(id) || seen.has(id)) throw new ValueError(`dossier line ${index} has a missing or duplicate id`);
    const at = value.recorded_at_unix;
    if (typeof at !== "number" || at < 0) throw new ValueError(`dossier line ${index} has an invalid recorded_at_unix`);
    const body = validatedBody(value, { where: `dossier line ${index}` });
    if (id !== idOf(body)) throw new ValueError(`dossier line ${index} content does not match id ${id}`);
    seen.add(id);
    entries.push({ ...value });
  }
  return [entries, warnings];
}

export function dossierReport(p, { function: fn = null, result = null } = {}) {
  const [entries, warnings] = readDossier(p);
  const selected = entries.filter((i) => (fn === null || i.function === fn) && (result === null || i.result === result));
  return { schema: DOSSIER_REPORT_SCHEMA, path: path.normalize(String(p)).replace(/\/$/, "") || ".", entries: selected, entry_count: selected.length,
    do_not_repeat: selected.filter((i) => i.do_not_repeat).length, warnings };
}
