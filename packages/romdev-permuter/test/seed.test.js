// Seeding: `--seed [permIndex,]rngSeed` must replay the same candidates, and
// the candidate a seed denotes is the one Candidate.from_source + repeated
// randomize_ast produces for that rng seed (upstream keeps randomizing the
// same candidate when the rng seed is forced).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, copyFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { run } from "../src/main.js";
import { Compiler } from "../src/compiler.js";
import { Scorer } from "../src/scorer.js";
import { Candidate } from "../src/candidate.js";
import { EvalState } from "../src/perm/perm.js";
import { perm_parse } from "../src/perm/parse.js";
import { perm_evaluate_one } from "../src/perm/eval.js";
import { get_default_randomization_weights, parseToml, get_settings } from "../src/helpers.js";
import { wasmGccCompile } from "./helpers/wasm-gcc.js";
import { MIPS_GCC_SCORER } from "./helpers/payloads.js";
import { workDir, removeDir } from "./helpers/work.js";

const INTRO = "int a, b, c; int f(int x) {";
const BASE = `${INTRO}\n  a = x * 3;\n  b = a + x;\n  c = b << 2;\n  return a + b + c;\n}\n`;

async function setup() {
  const dir = workDir("seed");
  writeFileSync(path.join(dir, "base.c"), BASE);
  writeFileSync(path.join(dir, "settings.toml"), "func_name = \"f\"\ncompiler_type = \"gcc\"\n");
  const c = new Compiler(null, { tmpDir: path.join(dir, ".cc"), compileFn: wasmGccCompile });
  const t = await c.compile(`${INTRO}\n  b = x * 4;\n  a = x * 3;\n  c = b << 2;\n  return a + b + c;\n}\n`);
  copyFileSync(t, path.join(dir, "target.o"));
  return dir;
}

async function seededRun(dir, seed, iterations) {
  const ac = new AbortController();
  const scores = [];
  await run({ directories: [dir], force_seed: seed, compileFn: wasmGccCompile, signal: ac.signal, quiet: true, out: () => {},
    onResult: (r) => { scores.push(r.score); if (r.iteration >= iterations) ac.abort(); } });
  const outs = readdirSync(dir).filter((d) => d.startsWith("output-")).sort()
    .map((d) => readFileSync(path.join(dir, d, "source.c"), "utf8"));
  return { scores, outs };
}

test("a forced seed replays the same scores and outputs", { skip: MIPS_GCC_SCORER }, async () => {
  const d1 = await setup(), d2 = await setup();
  try {
    const a = await seededRun(d1, "0,4242", 12);
    const b = await seededRun(d2, "0,4242", 12);
    assert.equal(a.scores.length, 12);
    assert.deepEqual(a.scores, b.scores);
    assert.deepEqual(a.outs, b.outs);
  } finally {
    removeDir(d1);
    removeDir(d2);
  }
});

test("the forced rng seed denotes Candidate.from_source + randomize_ast", { skip: MIPS_GCC_SCORER }, async () => {
  const dir = await setup();
  try {
    const weights = get_default_randomization_weights("gcc");
    const [text, st] = perm_evaluate_one(perm_parse(BASE, () => {}));
    const cand = Candidate.from_source(text, st, "f", weights, 777n);
    const expected = [];
    for (let i = 0; i < 6; i++) { cand.randomize_ast(); expected.push(cand.get_source()); }
    // Score each step of the chain directly; the seeded run must report exactly these scores.
    const scorer = await Scorer.create({ target_o: path.join(dir, "target.o"), stack_differences: false, algorithm: "difflib",
      debug_mode: false, ign_branch_targets: true, objdump_command: null });
    const compiler = new Compiler(null, { tmpDir: path.join(dir, ".cc2"), compileFn: wasmGccCompile });
    const want = [];
    for (const src of expected) want.push((await scorer.score(await compiler.compile(src)))[0]);
    const { scores, outs } = await seededRun(dir, "777", 6);
    assert.deepEqual(scores, want);
    for (const o of outs) assert.ok(expected.includes(o), "output not in the seed's randomization chain");
  } finally {
    removeDir(dir);
  }
});

test("settings and default weights: TOML subset and compiler_type merge", () => {
  const w = get_default_randomization_weights("ido");
  assert.equal(w.perm_inline, 0);
  assert.equal(w.perm_temp_for_expr, 100);
  assert.equal(w.perm_alias_array, 0.5);
  assert.equal(Object.keys(w).length, 35);
  const t = parseToml("func_name = \"f\" # x\ncompiler_type = 'ido'\n[weight_overrides]\nperm_sameline = 2\nperm_inline = 0.5\n");
  assert.equal(t.func_name, "f");
  assert.deepEqual(t.weight_overrides, { perm_sameline: { int: 2 }, perm_inline: 0.5 });
  const dir = workDir("settings");
  try {
    writeFileSync(path.join(dir, "settings.toml"), "func_name = \"g\"\n");
    assert.equal(get_settings(dir).func_name, "g");
  } finally { removeDir(dir); }
  void EvalState;
});
