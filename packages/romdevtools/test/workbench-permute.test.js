// The permuter sweep driver: recipe recovery, queue policy, scratch
// preparation and fidelity, the bounded search, the doctor, the classifier
// and the three commands. Ported from the workbench's own permute tests.
// Nothing here needs the permuter, a compiler, or a project build: the
// orchestration takes its process runner as an argument, and a fake stands
// in for `make -n`, the importer and the search.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIDELITY_DIFFERS, FIDELITY_IDENTICAL, FIDELITY_UNCHECKED, FIDELITY_UNKNOWN, FidelityAttempt, QueueItem, ScratchFidelity, SweepResult,
  bestOutput, completedFunctions, earlierResults, fidelityWarning, joinContinuations, loadGateNote, loadQueue, loadRanking, macroAttributable,
  objectTarget, orderQueue, parseBaseScore, parseDryRun, parsePreservedMacros, permuterArgv, recipeReport, recoverRecipe, renderSettings,
  renderTable, resolvePreserveMacroModes, retargetLabels, retargetObjcopy, shouldExtend, sweepPayload, waitForHeadroom, outputFraction,
} from "../src/decomp/workbench/permute.js";
import {
  CLASSIFY_SCHEMA, IMPORT_FAULT, MATCHED, P_STUCK_DESCENDING, P_STUCK_FLAT, classifyPayload, classifyRow, classifySummary, renderMarkdown,
} from "../src/decomp/workbench/permute-classify.js";
import {
  PermuterError, TimeoutExpired, checkScratchFidelity, compileScratchBase, doctor, expandPermuterPragmas, importScratch, prepareScratch,
  renderDoctor, resolvePlan, runOwned, runPermuter, runSweep, searchFunction,
} from "../src/decomp/workbench/permute-sweep.js";
import { COMMAND_SPECS, permuteSweepCommand, permuteDoctorCommand } from "../src/decomp/workbench/permute-cli.js";
import { parseArgs } from "../src/decomp/workbench/argparse.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { stampRanking } from "../src/decomp/workbench/ranking.js";
import { buildRelocatable, words, R_MIPS_26, STB_GLOBAL, STT_FUNC } from "./fixtures/workbench/elf-fixtures.js";

const hasProjectConfig = fs.existsSync(fileURLToPath(new URL("../src/decomp/workbench/project-config.js", import.meta.url)));
const hasRelocSurface = fs.existsSync(fileURLToPath(new URL("../src/decomp/workbench/reloc-surface.js", import.meta.url)));
const SUMMARY_FIXTURE = fileURLToPath(new URL("./fixtures/workbench/permute-summary.json", import.meta.url));

/** A dry run whose compile line is split by a backslash continuation. */
const CONTINUED_DRY_RUN = `echo "CC      src/game/track.c"
tools/ido/cc -c -non_shared -G 0 -I include -DVERSION_us \\
        -O2 -mips2 -Wab,-r4300_mul -32 -o build/src/game/track.c.o \\
        src/game/track.c
tools/binutils/objcopy --redefine-sym A=B build/src/game/track.c.o && \\
        tools/trim_elf_section.py build/src/game/track.c.o && \\
        tools/binutils/objcopy --weaken-symbol C build/src/game/track.c.o
`;
const OBJECT = "build/src/game/track.c.o";
/** The post-compile script pass the dry run names (a script over the object, never replayed). */
const TRIM = "tools/trim_elf_section" + ".py";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-permute-"));
async function withTemp(fn) { const d = tmp(); try { return await fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); } }

/** The defaults of the project config's [permuter] table. */
function permuterOptions(o = {}) {
  return { make: "make", python: null, permuter_dir: null, object_template: "build/{source}.o", compiler_marker: null, compiler_command: null,
    assembler_command: null, compiler_type: "ido", preserve_macros: [], preserve_macro_modes: ["configured", "none"], decompme_compiler: null,
    objdump: null, output_dir: null, ranking: null, fallback_flags: [], skip_postprocess: ["\\.py\\b"], minutes: 20, jobs: 1, threads: null,
    load_threshold: 0.0, nice: 15, step_timeout_seconds: 600.0, ...o };
}

// ---------------------------------------------------------------------------
// Recipe parsing
// ---------------------------------------------------------------------------

test("continuation lines are joined before parsing", () => { assert.equal(joinContinuations("a \\\nb"), "a  b"); });

test("flags come off the continued compile line, with or without a compiler marker", () => {
  const recipe = parseDryRun(CONTINUED_DRY_RUN, { obj: OBJECT, compiler: "tools/ido/cc" });
  assert.deepEqual(recipe.flags, ["-O2", "-mips2", "-Wab,-r4300_mul", "-32"]);
  assert.equal(recipe.from_dry_run, true);
  assert.deepEqual(recipe.warnings, []);
  assert.deepEqual(parseDryRun(CONTINUED_DRY_RUN, { obj: OBJECT }).flags, ["-O2", "-mips2", "-Wab,-r4300_mul", "-32"]);
});

test("the objcopy chain is split and script passes are skipped", () => {
  const recipe = parseDryRun(CONTINUED_DRY_RUN, { obj: OBJECT, compiler: "tools/ido/cc" });
  assert.deepEqual(recipe.objcopy_steps, [`tools/binutils/objcopy --redefine-sym A=B ${OBJECT}`, `tools/binutils/objcopy --weaken-symbol C ${OBJECT}`]);
  assert.deepEqual(recipe.skipped_postprocess, [`${TRIM} ${OBJECT}`]);
});

test("an up-to-date object prints nothing and warns loudly", () => {
  const recipe = parseDryRun("", { obj: OBJECT, compiler: "tools/ido/cc" });
  assert.deepEqual(recipe.flags, []);
  assert.equal(recipe.from_dry_run, false);
  assert.equal(recipe.warnings.length, 1);
  assert.ok(recipe.warnings[0].includes("wrong ISA"));
});

test("a line without an ISA flag, or about another object, is not a compile line", () => {
  assert.deepEqual(parseDryRun(`rm -f ${OBJECT}`, { obj: OBJECT }).flags, []);
  assert.deepEqual(parseDryRun("tools/ido/cc -O2 -mips2 -32 -o build/other.c.o other.c\n", { obj: OBJECT }).flags, []);
});

test("object targets render from the source path", () => {
  assert.equal(objectTarget("build/{source}.o", "src/game/track.c"), "build/src/game/track.c.o");
  assert.equal(objectTarget("obj/{stem}.o", "src/game/track.c"), "obj/track.o");
});

test("the chain is retargeted at the scratch object, whole tokens only", () => {
  assert.deepEqual(retargetObjcopy([`objcopy --redefine-sym A=B ${OBJECT}`], OBJECT), ['objcopy --redefine-sym A=B "$OUTPUT"']);
  assert.deepEqual(retargetObjcopy([`objcopy --weaken ${OBJECT} ${OBJECT}`], OBJECT), ['objcopy --weaken "$OUTPUT" "$OUTPUT"']);
  assert.deepEqual(retargetObjcopy([`objcopy --redefine-syms=${OBJECT}.syms ${OBJECT}`], OBJECT), [`objcopy --redefine-syms=${OBJECT}.syms "$OUTPUT"`]);
  assert.deepEqual(retargetObjcopy([`objcopy --weaken-symbol C ./${OBJECT}`], OBJECT), ['objcopy --weaken-symbol C "$OUTPUT"']);
  assert.deepEqual(retargetObjcopy([`objcopy --weaken vendor/${OBJECT}`], OBJECT), [`objcopy --weaken vendor/${OBJECT}`]);
});

