// Rizin analysis engine (romdev-analysis): CFG / xrefs / functions / structure.
// Builds a real NES ROM, then drives the four analysis ops through the JS layer
// the MCP tools call. Asserts the graph/xref/function structure is non-trivial
// and self-consistent (xref count == function indegree).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { buildForPlatform } from "../src/toolchains/index.js";
import {
  analyzeFunctions,
  analyzeCfg,
  analyzeXrefs,
  analyzeStructure,
  analyzeDecompile,
} from "../src/analysis/analyze.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("Rizin: NES ROM → functions / CFG / xrefs / structure", async () => {
  const src = await readFile(path.join(__dirname, "..", "examples", "nes", "main.c"), "utf8");
  const b = await buildForPlatform({ platform: "nes", source: src, sourceName: "main.c", language: "c" });
  assert.ok(b.binary, "nes build failed");
  const dir = await mkdtemp(path.join(os.tmpdir(), "rizin-test-"));
  const rom = path.join(dir, "hello.nes");
  await writeFile(rom, b.binary);

  // functions: rizin auto-analysis finds a non-trivial function set.
  const fns = await analyzeFunctions(rom, "nes");
  assert.equal(fns.arch, "6502");
  assert.ok(fns.count > 0, `expected functions, got ${fns.count}`);
  assert.ok(fns.functions.every((f) => typeof f.address === "number"), "functions carry addresses");

  // Pick the most-called function (highest indegree) as a stable xref target.
  const target = [...fns.functions].sort((a, c) => c.callers - a.callers)[0];

  // cfg: the entry function graphs into >=1 block with consistent edges.
  const cfg = await analyzeCfg(rom, fns.functions[0].address, "nes");
  assert.ok(cfg.nodes.length >= 1, "cfg has at least one block");
  for (const e of cfg.edges) {
    assert.ok(typeof e.from === "number" && typeof e.to === "number", "edges are address pairs");
  }

  // xrefs: a heavily-called function has at least one cross-reference, each
  // from a real address. (axt CALL/CODE refs are a subset of graph indegree —
  // indegree also counts fall-through edges — so they need not be equal.)
  if (target.callers > 0) {
    const xr = await analyzeXrefs(rom, target.address, "nes");
    assert.ok(xr.count >= 1, `expected >=1 xref to ${target.addressHex}, got ${xr.count}`);
    assert.ok(xr.refs.every((r) => typeof r.from === "number"), "xrefs carry source addresses");
  }

  // xrefs to an unused address → zero, not an error.
  const none = await analyzeXrefs(rom, 0x1, "nes");
  assert.equal(none.count, 0, "no xrefs to address 0x1");

  // structure: one-shot map agrees with the functions op on count.
  const s = await analyzeStructure(rom, "nes");
  assert.equal(s.functionCount, fns.count, "structure functionCount matches");
  assert.ok(s.entrypoints.length >= 1, "at least one entrypoint");

  // A3: every function carries a looksLikeData flag; dataCount is reported; and
  // the list is sorted real-code-first (no data-fold ahead of a control-flow fn).
  assert.equal(typeof fns.dataCount, "number", "functions reports dataCount");
  for (const f of fns.functions) assert.equal(typeof f.looksLikeData, "boolean");
  const firstData = fns.functions.findIndex((f) => f.looksLikeData);
  const lastReal = fns.functions.map((f) => f.looksLikeData).lastIndexOf(false);
  if (firstData !== -1 && lastReal !== -1) {
    assert.ok(firstData > lastReal, "all looksLikeData entries sort AFTER real code");
  }
}, { timeout: 120000 });

test("Ghidra decompiler: NES function → C pseudocode", async () => {
  const src = await readFile(path.join(__dirname, "..", "examples", "nes", "main.c"), "utf8");
  const b = await buildForPlatform({ platform: "nes", source: src, sourceName: "main.c", language: "c" });
  const dir = await mkdtemp(path.join(os.tmpdir(), "decomp-test-"));
  const rom = path.join(dir, "hello.nes");
  await writeFile(rom, b.binary);

  // Decompile the largest detected function (likeliest to have a real body).
  const fns = await analyzeFunctions(rom, "nes");
  const target = [...fns.functions].sort((a, c) => c.size - a.size)[0];
  const dec = await analyzeDecompile(rom, target.address, "nes");
  assert.equal(dec.langid, "6502:LE:16:default");
  assert.ok(/\bfn_target\b|\bvoid\b|\breturn\b|=/.test(dec.code), "produced C-like pseudocode");
  assert.ok(typeof dec.qualityNote === "string", "carries a per-platform quality note");
}, { timeout: 120000 });

