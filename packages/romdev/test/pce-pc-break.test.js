// PC Engine PC breakpoint / read watchpoint / single-step — end to end.
//
// Exercises the geargrafx core patch (HuC6280 = 65C02 superset: RunInstruction
// PC-break hook + Memory::Read read-watch; the per-frame loop in
// geargrafx_core_inline.h drains on the hit flag so retro_run returns — no hang)
// through the MCP tool surface: runUntilPC freezes the CPU at an exact
// instruction, runUntilRead catches a reader of an address, stepInstruction
// single-steps and must ADVANCE the PC. The breakpoint PC is discovered
// self-referentially via findWriter, so the test is deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "pce-pc-break", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pce-pc-break-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

const toJSON = (res) => {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
};

// Minimal PCE program: increment a counter in work RAM ($1F00, high end of the
// 8 KB work RAM, away from zero page / stack) every frame AND read it back, so
// both watches have a deterministic target. The writing/reading instruction PCs
// are stable breakpoint targets we discover via findWriter. (cc65 C, C89.)
const COUNTER = 0x1F00;
const SRC = `
#include <conio.h>
#include <pce.h>
static unsigned char keep_bss[4];   /* keep .bss non-empty (PCE crt0 footgun) */
void main(void) {
    volatile unsigned char* counter = (volatile unsigned char*)0x1F00;
    unsigned char acc = 0;
    keep_bss[0] = 0;
    clrscr();               /* init the HuC6270 VDC + VCE so waitvsync() returns */
    *counter = 0;
    for (;;) {
        waitvsync();
        acc = *counter;     /* a READ of $1F00 each frame  */
        acc++;
        *counter = acc;     /* a WRITE to $1F00 each frame */
    }
}`;

test("PC Engine PC breakpoint + read watch + single-step (geargrafx HuC6280)", { timeout: 150000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "build",
    arguments: { output: "rom",  platform: "pce", language: "c", source: SRC },
  }, undefined, { timeout: 150000 }));
  assert.equal(build.ok, true, "pce build failed:\n" + build.log);

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "pce", path: build.binaryPath },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));

  // Boot past crt0 into the main loop.
  toJSON(await client.callTool({ name: "frame", arguments: { op: "step",  frames: 60 } }));

  // 1) Discover a real instruction PC self-referentially. geargrafx has NO write
  //    watchpoint (so findWriter is unavailable here), but it DOES have the read
  //    watchpoint — runUntilRead on the counter the program reads each frame
  //    returns the EXACT reading-instruction PC, a stable breakpoint target.
  const rdSeed = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "read",  address: COUNTER, maxFrames: 300 },
  }));
  assert.equal(rdSeed.notSupported, undefined, "runUntilRead reported notSupported — read-watch patch missing?");
  assert.equal(rdSeed.hit, true, "runUntilRead didn't catch the $1F00 read: " + JSON.stringify(rdSeed));
  assert.ok(rdSeed.pcRaw > 0, "runUntilRead returned no reader pc");
  const seedPC = rdSeed.pcRaw;

  // 2) runUntilPC on that PC → must freeze the CPU exactly there.
  const bp = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "pc",  address: seedPC, maxFrames: 300 },
  }));
  assert.equal(bp.notSupported, undefined, "PC breakpoint reported notSupported — core patch missing?");
  assert.equal(bp.hit, true, "runUntilPC did not hit the seed PC: " + JSON.stringify(bp));
  assert.equal(bp.pcRaw, seedPC, "frozen PC != requested PC");
  const writerPC = seedPC;  // alias for the single-step advance assertion below

  // 3) With the CPU frozen, getCPUState reads the live regs.
  const regs = toJSON(await client.callTool({
    name: "cpu", arguments: { op: "read",  platform: "pce" },
  }));
  const pcField = regs.pc ?? regs.PC ?? regs.regs?.pc;
  assert.ok(pcField !== undefined, "getCPUState returned no PC field: " + JSON.stringify(regs).slice(0, 200));

  // 4) Single-step must ADVANCE the PC past the breakpoint (the countdown fix).
  const stepRes = toJSON(await client.callTool({ name: "frame", arguments: { op: "stepInstruction" } }));
  assert.equal(stepRes.notSupported, undefined, "stepInstruction reported notSupported");
  assert.equal(stepRes.stepped, true, "single-step failed: " + JSON.stringify(stepRes));
  assert.ok(stepRes.pcRaw >= 0, "single-step returned no pc");
  assert.notEqual(stepRes.pcRaw, writerPC, "single-step did not advance PC: " + JSON.stringify(stepRes));

  // 5) runUntilRead on the counter — the program reads $1F00 each frame: positive hit.
  const rd = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "read",  address: COUNTER, maxFrames: 120 },
  }));
  assert.equal(rd.notSupported, undefined, "runUntilRead reported notSupported — read-watch patch missing?");
  assert.equal(rd.hit, true, "runUntilRead did not catch the $1F00 read: " + JSON.stringify(rd));
  assert.ok(rd.pcRaw > 0, "runUntilRead returned no reader pc");
});
