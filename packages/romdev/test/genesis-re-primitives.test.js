// Genesis RE primitives round 2 (gpgx/m68k) — end to end.
//   - setRegister / callSubroutine  (item 1: drive the ROM's own routine, capture output)
//   - watchRange                    (item 2a: log every read/write in a range)
//   - logPCRange                    (item 2b: coverage trace — distinct PCs in a window)
//   - watchDma                      (item 3: targeted VDP-DMA log — vramDest + ROM source)

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "gen-re", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gen-re-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}
const toJSON = (res) => { assert.equal(res.isError, undefined, "isError: " + JSON.stringify(res)); return JSON.parse(res.content[0].text); };

// A reg-args asm subroutine (reg_copy: A0=src, A1=dst, D0=wordCount-1) — the shape
// real decompressors use — plus a deterministic per-frame write to $FF2000.
const SRC = `
#include <genesis.h>
void reg_copy(void);
void spin_forever(void);
asm("   .globl reg_copy\\nreg_copy:\\n   move.w (%a0)+,(%a1)+\\n   dbra %d0,reg_copy\\n   rts\\n");
asm("   .globl spin_forever\\nspin_forever:\\n   bra spin_forever\\n   rts\\n");
const u16 srcblob[4] = {0xCAFE,0xBABE,0x1122,0x3344};
volatile u16 dst[4];
void* keep[2] = { (void*)reg_copy, (void*)spin_forever }; // reference so both link (don't CALL spin)
int main(bool h){
  VDP_drawText("re",14,12);
  reg_copy();                                  // referenced so it links
  u16 a=0;
  while(1){ a++; *((volatile u16*)0xFF2000)=a; SYS_doVBlankProcess(); }
  return 0;
}`;

// Pull a symbol's address out of the SGDK .map text.
function symAddr(mapText, name) {
  const m = mapText.match(new RegExp("0x([0-9a-fA-F]{6,8})\\s+" + name + "\\b"));
  return m ? parseInt(m[1], 16) : null;
}

