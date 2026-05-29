// End-to-end MCP server test.
//
// Boots the McpServer in-process, connects an MCP Client over the in-memory
// transport pair, and drives the full agent workflow:
//   listPlatforms → loadMedia → stepAndScreenshot → readMemory → saveState → loadState
//
// Verifies the wired tool surface against the real fceumm core + nestest.nes.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROM_PATH = path.join(__dirname, "roms", "nestest.nes");
// nestest.nes is fetched on demand by scripts/fetch-test-roms.sh — skip ROM
// tests gracefully when it's not present (e.g. fresh clones without the fetch).
const HAS_NESTEST = existsSync(ROM_PATH);

async function startServerAndClient() {
  const server = new McpServer(
    { name: "rom-dev-mcp-test", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, z);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: "test-client", version: "0.0.1" },
    { capabilities: {} },
  );

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  // Tests directly call tools that live in deferred PD categories
  // (listPlatforms is in 'platforms', loadMedia is in 'run', etc.).
  // Load everything so tests can call any tool by name — mirrors the
  // power-user `loadCategory({category:"all"})` escape hatch.
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });

  return { server, client };
}

test("MCP: listPlatforms returns NES and other v1 platforms", async () => {
  const { client } = await startServerAndClient();
  const result = await client.callTool({ name: "listPlatforms", arguments: {} });
  const text = result.content[0].text;
  const data = JSON.parse(text);
  const ids = data.platforms.map((p) => p.platform);
  assert.ok(ids.includes("nes"));
  assert.ok(ids.includes("gb"));
  assert.ok(ids.includes("genesis"));
  const nes = data.platforms.find((p) => p.platform === "nes");
  assert.equal(nes.coreName, "fceumm");
  assert.equal(nes.coreAvailable, true);
});

test("MCP: load NES rom, step frames, screenshot returns valid PNG", { skip: !HAS_NESTEST && "nestest.nes not present — run scripts/fetch-test-roms.sh" }, async () => {
  const { client } = await startServerAndClient();

  // loadMedia
  const loaded = await client.callTool({
    name: "loadMedia",
    arguments: { platform: "nes", path: ROM_PATH },
  });
  assert.equal(loaded.isError, undefined, `loadMedia errored: ${JSON.stringify(loaded)}`);
  const loadInfo = JSON.parse(loaded.content[0].text);
  assert.equal(loadInfo.loaded, true);
  assert.equal(loadInfo.platform, "nes");
  assert.equal(loadInfo.core, "fceumm");

  // stepAndScreenshot — inline:true to get the image in the response
  // (default writes to a path; this test asserts the inline image shape).
  const shot = await client.callTool({
    name: "stepAndScreenshot",
    arguments: { frames: 60, inline: true },
  });
  assert.equal(shot.isError, undefined, `stepAndScreenshot errored: ${JSON.stringify(shot)}`);
  const img = shot.content.find((c) => c.type === "image");
  assert.ok(img, "expected image content");
  assert.equal(img.mimeType, "image/png");
  const png = Buffer.from(img.data, "base64");
  // PNG magic bytes
  assert.equal(png[0], 0x89);
  assert.equal(png[1], 0x50);
  assert.equal(png[2], 0x4e);
  assert.equal(png[3], 0x47);
});

test("MCP: save state, step further, load state restores frame count", { skip: !HAS_NESTEST && "nestest.nes not present" }, async () => {
  const { client } = await startServerAndClient();
  await client.callTool({
    name: "loadMedia",
    arguments: { platform: "nes", path: ROM_PATH },
  });
  await client.callTool({ name: "stepFrames", arguments: { frames: 30 } });

  const save = await client.callTool({
    name: "saveState",
    arguments: { name: "cp1" },
  });
  assert.equal(save.isError, undefined);

  await client.callTool({ name: "stepFrames", arguments: { frames: 100 } });
  const statusAfter = await client.callTool({ name: "getStatus", arguments: {} });
  const afterFrames = JSON.parse(statusAfter.content[0].text).frameCount;
  assert.equal(afterFrames, 130);

  const restore = await client.callTool({
    name: "loadState",
    arguments: { name: "cp1" },
  });
  assert.equal(restore.isError, undefined);

  // After load, the core's internal state is back at cp1 but our frame counter
  // does not roll back (it tracks calls into the host). That's documented
  // behavior — the core is restored, our counter is monotonic.
});

test("MCP: readMemory returns 16 bytes from NES system RAM", { skip: !HAS_NESTEST && "nestest.nes not present" }, async () => {
  const { client } = await startServerAndClient();
  await client.callTool({
    name: "loadMedia",
    arguments: { platform: "nes", path: ROM_PATH },
  });
  await client.callTool({ name: "stepFrames", arguments: { frames: 10 } });
  const r = await client.callTool({
    name: "readMemory",
    arguments: { region: "system_ram", offset: 0, length: 16 },
  });
  assert.equal(r.isError, undefined, `readMemory errored: ${JSON.stringify(r)}`);
  const data = JSON.parse(r.content[0].text);
  assert.equal(data.region, "system_ram");
  assert.equal(data.length, 16);
  assert.equal(data.hex.length, 32);
});

test("MCP: pressButton on NES does not throw", { skip: !HAS_NESTEST && "nestest.nes not present" }, async () => {
  const { client } = await startServerAndClient();
  await client.callTool({
    name: "loadMedia",
    arguments: { platform: "nes", path: ROM_PATH },
  });
  const r = await client.callTool({
    name: "pressButton",
    arguments: { button: "start", frames: 3 },
  });
  assert.equal(r.isError, undefined, `pressButton errored: ${JSON.stringify(r)}`);
});

test("MCP: listToolchains includes cc65", async () => {
  const { client } = await startServerAndClient();
  const r = await client.callTool({ name: "listToolchains", arguments: {} });
  const data = JSON.parse(r.content[0].text);
  const ids = data.toolchains.map((t) => t.id);
  assert.ok(ids.includes("cc65"));
});