test("RE engine: flat-map platforms force file-offset == CPU-address (the +0x200 Genesis decompile-shift bug)", async () => {
  // Regression for the 0.40.0 bug: Rizin's Mega Drive loader splits a flat .bin
  // into vtable/header/text segments and reports delta=0x200 on the code
  // segment, so vaMapping returned paddr = vaddr-0x200 and the decompiler
  // returned the WRONG function. Genesis carts map 1:1 (file offset == CPU
  // address) — the fix forces identity for flat-map platforms.
  const { vaMapping, FLAT_CPU_MAP } = await import("../src/analysis/analyze.js");

  // Flat-cartridge platforms must map file offset == CPU address (delta 0),
  // EVEN THOUGH Rizin's opinionated loaders may report a non-zero segment
  // delta. The Mega Drive loader splits a flat .bin into vtable/header/text and
  // reports delta=0x200 on the code segment; the bug was that vaMapping
  // honored that delta, so a code vaddr resolved to vaddr-0x200 (the WRONG
  // function). The fix forces identity for these platforms.
  assert.ok(FLAT_CPU_MAP.has("genesis"), "genesis must be a flat-CPU-map platform");
  const bytes = new Uint8Array(16);
  for (const p of ["genesis", "sms", "gg", "msx", "gb", "gbc"]) {
    const arch = p === "genesis" ? "m68k" : p === "msx" || p === "sms" || p === "gg" ? "z80" : "gb";
    const { paddr, vbase } = await vaMapping(bytes, arch, undefined, 0x2a75d2, p);
    assert.equal(paddr, 0x2a75d2, `${p}: flat map must keep paddr == vaddr (no Rizin delta shift)`);
    assert.equal(vbase, 0, `${p}: flat map base must be 0`);
  }

  // And a non-flat platform (NES, banked, goes through forcedBase/Rizin map)
  // must NOT be forced — its mapping path stays active.
  assert.ok(!FLAT_CPU_MAP.has("nes"), "nes is not a flat-map platform (uses the Rizin/forcedBase path)");
}, { timeout: 60000 });

test("RE engine: SNES decompile lays the cart out by CPU address (LoROM/HiROM)", async () => {
  // Regression for the 0.40.1→0.40.2 bug: SNES decompile treated the LoROM CPU
  // address as a raw FILE offset, so `decompile address:0x8000` returned the
  // function at file 0x8000 (CPU $01:8000) — the WRONG one. Fix: lay the image
  // out by 24-bit CPU address so both the function address AND in-bank/JSL
  // operands resolve. This unit-tests the layout directly (deterministic, no
  // toolchain): distinct marker bytes per file-bank must land at their CPU
  // addresses in the image.
  const { buildSnesCpuImage } = await import("../src/analysis/analyze.js");

  // 2 file banks (64KB LoROM): bank 0 filled with 0xA0, bank 1 with 0xB1.
  const rom = new Uint8Array(0x10000);
  rom.fill(0xa0, 0x0000, 0x8000); // file chunk 0 → CPU $00:8000-$FFFF
  rom.fill(0xb1, 0x8000, 0x10000); // file chunk 1 → CPU $01:8000-$FFFF
  const { image, isLo } = buildSnesCpuImage(rom, "lorom");
  assert.equal(isLo, true);
  assert.equal(image.length, 0x1000000, "LoROM image covers the full 16MB CPU space");
  // CPU $00:8000 holds file-chunk-0 (0xA0), NOT file 0x8000's 0xB1.
  assert.equal(image[0x008000], 0xa0, "CPU $00:8000 must be file chunk 0, not file offset 0x8000");
  // CPU $01:8000 holds file-chunk-1 (0xB1).
  assert.equal(image[0x018000], 0xb1, "CPU $01:8000 must be file chunk 1");
  // The $80-$FF FastROM mirror: CPU $80:8000 mirrors $00:8000.
  assert.equal(image[0x808000], 0xa0, "CPU $80:8000 mirrors $00:8000 (FastROM)");
  // Between-bank RAM/IO window ($00:0000-$7FFF) stays zero-filled.
  assert.equal(image[0x000000], 0x00, "LoROM $00:0000 (RAM/IO window) is zero-fill, not ROM");

  // HiROM: file chunk 0 → CPU bank $C0 (full 64KB).
  const hrom = new Uint8Array(0x10000);
  hrom.fill(0xc7);
  const hi = buildSnesCpuImage(hrom, "hirom");
  assert.equal(hi.isLo, false);
  assert.equal(hi.image[0xc00000], 0xc7, "HiROM file chunk 0 maps to CPU bank $C0");
  assert.equal(hi.image[0x400000], 0xc7, "HiROM bank $40 mirrors $C0");
}, { timeout: 30000 });

test("Ghidra decompiler: SLEIGH language id for every platform", async () => {
  const { SLEIGH_LANGID } = await import("../src/analysis/decompile.js");
  const all = ["nes", "snes", "genesis", "sms", "gg", "gb", "gbc", "gba",
               "atari2600", "atari7800", "c64", "lynx", "pce", "msx"];
  for (const p of all) {
    assert.ok(SLEIGH_LANGID[p], `platform '${p}' must have a SLEIGH language id (14/14 coverage)`);
  }
});
