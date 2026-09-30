// The composer refuses, or it lands where it was aimed. Ported from the
// workbench's compose tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Anchor, ComposeError, Edit, EditPlan, applyPlan, parseZone, sourceSha256 } from "../src/decomp/workbench/compose.js";
import { splitlines } from "../src/decomp/workbench/py.js";

const SOURCE = "void demo(void) {\n    f32 lead;\n    f32 span;\n\n    lead = 1.0f;\n    span = lead + 2.0f;\n    tail(span);\n}\n";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-compose-"));
  const file = path.join(dir, "work.c");
  fs.writeFileSync(file, SOURCE);
  const sha = sourceSha256(file);
  const plan = (over = {}) => new EditPlan({ base: file, base_sha256: sha, edits: [new Edit({ line: 5, expect: "    lead = 1.0f;", replace: "    lead = 3.0f;" })], ...over });
  return { dir, file, sha, plan, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const withSetup = (fn) => () => { const s = setup(); try { fn(s); } finally { s.done(); } };

test("an edit lands where it was aimed", withSetup(({ plan }) => {
  const composed = applyPlan(plan());
  assert.ok(composed.text.includes("lead = 3.0f;"));
  assert.ok(!composed.text.includes("lead = 1.0f;"));
  assert.ok(composed.text.endsWith("\n"));
}));

test("a moved base is refused before any line is read", withSetup(({ file, sha, plan }) => {
  fs.writeFileSync(file, "/* rebased */\n" + SOURCE);
  assert.throws(() => applyPlan(plan()), (e) => e instanceof ComposeError && e.message.includes("not the base this plan was written against") && e.message.includes(sha));
}));

test("an anchor line that says something else is refused", withSetup(({ plan }) => {
  assert.throws(() => applyPlan(plan({ anchors: [new Anchor({ line: 6, text: "span = lead + 9.0f;", owner: "B4S" })] })),
    (e) => e.message.includes("is not the anchor line") && e.message.includes("B4S"));
}));

test("an edit inside a frozen zone is refused by name", withSetup(({ plan }) => {
  assert.throws(() => applyPlan(plan({ frozen: [[4, 6]], frozen_owner: "the B4 supplier set" })),
    (e) => e.message.includes("frozen zone 4..6") && e.message.includes("the B4 supplier set"));
}));

test("an anchor is re-read at its own line, not anywhere", withSetup(({ plan }) => {
  const p = plan({ edits: [
    new Edit({ line: 5, expect: "    lead = 1.0f;", replace: "    lead = 4.0f;" }),
    new Edit({ line: 7, expect: "    tail(span);", replace: "    lead = 1.0f;" }),
  ], anchors: [new Anchor({ line: 5, text: "lead = 1.0f;" })] });
  assert.throws(() => applyPlan(p), /no longer reads/);
}));

test("two edits on one line are refused", withSetup(({ plan }) => {
  const p = plan({ edits: [
    new Edit({ line: 5, expect: "    lead = 1.0f;", replace: "    lead = 2.0f;" }),
    new Edit({ line: 5, expect: "    lead = 1.0f;", replace: "    lead = 3.0f;" }),
  ] });
  assert.throws(() => applyPlan(p), /two edits target line 5/);
}));

test("an insertion keeps the line it was aimed before", withSetup(({ plan }) => {
  const composed = applyPlan(plan({ edits: [new Edit({ line: 6, expect: "    span = lead + 2.0f;", insert: ["    span = 0.0f;"] })],
    anchors: [new Anchor({ line: 6, text: "span = lead + 2.0f;" })] }));
  const lines = splitlines(composed.text);
  assert.equal(lines[5].trim(), "span = 0.0f;");
  assert.equal(lines[6].trim(), "span = lead + 2.0f;");
  assert.deepEqual(composed.verified_anchors, [6]);
}));

test("a frozen zone outside the edit survives and is checked", withSetup(({ plan }) => {
  assert.ok(applyPlan(plan({ frozen: [[7, 7]] })).text.includes("    tail(span);"));
}));

test("an edit past the end names the file length", withSetup(({ plan }) => {
  assert.throws(() => applyPlan(plan({ edits: [new Edit({ line: 99, expect: "anything" })] })), /line\(s\); the edit/);
}));

test("a zone reads both spellings; backwards and non-ranges are refused", () => {
  assert.deepEqual(parseZone("10..20"), [10, 20]);
  assert.deepEqual(parseZone(" 7 "), [7, 7]);
  assert.throws(() => parseZone("20..10"), ComposeError);
  assert.throws(() => parseZone("the prologue"), /write LO\.\.HI/);
});
