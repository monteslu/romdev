// Campaign engine, process ownership, and the persistent campaign cockpit.
// Ported from the workbench's test_campaign, test_campaign_lifecycle and
// test_campaign_state; fake compilers and objdumps are node scripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync, chmodSync } from "node:fs";
import path from "node:path";
import { campaignResultSortKey, candidateKey, executableIdentity, groupObjectBasins, prepareCandidates, renderCompileCommand, runCampaign,
  runCompiler, terminateRunningCompilers } from "../src/decomp/workbench/campaign.js";
import { effectiveRankBy, recordKey, homologousGuidance, boundedExportStatus, findManifest } from "../src/decomp/workbench/campaign-state.js";
import { parseEnvironment, resolveCompilerEnvironment } from "../src/decomp/workbench/environment.js";
import { compareInstructions } from "../src/decomp/workbench/compare.js";
import { CompileResult } from "../src/decomp/workbench/model.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { sorted } from "../src/decomp/workbench/py.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { NODE, withTemp, writeCompiler, template, writeObjdump, writeCountingObjdump } from "./fixtures/workbench/campaign-tools.js";

const lines = (p) => readFileSync(p, "utf8").split("\n").filter((l) => l.length);

// test_campaign.py

test("temp-prefix ranking preserves later progress over word score", () => {
  const target = parseDisassembly("  0: 8e0e0000 lw t6,0(s0)\n  4: 8e0f0004 lw t7,4(s0)\n  8: 8e180008 lw t8,8(s0)\n  c: 8e19000c lw t9,12(s0)\n");
  const early = compareInstructions(target, parseDisassembly("  0: 8e080000 lw t0,0(s0)\n  4: 8e0f0004 lw t7,4(s0)\n  8: 8e180008 lw t8,8(s0)\n  c: 8e19000c lw t9,12(s0)\n"),
    { target_name: "target", candidate_name: "early", symbol: null });
  const later = compareInstructions(target, parseDisassembly("  0: 8e0e0000 lw t6,0(s0)\n  4: 8e0f0004 lw t7,4(s0)\n  8: 8e080008 lw t0,8(s0)\n  c: 8e09000c lw t1,12(s0)\n"),
    { target_name: "target", candidate_name: "later", symbol: null });
  const mk = (source, comparison) => new CompileResult({ source, command: [], returncode: 0, stdout: "", stderr: "", object_path: null, comparison });
  assert.ok(early.word_mismatches < later.word_mismatches);
  assert.notEqual(early.temp_prefix_exact, null);
  assert.notEqual(later.temp_prefix_exact, null);
  assert.ok((early.temp_prefix_exact || 0) < (later.temp_prefix_exact || 0));
  const ordered = sorted([mk("early.c", early), mk("later.c", later)], (r) => campaignResultSortKey(r, { rank_by: "temp-prefix" }));
  assert.equal(ordered[0].source, "later.c");
});

test("compiler identity resolves a relative executable", async () => {
  await withTemp((temp) => {
    const executable = path.join(temp, "compiler");
    writeFileSync(executable, "#!/bin/sh\n");
    chmodSync(executable, 0o755);
    const relative = path.relative(process.cwd(), executable);
    const identity = executableIdentity([relative]);
    assert.equal(identity.resolved, executable);
    assert.notEqual(identity.sha256, null);
  });
});

test("render command does not use a shell and requires both placeholders", () => {
  assert.deepEqual(renderCompileCommand("./compile.sh --input {source} --output {output}", "/tmp/a source.c", "/tmp/a.o"),
    ["./compile.sh", "--input", "/tmp/a source.c", "--output", "/tmp/a.o"]);
  assert.throws(() => renderCompileCommand("cc {source}", "a.c", "a.o"), /\{output\}/);
});

