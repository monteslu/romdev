// Tests for the Genesis-focused tooling added from the block-tile/palette
// feedback: getTile VRAM byte-swap correction, the m68k linker map, and the
// map-address → system_ram-offset workflow.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerTileInspectTools } from "../src/mcp/tools/tile-inspect.js";
import { _setHostForTest } from "../src/mcp/state.js";
import { buildForPlatform } from "../src/toolchains/index.js";
import { finalizeGenesisRom } from "romdev-toolchain-m68k-gcc";
import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "romdev-core-host/index.js";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function tileHandlers() {
  const map = {};
  // getTile is now tiles({op:'pixels'}). registerTileInspectTools registers the
  // consolidated `tiles` router; adapt so these (frozen) assertions are unchanged.
  registerTileInspectTools({ tool: (n, _d, _s, h) => { map[n] = h; } }, z, "gt-test");
  map.getTile = (args) => map.tiles({ op: "pixels", ...args });
  return map;
}
const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

// Fake Genesis host: video_ram holds one 4bpp tile (32 bytes) whose row 0
// logical bytes are [0x13,0x33,0x33,0x30] but stored host-LE word-swapped as
// [0x33,0x13,0x30,0x33] — exactly the scramble the real core exhibits.
function makeGenesisHost() {
  const vram = new Uint8Array(64);
  // logical row0 = 13 33 33 30 → swapped per 16-bit word = 33 13 30 33
  vram.set([0x33, 0x13, 0x30, 0x33], 0);
  return {
    status: { platform: "genesis" },
    readMemory(_region, offset, length) { return vram.slice(offset, offset + length); },
  };
}

test("getTile logicalPixels:true un-swaps Genesis VRAM words", async () => {
  _setHostForTest("gt-test", makeGenesisHost());
  const h = tileHandlers();
  const r = parse(await h.getTile({ tileIndex: 0, logicalPixels: true }));
  assert.equal(r.byteSwapCorrected, true);
  // Logical bytes 13 33 33 30 → 4bpp packed pixels: 1,3,3,3,3,3,3,0
  assert.deepEqual(r.pixels.slice(0, 8), [1, 3, 3, 3, 3, 3, 3, 0]);
});

test("getTile logicalPixels:false shows raw (swapped) host bytes", async () => {
  _setHostForTest("gt-test", makeGenesisHost());
  const h = tileHandlers();
  const r = parse(await h.getTile({ tileIndex: 0, logicalPixels: false }));
  assert.equal(r.byteSwapCorrected, false);
  // Raw bytes 33 13 30 33 → pixels 3,3,1,3,3,0,3,3 (the scramble Jay saw).
  assert.deepEqual(r.pixels.slice(0, 8), [3, 3, 1, 3, 3, 0, 3, 3]);
});

test("Genesis build emits an ld map; symbol address maps to system_ram offset", async () => {
  const src = "#include <genesis.h>\nvolatile unsigned short well[20][10];\n" +
    "int main(){ VDP_init(); while(1){ SYS_doVBlankProcess(); } return 0; }\n";
  const r = await buildForPlatform({ platform: "genesis", language: "c", source: src });
  assert.equal(r.ok, true, "genesis build should succeed:\n" + (r.log || "").slice(-300));
  assert.ok(r.symbols && r.symbols.length > 0, "build should return a linker map");

  const line = r.symbols.split("\n").find((l) => /0x[0-9a-f]+\s+well\s*$/.test(l.trim()));
  assert.ok(line, "map should contain the `well` symbol");
  const addr = parseInt(line.trim().split(/\s+/)[0], 16);
  assert.ok(addr >= 0xE0FF0000 && addr <= 0xE0FFFFFF, `well should be in mirrored work-RAM, got 0x${addr.toString(16)}`);

  // The low 16 bits are the system_ram offset — verify a write lands there.
  const offset = addr & 0xFFFF;
  const tmp = await mkdtemp(path.join(os.tmpdir(), "gen-tool-"));
  try {
    const rom = path.join(tmp, "t.bin");
    await writeFile(rom, finalizeGenesisRom(r.binary));
    const rc = resolveCore("genesis");
    const host = new LibretroHost();
    await host.loadCore(rc.jsPath, rc.wasmPath);
    await host.loadMedia({ platform: "genesis", path: rom });
    host.stepFrames(60);
    host.writeMemory("system_ram", offset, Uint8Array.from([0xBE, 0xEF]));
    const back = host.readMemory("system_ram", offset, 2);
    assert.deepEqual(Array.from(back), [0xBE, 0xEF], "write at map-derived offset should round-trip");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}, { timeout: 60000 });