test("the recipe report names the fallback as a fallback", () => {
  const report = recipeReport(parseDryRun("", { obj: OBJECT }), []);
  assert.ok(report.includes("NOT the real build"));
  assert.ok(report.includes("warning:"));
});

// ---------------------------------------------------------------------------
// Recipe recovery
// ---------------------------------------------------------------------------

test("the source is touched before the dry run", () => withTemp(async (root) => {
  const calls = [];
  const runner = async (argv) => { calls.push(argv); return { args: argv, returncode: 0, stdout: CONTINUED_DRY_RUN, stderr: "" }; };
  const source = path.join(root, "src", "game", "track.c");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "int f(void) { return 0; }\n");
  const old = new Date(Date.now() - 100_000); fs.utimesSync(source, old, old);
  const before = fs.statSync(source).mtimeMs;
  const recipe = await recoverRecipe(root, new QueueItem({ function: "f", source: "src/game/track.c" }), { make: "gmake", compiler: "tools/ido/cc", runner });
  assert.deepEqual(calls, [["gmake", "-n", OBJECT]]);
  assert.ok(fs.statSync(source).mtimeMs > before);
  assert.deepEqual(recipe.flags.slice(0, 2), ["-O2", "-mips2"]);
}));

test("a failed dry run falls back and says so", () => withTemp(async (root) => {
  const runner = async () => { throw Object.assign(new Error("gmake: not found"), { name: "OSError" }); };
  const recipe = await recoverRecipe(root, new QueueItem({ function: "f", source: "src/game/track.c" }), { fallback_flags: ["-O2", "-mips2", "-32"], runner });
  assert.deepEqual(recipe.flags, ["-O2", "-mips2", "-32"]);
  assert.equal(recipe.from_dry_run, false);
  assert.ok(recipe.warnings[0].includes("could not run"));
}));

test("a make dry run that times out degrades to the fallback", () => withTemp(async (root) => {
  const runner = async (argv) => { throw new TimeoutExpired(argv, 600.0); };
  const recipe = await recoverRecipe(root, new QueueItem({ function: "f", source: "src/game/track.c" }), { fallback_flags: ["-O2", "-mips2"], runner });
  assert.deepEqual(recipe.flags, ["-O2", "-mips2"]);
  assert.equal(recipe.from_dry_run, false);
  assert.equal(recipe.warnings.length, 1);
}));

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

test("JSON and line queues read the same rows", () => withTemp((root) => {
  fs.writeFileSync(path.join(root, "queue.json"), JSON.stringify({ functions: [{ function: "f", source: "src/a.c", asm: "asm/f.s" }] }));
  fs.writeFileSync(path.join(root, "queue.txt"), "# comment\nf src/a.c asm/f.s\n\n");
  assert.deepEqual(loadQueue(path.join(root, "queue.json")), loadQueue(path.join(root, "queue.txt")));
}));

test("an unknown queue key is refused", () => withTemp((root) => {
  fs.writeFileSync(path.join(root, "queue.json"), JSON.stringify([{ function: "f", source: "a.c", oops: 1 }]));
  assert.throws(() => loadQueue(path.join(root, "queue.json")), { name: "ValueError" });
}));

test("closest-first ordering puts unranked functions last", () => {
  const items = ["far", "unranked_b", "near", "unranked_a"].map((f, i) => new QueueItem({ function: f, source: `${i}.c` }));
  const ranking = new Map([["far", [40, 200]], ["near", [2, 120]]]);
  assert.deepEqual(orderQueue(items, ranking).map((i) => i.function), ["near", "far", "unranked_a", "unranked_b"]);
});

test("a ranking reads differing words and ignores junk", () => withTemp((root) => {
  const p = path.join(root, "ranking.json");
  fs.writeFileSync(p, JSON.stringify({ functions: [{ name: "a", differing_words: 3, size_bytes: 10 }, { name: "b", differing_words: "many" }, { nope: true }] }));
  assert.deepEqual([...loadRanking(p)], [["a", [3, 10]]]);
  assert.equal(loadRanking(null).size, 0);
}));

// ---------------------------------------------------------------------------
// Run policy
// ---------------------------------------------------------------------------

test("stack diffs and nice are forced on, and never repeated", () => {
  const argv = permuterArgv({ interpreter: "node", permuter: "/p/permuter.mjs", scratch: "/s", threads: 3, posix: true });
  assert.deepEqual(argv.slice(0, 3), ["nice", "-n", "15"]);
  assert.ok(argv.includes("--stack-diffs"));
  assert.ok(argv.includes("--stop-on-zero"));
  assert.equal(argv[argv.length - 1], "/s");
  const again = permuterArgv({ interpreter: "node", permuter: "/p/permuter.mjs", scratch: "/s", threads: 1, extra: ["--stack-diffs"], nice: null });
  assert.equal(again.filter((a) => a === "--stack-diffs").length, 1);
  assert.equal(again[0], "node");
});

test("a still-descending run is extended and a plateau is not", () => {
  const window = 20;
  const common = { minutes: window, best_score: 5, extend_minutes: 10 };
  assert.equal(shouldExtend({ elapsed: window * 60, best_age: 100.0, ...common }), true);
  assert.equal(shouldExtend({ elapsed: window * 60, best_age: 900.0, ...common }), false);
  assert.equal(shouldExtend({ elapsed: 60.0, best_age: 10.0, ...common }), false);
  assert.equal(shouldExtend({ elapsed: window * 60, minutes: window, best_score: 0, best_age: 10.0, extend_minutes: 10 }), false);
  assert.equal(shouldExtend({ elapsed: window * 60, minutes: window, best_score: 5, best_age: 10.0, extend_minutes: 0 }), false);
});

test("the load gate waits and then proceeds", async () => {
  const loads = [12.0, 11.0, 3.0][Symbol.iterator]();
  const slept = [], messages = [];
  const waits = await waitForHeadroom(9.0, { label: "before permuting f", load: () => loads.next().value, sleep: async (s) => { slept.push(s); }, interval: 1.0, report: (m) => messages.push(m) });
  assert.equal(waits, 2);
  assert.deepEqual(slept, [1.0, 1.0]);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].includes("before permuting f"));
});

test("a host with no load average is not reported as idle", async () => {
  assert.equal(await waitForHeadroom(9.0, { load: () => null }), 0);
  assert.ok(loadGateNote(9.0, { load: () => null }).includes("not gated"));
  assert.equal(loadGateNote(9.0, { load: () => 0.5 }), null);
  assert.equal(loadGateNote(0.0, { load: () => null }), null);
});

test("a disabled load gate never reads the load", async () => {
  assert.equal(await waitForHeadroom(0.0, { load: () => { throw new Error("the load must not be read when the gate is off"); } }), 0);
});

test("the lowest-scoring output wins", () => withTemp((scratch) => {
  for (const n of ["output-12-aaa", "output-3-bbb", "output-nope"]) fs.mkdirSync(path.join(scratch, n));
  const [dir, score] = bestOutput(scratch);
  assert.equal(score, 3);
  assert.equal(path.basename(dir), "output-3-bbb");
  assert.deepEqual(bestOutput(path.join(scratch, "missing")), [null, null]);
}));

test("the base score is read out of the log", () => {
  assert.equal(parseBaseScore("...\nbase score = 214\n"), 214);
  assert.equal(parseBaseScore("permuter failed"), null);
});

// ---------------------------------------------------------------------------
// Settings, summary
// ---------------------------------------------------------------------------