test("candidate key tracks source, environment, frontend cell and working directory", async () => {
  await withTemp((root) => {
    const source = path.join(root, "candidate.c"), target = path.join(root, "target.o"), compiler = path.join(root, "compiler");
    writeFileSync(source, "int value = 1;\n"); writeFileSync(target, "target"); writeFileSync(compiler, "#!/bin/sh\n");
    const command = [compiler, source, "{cache_object}"];
    const key = (env, extra = {}) => candidateKey(source, { command, target, symbol: "demo", environment: env, ...extra });
    const first = key({ MODE: "one" });
    assert.notEqual(first, key({ MODE: "two" }));
    writeFileSync(source, "int value = 2;\n");
    assert.notEqual(first, key({ MODE: "one" }));
    const legacy = key({}, { compilation_envelope: { frontend: "IRIX 4.x accom", backend: "IDO 5.3 ugen" } });
    const later = key({}, { compilation_envelope: { frontend: "IDO 5.3 cfe", backend: "IDO 5.3 ugen" } });
    assert.notEqual(legacy, later);
    assert.equal(key({}), key({}, { compilation_envelope: {} }));
    mkdirSync(path.join(root, "first")); mkdirSync(path.join(root, "second"));
    const cwdKey = (d) => candidateKey(source, { command: ["./compile", source, "{cache_object}"], target, symbol: null, environment: {}, compile_cwd: path.join(root, d) });
    assert.notEqual(cwdKey("first"), cwdKey("second"));
  });
});

test("candidate keys are path sensitive", async () => {
  await withTemp((root) => {
    const target = path.join(root, "target.o");
    writeFileSync(target, "target");
    const first = path.join(root, "first.c"), second = path.join(root, "second.c");
    writeFileSync(first, "int same;\n"); writeFileSync(second, "int same;\n");
    const [candidates, duplicates] = prepareCandidates([first, second], { template: "cc {source} -o {output}", target, symbol: null, environment: {} });
    assert.equal(candidates.length, 2);
    assert.equal(Object.keys(duplicates).length, 2);
  });
});

test("campaign caches and records provenance", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "target.o"); writeFileSync(target, "target");
    const source = path.join(root, "candidate.c"); writeFileSync(source, "int candidate;\n");
    const compiler = writeCompiler(root);
    const objdump = writeObjdump(root);
    const ledger = path.join(root, "ledger.jsonl");
    const args = { target, template: template(compiler), cache_dir: path.join(root, "cache"), ledger, objdump, symbol: "demo", section: ".text" };
    const [first] = await runCampaign([source], args);
    const [second] = await runCampaign([source], args);
    assert.equal(first[0].comparison.exact, true);
    assert.equal(first[0].cached, false);
    assert.equal(second[0].cached, true);
    const records = lines(ledger).map((l) => JSON.parse(l));
    assert.equal(records.length, 2);
    assert.equal(records[0].provenance.source_sha256, records[1].provenance.source_sha256);
    assert.equal(records[0].provenance.section, ".text");
    assert.equal(records[0].provenance.objdump.resolved, objdump);
    assert.equal(records[0].provenance.compile_cwd, process.cwd());
    assert.equal(records[0].execution.timeout_seconds, 120.0);
    assert.equal(records[0].redaction.schema, "decomp-workbench-ledger-redaction-v1");
  });
});

test("campaign uses an explicit compiler working directory", async () => {
  await withTemp(async (root) => {
    const project = path.join(root, "project"); mkdirSync(project);
    writeFileSync(path.join(project, "required.txt"), "present");
    const source = path.join(root, "candidate.c"), target = path.join(root, "target.o");
    writeFileSync(source, "int candidate;\n"); writeFileSync(target, "target");
    const compiler = writeCompiler(root, "if (!fs.existsSync('required.txt')) process.exit(3);\nfs.writeFileSync(out, fs.readFileSync(src));");
    const [results] = await runCampaign([source], { target, template: template(compiler), cache_dir: path.join(root, "cache"), objdump: writeObjdump(root), symbol: "demo", compile_cwd: project });
    assert.notEqual(results[0].comparison, null);
  });
});

test("distinct sources that compile to one object form one basin", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "target.o"); writeFileSync(target, "target");
    const first = path.join(root, "first.c"), second = path.join(root, "second.c");
    writeFileSync(first, "int first;\n"); writeFileSync(second, "int second;\n");
    const compiler = writeCompiler(root, "fs.writeFileSync(out, 'constant object');");
    const [results] = await runCampaign([first, second], { target, template: template(compiler), cache_dir: path.join(root, "cache"), objdump: writeObjdump(root), symbol: "demo", stop_on_exact: false });
    let basins = groupObjectBasins(results);
    assert.equal(basins.length, 1);
    assert.deepEqual(basins[0].map((i) => i.source), [first, second]);
    results[0].comparison.word_mismatches = 5;
    results[1].comparison.word_mismatches = 0;
    basins = groupObjectBasins(results);
    assert.equal(basins[0][0], results[1]);
  });
});

