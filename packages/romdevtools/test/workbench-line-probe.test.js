// The line-assignment probe: the statement tokenizer, the minimal ELF
// window reader, word scoring, verdicts, ties and next steps, and end-to-end
// runs against a self-contained fake compiler (a node script that hashes
// tokens into words and wraps them in a synthetic ELF object). Ported from
// the workbench's line-probe and line-probe command tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  VERDICT_LINE_SENSITIVE, VERDICT_NONDETERMINISTIC, VERDICT_NOT_LINE_SENSITIVE, ElfFormatError, LineProbeError, ProbeOSError,
  classifyVerdict, extractTextWindow, globalShift, nextSteps, runLineProbe, scoreAgainstTarget, splitStatementLines, tieStatementLines,
  wordDiffPositions, generateVariants,
} from "../src/decomp/workbench/line-probe.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { buildElf32 } from "./fixtures/workbench/fake-object.js";

const FAKE_OBJECT = pathToFileURL(fileURLToPath(new URL("./fixtures/workbench/fake-object.js", import.meta.url))).href;
const COMPILER = `import { createHash } from "node:crypto";
import fs from "node:fs";
import { buildElf32 } from ${JSON.stringify(FAKE_OBJECT)};
const [mode, source, output] = process.argv.slice(2);
const text = fs.readFileSync(source, "utf8");
const word = (t) => createHash("sha256").update(t, "utf8").digest().subarray(0, 4);
const tokens = (s) => s.split(/\\s+/).filter(Boolean);
const words = [];
if (mode === "sensitive") { for (const line of text.split(/\\r\\n|\\n|\\r/)) for (const t of tokens(line).reverse()) words.push(word(t)); }
else if (mode === "insensitive") { for (const t of tokens(text)) words.push(word(t)); }
else if (mode === "nondeterministic") { words.push(word(String(text.split("\\n").length - 1))); for (const t of tokens(text)) words.push(word(t)); }
else if (mode === "fail") { process.stderr.write("synthetic compiler error: refusing to compile\\n"); process.exit(1); }
else { process.stderr.write("unknown mode: " + mode + "\\n"); process.exit(1); }
const body = Buffer.concat(words);
const half = Math.floor(body.length / 4 / 2) * 4;
fs.writeFileSync(output, buildElf32(body, [["prefix_fn", 0, half], ["target_fn", half, body.length - half]]));
`;
const SOURCE = "int f(void) {\n    aaaa; bbbb; cccc; dddd;\n}\n";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-lines-")); }
function writeCompiler(dir) { const p = path.join(dir, "fake_compiler.mjs"); fs.writeFileSync(p, COMPILER); return p; }
const template = (script, mode) => `${process.execPath} ${script} ${mode} {input} {output}`;
async function withRoot(fn) { const root = tmp(); try { return await fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); } }
function input(root, text = SOURCE) { const p = path.join(root, "unit.i"); fs.writeFileSync(p, text); return p; }
const probe = (root, mode, extra = {}) => runLineProbe(input(root), { compile_template: template(writeCompiler(root), mode), split_threshold: 10,
  work_dir: path.join(root, "state"), compile_cwd: root, cwd: root, ...extra });

// -- tokenizer --

test("splits only overlong lines", () => {
  assert.equal(splitStatementLines(SOURCE, { threshold: 1000 }), SOURCE);
  assert.ok(splitStatementLines(SOURCE, { threshold: 10 }).includes("aaaa;\n bbbb;\n cccc;\n dddd;"));
});

test("ignores semicolons in string and char literals", () => {
  const r = splitStatementLines("void h(void) { char *s = \"a;b;c\"; char ch = ';'; int n = 1; }", { threshold: 5 });
  assert.ok(r.includes('"a;b;c"'));
  assert.ok(!r.includes("a;\nb;\nc"));
  assert.ok(r.includes("';';"));
});

