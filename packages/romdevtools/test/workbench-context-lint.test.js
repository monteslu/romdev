// The preprocessor-conditional audit: evaluator, findings, multi-file and
// the `context` commands. Ported from the workbench's context-lint tests.
// Evaluated values are exact integers (BigInt).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExpressionError, _tokenize, analyzeExpression, duplicateFileScopeDefinitions, fileScopeDefinitions, lintFiles, lintSources,
  parseDefines, renderReport, scanConditionals, stripComments } from "../src/decomp/workbench/context-lint.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const defs = (o) => new Map(Object.entries(o));
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-ctxlint-")));
const withDir = (fn) => async () => { const d = tmp(); try { await fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); } };
const TRAP = "#if BUILD_VERSION >= VERSION_J\ncase DRAW_SOMETHING:\n#endif\n";

test("bare literals need no macro table", () => {
  const a = analyzeExpression("1 + 2 * 3", {});
  assert.ok(a.ok); assert.equal(a.value, 7n); assert.deepEqual(a.value_identifiers, []);
});

test("precedence matches C", () => {
  const cases = { "2 + 3 * 4": 14n, "(2 + 3) * 4": 20n, "1 << 2 + 1": 8n, "1 | 0 && 0": 0n, "4 - 2 - 1": 1n, "2 == 1 + 1": 1n,
    "!0 && !1": 0n, "~0": -1n, "-3 % 2": -1n, "-7 / 2": -3n };
  for (const [e, v] of Object.entries(cases)) { const a = analyzeExpression(e, {}); assert.ok(a.ok, a.error); assert.equal(a.value, v, e); }
});

test("ternary evaluates the selected branch", () => {
  assert.equal(analyzeExpression("1 ? 10 : 20", {}).value, 10n);
  assert.equal(analyzeExpression("0 ? 10 : 20", {}).value, 20n);
});

test("defined checks presence without becoming a value identifier", () => {
  let a = analyzeExpression("defined(FOO)", defs({ FOO: null }));
  assert.ok(a.ok); assert.equal(a.value, 1n); assert.deepEqual(a.value_identifiers, []);
  a = analyzeExpression("defined FOO", {});
  assert.equal(a.value, 0n); assert.deepEqual(a.value_identifiers, []);
});

test("defined and bare reference are independent", () => {
  const a = analyzeExpression("defined(FOO) && BAR", defs({ FOO: null }));
  assert.equal(a.value, 0n);
  assert.deepEqual(a.value_identifiers, ["BAR"]);
  assert.deepEqual(a.undefined_identifiers, ["BAR"]);
});

test("a defined macro with a value substitutes it; without one it is 1", () => {
  const a = analyzeExpression("VERSION >= 3", defs({ VERSION: 5n }));
  assert.equal(a.value, 1n); assert.deepEqual(a.defined_identifiers, ["VERSION"]); assert.deepEqual(a.undefined_identifiers, []);
  assert.equal(analyzeExpression("FLAG", defs({ FLAG: null })).value, 1n);
});

test("an undefined bare identifier collapses to zero; the trap expression is true", () => {
  const a = analyzeExpression("BUILD_VERSION", {});
  assert.equal(a.value, 0n); assert.deepEqual(a.undefined_identifiers, ["BUILD_VERSION"]);
  const t = analyzeExpression("BUILD_VERSION >= VERSION_J", {});
  assert.ok(t.ok); assert.equal(t.value, 1n); assert.deepEqual(t.undefined_identifiers, ["BUILD_VERSION", "VERSION_J"]);
});

test("a function-like reference still collects argument identifiers", () => {
  const a = analyzeExpression("FOO(BAR, 1)", {});
  assert.ok(a.ok); assert.ok(a.value_identifiers.includes("FOO")); assert.ok(a.value_identifiers.includes("BAR"));
});

test("unparseable and divide-by-zero expressions are reported, not raised", () => {
  const a = analyzeExpression("(1 +", {});
  assert.equal(a.ok, false); assert.ok(a.error); assert.equal(a.value, null);
  for (const e of ["1 / 0", "1 % 0"]) assert.equal(analyzeExpression(e, {}).ok, false);
});

