// Genesis/m68k symbol resolution — the v0.6.0 feedback HEADLINE: there was no
// name→address path on Genesis, so every gameplay-state check went through a
// full-res screenshot. symbols({op:'resolve'}) now parses the GNU ld map that
// build({output:'romWithDebug'}) produces, so a C global's name → address →
// memory({op:'read'}) is a 1-byte assertion.
//
// Proves: (1) the GNU ld map parser finds C globals incl. `static` file-local
// ones, (2) resolve returns the work-RAM ramOffset, (3) the full chain
// build->resolve->read reads the live value.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseGnuLdMap, isGnuLdMap } from "../src/toolchains/gnu-ld-map.js";
import { resolveSymbolCore, getMemoryMapCore, listSymbolsCore } from "../src/mcp/tools/symbols.js";
import { addressToSymbolCore } from "../src/mcp/tools/address-to-symbol.js";
import { buildForPlatform } from "../src/toolchains/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "romdev-core-host/index.js";

// A Genesis C program with a NON-static and a STATIC global, both in work RAM.
const SRC = `#include <genesis.h>
volatile unsigned short score;
volatile unsigned char health;
static volatile unsigned char levelIdx;
int main(){
  VDP_init();
  score = 0x1234; health = 7; levelIdx = 3;
  while(1){ SYS_doVBlankProcess(); }
  return 0;
}
`;

test("parseGnuLdMap pulls C globals (incl. static) with work-RAM ramOffset", async () => {
  const r = await buildForPlatform({ platform: "genesis", language: "c", source: SRC });
  assert.equal(r.ok, true, "genesis build failed:\n" + (r.log || "").slice(-400));
  const map = r.symbols || "";
  assert.ok(isGnuLdMap(map), "build did not produce a GNU ld map");

  const syms = parseGnuLdMap(map);
  const byName = (n) => syms.find((s) => s.name === n);
  for (const n of ["score", "health", "levelIdx", "main"]) {
    assert.ok(byName(n), `GNU map parser missed '${n}'`);
  }
  // static levelIdx must be present too (the agent's caveat).
  assert.ok(byName("levelIdx"), "static file-local global 'levelIdx' must resolve");
  // Work-RAM globals carry a low-16 ramOffset; `main` (in ROM) does not.
  assert.equal(typeof byName("score").ramOffset, "number", "score should have a work-RAM ramOffset");
  assert.equal(byName("main").ramOffset, null, "main is in ROM — no ramOffset");
});

test("symbols({op:'resolve'}) on a Genesis map returns address + ramOffset + read hint", async () => {
  const r = await buildForPlatform({ platform: "genesis", language: "c", source: SRC });
  assert.equal(r.ok, true);
  const map = r.symbols;

  const res = await resolveSymbolCore({ map, name: "score" });
  assert.equal(res.format, "gnu-ld-map");
  assert.equal((res.address >>> 16), 0xe0ff, "score should live in the $E0FF0000 work-RAM mirror");
  assert.equal(typeof res.ramOffset, "number");
  assert.match(res.readHint, /region:'system_ram', offset:0x/, "should hand back the system_ram read recipe");

  // list + map ops also work off the same GNU map now.
  const list = await listSymbolsCore({ map, max: 5000 });
  assert.equal(list.format, "gnu-ld-map");
  assert.ok(list.symbols.some((s) => s.name === "health"));

  const mm = await getMemoryMapCore({ map, platform: "genesis" });
  assert.equal(mm.format, "gnu-ld-map");
  assert.ok(mm.symbolsByRegion.work_ram_mirror?.some((s) => s.name === "score"),
    "score should be grouped under the genesis work_ram_mirror region");
});

test("END-TO-END: build -> resolve 'score' -> memory read returns the live value", async () => {
  const r = await buildForPlatform({ platform: "genesis", language: "c", source: SRC });
  assert.equal(r.ok, true);

  const res = await resolveSymbolCore({ map: r.symbols, name: "score" });
  const offset = res.ramOffset;
  assert.equal(typeof offset, "number");

  // Boot the ROM and run until main() writes score=0x1234.
  const core = resolveCore("genesis");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "genesis", bytes: r.binary });
  for (let i = 0; i < 60; i++) host.stepFrames(1);

  // gpgx work-RAM is host-LE word-byte-swapped, so the 16-bit 0x1234 reads as
  // bytes [0x34,0x12] at the offset (the same swap getTile/decode handle). We
  // assert the two bytes are present (either order) so the test is robust to it.
  const bytes = host.readMemory("system_ram", offset & ~1, 2);
  const present = (bytes[0] === 0x12 && bytes[1] === 0x34) || (bytes[0] === 0x34 && bytes[1] === 0x12);
  assert.ok(present, `score=0x1234 not found at system_ram[0x${offset.toString(16)}]: got ${Array.from(bytes).map((b)=>b.toString(16))}`);
});

test("symbols({op:'addr'}) maps a Genesis PC into main() via the GNU ld map (PC→function)", async () => {
  const r = await buildForPlatform({ platform: "genesis", language: "c", source: SRC });
  assert.equal(r.ok, true);
  // main()'s address from the map, then look up an address a few bytes inside it.
  const mainSym = (await resolveSymbolCore({ map: r.symbols, name: "main" }));
  const inside = mainSym.address + 4;
  const res = await addressToSymbolCore({ pc: inside, symbolsText: r.symbols });
  assert.equal(res.symbol, "main", "PC inside main() should resolve to 'main': " + JSON.stringify(res));
  assert.equal(res.offset, 4);
});
