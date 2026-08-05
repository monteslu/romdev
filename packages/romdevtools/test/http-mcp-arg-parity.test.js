// http-mcp-arg-parity.test.js — a tool must receive the SAME arguments
// whichever transport called it.
//
// The HTTP path used to `safeParse` for VALIDATION and then hand the handler
// the RAW args, discarding `parsed.data`. A zod schema does more than validate:
// it applies `.default()`, coercions and transforms. The MCP SDK applies them;
// the HTTP path did not. So ~184 `.default()` declarations across the tool
// surface were behavioural forks between the two transports.
//
// Two real divergences this caused, in opposite directions:
//   - frame({op:'step'}) with no `frames` stepped 1 over MCP, 0 over HTTP.
//   - memory({op:'read', address}) worked over HTTP and silently read byte 0
//     over MCP, because an alias guard keyed on "offset is absent" only ever
//     saw an absent offset on the transport that skipped defaults.
//
// Neither is visible to a test that drives one transport, which is why both
// shipped. This asserts the seam directly: runTool must pass the PARSED args.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { runTool } from "../src/http/tool-registry.js";

/** Minimal tool double shaped like the registry's entries. */
function fakeTool(shape, handler) {
  return { name: "fake", inputSchema: z.object(shape), handler };
}

test("runTool applies zod defaults before calling the handler", async () => {
  let seen = null;
  const tool = fakeTool(
    { frames: z.number().int().default(1), op: z.string() },
    async (args) => { seen = args; return { content: [{ type: "text", text: "{}" }] }; },
  );

  const out = await runTool(tool, { op: "step" }, "test-session");
  assert.equal(out.ok, true, "call succeeded");
  assert.equal(seen.frames, 1, "the handler saw the DEFAULT, not undefined");
});

test("runTool passes an explicit value through unchanged", async () => {
  let seen = null;
  const tool = fakeTool(
    { frames: z.number().int().default(1), op: z.string() },
    async (args) => { seen = args; return { content: [{ type: "text", text: "{}" }] }; },
  );

  await runTool(tool, { op: "step", frames: 60 }, "test-session");
  assert.equal(seen.frames, 60, "an explicit value beats the default");
});

test("runTool still rejects invalid arguments", async () => {
  const tool = fakeTool(
    { frames: z.number().int().default(1), op: z.string() },
    async () => { throw new Error("handler must not run on invalid input"); },
  );

  const out = await runTool(tool, { op: "step", frames: "not-a-number" }, "test-session");
  assert.equal(out.ok, false, "invalid args are refused");
});

test("runTool leaves an OPTIONAL field absent (so alias guards still fire)", async () => {
  // memory's `address`→`offset` alias only fires when `offset` is genuinely
  // absent. Applying parsed data must not invent a key the caller never sent
  // and the schema never defaulted.
  let seen = null;
  const tool = fakeTool(
    { offset: z.number().int().optional(), address: z.number().int().optional() },
    async (args) => { seen = args; return { content: [{ type: "text", text: "{}" }] }; },
  );

  await runTool(tool, { address: 235 }, "test-session");
  assert.equal(seen.offset, undefined, "no offset key materialised");
  assert.equal(seen.address, 235, "the alias source survived");
});
