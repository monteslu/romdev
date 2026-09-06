// jobs.js — bounded candidate search as a cancellable, resumable background
// job around decomp-permuter. The permuter owns the mutation + scoring loop
// (it is the community's tool for exactly this); romdev owns the budget, the
// persistence, the process lifetime and the honest status.
//
// A job never touches the project's sources: import.py copies the TU + the
// target asm into its own directory under the workspace, and the compile
// script it writes runs the project's compiler with the candidate as input.
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { run } from "./mips-obj.js";
import { toolPaths, backendStatus } from "./m2c.js";
import { sha256Text } from "./project.js";

const jobsDir = (project) => path.join(project.ws, "jobs");
let counter = 0;

/**
 * Build a decomp-permuter directory WITHOUT touching the project tree:
 *   base.c       the real TU with the candidate spliced in, preprocessed with the
 *                build's own includes/defines (pragmas stripped; the permuter
 *                replaces every other function with a declaration itself)
 *   target.o     the extracted asm assembled by romdev (same prelude the
 *                permuter's import.py uses)
 *   compile.sh   the project's compiler with the TU's exact flags (asm-processor
 *                stripped away: base.c has no GLOBAL_ASM left to process)
 *   settings.toml func_name + compiler_type + objdump
 */
async function preparePermuterDir(project, fn, baseCandidateText, jobDir) {
  const t = toolPaths();
  if (!fs.existsSync(path.join(t.permuter, "permuter.py"))) throw Object.assign(new Error(`decomp-permuter not installed at ${t.permuter}. ${(await backendStatus()).permuter.setup}`), { code: "MISSING_BACKEND" });
  const { spliceFunction, ensureTarget } = await import("./compile.js");
  const tuRel = fn.source?.tu;
  if (!tuRel) throw Object.assign(new Error(`function '${fn.symbol}' is in no TU`), { code: "FUNCTION_NOT_IN_TU" });
  const target = await ensureTarget(project, fn);
  if (target.romOnly) throw Object.assign(new Error(`function '${fn.symbol}' has no extracted asm; the permuter needs a target .s`), { code: "NO_TARGET_ASM" });
  const inv = await project.compileInvocation(tuRel);
  // Preprocess the spliced TU with the build's include paths + defines.
  const tuText = await readFile(project.abs(tuRel), "utf8");
  const spliced = spliceFunction(tuText, fn.symbol, baseCandidateText).text.replace(/^[ \t]*#pragma\s+GLOBAL_ASM\([^)]*\)[ \t]*$/gm, "");
  const permDir = path.join(jobDir, "permuter");
  await mkdir(permDir, { recursive: true });
  const inPath = path.join(permDir, "base.in.c");
  await writeFile(inPath, spliced);
  const inc = inv.compile.reduce((acc, a, i, arr) => { if (arr[i - 1] === "-I") acc.push("-I", a); return acc; }, []);
  const defs = inv.compile.filter((a) => /^-D/.test(a));
  const pp = await run("gcc", ["-E", "-P", "-nostdinc", "-fno-builtin", "-std=gnu89", "-x", "c", ...inc, "-I", path.dirname(project.abs(tuRel)), ...defs, "-D_LANGUAGE_C", "-DPERMUTER", "-D__attribute__(x)=", "-U__GNUC__", inPath], { cwd: project.root, env: project.env, timeoutMs: 60_000 });
  if (pp.code !== 0) throw Object.assign(new Error(`preprocessing the TU for the permuter failed: ${pp.stderr.slice(0, 800)}`), { code: "SEARCH_IMPORT_FAILED" });
  await writeFile(path.join(permDir, "base.c"), pp.stdout);
  try { fs.unlinkSync(inPath); } catch {}
  await copyFileSafe(target.targetO, path.join(permDir, "target.o"));
  // compile.sh: the IDO invocation from the captured argv (drop the asm-processor wrapper + assembler section).
  const argv = inv.compile;
  let cc = argv;
  const bp = argv.findIndex((a) => /asm-processor\/build\.py$/.test(a));
  if (bp >= 0) {
    const firstSep = argv.indexOf("--");
    const secondSep = argv.indexOf("--", firstSep + 1);
    const compiler = argv[firstSep - 1];
    cc = [compiler, ...argv.slice(secondSep + 1)];
  }
  const objRel = inv.object;
  const ccOut = cc.map((a) => (a === tuRel ? '"$INPUT"' : a === objRel ? '"$OUTPUT"' : shq(a)));
  const envLines = Object.entries(project.env).map(([k, v]) => `export ${k}=${shq(v)}`).join("\n");
  const sh = `#!/usr/bin/env bash\nset -euo pipefail\nINPUT="$(realpath "$1")"\nOUTPUT="$(realpath "$3")"\n${envLines}\ncd ${shq(project.root)}\n${ccOut.join(" ")}\n`;
  await writeFile(path.join(permDir, "compile.sh"), sh, { mode: 0o755 });
  const objdump = project.m.toolchain.objdump?.path ?? "mips-linux-gnu-objdump";
  await writeFile(path.join(permDir, "settings.toml"), `func_name = "${fn.symbol}"\ncompiler_type = "ido"\nobjdump_command = "${objdump} --disassemble --reloc --disassemble-zeroes -Mreg-names=32 -Mno-aliases"\n`);
  await writeFile(path.join(jobDir, "import.log"), `base.c: preprocessed ${tuRel} with the candidate spliced at ${fn.symbol}\ncompile.sh: ${ccOut.join(" ")}\ntarget.o: ${target.targetO}\n`);
  return { permDir, importLog: path.join(jobDir, "import.log"), compile: ccOut.join(" ") };
}

function shq(s) { return /^[A-Za-z0-9_\/.=:+-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "'\\''") + "'"; }
async function copyFileSafe(src, dst) { const { copyFile } = await import("node:fs/promises"); await copyFile(src, dst); }

/**
 * Start a search job.
 * @param {{project, fn, baseCandidateText, timeLimitS?:number, threads?:number, seed?:string, stopOnZero?:boolean, label?:string, resumeFrom?:string}} a
 */
export async function startSearch({ project, fn, baseCandidateText, timeLimitS = 300, threads = 2, seed, stopOnZero = true, label, resumeFrom }) {
  const t = toolPaths();
  const jobId = `search-${fn.symbol}-${Date.now().toString(36)}${(counter++).toString(36)}`;
  const jobDir = path.join(jobsDir(project), jobId);
  await mkdir(jobDir, { recursive: true });
  const prep = await preparePermuterDir(project, fn, baseCandidateText, jobDir);
  const args = [path.join(t.permuter, "permuter.py"), prep.permDir, "-j", String(Math.max(1, threads)), "--quiet", ...(stopOnZero ? ["--stop-on-zero"] : []), ...(seed ? ["--seed", seed] : [])];
  const logPath = path.join(jobDir, "permuter.log");
  const out = fs.openSync(logPath, "a");
  const child = spawn("timeout", ["-s", "INT", "-k", "10", String(timeLimitS), t.python, ...args], { cwd: jobDir, env: { ...process.env, ...project.env, PYTHONUNBUFFERED: "1" }, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  const rec = {
    jobId, project: project.id, function: { symbol: fn.symbol, segment: fn.segment, va: fn.vaHex }, label: label ?? null,
    status: "running", pid: child.pid, startedAt: new Date().toISOString(), timeLimitS, threads, seed: seed ?? null, stopOnZero,
    resumeFrom: resumeFrom ?? null, baseCandidateSha256: sha256Text(baseCandidateText).slice(0, 16),
    dir: jobDir, permuterDir: prep.permDir, log: logPath, importLog: prep.importLog,
    backend: { name: "decomp-permuter", commit: (await backendStatus()).permuter?.commit, argv: [t.python, ...args] },
    best: null,
  };
  await writeFile(path.join(jobDir, "base.c"), baseCandidateText);
  await writeFile(path.join(jobDir, "job.json"), JSON.stringify(rec, null, 2));
  child.on("exit", () => {});
  return rec;
}

/** Read a job record + derive live status from the log and output dirs. */
export async function jobStatus(project, jobId) {
  const jobDir = path.join(jobsDir(project), jobId);
  let rec;
  try { rec = JSON.parse(await readFile(path.join(jobDir, "job.json"), "utf8")); } catch { throw Object.assign(new Error(`no job '${jobId}' for project '${project.id}'`), { code: "JOB_NOT_FOUND" }); }
  const log = fs.existsSync(rec.log) ? await readFile(rec.log, "utf8") : "";
  const alive = rec.pid ? isAlive(rec.pid) : false;
  // Permuter lines: "base score = N", "found new best score! (N vs M)", "iteration K", "Found zero score!"
  const baseScore = Number(/base score\s*=\s*(\d+)/.exec(log)?.[1] ?? NaN);
  const bestHits = [...log.matchAll(/found (?:new best|a better) score!? \((\d+) vs (\d+)\)/g)].map((m) => Number(m[1]));
  const zero = /Found zero score/.test(log) || /score 0\b/.test(log) && /output-0-/.test(log);
  const errors = (log.match(/(Traceback|Error:|error:)/g) ?? []).length;
  // Best candidate on disk: output-<score>-<n>/source.c under the permuter dir.
  let best = null;
  try {
    const outs = (await readdir(rec.permuterDir)).filter((d) => /^output-(\d+)-\d+$/.test(d)).map((d) => ({ dir: d, score: Number(/^output-(\d+)-/.exec(d)[1]) })).sort((a, b) => a.score - b.score);
    if (outs.length) {
      const b = outs[0];
      const src = path.join(rec.permuterDir, b.dir, "source.c");
      best = { score: b.score, path: src, candidatesWritten: outs.length, sha256: fs.existsSync(src) ? sha256Text(await readFile(src, "utf8")).slice(0, 16) : null };
    }
  } catch {}
  let status = rec.status;
  if (status === "running" && !alive) status = zero ? "complete-zero" : "complete-budget";
  if (rec.cancelledAt) status = "cancelled";
  if (errors > 0 && !best && !alive) status = "failed";
  const elapsedS = Math.round((Date.now() - Date.parse(rec.startedAt)) / 1000);
  const derived = { ...rec, status, alive, elapsedS, baseScore: Number.isNaN(baseScore) ? null : baseScore, bestScoreSeen: bestHits.length ? Math.min(...bestHits) : null, improvements: bestHits.length, candidatesWritten: (log.match(/^wrote to /gm) ?? []).length, zeroFound: zero, errorLines: errors, best,
    logTail: log.split("\n").filter(Boolean).slice(-6), note: status === "complete-budget" ? "budget exhausted — NOT a match unless best.score is 0 and compare confirms exact" : status === "complete-zero" ? "the permuter found a zero-score candidate; run decomp({op:'compare'}) on best.path to confirm strict equality" : undefined };
  if (status !== rec.status || (best && JSON.stringify(best) !== JSON.stringify(rec.best))) {
    rec.status = status; rec.best = best; if (!alive && !rec.endedAt) rec.endedAt = new Date().toISOString();
    await writeFile(path.join(jobDir, "job.json"), JSON.stringify(rec, null, 2));
  }
  return derived;
}

export async function cancelJob(project, jobId) {
  const jobDir = path.join(jobsDir(project), jobId);
  const rec = JSON.parse(await readFile(path.join(jobDir, "job.json"), "utf8"));
  if (rec.pid && isAlive(rec.pid)) { try { process.kill(-rec.pid, "SIGINT"); } catch { try { process.kill(rec.pid, "SIGINT"); } catch {} } }
  rec.cancelledAt = new Date().toISOString(); rec.status = "cancelled";
  await writeFile(path.join(jobDir, "job.json"), JSON.stringify(rec, null, 2));
  return jobStatus(project, jobId);
}

export async function listJobs(project, symbol) {
  let ids = [];
  try { ids = await readdir(jobsDir(project)); } catch { return []; }
  const out = [];
  for (const id of ids) {
    try { const s = await jobStatus(project, id); if (!symbol || s.function.symbol === symbol) out.push({ jobId: id, symbol: s.function.symbol, status: s.status, best: s.best?.score ?? null, elapsedS: s.elapsedS, startedAt: s.startedAt }); } catch {}
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