test("the target is disassembled once for the whole campaign", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "target.o"); writeFileSync(target, "target");
    const counter = path.join(root, "objdump-runs.txt");
    const objdump = writeCountingObjdump(root, counter);
    const sources = [0, 1, 2].map((i) => { const s = path.join(root, `candidate${i}.c`); writeFileSync(s, `int candidate = ${i};\n`); return s; });
    const [results] = await runCampaign(sources, { target, template: template(writeCompiler(root)), cache_dir: path.join(root, "cache"), objdump, symbol: "demo", stop_on_exact: false });
    assert.equal(results.length, 3);
    assert.equal(lines(counter).length, 4);
  });
});

test("stop on exact leaves later candidates uncompiled; a sweep compiles them", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "target.o"); writeFileSync(target, "target");
    const objdump = writeCountingObjdump(root, path.join(root, "runs.txt"));
    const sources = [0, 1, 2].map((i) => { const s = path.join(root, `candidate${i}.c`); writeFileSync(s, `int candidate = ${i};\n`); return s; });
    const ledger = path.join(root, "ledger.jsonl");
    const args = { target, template: template(writeCompiler(root)), cache_dir: path.join(root, "cache"), objdump, symbol: "demo", jobs: 1, ledger };
    const [stopped] = await runCampaign(sources, { ...args, stop_on_exact: true });
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].comparison.exact, true);
    assert.equal(lines(ledger).length, 1);
    const [swept] = await runCampaign(sources, { ...args, stop_on_exact: false });
    assert.equal(swept.length, 3);
    assert.equal(lines(ledger).length, 4);
  });
});

test("stopping early keeps every candidate that actually ran", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "target.o"); writeFileSync(target, "target");
    const objdump = writeCountingObjdump(root, path.join(root, "runs.txt"));
    const compiler = writeCompiler(root, "await new Promise((r) => setTimeout(r, 300));\nfs.writeFileSync(out, 'object');");
    const sources = [0, 1, 2, 3, 4, 5].map((i) => { const s = path.join(root, `candidate${i}.c`); writeFileSync(s, `int value = ${i};\n`); return s; });
    const ledger = path.join(root, "ledger.jsonl");
    const [results] = await runCampaign(sources, { target, template: template(compiler), cache_dir: path.join(root, "cache"), objdump, symbol: "demo", jobs: 6, ledger, stop_on_exact: true });
    assert.equal(results.length, 6);
    assert.equal(lines(ledger).length, 6);
    assert.ok(results.every((i) => i.comparison !== null));
  });
});

test("one broken candidate does not end the campaign", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "target.o"); writeFileSync(target, "target");
    const objdump = path.join(root, "objdump");
    writeFileSync(objdump, `#!${NODE}\nimport fs from "node:fs";\nconst objects = process.argv.slice(2).filter((a) => a.endsWith(".o"));\n`
      + "const data = fs.readFileSync(objects.at(-1));\n"
      + "if (data.includes('poison')) { process.stdout.write(Buffer.from([0x30,0x3a,0x20,0x30,0x33,0x65,0x30,0x30,0x30,0x30,0x38,0x20,0xff,0xfe,0x0a])); process.exit(0); }\n"
      + "process.stdout.write('00000000 <demo>:\\n   0: 03e00008  jr $ra\\n   4: 00000000  nop\\n');\n");
    chmodSync(objdump, 0o755);
    const good = path.join(root, "good.c"), poisoned = path.join(root, "poison.c"), other = path.join(root, "other.c");
    writeFileSync(good, "int good;\n"); writeFileSync(poisoned, "int poison;\n"); writeFileSync(other, "int other;\n");
    const ledger = path.join(root, "ledger.jsonl");
    const [results] = await runCampaign([good, poisoned, other], { target, template: template(writeCompiler(root)), cache_dir: path.join(root, "cache"), objdump, symbol: "demo", jobs: 1, ledger, stop_on_exact: false });
    assert.equal(results.length, 3);
    assert.equal(lines(ledger).length, 3);
    const failed = results.filter((i) => i.comparison === null);
    assert.equal(failed.length, 1);
    assert.ok(failed[0].source.includes("poison"));
    assert.notEqual(failed[0].returncode, 0);
    assert.ok(failed[0].stderr);
  });
});

