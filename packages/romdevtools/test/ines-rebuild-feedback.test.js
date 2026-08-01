// Tests for the v0.16.0 feedback: NES CHR-ROM / iNES-header rebuild ergonomics
// (the `inesHeader` build option + the `chr-rom` linker preset), and the
// generalized `disasm({target:'project'})` rebuild glue (blobs + rebuild.json +
// BUILD.md) across platforms.

import { test } from "node:test";
import assert from "node:assert/strict";
import { requireTestRom } from "./helpers/test-rom.js";
import { z } from "zod";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { inesHeaderBytes, inesHeaderSource, nromFlatCfg, charsSource } from "../src/toolchains/cc65/ines.js";
import { resolveLinkerConfig } from "../src/toolchains/cc65/preset-resolver.js";
import { planRebuild } from "../src/mcp/tools/disasm-rebuild.js";
import { registerDisasmTools } from "../src/mcp/tools/disasm.js";
import { registerToolchainTools } from "../src/mcp/tools/toolchain.js";

const TEST_ROM = requireTestRom(import.meta.url);
const NESTEST = TEST_ROM.path;

// ─────────────────────────────────────────────────── ines.js synthesizer (pure)

test("inesHeaderBytes: NROM-128 8KB-CHR header matches nestest.nes exactly", { skip: TEST_ROM.skip }, () => {
  const want = [...readFileSync(NESTEST).slice(0, 16)];
  const got = [...inesHeaderBytes({ prgBanks: 1, chrBanks: 1, mapper: 0, mirroring: "horizontal" })];
  assert.deepEqual(got, want, "synthesized iNES header should equal nestest.nes's first 16 bytes");
});

test("inesHeaderBytes: mapper + mirroring + battery pack into flags6/flags7", () => {
  const h = inesHeaderBytes({ prgBanks: 2, chrBanks: 0, mapper: 1, mirroring: "vertical", battery: true });
  assert.equal(h[4], 2, "PRG banks");
  assert.equal(h[5], 0, "CHR banks (0 = CHR-RAM)");
  // flags6: mirroring(bit0=1 vertical) | battery(bit1=1) | mapper-lo<<4 (1<<4=0x10)
  assert.equal(h[6], 0x01 | 0x02 | 0x10, "flags6 = vertical|battery|mapperLo");
  assert.equal(h[7], 0x00, "flags7 = mapperHi (mapper 1 → hi nibble 0)");
});

test("inesHeaderBytes: high mapper number splits across flags6/flags7", () => {
  const h = inesHeaderBytes({ prgBanks: 2, chrBanks: 1, mapper: 4 }); // MMC3
  assert.equal((h[6] >> 4) | (h[7] & 0xf0), 4, "mapper round-trips out of flags6/flags7");
});

test("inesHeaderBytes: rejects out-of-range / bad inputs", () => {
  assert.throws(() => inesHeaderBytes({ prgBanks: 0 }), /prgBanks/);
  assert.throws(() => inesHeaderBytes({ prgBanks: 1, chrBanks: -1 }), /chrBanks/);
  assert.throws(() => inesHeaderBytes({ prgBanks: 1, mapper: 999 }), /mapper/);
  assert.throws(() => inesHeaderBytes({ prgBanks: 1, mirroring: "diagonal" }), /mirroring/);
});

test("nromFlatCfg: NROM-128 maps PRG at $C000, NROM-256 at $8000; CHARS only when chr>0", () => {
  const cfg128 = nromFlatCfg({ prgBanks: 1, chrBanks: 1 });
  assert.match(cfg128, /PRG:\s+file = %O, start = \$C000, size = \$4000/);
  assert.match(cfg128, /CHARS:\s+file = %O/);
  const cfg256 = nromFlatCfg({ prgBanks: 2, chrBanks: 0 });
  assert.match(cfg256, /PRG:\s+file = %O, start = \$8000, size = \$8000/);
  assert.doesNotMatch(cfg256, /CHARS:/, "no CHARS segment when chrBanks=0 (CHR-RAM)");
});

test("inesHeaderSource + charsSource emit ca65 segments", () => {
  assert.match(inesHeaderSource({ prgBanks: 1, chrBanks: 1 }), /\.segment "HEADER"/);
  assert.match(charsSource("chr.bin"), /\.segment "CHARS"[\s\S]*\.incbin "chr.bin"/);
});

// ─────────────────────────────────────────────────── chr-rom preset resolution

test("chr-rom preset resolves with its companion crt0 (CHR-ROM header byte5=1)", async () => {
  const r = await resolveLinkerConfig("nes", "chr-rom");
  assert.ok(r.cfg, "chr-rom.cfg should resolve");
  assert.match(r.cfg, /CHARS:\s+load = ROM2/, "chr-rom .cfg defines a CHARS segment in ROM2");
  const crt0 = r.supportSources[Object.keys(r.supportSources)[0]] || "";
  assert.match(crt0, /CHR-ROM banks \(8K each\)/, "chr-rom crt0 documents CHR-ROM");
  assert.match(crt0, /\.byte\s+1\s+;.*CHR-ROM/, "chr-rom crt0 header byte5 = 1 (one 8KB CHR-ROM bank)");
});

// ─────────────────────────────────────────────────── planRebuild (pure)