test("settings carry the real flags and preserved macros", () => {
  const text = renderSettings({ compiler_command: "cc -c -I include -DVERSION_us", assembler_command: "as -march=vr4300", flags: ["-O2", "-mips2"],
    preserve_macros: ["g[DS]P.*=void"], decompme_compiler: "ido5.3" });
  assert.ok(text.includes("cc -c -I include -DVERSION_us -O2 -mips2"));
  assert.ok(text.includes('assembler_command = "as -march=vr4300"'));
  assert.ok(text.includes("[preserve_macros]"));
  assert.ok(text.includes('"g[DS]P.*" = "void"'));
  assert.ok(text.includes('"cc" = "ido5.3"'));
});

test("a target label rename touches only that label", () => {
  const text = "glabel func_overlay_1_80001234\n/* code */\n.word func_other\n";
  const renamed = retargetLabels(text, { old: "func_overlay_1_80001234", new: "overlay1GetEntry" });
  assert.ok(renamed.includes("glabel overlay1GetEntry"));
  assert.ok(renamed.includes(".word func_other"));
  assert.equal(retargetLabels(text, { old: "x", new: "x" }), text);
});

test("resume reads what a previous sweep recorded, and retries a broken scratch", () => withTemp((dir) => {
  const summary = path.join(dir, "summary.json");
  fs.writeFileSync(summary, JSON.stringify(sweepPayload([new SweepResult({ function: "done", source: "a.c", ok: true, best_score: 4 }),
    new SweepResult({ function: "broken", source: "b.c", ok: false, error: "the importer failed" })], { final: true })));
  assert.deepEqual([...completedFunctions(summary)], ["done"]);
  const carried = earlierResults(summary);
  assert.deepEqual(carried.map((r) => r.function), ["done", "broken"]);
  assert.equal(carried[0].best_score, 4);
  assert.equal(completedFunctions(path.join(dir, "nope.json")).size, 0);
}));

test("the table reports a fallback search as a fallback", () => {
  const rows = renderTable([new SweepResult({ function: "a", source: "a.c", ok: true, flags_recovered: true }), new SweepResult({ function: "b", source: "b.c", ok: true, flags_recovered: false })]);
  assert.ok(rows[1].includes("real"));
  assert.ok(rows[2].includes("FALLBACK"));
  assert.ok(rows[rows.length - 1].includes("1 searched with fallback flags"));
});

// ---------------------------------------------------------------------------
// A fake project: a tree plus a runner that impersonates the three tools
// ---------------------------------------------------------------------------