test("environment parsing, sealed compiler environment, inherited names", async () => {
  assert.deepEqual(parseEnvironment(["TRACE=1", "MODE=verbose"]), { TRACE: "1", MODE: "verbose" });
  assert.throws(() => parseEnvironment(["NOT-VALID=1"]), /invalid environment entry/);
  process.env.DECOMP_WORKBENCH_UNTRACKED_TEST_VALUE = "must-not-leak";
  try {
    const p = await runCompiler([NODE, "-e", "console.log(process.env.DECOMP_WORKBENCH_UNTRACKED_TEST_VALUE ?? 'sealed')"], { environment: {}, compile_cwd: process.cwd() });
    assert.equal(p.stdout.trim(), "sealed");
  } finally { delete process.env.DECOMP_WORKBENCH_UNTRACKED_TEST_VALUE; }
  assert.deepEqual(resolveCompilerEnvironment({ MODE: "explicit" }, ["PATH", "MODE"], { host: { PATH: "/controlled/bin", MODE: "host" } }), { MODE: "explicit", PATH: "/controlled/bin" });
  assert.throws(() => resolveCompilerEnvironment({}, ["ABSENT"], { host: {} }), /not set in the host environment/);
});

// test_campaign_lifecycle.py

const isRunning = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
async function waitUntil(pred, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return pred();
}
const SLOW = `import fs from "node:fs";\nimport { spawn } from "node:child_process";\nconst child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], { stdio: "ignore" });\nfs.writeFileSync(process.argv[2], child.pid + "\\n");\nsetTimeout(() => {}, 30000);\n`;
const STUBBORN = `import fs from "node:fs";\nprocess.on("SIGTERM", () => {});\nfs.writeFileSync(process.argv[2], "ready\\n");\nsetTimeout(() => {}, 30000);\n`;

test("a compiler that ignores SIGTERM is still ended", async () => {
  await withTemp(async (root) => {
    const compiler = path.join(root, "stubborn.mjs"); writeFileSync(compiler, STUBBORN);
    const ready = path.join(root, "ready");
    const running = runCompiler([NODE, compiler, ready], { environment: {}, compile_cwd: root });
    assert.ok(await waitUntil(() => existsSync(ready)));
    const start = Date.now();
    await terminateRunningCompilers();
    const completed = await running;
    assert.equal(completed.returncode, -9);
    assert.ok(Date.now() - start < 15_000);
  });
});

test("compilers run in their own process group", async () => {
  const completed = await runCompiler(["/bin/sh", "-c", "ps -o pgid= -p $$"], { environment: {}, compile_cwd: process.cwd() });
  assert.equal(completed.returncode, 0);
  const mine = (await runCompiler(["/bin/sh", "-c", `ps -o pgid= -p ${process.pid}`], { environment: {}, compile_cwd: process.cwd() })).stdout.trim();
  assert.notEqual(completed.stdout.trim(), mine);
});

test("terminating the campaign ends spawned tools", async () => {
  await withTemp(async (root) => {
    const compiler = path.join(root, "slow.mjs"); writeFileSync(compiler, SLOW);
    const pidFile = path.join(root, "child.pid");
    const running = runCompiler([NODE, compiler, pidFile], { environment: {}, compile_cwd: root });
    assert.ok(await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0), "the fake compiler never started its child");
    const childPid = parseInt(readFileSync(pidFile, "utf8"), 10);
    assert.ok(isRunning(childPid));
    await terminateRunningCompilers();
    const completed = await running;
    assert.notEqual(completed.returncode, 0);
    assert.ok(await waitUntil(() => !isRunning(childPid)), "a tool spawned by the compiler outlived the campaign");
  });
});

