// makeStoredBlock GBA LZ77 — LIVE round-trip through the REAL BIOS decompressor.
//
// The agent's whole ask for makeStoredBlock is "emit bytes the game's OWN
// decompressor expands verbatim." The reference-decompressor test (reinject.test.js)
// proves it against the documented algorithm; THIS test proves it against the
// actual GBA BIOS — we build a ROM that calls SWI 0x11 (LZ77UnCompWram) on bytes
// produced by makeStoredBlock, run it under mgba, and read back the decompressed
// output. If it matches the payload, the game's own decompressor accepts our
// stored block. This is the end-to-end proof.
//
// Run timeout-guarded: `timeout 180 node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGbaC } from "romdev-platform-gba";
import { resolveCore } from "../src/cores/registry.js";
import { storedGbaLz77 } from "../src/mcp/tools/reinject.js";

// The payload we want the BIOS to reproduce verbatim.
const PAYLOAD = [0xDE, 0xAD, 0xBE, 0xEF, 0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC];

test("makeStoredBlock GBA LZ77 decompresses verbatim under the real BIOS (mgba)", { timeout: 150000 }, async () => {
  // 1) Build the stored block with the tool, emit it as a C byte array.
  const block = storedGbaLz77(Uint8Array.from(PAYLOAD));
  const blockArr = Array.from(block.bytes).map((b) => "0x" + b.toString(16)).join(",");
  const OUT_ADDR = 0x02000000;   // EWRAM — where the BIOS writes the result
  const DONE_ADDR = 0x02000100;  // a "decompression finished" marker

  // The compressed stream MUST be 4-byte aligned (BIOS reads words); a static
  // const array in ROM is word-aligned. We call LZ77UnCompWram (SWI 0x11) which
  // writes 8 bits at a time to EWRAM.
  const SRC = `
#include <tonc.h>
const u8 g_block[] __attribute__((aligned(4))) = { ${blockArr} };
int main(void) {
    LZ77UnCompWram(g_block, (void*)0x02000000);   // SWI 0x11 → decompress to EWRAM
    *(volatile u32*)0x02000100 = 0xC0FFEE;        // signal done
    while (1) { }
    return 0;
}`;

  const r = await buildGbaC({ source: SRC });
  assert.equal(r.ok, true, `gba build failed at ${r.stage}: ${(r.log || "").slice(-600)}`);

  // 2) Boot under mgba.
  const { LibretroHost } = await import("../src/host/LibretroHost.js");
  const core = resolveCore("gba");
  assert.ok(core, "resolveCore('gba') returned null — mgba_libretro.{js,wasm} missing?");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "gba", bytes: r.binary, virtualName: "rt.gba" });

  // 3) Run until the done-marker is set (BIOS decompress finished), bounded.
  let done = false;
  for (let i = 0; i < 120 && !done; i++) {
    host.stepFrames(1);
    const m = host.readMemory("system_ram", DONE_ADDR - 0x02000000, 4);
    const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
    if (dv.getUint32(0, true) === 0xC0FFEE) done = true;
  }
  assert.equal(done, true, "ROM never signalled decompression-done (BIOS call may have faulted)");

  // 4) Read the decompressed bytes from EWRAM and compare to the payload.
  const out = host.readMemory("system_ram", OUT_ADDR - 0x02000000, PAYLOAD.length);
  assert.deepEqual(Array.from(out), PAYLOAD,
    "BIOS LZ77 did NOT reproduce the payload from makeStoredBlock output: got " +
    Array.from(out).map((b) => b.toString(16)).join(" "));

  console.log("GBA LZ77 live round-trip OK: BIOS reproduced", PAYLOAD.length, "bytes verbatim from makeStoredBlock");
});
