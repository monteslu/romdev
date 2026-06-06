// GB (gambatte / SM83) execution breakpoint + read watch + single-step — e2e.
// Mirrors test/genesis-pc-break.test.js for the SM83 core.
import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "gb-pc-break", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gb-pc-break-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

const toJSON = (res) => {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
};

// Per-frame WRITE to work-RAM 0xC000 and a READ-back at 0xC002 so both the
// read-watch and write-watch have a deterministic target.
const SRC = `
volatile unsigned char g_w;     /* lives in WRAM */
volatile unsigned char g_r = 7; /* lives in WRAM, read each frame */
void main(void) {
    unsigned char acc = 0;
    *((volatile unsigned char*)0xC000) = 1;
    for (;;) {
        acc += *((volatile unsigned char*)0xC002);  /* READ of g_r each loop */
        *((volatile unsigned char*)0xC000) = acc;   /* WRITE each loop */
        g_w = acc;
    }
}`;

test("GB PC breakpoint + read watch + single-step (gambatte sm83)", { timeout: 240000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "build",
    arguments: { output: "rom",  platform: "gb", language: "c", source: SRC },
  }, undefined, { timeout: 240000 }));
  assert.equal(build.ok, true, "gb build failed:\n" + build.log);

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "gb", path: build.binaryPath },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));

  toJSON(await client.callTool({ name: "frame", arguments: { op: "step",  frames: 60 } }));

  // 1) findWriter on 0xC000 → exact writing instruction PC.
  const fw = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "write",  address: 0xC000, maxFrames: 300 },
  }));
  assert.equal(fw.found, true, "findWriter didn't catch the 0xC000 write: " + JSON.stringify(fw));
  const writerPC = fw.pcRaw;
  console.log("writerPC =", writerPC.toString(16));

  // 2) runUntilPC → freeze exactly there.
  const bp = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "pc",  address: writerPC, maxFrames: 300 },
  }));
  assert.equal(bp.notSupported, undefined, "PC breakpoint notSupported — patch missing?");
  assert.equal(bp.hit, true, "runUntilPC did not hit: " + JSON.stringify(bp));
  assert.equal(bp.pcRaw, writerPC, "frozen PC != requested PC: " + JSON.stringify(bp));
  console.log("frozen at", bp.pcRaw.toString(16));

  // 3) getCPUState reads live regs at the frozen PC.
  const regs = toJSON(await client.callTool({
    name: "cpu", arguments: { op: "read",  platform: "gb" },
  }));
  const pcField = regs.pc ?? regs.PC ?? regs.regs?.pc;
  assert.ok(pcField !== undefined, "getCPUState returned no PC: " + JSON.stringify(regs).slice(0, 200));
  const pcNum = typeof pcField === "string" ? parseInt(pcField, 16) : pcField;
  assert.equal(pcNum, writerPC, "getCPUState PC != frozen PC (pc-writeback gotcha!): " + JSON.stringify(regs).slice(0, 200));

  // 4) stepInstruction single-steps.
  const stepRes = toJSON(await client.callTool({ name: "frame", arguments: { op: "stepInstruction" } }));
  assert.equal(stepRes.notSupported, undefined, "stepInstruction notSupported");
  assert.equal(stepRes.stepped, true, "single-step failed: " + JSON.stringify(stepRes));
  assert.notEqual(stepRes.pcRaw, writerPC, "single-step did not advance PC: " + JSON.stringify(stepRes));
  console.log("after step PC =", stepRes.pcRaw.toString(16));

  // 5) runUntilRead on 0xC002 (g_r is read every loop) → must hit.
  const rd = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "read",  address: 0xC002, maxFrames: 120 },
  }));
  assert.equal(rd.notSupported, undefined, "runUntilRead notSupported — read-watch patch missing?");
  assert.equal(rd.hit, true, "runUntilRead did not catch the 0xC002 read: " + JSON.stringify(rd));
  console.log("read caught at PC", (rd.pcRaw ?? 0).toString(16));
});
