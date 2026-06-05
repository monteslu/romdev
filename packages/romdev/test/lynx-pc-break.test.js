// Lynx (handy / 65C02) execution breakpoint + read watch + single-step — e2e.
// Mirrors test/nes-pc-break.test.js for the 65C02 core. The breakpoint PC is
// discovered self-referentially via findWriter; the program does a read-modify-
// write of a fixed RAM scratch address every loop (Lynx RAM is a flat 64KB
// space, no banking) so both the write- and read-watchpoints have a stable
// target. 0x8000 sits well inside the MAIN RAM region ($0200-$BE38) and above a
// tiny program's code/data.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "lynx-pc-break", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lynx-pc-break-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}

const toJSON = (res) => {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
};

const SCRATCH = 0x8000;

// A deterministic per-loop read-modify-write of a fixed RAM scratch byte. The
// writing instruction PC is a stable bp target we discover via findWriter; the
// read in the RMW gives runUntilRead a guaranteed hit.
const SRC = `
#define SCRATCH (*(volatile unsigned char*)0x8000)
void main(void) {
  unsigned char c = 0;
  while (1) {
    c = SCRATCH;     // READ of 0x8000 each loop
    c++;
    SCRATCH = c;     // WRITE of 0x8000 each loop
  }
}`;

test("Lynx PC breakpoint + read watch + single-step (handy 65C02)", { timeout: 180000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "buildSource", arguments: { platform: "lynx", language: "c", source: SRC },
  }, undefined, { timeout: 180000 }));
  assert.equal(build.ok, true, "lynx build failed:\n" + (build.log || JSON.stringify(build)).slice(-600));

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "lynx", path: build.binaryPath },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));

  // Boot into the main loop.
  toJSON(await client.callTool({ name: "stepFrames", arguments: { frames: 30 } }));

  // 1) findWriter on the scratch byte → the EXACT 65C02 instruction PC writing it.
  const fw = toJSON(await client.callTool({
    name: "findWriter", arguments: { address: SCRATCH, maxFrames: 300 },
  }));
  assert.equal(fw.found, true, "findWriter didn't catch the 0x8000 write: " + JSON.stringify(fw));
  const writerPC = fw.pcRaw;
  assert.ok(writerPC > 0, "findWriter returned no pc");

  // 2) runUntilPC → freeze the CPU at that exact instruction.
  const bp = toJSON(await client.callTool({
    name: "runUntilPC", arguments: { address: writerPC, maxFrames: 300 },
  }));
  assert.equal(bp.notSupported, undefined, "PC breakpoint notSupported — core patch missing?");
  assert.equal(bp.hit, true, "runUntilPC did not hit: " + JSON.stringify(bp));
  assert.equal(bp.pcRaw, writerPC, "frozen PC != requested PC");

  // 3) getCPUState reads the live 65C02 registers at the frozen instruction.
  const regs = toJSON(await client.callTool({
    name: "getCPUState", arguments: { platform: "lynx" },
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
    name: "runUntilRead", arguments: { address: SCRATCH, maxFrames: 120 },
  }));
  assert.equal(rd.notSupported, undefined, "runUntilRead notSupported — read-watch patch missing?");
  assert.equal(rd.hit, true, "runUntilRead did not catch the 0x8000 read: " + JSON.stringify(rd));
});
