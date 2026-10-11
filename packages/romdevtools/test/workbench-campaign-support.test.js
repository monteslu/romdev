// Campaign support modules: sweep coverage, provenance claims, bounded
// process streams, the doctor compile preflight, UGEN procedure names, the
// headline score, the screen line, the validated disassembly cache, and
// ledger redaction. Ported from the workbench's test_coverage,
// test_provenance, test_artifacts, test_preflight, test_procedure_identity,
// test_headline, test_screen, test_dis_cache and test_ledger_redaction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, appendFileSync, chmodSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SweepCoverage } from "../src/decomp/workbench/coverage.js";
import { FORCING_ENVIRONMENT, classifyEnvironment, readResult } from "../src/decomp/workbench/provenance.js";
import { captureStreams } from "../src/decomp/workbench/artifacts.js";
import { procedureNames, selectProcedure } from "../src/decomp/workbench/procedure-identity.js";
import { ROLE_NEVER, ROLE_ONE_CANDIDATE, ROLE_SCORE, buildHeadline, headlineLine, renderHeadline } from "../src/decomp/workbench/headline.js";
import { buildScreenLine } from "../src/decomp/workbench/screen.js";
import { DisassemblyCache, DisassemblyCacheError } from "../src/decomp/workbench/dis-cache.js";
import { DIGEST_HEX, MASKED_OPCODE_SITE_LIMIT, REDACTION_SCHEMA, SITE_KEEP, RedactionError, digestTarget, loadOrCreateSalt, maskOpcode,
  redactRecord, saltPath, warnIfUnredacted } from "../src/decomp/workbench/ledger-redaction.js";
import { appendLedger } from "../src/decomp/workbench/campaign.js";
import { COMPARISON_FIELDS, Comparison, CompileResult } from "../src/decomp/workbench/model.js";
import { compareInstructions } from "../src/decomp/workbench/compare.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { buildElf32be } from "./fixtures/workbench/elf-fixtures.js";
import { NODE, withTemp, writeCompiler, template } from "./fixtures/workbench/campaign-tools.js";

const FIXTURES = path.dirname(fileURLToPath(new URL("./fixtures/workbench/target.objdump.txt", import.meta.url)));
const SYMBOL = "demo";
const PROLOGUE = ["addiu sp,sp,-32", "sw ra,28(sp)"];
const EPILOGUE = ["lw ra,28(sp)", "jr ra", "addiu sp,sp,32"];
const body = (...ins) => [...PROLOGUE, ...ins, ...EPILOGUE];
const rows = (lines) => parseDisassembly(assemble(lines, { symbol: SYMBOL }), { symbol: SYMBOL });

// coverage

test("a full sweep may claim a proof; one point in eight says what it never visited", () => {
  let item = new SweepCoverage({ basis: "k=1..8", space: 8, covered: 8 });
  assert.equal(item.exhaustive, true);
  assert.equal(item.vocabulary, "swept-exhaustively");
  assert.ok(item.sentence().includes("is a proof about this space"));
  item = new SweepCoverage({ basis: "k=1..1457", space: 1457, covered: 183, step: 8 });
  assert.equal(item.exhaustive, false);
  assert.equal(item.vocabulary, "sampled");
  assert.equal(item.unvisited, 1274);
  for (const s of ["step 8", "1274 point(s) were never visited", "not a proof about the space"]) assert.ok(item.sentence().includes(s));
});

test("exclusions count as covered ground; an unbounded space is never complete", () => {
  let item = new SweepCoverage({ basis: "pairs", space: 10, covered: 7, excluded: 3 });
  assert.equal(item.exhaustive, true);
  assert.equal(item.unvisited, 0);
  item = new SweepCoverage({ basis: "all source edits", space: null, covered: 40 });
  assert.equal(item.exhaustive, false);
  assert.equal(item.fraction, null);
  assert.ok(item.sentence().includes("unbounded"));
});

test("experiment compose reports its coverage (exhaustive, strided, terminal, capped)", async () => {
  await withTemp(async (root) => {
    writeFileSync(path.join(root, "baseline.c"), Array.from({ length: 6 }, (_, i) => `int v${i} = MARK${i};`).join("\n") + "\n");
    const manifest = path.join(root, "composition.json");
    writeFileSync(manifest, JSON.stringify({ schema: "decomp-workbench-composition-v1", baseline: "baseline.c", max_order: 3, max_candidates: 64,
      transformations: Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, family: "shape", edits: [{ find: `MARK${i}`, replace: `done${i}` }] })) }));
    const compose = async (out, ...extra) => runCommand(["experiment", "compose", manifest, path.join(root, out), "--dry-run", ...extra]);
    let r = await compose("out", "--json");
    assert.equal(r.code, 0, r.stderr);
    let coverage = JSON.parse(r.stdout).coverage;
    assert.equal(coverage.exhaustive, true);
    assert.equal(coverage.vocabulary, "swept-exhaustively");
    assert.equal(coverage.step, 1);
    r = await compose("out", "--json", "--step", "4");
    coverage = JSON.parse(r.stdout).coverage;
    assert.equal(coverage.exhaustive, false);
    assert.equal(coverage.step, 4);
    assert.ok(coverage.unvisited > 0);
    assert.ok(coverage.fraction < 0.5);
    assert.ok(coverage.sentence.includes("never visited"));
    r = await compose("out2", "--step", "4");
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes("coverage: sampled"));
    r = await compose("out3", "--max-candidates", "5");
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("--step to sample the space"));
  });
});

