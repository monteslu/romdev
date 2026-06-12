// R23f regression test for a cross-platform live-palette bug.
//
// Bug: crossPlatformSpriteImport({intent:"homebrew"}) did not propagate
// the source ROM's live emulator palette through to its internal extract
// step. Output was the GBC homebrew fallback palette (grayscale-toned
// #fcfcfc / #bcbcbc / #7c7c7c / #000000) instead of the vivid colors
// the equivalent standalone extractSpriteSheet would have produced.
//
// Fix: the composite now mirrors extractSpriteSheet's palette resolution
// — when intent:"homebrew" and a ROM is loaded for sourcePlatform, it
// reads the live palette via decodeLivePalette and passes it into
// renderTilesGrid for the internal extract.
//
// This test exercises the bug's exact repro: load a built example ROM, step
// past boot, call crossPlatformSpriteImport, assert the response surfaces
// `sourcePaletteSource: "emulator (subpalette N)"` AND the resulting
// PNG isn't the pure grayscale fallback.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";
import { buildExampleRom } from "./build-fixture-rom.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Build a real, bootable NES ROM from our own example source so these tests run
// unconditionally and reference no external ROM on disk.
let ROM_PATH;
before(async () => { ROM_PATH = await buildExampleRom("nes"); });

async function startSession() {
  const server = new McpServer(
    { name: "r23f-test", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "r23f-test-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function parseToolJson(res) {
  return JSON.parse(res.content.find((c) => c.type === "text").text);
}

test("R23f crossPlatformSpriteImport propagates live source palette under intent:homebrew",
  { timeout: 60000 },
  async () => {
    const client = await startSession();
    const dir = mkdtempSync(path.join(os.tmpdir(), "r23f-"));
    try {
      // Load the example NES build into the host.
      const loadResult = await client.callTool({
        name: "loadMedia",
        arguments: { platform: "nes", path: ROM_PATH },
      });
      assert.equal(loadResult.isError, undefined, "loadMedia failed: " + JSON.stringify(loadResult));

      // Step past boot so the game writes its palette during init.
      await client.callTool({ name: "frame", arguments: { op: "step",  frames: 300 } });

      // Now run the composite under intent:"homebrew" with no explicit
      // paletteFromEmulator — the intent default should kick in and pull
      // the live palette automatically.
      const outPng = path.join(dir, "lift.png");
      const res = await client.callTool({
        name: "importArt",
        arguments: {
          from: "rom",
          sourceRom: ROM_PATH,
          sourcePlatform: "nes",
          sourceBank: 0,
          sourceTileX: 0, sourceTileY: 0, sourceTileW: 4, sourceTileH: 2,
          platform: "gbc",
          outputPng: outPng,
          intent: "homebrew",
          paletteIndex: 1,  // BG palette 1 — the example writes a non-grayscale (blue) palette here
        },
      });
      assert.equal(res.isError, undefined, "composite tool errored: " + JSON.stringify(res));
      const parsed = parseToolJson(res);

      // Invariant 1: sourcePaletteSource surfaces and reports it came
      // from the emulator. This is what tells the agent "the bug fix
      // worked, you got vivid colors, not the grayscale fallback."
      assert.ok(parsed.sourcePaletteSource, "missing sourcePaletteSource in response");
      assert.match(
        parsed.sourcePaletteSource,
        /^emulator \(subpalette \d+\)$/,
        `sourcePaletteSource should report 'emulator (subpalette N)' — got '${parsed.sourcePaletteSource}'`,
      );

      // Invariant 2: the response's output palette must not be the GBC
      // homebrew fallback (the bug's exact symptom). The fallback is
      // strictly monochrome (every entry has R == G == B), so we assert
      // at least one color in the output palette has color information.
      assert.ok(Array.isArray(parsed.palette), "palette missing from response");
      const hasColor = parsed.palette.some((hex) => {
        // hex is "#rrggbb" — parse the 3 channels and check they differ.
        const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
        if (!m) return false;
        const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
        return r !== g || g !== b;
      });
      assert.ok(
        hasColor,
        `output palette looks monochrome (the bug's exact symptom) — got ${JSON.stringify(parsed.palette)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("R23f crossPlatformSpriteImport intent:rom-hack still uses grayscale (no regression)",
  { timeout: 60000 },
  async () => {
    // rom-hack default is colorMode:"none" → no emulator palette read →
    // sourcePaletteSource stays "default (grayscale)". This protects the
    // forensic workflow from accidentally pulling live colors when the
    // agent wants byte-preserve behavior.
    const client = await startSession();
    const dir = mkdtempSync(path.join(os.tmpdir(), "r23f-rh-"));
    try {
      await client.callTool({
        name: "loadMedia",
        arguments: { platform: "nes", path: ROM_PATH },
      });
      await client.callTool({ name: "frame", arguments: { op: "step",  frames: 300 } });

      const outPng = path.join(dir, "lift.png");
      const res = await client.callTool({
        name: "importArt",
        arguments: {
          from: "rom",
          sourceRom: ROM_PATH,
          sourcePlatform: "nes",
          sourceBank: 0,
          sourceTileX: 0, sourceTileY: 0, sourceTileW: 4, sourceTileH: 2,
          platform: "gbc",
          outputPng: outPng,
          intent: "rom-hack",
        },
      });
      assert.equal(res.isError, undefined);
      const parsed = parseToolJson(res);
      assert.equal(parsed.sourcePaletteSource, "default (grayscale)",
        "rom-hack must NOT silently pull live palette");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("R23f crossPlatformSpriteImport with explicit paletteFromEmulator:true requires loaded ROM",
  { timeout: 30000 },
  async () => {
    // Explicit opt-in without a loaded ROM should error, not silently
    // fall back. Mirrors extractSpriteSheet's same behavior.
    const client = await startSession();  // fresh session — no ROM loaded
    const dir = mkdtempSync(path.join(os.tmpdir(), "r23f-noload-"));
    try {
      const outPng = path.join(dir, "lift.png");
      const res = await client.callTool({
        name: "importArt",
        arguments: {
          from: "rom",
          sourceRom: ROM_PATH,
          sourcePlatform: "nes",
          sourceBank: 0,
          sourceTileX: 0, sourceTileY: 0, sourceTileW: 2, sourceTileH: 2,
          platform: "gbc",
          outputPng: outPng,
          intent: "homebrew",
          paletteFromEmulator: true,  // explicit — should error w/o ROM
        },
      });
      // safeTool wraps errors as isError:true in the response.
      assert.equal(res.isError, true,
        "expected error when paletteFromEmulator:true with no ROM");
      assert.match(
        res.content[0].text,
        /requires a loaded ROM/i,
        "error message should mention the loaded-ROM requirement",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
