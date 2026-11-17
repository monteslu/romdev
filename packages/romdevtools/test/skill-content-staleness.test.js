// Report 2026-09-15 §13: "the stale installed skill cannot be regenerated
// using the remedy returned by decomp({op:'skill'}) itself" -- and, found
// while fixing that: a skill whose VERSION matches the server can still
// document none of the ops the server ships.
//
// Comparing version strings alone reported `stale: false` on a document that
// mentioned none of five newly shipped ops. A skill that never names an op is
// a skill that stops an agent from using it, which is exactly the failure the
// staleness check exists to prevent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decompSkillSection } from "../src/decomp/skill-sync.js";
import { DECOMP_OPS } from "../src/mcp/tools/decomp.js";

test("the op list has ONE source of truth", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/mcp/tools/decomp.js", import.meta.url), "utf8");
  // The schema must build from the constant, not from a second literal that
  // can drift away from it.
  assert.match(src, /op: z\.enum\(DECOMP_OPS\)/);
  assert.ok(DECOMP_OPS.length > 40, `expected the full op list, got ${DECOMP_OPS.length}`);
});

test("a generated skill names every op the server serves", () => {
  const md = decompSkillSection({ decompPlatforms: ["n64"], ops: [...DECOMP_OPS] });
  for (const op of DECOMP_OPS) {
    assert.ok(md.includes(`op:'${op}'`), `the generated skill never names op:'${op}'`);
  }
});

test("the generated skill says the op list is machine-generated", () => {
  const md = decompSkillSection({ decompPlatforms: ["n64"], ops: ["compare", "diagnose"] });
  assert.match(md, /generated from the server's own schema rather than maintained by hand/i);
});

test("omitting ops produces no op section rather than a half-empty one", () => {
  const md = decompSkillSection({ decompPlatforms: ["n64"] });
  assert.ok(!md.includes("### Every `decomp` op"));
});
