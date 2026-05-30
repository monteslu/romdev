// Tests for the one-shot "open playtest" hint that runSource adds when
// no playtest window is open. Two invariants:
//   1. First runSource in a fresh MCP session attaches the hint.
//   2. Second runSource in the SAME session does NOT attach it (one-shot
//      gate prevents nagging legitimate headless flows: CI, automated
//      tests, agent working alone).

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer(
    { name: "hint-test", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "hint-test-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function parseToolJson(res) {
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text);
}

// Smallest possible NES C source — compiles cleanly through cc65 and
// runs for a couple of frames without crashing. We don't care what it
// draws, only that the build succeeds so runSource gets to the hint.
const NES_TINY = `
#include <stdint.h>
void main(void) { while (1) {} }
`;

test("runSource: first call in a session attaches the playtest hint", { timeout: 60000 }, async () => {
  const client = await startClient();
  const res = await client.callTool({
    name: "runSource",
    arguments: { platform: "nes", source: NES_TINY, frames: 2 },
  });
  const parsed = parseToolJson(res);
  assert.equal(parsed.ok, true, "build should succeed:\n" + JSON.stringify(parsed, null, 2));
  assert.ok(parsed.hint, "first call must include the playtest hint");
  assert.match(parsed.hint, /playtest/i);
});

test("runSource: second call in the same session does NOT attach the hint", { timeout: 60000 }, async () => {
  const client = await startClient();
  // First call primes the gate.
  parseToolJson(await client.callTool({
    name: "runSource",
    arguments: { platform: "nes", source: NES_TINY, frames: 2 },
  }));
  // Second call must omit hint.
  const r2 = await client.callTool({
    name: "runSource",
    arguments: { platform: "nes", source: NES_TINY, frames: 2 },
  });
  const parsed2 = parseToolJson(r2);
  assert.equal(parsed2.ok, true);
  assert.equal(parsed2.hint, undefined, "second call must not nag with another hint");
});
