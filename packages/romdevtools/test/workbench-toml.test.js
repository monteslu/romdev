// The TOML reader behind project configuration: the value forms a config
// uses, and refusals with the position the standard reader reports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToml, TOMLDecodeError, TomlDateTime } from "../src/decomp/workbench/toml.js";

test("tables, arrays of tables, inline tables and dotted keys", () => {
  const d = parseToml('[a]\nb.c = 1\n[[t]]\nx = 1\n[[t]]\nx = 2\nin = { p = 1, q.r = "s" }\n');
  assert.deepEqual(d, { a: { b: { c: 1 } }, t: [{ x: 1 }, { x: 2, in: { p: 1, q: { r: "s" } } }] });
});

test("every string form", () => {
  const d = parseToml('a = "x\\ty \\u00e9 \\"q\\""\nb = \'C:\\\\path\'\nc = """\nl1\\\n   l2"""\nd = \'\'\'\nraw\\n\'\'\'\n');
  assert.equal(d.a, 'x\ty \u00e9 "q"');
  assert.equal(d.b, "C:\\\\path");
  assert.equal(d.c, "l1l2");
  assert.equal(d.d, "raw\\n");
});

test("numbers, booleans and date-times", () => {
  const d = parseToml("i = 1_000\nh = 0xff\no = 0o17\nb = 0b101\nf = -1.5e3\ninf = +inf\nbig = 9223372036854775807\nt = true\ndt = 1979-05-27T07:32:00Z\n");
  assert.equal(d.i, 1000); assert.equal(d.h, 255); assert.equal(d.o, 15); assert.equal(d.b, 5); assert.equal(d.f, -1500);
  assert.equal(d.inf, Infinity); assert.equal(d.big, 9223372036854775807n); assert.equal(d.t, true);
  assert.ok(d.dt instanceof TomlDateTime); assert.equal(String(d.dt), "1979-05-27T07:32:00Z");
});

test("refusals carry the position", () => {
  const cases = [["a = 1\na = 2\n", "Cannot overwrite a value (at line 2, column 1)"], ["[a]\n[a]\n", "Cannot declare a table twice (at line 2, column 1)"],
    ["a = \n", "Invalid value (at line 1, column 5)"], ["k = 1 2\n", "Expected newline or end of document after a statement (at line 1, column 7)"],
    ["k = \"open\n", "Unterminated string (at line 1, column 10)"], ["x = [1, 2\n", "Unclosed array (at end of document)"]];
  for (const [src, msg] of cases) assert.throws(() => parseToml(src), (e) => e instanceof TOMLDecodeError && e.message === msg, src);
});
