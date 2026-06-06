// sprite-pipeline.test.js — R15 cross-game sprite-lift primitives.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cropSpriteSheetImpl, quantizePngForPlatformImpl } from "./sprite-pipeline.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const NESTEST = path.resolve(__dirname, "..", "..", "..", "test", "roms", "nestest.nes");
const HAS_NESTEST = existsSync(NESTEST);

// Make a small synthetic tile-grid PNG: 4 tile columns × 2 tile rows of
// 8×8 cells, each cell solid-colored from a fixed palette so we can
// verify cropping picks the right region.
function makeGridPng(palette, tilesPerRow, rows, tileSize = 8) {
  const w = tilesPerRow * tileSize, h = rows * tileSize;
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tx = (x / tileSize) | 0;
      const ty = (y / tileSize) | 0;
      const idx = ty * tilesPerRow + tx;
      const c = palette[idx % palette.length];
      const i = (y * w + x) * 4;
      png.data[i + 0] = c[0];
      png.data[i + 1] = c[1];
      png.data[i + 2] = c[2];
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

test("cropSpriteSheet: pulls a 2×1 region out of a 4×2 grid", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "crop-"));
  try {
    const palette = [
      [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0],
      [255, 0, 255], [0, 255, 255], [128, 128, 128], [255, 255, 255],
    ];
    const src = path.join(dir, "src.png");
    const out = path.join(dir, "out.png");
    writeFileSync(src, makeGridPng(palette, 4, 2));

    // Crop columns 1..2 (= tiles green + blue) from row 0.
    const r = await cropSpriteSheetImpl({ path: src, tileX: 1, tileY: 0, tileW: 2, tileH: 1, outputPath: out, intent: "rom-hack" });
    assert.equal(r.width, 16);
    assert.equal(r.height, 8);
    assert.equal(r.tileWidth, 2);
    assert.equal(r.tileHeight, 1);

    const decoded = PNG.sync.read(readFileSync(out));
    // First pixel of cropped output = first pixel of source cell (1,0) = green.
    assert.equal(decoded.data[0], 0);
    assert.equal(decoded.data[1], 255);
    assert.equal(decoded.data[2], 0);
    // Last pixel of cropped row 0 = last pixel of source cell (2,0) = blue.
    const lastX = (decoded.width - 1) * 4;
    assert.equal(decoded.data[lastX + 0], 0);
    assert.equal(decoded.data[lastX + 1], 0);
    assert.equal(decoded.data[lastX + 2], 255);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cropSpriteSheet: rejects out-of-bounds crop with a clear error", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "crop-oob-"));
  try {
    const src = path.join(dir, "src.png");
    const out = path.join(dir, "out.png");
    writeFileSync(src, makeGridPng([[0, 0, 0]], 2, 1));  // 16×8 px

    await assert.rejects(
      cropSpriteSheetImpl({ path: src, tileX: 0, tileY: 0, tileW: 10, tileH: 1, outputPath: out, intent: "rom-hack" }),
      /extends past image bounds/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quantizePngForPlatform(nes): reduces a 5-color PNG to a 4-color PLTE", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "quant-"));
  try {
    const src = path.join(dir, "src.png");
    const out = path.join(dir, "out.png");
    // 5 distinct colors — should be quantized to 4 (most-frequent kept).
    const png = new PNG({ width: 5, height: 1 });
    const cols = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [128, 128, 128]];
    for (let i = 0; i < 5; i++) {
      png.data[i * 4 + 0] = cols[i][0];
      png.data[i * 4 + 1] = cols[i][1];
      png.data[i * 4 + 2] = cols[i][2];
      png.data[i * 4 + 3] = 255;
    }
    writeFileSync(src, PNG.sync.write(png));
    const r = await quantizePngForPlatformImpl({ path: src, platform: "nes", outputPath: out, intent: "rom-hack" });
    assert.equal(r.paletteEntries, 4);
    assert.equal(r.inputUniqueColors, 5);
    assert.match(r.note, /5 → 4/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quantizePngForPlatform(gbc, mode:luminance): sorts palette by luma so idx 0 is lightest", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "quant-lum-"));
  try {
    const src = path.join(dir, "src.png");
    const out = path.join(dir, "out.png");
    // 4 grays.
    const png = new PNG({ width: 4, height: 1 });
    const cols = [[0, 0, 0], [80, 80, 80], [160, 160, 160], [240, 240, 240]];
    for (let i = 0; i < 4; i++) {
      png.data[i * 4 + 0] = cols[i][0];
      png.data[i * 4 + 1] = cols[i][1];
      png.data[i * 4 + 2] = cols[i][2];
      png.data[i * 4 + 3] = 255;
    }
    writeFileSync(src, PNG.sync.write(png));
    const r = await quantizePngForPlatformImpl({ path: src, platform: "gbc", outputPath: out, mode: "luminance", intent: "homebrew" });
    assert.equal(r.paletteEntries, 4);
    // First palette entry should be the lightest.
    const decoded = PNG.sync.read(readFileSync(out));
    // First pixel of source = black; after luminance sort, black has the highest index, not 0.
    // The lightest source color (240,240,240) maps to index 0. The pixel for that color
    // is at x=3 in source.
    const idxLightest = decoded.data[3 * 4]; // first byte of last pixel
    const idxDarkest = decoded.data[0];
    // We can verify by examining hex of paletteEntries: r.palette[0] should be the brightest.
    assert.equal(r.palette[0], "#f0f0f0");
    assert.equal(r.palette[3], "#000000");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("crossPlatformSpriteImport: end-to-end NES → GBC lift", { skip: !HAS_NESTEST }, async () => {
  const { crossPlatformSpriteImportImpl } = await import("./sprite-pipeline.js");
  const dir = mkdtempSync(path.join(tmpdir(), "xport-"));
  try {
    const outPng = path.join(dir, "lift.png");
    const outManifest = path.join(dir, "lift.json");
    const r = await crossPlatformSpriteImportImpl({
      sourceRom: NESTEST,
      sourcePlatform: "nes",
      sourceBank: 0,
      sourceTileX: 0, sourceTileY: 0, sourceTileW: 4, sourceTileH: 2,
      targetPlatform: "gbc",
      outputPng: outPng,
      outputManifest: outManifest,
      quantizeMode: "luminance",
      intent: "homebrew",
    });
    assert.equal(r.targetPlatform, "gbc");
    assert.equal(r.width, 32);
    assert.equal(r.height, 16);
    assert.ok(r.paletteEntries <= 4, "GBC palette should be ≤4");
    assert.equal(r.manifest.frames, 8);  // 4×2 tiles named
    // The output PNG should exist + be a valid PNG.
    const decoded = PNG.sync.read(readFileSync(outPng));
    assert.equal(decoded.width, 32);
    assert.equal(decoded.height, 16);
    // Manifest should parse with minimal shape.
    const m = JSON.parse(readFileSync(outManifest, "utf8"));
    assert.ok(m.frames);
    assert.ok(m.frames.tile_0_0);
    assert.deepEqual(m.frames.tile_0_0.frame, { x: 0, y: 0, w: 8, h: 8 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Also export crossPlatformSpriteImportImpl so the test above can import it
// without needing it in the public list. (sprite-pipeline.js exports it
// at module bottom — see the re-export there.)

test("quantizePngForPlatform: rejects unknown platform with hint", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "quant-bad-"));
  try {
    const src = path.join(dir, "src.png");
    const out = path.join(dir, "out.png");
    const png = new PNG({ width: 1, height: 1 });
    writeFileSync(src, PNG.sync.write(png));
    await assert.rejects(
      quantizePngForPlatformImpl({ path: src, platform: "spectrum", outputPath: out, intent: "homebrew" }),
      /unknown platform 'spectrum'/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
