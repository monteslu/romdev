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
// Per-platform expected genres. As of 2026-06-11 EVERY platform ships the full
// 5 — the 14×5 grid is complete. The 2600 was the last holdout (the TIA has no
// tilemap, so it ships a MEMORY MATCH-PAIRS puzzle, TILE TWINS, drawn with
// full-width COLUPF bands — a real puzzle, not a colored match-3 grid).
const EXPECTED_GENRES = Object.fromEntries(
  ["nes","gb","gbc","snes","genesis","sms","gg","c64","gba","lynx","atari7800","pce","msx","atari2600"]
    .map((p) => [p, CANONICAL_GENRES]),
);
const EXPECTED_PLATFORMS = Object.keys(EXPECTED_GENRES);

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

test("R61 createGame: every genre-capable platform scaffolds its genres", { timeout: 60000 }, async () => {
  const client = await startClient();
  for (const platform of EXPECTED_PLATFORMS) {
    for (const genre of EXPECTED_GENRES[platform]) {
      const tmp = mkdtempSync(path.join(os.tmpdir(), `r59-${platform}-${genre}-`));
      try {
        const r = toJSON(await client.callTool({
          name: "examples",
          arguments: { op: "fork", platform, template: genre, name: "demo", path: tmp, overwrite: true },
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

test("R61 createGame: the grid is complete — atari2600/puzzle (TILE TWINS) now forks", async () => {
  // Historically the 2600 lacked a puzzle game (no TIA tilemap → no match-3),
  // and this slot was the sentinel for the per-genre REJECTION path. As of
  // 2026-06-11 the 2600 puzzle ships as TILE TWINS (a memory match-pairs game —
  // a real puzzle that fits the TIA: full-width COLUPF bands, not a colored
  // grid), completing the 14×5 grid. So this is now a POSITIVE test: the
  // previously-missing cell forks successfully. (The per-genre/unknown-genre
  // rejection path is covered by the unknown-genre test below.)
  const tmp = mkdtempSync(path.join(os.tmpdir(), "r61-a26puzzle-"));
  try {
    const client = await startClient();
    const res = await client.callTool({
      name: "examples",
      arguments: { op: "fork", platform: "atari2600", template: "puzzle", name: "demo", path: tmp, overwrite: true },
    });
    assert.ok(!res.isError, `atari2600/puzzle should fork now: ${res.content?.[0]?.text}`);
    const onDisk = readdirSync(tmp);
    assert.ok(onDisk.some((f) => /^main\.(c|asm|s)$/.test(f)), "atari2600/puzzle: forked a main source");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R61 createGame: unknown genre rejected with the platform's available genres", async () => {
  const client = await startClient();
  const res = await client.callTool({
    name: "examples",
    arguments: { op: "fork", platform: "c64", template: "fighting", name: "demo", path: os.tmpdir() },
  });
  assert.equal(res.isError, true);
  const msg = res.content[0].text;
  assert.match(msg, /no example 'c64\/fighting'/);
  assert.match(msg, /shmup, platformer, puzzle, sports, racing/);
});
