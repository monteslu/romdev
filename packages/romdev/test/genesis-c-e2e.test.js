// Genesis C end-to-end through MCP buildSource + loadMedia.
//
// Confirms the language:"c" Genesis dispatch produces a ROM that
// actually loads in genesis_plus_gx via the MCP tool surface — the
// full agent-facing flow for "I want C on Genesis."

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "genesis-c-e2e", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "genesis-c-e2e-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}

function toJSON(res) {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
}

test("buildSource({platform:'genesis', language:'c'}) → loadable Genesis ROM", async () => {
  const client = await startClient();
  const build = toJSON(await client.callTool({
    name: "buildSource",
    arguments: {
      platform: "genesis",
      language: "c",
      source: "int counter = 7; int main(void) { counter += 1; return counter; }",
    },
  }));
  assert.equal(build.ok, true, "genesis C build failed:\n" + build.log);
  assert.equal(build.toolchain, "m68k-elf-gcc");
  assert.ok(build.binaryBytes >= 256, "expected at least vector+header bytes");

  const load = toJSON(await client.callTool({
    name: "loadMedia",
    arguments: { platform: "genesis", path: build.binaryPath },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));
  assert.equal(load.platform, "genesis");

  const step = toJSON(await client.callTool({
    name: "stepFrames",
    arguments: { frames: 4 },
  }));
  assert.ok(step.framesRun >= 4, "stepFrames returned " + JSON.stringify(step));
});