test("timeout ends the compiler and every spawned tool", async () => {
  await withTemp(async (root) => {
    const compiler = path.join(root, "slow.mjs"); writeFileSync(compiler, SLOW);
    const pidFile = path.join(root, "child.pid");
    await assert.rejects(runCompiler([NODE, compiler, pidFile], { environment: {}, compile_cwd: root, timeout: 0.5 }), /--timeout=0\.5 seconds/);
    assert.ok(existsSync(pidFile));
    const childPid = parseInt(readFileSync(pidFile, "utf8"), 10);
    assert.ok(await waitUntil(() => !isRunning(childPid)), "a tool spawned by a timed-out compiler outlived the command");
  });
});

// Skipped from test_campaign_lifecycle: test_process_group_arguments_are_platform_appropriate
// (a subprocess keyword table with no node equivalent; the group itself is
// tested above) and test_a_failing_campaign_terminates_running_compilers (it
// patches a private function to raise KeyboardInterrupt inside the pool).

// test_campaign_state.py

test("persisted ranking uses words when every candidate has gaps", () => {
  const records = [
    { source: "misleading-aligned.c", signals: [], comparison: { alignment_comparable: false, aligned_total: 1, words: 90 } },
    { source: "actual-leader.c", signals: [], comparison: { alignment_comparable: false, aligned_total: 30, words: 10 } },
  ];
  const [rankedBy, unsafe] = effectiveRankBy(records, { requested: "auto" });
  const ordered = sorted(records, (r) => recordKey(r, { ranked_by: rankedBy }));
  assert.equal(rankedBy, "words");
  assert.equal(unsafe, true);
  assert.equal(ordered[0].source, "actual-leader.c");
});

test("mutating selection refuses to guess between campaigns", async () => {
  await withTemp((state) => {
    for (const name of ["first", "second"]) {
      mkdirSync(path.join(state, "campaigns", name), { recursive: true });
      writeFileSync(path.join(state, "campaigns", name, "manifest.json"), "{}\n");
    }
    assert.throws(() => findManifest(null, { state_root: state, require_explicit_when_ambiguous: true }), /select one explicitly/);
  });
});

test("homologous guidance requires a measured single-parameter gain", () => {
  const manifest = { experiment: { homologous_parameters: [["first", "second", "third"]] } };
  const records = [
    { source: "base.c", experiment: { parameters: { first: false, second: false, third: false } }, comparison: { temp_prefix_exact: 700, words: 58 } },
    { source: "first.c", experiment: { parameters: { first: true, second: false, third: false } }, comparison: { temp_prefix_exact: 732, words: 379 } },
  ];
  const guidance = homologousGuidance(manifest, records);
  assert.equal(guidance.length, 2);
  assert.deepEqual(new Set(guidance.map((i) => i.sibling_parameter)), new Set(["second", "third"]));
  assert.ok(guidance.every((i) => i.prefix_before === 700 && i.prefix_after === 732));
});

async function cli(args) {
  const r = await runCommand(args);
  return [r.code, r.stdout, r.stderr];
}

async function startCampaign(root, { sources = null, extra = [] } = {}) {
  const target = path.join(root, "target.o");
  writeFileSync(target, "target");
  let list = sources;
  if (!list) { const s = path.join(root, "candidate.c"); writeFileSync(s, "int candidate;\n"); list = [s]; }
  const compiler = writeCompiler(root, "fs.writeFileSync(out, 'object');");
  const objdump = writeObjdump(root);
  const [code, stdout, stderr] = await cli(["campaign", target, ...list, "--compile-command", template(compiler), "--objdump", objdump, "--symbol", "demo",
    "--cache-dir", path.join(root, "cache"), "--state-dir", path.join(root, "state"), ...extra, "--json-summary"]);
  return { code, stdout, stderr, payload: JSON.parse(stdout), target };
}

