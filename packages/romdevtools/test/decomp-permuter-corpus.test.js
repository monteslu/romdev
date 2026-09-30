// Upstream's recorded permuter scores, reproduced through romdev's own path.
//
// A romdev decomp workspace keeps the search jobs the Python decomp-permuter
// ran (permuter.log "base score = N", output-*/{source.c,score.txt}). Each
// candidate is rebuilt from the port's printed base source, compiled with the
// job's compile step through romdev's WASM toolchain (permuter-compile.js, the
// same module in-process searches use), and scored by romdev-permuter's scorer
// on the WASM mips-linux-gnu objdump; the score must equal upstream's.
//
// Local data only (skips without a corpus). ROMDEV_PERMUTER_CORPUS names a jobs
// directory (default: every ~/.romdev/decomp/<project>/jobs);
// ROMDEV_PERMUTER_CORPUS_SCORES caps the compiles (default 24, "all" for every
// recorded score).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { perm_parse, perm_evaluate_one, Candidate, Scorer, trim_source, get_settings, get_default_randomization_weights } from "romdev-permuter";
import { parseShell } from "../src/decomp/recipe.js";
import { compileCandidate } from "../src/decomp/permuter-compile.js";

function jobDirs() {
  const roots = process.env.ROMDEV_PERMUTER_CORPUS ? [process.env.ROMDEV_PERMUTER_CORPUS] : (() => {
    const base = path.join(os.homedir(), ".romdev", "decomp");
    return existsSync(base) ? readdirSync(base).map((p) => path.join(base, p, "jobs")).filter(existsSync) : [];
  })();
  const out = [];
  for (const r of roots) for (const j of readdirSync(r)) {
    const pd = path.join(r, j, "permuter");
    if (!existsSync(path.join(pd, "base.c")) || !existsSync(path.join(pd, "compile.sh")) || !existsSync(path.join(r, j, "permuter.log"))) continue;
    // Only jobs the upstream (Python) permuter ran are an oracle.
    const rec = existsSync(path.join(r, j, "job.json")) ? JSON.parse(readFileSync(path.join(r, j, "job.json"), "utf8")) : {};
    if (rec.backend?.name && rec.backend.name !== "decomp-permuter") continue;
    out.push({ job: path.join(r, j), pd });
  }
  return out;
}

/** The compile argv + cwd recorded in a job's compile.sh (cd <root>; <cc ... "$OUTPUT" "$INPUT">). */
function compileStep(pd) {
  const lines = readFileSync(path.join(pd, "compile.sh"), "utf8").split("\n");
  const k = lines.findIndex((l) => l.startsWith("cd "));
  const cwd = parseShell(lines[k])[0].pipeline[0].argv[1];
  const line = lines[k + 1].split("\"$INPUT\"").join("@IN@").split("\"$OUTPUT\"").join("@OUT@");
  const argv = parseShell(line)[0].pipeline[0].argv.map((a) => (a === "@IN@" ? "$INPUT" : a === "@OUT@" ? "$OUTPUT" : a));
  return { argv, cwd };
}

const JOBS = jobDirs();
const cap = process.env.ROMDEV_PERMUTER_CORPUS_SCORES ?? "24";
const budget = cap === "all" ? Infinity : Number(cap);
const WORK = path.join(path.dirname(fileURLToPath(import.meta.url)), ".work-permuter-corpus");

test("upstream's recorded permuter scores reproduce through the WASM compile + objdump path", {
  skip: (!JOBS.length && "no decomp corpus") || (!budget && "score budget 0"),
}, async (t) => {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const tasks = [];
  for (const { job, pd } of JOBS) {
    const m = /base score = (\d+)/.exec(readFileSync(path.join(job, "permuter.log"), "utf8"));
    if (m) tasks.push({ pd, kind: "base", want: Number(m[1]) });
    for (const o of readdirSync(pd).filter((d) => /^output-\d+-\d+$/.test(d))) {
      tasks.push({ pd, kind: o, want: Number(readFileSync(path.join(pd, o, "score.txt"), "utf8").trim()) });
    }
  }
  const step = budget === Infinity ? 1 : Math.max(1, Math.floor(tasks.length / budget));
  const printed = new Map(), scorers = new Map();
  let compared = 0, k = 0;
  const mismatches = [];
  try {
    for (let i = 0; i < tasks.length && compared < budget; i += step) {
      const { pd, kind, want } = tasks[i];
      const settings = get_settings(pd);
      if (!printed.has(pd)) {
        const [text, st] = perm_evaluate_one(perm_parse(readFileSync(path.join(pd, "base.c"), "utf8"), () => {}));
        printed.set(pd, Candidate.from_source(text, st, settings.func_name, get_default_randomization_weights(settings.compiler_type ?? "base"), 0).get_source());
        scorers.set(pd, await Scorer.create({ target_o: path.join(pd, "target.o"), stack_differences: false, algorithm: "difflib",
          debug_mode: false, ign_branch_targets: true, objdump_command: settings.objdump_command ?? null }));
      }
      const base = printed.get(pd);
      let text = base;
      if (kind !== "base") {
        const out = readFileSync(path.join(pd, kind, "source.c"), "utf8");
        // source.c is either whole or trimmed at the function (--no-context-output).
        text = out.startsWith(base.slice(0, 300)) ? out : base.slice(0, base.length - trim_source(base, settings.func_name).length) + out;
      }
      const c = path.join(WORK, `c${k}.c`), o = path.join(WORK, `c${k}.o`);
      k++;
      (await import("node:fs")).writeFileSync(c, text);
      const ok = await compileCandidate(c, o, { ...compileStep(pd), tmpRoot: WORK });
      assert.ok(ok, `${pd} ${kind}: compile failed`);
      const [got] = await scorers.get(pd).score(o);
      rmSync(c, { force: true });
      rmSync(o, { force: true });
      if (got !== want) mismatches.push(`${pd} ${kind}: upstream ${want}, port ${got}`);
      compared++;
    }
  } finally {
    rmSync(WORK, { recursive: true, force: true });
  }
  t.diagnostic(`compared ${compared} upstream scores`);
  assert.deepEqual(mismatches, []);
});
