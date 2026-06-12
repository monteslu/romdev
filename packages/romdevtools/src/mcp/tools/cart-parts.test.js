// Tests for extractCart + wrapRomFromParts. The round-trip test is the
// load-bearing one — it would have caught the two NROM-128 bugs
// (off-by-one size, wrong PRG start) by simply asserting the rebuilt ROM
// is byte-identical to the source. The size-math tests pin the same
// invariants at the math layer (fast, no WASM), so regressions surface
// early in CI.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { extractCartCore, wrapRomFromPartsCore } from "./cart-parts.js";
import { diffRomsCore } from "./diff-roms.js";
import { buildForPlatform } from "../../toolchains/index.js";
import { buildExampleRom } from "../../../test/build-fixture-rom.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// A known-good NROM-128 cart: we build one from our own NES example (which
// compiles to an NROM cart), so the round-trip test runs unconditionally and
// needs no external ROM on disk.
let SAMPLE_NROM;
before(async () => { SAMPLE_NROM = await buildExampleRom("nes"); });

// ─── Size / origin math (fast, no WASM) ─────────────────────────────

test("wrapRomFromParts[nes] NROM-128: PRG at $C000 size $4000", async () => {
  const r = await wrapRomFromPartsCore({
    platform: "nes",
    prgPath: "prg.bin", chrPath: "chr.bin",
    mapper: 0, mirror: "vertical",
    prgBanks: 1, chrBanks: 1,
  });
  assert.match(r.linkerConfig, /PRG:\s+file = %O, start = \$C000, size = \$4000/);
  assert.match(r.linkerConfig, /CHR:\s+file = %O, start = \$0000, size = \$2000/);
  assert.match(r.linkerConfig, /HEADER:\s+file = %O, start = \$0000, size = \$0010/);
});

test("wrapRomFromParts[nes] NROM-256: PRG at $8000 size $8000", async () => {
  const r = await wrapRomFromPartsCore({
    platform: "nes",
    prgPath: "prg.bin", chrPath: "chr.bin",
    mapper: 0, mirror: "horizontal",
    prgBanks: 2, chrBanks: 1,
  });
  assert.match(r.linkerConfig, /PRG:\s+file = %O, start = \$8000, size = \$8000/);
  assert.match(r.linkerConfig, /CHR:\s+file = %O, start = \$0000, size = \$2000/);
});

test("wrapRomFromParts[nes] CHR-RAM: omits CHR segment + memory", async () => {
  const r = await wrapRomFromPartsCore({
    platform: "nes",
    prgPath: "prg.bin", chrPath: null,
    prgBanks: 1, chrBanks: 0,
  });
  assert.match(r.linkerConfig, /PRG:\s+file = %O, start = \$C000, size = \$4000/);
  assert.doesNotMatch(r.linkerConfig, /CHR:/);
  assert.doesNotMatch(r.wrapperSource, /\.segment "CHR"/);
});

test("wrapRomFromParts[nes] every MEMORY block has file = %O", async () => {
  const r = await wrapRomFromPartsCore({
    platform: "nes", prgPath: "p", chrPath: "c",
    prgBanks: 1, chrBanks: 1,
  });
  // Pull out the MEMORY block.
  const memBlock = r.linkerConfig.match(/MEMORY\s*\{([^}]*)\}/s)[1];
  for (const line of memBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    assert.match(trimmed, /file = %O/, `MEMORY line missing file = %O: ${trimmed}`);
  }
});

test("wrapRomFromParts[nes] unsupported prgBanks throws structured error", async () => {
  await assert.rejects(
    () => wrapRomFromPartsCore({
      platform: "nes", prgPath: "p", chrPath: "c",
      prgBanks: 4, chrBanks: 1,
    }),
    (err) => {
      assert.match(err.message, /prgBanks=4/);
      assert.match(err.message, /NROM-128|NROM-256|mapper/i);
      return true;
    },
  );
});

// ─── Round-trip (extractCart → wrapRomFromParts → buildSource → diff) ──

test("round-trip: NROM-128 cart rebuilds byte-identical", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rom-rt-"));
  const ext = await extractCartCore({ path: SAMPLE_NROM, outputDir: dir });
  assert.equal(ext.manifest.platform, "nes");
  assert.equal(ext.manifest.format, "iNES");

  const prgBytes = await readFile(ext.files["prg.bin"]);
  const chrBytes = await readFile(ext.files["chr.bin"]);

  const { wrapperSource, linkerConfig } = await wrapRomFromPartsCore({
    platform: "nes",
    prgPath: "prg.bin",
    chrPath: "chr.bin",
    mapper: ext.manifest.mapper,
    mirror: ext.manifest.mirror,
    prgBanks: ext.manifest.prgBanks,
    chrBanks: ext.manifest.chrBanks,
    hasBattery: ext.manifest.hasBattery,
  });

  const build = await buildForPlatform({
    platform: "nes",
    source: wrapperSource,
    linkerConfig,
    binaryIncludes: { "prg.bin": prgBytes, "chr.bin": chrBytes },
  });
  assert.equal(build.ok, true, `build failed:\n${build.log}`);

  const builtPath = path.join(dir, "built.nes");
  await writeFile(builtPath, build.binary);

  const diff = await diffRomsCore({ platform: "nes", aPath: SAMPLE_NROM, bPath: builtPath });
  assert.equal(diff.sizeDelta, 0, `size mismatch (${diff.a.size} vs ${diff.b.size})`);
  assert.equal(diff.totalBytesDifferent, 0,
    `round-trip diverged:\n${JSON.stringify(diff.changes.slice(0, 5), null, 2)}`);
}, { timeout: 30000 });