test("ignores semicolons in line and block comments", () => {
  const r = splitStatementLines("void h(void) { /* a;b;c */ int n = 1; // trailing ; comment\nint m = 2; }", { threshold: 5 });
  assert.ok(r.includes("/* a;b;c */"));
  assert.ok(r.includes("// trailing ; comment"));
  assert.ok(r.includes("n = 1;\n"));
});

test("does not split a for header, or an empty one", () => {
  const r = splitStatementLines("void g(void) { for (i = 0; i < 10; i++) { xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx = 1; } }", { threshold: 10 });
  assert.ok(r.includes("for (i = 0; i < 10; i++)"));
  assert.ok(r.includes("= 1;\n"));
  assert.ok(splitStatementLines("void g(void) { for (;;) { aaaaaaaaaaaaaaaaaaaaaaaaaaaa = 1; } }", { threshold: 5 }).includes("for (;;)"));
});

test("does not split outside a brace; handles nested braces", () => {
  const source = "int a; int b; int c; int d; int e; int f; int g; int h;";
  assert.equal(splitStatementLines(source, { threshold: 5 }), source);
  const r = splitStatementLines("void g(void) { if (x) { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = 1; b = 2; } }", { threshold: 10 });
  assert.ok(r.includes("= 1;\n"));
  assert.ok(r.includes("b = 2;\n"));
});

test("rejects a non-positive threshold; global shift prepends blank lines", () => {
  assert.throws(() => splitStatementLines(SOURCE, { threshold: 0 }), (e) => e instanceof LineProbeError && /split-threshold/.test(e.message));
  assert.equal(globalShift("abc\n", { blank_lines: 3 }), "\n\n\nabc\n");
  assert.equal(globalShift("abc\n", { blank_lines: 0 }), "abc\n");
  assert.throws(() => globalShift("abc\n", { blank_lines: -1 }), (e) => e instanceof LineProbeError && /shift-lines/.test(e.message));
});

// -- ELF window --

function writeObject(root, text, symbols = []) { const p = path.join(root, "unit.o"); fs.writeFileSync(p, buildElf32(text, symbols)); return p; }
const hex = (...bytes) => Buffer.from(bytes).toString("hex");

test("whole-.text window, and a function window slices the right bytes", () => withRoot((root) => {
  const whole = extractTextWindow(writeObject(root, Buffer.from([...Array(32).keys()])), { function: null });
  assert.equal(whole.words.length, 8);
  assert.ok(whole.source.includes("whole section"));
  const text = Buffer.concat([...Array(8).keys()].map((i) => Buffer.alloc(4, i)));
  const fn = extractTextWindow(writeObject(root, text, [["prefix_fn", 0, 16], ["target_fn", 16, 16]]), { function: "target_fn" });
  assert.deepEqual(fn.words, [hex(4, 4, 4, 4), hex(5, 5, 5, 5), hex(6, 6, 6, 6), hex(7, 7, 7, 7)]);
}));

test("a missing function suggests whole-.text mode", () => withRoot((root) => {
  const p = writeObject(root, Buffer.alloc(16), [["known_fn", 0, 16]]);
  assert.throws(() => extractTextWindow(p, { function: "missing_fn" }), (e) => e instanceof ElfFormatError && e.message.includes("no symbol named 'missing_fn'")
    && ["whole-.text mode", "IDO", "static", "known_fn"].every((s) => e.message.includes(s)));
}));

