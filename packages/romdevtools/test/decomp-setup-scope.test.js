// decomp({op:'setup'}) takes `root` (the fresh checkout). The declared per-op
// scope table listed `root` only for import/research/replay, so the MCP
// validator refused the documented setup call before the handler ever ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { makeScopeChecker } from "../src/mcp/util.js";
import { DECOMP_OPS } from "../src/mcp/tools/decomp.js";

const shape = {
  op: z.enum(DECOMP_OPS).describe("what to do"),
  root: z.string().optional().describe("checkout path"),
  targets: z.array(z.string()).optional().describe("op:'setup' - Makefile goals"),
};

test("op:'setup' accepts root", () => {
  const check = makeScopeChecker(shape, "decomp");
  assert.ok(check);
  assert.equal(check({ op: "setup", root: "/checkout" }), null);
  assert.equal(check({ op: "setup", root: "/checkout", targets: ["setup"] }), null);
});

test("root is still refused on an op it does not apply to", () => {
  const check = makeScopeChecker(shape, "decomp");
  assert.match(check({ op: "compare", root: "/checkout" }), /'root' does not apply to op:'compare'/);
});
