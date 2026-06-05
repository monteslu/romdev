// C64 (vice x64 / 6510) execution breakpoint + read watch + single-step — e2e.
// Mirrors test/nes-pc-break.test.js for the 6510 core. The breakpoint PC is
// discovered self-referentially via findWriter; the program does a read-modify-
// write of a fixed RAM scratch address ($C000, the free 4K block unused by
// BASIC/KERNAL) every loop, so both the write- and read-watchpoints have a
// stable target. NOTE: a C64 .prg only starts after BASIC auto-RUNs it, so we
// step ~150 frames before findWriter.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "c64-pc-break", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c64-pc-break-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}

const toJSON = (res) => {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
};

const SCRATCH = 0xC000;

// A deterministic per-loop read-modify-write of $C000. The writing instruction
// PC is a stable bp target we discover via findWriter; the read in the RMW
// gives runUntilRead a guaranteed hit.
const SRC = `
#define SCRATCH (*(volatile unsigned char*)0xC000)
void main(void) {
  unsigned char c = 0;
  while (1) {
    c = SCRATCH;     // READ of $C000 each loop
    c++;
    SCRATCH = c;     // WRITE of $C000 each loop
  }
}`;

test("C64 PC breakpoint + read watch + single-step (vice 6510)", { timeout: 240000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "buildSource", arguments: { platform: "c64", language: "c", source: SRC },
  }, undefined, { timeout: 180000 }));
  assert.equal(build.ok, true, "c64 build failed:\n" + (build.log || JSON.stringify(build)).slice(-600));

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "c64", path: build.binaryPath },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));

  // C64 BASIC auto-RUN takes many frames before our program reaches its loop.
  toJSON(await client.callTool({ name: "frame", arguments: { op: "step",  frames: 150 } }));

  // 1) findWriter on the scratch byte → the EXACT 6510 instruction PC writing it.
  const fw = toJSON(await client.callTool({
    name: "findWriter", arguments: { address: SCRATCH, maxFrames: 400 },
  }));
  assert.equal(fw.found, true, "findWriter didn't catch the $C000 write: " + JSON.stringify(fw));
  const writerPC = fw.pcRaw;
  assert.ok(writerPC > 0, "findWriter returned no pc");

  // 2) runUntilPC → freeze the CPU at that exact instruction.
  const bp = toJSON(await client.callTool({
    name: "runUntilPC", arguments: { address: writerPC, maxFrames: 400 },
  }));
  assert.equal(bp.notSupported, undefined, "PC breakpoint notSupported — core patch missing?");
  assert.equal(bp.hit, true, "runUntilPC did not hit: " + JSON.stringify(bp));
  assert.equal(bp.pcRaw, writerPC, "frozen PC != requested PC");

  // 3) getCPUState reads the live 6510 registers at the frozen instruction.
  const regs = toJSON(await client.callTool({
    name: "getCPUState", arguments: { platform: "c64" },
  }));
  const pcField = regs.pc ?? regs.PC ?? regs.registers?.PC;
  assert.ok(pcField !== undefined, "getCPUState returned no PC: " + JSON.stringify(regs).slice(0, 200));

  // 4) stepInstruction must ADVANCE the PC (not re-stop on the same instruction).
  const stepRes = toJSON(await client.callTool({ name: "stepInstruction", arguments: {} }));
  assert.equal(stepRes.notSupported, undefined, "stepInstruction notSupported");
  assert.equal(stepRes.stepped, true, "single-step failed: " + JSON.stringify(stepRes));
  assert.notEqual(stepRes.pcRaw, writerPC, "single-step did not advance PC: " + JSON.stringify(stepRes));

  // 5) runUntilRead — the scratch byte is read every loop (RMW), so the read
  //    watch must fire and report a reader PC.
  const rd = toJSON(await client.callTool({
    name: "runUntilRead", arguments: { address: SCRATCH, maxFrames: 200 },
  }));
  assert.equal(rd.notSupported, undefined, "runUntilRead notSupported — read-watch patch missing?");
  assert.equal(rd.hit, true, "runUntilRead did not catch the $C000 read: " + JSON.stringify(rd));
});
