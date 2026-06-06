// Clear tool-call validation errors (the withClearToolErrors layer): bad enum,
// unknown/misspelled param (+ did-you-mean), wrong type, and that .strict()
// rejects unknown keys instead of silently dropping them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { withClearToolErrors } from "../src/mcp/util.js";

async function client() {
  let server = new McpServer({ name: "e", version: "1" }, { capabilities: { tools: {} } });
  server = withClearToolErrors(server, z);
  server.tool("memory", "test", {
    op: z.enum(["read", "write"]), region: z.string().optional(),
    offset: z.number().optional(), length: z.number().optional(), hex: z.string().optional(),
  }, async (args) => ({ content: [{ type: "text", text: "ok " + JSON.stringify(args) }] }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "c", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(st), c.connect(ct)]);
  return c;
}
// the SDK throws on validation failure → callTool rejects; capture the message.
async function callErr(c, args) {
  try { const r = await c.callTool({ name: "memory", arguments: args });
    return r.isError ? r.content[0].text : null; // null = succeeded (no error)
  } catch (e) { return e.message; }
}

test("bad enum → readable 'must be one of' (not a JSON dump)", async () => {
  const c = await client();
  const m = await callErr(c, { op: "frobnicate" });
  assert.match(m, /'op' must be one of: read \| write/);
});

test("misspelled param → 'did you mean' (conceptual alias addr→offset)", async () => {
  const c = await client();
  const m = await callErr(c, { op: "read", addr: 5 });
  assert.match(m, /unknown parameter 'addr'/);
  assert.match(m, /Did you mean 'offset'/);
});

test("alias len→length, data→hex", async () => {
  const c = await client();
  assert.match(await callErr(c, { op: "read", len: 4 }), /Did you mean 'length'/);
  assert.match(await callErr(c, { op: "write", data: "ff" }), /Did you mean 'hex'/);
});

test("wrong type → ''x' must be a number'", async () => {
  const c = await client();
  const m = await callErr(c, { op: "read", offset: "nope" });
  assert.match(m, /'offset' must be a number/);
});

test("unknown key is REJECTED, not silently dropped", async () => {
  const c = await client();
  // before the fix this succeeded with the key stripped; now it must error.
  const m = await callErr(c, { op: "read", bogusKey: 1 });
  assert.ok(m, "unknown key should produce an error, not succeed");
  assert.match(m, /unknown parameter 'bogusKey'/);
});

test("valid call still succeeds (no false positives)", async () => {
  const c = await client();
  const m = await callErr(c, { op: "read", region: "system_ram", offset: 0, length: 16 });
  assert.equal(m, null, "valid call should not error: " + m);
});