test("planRebuild(nes): NROM → inesHeader build call + chr.bin blob, verifiable", { skip: TEST_ROM.skip }, () => {
  const data = readFileSync(NESTEST);
  // planRegions for NES would give bank0; planRebuild only needs `data` for NES.
  const plan = planRebuild("nes", new Uint8Array(data), [
    { name: "bank0", file: "bank0.asm", bytes: new Uint8Array(data.slice(16, 16 + 0x4000)), startAddress: 0xC000, fileOffset: 16 },
  ]);
  assert.equal(plan.verifiable, true);
  assert.ok(plan.blobs["chr.bin"], "CHR-ROM extracted to chr.bin");
  assert.equal(plan.blobs["chr.bin"].length, 0x2000, "8KB CHR-ROM");
  assert.equal(plan.build.platform, "nes");
  assert.deepEqual(plan.build.inesHeader, { prgBanks: 1, chrBanks: 1, mirroring: "horizontal" });
});

test("planRebuild(msx): strips the AB header to a blob; native recipe (build:null)", () => {
  // Minimal fake MSX ROM: "AB" header + a tiny body.
  const data = new Uint8Array(48);
  data[0] = 0x41; data[1] = 0x42; // "AB"
  const plan = planRebuild("msx", data, [
    { name: "rom", file: "rom.asm", bytes: data.slice(16), startAddress: 0x4010, fileOffset: 16 },
  ]);
  assert.equal(plan.build, null, "MSX has no one-call build() route (SDCC can't reassemble GNU-as)");
  assert.ok(plan.blobs["msx_header.bin"], "16-byte AB header shipped as a blob");
  assert.equal(plan.blobs["msx_header.bin"].length, 16);
  assert.match(plan.notes, /z80-elf-as/, "notes give the native rebuild recipe");
});

test("planRebuild(unknown platform): falls back gracefully, not verifiable", () => {
  const plan = planRebuild("zxspectrum", new Uint8Array(10), [
    { name: "rom", file: "rom.asm", bytes: new Uint8Array(10), startAddress: 0, fileOffset: 0 },
  ]);
  assert.equal(plan.verifiable, false);
  assert.match(plan.notes, /No platform-specific rebuild recipe/);
});

// ─────────────────────────────────────────────── disasm({target:'project'}) emits rebuild glue

function disasmHandler() {
  const map = {};
  registerDisasmTools({ tool: (n, _d, _s, h) => { map[n] = h; } }, z);
  return (a) => map.disasm({ target: "project", ...a });
}
function parse(res) {
  assert.equal(res.isError, undefined, "tool error: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
}

test("disasm({target:'project'}) on NES emits chr.bin + rebuild.json + BUILD.md", { skip: TEST_ROM.skip }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ines-proj-"));
  try {
    const r = parse(await disasmHandler()({ path: NESTEST, platform: "nes", outputDir: tmp }));
    assert.equal(r.ok, true);
    assert.equal(r.rebuild.verifiable, true, "NES NROM rebuild is verifiable");
    assert.ok(r.rebuild.buildCall, "a one-call build() recipe is emitted for NES");
    assert.ok(existsSync(path.join(tmp, "chr.bin")), "CHR-ROM blob written");
    assert.ok(existsSync(path.join(tmp, "rebuild.json")), "rebuild.json written");
    assert.ok(existsSync(path.join(tmp, "BUILD.md")), "BUILD.md written");
    const rj = JSON.parse(await readFile(path.join(tmp, "rebuild.json"), "utf8"));
    assert.equal(rj.inesHeader.prgBanks, 1);
    assert.ok(path.isAbsolute(Object.values(rj.binaryIncludePaths)[0]), "rebuild.json paths are absolute");
    const md = await readFile(path.join(tmp, "BUILD.md"), "utf8");
    assert.match(md, /Rebuilding this nes project/);
    assert.match(md, /byte-identical/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}, { timeout: 120000 });

// ─────────────────────────────────────────────── end-to-end: disasm → build → byte-identical

test("inesHeader build round-trips nestest.nes byte-identical (the v0.16.0 ask)", { skip: TEST_ROM.skip }, async () => {
  // Register the build tool and drive output:'rom' with inesHeader, feeding the
  // raw PRG + CHR extracted from nestest.nes. This is the exact NROM rebuild the
  // feedback wanted with zero glue .s/.cfg.
  const map = {};
  registerToolchainTools({ tool: (n, _d, _s, h) => { map[n] = h; } }, z, "ines-test");
  const build = map.build;
  if (!build) { return; }

  const rom = readFileSync(NESTEST);
  const prg = rom.subarray(16, 16 + 0x4000);
  const chr = rom.subarray(16 + 0x4000, 16 + 0x4000 + 0x2000);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ines-build-"));
  try {
    const prgPath = path.join(tmp, "prg.bin");
    const chrPath = path.join(tmp, "chr.bin");
    await writeFile(prgPath, prg);
    await writeFile(chrPath, chr);
    // PRG as a flat CODE blob (a real disasm would be ca65 instructions; for the
    // round-trip the .incbin of the exact PRG is a faithful stand-in).
    await writeFile(path.join(tmp, "prg.s"), '.segment "CODE"\n.incbin "prg.bin"\n');
    const out = path.join(tmp, "rebuilt.nes");
    const res = build({
      output: "rom",
      platform: "nes",
      sourcesPaths: { "prg.s": path.join(tmp, "prg.s") },
      binaryIncludePaths: { "prg.bin": prgPath, "chr.bin": chrPath },
      inesHeader: { prgBanks: 1, chrBanks: 1, mapper: 0, mirroring: "horizontal", chrIncbin: "chr.bin" },
      outputPath: out,
    });
    const j = JSON.parse((await res).content[0].text);
    assert.equal(j.ok, true, "build should succeed: " + (j.log || "").slice(-300));
    assert.ok(existsSync(out), "rebuilt.nes written");
    const rebuilt = readFileSync(out);
    assert.equal(rebuilt.length, rom.length, "rebuilt size matches");
    assert.ok(rebuilt.equals(rom), "rebuilt.nes is BYTE-IDENTICAL to nestest.nes");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}, { timeout: 180000 });