class FakeProject {
  constructor(root, { dry_run = CONTINUED_DRY_RUN, preserve_macros = [] } = {}) {
    Object.assign(this, { root, dry_run, preserve_macros, base_score: 214, outputs: ["output-9-aaa"], import_fails: false, commands: [], imports: [],
      preserved_report: "macros: gDPPipeSync, gSPEndDisplayList", step_timeout_seconds: 600.0 });
    fs.mkdirSync(path.join(root, "src", "game"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "game", "track.c"), "int f(void);\n");
    fs.mkdirSync(path.join(root, "asm"));
    fs.writeFileSync(path.join(root, "asm", "f.s"), "glabel f_asm\njr $ra\n");
    fs.mkdirSync(path.join(root, "permuter"));
    for (const n of ["import.mjs", "permuter.mjs"]) fs.writeFileSync(path.join(root, "permuter", n), "");
    this.run = this.run.bind(this);
  }
  get options() {
    return permuterOptions({ make: "gmake", permuter_dir: path.join(this.root, "permuter"), compiler_marker: "tools/ido/cc",
      compiler_command: "tools/ido/cc -c -I include", assembler_command: "as -march=vr4300", output_dir: path.join(this.root, "out"),
      preserve_macros: this.preserve_macros, step_timeout_seconds: this.step_timeout_seconds });
  }
  buildTheObject() {
    const obj = path.join(this.root, OBJECT);
    fs.mkdirSync(path.dirname(obj), { recursive: true });
    fs.writeFileSync(obj, Buffer.from("\x7fELF", "latin1"));
    return obj;
  }
  get item() { return new QueueItem({ function: "f", source: "src/game/track.c", asm: "asm/f.s", asm_symbol: "f_asm" }); }
  async run(argv, kw = {}) {
    this.commands.push([...argv]);
    if (argv[0].endsWith("make") && argv.includes("-n")) return { args: argv, returncode: 0, stdout: this.dry_run, stderr: "" };
    if (argv.some((a) => String(a).endsWith("import.mjs"))) {
      if (this.import_fails) return { args: argv, returncode: 1, stdout: "not found in base.c", stderr: "" };
      const regex = argv.includes("--preserve-macros") ? argv[argv.indexOf("--preserve-macros") + 1] : null;
      this.imports.push(regex);
      const scratch = path.join(this.root, "nonmatchings", "f");
      fs.mkdirSync(scratch, { recursive: true });
      fs.writeFileSync(path.join(scratch, "compile.sh"), '#!/bin/sh\ncc "$1"\n');
      fs.writeFileSync(path.join(scratch, "base.c"), "int f(void) { return 0; }\n");
      const preserved = regex === "" ? "no macros" : this.preserved_report;
      const log = preserved !== null ? `Preserving ${preserved}. Use --preserve-macros\n` : "Compiler type: ido\n";
      return { args: argv, returncode: 0, stdout: log, stderr: "" };
    }
    if (argv[0].endsWith("compile.sh")) {
      fs.writeFileSync(argv[argv.indexOf("-o") + 1], Buffer.from("\x7fELF", "latin1"));
      return { args: argv, returncode: 0, stdout: "", stderr: "" };
    }
    if (argv.some((a) => String(a).endsWith("permuter.mjs"))) {
      const scratch = argv[argv.length - 1];
      for (const name of this.outputs) { fs.mkdirSync(path.join(scratch, name), { recursive: true }); fs.writeFileSync(path.join(scratch, name, "source.c"), "int f(void) { }\n"); }
      if (kw.stdout && kw.stdout.file) fs.appendFileSync(kw.stdout.file, `base score = ${this.base_score}\n`);
      return { args: argv, returncode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command: ${argv}`);
  }
}

const fakeComparison = (words, { delta = 0, error = null } = {}) => ({ word_mismatches: words, raw_word_mismatches: words, instruction_delta: delta, exact: words === 0 && delta === 0, error });
const comparingWith = (comparison) => (plan, item, scratch, outDir, opts) => checkScratchFidelity(plan, item, scratch, outDir, { ...opts, compare: () => comparison });

/** A fidelity checker that answers from a script instead of a compiler. */
function scriptedFidelity(...answers) {
  const checker = async (plan, item, scratch, outDir, { mode, preserved_macros = null } = {}) => {
    checker.modes.push(mode);
    const answer = answers[Math.min(checker.modes.length - 1, answers.length - 1)];
    return new ScratchFidelity({ ...answer, mode, preserved_macros });
  };
  checker.modes = [];
  return checker;
}

test("the scratch replicates the real recipe", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  const plan = resolvePlan(project.root, project.options);
  const { out_dir: outDir, scratch, recipe, steps } = await prepareScratch(plan, project.item, { runner: project.run });
  const settings = fs.readFileSync(path.join(outDir, "permuter_settings.toml"), "utf8");
  const compileSh = fs.readFileSync(path.join(scratch, "compile.sh"), "utf8");
  const report = fs.readFileSync(path.join(outDir, "recipe.txt"), "utf8");
  const target = fs.readFileSync(path.join(outDir, "target.s"), "utf8");
  assert.equal(recipe.from_dry_run, true);
  assert.ok(settings.includes("-mips2"));
  assert.equal(steps.length, 2);
  assert.ok(compileSh.includes('objcopy --redefine-sym A=B "$OUTPUT"'));
  assert.ok(report.includes(TRIM));
  assert.ok(report.includes("skipped (not replicable)"));
  assert.ok(target.includes("glabel f"));
  assert.ok(!target.includes("f_asm"));
}));

test("a failed import is reported with its log", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  project.import_fails = true;
  await assert.rejects(prepareScratch(resolvePlan(project.root, project.options), project.item, { runner: project.run }), (e) => e instanceof PermuterError && e.message.includes("import.mjs failed"));
}));

test("a missing compiler command refuses before running anything", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  const plan = resolvePlan(project.root, permuterOptions({ permuter_dir: path.join(project.root, "permuter") }));
  await assert.rejects(prepareScratch(plan, project.item, { runner: project.run }), (e) => e instanceof PermuterError && e.message.includes("compiler_command"));
  assert.deepEqual(project.commands, []);
}));

test("a missing permuter program is named, with the key that points at it", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  const plan = resolvePlan(project.root, permuterOptions({ compiler_command: "cc -c", permuter_dir: path.join(d, "absent") }));
  await assert.rejects(prepareScratch(plan, project.item, { runner: project.run }), (e) => e instanceof PermuterError && e.message.includes("permuter_dir") && e.message.includes("import.mjs"));
}));

// ---------------------------------------------------------------------------
// Preserved-macro modes, pragma expansion, fidelity
// ---------------------------------------------------------------------------

test("the default modes are the configured set, then none", () => {
  const modes = resolvePreserveMacroModes(["g[DS]P.*=void"]);
  assert.deepEqual(modes.map((m) => m.name), ["configured", "none"]);
  assert.deepEqual(modes[0].macros, ["g[DS]P.*=void"]);
  assert.equal(modes[0].regex, null);
  assert.deepEqual(modes[1].macros, []);
  assert.equal(modes[1].regex, "");
});

test("a project with no macros does not import the same thing twice", () => {
  const modes = resolvePreserveMacroModes([]);
  assert.deepEqual(modes.map((m) => m.name), ["configured"]);
  assert.equal(modes[0].regex, "");
});

test("a mode that is neither name is a narrowing regex", () => {
  const modes = resolvePreserveMacroModes(["g[DS]P.*=void", "OS_PHYSICAL_TO_K0=void *"], ["configured", "OS_PHYSICAL_TO_K0", "none"]);
  assert.deepEqual(modes.map((m) => m.name), ["configured", "OS_PHYSICAL_TO_K0", "none"]);
  assert.equal(modes[1].regex, "OS_PHYSICAL_TO_K0");
  assert.deepEqual(modes[1].macros, modes[0].macros);
});

test("the import log says which macros were preserved; nothing and silence differ", () => {
  assert.deepEqual(parsePreservedMacros("Compiler type: ido\nPreserving macros: gDPPipeSync, gSPMatrix. Use\n"), ["gDPPipeSync", "gSPMatrix"]);
  assert.deepEqual(parsePreservedMacros("Preserving no macros. Use\n"), []);
  assert.equal(parsePreservedMacros("Function name: f\n"), null);
});

test("only a scratch that preserved something is worth re-importing", () => {
  const differs = new ScratchFidelity({ status: FIDELITY_DIFFERS, differing_words: 4, attempts: [new FidelityAttempt({ mode: "configured", status: FIDELITY_DIFFERS })] });
  assert.equal(macroAttributable(differs), false);
  assert.equal(macroAttributable(new ScratchFidelity({ ...differs, preserved_macros: ["gDPPipeSync"] })), true);
  assert.equal(macroAttributable(new ScratchFidelity({ ...differs, status: FIDELITY_UNKNOWN })), false);
});

test("the latedefine block becomes the real defines", () => {
  const expanded = expandPermuterPragmas(["#pragma _permuter latedefine start", "#pragma _permuter define gDPPipeSync(pkt) _g(pkt)", "void gDPPipeSync();",
    "#pragma _permuter latedefine end", "void f(void) { gDPPipeSync(x); }"].join("\n"));
  assert.ok(expanded.includes("#define gDPPipeSync(pkt) _g(pkt)"));
  assert.ok(!expanded.includes("void gDPPipeSync();"));
  assert.ok(expanded.includes("void f(void) { gDPPipeSync(x); }"));
});

test("a b64 literal is restored; the fixed-address encoding is decoded; plain source is unchanged", () => {
  const encoded = Buffer.from('__asm__("nop");').toString("base64");
  assert.ok(expandPermuterPragmas(`#pragma _permuter b64literal ${encoded}\n`).includes('__asm__("nop");'));
  assert.equal(expandPermuterPragmas("u32 v = FIXEDADDR(0x1234);\n"), "u32 v : (0x1234);\n");
  assert.equal(expandPermuterPragmas("int f(void);\n"), "int f(void);\n");
});

test("an unbuilt project object is unknown, not a verdict", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  const plan = resolvePlan(project.root, project.options);
  const outDir = path.join(plan.output_dir, "f");
  fs.mkdirSync(outDir, { recursive: true });
  const fidelity = await checkScratchFidelity(plan, project.item, path.join(outDir, "scratch"), outDir, { mode: "configured", runner: project.run });
  assert.equal(fidelity.status, FIDELITY_UNKNOWN);
  assert.equal(fidelity.summary, "unknown");
  assert.ok(fidelity.reason.includes("is not built"));
  assert.equal(fidelity.object, OBJECT);
}));

test("an identical scratch object is the transferable one", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  project.buildTheObject();
  const { fidelity } = await prepareScratch(resolvePlan(project.root, project.options), project.item, { runner: project.run, fidelity_checker: comparingWith(fakeComparison(0)) });
  assert.equal(fidelity.status, FIDELITY_IDENTICAL);
  assert.equal(fidelity.summary, "identical");
  assert.equal(fidelityWarning(fidelity, "f"), null);
}));

test("a differing scratch counts its words and is loud", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  project.buildTheObject();
  const { fidelity } = await prepareScratch(resolvePlan(project.root, project.options), project.item, { runner: project.run, fidelity_checker: comparingWith(fakeComparison(4)) });
  assert.equal(fidelity.status, FIDELITY_DIFFERS);
  assert.equal(fidelity.summary, "differs(4 words)");
  assert.ok(fidelityWarning(fidelity, "f").includes("does not have to transfer"));
}));

test("the base is compiled through the scratch's own compile script", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  project.buildTheObject();
  await prepareScratch(resolvePlan(project.root, project.options), project.item, { runner: project.run, fidelity_checker: comparingWith(fakeComparison(0)) });
  const compiles = project.commands.filter((a) => a[0].endsWith("compile.sh"));
  assert.equal(compiles.length, 1);
  assert.ok(compiles[0][0].endsWith("scratch/compile.sh"));
  assert.ok(compiles[0][1].endsWith("fidelity-base.c"));
}));

test("the fidelity check can be switched off entirely", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  project.buildTheObject();
  const { fidelity } = await prepareScratch(resolvePlan(project.root, project.options, { check_fidelity: false }), project.item, { runner: project.run });
  assert.equal(fidelity.status, FIDELITY_UNCHECKED);
  assert.deepEqual(project.commands.filter((a) => a[0].endsWith("compile.sh")), []);
}));

const MACROS = ["g[DS]P.*=void"];

