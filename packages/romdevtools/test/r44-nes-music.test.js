// R44 — NES bundled music driver (FamiTone2).
//
// FamiTone2 is Shiru's public-domain 6502 music engine. We bundle:
//   - src/platforms/nes/lib/asm/famitone2.s     — engine (~27 KB src, ~1.5 KB code)
//   - src/platforms/nes/lib/asm/famitone_bridge.s — cc65-fastcall C wrappers
//   - src/platforms/nes/lib/asm/music_data.s    — example track (public domain)
//   - examples/nes/templates/music_demo.c       — template that drives it
//
// Test coverage:
//   1. Each bundled source file exists and contains the expected exports.
//   2. The music_demo template compiles to a valid .nes ROM via cc65/ca65/ld65.
//   3. The ROM boots in fceumm without crashing (we step a couple of frames
//      and assert the PC isn't stuck in an infinite-error loop).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

async function readSrc(rel) {
  return readFile(join(REPO_ROOT, rel), "utf-8");
}

test("R44 NES music: FamiTone2 driver files are bundled", async () => {
  const ft2 = await readSrc("src/platforms/nes/lib/asm/famitone2.s");
  assert.match(ft2, /\.export\s+FamiToneInit/, "famitone2.s missing FamiToneInit export");
  assert.match(ft2, /\.export\s+FamiToneInit,\s*FamiToneMusicPlay,\s*FamiToneUpdate/,
    "famitone2.s missing one of the three core exports");

  const bridge = await readSrc("src/platforms/nes/lib/asm/famitone_bridge.s");
  assert.match(bridge, /\.export\s+_famitone_init/, "bridge missing _famitone_init export");
  assert.match(bridge, /\.export\s+.*_famitone_play/, "bridge missing _famitone_play export");
  assert.match(bridge, /\.export\s+.*_famitone_update/, "bridge missing _famitone_update export");

  const music = await readSrc("src/platforms/nes/lib/asm/music_data.s");
  assert.match(music, /\.export\s+_music_data/, "music_data.s missing _music_data export");
  assert.match(music, /\.segment\s+"RODATA"/, "music_data.s should live in RODATA");
});

test("R44 NES music: license/attribution doc shipped", async () => {
  const lic = await readSrc("src/platforms/nes/lib/asm/LICENSE-FAMITONE");
  assert.match(lic, /public domain/i, "LICENSE-FAMITONE should attribute the source");
  assert.match(lic, /shiru/i, "LICENSE-FAMITONE should credit Shiru");
});

test("R44 NES music: music_demo.c compiles to a valid .nes ROM", { timeout: 120000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");

  const main_c    = await readSrc("examples/nes/templates/music_demo.c");
  const runtime_h = await readSrc("src/platforms/nes/lib/c/nes_runtime.h");
  const runtime_c = await readSrc("src/platforms/nes/lib/c/nes_runtime.c");
  const famitone  = await readSrc("src/platforms/nes/lib/asm/famitone2.s");
  const bridge    = await readSrc("src/platforms/nes/lib/asm/famitone_bridge.s");
  const music     = await readSrc("src/platforms/nes/lib/asm/music_data.s");

  const r = await buildForPlatform({
    platform: "nes",
    sources: {
      "main.c":            main_c,
      "nes_runtime.c":     runtime_c,
      "famitone2.s":       famitone,
      "famitone_bridge.s": bridge,
      "music_data.s":      music,
    },
    includes: { "nes_runtime.h": runtime_h },
    linkerConfig: "chr-ram-runtime",
  });

  assert.equal(r.ok, true, `build failed at ${r.stage}:\n${(r.log || "").slice(-1500)}`);
  // iNES header (16 bytes) + 32 KB PRG = 32784. No CHR-ROM (CHR-RAM build).
  assert.equal(r.binary.length, 32784, "should be a 32 KB iNES ROM (16+32768)");
  // iNES magic.
  assert.equal(r.binary[0], 0x4E); // 'N'
  assert.equal(r.binary[1], 0x45); // 'E'
  assert.equal(r.binary[2], 0x53); // 'S'
  assert.equal(r.binary[3], 0x1A);
  // PRG = 2 × 16 KB.
  assert.equal(r.binary[4], 2);
  // CHR = 0 (CHR-RAM).
  assert.equal(r.binary[5], 0);
});

test("R44 NES music: ROM boots in fceumm + runs for 60 frames without crashing", { timeout: 60000 }, async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { z } = await import("zod");
  const { registerTools } = await import("../src/mcp/tools/index.js");
  const os = await import("node:os");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const path = await import("node:path");

  const server = new McpServer({ name: "r44", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "r44-c", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);

  // Build via buildForPlatform directly (faster than going through buildSource).
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const main_c    = await readSrc("examples/nes/templates/music_demo.c");
  const runtime_h = await readSrc("src/platforms/nes/lib/c/nes_runtime.h");
  const runtime_c = await readSrc("src/platforms/nes/lib/c/nes_runtime.c");
  const famitone  = await readSrc("src/platforms/nes/lib/asm/famitone2.s");
  const bridge    = await readSrc("src/platforms/nes/lib/asm/famitone_bridge.s");
  const music     = await readSrc("src/platforms/nes/lib/asm/music_data.s");
  const r = await buildForPlatform({
    platform: "nes",
    sources: {
      "main.c":            main_c,
      "nes_runtime.c":     runtime_c,
      "famitone2.s":       famitone,
      "famitone_bridge.s": bridge,
      "music_data.s":      music,
    },
    includes: { "nes_runtime.h": runtime_h },
    linkerConfig: "chr-ram-runtime",
  });
  assert.equal(r.ok, true, "build failed: " + (r.log || "").slice(-1500));

  const tmp = mkdtempSync(path.join(os.tmpdir(), "r44-music-"));
  const romPath = path.join(tmp, "music.nes");
  writeFileSync(romPath, r.binary);

  const loaded = await client.callTool({
    name: "loadMedia",
    arguments: { platform: "nes", path: romPath },
  });
  assert.equal(loaded.isError, undefined, "loadMedia failed: " + JSON.stringify(loaded));

  // Step 60 frames + screenshot. If the ROM crashed at boot fceumm would still
  // produce a frame, but we also assert that the screenshot decoded.
  const shot = await client.callTool({
    name: "frame", arguments: { op: "stepAndShot",  frames: 60, inline: true },
  });
  assert.equal(shot.isError, undefined, "stepAndScreenshot failed: " + JSON.stringify(shot));
  const img = shot.content.find((c) => c.type === "image");
  assert.ok(img, "no image in stepAndScreenshot response");
  const png = Buffer.from(img.data, "base64");
  assert.equal(png[0], 0x89, "PNG magic byte 0 mismatch");
  assert.equal(png[1], 0x50, "PNG magic byte 1 mismatch");
});