test("char, hex and octal literals; exact beyond 53 bits", () => {
  const cases = { "'A'": 65n, "0x2A": 42n, "052": 42n, "'\\n'": 10n, "0xFFFFFFFFFFFFFFFF": 0xFFFFFFFFFFFFFFFFn };
  for (const [e, v] of Object.entries(cases)) assert.equal(analyzeExpression(e, {}).value, v, e);
});

test("the tokenizer rejects unknown characters", () => {
  assert.throws(() => _tokenize("FOO $ BAR"), ExpressionError);
});

test("comments are blanked, lines survive, strings keep their markers", () => {
  const text = "a // comment\nb /* block\nspans */ c\n";
  const s = stripComments(text);
  assert.equal(s.split("\n").length, text.split("\n").length);
  assert.ok(!s.includes("comment") && !s.includes("spans") && s.includes("a") && s.includes("c"));
  assert.ok(stripComments('const char *s = "http://example.com";\n').includes("http://example.com"));
});

test("all undefined and true is high severity", () => {
  const f = scanConditionals("#if BUILD_VERSION >= VERSION_J\ncase DRAW_SOMETHING:\n    do_thing();\n#endif\n", "drawbitmap.c", new Map());
  assert.equal(f.length, 1);
  const x = f[0];
  assert.equal(x.kind, "always-true-by-absence"); assert.equal(x.severity, "high"); assert.equal(x.directive, "if"); assert.equal(x.line, 1);
  assert.equal(x.region_first_line, 2); assert.equal(x.region_last_line, 3); assert.equal(x.region_line_count, 2);
  assert.equal(x.region_first_source_line, "case DRAW_SOMETHING:");
  assert.deepEqual(new Set(x.undefined_identifiers), new Set(["BUILD_VERSION", "VERSION_J"]));
  assert.ok(x.action.includes("define"));
});

test("all undefined and false is informational; mixed is noted", () => {
  const f = scanConditionals("#if OLD_FEATURE_A && OLD_FEATURE_B\ndead_code();\n#endif\n", "legacy.c", new Map());
  assert.equal(f[0].kind, "always-false-by-absence"); assert.equal(f[0].severity, "info");
  const m = scanConditionals("#if KNOWN_FLAG && UNKNOWN_FLAG\nmaybe();\n#endif\n", "mixed.c", defs({ KNOWN_FLAG: 1n }));
  assert.equal(m[0].kind, "mixed-defined-undefined");
  assert.deepEqual(m[0].undefined_identifiers, ["UNKNOWN_FLAG"]);
  assert.deepEqual(m[0].defined_identifiers, ["KNOWN_FLAG"]);
});

test("an unparseable expression is its own class", () => {
  const f = scanConditionals("#if (BROKEN\nnever();\n#endif\n", "broken.c", new Map());
  assert.equal(f[0].kind, "unparseable-expression"); assert.equal(f[0].severity, "note"); assert.ok(f[0].action.includes("could not parse"));
});

test("fully defined and pure defined() guards produce no finding", () => {
  assert.deepEqual(scanConditionals("#if VERSION >= 3\ncase A:\n#endif\n", "fine.c", defs({ VERSION: 5n })), []);
  assert.deepEqual(scanConditionals("#if defined(FEATURE)\ncase A:\n#endif\n", "fine.c", new Map()), []);
});

test("elif is scanned the same way; an empty region reports zero lines", () => {
  const f = scanConditionals("#if 0\nnever();\n#elif BUILD_VERSION >= VERSION_J\ncase DRAW_SOMETHING:\n#endif\n", "drawbitmap.c", new Map());
  assert.equal(f.length, 1); assert.equal(f[0].directive, "elif"); assert.equal(f[0].line, 3);
  const e = scanConditionals("#if BUILD_VERSION >= VERSION_J\n#endif\n", "empty.c", new Map());
  assert.equal(e[0].region_line_count, 0); assert.equal(e[0].region_first_source_line, "");
});

test("findings are sorted most severe first", () => {
  const r = lintSources([["one.c", "#if OLD_A && OLD_B\ndead();\n#endif\n#if BUILD_VERSION >= VERSION_J\ncase X:\n#endif\n"]]);
  assert.equal(r.findings.length, 2); assert.equal(r.findings[0].severity, "high"); assert.equal(r.findings[1].severity, "info");
});

