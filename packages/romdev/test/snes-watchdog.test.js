// SNES (snes9x / 65816) callSubroutine instruction WATCHDOG — the fix for the
// "callSubroutine hung" black box. A routine that loops FOREVER spins inside one
// retro_run frame, so the host's per-frame cap can't catch it. The core's
// instruction watchdog force-stops at the budget and returns
// { returned:false, watchdog:true, finalPC } instead of hanging the WASM.
//
// NOTE: the host's callSubroutine sentinel-return is m68k-shaped (it pushes a
// 4-byte BE return + reads SP via reg-id 18); on the 65816 the RTS/RTL return
// width differs, so a NORMAL routine's clean sentinel-return isn't asserted here
// (documented host-layer limitation — see snes-re-primitives.test.js). What this
// test proves is the CORE watchdog: a routine that never returns trips it instead
// of hanging. We drive callSubroutine into the live main loop (which never RTSes
// back to the sentinel) and confirm the watchdog stops it.
//
// Run timeout-guarded (a watchdog bug could hang): `timeout 120 node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "snes-wd", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "snes-wd-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}
const toJSON = (res) => { assert.equal(res.isError, undefined, "isError: " + JSON.stringify(res)); return JSON.parse(res.content[0].text); };

// Writes an incrementing counter to low WRAM $0010 (mirrors $7E0010) each frame.
// The main while(1) loop never returns — driving callSubroutine into it must trip
// the watchdog (run the instruction budget without returning), not hang.
const SRC = `
#include <snes.h>
unsigned char counter = 0;
int main(void) {
    consoleInit();
    while (1) {
        counter++;
        *((volatile unsigned char*)0x0010) = counter;
        WaitForVBlank();
    }
    return 0;
}`;

test("SNES watchdog: a non-returning routine trips the watchdog, no hang (snes9x 65816)", { timeout: 240000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "build", arguments: { output: "rom",  platform: "snes", language: "c", source: SRC },
  }, undefined, { timeout: 240000 }));
  assert.equal(build.ok, true, "snes build failed:\n" + build.log);

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "snes", path: build.binaryPath },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));
  toJSON(await client.callTool({ name: "frame", arguments: { op: "step",  frames: 60 } }));

  // Discover a live PC inside the main loop via the per-frame write to $7E0010.
  const wr = toJSON(await client.callTool({
    name: "watch", arguments: { on: "range",  start: 0x7E0010, end: 0x7E0010, kind: "write", frames: 10, limit: 20 },
  }));
  assert.equal(wr.notSupported, undefined, "watchRange notSupported on snes9x");
  assert.ok(wr.distinctPCs?.length > 0, "watchRange found no writer PC: " + JSON.stringify(wr));
  const writerPC = parseInt(String(wr.distinctPCs[0]).replace(/^\$/, ""), 16);
  assert.ok(writerPC > 0, "no writer PC from watchRange");

  // The WATCHDOG: drive callSubroutine into the main loop. It never RTSes back to
  // the sentinel, so the run must terminate via the watchdog (returned:false,
  // watchdog:true) with a finalPC — never hang.
  const wd = toJSON(await client.callTool({
    name: "cpu",
    arguments: { op: "call",  pc: writerPC, maxFrames: 30, maxInstructions: 200000, sandbox: true },
  }));
  assert.equal(wd.notSupported, undefined, "callSubroutine notSupported (watchdog export missing?)");
  assert.equal(wd.returned, false, "non-returning routine should not 'return': " + JSON.stringify(wd));
  assert.equal(wd.watchdog, true, "watchdog must trip (no hang): " + JSON.stringify(wd));
  assert.ok(wd.finalPC, "watchdog must report finalPC (where it's stuck): " + JSON.stringify(wd));

  console.log("SNES watchdog OK:", JSON.stringify({ returned: wd.returned, watchdog: wd.watchdog, finalPC: wd.finalPC }));
});
