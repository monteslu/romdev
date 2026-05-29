// R23g — rom-hack cross-platform NES → SNES preserve path validation.
//
// The other agent's feedback (feedback_round17_intent_validation.md) offered
// to test the rom-hack path now that R23f landed the homebrew live-palette
// fix:
//
// > If you want me to test the `intent:"rom-hack"` cross-platform path
// > next, say the word. The interesting case is "NES 4-color → SNES
// > 16-color subpalette where preserve-verbatim is exactly right" —
// > that's the case your v2 reply highlighted and I haven't run.
//
// We preempt by running it ourselves. The contract under
// intent:"rom-hack" is **source bytes preserved verbatim**:
//
//   1. quantizeMode reports "skipped"
//   2. The output PNG is byte-equal to what cropSpriteSheetImpl would
//      have produced on the source extract — no palette remapping
//      happens between the two.
//   3. Output palette matches the source extract's palette exactly.
//
// We exercise NES → SNES specifically (the user's named case): the
// preserve guarantee should hold regardless of target platform under
// rom-hack, but NES → SNES is the interesting one because both
// platforms have indexed-color tile formats.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  cropSpriteSheetImpl,
  crossPlatformSpriteImportImpl,
} from "../src/mcp/tools/sprite-pipeline.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const NESTEST = path.resolve(__dirname, "roms", "nestest.nes");
const HAS_NESTEST = existsSync(NESTEST);

test("R23g rom-hack NES → SNES: composite output matches extract+crop pipeline exactly",
  { skip: !HAS_NESTEST, timeout: 60000 },
  async () => {
    // Reproduce the user-offered case: NES 4-color tiles → SNES target.
    // Under rom-hack the auto-quantize step is skipped, so the composite
    // should produce byte-equal output to the discrete extract+crop chain.

    const dir = mkdtempSync(path.join(os.tmpdir(), "r23g-romhack-"));
    try {
      // ─── Path A: composite ─────────────────────────────────────────
      const outViaComposite = path.join(dir, "via-composite.png");
      const compositeResult = await crossPlatformSpriteImportImpl({
        sourceRom: NESTEST,
        sourcePlatform: "nes",
        sourceBank: 0,
        sourceTileX: 0, sourceTileY: 0, sourceTileW: 4, sourceTileH: 2,
        targetPlatform: "snes",
        outputPng: outViaComposite,
        intent: "rom-hack",
      });
      assert.equal(compositeResult.intent, "rom-hack");
      assert.equal(compositeResult.quantizeMode, "skipped",
        "rom-hack must report quantize as 'skipped' — source bytes preserved verbatim");

      // ─── Path B: standalone extract → crop, matching the composite's
      //     internal sequence. We render the NES CHR bank to a grid PNG
      //     (renderTilesGrid is what extractSpriteSheet calls), then crop
      //     the same tile region. Output should be byte-equal.
      const fs = await import("node:fs");
      const { extractChrFromINes } = await import("../src/rom-id/patch.js");
      const { renderTilesGrid } = await import("../src/platforms/common/render-tiles.js");

      const romBytes = new Uint8Array(fs.readFileSync(NESTEST));
      const chr = extractChrFromINes(romBytes);
      assert.ok(chr, "nestest must be a CHR-ROM cart for this test to work");

      const bankPng = renderTilesGrid({
        platform: "nes",
        tileBytes: chr,
        tilesPerRow: 16,
      });
      const bankTmp = path.join(dir, "bank.png");
      fs.writeFileSync(bankTmp, bankPng);

      const outViaPipeline = path.join(dir, "via-pipeline.png");
      await cropSpriteSheetImpl({
        path: bankTmp,
        tileX: 0, tileY: 0, tileW: 4, tileH: 2,
        outputPath: outViaPipeline,
        intent: "rom-hack",
      });

      // ─── Verify byte-equal output ─────────────────────────────────
      const compositeBytes = readFileSync(outViaComposite);
      const pipelineBytes = readFileSync(outViaPipeline);
      assert.deepEqual(
        Buffer.from(compositeBytes),
        Buffer.from(pipelineBytes),
        "rom-hack composite output must byte-equal the discrete extract+crop chain — " +
        "preserve-verbatim is the whole point of the intent",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("R23g rom-hack reports source palette unchanged (no emulator read)",
  { skip: !HAS_NESTEST, timeout: 30000 },
  async () => {
    // Sanity check that R23f's palette-resolution chain doesn't
    // accidentally read the live emulator palette under rom-hack even
    // when a host happens to be available. This is the inverse of the
    // R23f homebrew test.
    const dir = mkdtempSync(path.join(os.tmpdir(), "r23g-romhack-pal-"));
    try {
      const outPng = path.join(dir, "lift.png");
      const r = await crossPlatformSpriteImportImpl({
        sourceRom: NESTEST,
        sourcePlatform: "nes",
        sourceBank: 0,
        sourceTileX: 0, sourceTileY: 0, sourceTileW: 2, sourceTileH: 2,
        targetPlatform: "snes",
        outputPng: outPng,
        intent: "rom-hack",
      });
      assert.equal(r.sourcePaletteSource, "default (grayscale)",
        "rom-hack must not silently switch on the live-palette read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("R23g rom-hack output palette is monochrome ramp (NES default render)",
  { skip: !HAS_NESTEST, timeout: 30000 },
  async () => {
    // The standalone extractSpriteSheet under rom-hack uses the default
    // grayscale ramp. The composite should match — every output palette
    // entry should have R == G == B (no color leakage).
    const dir = mkdtempSync(path.join(os.tmpdir(), "r23g-romhack-mono-"));
    try {
      const outPng = path.join(dir, "lift.png");
      const r = await crossPlatformSpriteImportImpl({
        sourceRom: NESTEST,
        sourcePlatform: "nes",
        sourceBank: 0,
        sourceTileX: 0, sourceTileY: 0, sourceTileW: 2, sourceTileH: 2,
        targetPlatform: "snes",
        outputPng: outPng,
        intent: "rom-hack",
      });
      assert.ok(Array.isArray(r.palette));
      for (const hex of r.palette) {
        const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
        if (!m) continue;
        const rch = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
        assert.equal(rch, g, `rom-hack palette entry ${hex} has non-monochrome R/G`);
        assert.equal(g, b,   `rom-hack palette entry ${hex} has non-monochrome G/B`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