test("defines accumulate across files, seed from flags, and #undef removes", () => {
  const body = "#if BUILD_VERSION >= VERSION_J\ncase X:\n#endif\n";
  const r = lintSources([["header.h", "#define BUILD_VERSION 3\n#define VERSION_J 5\n"], ["body.c", body]]);
  assert.deepEqual(r.findings, []); assert.equal(r.defines.get("BUILD_VERSION"), 3n); assert.equal(r.defines.get("VERSION_J"), 5n);
  assert.deepEqual(lintSources([["body.c", body]], defs({ BUILD_VERSION: 3n, VERSION_J: 5n })).findings, []);
  const u = lintSources([["a.c", "#define FLAG 1\n"], ["b.c", "#undef FLAG\n#if FLAG\ncase X:\n#endif\n"]]);
  assert.equal(u.findings.length, 1); assert.equal(u.findings[0].kind, "always-false-by-absence");
});

test("a computed define participates in later arithmetic; function-like macros are unknown", () => {
  const r = lintSources([["one.c", "#define A 2\n#define B (A + 1)\n#if B >= 4\ncase X:\n#endif\n"]]);
  assert.deepEqual(r.findings, []); assert.equal(r.defines.get("B"), 3n);
  const f = lintSources([["one.c", "#define MAX(a, b) ((a) > (b) ? (a) : (b))\n"]]);
  assert.ok(f.defines.has("MAX")); assert.equal(f.defines.get("MAX"), null);
});

test("line continuation is spliced before directive parsing", () => {
  const f = scanConditionals("#if BUILD_VERSION \\\n    >= VERSION_J\ncase X:\n#endif\n", "spliced.c", new Map());
  assert.equal(f.length, 1); assert.equal(f[0].kind, "always-true-by-absence");
});

test("parse_defines: bare, valued, chained and invalid entries", () => {
  assert.equal(parseDefines(["FOO"]).get("FOO"), null);
  assert.equal(parseDefines(["VERSION=5"]).get("VERSION"), 5n);
  assert.equal(parseDefines(["A=2", "B=A+1"]).get("B"), 3n);
  assert.throws(() => parseDefines(["1BAD=2"]), { name: "ValueError" });
});

test("file-scope definitions: statics, signatures, locals, prototypes, externs, typedefs", () => {
  assert.deepEqual([...fileScopeDefinitions("static int *prev_bmbuf = 0;\n")], [["prev_bmbuf", 1]]);
  assert.equal(fileScopeDefinitions("s32 demo(void) {\n    return 1;\n}\n").get("demo"), 1);
  assert.ok(!fileScopeDefinitions("void f(void) {\n    int x = 0;\n}\n").has("x"));
  assert.equal(fileScopeDefinitions("void f(int x);\n").size, 0);
  assert.equal(fileScopeDefinitions("extern int shared_counter;\n").size, 0);
  assert.ok(fileScopeDefinitions("typedef unsigned int u32;\n").has("u32"));
});

test("duplicates retain every source and line", () => {
  const f = duplicateFileScopeDefinitions([["ctx.c", "static int shared = 0;\nint only_ctx = 1;\n"], ["code.c", "\nstatic int shared = 2;\n"], ["extra.c", "static int shared = 3;\n"]]);
  assert.equal(f.length, 1); assert.equal(f[0].symbol, "shared");
  assert.deepEqual(f[0].occurrences, [{ source: "ctx.c", line: 1 }, { source: "code.c", line: 2 }, { source: "extra.c", line: 1 }]);
});

test("context duplicates is machine-readable and gateable", withDir(async (root) => {
  fs.writeFileSync(path.join(root, "ctx.c"), "static int shared = 0;\n");
  fs.writeFileSync(path.join(root, "code.c"), "static int shared = 1;\n");
  const r = await runCommand(["context", "duplicates", path.join(root, "ctx.c"), path.join(root, "code.c"), "--fail-on-findings", "--json"], { cwd: root });
  const payload = JSON.parse(r.stdout);
  assert.equal(r.code, 1); assert.equal(r.stderr, "");
  assert.equal(payload.schema, "decomp-workbench-context-duplicates-v1"); assert.equal(payload.findings[0].symbol, "shared");
  const one = await runCommand(["context", "duplicates", path.join(root, "ctx.c")], { cwd: root });
  assert.equal(one.code, 2); assert.equal(one.stderr, "error: context duplicates requires at least two files\n");
}));