test("campaign creates the default manifest, ledger and status", async () => {
  await withTemp(async (root) => {
    const { code, stderr, payload } = await startCampaign(root, { extra: ["--rank-by", "temp-prefix"] });
    assert.equal(code, 0, stderr);
    assert.equal(stderr, "");
    assert.ok(existsSync(payload.manifest));
    assert.ok(existsSync(payload.ledger));
    assert.equal(payload.ranked_by, "temp-prefix");
    assert.equal(payload.alignment_ranking_unsafe, false);
    assert.equal(JSON.parse(readFileSync(payload.manifest, "utf8")).execution.rank_by, "temp-prefix");
    const [status, stdout, err] = await cli(["campaign", "status", path.dirname(payload.manifest), "--json"]);
    const report = JSON.parse(stdout);
    assert.equal(status, 0);
    assert.equal(err, "");
    assert.equal(report.schema, "decomp-workbench-campaign-status-v1");
    assert.equal(report.rank_by, "temp-prefix");
    assert.equal(report.ranked_by, "temp-prefix");
    assert.equal(report.alignment_ranking_unsafe, false);
    assert.equal(report.recorded_candidates, 1);
    assert.equal(report.object_basins[0].variant_count, 1);
    const [textCode, text] = await cli(["campaign", "status", path.dirname(payload.manifest)]);
    assert.equal(textCode, 0);
    assert.match(text, /^campaign: exact \u2014 1\/1 candidate\(s\), 1 object basin\(s\)/);
    assert.match(text, /idea collapse: 1 successful source variant\(s\) \u2192 1 distinct object basin\(s\)/);
  });
});

test("campaign package promotes the verified winner", async () => {
  await withTemp(async (root) => {
    const source = path.join(root, "candidate.c"); writeFileSync(source, "int candidate;\n");
    const payloadBytes = readFileSync(source);
    const targetAssembly = path.join(root, "target.s"), context = path.join(root, "ctx.c");
    writeFileSync(targetAssembly, "jr $ra\n nop\n"); writeFileSync(context, "typedef int s32;\n");
    const { payload } = await startCampaign(root, { sources: [source] });
    const manifestPayload = JSON.parse(readFileSync(payload.manifest, "utf8"));
    const retained = manifestPayload.sources[0].retained_path;
    assert.ok(existsSync(retained));
    assert.deepEqual(readFileSync(retained), payloadBytes);
    unlinkSync(source);
    const output = path.join(root, "scratch");
    const [status, stdout, stderr] = await cli(["campaign", "package", payload.manifest, "--output", output, "--target-assembly", targetAssembly, "--context", context,
      "--platform", "n64", "--compiler", "IDO 5.3", "--compiler-id", "ido5.3", "--language", "C", "--compiler-flags=-O2 -mips2", "--diff-label", "demo", "--json"]);
    assert.equal(status, 0, stderr);
    assert.equal(stderr, "");
    assert.equal(JSON.parse(stdout).scratch_accepted, true);
    assert.deepEqual(readFileSync(path.join(output, "source.c")), payloadBytes);
    const scratch = JSON.parse(readFileSync(path.join(output, "scratch.json"), "utf8"));
    assert.equal(scratch.provenance.campaign_identity, JSON.parse(readFileSync(payload.manifest, "utf8")).identity);
  });
});

test("campaign finish freshly rebuilds and preserves NOT RUN gates", async () => {
  await withTemp(async (root) => {
    const { code, payload } = await startCampaign(root);
    assert.equal(code, 0);
    const receipt = path.join(root, "finish.json");
    const [status, , stderr] = await cli(["campaign", "finish", payload.manifest, "--output", receipt]);
    const report = JSON.parse(readFileSync(receipt, "utf8"));
    const timeoutScript = path.join(root, "project-timeout.mjs");
    writeFileSync(timeoutScript, "process.stdout.write('x'.repeat(200) + '\\n');\nsetTimeout(() => {}, 5000);\n");
    const timeoutReceipt = path.join(root, "finish-timeout.json");
    const [timeoutStatus] = await cli(["campaign", "finish", payload.manifest, "--output", timeoutReceipt, "--project-command", `${NODE} ${timeoutScript}`,
      "--project-timeout", "0.5", "--stream-limit", "16"]);
    const timeoutReport = JSON.parse(readFileSync(timeoutReceipt, "utf8"));
    const htmlReceipt = path.join(root, "finish.html");
    const [htmlStatus] = await cli(["campaign", "finish", payload.manifest, "--output", htmlReceipt, "--format", "html"]);
    const html = readFileSync(htmlReceipt, "utf8");
    assert.equal(status, 0, stderr);
    assert.equal(stderr, "");
    assert.equal(report.ready, true);
    assert.equal(report.gates.fresh_function.status, "PASS");
    assert.equal(report.gates.required_signals.status, "PASS");
    assert.equal(report.gates.scratch_context.status, "NOT RUN");
    assert.notEqual(report.winner.fresh_object_sha256, null);
    const evidence = timeoutReport.gates.project_verification.evidence;
    assert.equal(timeoutStatus, 1);
    assert.equal(evidence.returncode, 124);
    assert.equal(evidence.stdout_truncated, true);
    assert.ok(evidence.stdout_bytes > 16);
    assert.ok(existsSync(evidence.artifacts.stdout));
    assert.equal(htmlStatus, 0);
    for (const needle of ["Machine-readable receipt", "decomp-workbench-campaign-finish-v1", "NOT RUN", '<a class="skip-link" href="#main-content">', '<main id="main-content">', "<details open>"]) {
      assert.ok(html.includes(needle), needle);
    }
  });
});

