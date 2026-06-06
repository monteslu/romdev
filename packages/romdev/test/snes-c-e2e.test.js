// SNES C end-to-end through MCP buildSource + loadMedia.
//
// Confirms the language:"c" SNES dispatch produces a ROM that actually
// loads in snes9x via the MCP tool surface — the full agent-facing flow
// for "I want C on SNES."

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "snes-c-e2e", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "snes-c-e2e-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function toJSON(res) {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
}

test("buildSource({platform:'snes', language:'c'}) (default pvsneslib) → loadable LoROM ROM", async () => {
  const client = await startClient();
  // R18 default: pvsneslib:true → idiomatic SNES C, PVSnesLib runtime linked.
  // Output is ≥ 32KB (PVSnesLib hdr.asm declares ROMBANKS 8 = 256KB allotted).
  const build = toJSON(await client.callTool({
    name: "build",
    arguments: { output: "rom", 
      platform: "snes",
      language: "c",
      source: "int counter = 7; int main(void) { counter += 1; return counter; }",
    },
  }));
  assert.equal(build.ok, true, "snes C build failed:\n" + build.log);
  assert.equal(build.toolchain, "tcc816+wladx");
  assert.ok(build.binaryBytes >= 32 * 1024, "expected at least 32KB, got " + build.binaryBytes);
  // The build wrote the ROM to a temp path; we can ask the MCP to load it.
  const load = toJSON(await client.callTool({
    name: "loadMedia",
    arguments: { platform: "snes", path: build.binaryPath },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));
  assert.equal(load.platform, "snes");
  // Step a few frames to confirm snes9x didn't reject the cart on boot.
  const step = toJSON(await client.callTool({
    name: "frame", arguments: { op: "step",  frames: 4 },
  }));
  assert.ok(step.framesRun >= 4, "stepFrames returned " + JSON.stringify(step));
});