test("the first identical mode wins and stops the search", () => withTemp(async (d) => {
  const checker = scriptedFidelity(new ScratchFidelity({ status: FIDELITY_DIFFERS, differing_words: 8 }), new ScratchFidelity({ status: FIDELITY_IDENTICAL, differing_words: 0 }));
  const project = new FakeProject(d, { preserve_macros: MACROS });
  const { fidelity } = await prepareScratch(resolvePlan(project.root, project.options), project.item, { runner: project.run, fidelity_checker: checker });
  assert.deepEqual(checker.modes, ["configured", "none"]);
  assert.deepEqual(project.imports, [null, ""]);
  assert.equal(fidelity.status, FIDELITY_IDENTICAL);
  assert.equal(fidelity.mode, "none");
  assert.deepEqual(fidelity.attempts.map((a) => a.mode), ["configured", "none"]);
}));

test("a difference no macro can explain is not re-imported", () => withTemp(async (d) => {
  const checker = scriptedFidelity(new ScratchFidelity({ status: FIDELITY_DIFFERS, differing_words: 8 }));
  const project = new FakeProject(d, { preserve_macros: MACROS });
  project.preserved_report = "no macros";
  const { fidelity } = await prepareScratch(resolvePlan(project.root, project.options), project.item, { runner: project.run, fidelity_checker: checker });
  assert.deepEqual(checker.modes, ["configured"]);
  assert.deepEqual(project.imports, [null]);
  assert.equal(fidelity.status, FIDELITY_DIFFERS);
}));

test("an import log that says nothing still earns the fallback", () => withTemp(async (d) => {
  const checker = scriptedFidelity(new ScratchFidelity({ status: FIDELITY_DIFFERS, differing_words: 8 }), new ScratchFidelity({ status: FIDELITY_IDENTICAL, differing_words: 0 }));
  const project = new FakeProject(d, { preserve_macros: MACROS });
  project.preserved_report = null;
  const { fidelity } = await prepareScratch(resolvePlan(project.root, project.options), project.item, { runner: project.run, fidelity_checker: checker });
  assert.deepEqual(checker.modes, ["configured", "none"]);
  assert.equal(fidelity.status, FIDELITY_IDENTICAL);
  assert.equal(fidelity.attempts[0].preserved_macros, null);
}));

test("with no identical mode the smallest difference is kept", () => withTemp(async (d) => {
  const checker = scriptedFidelity(new ScratchFidelity({ status: FIDELITY_DIFFERS, differing_words: 2 }), new ScratchFidelity({ status: FIDELITY_DIFFERS, differing_words: 7 }));
  const project = new FakeProject(d, { preserve_macros: MACROS });
  const { fidelity } = await prepareScratch(resolvePlan(project.root, project.options), project.item, { runner: project.run, fidelity_checker: checker });
  assert.deepEqual(checker.modes, ["configured", "none"]);
  assert.deepEqual(project.imports, [null, "", null]);
  assert.equal(fidelity.mode, "configured");
  assert.equal(fidelity.differing_words, 2);
  assert.equal(fidelity.attempts.length, 2);
}));

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

const ticking = (...values) => { const it = values[Symbol.iterator](); return () => it.next().value; };

test("one function is searched and recorded", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  const result = await searchFunction(resolvePlan(project.root, project.options, { minutes: 1 }), project.item, { runner: project.run });
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.base_score, 214);
  assert.equal(result.best_score, 9);
  assert.equal(result.zero_found, false);
  assert.equal(result.flags_recovered, true);
  assert.equal(result.replicated_objcopy, 2);
}));

test("a zero score is reported but never promoted", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  project.outputs = ["output-0-win"];
  const results = await runSweep(resolvePlan(project.root, project.options, { minutes: 1 }), [project.item], { runner: project.run });
  assert.equal(results[0].zero_found, true);
  assert.ok(!("promoted" in results[0].asDict()));
  assert.equal(sweepPayload(results, { final: true }).totals.zero_found, 1);
}));

test("the record says where in the window the best result landed", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  const result = await searchFunction(resolvePlan(project.root, project.options, { minutes: 1 }), project.item, { runner: project.run, clock: ticking(0.0, 0.0, 60.0, 60.0) });
  assert.equal(result.window_seconds, 60.0);
  assert.equal(result.hit_cap, true);
  assert.ok(result.best_output_mtime_fraction > 0.9);
  assert.equal(classifyRow(result.asDict()).wall_class, P_STUCK_DESCENDING);
}));

test("a search that stopped early did not hit its cap", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  project.outputs = ["output-0-win"];
  const result = await searchFunction(resolvePlan(project.root, project.options, { minutes: 20 }), project.item, { runner: project.run, clock: ticking(0.0, 0.0, 75.0, 75.0) });
  assert.equal(result.hit_cap, false);
  assert.equal(result.window_seconds, 1200.0);
  assert.equal(classifyRow(result.asDict()).wall_class, MATCHED);
}));

test("a preparation failure records the error and keeps going", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  project.import_fails = true;
  const results = await runSweep(resolvePlan(project.root, project.options, { minutes: 1 }), [project.item, project.item], { runner: project.run });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.error));
}));

test("concurrent jobs search every function", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  const items = ["f", "f"].map(() => project.item);
  const seen = [];
  const results = await runSweep(resolvePlan(project.root, project.options, { minutes: 1, jobs: 2 }), items, { runner: project.run, on_result: (r) => seen.push(r.length) });
  assert.equal(results.length, 2);
  assert.deepEqual(seen, [1, 2]);
}));

test("a search records the fidelity and warns about a difference", () => withTemp(async (d) => {
  const checker = scriptedFidelity(new ScratchFidelity({ status: FIDELITY_DIFFERS, differing_words: 6 }));
  const project = new FakeProject(d);
  project.preserved_report = "no macros";
  const messages = [];
  const result = await searchFunction(resolvePlan(project.root, project.options), project.item, { runner: project.run, report: (m) => messages.push(m), fidelity_checker: checker });
  assert.equal(result.ok, true);
  assert.equal(result.scratch_fidelity, FIDELITY_DIFFERS);
  assert.equal(result.scratch_fidelity_words, 6);
  assert.equal(result.scratch_fidelity_mode, "configured");
  assert.ok(messages.some((l) => l.includes("does not have to transfer")));
  assert.equal(result.base_score, 214);
}));

test("--require-fidelity refuses before the window is spent", () => withTemp(async (d) => {
  const checker = scriptedFidelity(new ScratchFidelity({ status: FIDELITY_DIFFERS, differing_words: 6 }));
  const project = new FakeProject(d);
  project.preserved_report = "no macros";
  const result = await searchFunction(resolvePlan(project.root, project.options, { require_fidelity: true }), project.item, { runner: project.run, fidelity_checker: checker });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("--require-fidelity"));
  assert.ok(result.error.includes("differs(6 words)"));
  assert.deepEqual(project.commands.filter((a) => a.some((p) => String(p).endsWith("permuter.mjs"))), []);
}));

test("the summary row and the table carry the verdict", () => {
  const results = [new SweepResult({ function: "clean", source: "a.c", ok: true, scratch_fidelity: FIDELITY_IDENTICAL, scratch_fidelity_words: 0 }),
    new SweepResult({ function: "dirty", source: "b.c", ok: true, scratch_fidelity: FIDELITY_DIFFERS, scratch_fidelity_words: 8 })];
  const payload = sweepPayload(results, { final: true });
  const table = renderTable(results).join("\n");
  assert.equal(payload.totals.scratch_differs, 1);
  assert.equal(payload.results[0].scratch_fidelity, FIDELITY_IDENTICAL);
  for (const s of ["scratch", "identical", "DIFFERS/8", "1 on a scratch that is not the real object"]) assert.ok(table.includes(s), s);
});

