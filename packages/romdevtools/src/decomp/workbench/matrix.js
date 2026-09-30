// matrix.js - run a batch of pipeline variants and cluster them by output
// bytes into lettered attractors (A is closest to matching). Two
// differently-labeled variants in one attractor are reported plainly; every
// variant collapsing into one is an explicit caution, because a silently
// ignored flag looks identical to an exhausted search axis otherwise. stderr
// is never discarded.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { runProgramSync } from "./proc.js";
import { ScoreError, scoreReport, scoreSpecFromDict } from "./score.js";
import { formatG } from "./globalcolor.js";
import { sorted, strRepr, splitlines, strip } from "./py.js";

export const OUTPUT_PLACEHOLDER = "$OUTPUT";
export const SILENT_FALLBACK_RE = /unknown option|ignored|unrecognized/i;
export const ALL_COLLAPSED_CAUTION = "every variant produced identical bytes -- verify the flags are actually "
  + "accepted (this exact failure produced a wrong conclusion in the reference campaign).";

export class Variant { constructor({ label, command }) { Object.assign(this, { label, command }); Object.freeze(this); } }

export class VariantResult {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  asDict() {
    return { label: this.label, command: this.command, returncode: this.returncode, output_exists: this.output_exists,
      duration_seconds: this.duration_seconds, error: this.error, stderr_warning: this.stderr_warning, candidate_sha256: this.candidate_sha256,
      score: this.score !== null ? this.score.asDict() : null, stdout_log: this.stdout_log, stderr_log: this.stderr_log };
  }
}

export class Attractor {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  asDict() { return { attractor: this.letter, candidate_sha256: this.candidate_sha256, diff_words: this.diff_words, relocation_floor: this.relocation_floor, members: [...this.members] }; }
}

export class MatrixReport {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  asDict() {
    return { run_dir: this.run_dir, variants: this.variants.map((v) => v.asDict()), attractors: this.attractors.map((a) => a.asDict()),
      collapsed_attractors: this.collapsed_attractors.map((a) => a.letter), all_collapsed: this.all_collapsed, caution: this.caution,
      silent_fallback_warnings: this.silent_fallback_warnings.map(([label, line]) => ({ label, line })) };
  }
}

/** Load and validate a `matrix` JSON spec file. */
export function loadMatrixSpec(p, { cwd = process.cwd() } = {}) {
  const abs = path.resolve(cwd, String(p));
  let stat = null;
  try { stat = fs.statSync(abs); } catch {}
  if (!stat || !stat.isFile()) throw new ScoreError(`matrix spec does not exist: ${p}`);
  let text;
  try { text = fs.readFileSync(abs, "utf8"); } catch (e) { throw new ScoreError(`matrix spec could not be read: ${p} (${e.message})`); }
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new ScoreError(`matrix spec is not valid JSON: ${p} (${e.message})`); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ScoreError(`matrix spec must be a JSON object: ${p}`);
  const raw = data.variants;
  if (!Array.isArray(raw) || !raw.length) throw new ScoreError(`matrix spec ${p} must have a non-empty 'variants' array`);
  const variants = [], seen = new Set();
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !item.label || !item.command) throw new ScoreError(`variant #${index} in ${p} needs non-empty 'label' and 'command' strings`);
    const label = String(item.label);
    if (seen.has(label)) throw new ScoreError(`duplicate variant label ${strRepr(label)} in ${p}`);
    seen.add(label);
    variants.push(new Variant({ label, command: String(item.command) }));
  });
  const scoreData = data.score;
  if (!scoreData || typeof scoreData !== "object" || Array.isArray(scoreData)) throw new ScoreError(`matrix spec ${p} must have a 'score' object`);
  return [variants, scoreSpecFromDict(scoreData)];
}

const safeLabel = (label) => label.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "variant";