test("a missing .symtab suggests whole-.text mode", () => withRoot((root) => {
  const shstrtab = Buffer.from("\0.text\0.shstrtab\0", "latin1");
  const text = Buffer.alloc(8), textOff = 52, shstrOff = textOff + text.length, shoff = shstrOff + shstrtab.length;
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
  const sec = [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 1, 6, 0, textOff, text.length, 0, 0, 4, 0], [7, 3, 0, 0, shstrOff, shstrtab.length, 0, 0, 1, 0]];
  const header = Buffer.concat([Buffer.from("\x7fELF", "latin1"), Buffer.from([1, 2, 1]), Buffer.alloc(9), u16(1), u16(8), u32(1), u32(0), u32(0), u32(shoff), u32(0), u16(52), u16(0), u16(0), u16(40), u16(3), u16(2)]);
  const p = path.join(root, "no-symtab.o");
  fs.writeFileSync(p, Buffer.concat([header, text, shstrtab, ...sec.map((e) => Buffer.concat(e.map(u32)))]));
  assert.throws(() => extractTextWindow(p, { function: "anything" }), (e) => e instanceof ElfFormatError && e.message.includes("no .symtab") && e.message.includes("whole-.text mode"));
}));

test("a non-ELF object, a zero-size symbol, and a short trailing word", () => withRoot((root) => {
  const bad = path.join(root, "not-an-object.o");
  fs.writeFileSync(bad, "not an elf file at all");
  assert.throws(() => extractTextWindow(bad, { function: null }), (e) => e instanceof ElfFormatError && e.message.includes("ELF"));
  assert.throws(() => extractTextWindow(writeObject(root, Buffer.alloc(8), [["stripped_fn", 0, 0]]), { function: "stripped_fn" }),
    (e) => e instanceof ElfFormatError && e.message.includes("size 0") && e.message.includes("whole-.text mode"));
  assert.deepEqual(extractTextWindow(writeObject(root, Buffer.from([1, 2, 3, 4, 5, 6])), { function: null }).words, [hex(1, 2, 3, 4), hex(5, 6)]);
}));

// -- scoring and verdicts --

test("word diff counts positions and length difference", () => {
  assert.equal(wordDiffPositions(["aaaa", "bbbb", "cccc"], ["aaaa", "xxxx"]), 2);
});

test("score against target partitions toward/away/unchanged", () => {
  const score = scoreAgainstTarget(["1111", "2222", "0000", "9999"], ["0000", "2222", "3333", "9999"], ["1111", "2222", "3333", "4444"]);
  assert.deepEqual([score.toward, score.away, score.unchanged, score.total_positions], [1, 1, 2, 4]);
  const self = scoreAgainstTarget(["1111", "2222"], ["1111", "2222"], ["9999", "9999"]);
  assert.deepEqual([self.toward, self.away, self.unchanged], [0, 0, 2]);
});

test("verdicts: line-sensitive names the lever; control failure takes priority", () => {
  const [v1, m1] = classifyVerdict(4, 0, { shift_lines: 20 });
  assert.equal(v1, VERDICT_LINE_SENSITIVE);
  for (const s of ["LINE-SENSITIVE", "field-guide lever 23", "acpp"]) assert.ok(m1.includes(s));
  const [v2, m2] = classifyVerdict(0, 0, { shift_lines: 20 });
  assert.equal(v2, VERDICT_NOT_LINE_SENSITIVE);
  assert.ok(m2.includes("NOT line-sensitive"));
  const [v3, m3] = classifyVerdict(4, 2, { shift_lines: 20 });
  assert.equal(v3, VERDICT_NONDETERMINISTIC);
  for (const s of ["NONDETERMINISTIC", "untrustworthy", "20"]) assert.ok(m3.includes(s));
});

// -- end to end --

test("line-sensitive end to end", () => withRoot(async (root) => {
  const report = await probe(root, "sensitive");
  assert.equal(report.verdict, VERDICT_LINE_SENSITIVE);
  assert.ok(report.split_word_diff > 0);
  assert.equal(report.shift_word_diff, 0);
  assert.ok(fs.statSync(report.run_directory).isDirectory());
  for (const n of ["baseline", "split-statements", "global-shift"]) assert.ok(fs.statSync(report.variants[n].object_path).isFile());
}));

