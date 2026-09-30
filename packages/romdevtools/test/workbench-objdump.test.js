// objdump text selection and the comparison record: stripped-symbol
// fallback, cross-function warnings, selection errors, interior labels,
// control-character scrubbing, schema keys and display paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { anonymousSingleFunction, crossFunctionWarning, interiorLabels, parseDisassembly, parseSelectedDisassembly, selectionWarnings,
  symbolLabels, symbolSelectionError } from "../src/decomp/workbench/objdump.js";
import { compareInstructions } from "../src/decomp/workbench/compare.js";
import { displayPath } from "../src/decomp/workbench/model.js";
import { COMPARISON_CENSUS_KEYS, DEPRECATED_KEYS, METRICS_BY_KEY, explainKeysText } from "../src/decomp/workbench/schema.js";
import { dumps } from "../src/decomp/workbench/pyjson.js";

const STRIPPED = "00000000 <.text>:\n   0: 03e00008  jr $ra\n   4: 00000000  nop\n";

test("a stripped export answers --function with the whole section, and says so", () => {
  assert.equal(anonymousSingleFunction(STRIPPED), true);
  assert.deepEqual(parseDisassembly(STRIPPED, { symbol: "func" }), []);
  assert.equal(parseSelectedDisassembly(STRIPPED, { symbol: "func" }).length, 2);
  const w = selectionWarnings(STRIPPED, STRIPPED, { symbol: "func", target_name: "t.o", candidate_name: "c.o" });
  assert.equal(w.length, 2);
  assert.ok(w[0].startsWith("t.o has no symbol for 'func'"));
});

test("two differently named single functions warn only without a selector", () => {
  const a = "00000000 <alpha>:\n   0: 00000000  nop\n", b = "00000000 <beta>:\n   0: 00000000  nop\n";
  assert.match(crossFunctionWarning(a, b, { symbol: null }), /target defines 'alpha' but candidate defines 'beta'/);
  assert.equal(crossFunctionWarning(a, b, { symbol: "alpha" }), null);
  assert.equal(crossFunctionWarning(a, a, { symbol: null }), null);
});

test("a selection miss lists what each input defines", () => {
  const text = "00000000 <Alpha>:\n   0: 00000000  nop\n";
  const msg = symbolSelectionError("alphax", { inputs: [["t.o", text]] });
  assert.ok(msg.startsWith("symbol 'alphax' produced no instructions in t.o."));
  assert.ok(msg.includes("  t.o defines: Alpha") && msg.includes("Names are case-sensitive"));
  assert.match(symbolSelectionError(null, { inputs: [["t.o", ""]] }), /no GNU-style objdump instruction lines in t\.o/);
});

test("an interior label reached by a branch inside the selection keeps it open", () => {
  const text = "00000000 <f>:\n   0: 10000001  b 8 <L1>\n   4: 00000000  nop\n00000008 <L1>:\n   8: 03e00008  jr $ra\n   c: 00000000  nop\n00000010 <g>:\n  10: 00000000  nop\n";
  assert.deepEqual(parseDisassembly(text, { symbol: "f" }).map((i) => i.address), [0, 4, 8, 12]);
  assert.deepEqual([...interiorLabels(text)], ["L1"]);
  assert.deepEqual(symbolLabels(text), ["f", "L1", "g"]);
  const self = "00000000 <f>:\n   0: 00000000  nop\n00000004 <g>:\n   4: 1440ffff  bnez v0,4 <g>\n   8: 00000000  nop\n";
  assert.deepEqual(parseDisassembly(self, { symbol: "f" }).map((i) => i.address), [0]);
});

test("control characters never survive into instruction text", () => {
  const [i] = parseDisassembly("   0: 00000000  nop\u0000\u0007\n");
  assert.equal(i.assembly, "nop");
});

test("the comparison document carries canonical and deprecated keys and geometry", () => {
  const t = parseDisassembly("   0: 24020021  li $v0,33\n"), c = parseDisassembly("   0: 24020031  li $v0,49\n");
  const doc = JSON.parse(dumps(compareInstructions(t, c, { target_name: "t", candidate_name: "c", symbol: null }).asDict()));
  for (const [alias, key] of Object.entries(DEPRECATED_KEYS)) assert.deepEqual(doc[alias], doc[key], alias);
  assert.deepEqual(doc.geometry, { absolute_extent_delta: 0, edit_distance: doc.normalized_distance, opcode_distance: 0 });
  assert.equal(doc.geometry_edit_distance, doc.normalized_distance);
  assert.equal(COMPARISON_CENSUS_KEYS.words, "words");
  assert.equal(METRICS_BY_KEY.words.attribute, "word_mismatches");
  assert.ok(explainKeysText().startsWith("Comparison keys."));
});

test("display paths are relative to the working directory when inside it", () => {
  const cwd = process.cwd();
  assert.equal(displayPath(path.join(cwd, "a", "b.o"), cwd), path.join("a", "b.o"));
  assert.equal(displayPath("/definitely/elsewhere/x.o", cwd), "/definitely/elsewhere/x.o");
  assert.equal(displayPath(cwd, cwd), ".");
});
