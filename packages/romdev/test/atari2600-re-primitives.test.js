// atari2600 RE primitives round 2 (6502): setRegister + watchRange + logPCRange.
// Verifies the round-2 core exports + the discovery tools on this platform.

import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "atari2600-re", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "atari2600-re-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}
const toJSON = (res) => { assert.equal(res.isError, undefined, "isError: " + JSON.stringify(res)); return JSON.parse(res.content[0].text); };

const SRC = "  processor 6502\n  org $F000\nStart:\n  ldx #$00\nLoop:\n  inx\n  stx $80\n  jmp Loop\n  org $FFFC\n  .word Start\n  .word Start";

test("atari2600 RE primitives: setRegister + watchRange + logPCRange (6502)", { timeout: 200000 }, async () => {
  const client = await startClient();
  const build = toJSON(await client.callTool({ name: "buildSource", arguments: { platform: "atari2600", language: "asm", source: SRC } }, undefined, { timeout: 200000 }));
  assert.equal(build.ok, true, "atari2600 build failed:\n" + build.log);
  const load = toJSON(await client.callTool({ name: "loadMedia", arguments: { platform: "atari2600", path: build.binaryPath } }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));
  toJSON(await client.callTool({ name: "frame", arguments: { op: "step",  frames: 10 } }));

  const sr = toJSON(await client.callTool({ name: "cpu", arguments: { op: "setReg",  regId: 0, value: 0x42 } }));
  assert.equal(sr.notSupported, undefined, "setRegister notSupported on atari2600");
  assert.equal((sr.valueRaw & 0xFF), 0x42, "setRegister (A) didn't round-trip: " + JSON.stringify(sr));

  const wr = toJSON(await client.callTool({ name: "watchRange", arguments: { start: 128, end: 128, kind: "write", frames: 10, limit: 10 } }));
  assert.equal(wr.notSupported, undefined, "watchRange notSupported on atari2600");
  assert.ok(wr.total > 0, "watchRange caught no writes: " + JSON.stringify(wr));
  assert.ok(wr.distinctPCs.length > 0, "watchRange returned no PCs");

  const cov = toJSON(await client.callTool({ name: "logPCRange", arguments: { start: 61440, end: 65535, frames: 10 } }));
  assert.equal(cov.notSupported, undefined, "logPCRange notSupported on atari2600");
  assert.ok(cov.distinct > 0, "logPCRange found no PCs: " + JSON.stringify(cov));
});
