// Ported from the workbench's presentation tests: HTML parity with the
// screen, verdict colour, width never suppressing evidence, context-row
// annotations, lane units, the guidance footer, orientation notes, and the
// properties the presentation layer may never cost.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { buildView } from "../src/decomp/workbench/view.js";
import { renderDiagnosisHtml } from "../src/decomp/workbench/html-report.js";
import { Painter, visibleLength } from "../src/decomp/workbench/terminal.js";
import { renderView } from "../src/decomp/workbench/view-cli.js";
import { commandSpecs } from "../src/decomp/workbench/cli.js";
import { runCli } from "./fixtures/workbench/cli-run.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workbench");
const PT = path.join(FIX, "phase-shift-target.objdump.txt"), PC = path.join(FIX, "phase-shift-candidate.objdump.txt");
const ST = path.join(FIX, "shifted-insertion-target.objdump.txt"), SC = path.join(FIX, "shifted-insertion-candidate.objdump.txt");
const SYMBOL = "demo";
const PROLOGUE = ["addiu sp,sp,-32", "sw ra,28(sp)"];
const body = (...i) => [...PROLOGUE, ...i, "lw ra,28(sp)", "jr ra", "addiu sp,sp,32"];
const viewOf = (t, c) => buildView(parseDisassembly(assemble(t, { symbol: SYMBOL }), { symbol: SYMBOL }), parseDisassembly(assemble(c, { symbol: SYMBOL }), { symbol: SYMBOL }),
  { target_name: "target", candidate_name: "candidate", symbol: SYMBOL });
const phaseView = () => buildView(parseDisassembly(fs.readFileSync(PT, "utf8"), { symbol: "animStep" }), parseDisassembly(fs.readFileSync(PC, "utf8"), { symbol: "animStep" }),
  { target_name: "target.objdump", candidate_name: "candidate.objdump", symbol: "animStep" });
const DOC = renderDiagnosisHtml(phaseView());

test("HTML: hunks are linkable sections with context and divergence rows and real annotation cells", () => {
  for (const s of ['<section class="hunk" id="hunk-1">', '<h3><a href="#hunk-1">Hunk 1</a></h3>', '<tr class="diverge">', '<tr class="context">',
    "t7-&gt;t8 [w1]", 'href="#web-1"', 'class="swatch"']) assert.ok(DOC.includes(s), s);
});

test("HTML: webs link to their hunks; lanes mark the divergence; the verdict is sticky; the blob is still there", () => {
  for (const s of ['<tr id="web-1">', "<h2>Webs</h2>", '<a href="#hunk-1">hunk 1</a>', "<h2>Register lanes</h2>", 'class="slot-diverge"',
    "slot=5 aligned_row=12 rotation=+1", 'class="verdict-bar"', "position: sticky", "Machine-readable evidence", '<pre id="report">']) assert.ok(DOC.includes(s), s);
});

