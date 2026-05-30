// loadSpriteSheet — R15 phase C emit / emitDefines option tests.
//
// Builds a tiny indexed PNG + manifest pair on the fly, runs loadSpriteSheet
// through the MCP client, asserts the new emit modes produce source code
// that matches the agent's expected `0xNN,0xNN /* tilename */` shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "./index.js";

async function startClient() {
  const server = new McpServer({ name: "emit-test", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "emit-test-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}

function makeTwoTileSheet(dir) {
  // 16×8 PNG → two 8×8 tiles, distinct colors.
  const png = new PNG({ width: 16, height: 8 });
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 16; x++) {
      const tile = x < 8 ? 0 : 1;
      const i = (y * 16 + x) * 4;
      png.data[i + 0] = tile === 0 ? 255 : 0;
      png.data[i + 1] = tile === 0 ? 0 : 255;
      png.data[i + 2] = 0;
      png.data[i + 3] = 255;
    }
  }
  const pngPath = path.join(dir, "sheet.png");
  const manifestPath = path.join(dir, "sheet.json");
  writeFileSync(pngPath, PNG.sync.write(png));
  writeFileSync(manifestPath, JSON.stringify({
    frames: {
      "player_idle": { frame: { x: 0, y: 0, w: 8, h: 8 } },
      "player_run":  { frame: { x: 8, y: 0, w: 8, h: 8 } },
    },
  }));
  return { pngPath, manifestPath };
}

function toJSON(res) {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
}

test("loadSpriteSheet emit='c' produces a C array with tile-name comments", async () => {
  const client = await startClient();
  const dir = mkdtempSync(path.join(tmpdir(), "emit-c-"));
  try {
    const { pngPath, manifestPath } = makeTwoTileSheet(dir);
    const r = toJSON(await client.callTool({
      name: "loadSpriteSheet",
      arguments: { pngPath, manifestPath, platform: "gb", emit: "c" },
    }));
    assert.equal(r.emit, "c");
    assert.ok(r.tile_source, "no tile_source emitted");
    assert.match(r.tile_source, /const unsigned char tiles\[\]/);
    assert.match(r.tile_source, /0x[0-9a-fA-F]{2}/);
    // Each tile boundary should have a comment naming its slice.
    assert.match(r.tile_source, /\/\* tile 0/);
    assert.match(r.tile_source, /player_idle|player_run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSpriteSheet emit='rgbasm' produces db lines suitable for RGBDS", async () => {
  const client = await startClient();
  const dir = mkdtempSync(path.join(tmpdir(), "emit-rgb-"));
  try {
    const { pngPath, manifestPath } = makeTwoTileSheet(dir);
    const r = toJSON(await client.callTool({
      name: "loadSpriteSheet",
      arguments: { pngPath, manifestPath, platform: "gb", emit: "rgbasm" },
    }));
    assert.match(r.tile_source, /^\s*db \$[0-9a-fA-F]{2}/m);
    assert.match(r.tile_source, /; tile 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSpriteSheet emit='ca65' + emitDefines emits both source + defines", async () => {
  const client = await startClient();
  const dir = mkdtempSync(path.join(tmpdir(), "emit-ca65-"));
  try {
    const { pngPath, manifestPath } = makeTwoTileSheet(dir);
    const r = toJSON(await client.callTool({
      name: "loadSpriteSheet",
      arguments: { pngPath, manifestPath, platform: "nes", emit: "ca65", emitDefines: true },
    }));
    assert.match(r.tile_source, /^\s*\.byte \$[0-9a-fA-F]{2}/m);
    assert.ok(r.defines, "expected defines field");
    assert.match(r.defines, /T_PLAYER_IDLE = \d/);
    assert.match(r.defines, /T_PLAYER_RUN = \d/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSpriteSheet dedup='preserve': every named slice gets a unique tile slot", async () => {
  const client = await startClient();
  const dir = mkdtempSync(path.join(tmpdir(), "dedup-pres-"));
  try {
    // Build a sheet where both slices have IDENTICAL pixel content. The
    // default 'merge' mode would collapse them; 'preserve' keeps both.
    const png = new PNG({ width: 16, height: 8 });
    for (let i = 0; i < 16 * 8; i++) {
      png.data[i * 4 + 0] = 100;
      png.data[i * 4 + 1] = 0;
      png.data[i * 4 + 2] = 0;
      png.data[i * 4 + 3] = 255;
    }
    const pngPath = path.join(dir, "twin.png");
    const manifestPath = path.join(dir, "twin.json");
    writeFileSync(pngPath, PNG.sync.write(png));
    writeFileSync(manifestPath, JSON.stringify({
      frames: {
        "a": { frame: { x: 0, y: 0, w: 8, h: 8 } },
        "b": { frame: { x: 8, y: 0, w: 8, h: 8 } },
      },
    }));
    // Default merge → 1 unique tile.
    const merge = toJSON(await client.callTool({
      name: "loadSpriteSheet",
      arguments: { pngPath, manifestPath, platform: "gb" },
    }));
    assert.equal(merge.tile_count, 1, "merge should collapse to 1 tile");
    // Preserve → 2 unique tiles (one per slice).
    const preserve = toJSON(await client.callTool({
      name: "loadSpriteSheet",
      arguments: { pngPath, manifestPath, platform: "gb", dedup: "preserve" },
    }));
    assert.equal(preserve.tile_count, 2, "preserve should keep 2 distinct slots");
    assert.notEqual(preserve.tiles.a.tile_indices[0], preserve.tiles.b.tile_indices[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSpriteSheet emit='raw' (default) is unchanged from pre-R15 behavior", async () => {
  const client = await startClient();
  const dir = mkdtempSync(path.join(tmpdir(), "emit-raw-"));
  try {
    const { pngPath, manifestPath } = makeTwoTileSheet(dir);
    const r = toJSON(await client.callTool({
      name: "loadSpriteSheet",
      arguments: { pngPath, manifestPath, platform: "gb" },
    }));
    assert.equal(r.emit, undefined, "no emit field when default");
    assert.equal(r.tile_source, undefined, "no tile_source field when emit:raw");
    assert.equal(r.defines, undefined, "no defines field when emit:raw");
    assert.ok(r.tile_bytes_base64, "raw mode should still expose tile_bytes_base64");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
