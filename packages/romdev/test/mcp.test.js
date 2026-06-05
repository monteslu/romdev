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
import os from "node:os";
import { existsSync, rmSync } from "node:fs";
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
    { name: "romdev-test", version: "0.0.1" },
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
    name: "state",
    arguments: { op: "save", name: "cp1" },
  });
  assert.equal(save.isError, undefined);

  await client.callTool({ name: "stepFrames", arguments: { frames: 100 } });
  const statusAfter = await client.callTool({ name: "getStatus", arguments: {} });
  const afterFrames = JSON.parse(statusAfter.content[0].text).frameCount;
  assert.equal(afterFrames, 130);

  const restore = await client.callTool({
    name: "state",
    arguments: { op: "load", name: "cp1" },
  });
  assert.equal(restore.isError, undefined);
  // loadState refreshes the framebuffer by default (render:true) so an
  // immediate screenshot isn't stale — it reports rendered:true and advances
  // the monotonic counter by one (130 → 131). The core state itself is back
  // at cp1; only our power-on counter is monotonic (documented).
  const restoreBody = JSON.parse(restore.content[0].text);
  assert.equal(restoreBody.rendered, true, "loadState renders one frame by default");
  const afterRestore = JSON.parse((await client.callTool({ name: "getStatus", arguments: {} })).content[0].text).frameCount;
  assert.equal(afterRestore, 131, "render:true stepped exactly one frame");

  // render:false restores WITHOUT advancing — for callers who need the core
  // paused at the exact restored instant before any frame runs.
  const restoreNoRender = await client.callTool({
    name: "state",
    arguments: { op: "load", name: "cp1", render: false },
  });
  assert.equal(JSON.parse(restoreNoRender.content[0].text).rendered, false);
  const afterNoRender = JSON.parse((await client.callTool({ name: "getStatus", arguments: {} })).content[0].text).frameCount;
  assert.equal(afterNoRender, 131, "render:false did not advance the frame counter");
});

test("MCP: loadState clears active cheats (documented contract)", { skip: !HAS_NESTEST && "nestest.nes not present" }, async () => {
  const { client } = await startServerAndClient();
  await client.callTool({ name: "loadMedia", arguments: { platform: "nes", path: ROM_PATH } });
  await client.callTool({ name: "stepFrames", arguments: { frames: 30 } });
  await client.callTool({ name: "state", arguments: { op: "save", name: "cp" } });
  await client.callTool({ name: "cheats", arguments: { op: "apply", code: "0075:09" } });
  // Restoring a state must clear cheats (frontend cheat state isn't in the blob).
  const r = JSON.parse((await client.callTool({ name: "state", arguments: { op: "load", name: "cp" } })).content[0].text);
  assert.equal(r.cheatsCleared, 1, "loadState reports the cheat it cleared");
  // Re-apply: it should land in slot 0 (proving the prior cheat was gone), not slot 1.
  const re = JSON.parse((await client.callTool({ name: "cheats", arguments: { op: "apply", code: "0075:09" } })).content[0].text);
  assert.deepEqual(re.active.map((c) => c.index), [0], "no stale cheat survived the restore");
});

test("MCP: exportState copies a slot to disk without touching the live host", { skip: !HAS_NESTEST && "nestest.nes not present" }, async () => {
  const { client } = await startServerAndClient();
  await client.callTool({ name: "loadMedia", arguments: { platform: "nes", path: ROM_PATH } });
  await client.callTool({ name: "stepFrames", arguments: { frames: 30 } });
  await client.callTool({ name: "state", arguments: { op: "save", name: "slot1" } });
  const before = JSON.parse((await client.callTool({ name: "getStatus", arguments: {} })).content[0].text).frameCount;
  const out = path.join(os.tmpdir(), `romdev-export-${before}.state`);
  const r = JSON.parse((await client.callTool({ name: "state", arguments: { op: "export", fromSlot: "slot1", path: out } })).content[0].text);
  assert.equal(r.exported, true);
  assert.ok(r.bytes > 0);
  assert.ok(existsSync(out), "the state file was written");
  // Live host untouched: frame counter unchanged by the export.
  const after = JSON.parse((await client.callTool({ name: "getStatus", arguments: {} })).content[0].text).frameCount;
  assert.equal(after, before, "exportState did not advance/disturb the live host");
  rmSync(out, { force: true });
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

test("MCP: findWriter captures the instruction-level write PC (watchpoint)", { skip: !HAS_NESTEST && "nestest.nes not present" }, async () => {
  const { client } = await startServerAndClient();
  await client.callTool({ name: "loadMedia", arguments: { platform: "nes", path: ROM_PATH } });
  await client.callTool({ name: "stepFrames", arguments: { frames: 60 } });
  // Find a RAM address the ROM actually writes, so the watchpoint is sure to fire.
  const before = JSON.parse((await client.callTool({ name: "readMemory", arguments: { region: "system_ram", offset: 0, length: 0x100 } })).content[0].text).hex;
  await client.callTool({ name: "stepFrames", arguments: { frames: 5 } });
  const after = JSON.parse((await client.callTool({ name: "readMemory", arguments: { region: "system_ram", offset: 0, length: 0x100 } })).content[0].text).hex;
  let addr = -1;
  for (let i = 0; i < 0x100; i++) {
    if (before.slice(i * 2, i * 2 + 2) !== after.slice(i * 2, i * 2 + 2)) { addr = i; break; }
  }
  if (addr < 0) return; // no zero-page write in this window — nothing to assert
  const r = await client.callTool({ name: "findWriter", arguments: { address: addr, maxFrames: 120 } });
  assert.equal(r.isError, undefined, `findWriter errored: ${JSON.stringify(r)}`);
  const w = JSON.parse(r.content[0].text);
  assert.equal(w.found, true, `findWriter should catch a write to $${addr.toString(16)}`);
  assert.match(w.pc, /^\$[0-9A-F]+$/, "pc is a real hex address");
  assert.ok(w.hits >= 1, "at least one write recorded");
  assert.ok(typeof w.pcRaw === "number" && w.pcRaw !== 0xFFFFFFFF, "pcRaw is a concrete PC, not the sentinel");
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
