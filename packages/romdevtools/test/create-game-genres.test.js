// createGame — verify each NES genre scaffold (a) produces files on disk,
// (b) builds successfully end-to-end through buildSource.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "genre-test", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "genre-test-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function toJSON(res) {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
}

for (const genre of ["shmup", "platformer", "puzzle"]) {
  test(`createGame({platform:"nes", genre:"${genre}"}) — scaffolds + builds`, async () => {
    const client = await startClient();
    const tmp = mkdtempSync(path.join(os.tmpdir(), `genre-${genre}-`));
    try {
      const create = toJSON(await client.callTool({
        name: "examples",
        arguments: { op: "fork", platform: "nes", template: genre, name: "demo", path: tmp, overwrite: true },
      }));
      assert.equal(create.platform, "nes");
      assert.equal(create.genre, genre);
      assert.equal(create.template, genre);
      // Confirm the expected NES template files landed.
      const onDisk = readdirSync(tmp).sort();
      for (const f of ["main.c", "nes_runtime.h", "nes_runtime.c", "chr-ram-runtime.crt0.s", "chr-ram-runtime.cfg", "README.md"]) {
        assert.ok(onDisk.includes(f), `missing ${f} in scaffold — got ${onDisk.join(", ")}`);
      }
      // main.c should be the genre template (not the generic default).
      const main = readFileSync(path.join(tmp, "main.c"), "utf-8");
      // Each genre's template has a unique opening comment slug.
      const slug = { shmup: "shmup.c", platformer: "platformer.c", puzzle: "puzzle.c" }[genre];
      assert.ok(main.includes(slug), `expected '${slug}' header comment in main.c`);

      // ── Build the scaffold end-to-end ─────────────────────────────
      const cfgContents = readFileSync(path.join(tmp, "chr-ram-runtime.cfg"), "utf-8");
      const build = toJSON(await client.callTool({
        name: "build",
        arguments: { output: "rom", 
          platform: "nes",
          sourcesPaths: {
            "main.c":         path.join(tmp, "main.c"),
            "nes_runtime.c":  path.join(tmp, "nes_runtime.c"),
            "_preset_crt0.s": path.join(tmp, "chr-ram-runtime.crt0.s"),
          },
          includePaths: { "nes_runtime.h": path.join(tmp, "nes_runtime.h") },
          linkerConfig: cfgContents,
        },
      }));
      assert.equal(build.ok, true, `${genre} build failed:\n${build.log}`);
      assert.ok(build.binaryBytes > 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test("createGame: the 14×5 grid is complete — atari2600/puzzle now forks", async () => {
  const client = await startClient();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "genre-a26puzzle-"));
  try {
    // As of 2026-06-11 every platform ships all five canonical genres — the
    // 2600 was the last holdout and now ships TILE TWINS (memory match-pairs,
    // a real puzzle drawn with full-width COLUPF bands, no tilemap needed). So
    // this previously-rejected combo now forks. (The genuinely-unsupported
    // genre path is covered by "rejects unsupported genre" below.)
    const res = await client.callTool({
      name: "examples",
      arguments: { op: "fork", platform: "atari2600", template: "puzzle", name: "x", path: tmp, overwrite: true },
    });
    assert.ok(!res.isError, `atari2600/puzzle should fork: ${res.content?.[0]?.text}`);
    assert.match(res.content[0].text, /atari2600\/puzzle/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("createGame rejects unsupported genre with a clear message", async () => {
  const client = await startClient();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "genre-bad2-"));
  try {
    const res = await client.callTool({
      name: "examples",
      arguments: { op: "fork", platform: "nes", template: "rpg", name: "x", path: tmp, overwrite: true },
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /no example '/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