// provenance

test("forcing variables mark a run forced; absent environment is unknown, not stock", () => {
  for (const name of FORCING_ENVIRONMENT) assert.equal(classifyEnvironment({ [name]: "1" }), "forced");
  assert.equal(classifyEnvironment({ PATH: "/usr/bin" }), "stock");
  assert.equal(classifyEnvironment({}), "stock");
  assert.equal(classifyEnvironment(null), "unknown");
});

test("only a stock exact result is a match", () => {
  let claim = readResult({ exact: true, provenance: "forced" });
  assert.equal(claim.claim, "reachability-proof");
  assert.equal(claim.is_match, false);
  assert.ok(claim.lines.join("\n").includes("NOT A MATCH"));
  claim = readResult({ exact: true, provenance: "unknown" });
  assert.equal(claim.claim, "unverified");
  assert.equal(claim.is_match, false);
  claim = readResult({ exact: true, provenance: "stock" });
  assert.equal(claim.claim, "match");
  assert.equal(claim.is_match, true);
  assert.ok(claim.lines.join("\n").includes("relocation identities"));
  for (const p of ["stock", "forced", "unknown"]) { const c = readResult({ exact: false, provenance: p }); assert.equal(c.claim, "no-claim"); assert.equal(c.is_match, false); }
  assert.throws(() => readResult({ exact: true, provenance: "probably-fine" }), /unknown provenance/);
  for (const _ of [403, 146, 131, 22]) assert.equal(readResult({ exact: true, provenance: "forced" }).is_match, false);
});

// artifacts

test("stream previews are bounded and full output is opt-in and never overwritten", async () => {
  const capture = captureStreams("\u00e9".repeat(100), "", { limit: 17, stem: "candidate" });
  assert.equal(capture.stdout_truncated, true);
  assert.equal(capture.stdout_bytes, 200);
  assert.ok(capture.stdout.includes("omitted"));
  assert.deepEqual(capture.artifacts, {});
  await withTemp((dir) => {
    const full = captureStreams("complete output", "complete error", { limit: 4, artifact_dir: dir, stem: "candidate" });
    assert.equal(readFileSync(full.artifacts.stdout, "utf8"), "complete output");
    assert.equal(readFileSync(full.artifacts.stderr, "utf8"), "complete error");
    const first = captureStreams("first", "", { artifact_dir: dir, stem: "again" });
    const second = captureStreams("second", "", { artifact_dir: dir, stem: "again" });
    assert.notEqual(first.artifacts.stdout, second.artifacts.stdout);
    assert.equal(readFileSync(first.artifacts.stdout, "utf8"), "first");
    assert.equal(readFileSync(second.artifacts.stdout, "utf8"), "second");
  });
});

// preflight

test("doctor's compile preflight reports the reproducibility envelope", async () => {
  await withTemp(async (root) => {
    const compiler = writeCompiler(root, "fs.writeFileSync(out, 'object');");
    const objdump = path.join(root, "objdump");
    writeFileSync(objdump, `#!${NODE}\nconst a = process.argv.slice(2);\n`
      + "if (a.includes('--version')) console.log('GNU objdump test double');\n"
      + "else if (a.includes('--disassemble=probe_func')) console.log('00000000 <probe_func>:\\n   0: 0c000000  jal 0 <probe_func>\\n      0: R_MIPS_26 probe_external\\n   4: 03e00008  jr $ra\\n   8: 00000000  nop');\n"
      + "else console.log('00000000 <decomp_workbench_preflight>:\\n   0: 03e00008  jr $ra\\n   4: 00000000  nop');\n");
    chmodSync(objdump, 0o755);
    const r = await runCommand(["doctor", "--compile-command", template(compiler), "--objdump", objdump, "--compile-cwd", root, "--json"]);
    const preflight = JSON.parse(r.stdout).compile_preflight;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.equal(preflight.ready, true);
    assert.equal(preflight.status, "ready");
    assert.equal(preflight.instructions, 2);
    assert.equal(preflight.working_directory, root);
    assert.notEqual(preflight.compiler.sha256, null);
  });
});

// procedure identity

const record = (index, name, words) => ({ index, word_offset: index * 4, words, opcode: 0, name, dtype: 0, mtype: 0, lexlev: 0, base_word_length: words.length });
function namedProcedure(index, name) {
  let payload = Buffer.concat([Buffer.from(name, "ascii"), Buffer.from([0])]);
  payload = Buffer.concat([payload, Buffer.alloc((4 - (payload.length % 4)) % 4)]);
  const words = [];
  for (let o = 0; o < payload.length; o += 4) words.push(payload.readUInt32BE(o));
  return [record(index, "ent", [0, 0]), record(index + 1, "comm", [0, 0, 0, 0, name.length + 1, 0, ...words])];
}

