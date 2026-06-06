// Atari 7800 callSubroutine instruction WATCHDOG — end to end (prosystem 6502).
//
// callSubroutine can be pointed at a routine that loops FOREVER. Each emulator
// frame spins inside the Sally execute loop, so the host's per-frame cap can't
// catch it and the WASM would hang. The watchdog (romdev_watchdog_set, hooked
// into sally_ExecuteInstruction, force-stops via romdev_pc_hit + the per-frame
// budget drain in prosystem_ExecuteFrame) must force-stop at the host-set
// instruction budget and return {watchdog:true, finalPC:<spin>} — NOT hang.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "a78-wd", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "a78-wd-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}
const toJSON = (res) => { assert.equal(res.isError, undefined, "isError: " + JSON.stringify(res)); return JSON.parse(res.content[0].text); };

// main() stores the address of spin() (a forever-loop = `jmp *` to self once
// optimized) into a known RAM pointer at $1800, then idles. We read $1800 to
// learn spin's entry PC self-referentially (no symbol map needed), then drive
// callSubroutine at it. The routine never RTSes → only the watchdog can stop it.
const PTR = 0x1800;
const SRC = `
#include <stdint.h>
#define MSTAT (*(volatile uint8_t*)0x28)
void spin(void) { for (;;) { } }
void main(void) {
  uint16_t a = (uint16_t)(void*)&spin;
  *(volatile uint8_t*)0x1800 = (uint8_t)(a & 0xFF);
  *(volatile uint8_t*)0x1801 = (uint8_t)(a >> 8);
  for (;;) { while (MSTAT & 0x80) {} while (!(MSTAT & 0x80)) {} }
}`;

test("Atari 7800 callSubroutine watchdog force-stops an infinite loop (prosystem 6502)", { timeout: 150000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "buildSource", arguments: { platform: "atari7800", language: "c", source: SRC },
  }, undefined, { timeout: 150000 }));
  assert.equal(build.ok, true, "atari7800 build failed:\n" + build.log);

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "atari7800", path: build.binaryPath },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));

  // Boot so main() runs and stores &spin at $1800.
  toJSON(await client.callTool({ name: "frame", arguments: { op: "step",  frames: 60 } }));

  const mem = toJSON(await client.callTool({
    name: "memory", arguments: { op: "read", region: "system_ram", offset: PTR, length: 2 },
  }));
  const bytes = mem.hex ? mem.hex.match(/../g).map((h) => parseInt(h, 16)) : null;
  assert.ok(bytes && bytes.length >= 2, "readMemory $1800 returned no bytes: " + JSON.stringify(mem));
  const spinPC = (bytes[0] | (bytes[1] << 8)) >>> 0;
  assert.ok(spinPC > 0x4000, "spin entry PC looks wrong: $" + spinPC.toString(16));

  // Drive the infinite-loop routine. With a modest instruction budget the
  // watchdog MUST trip and return — no hang.
  const r = toJSON(await client.callTool({
    name: "callSubroutine",
    arguments: { pc: spinPC, maxInstructions: 200000, maxFrames: 600, sandbox: true },
  }, undefined, { timeout: 60000 }));

  assert.equal(r.returned, false, "infinite loop should NOT report returned:true: " + JSON.stringify(r));
  assert.equal(r.watchdog, true, "watchdog did not trip on the infinite loop: " + JSON.stringify(r));
  assert.ok(r.finalPC, "no finalPC reported: " + JSON.stringify(r));
  console.log("a7800 watchdog result:", JSON.stringify(r));
});