// ---------------------------------------------------------------------------
// Process ownership and bounded preparation
// ---------------------------------------------------------------------------

test("a timeout ends the whole process group", { skip: process.platform === "win32" }, () => withTemp(async (d) => {
  const marker = path.join(d, "child.pid");
  const script = `const { spawn } = require("node:child_process"); const c = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(c.pid)); setTimeout(()=>{}, 60000);`;
  await assert.rejects(runOwned([process.execPath, "-e", script], { cwd: d, stdout: "devnull", stderr: "devnull", timeout: 3.0 }), (e) => e instanceof TimeoutExpired);
  const pid = Number(fs.readFileSync(marker, "utf8"));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 50));
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
  assert.fail(`grandchild ${pid} outlived the timeout`);
}));

test("the permuter run is bounded and logged", () => withTemp(async (d) => {
  const project = new FakeProject(path.join(d, "project"));
  const plan = resolvePlan(project.root, project.options);
  const calls = [];
  const runner = (argv, kw) => { calls.push(kw.timeout); return project.run(argv, kw); };
  fs.mkdirSync(path.join(d, "scratch"));
  const [score, elapsed] = await runPermuter(plan, path.join(d, "scratch"), d, { seconds: 90.0, runner, clock: ticking(0.0, 12.0) });
  assert.deepEqual(calls, [90.0]);
  assert.equal(score, 214);
  assert.equal(elapsed, 12.0);
}));

test("every preparation child is given the step timeout", () => withTemp(async (d) => {
  const project = new FakeProject(path.join(d, "project"));
  project.buildTheObject();
  const plan = resolvePlan(project.root, project.options);
  const timeouts = [];
  const runner = (argv, kw) => { timeouts.push(kw.timeout); return project.run(argv, kw); };
  await prepareScratch(plan, project.item, { runner, fidelity_checker: (p, i, s, o, opts) => checkScratchFidelity(p, i, s, o, { ...opts, compare: () => fakeComparison(0) }) });
  assert.ok(timeouts.length);
  assert.deepEqual([...new Set(timeouts)], [plan.step_timeout]);
  assert.equal(plan.step_timeout, 600.0);
}));

test("a hung importer names the key that bounds it and keeps the partial log", () => withTemp(async (d) => {
  const project = new FakeProject(path.join(d, "project"));
  project.step_timeout_seconds = 30.0;
  const plan = resolvePlan(project.root, project.options);
  const outDir = path.join(plan.output_dir, "f");
  fs.mkdirSync(outDir, { recursive: true });
  const runner = async (argv) => { throw new TimeoutExpired(argv, 30.0, "half a log\n"); };
  await assert.rejects(importScratch(plan, project.item, outDir, path.join(outDir, "settings.toml"), path.join(outDir, "target.s"), { runner }),
    (e) => e instanceof PermuterError && e.message.includes("30s") && e.message.includes("step_timeout_seconds"));
  assert.equal(fs.readFileSync(path.join(outDir, "import.log"), "utf8"), "half a log\n");
}));

test("a hung fidelity compile is an unknown verdict, not a hang", () => withTemp(async (d) => {
  const project = new FakeProject(path.join(d, "project"));
  project.buildTheObject();
  project.step_timeout_seconds = 5.0;
  const plan = resolvePlan(project.root, project.options);
  const outDir = path.join(plan.output_dir, "f");
  const scratch = path.join(outDir, "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, "base.c"), "int f(void) { return 0; }\n");
  fs.writeFileSync(path.join(scratch, "compile.sh"), '#!/bin/sh\ncc "$1"\n');
  const runner = async (argv) => { throw new TimeoutExpired(argv, 5.0); };
  await assert.rejects(compileScratchBase(plan, scratch, outDir, { runner }), (e) => e.message.includes("step_timeout_seconds"));
  const fidelity = await checkScratchFidelity(plan, project.item, scratch, outDir, { mode: "configured", runner });
  assert.equal(fidelity.status, FIDELITY_UNKNOWN);
  assert.ok(fidelity.reason.includes("step_timeout_seconds"));
}));

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

test("a healthy function is ready", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  const report = await doctor(resolvePlan(project.root, project.options), project.item, { seconds: 60, runner: project.run });
  assert.equal(report.ok, true);
  assert.deepEqual(report.flags.slice(0, 2), ["-O2", "-mips2"]);
  assert.equal(report.replicated.length, 2);
  assert.equal(report.base_score, 214);
  assert.equal(report.base_compiles, true);
  assert.ok(renderDoctor(report).at(-1).includes("ready"));
}));

test("a base that already scores zero is not scoring this function", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  project.base_score = 0;
  const report = await doctor(resolvePlan(project.root, project.options), project.item, { seconds: 60, runner: project.run });
  assert.equal(report.ok, false);
  assert.ok(report.problems[0].includes("not scoring the function under test"));
}));

test("the doctor reports the scratch object verdict; --require-fidelity makes it a problem", () => withTemp(async (d) => {
  const checker = () => scriptedFidelity(new ScratchFidelity({ status: FIDELITY_DIFFERS, differing_words: 3 }));
  const project = new FakeProject(d);
  project.preserved_report = "no macros";
  const report = await doctor(resolvePlan(project.root, project.options), project.item, { seconds: 60, runner: project.run, fidelity_checker: checker() });
  const rendered = renderDoctor(report).join("\n");
  assert.equal(report.fidelity.status, FIDELITY_DIFFERS);
  assert.ok(rendered.includes("scratch object  differs(3 words) [configured]"));
  assert.ok(rendered.includes("mode          configured: differs"));
  assert.equal(report.ok, true);
  assert.ok(rendered.split("\n").at(-1).includes("ready"));
  const strict = await doctor(resolvePlan(project.root, project.options, { require_fidelity: true }), project.item, { seconds: 60, runner: project.run, fidelity_checker: checker() });
  assert.equal(strict.ok, false);
  assert.ok(strict.problems[0].includes("not the object the build produces"));
}));

test("unrecovered flags are a problem, not a footnote", () => withTemp(async (d) => {
  const project = new FakeProject(d, { dry_run: "" });
  const report = await doctor(resolvePlan(project.root, project.options), project.item, { check_base: false, runner: project.run });
  assert.equal(report.ok, false);
  assert.ok(report.problems[0].includes("codegen flags were not recovered"));
  assert.ok(renderDoctor(report).at(-1).includes("NOT READY"));
}));

const placeholderTarget = (d, extra = null) => {
  const target = path.join(d, "target.o");
  const symbols = [{ name: "f_asm", value: 0, size: 8, kind: STT_FUNC, binding: STB_GLOBAL, section: ".text" }];
  if (extra) symbols.push({ name: extra });
  fs.writeFileSync(target, buildRelocatable({ ".text": words(0x0C000000, 0) }, symbols, [{ section: ".text", offset: 0, symbol: extra ?? "f_asm", type: R_MIPS_26 }]));
  return target;
};