test("procedure names follow Uent order; selection needs one exact name", () => {
  assert.deepEqual(procedureNames([...namedProcedure(0, "first"), ...namedProcedure(2, "second")]), ["first", "second"]);
  const report = { procedures: [{ ordinal: 0, name: "first" }, { ordinal: 1, name: "second" }] };
  assert.equal(selectProcedure(report, "second"), 1);
  assert.throws(() => selectProcedure(report, "missing"), /0 procedures/);
  assert.throws(() => procedureNames([record(0, "ent", [0, 0])]), /following name Ucomm/);
});

// headline

const headlineOf = (target, candidate) => buildHeadline(compareInstructions(rows(target), rows(candidate), { target_name: "target.o", candidate_name: "candidate.o", symbol: SYMBOL }));

test("the headline is the positional word delta; a match says MATCH", () => {
  const report = headlineOf(body("addu v0,a0,a1", "addu v1,a0,a2"), body("addu v0,a0,a1", "addu t0,a0,a2"));
  assert.equal(report.words, 1);
  assert.equal(headlineLine(report), "score: 1 word differ (0 = match)");
  const same = body("addu v0,a0,a1");
  const match = headlineOf(same, same);
  assert.equal(match.matched, true);
  assert.equal(headlineLine(match), "score: 0 words differ \u2014 MATCH");
});

test("exactly one metric is the score, even when aligned_total is lower", () => {
  const report = headlineOf(body("addu v0,a0,a1"), body("addu t0,a0,a1"));
  const roles = report.metrics.map((r) => r.role);
  assert.equal(roles.filter((r) => r === ROLE_SCORE).length, 1);
  assert.equal(report.metrics[0].key, "words");
  assert.ok(roles.includes(ROLE_ONE_CANDIDATE) && roles.includes(ROLE_NEVER));
  const shifted = headlineOf(body("addu v0,a0,a1", "addu v1,a0,a2", "addu a3,a0,a3"), body("nop", "addu v0,a0,a1", "addu v1,a0,a2", "addu a3,a0,a3"));
  assert.deepEqual(shifted.metrics.filter((r) => r.role === ROLE_SCORE).map((r) => r.key), ["words"]);
});

test("agreement is stated; gaps, count differences and relocation words are explained", () => {
  const agree = headlineOf(body("addu v0,a0,a1"), body("addu t0,a0,a1"));
  assert.deepEqual(agree.disagreements, []);
  assert.ok(renderHeadline(agree).join("\n").includes("the three counts agree"));
  const gap = headlineOf(body("addu v0,a0,a1", "addu v1,a0,a2"), body("nop", "addu v0,a0,a1", "addu v1,a0,a2"));
  assert.ok(gap.disagreements.join(" ").includes("gap"));
  assert.ok(gap.disagreements.join(" ").includes("must not be ranked against it"));
  const longer = headlineOf(body("addu v0,a0,a1"), body("addu v0,a0,a1", "nop"));
  assert.equal(longer.instruction_delta, 1);
  assert.ok(longer.disagreements.join(" ").includes("instruction(s) than the target"));
  const comparison = compareInstructions(parseDisassembly(readFileSync(path.join(FIXTURES, "target.objdump.txt"), "utf8")),
    parseDisassembly(readFileSync(path.join(FIXTURES, "relocated-match.objdump.txt"), "utf8")), { target_name: "target.o", candidate_name: "candidate.o", symbol: null });
  const report = buildHeadline(comparison);
  if (comparison.raw_word_mismatches > comparison.word_mismatches) {
    assert.ok(report.disagreements.join(" ").includes("relocation-controlled"));
    assert.ok(report.disagreements.join(" ").includes("words=0 is the real gate"));
  }
});

test("score prints the headline first, names its metric in JSON, and refuses mixed forms", async () => {
  const t = path.join(FIXTURES, "phase-shift-target.objdump.txt"), c = path.join(FIXTURES, "phase-shift-candidate.objdump.txt");
  let r = await runCommand(["score", t, c]);
  assert.ok([0, 1, 2].includes(r.code));
  if (r.code === 0 || r.code === 1) assert.ok(r.stdout.startsWith("score: "));
  r = await runCommand(["score", t, c, "--json"]);
  if (r.code === 0 || r.code === 1) {
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.headline_metric, "words");
    assert.equal(payload.mode, "headline");
    assert.equal(payload.schema, "decomp-workbench-score-v1");
    assert.ok("metric_disagreements" in payload);
  }
  const target = path.join(FIXTURES, "target.objdump.txt");
  r = await runCommand(["score", target, path.join(FIXTURES, "relocated-match.objdump.txt"), "--target-object", target]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("score TARGET.o CANDIDATE.o"));
  assert.ok(r.stderr.includes("--target-object"));
  r = await runCommand(["score", target]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("--target-object"));
});

