// The two source questions one campaign could not ask its tools:
// probe-equiv (are two reads of a non-escaping local the same value) and
// probe-deadread (where can a statement that emits nothing still move the
// allocator). Ported from the workbench's source-probe tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CSourceError, scanStatements, stripNoncode } from "../src/decomp/workbench/csource.js";
import { SPELLINGS, deadReadReport, valueEqualityReport } from "../src/decomp/workbench/source-probe.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const SOURCE = `void demo(Object *obj) {
    f32 sp4B8;
    f32 sp4A0;
    s32 i;

    if (obj->flags) {
        sp4B8 = obj->x * obj->x;
        sp4A0 = angle(sp4B8);
        if (obj->near) {
            sp4B8 += obj->y * obj->y;
            sp4A0 = angle(sp4B8);
        }
        limit(sp4B8);
        for (i = 0; i < 4; i++) {
            step(sp4B8);
        }
    }
    tail(sp4A0);
}
`;
const ADDRESS_SOURCE = "void demo(void) {\n    f32 v;\n\n    v = 1.0f;\n    read(v);\n    fill(&v);\n    read(v);\n}\n";
const GOTO_SOURCE = "void demo(void) {\n    f32 v;\n\n    v = 1.0f;\n    read(v);\nagain:\n    read(v);\n    goto again;\n}\n";

function written(text, name = "work.c") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-sprobe-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return { file, dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function withFile(text, fn) { const w = written(text); try { return fn(w.file, w); } finally { w.done(); } }
async function withFileAsync(text, fn) { const w = written(text); try { return await fn(w.file, w); } finally { w.done(); } }

// -- csource --

test("comments and strings cannot create a definition", () => {
  const lines = stripNoncode('int a; /* v = 1; */ char *s = "v = 2;"; // v = 3;\n');
  for (const s of ["v = 1", "v = 2", "v = 3"]) assert.ok(!lines[0].includes(s));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("int a;"));
});

test("a sibling branch does not reach a later statement; an enclosing block does", () => {
  const s = new Map(scanStatements(stripNoncode("void f(void) {\n    if (a) {\n        v = 1;\n    }\n    if (b) {\n        read(v);\n    }\n}\n")).map((x) => [x.line, x]));
  assert.equal(s.get(3).depth, s.get(6).depth);
  assert.equal(s.get(6).reachedFrom(s.get(3)), false);
  const e = new Map(scanStatements(stripNoncode("void f(void) {\n    v = 1;\n    if (b) {\n        read(v);\n    }\n}\n")).map((x) => [x.line, x]));
  assert.equal(e.get(4).reachedFrom(e.get(2)), true);
});

test("a loop body is named and a do-while closes it", () => {
  const s = new Map(scanStatements(stripNoncode("void f(void) {\n    do {\n        step();\n    } while (c);\n    after();\n}\n")).map((x) => [x.line, x]));
  assert.equal(s.get(3).in_loop, true);
  assert.equal(s.get(5).in_loop, false);
});

// -- value equality --

test("two reads with no definition between them are one value", () => withFile(SOURCE, (p) => {
  const report = valueEqualityReport(p, { variable: "sp4B8", positions: [11, 13] });
  assert.equal(report.callee_safe, true);
  assert.equal(report.pairs[0].verdict, "SAME-VALUE");
  assert.ok(report.pairs[0].reasons[0].includes("no definition between them"));
}));

test("a definition between them is named as the reason", () => withFile(SOURCE, (p) => {
  const pair = valueEqualityReport(p, { variable: "sp4B8", positions: [8, 13] }).pairs[0];
  assert.equal(pair.verdict, "NOT-PROVEN");
  assert.ok(pair.reasons[0].includes("definition at line 10"));
}));

test("an escaping address withdraws the purity argument", () => withFile(ADDRESS_SOURCE, (p) => {
  const report = valueEqualityReport(p, { variable: "v", positions: [5, 7] });
  assert.equal(report.callee_safe, false);
  assert.deepEqual(report.address_taken_at, [6]);
  assert.equal(report.pairs[0].verdict, "NOT-PROVEN");
}));

test("a label makes textual order stop describing control flow", () => withFile(GOTO_SOURCE, (p) => {
  const report = valueEqualityReport(p, { variable: "v", positions: [5, 7] });
  assert.ok(report.ranges[0].control_breaks.length);
  assert.equal(report.pairs[0].verdict, "NOT-PROVEN");
}));

test("the ranges partition the reads by definition", () => withFile(SOURCE, (p) => {
  const report = valueEqualityReport(p, { variable: "sp4B8" });
  assert.deepEqual(report.definitions, [7, 10]);
  assert.deepEqual(report.ranges.map((r) => r.defined_at), [7, 10]);
  assert.deepEqual(report.ranges[0].reads, [8]);
}));

test("an unknown identifier is an error that says why", () => withFile(SOURCE, (p) => {
  assert.throws(() => valueEqualityReport(p, { variable: "nosuchlocal" }), (e) => e instanceof CSourceError && e.message.includes("struct or union member"));
}));

// -- dead reads --

test("only positions a definition reaches are candidates", () => withFile(SOURCE, (p) => {
  const report = deadReadReport(p, { variable: "sp4A0" });
  const lines = report.candidates.map((c) => c.line);
  assert.ok(lines.includes(13));
  assert.ok(!lines.includes(18));
  assert.ok(report.candidates.every((c) => c.dominated));
}));

test("the textual reach widens the set and marks it", () => withFile(SOURCE, (p) => {
  const narrow = deadReadReport(p, { variable: "sp4A0" }), wide = deadReadReport(p, { variable: "sp4A0", reach: "textual" });
  assert.ok(wide.candidate_count > narrow.candidate_count);
  assert.ok(wide.candidates.map((c) => c.line).includes(18));
  assert.ok(wide.candidates.some((c) => !c.dominated));
  assert.equal(wide.dominated_count, narrow.candidate_count);
}));

test("loop positions are marked and ranked last", () => withFile(SOURCE, (p) => {
  const report = deadReadReport(p, { variable: "sp4B8", reach: "textual" });
  const inLoop = report.candidates.filter((c) => c.in_loop);
  assert.ok(inLoop.length);
  assert.equal(inLoop[inLoop.length - 1], report.candidates[report.candidates.length - 1]);
  assert.ok(report.loop_free_count < report.candidate_count);
}));

test("the patch keeps the line indentation", () => withFile(SOURCE, (p) => {
  const patch = deadReadReport(p, { variable: "sp4B8" }).candidates[0].patches[0];
  assert.equal(patch.spelling, "if (V != 0.0f);");
  assert.ok(patch.insert.startsWith("        "));
  assert.ok(patch.insert.includes("if (sp4B8 != 0.0f);"));
}));

test("the spelling table separates the inert from the costly", () => {
  const s = new Map(SPELLINGS.map((x) => [x.text, x]));
  assert.ok(s.get("V = 0.0f;").note.includes("INERT"));
  assert.ok(s.get("V = V;").note.includes("INERT"));
  assert.equal(s.get("if (V);").footprint, "0 or +2");
  assert.equal(s.get("if (V != 0.0f);").footprint, "0");
});

test("a variable that is never assigned is an error", () => withFile("void f(void) {\n    f32 v;\n    read(v);\n}\n", (p) => {
  assert.throws(() => deadReadReport(p, { variable: "v" }), (e) => e instanceof CSourceError && e.message.includes("there is nothing to read"));
}));

// -- commands --

test("probe-equiv prints the verdict and its limits; JSON carries the schema", () => withFileAsync(SOURCE, async (p) => {
  const r = await runCommand(["probe-equiv", p, "--variable", "sp4B8", "--at", "11", "--at", "13"]);
  assert.equal(r.code, 0);
  for (const s of ["SAME-VALUE", "address is never taken", "what this does not know:"]) assert.ok(r.stdout.includes(s), s);
  const j = await runCommand(["probe-equiv", p, "--variable", "sp4B8", "--json"]);
  assert.equal(j.code, 0);
  const doc = JSON.parse(j.stdout);
  assert.equal(doc.schema, "decomp-workbench-value-equality-v1");
  assert.equal(doc.callee_safe, true);
}));

test("probe-deadread prints the table and a patch", () => withFileAsync(SOURCE, async (p) => {
  const r = await runCommand(["probe-deadread", p, "--variable", "sp4B8"]);
  assert.equal(r.code, 0);
  for (const s of ["dead-read probe:", "if (sp4B8 != 0.0f);", "INERT"]) assert.ok(r.stdout.includes(s), s);
}));

test("probe-deadread writes one variant per candidate", () => withFileAsync(SOURCE, async (p, w) => {
  const out = path.join(w.dir, "variants");
  const r = await runCommand(["probe-deadread", p, "--variable", "sp4B8", "--limit", "2", "--write", out]);
  assert.equal(r.code, 0);
  const files = fs.readdirSync(out).filter((f) => f.endsWith(".c")).sort();
  assert.equal(files.length, 2);
  assert.ok(r.stdout.includes("wrote 2 variant source(s)"));
  const first = fs.readFileSync(path.join(out, files[0]), "utf8").split("\n").slice(0, -1);
  assert.ok(first.some((l) => l.includes("if (sp4B8 != 0.0f);")));
  assert.equal(first.length, SOURCE.split("\n").length - 1 + 1);
}));

test("probe-deadread JSON carries the schema and the reach", () => withFileAsync(SOURCE, async (p) => {
  const r = await runCommand(["probe-deadread", p, "--variable", "sp4B8", "--reach", "textual", "--json"]);
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.schema, "decomp-workbench-dead-read-v1");
  assert.equal(doc.reach, "textual");
}));

test("an unreadable source reports JSON rather than bare text", async () => {
  const r = await runCommand(["probe-equiv", "/nonexistent/work.c", "--variable", "v", "--json"]);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout).schema, "decomp-workbench-error-v1");
});

test("the grouped spellings reach the same commands", () => withFileAsync(SOURCE, async (p) => {
  const r = await runCommand(["probe", "equiv", p, "--variable", "sp4B8"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("value equality:"));
  const d = await runCommand(["probe", "deadread", p, "--variable", "sp4B8", "--limit", "1"]);
  assert.equal(d.code, 0);
}));

test("the shipped example source is the fixture", () => {
  assert.equal(fs.readFileSync(new URL("./fixtures/workbench/value-equality.c", import.meta.url), "utf8"), SOURCE);
});