test("a target whose calls are placeholders routes to linked-compare", { skip: !hasRelocSurface && "reloc-surface.js (placeholder_call_check) is ported by another fork and is not present yet" }, () => withTemp(async (d) => {
  const project = new FakeProject(d);
  const report = await doctor(resolvePlan(project.root, project.options), project.item, { seconds: 60, runner: project.run, target_object: placeholderTarget(d) });
  const rendered = renderDoctor(report).join("\n");
  assert.ok(report.placeholder);
  assert.equal(report.placeholder.blocked, true);
  assert.ok(rendered.includes("linked-compare"));
  assert.ok(rendered.includes("target calls    1 R_MIPS_26 site(s)"));
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((w) => w.includes("cannot reach zero")));
  const payload = JSON.parse(JSON.stringify(report.asDict()));
  assert.equal(payload.placeholder_calls.call_sites, 1);
  assert.equal(payload.placeholder_calls.blocked, true);
  assert.deepEqual(payload.placeholder_calls.self_named, ["f_asm"]);
}));

test("an ordinary call the candidate names leaves the score usable", { skip: !hasRelocSurface && "reloc-surface.js is not present yet" }, () => withTemp(async (d) => {
  const project = new FakeProject(d);
  const target = placeholderTarget(d, "ordinaryCallee");
  const candidate = path.join(d, "candidate.o");
  fs.copyFileSync(target, candidate);
  const report = await doctor(resolvePlan(project.root, project.options), project.item, { seconds: 60, runner: project.run, target_object: target, candidate_object: candidate });
  assert.equal(report.placeholder.blocked, false);
  assert.ok(!renderDoctor(report).join("\n").includes("linked-compare"));
}));

test("without a target object, or with an unreadable one, the question is not answered", () => withTemp(async (d) => {
  const project = new FakeProject(d);
  const plan = resolvePlan(project.root, project.options);
  const report = await doctor(plan, project.item, { seconds: 60, runner: project.run });
  assert.equal(report.placeholder, null);
  assert.equal(report.asDict().placeholder_calls, null);
  assert.ok(!renderDoctor(report).join("\n").includes("target calls"));
  const junk = path.join(d, "not-an-object.o");
  fs.writeFileSync(junk, "not an ELF at all");
  assert.equal((await doctor(plan, project.item, { seconds: 60, runner: project.run, target_object: junk })).placeholder, null);
}));

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

const row = (o = {}) => ({ function: "func_80012574", source: "src/game/track.c", ok: true, base_score: 40, best_score: 30, extended: false, flags_recovered: true,
  hit_cap: true, seconds: 1200.0, window_seconds: 1200.0, best_output_mtime_fraction: 0.9, error: null, ...o });

test("classification follows the measurements", () => {
  let r = classifyRow(row({ best_score: 0 }));
  assert.equal(r.wall_class, MATCHED); assert.equal(r.delta, 40); assert.ok(r.reason.includes("real build has not confirmed"));
  r = classifyRow(row({ best_output_mtime_fraction: 0.9 }));
  assert.equal(r.wall_class, P_STUCK_DESCENDING); assert.equal(r.delta, 10);
  r = classifyRow(row({ extended: true, best_output_mtime_fraction: 0.1 }));
  assert.equal(r.wall_class, P_STUCK_DESCENDING); assert.ok(r.reason.includes("earned its extension"));
  r = classifyRow(row({ best_output_mtime_fraction: 0.1 }));
  assert.equal(r.wall_class, P_STUCK_FLAT); assert.ok(r.reason.includes("10%"));
  const never = classifyRow(row({ best_score: null, best_output_mtime_fraction: null }));
  assert.equal(never.wall_class, P_STUCK_FLAT); assert.equal(never.delta, 0);
  assert.equal(classifyRow(row({ best_score: 44 })).wall_class, P_STUCK_FLAT);
  const failed = classifyRow(row({ ok: false, base_score: null, error: "the importer failed" }));
  assert.equal(failed.wall_class, IMPORT_FAULT); assert.ok(failed.reason.includes("the importer failed")); assert.equal(failed.delta, null);
  assert.equal(classifyRow(row({ base_score: null })).wall_class, IMPORT_FAULT);
  assert.equal(classifyRow(row({ best_score: 0, error: "the run was killed" })).wall_class, IMPORT_FAULT);
  r = classifyRow(row({ best_output_mtime_fraction: null }));
  assert.equal(r.wall_class, P_STUCK_DESCENDING); assert.ok(r.reason.includes("does not record when"));
});

test("summaries, payload totals and the pasteable table", () => {
  assert.equal(classifySummary({ results: [row({ function: "a" }), row({ function: "b", best_score: 0 })] }).length, 2);
  assert.equal(classifySummary([row(), row()]).length, 2);
  assert.throws(() => classifySummary({ results: 3 }), { name: "ValueError" });
  const payload = classifyPayload([classifyRow(row({ best_score: 0 })), classifyRow(row())], { source: "summary.json" });
  assert.equal(payload.schema, CLASSIFY_SCHEMA);
  assert.deepEqual(payload.totals, { [MATCHED]: 1, [P_STUCK_DESCENDING]: 1, [P_STUCK_FLAT]: 0, [IMPORT_FAULT]: 0 });
  assert.ok(MATCHED in payload.routing);
  assert.equal(payload.functions[0].class, MATCHED);
  const text = renderMarkdown([classifyRow(row({ function: "wrong_isa", flags_recovered: false })),
    classifyRow(row({ function: "broken", ok: false, base_score: null, flags_recovered: false, error: "the importer failed" }))]).join("\n");
  assert.ok(text.split("fallback flags")[1].includes("`wrong_isa`"));
  assert.ok(!text.split("fallback flags")[1].includes("`broken`"));
  const lines = renderMarkdown([classifyRow(row())], { source: "summary.json" });
  assert.equal(lines[0], "Sweep: `summary.json`");
  assert.ok(lines[2].startsWith("| function | class |"));
  assert.ok(lines.some((l) => l.includes("P_STUCK_DESCENDING")));
  assert.ok(lines.some((l) => l.startsWith("| class |")));
});

test("the output fraction places the best candidate in the window", () => {
  assert.equal(outputFraction({ elapsed: 1200.0, best_age: 0.0 }), 1.0);
  assert.equal(outputFraction({ elapsed: 1200.0, best_age: 1200.0 }), 0.0);
  assert.ok(Math.abs(outputFraction({ elapsed: 1200.0, best_age: 300.0 }) - 0.75) < 1e-9);
  assert.equal(outputFraction({ elapsed: 1200.0, best_age: null }), null);
  assert.equal(outputFraction({ elapsed: 0.0, best_age: 1.0 }), null);
  assert.equal(outputFraction({ elapsed: 10.0, best_age: -5.0 }), 1.0);
  assert.equal(outputFraction({ elapsed: 10.0, best_age: 99.0 }), 0.0);
});