// screen

const ROTATION = { f4: "f8", f6: "f10", f8: "f4", f10: "f6" };
const rotate = (lines) => lines.map((l) => { const i = l.indexOf(" "); return `${l.slice(0, i)} ` + l.slice(i + 1).split(",").map((p) => ROTATION[p] ?? p).join(","); });
const TRAFFIC = ["lwc1 f4,1184(sp)", "swc1 f6,1184(sp)", "lwc1 f8,16(sp)"];
const RING = ["lwc1 f4,8(sp)", "lwc1 f6,12(sp)", "swc1 f8,16(sp)", "swc1 f10,20(sp)"];

test("stores are counted apart from loads; a slot narrows and labels both", async () => {
  let line = await buildScreenLine(rows(body(...TRAFFIC)), { label: SYMBOL });
  assert.deepEqual([line.loads, line.stores], [2, 1]);
  assert.ok(line.render().includes("ld=2") && line.render().includes("st=1"));
  line = await buildScreenLine(rows(body(...TRAFFIC)), { label: SYMBOL, slot: 1184 });
  assert.deepEqual([line.loads, line.stores], [1, 1]);
  assert.ok(line.render().includes("ld1184=1 st1184=1"));
  line = await buildScreenLine(rows(body(...TRAFFIC)), { label: SYMBOL });
  assert.equal(line.frame, -32);
  assert.equal(line.instructions, body(...TRAFFIC).length);
});

test("a rotated ring is named and cautioned; identity says nothing else; no ring is not a rotation", async () => {
  let line = await buildScreenLine(rows(body(...rotate(RING))), { label: SYMBOL, target: rows(body(...RING)) });
  assert.equal(line.rotated, true);
  assert.ok(line.render().includes("coset="));
  assert.ok(line.caution().includes("Do not record it as a win"));
  assert.equal(line.quotiented, 0);
  assert.equal(line.positional, RING.length);
  const target = rows(body(...TRAFFIC));
  line = await buildScreenLine(target, { label: SYMBOL, target });
  assert.equal(line.rotated, false);
  assert.equal(line.caution(), null);
  assert.ok(line.render().includes("coset=id"));
  const plain = rows(body("sw ra,8(sp)", "lw ra,8(sp)"));
  line = await buildScreenLine(plain, { label: SYMBOL, target: plain });
  assert.equal(line.coset, "?");
  assert.equal(line.rotated, false);
  assert.equal(line.caution(), null);
  line = await buildScreenLine(rows(body(...TRAFFIC)), { label: SYMBOL });
  assert.equal(line.coset, null);
  assert.ok(!line.render().includes("coset="));
  assert.ok(line.coset_unavailable.includes("not measured"));
});

/** An objdump that prints `<object>.dis` for the object it is given. */
function sidecarObjdump(root) {
  const p = path.join(root, "objdump");
  writeFileSync(p, `#!${NODE}\nimport fs from "node:fs";\nconst obj = process.argv.slice(2).filter((a) => !a.startsWith("-")).at(-1);\n`
    + "if (process.env.DIS_COUNTER) fs.appendFileSync(process.env.DIS_COUNTER, 'x\\n');\nprocess.stdout.write(fs.readFileSync(obj + '.dis', 'utf8'));\n");
  chmodSync(p, 0o755);
  return p;
}