test("not line-sensitive, and nondeterministic, end to end", () => withRoot(async (root) => {
  const insensitive = await probe(root, "insensitive");
  assert.equal(insensitive.verdict, VERDICT_NOT_LINE_SENSITIVE);
  assert.equal(insensitive.split_word_diff, 0);
  assert.equal(insensitive.shift_word_diff, 0);
  const nondet = await probe(root, "nondeterministic", { shift_lines: 5 });
  assert.equal(nondet.verdict, VERDICT_NONDETERMINISTIC);
  assert.ok(nondet.shift_word_diff > 0);
}));

test("target scoring reports toward/away/unchanged", () => withRoot(async (root) => {
  const first = await probe(root, "sensitive");
  const report = await probe(root, "sensitive", { target_object: first.variants["split-statements"].object_path });
  const t = report.target;
  assert.ok(t.baseline.mismatched_vs_target > 0);
  assert.equal(t["split-statements"].away, 0);
  assert.ok(t["split-statements"].toward > 0);
  const s = t["split-statements"];
  assert.equal(s.toward + s.away + s.unchanged, s.total_positions);
}));

test("a compile failure points at the captured stderr file and keeps the run directory", () => withRoot(async (root) => {
  await assert.rejects(probe(root, "fail"), (e) => {
    const lines = e.message.split("\n");
    const stderrPath = lines.find((l) => l.startsWith("full stderr:")).slice("full stderr:".length).trim();
    assert.ok(fs.readFileSync(stderrPath, "utf8").includes("synthetic compiler error"));
    const runDir = lines.find((l) => l.startsWith("run directory")).split(":").slice(1).join(":").trim();
    assert.ok(fs.statSync(path.join(runDir, "baseline", "compile.stderr.txt")).isFile());
    return e.name === "RuntimeError";
  });
}));

test("a missing input names where a .i comes from; argument conflicts are refused", () => withRoot(async (root) => {
  const script = writeCompiler(root);
  await assert.rejects(runLineProbe(path.join(root, "missing.i"), { compile_template: template(script, "sensitive"), work_dir: path.join(root, "state"), compile_cwd: root }),
    (e) => e instanceof ProbeOSError && e.message.includes("cc -E"));
  await assert.rejects(probe(root, "sensitive", { target_bytes: path.join(root, "a"), target_object: path.join(root, "b") }), (e) => e instanceof LineProbeError && /mutually exclusive/.test(e.message));
  await assert.rejects(probe(root, "sensitive", { target_offset: 4 }), (e) => e instanceof LineProbeError && /target-offset/.test(e.message));
}));

// -- ties --

const TIE_SOURCE = "int a;\nint b;\nint c;\nint d;\n";

test("a single tie wraps the statement in #line directives; multiple ties use original numbering", () => {
  assert.equal(tieStatementLines(TIE_SOURCE, [[2, 4]]), "int a;\n#line 4\nint b;\n#line 3\nint c;\nint d;\n");
  assert.equal(tieStatementLines(TIE_SOURCE, [[1, 3], [3, 1]]), "#line 3\nint a;\n#line 2\nint b;\n#line 1\nint c;\n#line 4\nint d;\n");
  assert.throws(() => tieStatementLines(TIE_SOURCE, [[9, 1]]), LineProbeError);
  assert.throws(() => tieStatementLines(TIE_SOURCE, [[0, 2]]), LineProbeError);
  const variants = generateVariants(TIE_SOURCE, { ties: [[2, 4]] });
  assert.ok(variants.tie.includes("#line 4"));
  assert.ok(!("tie" in generateVariants(TIE_SOURCE)));
});