test("campaign finish refuses a mutated cached object and an overwrite", async () => {
  await withTemp(async (root) => {
    const { payload } = await startCampaign(root);
    const receipt = path.join(root, "finish.json");
    const [first] = await cli(["campaign", "finish", payload.manifest, "--output", receipt]);
    const [overwrite, , overwriteError] = await cli(["campaign", "finish", payload.manifest, "--output", receipt]);
    writeFileSync(path.join(root, "cache", `${payload.results[0].cache_key}.o`), "tampered");
    const [tamper, , tamperError] = await cli(["campaign", "finish", payload.manifest, "--output", path.join(root, "second.json")]);
    assert.equal(first, 0);
    assert.equal(overwrite, 2);
    assert.ok(overwriteError.includes("refusing to overwrite"));
    assert.equal(tamper, 2);
    assert.ok(tamperError.includes("cached object hash changed"));
  });
});

test("campaign finish keeps a project failure separate from the function pass", async () => {
  await withTemp(async (root) => {
    const { payload } = await startCampaign(root);
    const receipt = path.join(root, "finish-with-project.json");
    const [status, , stderr] = await cli(["campaign", "finish", payload.manifest, "--output", receipt, "--project-command", `${NODE} -e 'process.exit(7)'`]);
    const report = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(status, 1);
    assert.equal(stderr, "");
    assert.equal(report.ready, false);
    assert.equal(report.gates.fresh_function.status, "PASS");
    assert.equal(report.gates.project_verification.status, "FAIL");
  });
});

test("campaign note survives as handoff state", async () => {
  await withTemp(async (root) => {
    const { payload } = await startCampaign(root);
    const [status, , stderr] = await cli(["campaign", "note", "padding loop line markers remain the active hypothesis", payload.manifest]);
    const [, stdout] = await cli(["campaign", "status", payload.manifest, "--json"]);
    assert.equal(status, 0);
    assert.equal(stderr, "");
    assert.equal(JSON.parse(stdout).hypothesis, "padding loop line markers remain the active hypothesis");
  });
});

test("campaign export is self-contained HTML and never overwrites", async () => {
  await withTemp(async (root) => {
    const { payload } = await startCampaign(root);
    const output = path.join(root, "report.html");
    const [status, , stderr] = await cli(["campaign", "export", payload.manifest, "--output", output]);
    const document = readFileSync(output, "utf8");
    const [second, , secondErr] = await cli(["campaign", "export", payload.manifest, "--output", output]);
    assert.equal(status, 0, stderr);
    assert.equal(stderr, "");
    for (const needle of ["<!doctype html>", "Machine-readable evidence", '<a class="skip-link" href="#main-content">', '<main id="main-content">', "<details open>", "<caption>"]) {
      assert.ok(document.includes(needle), needle);
    }
    assert.ok(!document.includes("https://"));
    assert.equal(second, 2);
    assert.ok(secondErr.includes("refusing to overwrite"));
  });
});

test("shareable export bounds long histories explicitly", () => {
  const status = {
    trajectory: Array.from({ length: 2101 }, (_, record) => ({ record })),
    basin_transitions: Array.from({ length: 2102 }, (_, record) => ({ record })),
    failures: Array.from({ length: 300 }, (_, i) => ({ source: String(i) })),
    object_basins: [{ candidate_sha256: "a".repeat(64), variant_count: 300, sources: Array.from({ length: 300 }, (_, i) => `candidate-${i}.c`) }],
  };
  const bounded = boundedExportStatus(status);
  assert.equal(bounded.trajectory.length, 2000);
  assert.equal(bounded.trajectory[0].record, 0);
  assert.equal(bounded.trajectory.at(-1).record, 2100);
  assert.equal(bounded.basin_transitions.length, 2000);
  assert.equal(bounded.failures.length, 256);
  assert.equal(bounded.object_basins[0].sources.length, 256);
  assert.equal(bounded.object_basins[0].sources_truncated, true);
  assert.deepEqual(bounded.export_bounds.object_basin_sources, { total: 300, included: 256, truncated: true });
});

