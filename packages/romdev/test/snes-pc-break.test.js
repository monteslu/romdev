// SNES (snes9x / 65816) execution breakpoint + read watch + single-step — e2e.
// Mirrors test/genesis-pc-break.test.js for the 65816 core.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "snes-pc-break", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "snes-pc-break-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}

const toJSON = (res) => {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
};

// Write an incrementing counter to low WRAM $0010 (mirrors $7E0010) every frame.
// findWriter canonicalizes the low-8KB WRAM mirror, so a watch on $7E0010 catches
// the store. Use a byte store via an absolute pointer so cc816 can't elide it.
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

test("SNES PC breakpoint + read watch + single-step (snes9x 65816)", { timeout: 240000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "buildSource", arguments: { platform: "snes", language: "c", source: SRC },
  }, undefined, { timeout: 240000 }));
  assert.equal(build.ok, true, "snes build failed:\n" + build.log);

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "snes", path: build.binaryPath },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));

  toJSON(await client.callTool({ name: "frame", arguments: { op: "step",  frames: 60 } }));

  // 1) findWriter on $7E0010 → the exact 65816 instruction PC.
  const fw = toJSON(await client.callTool({
    name: "findWriter", arguments: { address: 0x7E0010, maxFrames: 300 },
  }));
  assert.equal(fw.found, true, "findWriter didn't catch the $7E2000 write: " + JSON.stringify(fw));
  const writerPC = fw.pcRaw;
  assert.ok(writerPC > 0, "findWriter returned no pc");

  // 2) runUntilPC → freeze the CPU at that instruction.
  const bp = toJSON(await client.callTool({
    name: "runUntilPC", arguments: { address: writerPC, maxFrames: 300 },
  }));
  assert.equal(bp.notSupported, undefined, "PC breakpoint notSupported — core patch missing?");
  assert.equal(bp.hit, true, "runUntilPC did not hit: " + JSON.stringify(bp));
  assert.equal(bp.pcRaw, writerPC, "frozen PC != requested PC");

  // 3) getCPUState reads the live 65816 registers at the frozen instruction.
  const regs = toJSON(await client.callTool({
    name: "cpu", arguments: { op: "read",  platform: "snes", cpu: "main" },
  }));
  assert.ok((regs.pc ?? regs.PC ?? regs.registers?.PC) !== undefined,
    "getCPUState returned no PC: " + JSON.stringify(regs).slice(0, 160));

  // 4) stepInstruction must ADVANCE the PC.
  const stepRes = toJSON(await client.callTool({ name: "stepInstruction", arguments: {} }));
  assert.equal(stepRes.notSupported, undefined, "stepInstruction notSupported");
  assert.equal(stepRes.stepped, true, "single-step failed: " + JSON.stringify(stepRes));
  assert.notEqual(stepRes.pcRaw, writerPC, "single-step did not advance PC: " + JSON.stringify(stepRes));

  // 5) runUntilRead wired + clean shape.
  const rd = toJSON(await client.callTool({
    name: "runUntilRead", arguments: { address: 0x7E0010, maxFrames: 60 },
  }));
  assert.equal(rd.notSupported, undefined, "runUntilRead notSupported — read-watch patch missing?");
  assert.ok(typeof rd.hit === "boolean", "runUntilRead returned no hit field: " + JSON.stringify(rd));
});
