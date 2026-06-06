// R61 — createGame consistency: every genre-capable platform must scaffold
// every canonical genre, with availability DERIVED from TEMPLATES (no parallel
// hardcoded table to drift). This locks in the R61 fix for the bug where
// createGame's hardcoded GENRE_MAP silently omitted c64/gba/lynx even though
// their genre templates were registered.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

// The set of platforms that ship genre scaffolds, and the genres each has.
// Kept here as the EXPECTED contract — if a platform gains/loses genre
// templates, update this table intentionally (it's the spec).
const CANONICAL_GENRES = ["shmup", "platformer", "puzzle", "sports", "racing"];
const EXPECTED_PLATFORMS = [
  "nes", "gb", "gbc", "snes", "genesis",
  "sms", "gg", "c64", "gba", "lynx", "atari7800",
];
// Supported platforms that have NO genre scaffolds — createGame must reject these.
const NON_GENRE_PLATFORMS = ["atari2600"];

async function startClient() {
  const server = new McpServer({ name: "r59-test", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "r59-test-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function toJSON(res) {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
}

test("R61 createGame: every genre-capable platform scaffolds all 5 genres", { timeout: 60000 }, async () => {
  const client = await startClient();
  for (const platform of EXPECTED_PLATFORMS) {
    for (const genre of CANONICAL_GENRES) {
      const tmp = mkdtempSync(path.join(os.tmpdir(), `r59-${platform}-${genre}-`));
      try {
        const r = toJSON(await client.callTool({
          name: "scaffold",
          arguments: { op: "game",  platform, genre, name: "demo", path: tmp, overwrite: true },
        }));
        assert.equal(r.platform, platform, `${platform}/${genre}: platform mismatch`);
        assert.equal(r.genre, genre, `${platform}/${genre}: genre mismatch`);
        assert.equal(r.template, genre, `${platform}/${genre}: template should equal genre`);
        const onDisk = readdirSync(tmp);
        const mainFile = onDisk.find((f) => /^main\.(c|asm|s)$/.test(f));
        assert.ok(mainFile, `${platform}/${genre}: no main.{c,asm,s} scaffolded`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
});

test("R61 createGame: platforms with no genre templates are rejected with the full supported list", async () => {
  const client = await startClient();
  for (const platform of NON_GENRE_PLATFORMS) {
    const res = await client.callTool({
      name: "scaffold",
      arguments: { op: "game",  platform, genre: "platformer", name: "demo", path: os.tmpdir() },
    });
    assert.equal(res.isError, true, `${platform}: expected an error`);
    const msg = res.content[0].text;
    assert.match(msg, new RegExp(`no genre scaffolds for platform '${platform}'`), `${platform}: wrong error`);
    // The error must advertise the newly-enabled platforms too — proof the
    // supported list is derived from TEMPLATES, not the stale hardcoded 8.
    for (const p of ["c64", "gba", "lynx"]) {
      assert.match(msg, new RegExp(`\\b${p}\\b`), `${platform} error should list ${p} as supported`);
    }
  }
});

test("R61 createGame: unknown genre rejected with the platform's available genres", async () => {
  const client = await startClient();
  const res = await client.callTool({
    name: "scaffold",
    arguments: { op: "game",  platform: "c64", genre: "fighting", name: "demo", path: os.tmpdir() },
  });
  assert.equal(res.isError, true);
  const msg = res.content[0].text;
  assert.match(msg, /genre 'fighting' not supported for platform 'c64'/);
  assert.match(msg, /shmup, platformer, puzzle, sports, racing/);
});
