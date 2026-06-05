// Atari 7800 PC breakpoint / read watchpoint / single-step — end to end.
//
// Exercises the prosystem core patch (6502 / Sally execute hook + memory_Read
// read-watch + the per-frame budget drain in prosystem_ExecuteFrame) through the
// MCP tool surface: runUntilPC freezes the CPU at an exact instruction,
// runUntilRead catches a reader of an address, stepInstruction single-steps and
// must ADVANCE the PC. The breakpoint PC is discovered self-referentially via
// findWriter (no symbol-map dependency), so the test is deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "a78-pc-break", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "a78-pc-break-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}

const toJSON = (res) => {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
};

// Minimal 7800 program: increment a counter in 7800 internal RAM ($1800) every
// frame AND read it back (so both the write watch and the read watch have a
// deterministic target). The writing/reading instruction PCs are stable
// breakpoint targets we discover via findWriter.
const COUNTER = 0x1800;
const SRC = `
#include <stdint.h>
#define MSTAT   (*(volatile uint8_t*)0x28)
#define COUNTER (*(volatile uint8_t*)0x1800)
static void vblank_wait(void) {
  while (MSTAT & 0x80) { }
  while (!(MSTAT & 0x80)) { }
}
void main(void) {
  uint8_t acc = 0;
  COUNTER = 0;
  for (;;) {
    vblank_wait();
    acc = COUNTER;        /* a READ of $1800 each frame  */
    acc++;
    COUNTER = acc;        /* a WRITE to $1800 each frame */
  }
}`;

test("Atari 7800 PC breakpoint + read watch + single-step (prosystem 6502)", { timeout: 150000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "buildSource",
    arguments: { platform: "atari7800", language: "c", source: SRC },
  }, undefined, { timeout: 150000 }));
  assert.equal(build.ok, true, "atari7800 build failed:\n" + build.log);

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "atari7800", path: build.binaryPath },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));

  // Boot past reset into the main loop.
  toJSON(await client.callTool({ name: "stepFrames", arguments: { frames: 60 } }));

  // 1) findWriter on the counter → the EXACT instruction PC that writes it.
  const fw = toJSON(await client.callTool({
    name: "findWriter", arguments: { address: COUNTER, maxFrames: 300 },
  }));
  assert.equal(fw.found, true, "findWriter didn't catch the $1800 write: " + JSON.stringify(fw));
  assert.ok(fw.pcRaw > 0, "findWriter returned no pc");
  const writerPC = fw.pcRaw;

  // 2) runUntilPC on that PC → must freeze the CPU exactly there.
  const bp = toJSON(await client.callTool({
    name: "runUntilPC", arguments: { address: writerPC, maxFrames: 300 },
  }));
  assert.equal(bp.notSupported, undefined, "PC breakpoint reported notSupported — core patch missing?");
  assert.equal(bp.hit, true, "runUntilPC did not hit the writer PC: " + JSON.stringify(bp));
  assert.equal(bp.pcRaw, writerPC, "frozen PC != requested PC");

  // 3) With the CPU frozen, getCPUState reads the live regs (PC must match bp).
  const regs = toJSON(await client.callTool({
    name: "getCPUState", arguments: { platform: "atari7800" },
  }));
  const pcField = regs.pc ?? regs.PC ?? regs.regs?.pc;
  assert.ok(pcField !== undefined, "getCPUState returned no PC field: " + JSON.stringify(regs).slice(0, 200));

  // 4) Single-step must ADVANCE the PC past the breakpoint — not re-stop on the
  //    same (un-executed) instruction (the countdown-arm fix).
  const stepRes = toJSON(await client.callTool({ name: "stepInstruction", arguments: {} }));
  assert.equal(stepRes.notSupported, undefined, "stepInstruction reported notSupported");
  assert.equal(stepRes.stepped, true, "single-step failed: " + JSON.stringify(stepRes));
  assert.ok(stepRes.pcRaw >= 0, "single-step returned no pc");
  assert.notEqual(stepRes.pcRaw, writerPC, "single-step did not advance PC: " + JSON.stringify(stepRes));

  // 5) runUntilRead on the counter — the program reads $1800 each frame, so this
  //    is a positive hit. Confirms the read-watch hook in memory_Read fires.
  const rd = toJSON(await client.callTool({
    name: "runUntilRead", arguments: { address: COUNTER, maxFrames: 120 },
  }));
  assert.equal(rd.notSupported, undefined, "runUntilRead reported notSupported — read-watch patch missing?");
  assert.equal(rd.hit, true, "runUntilRead did not catch the $1800 read: " + JSON.stringify(rd));
  assert.ok(rd.pcRaw > 0, "runUntilRead returned no reader pc");
});
