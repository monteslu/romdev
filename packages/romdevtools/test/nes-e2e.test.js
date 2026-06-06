// Full vibe-coding loop on NES:
//   1. Agent writes C source.
//   2. MCP buildSource compiles it via bundled cc65.wasm → ca65.wasm → ld65.wasm.
//   3. MCP loadMedia loads the .nes into bundled fceumm.
//   4. MCP stepAndScreenshot captures a PNG.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import os from "node:os";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

const NES_C = `
void main(void) {
  while (1) { }
}
`;

async function startServerAndClient() {
  const server = new McpServer(
    { name: "romdev-test", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, z);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  // Progressive disclosure: deferred categories aren't auto-loaded.
  // Tests need the full tool surface; mirror the power-user "all" flow.
  return client;
}

test("vibe loop: build NES C with cc65, run in fceumm, screenshot", async () => {
  const client = await startServerAndClient();

  const tmp = mkdtempSync(path.join(os.tmpdir(), "romdev-nes-"));
  const romPath = path.join(tmp, "hello.nes");

  const build = await client.callTool({
    name: "build",
    arguments: { output: "rom", 
      platform: "nes",
      source: NES_C,
      outputPath: romPath,
    },
  });
  assert.equal(build.isError, undefined, "build error: " + JSON.stringify(build));
  const buildInfo = JSON.parse(build.content[0].text);
  assert.equal(buildInfo.ok, true, "build failed:\n" + buildInfo.log);
  assert.equal(buildInfo.toolchain, "cc65");
  assert.ok(buildInfo.binaryBytes > 0);

  const loaded = await client.callTool({
    name: "loadMedia",
    arguments: { platform: "nes", path: romPath },
  });
  assert.equal(loaded.isError, undefined);

  const shot = await client.callTool({
    name: "frame", arguments: { op: "stepAndShot",  frames: 30, inline: true },
  });
  assert.equal(shot.isError, undefined);
  const img = shot.content.find((c) => c.type === "image");
  assert.ok(img);
  const png = Buffer.from(img.data, "base64");
  assert.equal(png[0], 0x89);
  assert.equal(png[1], 0x50);
}, { timeout: 30000 });