test("resume preserves an exact stop unless explicitly continued", async () => {
  await withTemp(async (root) => {
    const sources = [0, 1].map((i) => { const s = path.join(root, `candidate-${i}.c`); writeFileSync(s, `int candidate = ${i};\n`); return s; });
    const { payload } = await startCampaign(root, { sources, extra: ["--jobs", "1"] });
    assert.equal(lines(payload.ledger).length, 1);
    const [status, stdout, stderr] = await cli(["campaign", "resume", payload.manifest]);
    assert.equal(lines(payload.ledger).length, 1);
    assert.ok(stdout.includes("exact result already recorded"));
    const [continued, , continuedErr] = await cli(["campaign", "resume", payload.manifest, "--continue-after-exact"]);
    const finalRecords = lines(payload.ledger);
    const [, finalOut] = await cli(["campaign", "status", payload.manifest, "--json"]);
    assert.equal(status, 0);
    assert.equal(stderr, "");
    assert.equal(continued, 0);
    assert.equal(continuedErr, "");
    assert.equal(finalRecords.length, 2);
    assert.equal(JSON.parse(finalOut).status, "exact");
  });
});

test("resume preserves v2 candidate metadata and signals", async () => {
  await withTemp(async (root) => {
    writeFileSync(path.join(root, "baseline.c"), "int baseline;\n");
    const sources = [path.join(root, "first.c"), path.join(root, "second.c")];
    sources.forEach((s, i) => writeFileSync(s, `int candidate = ${i};\n`));
    const experiment = path.join(root, "experiment.json");
    writeFileSync(experiment, JSON.stringify({ schema: "decomp-workbench-experiment-v2", family: "resume-v2", baseline: "baseline.c",
      parameters: { shape: ["first", "second"] }, candidates: sources.map((s) => ({ source: path.basename(s), parameters: { shape: path.basename(s, ".c") } })),
      signals: [{ id: "tail", kind: "target-rows-exact", rows: [1], required: true }], coverage: { method: "exhaustive", excluded: 0 } }));
    const { payload } = await startCampaign(root, { sources, extra: ["--jobs", "1", "--experiment-manifest", experiment] });
    const [resumed, , stderr] = await cli(["campaign", "resume", payload.manifest, "--continue-after-exact"]);
    const records = lines(payload.ledger).map((l) => JSON.parse(l));
    assert.equal(resumed, 0, stderr);
    assert.equal(stderr, "");
    assert.equal(records.length, 2);
    assert.equal(records[1].experiment.schema, "decomp-workbench-experiment-v2");
    assert.deepEqual(records[1].experiment.signals, ["tail"]);
    assert.equal(records[1].signals[0].status, "PASS");
  });
});

test("compile-rank ranks through the campaign engine", async () => {
  await withTemp(async (root) => {
    const target = path.join(root, "target.o"); writeFileSync(target, "target");
    const source = path.join(root, "a.c"); writeFileSync(source, "int a;\n");
    const [code, stdout, stderr] = await cli(["compile-rank", target, source, "--compile-command", template(writeCompiler(root)), "--objdump", writeObjdump(root),
      "--symbol", "demo", "--cache-dir", path.join(root, "cache"), "--json"]);
    assert.equal(code, 0, stderr);
    const doc = JSON.parse(stdout);
    assert.equal(doc.schema, "decomp-workbench-compile-rank-v1");
    assert.equal(doc.results[0].comparison.exact, true);
    const [textCode, text] = await cli(["compile-rank", target, source, "--compile-command", template(writeCompiler(root)), "--objdump", writeObjdump(root),
      "--symbol", "demo", "--cache-dir", path.join(root, "cache")]);
    assert.equal(textCode, 0);
    assert.match(text, /^  1 /);
  });
});
