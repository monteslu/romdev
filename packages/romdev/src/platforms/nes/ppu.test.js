// PPU decoder unit tests — exercise the tile-bitplane math with a tiny
// synthetic tile, plus verify the pattern-table renderer against a real
// fceumm load.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PNG } from "pngjs";

import { decodeTile, renderPatternTablePng } from "./ppu.js";
import { resolveCore } from "../../cores/registry.js";
import { LibretroHost } from "../../host/index.js";
import { buildC } from "../../toolchains/cc65/cc65.js";
import { writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";

test("decodeTile: solid-color tile decodes to all 3s", () => {
  const tile = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    tile[i] = 0xff;
    tile[i + 8] = 0xff;
  }
  const out = decodeTile(tile);
  for (let i = 0; i < 64; i++) assert.equal(out[i], 3);
});

test("decodeTile: diagonal pattern", () => {
  const tile = new Uint8Array(16);
  for (let y = 0; y < 8; y++) tile[y] = 1 << (7 - y);
  const out = decodeTile(tile);
  for (let y = 0; y < 8; y++) {
    assert.equal(out[y * 8 + y], 1, `expected diagonal at (${y},${y})`);
  }
});

test("renderPatternTablePng: produces a valid 128x128 PNG", () => {
  const chr4k = new Uint8Array(4096);
  for (let i = 0; i < 16; i++) chr4k[i] = 0xff;
  const buf = renderPatternTablePng(chr4k);
  const img = PNG.sync.read(buf);
  assert.equal(img.width, 128);
  assert.equal(img.height, 128);
  const o0 = 0;
  assert.equal(img.data[o0 + 0], 240);
  assert.equal(img.data[o0 + 1], 240);
  assert.equal(img.data[o0 + 2], 240);
});

test("snapshotPatternTables: works against a real fceumm + cc65 nes ROM", async () => {
  const r = await buildC({ source: "void main(void){while(1){}}\n", target: "nes" });
  assert.equal(r.exitCode, 0, "build failed:\n" + r.log);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ppu-test-"));
  const romPath = path.join(tmp, "test.nes");
  await writeFile(romPath, r.binary);

  const resolved = resolveCore("nes");
  const host = new LibretroHost();
  await host.loadCore(resolved.jsPath, resolved.wasmPath);
  await host.loadMedia({ platform: "nes", path: romPath });
  host.stepFrames(10);

  const { snapshotPatternTables } = await import("./ppu.js");
  const { width, height, png } = await snapshotPatternTables(host);
  assert.equal(width, 256);
  assert.equal(height, 128);
  assert.equal(png[0], 0x89);
  assert.equal(png[1], 0x50);
  await writeFile("/tmp/nes-pattern-tables.png", png);
}, { timeout: 30000 });
