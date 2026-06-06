// NES (fceumm / 6502) execution breakpoint + read watch + single-step — e2e.
// Mirrors test/genesis-pc-break.test.js for the 6502 core.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "nes-pc-break", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nes-pc-break-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}

const toJSON = (res) => {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
};

// A deterministic per-frame write to zero-page $10 (system_ram offset 0x10):
// an incrementing counter. The writing instruction PC is a stable bp target.
const SRC = `
volatile unsigned char counter;
void main(void) {
  while (1) {
    counter++;                 // a read-modify-write of $10 each loop
    *(volatile unsigned char*)0x10 = counter;
  }
}`;

test("NES PC breakpoint + read watch + single-step (fceumm 6502)", { timeout: 180000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "build", arguments: { output: "rom",  platform: "nes", source: SRC },
  }, undefined, { timeout: 180000 }));
  assert.equal(build.ok, true, "nes build failed:\n" + build.log);

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "nes", path: build.binaryPath },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));

  toJSON(await client.callTool({ name: "frame", arguments: { op: "step",  frames: 30 } }));

  // 1) findWriter on $10 → the EXACT 6502 instruction PC that writes the counter.
  const fw = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "write",  address: 0x10, maxFrames: 300 },
  }));
  assert.equal(fw.found, true, "findWriter didn't catch the $10 write: " + JSON.stringify(fw));
  const writerPC = fw.pcRaw;
  assert.ok(writerPC > 0, "findWriter returned no pc");

  // 2) runUntilPC → freeze the CPU at that exact instruction.
  const bp = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "pc",  address: writerPC, maxFrames: 300 },
  }));
  assert.equal(bp.notSupported, undefined, "PC breakpoint notSupported — core patch missing?");
  assert.equal(bp.hit, true, "runUntilPC did not hit: " + JSON.stringify(bp));
  assert.equal(bp.pcRaw, writerPC, "frozen PC != requested PC");

  // 3) getCPUState reads the live 6502 registers at the frozen instruction.
  const regs = toJSON(await client.callTool({
    name: "cpu", arguments: { op: "read",  platform: "nes" },
  }));
  assert.ok((regs.pc ?? regs.PC ?? regs.registers?.PC) !== undefined,
    "getCPUState returned no PC: " + JSON.stringify(regs).slice(0, 160));

  // 4) stepInstruction must ADVANCE the PC (not re-stop on the same instruction).
  const stepRes = toJSON(await client.callTool({ name: "stepInstruction", arguments: {} }));
  assert.equal(stepRes.notSupported, undefined, "stepInstruction notSupported");
  assert.equal(stepRes.stepped, true, "single-step failed: " + JSON.stringify(stepRes));
  assert.notEqual(stepRes.pcRaw, writerPC, "single-step did not advance PC: " + JSON.stringify(stepRes));

  // 5) runUntilRead is wired and returns a clean shape.
  const rd = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "read",  address: 0x10, maxFrames: 60 },
  }));
  assert.equal(rd.notSupported, undefined, "runUntilRead notSupported — read-watch patch missing?");
  assert.ok(typeof rd.hit === "boolean", "runUntilRead returned no hit field: " + JSON.stringify(rd));
});