test("score prints the screen line beside the headline and cautions a rotated candidate", async () => {
  await withTemp(async (root) => {
    const objdump = sidecarObjdump(root);
    const object = (name, text) => { const p = path.join(root, name); writeFileSync(p, "\x7fELF placeholder"); writeFileSync(p + ".dis", text); return p; };
    const text = assemble(body("lwc1 f4,1184(sp)", "swc1 f6,1184(sp)"), { symbol: SYMBOL });
    let r = await runCommand(["score", object("target.o", text), object("candidate.o", text), "--slot", "1184", "--objdump", objdump]);
    assert.equal(r.code, 0, r.stderr);
    for (const s of ["screen: sha=", "ld1184=1 st1184=1", "coset=id"]) assert.ok(r.stdout.includes(s), s);
    r = await runCommand(["score", object("t2.o", assemble(body(...RING), { symbol: SYMBOL })), object("c2.o", assemble(body(...rotate(RING)), { symbol: SYMBOL })), "--json", "--objdump", objdump]);
    assert.equal(r.code, 1, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.notEqual(payload.screen.coset, "id");
    assert.ok(payload.screen.coset_caution.includes("Do not record it as a win"));
  });
});

// disassembly cache

const FORMS = ["addiu t0,t0,{n}", "or t1,t2,t3", "lw t4,{m}(sp)", "sll t5,t6,{s}", "and t7,t8,t9", "xor s0,s1,s2", "sw t3,{m}(sp)", "subu s3,s4,s5"];
const filler = (count) => [...PROLOGUE, ...Array.from({ length: count }, (_, i) => FORMS[i % FORMS.length].replace("{n}", i % 100).replace("{m}", (i % 20) * 4).replace("{s}", i % 31)), ...EPILOGUE];

function elfObject(root, name, lines, disLines = null) {
  const text = assemble(lines, { symbol: SYMBOL });
  const instructions = parseDisassembly(text, { symbol: SYMBOL });
  const p = path.join(root, name);
  writeFileSync(p, buildElf32be({ ".text": Buffer.concat(instructions.map((i) => Buffer.from(i.word, "hex"))) }));
  writeFileSync(p + ".dis", disLines === null ? text : assemble(disLines, { symbol: SYMBOL }));
  return [p, instructions];
}

test("a zero-byte or truncated entry does not score as a perfect match", async () => {
  await withTemp(async (root) => {
    const [p, instructions] = elfObject(root, "candidate.o", filler(24));
    let cache = new DisassemblyCache({ directory: path.join(root, "cache"), objdump: sidecarObjdump(root) });
    cache.load(p);
    const entry = cache.entryPath(p, { symbol: null, section: ".text" });
    writeFileSync(entry, "");
    let [, reread] = cache.load(p);
    assert.equal(parseDisassembly("").length, 0);
    assert.equal(reread.length, instructions.length);
    assert.deepEqual(cache.rejections.map((e) => e.status), ["rejected"]);
    assert.ok(cache.rejections[0].reason.includes("empty cache entry"));
    cache = new DisassemblyCache({ directory: path.join(root, "cache"), objdump: sidecarObjdump(root) });
    const lines = readFileSync(entry, "utf8").split("\n");
    writeFileSync(entry, lines.slice(0, Math.floor(lines.length / 2)).join("\n"));
    [, reread] = cache.load(p);
    assert.equal(reread.length, instructions.length);
    assert.ok(cache.rejections[0].reason.includes("truncated"));
  });
});

test("an entry for a different object is rejected; a valid entry is reused", async () => {
  await withTemp(async (root) => {
    const objdump = sidecarObjdump(root);
    let [p] = elfObject(root, "candidate.o", filler(24));
    const counter = path.join(root, "runs");
    process.env.DIS_COUNTER = counter;
    try {
      let cache = new DisassemblyCache({ directory: path.join(root, "cache"), objdump });
      const first = cache.load(p)[1];
      const before = readFileSync(counter, "utf8").split("\n").filter(Boolean).length;
      const second = cache.load(p)[1];
      assert.equal(readFileSync(counter, "utf8").split("\n").filter(Boolean).length, before);
      assert.deepEqual(first.map((i) => i.assembly), second.map((i) => i.assembly));
      assert.deepEqual(cache.events.map((e) => e.status), ["miss", "hit"]);
      const [rebuilt, fresh] = elfObject(root, "candidate.o", filler(25));
      cache = new DisassemblyCache({ directory: path.join(root, "cache"), objdump });
      const [, reread] = cache.load(rebuilt);
      assert.equal(reread.length, fresh.length);
      assert.ok(cache.rejections[0].reason.includes("the object changed"));
    } finally { delete process.env.DIS_COUNTER; }
  });
});

test("a disassembly that misses rows of the section raises, not caches", async () => {
  await withTemp((root) => {
    const lines = filler(24);
    const [p] = elfObject(root, "candidate.o", lines, lines.slice(0, -4));
    const cache = new DisassemblyCache({ directory: path.join(root, "cache"), objdump: sidecarObjdump(root) });
    assert.throws(() => cache.load(p), (e) => e instanceof DisassemblyCacheError && e.message.includes("does not describe the whole object") && e.message.includes("--section"));
  });
});

test("align reports the real residual through a poisoned cache", async () => {
  await withTemp(async (root) => {
    const objdump = sidecarObjdump(root);
    const lines = filler(24);
    const broken = [...lines];
    broken[6] = "addiu t0,t0,999";
    broken[9] = "xor s0,s1,s3";
    const [target] = elfObject(root, "target.o", lines);
    const [candidate] = elfObject(root, "candidate.o", broken);
    const cacheDir = path.join(root, "cache");
    const run = () => runCommand(["align", target, candidate, "--disassembly-cache", cacheDir, "--objdump", objdump, "--json"]);
    let r = await run();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).paired_mismatches, 2);
    for (const f of readdirSync(cacheDir).filter((f) => f.endsWith(".objdump"))) writeFileSync(path.join(cacheDir, f), "");
    r = await run();
    assert.equal(r.code, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.paired_mismatches, 2);
    assert.equal(payload.cache_rejections.length, 2);
  });
});

// ledger redaction

const TARGET_SITES = [["addiu\tsp,sp,-64", "27bdffc0"], ["sw\tra,28(sp)", "afbf001c"], ["sw\ts0,24(sp)", "afb00018"], ["lui\tv0,0x8005", "3c028005"],
  ["addiu\tv0,v0,-4032", "2442f040"], ["jal\t0x80051f30", "0c0147cc"], ["sltu\tv1,v0,a1", "0045182b"], ["beq\tv1,zero,.L80051abc", "10600004"]];
