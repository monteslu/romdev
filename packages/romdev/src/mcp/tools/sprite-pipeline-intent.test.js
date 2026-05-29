// sprite-pipeline-intent.test.js — R17 intent-axis behavior tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";

import {
  cropSpriteSheetImpl,
  quantizePngForPlatformImpl,
  crossPlatformSpriteImportImpl,
} from "./sprite-pipeline.js";

function makeFivecolorPng() {
  const png = new PNG({ width: 5, height: 1 });
  const cols = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [128, 128, 128]];
  for (let i = 0; i < 5; i++) {
    png.data[i * 4 + 0] = cols[i][0];
    png.data[i * 4 + 1] = cols[i][1];
    png.data[i * 4 + 2] = cols[i][2];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

test("intent is required — undefined rejects with a helpful error", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "intent-req-"));
  try {
    const src = path.join(dir, "src.png");
    const out = path.join(dir, "out.png");
    writeFileSync(src, makeFivecolorPng());
    await assert.rejects(
      quantizePngForPlatformImpl({ path: src, platform: "nes", outputPath: out }),
      /intent must be 'homebrew' or 'rom-hack'/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("intent rejects unknown values", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "intent-bad-"));
  try {
    const src = path.join(dir, "src.png");
    const out = path.join(dir, "out.png");
    writeFileSync(src, makeFivecolorPng());
    await assert.rejects(
      quantizePngForPlatformImpl({ path: src, platform: "nes", outputPath: out, intent: "doodlefarts" }),
      /intent must be 'homebrew' or 'rom-hack'/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("homebrew default mode is platform-master (NES) instead of frequency", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "intent-hb-"));
  try {
    const src = path.join(dir, "src.png");
    const out = path.join(dir, "out.png");
    writeFileSync(src, makeFivecolorPng());
    const r = await quantizePngForPlatformImpl({
      path: src, platform: "nes", outputPath: out, intent: "homebrew",
    });
    assert.equal(r.mode, "platform-master");
    assert.equal(r.intent, "homebrew");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rom-hack default mode is frequency (preserves what's there)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "intent-rh-"));
  try {
    const src = path.join(dir, "src.png");
    const out = path.join(dir, "out.png");
    writeFileSync(src, makeFivecolorPng());
    const r = await quantizePngForPlatformImpl({
      path: src, platform: "nes", outputPath: out, intent: "rom-hack",
    });
    assert.equal(r.mode, "frequency");
    assert.equal(r.intent, "rom-hack");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("homebrew on a non-NES platform falls back to luminance (platform-master not implemented)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "intent-hb-fallback-"));
  try {
    const src = path.join(dir, "src.png");
    const out = path.join(dir, "out.png");
    writeFileSync(src, makeFivecolorPng());
    const r = await quantizePngForPlatformImpl({
      path: src, platform: "gbc", outputPath: out, intent: "homebrew",
    });
    // Resolves homebrew → platform-master → no NES master available → falls back to luminance
    assert.equal(r.mode, "luminance");
    // First palette entry should be lightest (luma-sorted).
    const lumas = r.palette.map((hex) => {
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      return 0.299 * r + 0.587 * g + 0.114 * b;
    });
    for (let i = 1; i < lumas.length; i++) assert.ok(lumas[i - 1] >= lumas[i], "palette not sorted lightest-first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit mode wins over intent default", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "intent-override-"));
  try {
    const src = path.join(dir, "src.png");
    const out = path.join(dir, "out.png");
    writeFileSync(src, makeFivecolorPng());
    const r = await quantizePngForPlatformImpl({
      path: src, platform: "nes", outputPath: out, intent: "homebrew", mode: "frequency",
    });
    assert.equal(r.mode, "frequency", "explicit mode:'frequency' should win over homebrew's platform-master default");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("crossPlatformSpriteImport under rom-hack SKIPS the auto-quantize step", async () => {
  const NESTEST = path.resolve("test", "roms", "nestest.nes");
  const fs = await import("node:fs");
  if (!fs.existsSync(NESTEST)) {
    return;  // skip silently when ROM fixture isn't present
  }
  const dir = mkdtempSync(path.join(tmpdir(), "intent-cross-rh-"));
  try {
    const outPng = path.join(dir, "lift.png");
    const r = await crossPlatformSpriteImportImpl({
      sourceRom: NESTEST,
      sourcePlatform: "nes",
      sourceBank: 0,
      sourceTileX: 0, sourceTileY: 0, sourceTileW: 4, sourceTileH: 2,
      targetPlatform: "gbc",
      outputPng: outPng,
      intent: "rom-hack",
    });
    assert.equal(r.intent, "rom-hack");
    assert.equal(r.quantizeMode, "skipped", "rom-hack should report 'skipped' for the quantize step");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("crossPlatformSpriteImport under homebrew RUNS the auto-quantize step", async () => {
  const NESTEST = path.resolve("test", "roms", "nestest.nes");
  const fs = await import("node:fs");
  if (!fs.existsSync(NESTEST)) return;
  const dir = mkdtempSync(path.join(tmpdir(), "intent-cross-hb-"));
  try {
    const outPng = path.join(dir, "lift.png");
    const r = await crossPlatformSpriteImportImpl({
      sourceRom: NESTEST,
      sourcePlatform: "nes",
      sourceBank: 0,
      sourceTileX: 0, sourceTileY: 0, sourceTileW: 4, sourceTileH: 2,
      targetPlatform: "gbc",
      outputPng: outPng,
      intent: "homebrew",
    });
    assert.equal(r.intent, "homebrew");
    assert.notEqual(r.quantizeMode, "skipped");
    assert.ok(["platform-master", "frequency", "luminance"].includes(r.quantizeMode));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
