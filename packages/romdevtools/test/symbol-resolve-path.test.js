// P2 — cheap symbol→address resolution. The feedback: to read a C variable in
// WRAM the agent needed its address, but the only path was to pull the whole
// 30-60KB .map/.dbg back through context and pass it to symbols({op:'resolve'}).
//
// Two new paths, proven here cross-format:
//   (a) symbols({op:'resolve', name, dbgPath|mapPath}) — the SERVER reads the
//       debug file off disk; the agent gets back JUST {address,hex,region?,...}.
//   (b) build({output:'romWithDebug', resolveSymbols:[...]}) — resolve names off
//       the freshly-produced map in the build result, no map dumped.
//
// Covers cc65 .dbg (NES), sdld .map (GBC), GNU ld .map (Genesis).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildSourceWithDebugCore,
  resolveSymbolCore,
  resolveSymbolsBatchCore,
  loadDebugSource,
} from "../src/mcp/tools/symbols.js";

const toJSON = (res) => {
  assert.equal(res.isError, undefined, "isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
};
const tmpOut = async (name) => path.join(await mkdtemp(path.join(tmpdir(), "romdev-sym-")), name);

// ── GBC (sdld .map) — a known WRAM global. SDCC puts C globals in _DATA at
// $C0xx; resolving `grid` must give a $C0xx-ish address WITHOUT the map.
// (Non-static file-scope globals: SDCC only emits THOSE as `_name` symbols in
// the sdld map — a `static` would be area-relative-only, never resolvable.) ──
const GBC_SRC = `#include <stdint.h>
uint8_t grid[78];
uint16_t score;
void main(void){ grid[0]=1; score=0x1234; while(1){} }
`;

test("GBC: build romWithDebug writes a .map; resolve 'grid' via mapPath → $C0xx WRAM addr (no map in context)", async () => {
  const outputPath = await tmpOut("game.gbc");
  const build = toJSON(await buildSourceWithDebugCore({
    platform: "gbc", source: GBC_SRC, codeLoc: 0x150, outputPath,
  }));
  assert.equal(build.ok, true, "gbc romWithDebug build failed: " + JSON.stringify(build).slice(0, 400));
  assert.ok(build.mapPath, "expected a mapPath on disk");
  // The map is on disk and is large — the whole point is we never read it here.
  const mapBytes = (await readFile(build.mapPath)).length;
  assert.ok(mapBytes > 2000, "sanity: the sdld .map is large (" + mapBytes + "B)");

  // (a) resolve via mapPath — server reads the file.
  const loaded = await loadDebugSource({ mapPath: build.mapPath });
  const res = await resolveSymbolCore({ ...loaded, name: "grid", platform: "gbc" });
  assert.equal((res.address & 0xf000), 0xc000, "grid should land in $C0xx WRAM, got " + res.hex);
  assert.equal(res.region, "work_ram", "region should be tagged work_ram");
  assert.match(res.hex, /^\$C0/, "hex should be $C0xx-ish: " + res.hex);
});

test("GBC: build({resolveSymbols:['grid','score','nope']}) folds addresses into the result, no map dumped", async () => {
  const outputPath = await tmpOut("game.gbc");
  const build = toJSON(await buildSourceWithDebugCore({
    platform: "gbc", source: GBC_SRC, codeLoc: 0x150, outputPath,
    resolveSymbols: ["grid", "score", "nope"],
  }));
  assert.equal(build.ok, true);
  // The response carries the addresses we asked for — and NOT the map text.
  assert.ok(build.resolvedSymbols.grid, "grid resolved");
  assert.ok(build.resolvedSymbols.score, "score resolved");
  assert.equal((build.resolvedSymbols.grid.address & 0xf000), 0xc000);
  assert.equal(build.resolvedSymbols.grid.region, "work_ram");
  assert.deepEqual(build.unresolvedSymbols, ["nope"], "missing names reported");
  assert.equal(build.mapText, undefined, "raw map text must NOT be inline in the result");
});

// ── NES (cc65 .dbg) — a known global. cc65 names it '_grid' in the .dbg;
// resolve must find it under the plain name and land in BSS RAM. Uses the stock
// cc65 nes.cfg (no preset name — the romWithDebug raw path takes .cfg CONTENTS
// only), with a HEADER + tiny crt0 supplied as sources so it links. ──
const NES_HEADER_S = `.segment "HEADER"
.byte "NES", $1A
.byte 2, 1, 0, 0
.res 8, 0
`;
const NES_CRT0_S = `.export __STARTUP__ : absolute = 1
.import _main, __RAM_START__, __RAM_SIZE__
.import __STACK_START__
.segment "STARTUP"
reset: sei
  cld
  ldx #$ff
  txs
  jsr _main
hang: jmp hang
nmi: rti
irq: rti
.segment "VECTORS"
.word nmi, reset, irq
`;
const NES_MAIN_C = `volatile unsigned char grid[40];
volatile unsigned char score;
void main(void){ grid[0]=1; score=7; while(1){} }
`;
const NES_SOURCES = { "main.c": NES_MAIN_C, "header.s": NES_HEADER_S, "crt0.s": NES_CRT0_S };

test("NES: resolve 'grid' via dbgPath → RAM address (cc65 .dbg, no .dbg in context)", async () => {
  const outputPath = await tmpOut("game.nes");
  const build = toJSON(await buildSourceWithDebugCore({
    platform: "nes", sources: NES_SOURCES, outputPath,
  }));
  assert.equal(build.ok, true, "nes romWithDebug build failed: " + JSON.stringify(build).slice(0, 400));
  assert.ok(build.dbgPath, "expected a dbgPath on disk");

  const loaded = await loadDebugSource({ dbgPath: build.dbgPath });
  const res = await resolveSymbolCore({ ...loaded, name: "grid", platform: "nes" });
  // The stock cc65 nes.cfg links C BSS into the $6000 PRG-RAM window (the
  // NES "BSS must be in real RAM" placement) — still below the ROM window and
  // correctly region-tagged. The point: we got the ADDRESS, not the .dbg.
  assert.ok(res.address < 0x8000, "grid should be in RAM (< $8000), got " + res.hex);
  assert.ok(["zeropage", "stack", "system_ram", "sram"].includes(res.region),
    "grid should be in a RAM region, got region=" + res.region + " addr=" + res.hex);
});

test("NES: build({resolveSymbols}) resolves the cc65 '_grid' C alias by plain name", async () => {
  const outputPath = await tmpOut("game.nes");
  const build = toJSON(await buildSourceWithDebugCore({
    platform: "nes", sources: NES_SOURCES, outputPath,
    resolveSymbols: ["grid", "score"],
  }));
  assert.equal(build.ok, true, "nes build failed: " + JSON.stringify(build).slice(0, 400));
  assert.ok(build.resolvedSymbols.grid, "grid resolved by plain name (cc65 stores it as _grid)");
  assert.ok(build.resolvedSymbols.grid.address < 0x8000, "grid in RAM");
  assert.ok(build.resolvedSymbols.score, "score resolved");
});

// ── Genesis (GNU ld .map) — a work-RAM global gets a ramOffset for the
// system_ram read. Proves the third map format flows through the same path. ──
const GEN_SRC = `#include <genesis.h>
volatile unsigned short score;
int main(){ VDP_init(); score = 0x1234; while(1){ SYS_doVBlankProcess(); } return 0; }
`;

test("Genesis: resolve 'score' via mapPath → $E0FF work-RAM mirror + ramOffset (GNU ld .map)", async () => {
  const outputPath = await tmpOut("game.bin");
  const build = toJSON(await buildSourceWithDebugCore({
    platform: "genesis", source: GEN_SRC, outputPath,
  }));
  assert.equal(build.ok, true, "genesis romWithDebug build failed: " + JSON.stringify(build).slice(0, 400));
  assert.ok(build.mapPath, "expected a mapPath on disk");

  const loaded = await loadDebugSource({ mapPath: build.mapPath });
  const res = await resolveSymbolCore({ ...loaded, name: "score", platform: "genesis" });
  assert.equal((res.address >>> 16), 0xe0ff, "score in the $E0FF0000 work-RAM mirror: " + res.hex);
  assert.equal(typeof res.ramOffset, "number", "work-RAM symbol should carry a ramOffset");
  assert.equal(res.region, "work_ram_mirror");
});

test("Genesis: build({resolveSymbols:['score']}) folds the ramOffset into resolvedSymbols", async () => {
  const outputPath = await tmpOut("game.bin");
  const build = toJSON(await buildSourceWithDebugCore({
    platform: "genesis", source: GEN_SRC, outputPath,
    resolveSymbols: ["score"],
  }));
  assert.equal(build.ok, true);
  assert.equal((build.resolvedSymbols.score.address >>> 16), 0xe0ff);
  assert.equal(typeof build.resolvedSymbols.score.ramOffset, "number");
  assert.equal(build.resolvedSymbols.score.region, "work_ram_mirror");
});

// ── inline `dbg`/`map` still wins over a path (back-compat + precedence). ──
test("loadDebugSource: inline dbg/map takes precedence over dbgPath/mapPath", async () => {
  const loaded = await loadDebugSource({ map: "INLINE", mapPath: "/nonexistent/should-not-be-read" });
  assert.equal(loaded.map, "INLINE", "inline map must win and the path must NOT be read");
});

// ── resolveSymbolsBatchCore directly (the engine behind build resolveSymbols). ──
test("resolveSymbolsBatchCore reports both resolved and missing names", async () => {
  const outputPath = await tmpOut("game.gbc");
  const build = toJSON(await buildSourceWithDebugCore({
    platform: "gbc", source: GBC_SRC, codeLoc: 0x150, outputPath,
  }));
  const loaded = await loadDebugSource({ mapPath: build.mapPath });
  const r = await resolveSymbolsBatchCore({ ...loaded, names: ["grid", "missing1"], platform: "gbc" });
  assert.ok(r.symbols.grid, "grid present");
  assert.deepEqual(r.missing, ["missing1"]);
});