test("tie validation refuses inputs that name no statement", () => {
  const src = "int a;\n\n#line 40\nint c;\n";
  assert.throws(() => tieStatementLines(src, [[1, 5], [1, 6]]), (e) => e instanceof LineProbeError && ["statement line 1 twice", "5", "6"].every((s) => e.message.includes(s)));
  assert.throws(() => tieStatementLines(src, [[2, 9]]), (e) => /blank/.test(e.message));
  assert.throws(() => tieStatementLines(src, [[3, 9]]), (e) => /preprocessing directive/.test(e.message));
  assert.ok(tieStatementLines(src, [[4, 900]]).includes("#line 900\n"));
  assert.throws(() => tieStatementLines(src, [[4, 0]]), (e) => /assigned line number/.test(e.message));
});

test("next steps route each verdict", () => {
  const unscored = nextSteps(VERDICT_LINE_SENSITIVE).join("\n");
  assert.ok(unscored.includes("--tie STATEMENT=LINE") && unscored.includes("--target-object"));
  const scored = nextSteps(VERDICT_LINE_SENSITIVE, { target: { baseline: { toward: 0, away: 0 } } });
  assert.equal(scored.length, 1);
  assert.ok(nextSteps(VERDICT_LINE_SENSITIVE, { ties: [[3, 5]] }).join("\n").includes("nothing scored it"));
  const win = nextSteps(VERDICT_LINE_SENSITIVE, { ties: [[3, 5]], target: { tie: { toward: 4, away: 0 } } }).join("\n");
  assert.ok(win.includes("4 site(s) toward") && win.includes("guide 25"));
  const lose = nextSteps(VERDICT_LINE_SENSITIVE, { ties: [[3, 5]], target: { tie: { toward: 1, away: 6 } } }).join("\n");
  assert.ok(lose.includes("not the one") && lose.includes("scoped"));
  assert.ok(nextSteps(VERDICT_NOT_LINE_SENSITIVE).join("\n").includes("guide g0-schedule-probe"));
  assert.deepEqual(nextSteps(VERDICT_NONDETERMINISTIC), []);
});

test("the report records the ties that defined it, or none", () => withRoot(async (root) => {
  const tied = await probe(root, "sensitive", { ties: [[2, 1]] });
  assert.deepEqual(tied.ties, [[2, 1]]);
  assert.notEqual(tied.tie_word_diff, null);
  assert.ok("tie" in tied.variants);
  assert.ok(tied.next_steps.length);
  const plain = await probe(root, "sensitive");
  assert.deepEqual(plain.ties, []);
  assert.equal(plain.tie_word_diff, null);
  assert.ok(!("tie" in plain.variants));
}));

// -- the probe-lines command --

