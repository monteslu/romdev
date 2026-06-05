// Consolidation invariants — the gates that keep the 132→34 refactor honest as it
// lands domain-by-domain. These GROW with the manifest; while consolidation is in
// progress they assert what's true SO FAR, not the final 34.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";
import { MERGE_MAP, absorbedToolNames, consolidatedToolNames } from "../src/mcp/tool-manifest.js";

async function liveToolNames() {
  const s = new McpServer({ name: "m", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(s, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "mc", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([s.connect(st), c.connect(ct)]);
  await c.callTool({ name: "loadCategory", arguments: { category: "all" } });
  const list = await c.listTools();
  return new Set(list.tools.map((t) => t.name));
}

test("manifest: no absorbed (old) tool name is still registered", async () => {
  const live = await liveToolNames();
  const stillAround = absorbedToolNames().filter((n) => live.has(n));
  assert.deepEqual(stillAround, [], "these absorbed tools were not removed: " + stillAround.join(", "));
});

test("manifest: every consolidated tool IS registered (coverage gate)", async () => {
  const live = await liveToolNames();
  const missing = consolidatedToolNames().filter((n) => !live.has(n));
  assert.deepEqual(missing, [], "manifest names a tool that isn't registered: " + missing.join(", "));
});

test("manifest: no tool is absorbed by two different consolidated tools (no dupe)", () => {
  const seen = new Map();
  for (const [newTool, entry] of Object.entries(MERGE_MAP)) {
    for (const old of entry.absorbs ?? []) {
      assert.ok(!seen.has(old), `${old} is absorbed by both ${seen.get(old)} and ${newTool}`);
      seen.set(old, newTool);
    }
  }
});

test("tool-count budget: surface is shrinking, never above the start (132)", async () => {
  // Final target is ~34; while consolidation lands this guards against ACCIDENTAL
  // GROWTH. Tighten the ceiling toward 35 as domains land.
  const live = await liveToolNames();
  assert.ok(live.size <= 132, `tool count ${live.size} exceeds the pre-consolidation 132 — did a tool get added without merging?`);
});