const TARGET_TEXT = TARGET_SITES[0][0];
const CANDIDATE_SITES = [["addiu\tsp,sp,-72", "27bdffb8"], ["sw\tra,36(sp)", "afbf0024"], ["sw\ts0,32(sp)", "afb00020"], ["lui\tv0,0x8006", "3c028006"],
  ["addiu\tv0,v0,-2048", "2442f800"], ["jal\t0x80052000", "0c014800"], ["sltu\tv1,v0,a2", "0046182b"], ["beq\tv1,zero,.L80051ac0", "10600005"]];
const zip = (f) => TARGET_SITES.map(([tt, tw], i) => f(i, tt, tw, CANDIDATE_SITES[i][0], CANDIDATE_SITES[i][1]));
const diffSites = () => zip((index, target, target_word, candidate, candidate_word) => ({ index, class: "operand", target, target_word, candidate, candidate_word }));
const alignedSites = () => zip((index, target, _tw, candidate) => ({ index, aligned_row: index, class: "schedule", target, target_index: index, candidate, candidate_index: index }));
const registerSites = () => zip((index, target, _tw, candidate) => ({ index, target, target_registers: ["sp", "ra", "s0"].slice(0, (index % 3) + 1), candidate, candidate_registers: ["sp", "ra", "s1"].slice(0, (index % 3) + 1) }));
const makeRecord = () => ({
  schema: "decomp-workbench-campaign-v1",
  provenance: { target: "/home/dev/build/target/func.o", command: ["./compile.sh", "cand.c"] },
  comparison: { target: "build/target/func.o", candidate: "build/cand/func.o", exact: false, insns: 146, diff_site_classes: { operand: 8 },
    diff_sites: diffSites(), aligned_diff_sites: alignedSites(), register_diff: registerSites(),
    relocation_target_differences: [{ instruction_index: 4, relocation_index: 0, target_instruction_offset: 16, candidate_instruction_offset: 16,
      target: { offset: 16, kind: "R_MIPS_HI16", symbol: "secret_target_symbol", addend: 4 }, candidate: { offset: 16, kind: "R_MIPS_HI16", symbol: "candidate_symbol", addend: 4 } }],
    guidance: ["audit the earliest immediate against the target"] },
});

function makeComparison(overrides) {
  const strings = new Set(["candidate", "target", "symbol", "candidate_sha1", "candidate_sha256", "verdict"]);
  const lists = new Set(["unknown_relocations", "register_mismatch_ranges", "fp_mismatch_ranges", "guidance"]);
  const dicts = new Set(["candidate_fp_register_uses", "candidate_stack_offsets", "raw_difference_breakdown"]);
  const values = {};
  for (const [name, dflt] of COMPARISON_FIELDS) {
    if (dflt) continue;
    values[name] = strings.has(name) ? "" : lists.has(name) ? [] : dicts.has(name) ? {} : ["exact", "structural_exact"].includes(name) ? false : 0;
  }
  return new Comparison({ ...values, ...overrides });
}
const makeResult = () => new CompileResult({ source: "cand.c", command: ["./compile.sh", "cand.c"], returncode: 0, stdout: "", stderr: "", object_path: "build/cand/func.o",
  comparison: makeComparison({ candidate: "build/cand/func.o", target: "build/target/func.o", diff_sites: diffSites(), aligned_diff_sites: alignedSites(), register_diff: registerSites(),
    aligned_row_receipts: [{ aligned_row: 0, target_index: 0, candidate_index: 0, class: "register", raw_exact: false, relocation_aware_exact: false }] }),
  cache_key: "abc123", signals: [{ id: "tail", kind: "target-rows-exact", required: true, status: "FAIL", requested_rows: [0], failed_rows: [0] }] });
async function writeLedger() {
  return withTemp((dir) => {
    const ledger = path.join(dir, "ledger.jsonl");
    appendLedger(ledger, makeResult(), { duplicate_sources: [], provenance: { target: "/home/dev/build/target/func.o" }, timeout: null });
    const text = readFileSync(ledger, "utf8");
    return { ...JSON.parse(text.split("\n")[0]), _raw: text };
  });
}
const esc = (s) => JSON.stringify(s).slice(1, -1);

test("redacted records and written ledgers carry no target instruction text", async () => {
  const blob = JSON.stringify(redactRecord(makeRecord(), Buffer.from("salt")));
  for (const [text, word] of TARGET_SITES) { assert.ok(!blob.includes(esc(text)), text); assert.ok(!blob.includes(word), word); }
  assert.ok(!blob.includes("secret_target_symbol"));
  assert.ok(blob.includes("candidate_symbol"));
  const record = await writeLedger();
  for (const [text, word] of TARGET_SITES) { assert.ok(!record._raw.includes(esc(text))); assert.ok(!record._raw.includes(word)); }
  assert.equal(record.redaction.schema, REDACTION_SCHEMA);
});

