// Full vibe-coding loop:
//   1. Agent writes Atari 2600 assembly.
//   2. MCP buildSource compiles it via bundled dasm.wasm.
//   3. MCP loadMedia loads the resulting ROM into the bundled stella core.
//   4. MCP stepAndScreenshot captures a PNG.
//
// If this passes, the entire v1 promise — write code, build, run, see — works
// for at least one platform with zero external dependencies.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// A genuinely minimal 2600 program: blue background, infinite loop.
// Pulled from the Atari 2600 homebrew tradition.
const ATARI_PROGRAM = `
  processor 6502

  org $F000

START:
  SEI
  CLD
  LDX #$FF
  TXS
  LDA #0
CLEAR:
  STA $00,X
  DEX
  BNE CLEAR

  ; set background color $90 (blue)
  LDA #$90
  STA $09           ; COLUBK

MAIN:
  ; minimal frame: vsync (3 scanlines) + vblank + 192 scanlines + overscan
  LDA #2
  STA $00           ; VSYNC on
  STA $01           ; VBLANK on
  STA $02           ; WSYNC
  STA $02
  STA $02
  LDA #0
  STA $00           ; VSYNC off

  ; 37 scanlines of vblank
  LDX #37
VB:
  STA $02
  DEX
  BNE VB

  LDA #0
  STA $01           ; VBLANK off

  ; 192 visible scanlines
  LDX #192
VL:
  STA $02
  DEX
  BNE VL

  LDA #2
  STA $01           ; VBLANK on for overscan
  LDX #30
OS:
  STA $02
  DEX
  BNE OS

  JMP MAIN

  org $FFFC
  .word START
  .word START
`;

async function startServerAndClient() {
  const server = new McpServer(
    { name: "romdev-test", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, z);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  // Progressive disclosure: deferred categories aren't auto-loaded.
  // Tests need the full tool surface; mirror the power-user "all" flow.
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}

test("vibe loop: build 2600 ROM with dasm, run in stella, screenshot", async () => {
  const client = await startServerAndClient();

  const tmp = mkdtempSync(path.join(os.tmpdir(), "romdev-e2e-"));
  const romPath = path.join(tmp, "blue.bin");

  // Build the ROM via MCP.
  const build = await client.callTool({
    name: "build",
    arguments: { output: "rom", 
      platform: "atari2600",
      source: ATARI_PROGRAM,
      outputPath: romPath,
    },
  });
  assert.equal(build.isError, undefined, "build error: " + JSON.stringify(build));
  const buildInfo = JSON.parse(build.content[0].text);
  assert.equal(buildInfo.ok, true, "buildSource failed:\n" + buildInfo.log);
  assert.equal(buildInfo.toolchain, "dasm");
  assert.equal(buildInfo.binaryBytes, 4096);

  // Load it into stella via MCP.
  const loaded = await client.callTool({
    name: "loadMedia",
    arguments: { platform: "atari2600", path: romPath },
  });
  assert.equal(loaded.isError, undefined, "load error: " + JSON.stringify(loaded));

  // Step + screenshot.
  const shot = await client.callTool({
    name: "frame", arguments: { op: "stepAndShot",  frames: 30, inline: true },
  });
  assert.equal(shot.isError, undefined, "shot error: " + JSON.stringify(shot));
  const img = shot.content.find((c) => c.type === "image");
  assert.ok(img, "expected image content");
  const png = Buffer.from(img.data, "base64");
  // PNG magic
  assert.equal(png[0], 0x89);
  assert.equal(png[1], 0x50);
});