test("files are read in order and defines accumulate across them", withDir((root) => {
  const header = path.join(root, "header.h"), body = path.join(root, "body.c");
  fs.writeFileSync(header, "#define BUILD_VERSION 3\n#define VERSION_J 5\n");
  fs.writeFileSync(body, "#if BUILD_VERSION >= VERSION_J\ncase X:\n#endif\n");
  const r = lintFiles([header, body]);
  assert.deepEqual(r.files, [header, body]); assert.deepEqual(r.findings, []);
}));

test("render: zero findings is one calm line; a finding shows its first line and an action", () => {
  const lines = renderReport(lintSources([["a.c", "int x;\n"]]));
  assert.equal(lines.length, 2); assert.ok(lines[0].includes("0 finding")); assert.ok(lines[1].includes("no undefined-identifier collapse"));
  const text = renderReport(lintSources([["drawbitmap.c", TRAP]])).join("\n");
  assert.ok(text.includes("DRAW_SOMETHING") && text.includes("do:") && text.includes("HIGH"));
  assert.equal(text, "context lint: 1 finding(s) across 1 file(s)\n[HIGH] always-true-by-absence  drawbitmap.c:1  #if BUILD_VERSION >= VERSION_J\n"
    + "  guarded region: lines 2-2 (1 line(s)), first line: 'case DRAW_SOMETHING:'\n  undefined: BUILD_VERSION, VERSION_J\n"
    + "  do: define BUILD_VERSION, VERSION_J explicitly (--define or an earlier #define), include the header that defines it, or delete this guard if the region should always compile in");
});

test("lint reports the trap and exits zero by default; --fail-on-high gates; --define resolves", withDir(async (root) => {
  const source = path.join(root, "drawbitmap.c");
  fs.writeFileSync(source, TRAP);
  const r = await runCommand(["context", "lint", source], { cwd: root });
  assert.equal(r.code, 0); assert.equal(r.stderr, ""); assert.ok(r.stdout.includes("always-true-by-absence") && r.stdout.includes("DRAW_SOMETHING"));
  assert.equal((await runCommand(["context", "lint", source, "--fail-on-high"], { cwd: root })).code, 1);
  const d = await runCommand(["context", "lint", source, "--define", "BUILD_VERSION=3", "--define", "VERSION_J=5", "--fail-on-high"], { cwd: root });
  assert.equal(d.code, 0); assert.ok(d.stdout.includes("no undefined-identifier collapse"));
}));

test("lint JSON has the documented shape", withDir(async (root) => {
  const source = path.join(root, "drawbitmap.c");
  fs.writeFileSync(source, TRAP);
  const r = await runCommand(["context", "lint", source, "--json"], { cwd: root });
  assert.equal(r.code, 0); assert.equal(r.stderr, "");
  const p = JSON.parse(r.stdout);
  assert.equal(p.schema, "decomp-workbench-context-lint-v1"); assert.equal(p.findings.length, 1);
  const f = p.findings[0];
  assert.equal(f.kind, "always-true-by-absence"); assert.equal(f.severity, "high"); assert.ok(f.region && "first_line" in f.region && f.action);
  assert.equal(f.value, 1);
}));

test("several files scan in the given order; a missing file is a usage error", withDir(async (root) => {
  fs.writeFileSync(path.join(root, "header.h"), "#define BUILD_VERSION 3\n#define VERSION_J 5\n");
  fs.writeFileSync(path.join(root, "body.c"), "#if BUILD_VERSION >= VERSION_J\ncase X:\n#endif\n");
  const r = await runCommand(["context", "lint", path.join(root, "header.h"), path.join(root, "body.c")], { cwd: root });
  assert.equal(r.code, 0); assert.ok(r.stdout.includes("0 finding"));
  const m = await runCommand(["context", "lint", "/no/such/file.c"], { cwd: root });
  assert.equal(m.code, 2); assert.ok(m.stderr.includes("error:"));
}));

test("the command map lists context", async () => {
  const r = await runCommand(["commands", "--json"]);
  assert.equal(r.code, 0);
  assert.ok("context" in JSON.parse(r.stdout).groups);
});