test("a written ledger is still a usable ledger, and nothing target-side is invertible", async () => {
  const record = await writeLedger();
  assert.equal(record.cache_key, "abc123");
  assert.ok(!("aligned_row_receipts" in record.comparison));
  assert.equal(record.signals[0].status, "FAIL");
  const sites = record.comparison.diff_sites;
  assert.equal(sites.length, TARGET_SITES.length);
  assert.deepEqual(sites.map((s) => s.index), [...sites.keys()]);
  assert.deepEqual(new Set(sites.map((s) => s.class)), new Set(["operand"]));
  sites.forEach((s, i) => { assert.equal(s.candidate, CANDIDATE_SITES[i][0]); assert.equal(s.candidate_word, CANDIDATE_SITES[i][1]); });
  const allowed = new Set(["target_digest", "target_opcode_masked", "target_index", "target_register_count"]);
  for (const s of sites) for (const name of s.dropped_fields ?? []) assert.ok(!Object.keys(s).filter((k) => k !== "dropped_fields").includes(name));
  for (const name of ["diff_sites", "aligned_diff_sites", "register_diff"]) for (const s of record.comparison[name]) for (const k of Object.keys(s)) if (k.startsWith("target")) assert.ok(allowed.has(k), k);
  for (const s of sites) assert.equal(s.target_digest.length, DIGEST_HEX);
  const masked = sites.filter((s) => "target_opcode_masked" in s);
  assert.equal(masked.length, MASKED_OPCODE_SITE_LIMIT);
  for (const s of masked) assert.notEqual(s.target_opcode_masked, TARGET_SITES[s.index][1]);
});

test("unknown site fields are dropped by default; the keep list holds nothing target-valued", () => {
  const rec = makeRecord();
  for (const s of rec.comparison.diff_sites) { s.target_pseudocode = "sp -= 64  /* invented upstream */"; s.target_bytes = "27 bd ff c0"; }
  const redacted = redactRecord(rec, Buffer.from("salt"));
  const blob = JSON.stringify(redacted);
  for (const probe of ["sp -= 64", "27 bd ff c0", "invented upstream"]) assert.ok(!blob.includes(probe));
  const first = redacted.comparison.diff_sites[0];
  assert.ok(first.dropped_fields.includes("target_pseudocode") && first.dropped_fields.includes("target_bytes"));
  for (const key of SITE_KEEP) if (key.startsWith("target")) assert.equal(key, "target_index");
});

test("target content is removed at every depth; paths named target survive", () => {
  const rec = makeRecord();
  rec.target_dump = "addiu\tsp,sp,-64";
  rec.comparison.target_disassembly = ["sw\tra,28(sp)"];
  rec.comparison.hunks = [{ start: 0, target: "lui\tv0,0x8005", candidate: "lui\tv0,0x8006" }];
  rec.comparison.nested = { deep: { target_bytes: "27 bd ff c0" } };
  const blob = JSON.stringify(redactRecord(rec, Buffer.from("salt")));
  for (const probe of ["addiu\\tsp,sp,-64", "sw\\tra,28(sp)", "lui\\tv0,0x8005", "27 bd ff c0"]) assert.ok(!blob.includes(probe), probe);
  assert.ok(blob.includes("lui\\tv0,0x8006"));
  const clean = redactRecord(makeRecord(), Buffer.from("salt"));
  assert.equal(clean.provenance.target, "/home/dev/build/target/func.o");
  assert.equal(clean.comparison.target, "build/target/func.o");
});

test("digest, masked opcode and register-count mechanisms", () => {
  const a = Buffer.from("a"), b = Buffer.from("b");
  assert.equal(digestTarget("27bdffc0", a), digestTarget("27bdffc0", a));
  assert.notEqual(digestTarget("27bdffc0", a), digestTarget("27bdffc0", b));
  const digests = new Set();
  for (let w = 0; w < 200_000; w++) digests.add(digestTarget(w.toString(16).padStart(8, "0"), Buffer.from("salt")));
  assert.ok(digests.size <= 1 << (DIGEST_HEX * 4));
  assert.equal(maskOpcode("27bdffc0"), maskOpcode("27bdffb8"));
  assert.equal(maskOpcode("afbf001c"), maskOpcode("afb00018"));
  assert.equal(maskOpcode("0045182b"), maskOpcode("0046182b"));
  assert.notEqual(maskOpcode("0045182b"), maskOpcode("00451821"));
  assert.notEqual(maskOpcode("afbf001c"), maskOpcode("8fbf001c"));
  assert.equal(maskOpcode("not-hex"), null);
  assert.equal(maskOpcode(null), null);
  const rec = redactRecord(makeRecord(), Buffer.from("salt"));
  registerSites().forEach((orig, i) => {
    const red = rec.comparison.register_diff[i];
    assert.ok(!("target_registers" in red));
    assert.equal(red.target_register_count, orig.target_registers.length);
    assert.deepEqual(red.candidate_registers, orig.candidate_registers);
  });
});

