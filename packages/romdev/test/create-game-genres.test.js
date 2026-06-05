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
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
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
        name: "scaffold",
        arguments: { op: "game",  platform: "nes", genre, name: "demo", path: tmp, overwrite: true },
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
        name: "buildSource",
        arguments: {
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

test("createGame rejects unsupported platform with a clear message", async () => {
  const client = await startClient();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "genre-bad-"));
  try {
    // R21 added GB/GBC/SNES/Genesis genre scaffolds. Atari 2600 has no
    // C compiler so no genre scaffolds either — use it as the
    // "definitely unsupported" sentinel platform here. If we ship
    // batariBasic templates for it later, update this test to use
    // another holdout.
    const res = await client.callTool({
      name: "scaffold",
      arguments: { op: "game",  platform: "atari2600", genre: "shmup", name: "x", path: tmp, overwrite: true },
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /no genre scaffolds for platform 'atari2600'/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("createGame rejects unsupported genre with a clear message", async () => {
  const client = await startClient();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "genre-bad2-"));
  try {
    const res = await client.callTool({
      name: "scaffold",
      arguments: { op: "game",  platform: "nes", genre: "rpg", name: "x", path: tmp, overwrite: true },
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /genre 'rpg' not supported/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