test("Genesis RE primitives: callSubroutine + watchRange + logPCRange + watchDma", { timeout: 240000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "buildSourceWithDebug", arguments: { platform: "genesis", language: "c", source: SRC, inline: true },
  }, undefined, { timeout: 240000 }));
  assert.equal(build.ok, true, "build failed:\n" + build.log);
  const map = build.mapText || build.symbols || "";
  const regCopy = symAddr(map, "reg_copy");
  const srcblob = symAddr(map, "srcblob");
  assert.ok(regCopy && srcblob, "couldn't find reg_copy/srcblob in the map");

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "genesis", base64: build.binaryBase64 },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));

  // ── item 3 FIRST: watchDma must run while the SGDK boot tile/font uploads are
  //    still happening (DMAs fire at boot; once settled there are none). ──
  const dma = toJSON(await client.callTool({ name: "watchDma", arguments: { frames: 120 } }));
  assert.equal(dma.notSupported, undefined, "watchDma notSupported");
  assert.ok(dma.totalEvents > 0, "watchDma caught no DMAs: " + JSON.stringify(dma));
  assert.ok(dma.dmas[0].vramDest && dma.dmas[0].source, "watchDma entry missing vramDest/source");
  assert.ok(typeof dma.dmas[0].from === "string", "watchDma entry should report from:ROM/RAM");

  toJSON(await client.callTool({ name: "stepFrames", arguments: { frames: 60 } }));

  // dst lives in work RAM; SGDK placed it at the $E0FF00xx mirror → system_ram
  // offset = low 16 bits. The .bss line gives 0xE0FF00xx; use 0x48 (matches the
  // build's layout) — but to be robust, find it from the map's dst address.
  const dstAddr = symAddr(map, "dst") ?? 0xE0FF0048;
  const dstOff = dstAddr & 0xFFFF;                 // system_ram offset
  const dstCpu = 0xFF0000 | dstOff;                // 68k work-RAM CPU address

  // Run the NON-destructive discovery tools FIRST (item 1's sandbox:false call
  // hijacks the CPU and leaves it at the sentinel, stopping the live game).

  // ── item 2a: watchRange logs writes to $FF2000 with pc/addr/value ──
  const wr = toJSON(await client.callTool({
    name: "watchRange", arguments: { start: 0xFF2000, end: 0xFF2001, kind: "write", frames: 10, limit: 10 },
  }));
  assert.equal(wr.notSupported, undefined, "watchRange notSupported");
  assert.ok(wr.total > 0, "watchRange caught no writes: " + JSON.stringify(wr));
  assert.ok(wr.distinctPCs.length > 0, "watchRange returned no PCs");

  // ── item 2b: logPCRange returns distinct executed PCs ──
  const cov = toJSON(await client.callTool({
    name: "logPCRange", arguments: { start: 0x200, end: 0x2000, frames: 10 },
  }));
  assert.equal(cov.notSupported, undefined, "logPCRange notSupported");
  assert.ok(cov.distinct > 0, "logPCRange found no PCs: " + JSON.stringify(cov));

  // ── item 1: setRegister round-trips ──
  const sr = toJSON(await client.callTool({ name: "setRegister", arguments: { regId: 8, value: 0xDEADBEEF } }));
  assert.equal(sr.notSupported, undefined, "setRegister notSupported — romdev_setreg missing?");
  assert.equal((sr.valueRaw >>> 0), 0xDEADBEEF, "setRegister didn't take");

  // ── item 1: callSubroutine drives reg_copy and the copy lands (run LAST — it
  //    hijacks the CPU; sandbox:false leaves it at the sentinel) ──
  await client.callTool({ name: "writeMemory", arguments: { region: "system_ram", offset: dstOff, hex: "0000000000000000" } });
  const cs = toJSON(await client.callTool({
    name: "callSubroutine",
    arguments: { pc: regCopy, regs: { 8: srcblob, 9: dstCpu, 0: 3 }, maxFrames: 60, sandbox: false },
  }));
  assert.equal(cs.notSupported, undefined, "callSubroutine notSupported");
  assert.equal(cs.returned, true, "callSubroutine did not return: " + JSON.stringify(cs));
  assert.notEqual(cs.watchdog, true, "normal routine should NOT trip the watchdog: " + JSON.stringify(cs));
  const dstAfter = toJSON(await client.callTool({ name: "readMemory", arguments: { region: "system_ram", offset: dstOff, length: 8 } }));
  // gpgx work-RAM is host-LE word-byte-swapped, so CAFE BABE 1122 3344 reads as
  // fecabeba22114433. Assert the swapped form (proves the copy ran correctly).
  assert.equal(dstAfter.hex.toLowerCase(), "fecabeba22114433", "callSubroutine copy wrong: " + dstAfter.hex);

  // ── the WATCHDOG: an infinite-loop routine must NOT hang — it returns
  //    { returned:false, watchdog:true, finalPC } with the spin address. This is
  //    the fix for the agent's black-box hang (now: progress on timeout). ──
  const spin = symAddr(map, "spin_forever");
  assert.ok(spin, "couldn't find spin_forever in the map");
  const wd = toJSON(await client.callTool({
    name: "callSubroutine",
    arguments: { pc: spin, maxFrames: 30, maxInstructions: 200000, sandbox: false },
  }));
  assert.equal(wd.returned, false, "spin should not 'return': " + JSON.stringify(wd));
  assert.equal(wd.watchdog, true, "watchdog must trip on an infinite loop (no hang): " + JSON.stringify(wd));
  assert.ok(wd.finalPC, "watchdog must report finalPC (where it's stuck): " + JSON.stringify(wd));
  assert.ok(wd.finalRegs, "watchdog must report finalRegs: " + JSON.stringify(wd));
});