test("the shipped summary fixture classifies every class, by either spelling", async () => {
  const r = await runCommand(["permute-classify", SUMMARY_FIXTURE, "--json"]);
  const payload = JSON.parse(r.stdout);
  assert.deepEqual([r.code, r.stderr], [0, ""]);
  assert.equal(payload.schema, CLASSIFY_SCHEMA);
  assert.deepEqual(payload.totals, { [MATCHED]: 1, [P_STUCK_DESCENDING]: 1, [P_STUCK_FLAT]: 2, [IMPORT_FAULT]: 1 });
  const one = await runCommand(["permute", "classify", SUMMARY_FIXTURE, "--class", P_STUCK_FLAT]);
  assert.equal(one.code, 0);
  assert.ok(one.stdout.includes("synth_plateaued"));
  assert.ok(!one.stdout.includes("synth_still_descending"));
  await withTemp(async (d) => {
    const missing = await runCommand(["permute-classify", path.join(d, "absent.json")]);
    assert.equal(missing.code, 2);
    assert.ok(missing.stderr.startsWith("error: "));
  });
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function writeProject(root) {
  fs.writeFileSync(path.join(root, ".decomp-workbench.toml"), "[project]\nname = 'example'\n\n[permuter]\nmake = 'gmake'\npermuter_dir = 'permuter'\n"
    + "compiler_command = 'tools/ido/cc -c -I include'\nassembler_command = 'as -march=vr4300'\ncompiler_marker = 'tools/ido/cc'\nminutes = 7\n"
    + "preserve_macros = ['g[DS]P.*=void']\n");
  const queue = path.join(root, "queue.json");
  fs.writeFileSync(queue, JSON.stringify([{ function: "far", source: "src/game/track.c" }, { function: "near", source: "src/game/track.c" }]));
  const ranking = path.join(root, "ranking.json");
  fs.writeFileSync(ranking, JSON.stringify({ functions: [{ name: "far", differing_words: 30 }, { name: "near", differing_words: 1 }] }));
  return [queue, ranking];
}

/** Run a permute command handler with a controllable git HEAD. */
async function runHandler(argv, { gitHead = null, cwd } = {}) {
  const spec = COMMAND_SPECS.find((s) => s.path.join(" ") === argv[0]);
  const args = parseArgs(spec, argv.slice(1), { prog: `decomp-workbench ${argv[0]}` });
  const out = [], err = [];
  const io = { print: (s = "") => out.push(`${s}\n`), eprint: (s = "") => err.push(`${s}\n`), write: (s) => out.push(s), ewrite: (s) => err.push(s) };
  const ctx = { cwd, env: process.env, resolve: (p) => path.resolve(cwd, p), ...(gitHead ? { gitHead: () => gitHead } : {}) };
  const status = await spec.handler(args, io, ctx);
  return [status, out.join(""), err.join("")];
}

const cliSkip = !hasProjectConfig && "project-config.js (the [permuter] table reader) is ported by another fork and is not present yet";

test("a dry run orders the queue and starts no process", { skip: cliSkip }, () => withTemp(async (root) => {
  const [queue, ranking] = writeProject(root);
  const [status, stdout, stderr] = await runHandler(["permute-sweep", queue, "--project", root, "--ranking", ranking, "--dry-run"], { cwd: root });
  assert.equal(status, 0);
  assert.equal(stderr, "");
  assert.ok(stdout.indexOf("near") < stdout.indexOf("far"));
  assert.ok(stdout.includes("7 min cap"));
}));

test("a cap of zero minutes is a usage error, not a default", async () => {
  for (const value of ["0", "-5"]) {
    const r = await runCommand(["permute-sweep", "queue.json", "--minutes", value, "--dry-run"]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("must be greater than 0"));
  }
});

test("a missing function row, and a doctor without --source, are usage errors", { skip: cliSkip }, () => withTemp(async (root) => {
  const [queue] = writeProject(root);
  let [status, , stderr] = await runHandler(["permute-doctor", "absent", "--project", root, "--queue", queue], { cwd: root });
  assert.equal(status, 2);
  assert.ok(stderr.includes("is not in"));
  [status, , stderr] = await runHandler(["permute-doctor", "f", "--project", root], { cwd: root });
  assert.equal(status, 2);
  assert.ok(stderr.includes("--source is required"));
}));

test("a stale ranking is loud but does not stop a sweep; --require-fresh refuses it", { skip: cliSkip }, () => withTemp(async (root) => {
  const [queue, ranking] = writeProject(root);
  stampRanking(ranking, "a".repeat(40));
  let [status, stdout, stderr] = await runHandler(["permute-sweep", queue, "--project", root, "--ranking", ranking, "--dry-run"], { cwd: root, gitHead: "b".repeat(40) });
  assert.equal(status, 0);
  assert.ok(stderr.includes("WARNING:"));
  assert.ok(stderr.includes("measurement of a different tree"));
  assert.ok(stdout.includes("near"));
  [status, stdout, stderr] = await runHandler(["permute-sweep", queue, "--project", root, "--ranking", ranking, "--require-fresh"], { cwd: root, gitHead: "b".repeat(40) });
  assert.equal(status, 2);
  assert.equal(stdout, "");
  assert.ok(stderr.includes("error:"));
  [status, stdout, stderr] = await runHandler(["permute-sweep", queue, "--project", root, "--ranking", ranking, "--require-fresh", "--dry-run"], { cwd: root, gitHead: "a".repeat(40) });
  assert.equal(status, 0);
  assert.equal(stderr, "");
}));

test("--require-fresh without a ranking says so; the doctor checks the configured ranking", { skip: cliSkip }, () => withTemp(async (root) => {
  const [queue, ranking] = writeProject(root);
  let [status, , stderr] = await runHandler(["permute-sweep", queue, "--project", root, "--require-fresh", "--dry-run"], { cwd: root });
  assert.equal(status, 2);
  assert.ok(stderr.includes("--require-fresh needs a ranking"));
  const config = path.join(root, ".decomp-workbench.toml");
  fs.appendFileSync(config, "ranking = 'ranking.json'\n");
  stampRanking(ranking, "a".repeat(40));
  [status, , stderr] = await runHandler(["permute-doctor", "far", "--project", root, "--queue", queue, "--require-fresh"], { cwd: root, gitHead: "b".repeat(40) });
  assert.equal(status, 2);
  assert.ok(stderr.includes("error:"));
}));

test("resume carries the done rows and retries the broken one", { skip: cliSkip }, () => withTemp(async (root) => {
  const [queue] = writeProject(root);
  const out = path.join(root, "out");
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(sweepPayload([new SweepResult({ function: "near", source: "a.c", ok: true }),
    new SweepResult({ function: "far", source: "b.c", error: "the importer failed" })], { final: true })));
  const [status, stdout] = await runHandler(["permute-sweep", queue, "--project", root, "--output-dir", out, "--resume", "--dry-run"], { cwd: root });
  assert.equal(status, 0);
  assert.ok(stdout.includes("skipping 1"));
  assert.ok(stdout.includes("far"));
  assert.ok(!stdout.split("queued function(s):")[1].includes("near"));
}));

test("a sweep or doctor with no permuter programs is a capability error, exit 2", { skip: cliSkip }, () => withTemp(async (root) => {
  const [queue] = writeProject(root);
  let [status, , stderr] = await runHandler(["permute-sweep", queue, "--project", root, "--output-dir", path.join(root, "out")], { cwd: root });
  assert.equal(status, 2);
  assert.ok(stderr.includes("import.mjs is not at"));
  fs.writeFileSync(path.join(root, "q.json"), JSON.stringify([{ function: "far", source: "src/game/track.c", asm: "a.s" }]));
  [status, , stderr] = await runHandler(["permute-doctor", "far", "--project", root, "--queue", path.join(root, "q.json")], { cwd: root });
  assert.equal(status, 2);
  assert.ok(stderr.includes("permuter_dir"));
}));

test("every spelling is registered and the group word lists its operations", async () => {
  for (const argv of [["permute-sweep", "--help"], ["permute", "sweep", "--help"], ["permute-doctor", "--help"], ["permute", "doctor", "--help"], ["permute-classify", "--help"], ["permute", "classify", "--help"]]) {
    const r = await runCommand(argv);
    assert.equal(r.code, 0, argv.join(" "));
    assert.ok(r.stdout.startsWith("usage:"), argv.join(" "));
  }
  const listing = await runCommand(["permute"]);
  assert.equal(listing.code, 0);
  assert.ok(listing.stdout.includes("sweep") && listing.stdout.includes("classify"));
});
