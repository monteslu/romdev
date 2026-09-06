// integrate.js — turn an exact candidate into a reviewable source patch, apply
// it, run the project's full build, and verify the ROM byte-for-byte. Any
// failure restores the original TU. The patch file is written whether or not
// it is applied, so a human can review it as a diff.
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { run } from "./mips-obj.js";
import { spliceFunction } from "./compile.js";
import { sha1File } from "./project.js";

/**
 * @param {import('./project.js').Project} project
 * @param {object} fn resolved function
 * @param {{candidateText:string, apply:boolean, verify:boolean, jobs?:number, declarations?:string}} opts
 */
export async function integrateCandidate(project, fn, { candidateText, apply = false, verify = true, jobs = 8, declarations }) {
  const tuRel = fn.source?.tu;
  if (!tuRel) throw Object.assign(new Error(`function '${fn.symbol}' is not in any TU`), { code: "FUNCTION_NOT_IN_TU" });
  const tuAbs = project.abs(tuRel);
  const original = await readFile(tuAbs, "utf8");
  let text = candidateText;
  if (declarations) text = declarations.replace(/\s*$/, "\n\n") + text;
  const spliced = spliceFunction(original, fn.symbol, text);
  const dir = path.join(project.ws, "patches");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const newPath = path.join(dir, `${fn.symbol}.${stamp}.c`);
  await writeFile(newPath, spliced.text);
  const patchPath = path.join(dir, `${fn.symbol}.${stamp}.patch`);
  const d = await run("diff", ["-u", "--label", `a/${tuRel}`, "--label", `b/${tuRel}`, tuAbs, newPath], { cwd: project.root });
  await writeFile(patchPath, d.stdout);
  const result = { function: fn.symbol, tu: tuRel, replaced: spliced.replaced, atLine: spliced.line, patch: patchPath, patchLines: d.stdout.split("\n").length, applied: false, verification: { fullRom: "not-run" } };
  if (!apply) { result.note = "patch written, NOT applied (apply:true to write the TU and verify the full ROM)"; return result; }
  const backup = path.join(dir, `${fn.symbol}.${stamp}.orig.c`);
  await copyFile(tuAbs, backup);
  await writeFile(tuAbs, spliced.text);
  result.applied = true; result.backup = backup;
  if (!verify) { result.note = "applied WITHOUT full-ROM verification (verify:true to build + compare)"; return result; }
  const v = await fullRomVerify(project, { jobs });
  result.verification = { fullRom: v.ok ? "byte-exact" : "MISMATCH", ...v };
  if (!v.ok) {
    await writeFile(tuAbs, original);
    result.applied = false; result.revertedTo = backup;
    result.note = "full build did not reproduce the base ROM — the TU was RESTORED to its original text; the patch file remains for inspection";
  } else result.note = "applied and the full rebuilt ROM is byte-exact with the base ROM";
  return result;
}

/** Run the project's build and compare the built ROM with the base ROM. */
export async function fullRomVerify(project, { jobs = 8 } = {}) {
  const cmd = project.m.build.command;
  const t0 = Date.now();
  const r = await run(cmd[0], [...cmd.slice(1), `-j${jobs}`], { cwd: project.root, env: project.env, timeoutMs: 900_000 });
  const ms = Date.now() - t0;
  const built = project.m.built?.rom ? project.abs(project.m.built.rom) : null;
  const logPath = path.join(project.ws, "last-build.log");
  await mkdir(project.ws, { recursive: true });
  await writeFile(logPath, `$ ${cmd.join(" ")} -j${jobs}\n${r.stdout}\n${r.stderr}`);
  if (r.code !== 0) return { ok: false, buildExit: r.code, buildMs: ms, log: logPath, tail: (r.stdout + r.stderr).split("\n").filter(Boolean).slice(-8) };
  if (!built || !fs.existsSync(built)) return { ok: false, buildExit: r.code, buildMs: ms, log: logPath, error: `built ROM not found at ${built}` };
  const sha = await sha1File(built);
  return { ok: sha === project.m.rom.sha1, buildExit: r.code, buildMs: ms, builtSha1: sha, baseSha1: project.m.rom.sha1, builtRom: project.m.built.rom, log: logPath };
}
