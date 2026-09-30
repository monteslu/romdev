// toolchain.js - real-copy external toolchain directories with explicit
// calibration state. A toolchain is a dereferenced copy of a base compiler
// directory plus hash-recorded replacement binaries; it claims "ready" only
// when every calibration gate has passed, and its integrity is re-verified
// from the recorded inventory every time it is used.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ValueError, strRepr, sorted } from "./py.js";
import { FileNotFoundError, OSError } from "./py-extra.js";
import { fileSha256 } from "./campaign.js";
import { parseSchedulerTrace } from "./scheduler.js";
import { readTraceText } from "./trace-source.js";
import { dumps as pyDumps } from "./pyjson.js";

export const TOOLCHAIN_SCHEMA = "decomp-workbench-toolchain-v1";
export const MANIFEST_NAME = "workbench-toolchain.json";
export const CALIBRATION_GATES = ["real_copy", "fidelity", "positive_control", "unedited_replay", "collateral", "project_output"];

const expand = (p) => (p === "~" || String(p).startsWith("~/") ? (process.env.HOME ?? "") + String(p).slice(1) : String(p));
const resolve = (p) => { const a = path.resolve(expand(p)); try { return fs.realpathSync(a); } catch { return a; } };
const notADirectory = (m) => Object.assign(new OSError(m), { kind: "NotADirectoryError" });
const fileExists = (m) => Object.assign(new OSError(m), { kind: "FileExistsError" });

/** A JSON string with every non-ASCII code unit escaped. */
function asciiJson(s) {
  // ensure_ascii: every code unit above 0x7F becomes a \\uXXXX escape.
  let out = "";
  for (const ch of JSON.stringify(s)) {
    const c = ch.charCodeAt(0);
    out += c > 0x7f ? [...ch].map((u) => { let r = ""; for (let k = 0; k < u.length; k++) r += "\\u" + u.charCodeAt(k).toString(16).padStart(4, "0"); return r; }).join("") : ch;
  }
  return out;
}

