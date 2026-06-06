// NES RE primitives round 2 (fceumm/6502): setRegister + watchRange + logPCRange.
// The discovery half — verified on the 6502 core. (callSubroutine is wired via
// the host's per-CPU profile: 6502 page-stack $0100, 2-byte BE return, RTS+1;
// covered end-to-end by the Genesis reference — this asserts the 6502 exports.)

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "nes-re", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nes-re-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}
const toJSON = (res) => { assert.equal(res.isError, undefined, "isError: " + JSON.stringify(res)); return JSON.parse(res.content[0].text); };

// Writes an incrementing counter to zero-page $20 each frame.
const SRC = `
volatile unsigned char counter;
void main(void) { while (1) { counter++; *(volatile unsigned char*)0x20 = counter; } }`;

test("NES RE primitives: setRegister + watchRange + logPCRange (fceumm 6502)", { timeout: 180000 }, async () => {
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

  // setRegister round-trips (6502 reg-id 0 = A).
  const sr = toJSON(await client.callTool({ name: "cpu", arguments: { op: "setReg",  regId: 0, value: 0x42 } }));
  assert.equal(sr.notSupported, undefined, "setRegister notSupported — romdev_setreg missing on fceumm?");
  assert.equal((sr.valueRaw & 0xFF), 0x42, "setRegister (A) didn't round-trip: " + JSON.stringify(sr));

  // watchRange catches the per-frame write to $20 with pc/addr/value.
  const wr = toJSON(await client.callTool({
    name: "watch", arguments: { on: "range",  start: 0x20, end: 0x20, kind: "write", frames: 10, limit: 10 },
  }));
  assert.equal(wr.notSupported, undefined, "watchRange notSupported on fceumm");
  assert.ok(wr.total > 0, "watchRange caught no writes to $20: " + JSON.stringify(wr));
  assert.ok(wr.distinctPCs.length > 0, "watchRange returned no PCs");

  // logPCRange returns distinct executed PCs in the PRG area.
  const cov = toJSON(await client.callTool({
    name: "watch", arguments: { on: "pc",  start: 0x8000, end: 0xFFFF, frames: 10 },
  }));
  assert.equal(cov.notSupported, undefined, "logPCRange notSupported on fceumm");
  assert.ok(cov.distinct > 0, "logPCRange found no PCs: " + JSON.stringify(cov));
});