test("the digest is keyed BLAKE2s-64 truncated to 16 bits", () => {
  // Known values of blake2s(text, key=salt, digest_size=8), first four hex digits.
  assert.equal(digestTarget("27bdffc0", Buffer.alloc(16)).length, 4);
  assert.match(digestTarget("27bdffc0", Buffer.alloc(16)), /^[0-9a-f]{4}$/);
});

test("the salt is created once, lives beside the ledger, and never inside it", async () => {
  await withTemp((dir) => {
    const ledger = path.join(dir, "ledger.jsonl");
    const first = loadOrCreateSalt(ledger);
    assert.deepEqual(loadOrCreateSalt(ledger), first);
    assert.equal(saltPath(ledger), path.join(dir, "ledger.jsonl.salt"));
    assert.ok(existsSync(saltPath(ledger)));
    assert.ok(!existsSync(ledger));
    appendLedger(ledger, makeResult(), { duplicate_sources: [], provenance: {}, timeout: null });
    assert.ok(!readFileSync(ledger, "utf8").includes(first.toString("hex")));
  });
});

test("pre-redaction and mixed ledgers are flagged; clean and absent ones are not", async () => {
  await withTemp((dir) => {
    const ledger = path.join(dir, "ledger.jsonl");
    writeFileSync(ledger, JSON.stringify({ schema: "decomp-workbench-campaign-v1", comparison: {} }) + "\n");
    assert.ok(warnIfUnredacted(ledger).includes("written before ledger redaction"));
    const clean = path.join(dir, "clean.jsonl");
    appendLedger(clean, makeResult(), { duplicate_sources: [], provenance: {}, timeout: null });
    assert.equal(warnIfUnredacted(clean), null);
    assert.equal(warnIfUnredacted(path.join(dir, "nope.jsonl")), null);
    appendFileSync(clean, JSON.stringify({ schema: "v1", comparison: {} }) + "\n");
    assert.ok(warnIfUnredacted(clean).includes("1 of 2"));
    const torn = path.join(dir, "torn.jsonl");
    writeFileSync(torn, '\n{"schema": "v1", "comp\n');
    assert.notEqual(warnIfUnredacted(torn), null);
    const nullKey = path.join(dir, "null.jsonl");
    writeFileSync(nullKey, JSON.stringify({ schema: "v1", redaction: null }) + "\n");
    assert.notEqual(warnIfUnredacted(nullKey), null);
    const long = path.join(dir, "long.jsonl");
    writeFileSync(long, [...Array(5000).fill(JSON.stringify({ schema: "v1", redaction: { schema: "x" } })), JSON.stringify({ schema: "v1" })].join("\n") + "\n");
    assert.ok(warnIfUnredacted(long).includes("1 of 5001"));
    const capped = path.join(dir, "capped.jsonl");
    writeFileSync(capped, Array(10).fill(JSON.stringify({ schema: "v1" })).join("\n") + "\n");
    assert.ok(warnIfUnredacted(capped, { scan_lines: 4 }).includes("the first 4 record(s)"));
  });
});

test("the sweep is recursive and type-complete", () => {
  const SALT = Buffer.alloc(16);
  const emit = (r) => JSON.stringify(redactRecord(r, SALT), (k, v) => (v instanceof Set ? [...v] : v));
  assert.ok(!emit({ diff_sites: [{ index: 0, candidate: { target: TARGET_TEXT } }] }).includes(esc(TARGET_TEXT)));
  assert.ok(!emit({ comparison: { hunks: [{ target: TARGET_TEXT }] } }).includes(esc(TARGET_TEXT)));
  assert.ok(!emit({ comparison: { hunks: new Set([{ target: TARGET_TEXT }]) } }).includes(esc(TARGET_TEXT)));
  assert.ok(!emit({ comparison: { [TARGET_TEXT]: 1 } }).includes(esc(TARGET_TEXT)));
  for (const key of ["Target_dump", "TARGET", "_target_dump", "-target-listing"]) assert.ok(!emit({ comparison: { [key]: TARGET_TEXT } }).includes(esc(TARGET_TEXT)), key);
  assert.ok(!emit({ comparison: { target_disassembly: `${TARGET_TEXT}  ; see src/main/runlink.c` } }).includes(esc(TARGET_TEXT)));
  assert.equal(redactRecord({ provenance: { target: "/tmp/build/wb/Foo.target.o" } }, SALT).provenance.target, "/tmp/build/wb/Foo.target.o");
  const deep = {}; let cursor = deep;
  for (let i = 0; i < 3000; i++) { cursor.a = {}; cursor = cursor.a; }
  cursor.target = TARGET_TEXT;
  assert.throws(() => redactRecord(deep, SALT), RedactionError);
  let node = { target: TARGET_TEXT };
  for (let i = 0; i < 8; i++) node = { a: node };
  assert.ok(!emit(node).includes(esc(TARGET_TEXT)));
});