/** json.dumps(value, sort_keys=True, separators=(",", ":")). */
function compactSorted(value) {
  if (Array.isArray(value)) return `[${value.map(compactSorted).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${asciiJson(k)}:${compactSorted(value[k])}`).join(",")}}`;
  return typeof value === "string" ? asciiJson(value) : JSON.stringify(value);
}

function walk(root) {
  const out = [];
  const visit = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      out.push(full);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) visit(full);
    }
  };
  visit(root);
  return out;
}

function treeInventory(root) {
  const entries = [];
  for (const p of sorted(walk(root), (x) => path.relative(root, x).split(path.sep))) {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) throw new ValueError(`toolchain contains a symlink after copy: ${p}`);
    if (st.isDirectory()) continue;
    if (!st.isFile()) throw new ValueError(`toolchain contains unsupported filesystem node: ${p}`);
    entries.push({ path: path.relative(root, p).split(path.sep).join("/"), bytes: st.size, sha256: fileSha256(p) });
  }
  return [entries, createHash("sha256").update(compactSorted(entries), "utf8").digest("hex")];
}

/** Copy a tree with every link dereferenced (ordinary files only), keeping modes and times. */
function copyDereferenced(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name), to = path.join(dst, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyDereferenced(from, to);
    else {
      fs.copyFileSync(from, to);
      fs.chmodSync(to, st.mode & 0o7777);
      fs.utimesSync(to, st.atime, st.mtime);
    }
  }
}

function parseReplacements(values) {
  const result = {};
  for (const [relative, sourceValue] of Object.entries(values)) {
    const parts = relative.split("/").filter((x) => x && x !== ".");
    if (path.isAbsolute(relative) || parts.includes("..") || !parts.length) {
      throw new ValueError(`replacement destination must be a relative file path: ${strRepr(relative)}`);
    }
    const source = resolve(sourceValue);
    let st = null;
    try { st = fs.statSync(source); } catch { st = null; }
    if (!st?.isFile()) throw new FileNotFoundError(`replacement binary does not exist: ${source}`);
    result[parts.join("/")] = source;
  }
  return result;
}

function writeManifest(p, manifest) {
  const temporary = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, pyDumps(manifest) + "\n", "utf8");
  fs.renameSync(temporary, p);
}


function schedulerPositiveControl(p) {
  const source = resolve(p);
  const [events] = parseSchedulerTrace(readTraceText(source));
  const ties = events.filter((e) => e.ready > 1).length;
  return { path: source, sha256: fileSha256(source), events: events.length, ready_set_ties: ties, pass: events.length > 0 && ties > 0 };
}

function exactFilePair(expected, actual) {
  const e = resolve(expected), a = resolve(actual);
  const isFile = (x) => { try { return fs.statSync(x).isFile(); } catch { return false; } };
  if (!isFile(e)) throw new FileNotFoundError(`expected project output does not exist: ${e}`);
  if (!isFile(a)) throw new FileNotFoundError(`actual project output does not exist: ${a}`);
  const eh = fileSha256(e), ah = fileSha256(a);
  return { expected: e, actual: a, expected_sha256: eh, actual_sha256: ah, pass: eh === ah };
}

async function fidelity(stock, candidate, objdump) {
  const { compareObjectFidelity } = await import("./fidelity.js");
  return await compareObjectFidelity(stock, candidate, { objdump });
}

/** Replaceable filesystem steps (tests simulate a lost destination race). */
export const seams = {
  mkdir(p) {
    try { fs.mkdirSync(p); } catch (e) { if (e.code === "EEXIST") throw fileExists(`[Errno 17] File exists: '${p}'`); throw e; }
  },
};

/** Materialize a real-copy toolchain and record every externally owned hash. */
export async function initializeToolchain(destination, { base, replacements, fidelity_pairs = null, scheduler_positive_log = null, objdump = null }) {
  const basePath = resolve(base);
  const output = resolve(destination);
  let st = null;
  try { st = fs.statSync(basePath); } catch { st = null; }
  if (!st?.isDirectory()) throw notADirectory(`base toolchain is not a directory: ${basePath}`);
  if (fs.existsSync(output)) throw fileExists(`refusing to overwrite toolchain: ${output}`);
  if (basePath === output || output.startsWith(basePath + path.sep)) throw new ValueError("destination must not be inside the base toolchain");
  const replacementPaths = parseReplacements(replacements);
  let ownsOutput = false;
  let manifest;
  try {
    // Reserve the exact destination before copying, so failure cleanup can
    // only remove a directory created here.
    fs.mkdirSync(path.dirname(output), { recursive: true });
    seams.mkdir(output);
    ownsOutput = true;
    // Dereference links: the toolchain must contain ordinary files.
    copyDereferenced(basePath, output);
    const [, baseDigest] = treeInventory(output);
    const installed = {};
    for (const [relative, source] of Object.entries(replacementPaths)) {
      const target = path.resolve(output, relative);
      if (!target.startsWith(output + path.sep)) throw new ValueError(`replacement destination escapes toolchain: ${relative}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      const s = fs.statSync(source);
      fs.chmodSync(target, s.mode);
      fs.utimesSync(target, s.atime, s.mtime);
      installed[relative] = { source, source_sha256: fileSha256(source), installed_sha256: fileSha256(target) };
    }
    const reports = [];
    for (const [stock, instrumented] of fidelity_pairs ?? []) reports.push(await fidelity(stock, instrumented, objdump));
    const positive = scheduler_positive_log ? schedulerPositiveControl(scheduler_positive_log) : null;
    const [entries, installedDigest] = treeInventory(output);
    const gates = {
      real_copy: true,
      fidelity: reports.length > 0 && reports.every((r) => r.pass),
      positive_control: !!(positive && positive.pass),
      unedited_replay: false, collateral: false, project_output: false,
    };
    manifest = {
      schema: TOOLCHAIN_SCHEMA, created_at_unix: Date.now() / 1000, base: basePath,
      base_inventory_sha256: baseDigest, installed_inventory_sha256: installedDigest, files: entries.length,
      replacements: installed, fidelity_reports: reports, scheduler_positive_control: positive, gates,
      claim: Object.values(gates).every(Boolean) ? "ready" : "uncalibrated",
    };
    writeManifest(path.join(output, MANIFEST_NAME), manifest);
  } catch (e) {
    if (ownsOutput) fs.rmSync(output, { recursive: true, force: true });
    throw e;
  }
  return { ...manifest, directory: output };
}