test("probe-lines prints the verdict, variants and next steps; JSON carries the schema", () => withRoot(async (root) => {
  const script = writeCompiler(root), i = input(root);
  const r = await runCommand(["probe-lines", i, "--compile-command", template(script, "sensitive"), "--split-threshold", "10", "--work-dir", path.join(root, "state")], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  for (const s of ["input: unit.i", "function: (whole .text)", "verdict: line-sensitive", "LINE-SENSITIVE", "next: retarget one statement", "run directory:"]) assert.ok(r.stdout.includes(s), s);
  const j = await runCommand(["probe", "lines", i, "--compile-command", template(script, "insensitive"), "--split-threshold", "10", "--work-dir", path.join(root, "state"), "--json"], { cwd: root });
  assert.equal(j.code, 0);
  const doc = JSON.parse(j.stdout);
  assert.equal(doc.schema, "decomp-workbench-line-probe-v1");
  assert.equal(doc.verdict, "not-line-sensitive");
}));

test("probe-lines exits 1 on a nondeterministic control, 2 on a bad tie or compile failure", () => withRoot(async (root) => {
  const script = writeCompiler(root), i = input(root), state = path.join(root, "state");
  const nd = await runCommand(["probe-lines", i, "--compile-command", template(script, "nondeterministic"), "--split-threshold", "10", "--work-dir", state], { cwd: root });
  assert.equal(nd.code, 1);
  assert.ok(nd.stdout.includes("NONDETERMINISTIC COMPILE"));
  const tie = await runCommand(["probe-lines", i, "--compile-command", template(script, "sensitive"), "--tie", "x=3", "--work-dir", state], { cwd: root });
  assert.equal(tie.code, 2);
  assert.ok(tie.stderr.includes("is not STATEMENT=LINE"));
  const fail = await runCommand(["probe-lines", i, "--compile-command", template(script, "fail"), "--work-dir", state], { cwd: root });
  assert.equal(fail.code, 2);
  assert.ok(fail.stderr.startsWith("error: baseline variant failed to compile (exit 1): synthetic compiler error"));
  const env = await runCommand(["probe-lines", i, "--compile-command", template(script, "sensitive"), "--env", "1BAD=x", "--work-dir", state], { cwd: root });
  assert.equal(env.code, 2);
  assert.ok(env.stderr.includes("invalid environment entry"));
  const noCompile = await runCommand(["probe-lines", i, "--json"], { cwd: root });
  assert.equal(noCompile.code, 2);
  assert.match(JSON.parse(noCompile.stdout).error.message, /--compile-command/);
}));

import { parseTies } from "../src/decomp/workbench/line-probe-cli.js";
import { SCHEMAS } from "../src/decomp/workbench/reporting.js";

test("probe-lines help names every variant, where a .i comes from, and the tie flag", async () => {
  const r = await runCommand(["probe-lines", "--help"]);
  assert.equal(r.code, 0);
  const text = r.stdout.split(/\s+/).join(" ");
  for (const s of ["baseline", "split-statements", "global-shift", "cc -E", "-K", "field-guide lever 23", "LINE-SENSITIVE", "NONDETERMINISTIC", "--tie STATEMENT=LINE", "tie - wrap each"]) assert.ok(text.includes(s), s);
  assert.ok("probe-lines" in SCHEMAS);
});

test("the grouped spelling is an exact alias for bad input", async () => {
  const flat = await runCommand(["probe-lines", "missing.i", "--compile-command", "cc {input} {output}"]);
  const grouped = await runCommand(["probe", "lines", "missing.i", "--compile-command", "cc {input} {output}"]);
  assert.deepEqual(flat, grouped);
  assert.equal(flat.code, 2);
  assert.ok(flat.stderr.startsWith("error: ") && flat.stderr.includes("cc -E"));
});

test("ties parse repeatably and malformed entries are refused", () => {
  assert.deepEqual(parseTies(["83=88", "178=183"]), [[83, 88], [178, 183]]);
  for (const bad of ["83", "83=", "=88", "a=b", "83:88"]) assert.throws(() => parseTies([bad]));
});

test("a missing function is an error with no stack trace; the report prints ties and next steps", () => withRoot(async (root) => {
  const script = writeCompiler(root), i = input(root), state = path.join(root, "state");
  const miss = await runCommand(["probe-lines", i, "--compile-command", template(script, "sensitive"), "--function", "nope", "--work-dir", state], { cwd: root });
  assert.equal(miss.code, 2);
  assert.equal(miss.stdout, "");
  assert.ok(miss.stderr.startsWith("error: ") && !miss.stderr.includes("    at ") && miss.stderr.includes("whole-.text mode") && miss.stderr.includes("IDO"));
  const tied = await runCommand(["probe-lines", i, "--compile-command", template(script, "sensitive"), "--split-threshold", "10", "--tie", "2=1", "--work-dir", state], { cwd: root });
  assert.equal(tied.code, 0);
  for (const s of ["ties: 2->1", "tie vs baseline:", "next: "]) assert.ok(tied.stdout.includes(s), s);
  const mutex = await runCommand(["probe-lines", i, "--compile-command", template(script, "sensitive"), "--target-bytes", "a", "--target-object", "b", "--work-dir", state], { cwd: root });
  assert.equal(mutex.code, 2);
  assert.ok(mutex.stderr.includes("mutually exclusive"));
}));
