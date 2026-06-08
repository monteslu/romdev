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
// Per-platform expected genres. All canonical-genre platforms ship the full 5
// EXCEPT atari2600 — the TIA has no tilemap/framebuffer, so a match-3 "puzzle"
// grid can't be rendered; it ships the 4 action genres only. Every supported
// platform now ships at least one genre, so there is no fully genre-less
// platform anymore (the old NON_GENRE_PLATFORMS holdout is gone).
const EXPECTED_GENRES = {
  nes: CANONICAL_GENRES,
  gb: CANONICAL_GENRES,
  gbc: CANONICAL_GENRES,
  snes: CANONICAL_GENRES,
  genesis: CANONICAL_GENRES,
  sms: CANONICAL_GENRES,
  gg: CANONICAL_GENRES,
  c64: CANONICAL_GENRES,
  gba: CANONICAL_GENRES,
  lynx: CANONICAL_GENRES,
  atari7800: CANONICAL_GENRES,
  pce: CANONICAL_GENRES,
  msx: CANONICAL_GENRES,
  atari2600: ["shmup", "platformer", "sports", "racing"], // no puzzle (TIA)
};
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

test("R61 createGame: a genre a platform lacks is rejected with that platform's available genres", async () => {
  // Every supported platform now ships at least one genre, so there is no
  // longer a fully genre-less platform to reject wholesale. atari2600 is the
  // one platform that lacks a SPECIFIC canonical genre (puzzle — no TIA
  // tilemap), so it's the honest sentinel for the per-genre rejection path.
  const client = await startClient();
  const res = await client.callTool({
    name: "scaffold",
    arguments: { op: "game", platform: "atari2600", genre: "puzzle", name: "demo", path: os.tmpdir() },
  });
  assert.equal(res.isError, true, "atari2600/puzzle: expected an error");
  const msg = res.content[0].text;
  assert.match(msg, /genre 'puzzle' not supported for platform 'atari2600'/);
  // The error lists what atari2600 DOES have — derived from TEMPLATES, so this
  // proves the available-genre list isn't a stale parallel table.
  for (const g of ["shmup", "platformer", "sports", "racing"]) {
    assert.match(msg, new RegExp(`\\b${g}\\b`), `atari2600 error should offer ${g}`);
  }
  // ...and must NOT advertise the one genre it can't render.
  assert.doesNotMatch(msg, /\bpuzzle\b(?!')/, "atari2600 must not list puzzle as available");
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