/** Run one variant's command and score whatever object it produced. */
export async function runVariant(variant, { run_dir, spec, timeout, cwd = process.cwd(), env = process.env }) {
  const safe = safeLabel(variant.label);
  const outputPath = path.join(run_dir, "objects", `${safe}.o`);
  const absRun = path.resolve(cwd, run_dir);
  fs.mkdirSync(path.join(absRun, "objects"), { recursive: true });
  fs.mkdirSync(path.join(absRun, "logs"), { recursive: true });
  const stdoutLog = path.join(run_dir, "logs", `${safe}.stdout.log`), stderrLog = path.join(run_dir, "logs", `${safe}.stderr.log`);
  const write = (p, t) => fs.writeFileSync(path.resolve(cwd, p), t, "utf8");
  if (!variant.command.includes(OUTPUT_PLACEHOLDER)) {
    write(stdoutLog, ""); write(stderrLog, "");
    return new VariantResult({ label: variant.label, command: variant.command, returncode: null, stdout: "", stderr: "", output_path: null, output_exists: false,
      duration_seconds: 0.0, error: `variant command does not contain the ${OUTPUT_PLACEHOLDER} placeholder, so no object path was substituted`,
      score: null, candidate_sha256: null, stderr_warning: null, stdout_log: stdoutLog, stderr_log: stderrLog });
  }
  const rendered = variant.command.split(OUTPUT_PLACEHOLDER).join(outputPath);
  const started = performance.now();
  let runError = null, returncode = null, stdout = "", stderr = "";
  const r = runProgramSync(["/bin/sh", "-c", rendered], { cwd, env, timeout: timeout * 1000, killSignal: "SIGKILL" });
  const dec = (b) => (b ? new TextDecoder("utf-8", { fatal: false }).decode(b) : "");
  stdout = dec(r.stdout); stderr = dec(r.stderr);
  if (r.error && r.error.code === "ETIMEDOUT") { runError = `variant command exceeded --timeout (${formatG(timeout)}s)`; stdout = ""; stderr = ""; }
  else returncode = r.status;
  const duration = (performance.now() - started) / 1000;
  write(stdoutLog, stdout); write(stderrLog, stderr);
  let stderrWarning = null;
  for (const line of splitlines(stderr)) if (SILENT_FALLBACK_RE.test(line)) { stderrWarning = strip(line); break; }
  let outputExists = false;
  try { const s = fs.statSync(path.resolve(cwd, outputPath)); outputExists = s.isFile() && s.size > 0; } catch {}
  let failure = runError;
  if (failure === null && returncode) failure = `variant command exited ${returncode}`;
  else if (failure === null && !outputExists) failure = `variant command produced no output object at ${outputPath} (the ${OUTPUT_PLACEHOLDER} path)`;
  let score = null, sha = null;
  if (outputExists && failure === null) {
    try { score = await scoreReport(outputPath, spec, { cwd, env }); sha = score.function.candidate_sha256; }
    catch (e) {
      if (!(e instanceof ScoreError || e?.name === "RuntimeError" || e?.name === "OSError" || e?.name === "FileNotFoundError" || (typeof e?.code === "string" && /^E[A-Z]+$/.test(e.code)))) throw e;
      failure = `scoring failed: ${e.message}`;
    }
  }
  return new VariantResult({ label: variant.label, command: variant.command, returncode, stdout, stderr, output_path: outputExists ? outputPath : null,
    output_exists: outputExists, duration_seconds: duration, error: failure, score, candidate_sha256: sha, stderr_warning: stderrWarning,
    stdout_log: stdoutLog, stderr_log: stderrLog });
}

/** 0, 1, ... 25, 26 as A, B, ... Z, AA. */
export function letter(index) {
  index += 1;
  let out = "";
  while (index) { const rem = (index - 1) % 26; index = Math.floor((index - 1) / 26); out = String.fromCharCode(65 + rem) + out; }
  return out;
}

/** Group variants with byte-identical scored functions into attractors. */
export function clusterAttractors(results) {
  const groups = new Map();
  for (const item of results) {
    if (item.score === null || item.candidate_sha256 === null) continue;
    if (!groups.has(item.candidate_sha256)) groups.set(item.candidate_sha256, []);
    groups.get(item.candidate_sha256).push(item);
  }
  const ordered = sorted([...groups], ([digest, members]) => [members[0].score ? members[0].score.function.diff_words : 0, digest]);
  return ordered.map(([digest, members], i) => new Attractor({ letter: letter(i), candidate_sha256: digest, diff_words: members[0].score.function.diff_words,
    relocation_floor: members[0].score.function.relocation_floor, members: members.map((m) => m.label) }));
}

export function defaultRunDir() {
  const d = new Date(), z = (n) => String(n).padStart(2, "0");
  return path.join(".decomp-workbench", "matrix", `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`);
}

/** Run every variant in a matrix spec and cluster the results. */
export async function runMatrix(specPath, { run_dir = null, timeout = 120.0, cwd = process.cwd(), env = process.env } = {}) {
  const [variants, spec] = loadMatrixSpec(specPath, { cwd });
  const dir = run_dir !== null ? run_dir : defaultRunDir();
  fs.mkdirSync(path.resolve(cwd, dir), { recursive: true });
  const results = [];
  for (const v of variants) results.push(await runVariant(v, { run_dir: dir, spec, timeout, cwd, env }));
  const attractors = clusterAttractors(results);
  const collapsed = attractors.filter((a) => a.members.length >= 2);
  const successful = results.filter((r) => r.score !== null);
  const allCollapsed = attractors.length === 1 && successful.length >= 2;
  return new MatrixReport({ run_dir: dir, variants: results, attractors, collapsed_attractors: collapsed, all_collapsed: allCollapsed,
    caution: allCollapsed ? ALL_COLLAPSED_CAUTION : null, silent_fallback_warnings: results.filter((r) => r.stderr_warning !== null).map((r) => [r.label, r.stderr_warning]) });
}
