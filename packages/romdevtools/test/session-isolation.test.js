// Per-session host isolation test.
//
// Two MCP sessions (two registerTools() calls, each with its own sessionKey)
// must NOT share host state — one session's loadMedia should not be visible
// to the other. Pre-isolation this was a process-wide singleton; the failure
// mode was silent cross-session data corruption.
//
// We exercise it through the real Client/McpServer + InMemoryTransport so
// the sessionKey-threading actually flows through registerTools → category
// register fns → handler closures.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";
import { _liveHostCount } from "../src/mcp/state.js";
import { buildExampleRom } from "./build-fixture-rom.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Build a real, bootable NES ROM from our own example source so this test runs
// unconditionally and references no external ROM on disk.
let ROM_PATH;
before(async () => { ROM_PATH = await buildExampleRom("nes"); });

async function startSession() {
  const server = new McpServer(
    { name: "romdev-test-iso", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  // registerTools with no sessionKey mints a fresh one — each call gets
  // its own scope, which is exactly what we want to exercise.
  registerTools(server, z);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "iso-test", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

test("two MCP sessions own independent hosts; loadMedia in one is invisible to the other", async () => {
  const before = _liveHostCount();
  const a = await startSession();
  const b = await startSession();

  // Session A loads nestest. Session B is untouched.
  const loadA = await a.callTool({
    name: "loadMedia",
    arguments: { platform: "nes", path: ROM_PATH },
  });
  assert.equal(loadA.isError, undefined, "session A loadMedia failed");

  // Session B has no host yet — getStatus should report loaded:false.
  const statusB = await b.callTool({ name: "catalog", arguments: { op: "status" } });
  const parsedB = JSON.parse(statusB.content[0].text);
  assert.equal(parsedB.loaded, false, "session B sees A's loaded media — leak: " + JSON.stringify(parsedB));

  // Session A's status confirms it DOES have media.
  const statusA = await a.callTool({ name: "catalog", arguments: { op: "status" } });
  const parsedA = JSON.parse(statusA.content[0].text);
  assert.equal(parsedA.loaded, true, "session A lost its media");
  assert.equal(parsedA.platform, "nes");

  // Session B trying to read memory should fail — no host. A SHOULD succeed.
  const memB = await b.callTool({ name: "memory", arguments: { op: "read", region: "system_ram", offset: 0, length: 16 } });
  assert.equal(memB.isError, true, "session B's readMemory must error — no media loaded in B");

  const memA = await a.callTool({ name: "memory", arguments: { op: "read", region: "system_ram", offset: 0, length: 16 } });
  assert.equal(memA.isError, undefined, "session A's readMemory failed: " + JSON.stringify(memA));

  // Only session A actually instantiated a host (loadMedia creates one).
  // Session B never loaded, so it has none. Confirm host count went up by 1.
  assert.equal(_liveHostCount(), before + 1, "host count is " + _liveHostCount());

  // Now load in B and confirm both coexist without collision.
  const loadB = await b.callTool({
    name: "loadMedia",
    arguments: { platform: "nes", path: ROM_PATH },
  });
  assert.equal(loadB.isError, undefined, "session B loadMedia failed");
  assert.equal(_liveHostCount(), before + 2, "host count after both loaded: " + _liveHostCount());

  // Read RAM in both — they should be independent emulators. We can't
  // guarantee different RAM contents from a passive ROM at frame 0, but
  // we CAN confirm independent screenshot pipelines: step A 60 frames,
  // B 0 frames, then read each frame counter from getStatus.
  await a.callTool({ name: "frame", arguments: { op: "step",  frames: 60 } });
  const sA = JSON.parse((await a.callTool({ name: "catalog", arguments: { op: "status" } })).content[0].text);
  const sB = JSON.parse((await b.callTool({ name: "catalog", arguments: { op: "status" } })).content[0].text);
  assert.equal(sA.frameCount, 60, "A frameCount: " + sA.frameCount);
  assert.equal(sB.frameCount, 0,  "B frameCount: " + sB.frameCount + " — bleed-through from A");
});