/** Run explicit calibration cells and atomically update their evidence. */
export async function calibrateToolchain(p, { unedited_replay_pairs = [], collateral_pairs = [], project_output_pairs = [], scheduler_positive_log = null, objdump = null } = {}) {
  const root = resolve(p);
  const status = toolchainStatus(root);
  if (!status.integrity) throw new ValueError("toolchain integrity failed; restore or reinitialize it");
  const manifestPath = path.join(root, MANIFEST_NAME);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const evidence = { ...(manifest.calibration_evidence ?? {}) };
  const fidelityReports = async (pairs) => { const out = []; for (const [s, c] of pairs) out.push(await fidelity(s, c, objdump)); return out; };
  if (unedited_replay_pairs.length) {
    const reports = await fidelityReports(unedited_replay_pairs);
    evidence.unedited_replay = reports;
    manifest.gates.unedited_replay = reports.every((r) => !!r.pass);
  }
  if (collateral_pairs.length) {
    const reports = await fidelityReports(collateral_pairs);
    evidence.collateral = reports;
    manifest.gates.collateral = reports.every((r) => !!r.pass);
  }
  if (project_output_pairs.length) {
    const reports = project_output_pairs.map(([e, a]) => exactFilePair(e, a));
    evidence.project_output = reports;
    manifest.gates.project_output = reports.every((r) => !!r.pass);
  }
  if (scheduler_positive_log !== null && scheduler_positive_log !== undefined) {
    const report = schedulerPositiveControl(scheduler_positive_log);
    manifest.scheduler_positive_control = report;
    evidence.positive_control = report;
    manifest.gates.positive_control = !!report.pass;
  }
  if (!unedited_replay_pairs.length && !collateral_pairs.length && !project_output_pairs.length && !scheduler_positive_log) {
    throw new ValueError("calibration requires at least one evidence input");
  }
  manifest.calibration_evidence = evidence;
  manifest.updated_at_unix = Date.now() / 1000;
  manifest.claim = CALIBRATION_GATES.every((g) => manifest.gates[g] ?? false) ? "ready" : "uncalibrated";
  writeManifest(manifestPath, manifest);
  return toolchainStatus(root);
}

/** Verify the installed copy and print no claim stronger than its gates. */
export function toolchainStatus(p) {
  const root = resolve(p);
  const manifestPath = path.join(root, MANIFEST_NAME);
  let st = null;
  try { st = fs.statSync(manifestPath); } catch { st = null; }
  if (!st?.isFile()) throw new FileNotFoundError(`toolchain manifest does not exist: ${manifestPath}`);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { manifest = null; }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.schema !== TOOLCHAIN_SCHEMA) {
    throw new ValueError(`invalid toolchain manifest: ${manifestPath}`);
  }
  const [entries] = treeInventory(root);
  const withoutManifest = entries.filter((i) => i.path !== MANIFEST_NAME);
  const currentDigest = createHash("sha256").update(compactSorted(withoutManifest), "utf8").digest("hex");
  const replacements = {};
  for (const [relative, expected] of Object.entries(manifest.replacements ?? {})) {
    const installed = path.join(root, relative);
    let isFile = false;
    try { isFile = fs.statSync(installed).isFile(); } catch { isFile = false; }
    const actual = isFile ? fileSha256(installed) : null;
    replacements[relative] = { expected_sha256: expected.installed_sha256, actual_sha256: actual, pass: actual === expected.installed_sha256 };
  }
  const integrity = currentDigest === manifest.installed_inventory_sha256 && Object.values(replacements).every((i) => i.pass);
  const gates = { ...manifest.gates };
  gates.real_copy = integrity;
  return {
    schema: TOOLCHAIN_SCHEMA, directory: root, manifest_sha256: fileSha256(manifestPath), integrity, gates,
    claim: Object.values(gates).every(Boolean) ? "ready" : "uncalibrated", replacements,
    next_missing_gates: Object.entries(gates).filter(([, v]) => !v).map(([k]) => k),
  };
}

/** The path-sensitive driver environment for one verified copy. */
export function toolchainEnvironment(p, { require_ready = false } = {}) {
  const report = toolchainStatus(p);
  if (!report.integrity) throw new ValueError("toolchain integrity failed");
  if (require_ready && report.claim !== "ready") throw new ValueError(`toolchain is not calibrated; missing gates: ${report.next_missing_gates.join(", ")}`);
  return { USR_LIB: report.directory };
}