test("HTML: self-contained, semantic, accessible, and the identity chip never claims the site score", () => {
  assert.ok(!DOC.includes("<script")); assert.deepEqual(DOC.match(/(?:src|href)="https?:/g) ?? [], []);
  for (const s of ['scope="col"', 'scope="row"', '<html lang="en">', '<meta name="theme-color"', '<a class="skip-link" href="#main-content">', '<main id="main-content">',
    "<details open>", "<caption>", 'class="table-scroll"', ":focus-visible", "details > * { display: block !important; }", "aligned identical 18/24", "not decomp.me"]) assert.ok(DOC.includes(s), s);
});

test("HTML: an input warning survives the export; the command still writes it", async () => {
  const view = buildView(parseDisassembly(assemble(body("lw t8,0(s0)"), { symbol: SYMBOL })), parseDisassembly(assemble(body("lw t6,0(s0)"), { symbol: SYMBOL })),
    { target_name: "a", candidate_name: "b", warnings: ["target defines 'x' but candidate defines 'y'"] });
  const doc = renderDiagnosisHtml(view);
  assert.ok(doc.includes('class="warning"')); assert.ok(doc.includes("candidate defines &#x27;y&#x27;"));
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-pres-")), "report.html");
  const [status] = await runCli(["diagnose-dumps", PT, PC, "--function", "animStep", "--html", out, "--pager", "never"]);
  assert.equal(status, 0); assert.ok(fs.readFileSync(out, "utf8").includes('id="hunk-1"'));
});

test("verdict colour: the verdict is the emphasized token; each family has its hue; unknown verdicts render", async () => {
  const [status, out] = await runCli(["compare-dumps", PT, PC, "--function", "animStep", "--color", "always"]);
  assert.equal(status, 0);
  assert.ok(out.includes("\x1b[1mverdict=\x1b[0m")); assert.ok(out.includes("\x1b[1;31mallocation-mismatch\x1b[0m"));
  const p = new Painter(true);
  assert.equal(new Set(["exact", "constant", "schedule", "structure", "allocation"].map((n) => p.verdict(n))).size, 5);
  assert.ok(p.verdict("mixed(register:2, constant:1)").includes("mixed(register:2, constant:1)"));
});

test("every comparison command can be colourized; --color never is respected", async () => {
  const specs = await commandSpecs();
  for (const c of ["compare", "compare-dumps", "rank", "diagnose", "view"]) assert.ok(specs.get(c).arguments.some((a) => a.flags?.includes("--color")), c);
  const [, plain] = await runCli(["compare-dumps", PT, PC, "--function", "animStep", "--color", "never"]);
  assert.ok(!plain.includes("\x1b["));
});

test("a narrow width wraps the annotation instead of cutting it; every wrapped line fits; unlimited keeps it inline", async () => {
  const [status, out] = await runCli(["view-dumps", PT, PC, "--function", "animStep", "--pager", "never", "--width", "60"]);
  assert.equal(status, 0);
  const hunk = out.split("HUNK 1")[1].split("WEBS")[0];
  const rows = hunk.split("\n").filter((l) => l.includes("|") || l.includes("[w"));
  assert.ok(!rows.join("\n").includes("…"));
  for (const label of ["t7->t8 [w1]", "t8->t9 [w2]", "t9->t6 [w3]", "t6->t7 [w4]"]) assert.ok(out.includes(label), label);
  for (const line of renderView(phaseView(), { width: 60 })) if (line.includes("[w")) assert.ok(visibleLength(line) <= 60, line);
  assert.ok(renderView(phaseView(), { width: 0 }).join("\n").includes("lw $t8,20($t7)    | lw $t9,20($t8)     t8->t9 [w2]"));
});

test("a context row in a known web names the web", () => {
  const t = body("lw t8,0(s0)", "addu t1,t1,t1", "lw t8,4(s0)", "addu t2,t2,t2", "lw t8,8(s0)");
  const c = body("lw t6,0(s0)", "addu t1,t1,t1", "lw t6,4(s0)", "addu t2,t2,t2", "lw t6,8(s0)");
  const screen = renderView(viewOf(t, c), { max_hunks: 1 }).join("\n");
  const annotated = screen.split("\n").filter((l) => l.includes("t8->t6"));
  assert.ok(annotated.length >= 2); assert.ok(!screen.includes("  register\n"));
  assert.ok(annotated.some((l) => l.includes(" > "))); assert.ok(annotated.some((l) => !l.includes(" > ")));
});

async function screen(...extra) { const [, out] = await runCli(["view-dumps", PT, PC, "--function", "animStep", "--pager", "never", ...extra]); return out; }

test("the caret names both units", async () => {
  const out = await screen();
  assert.ok(out.includes("slot=5 aligned_row=12 rotation=+1")); assert.ok(!out.includes("divergence=5")); assert.ok(!out.includes("index=12"));
});

test("the footer wraps instead of cutting, keeps the dead-family warning, and continuations are indented", async () => {
  const narrow = (await screen("--width", "60")).split("next: ", 2)[1];
  assert.ok(!narrow.includes("…")); assert.ok(Math.max(...narrow.split("\n").map((l) => l.length)) <= 60);
  assert.ok(narrow.includes("does not establish")); assert.ok((await screen()).split("next: ", 2)[1].includes("does not establish"));
  const entries = narrow.split("\n").filter((l) => l.startsWith("      "));
  assert.ok(entries.some((l) => l.startsWith("        ")));
  assert.ok((await screen()).split("next: ", 2)[1].includes("a rotation of visible registers does not establish a changed demand order"));
});

test("orientation notes print by default; --terse drops them and nothing else; diagnose offers the same switch", async () => {
  const full = await screen(), terse = await screen("--terse");
  for (const s of ["signature reads left to right", "pool = uopt's colored variable webs", "labels defined: decomp-workbench --explain-keys"]) assert.ok(full.includes(s), s);
  for (const s of ["signature reads left to right", "pool = uopt's colored", "labels defined:"]) assert.ok(!terse.includes(s), s);
  for (const s of ["verdict: register-permutation", "REGISTER LANES", "WEBS", "[w1]", "next:"]) assert.ok(terse.includes(s), s);
  assert.ok(terse.length < full.length);
  const [, d] = await runCli(["diagnose-dumps", PT, PC, "--function", "animStep", "--pager", "never", "--terse"]);
  assert.ok(!d.includes("signature reads left to right")); assert.ok(d.includes("MECHANISM"));
});

test("HTML guidance: lever and prose commands are marked up and need no network", () => {
  assert.ok(DOC.includes("<code>decomp-workbench guide register-role-audit</code>"));
  assert.ok(!DOC.includes("<script")); assert.deepEqual(DOC.match(/href="https?:/g) ?? [], []);
});

test("must not break: a shifted insertion stays one structural row; webs print in full under hunk truncation", async () => {
  const [status, out] = await runCli(["view-dumps", ST, SC, "--pager", "never"]);
  assert.equal(status, 0); for (const s of ["structural=1", "register=0", "hunks=1"]) assert.ok(out.includes(s), s);
  const t = body(...Array.from({ length: 6 }, (_, i) => `lw t8,${i * 4}(s0)`));
  const c = body(...Array.from({ length: 6 }, (_, i) => `lw t6,${i * 4}(s0)`));
  for (const i of [1, 3, 5]) c[PROLOGUE.length + i] = t[PROLOGUE.length + i];
  const view = viewOf(t, c);
  const s = renderView(view, { max_hunks: 1 }).join("\n");
  assert.ok(s.includes("further hunk(s) not shown")); assert.ok(!s.includes("HUNK 2"));
  assert.ok(s.includes(`count=${view.webs[0].count}`));
  for (const row of view.webs[0].rows) assert.ok(s.split("WEBS")[1].includes(String(row)));
});

test("must not break: the caret lands under the first divergent slot", () => {
  const s = renderView(phaseView());
  const cand = s.find((l) => l.trimStart().startsWith("candidate  t6 t7"));
  const caret = s.find((l) => l.includes("^ slot=5"));
  const cells = cand.split("candidate  ")[1];
  const offset = cand.indexOf("candidate  ") + "candidate  ".length;
  const slot5 = offset + cells.split(/\s+/).filter(Boolean).slice(0, 5).reduce((a, c) => a + c.length + 1, 0);
  assert.equal(caret.indexOf("^"), slot5);
});

test("must not break: monochrome keeps every label; one web keeps one colour; painted registers keep the column", () => {
  const mono = renderView(phaseView(), { painter: new Painter(false) }).join("\n");
  const colored = renderView(phaseView(), { painter: new Painter(true) });
  assert.ok(!mono.includes("\x1b["));
  for (const l of ["[w1]", "[w2]", "[w3]", "[w4]"]) { assert.ok(mono.includes(l)); assert.ok(colored.join("\n").includes(l)); }
  const text = colored.join("\n");
  const first = /\x1b\[(\d+)m[^\x1b]*t7->t8 \[w1\]/.exec(text), summary = /\x1b\[(\d+)mw1 t7->t8/.exec(text);
  assert.ok(first && summary); assert.equal(first[1], summary[1]);
  const cols = new Set(colored.filter((l) => /^\s+\d+ [ >] /.test(l) && l.includes("|")).map((l) => visibleLength(l.split("|")[0])));
  assert.equal(cols.size, 1);
});
