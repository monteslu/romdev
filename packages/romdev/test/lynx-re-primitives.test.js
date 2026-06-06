// lynx RE primitives round 2 (65C02): setRegister + watchRange + logPCRange.
// Verifies the round-2 core exports + the discovery tools on this platform.

import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "lynx-re", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lynx-re-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}
const toJSON = (res) => { assert.equal(res.isError, undefined, "isError: " + JSON.stringify(res)); return JSON.parse(res.content[0].text); };

const SRC = "#include <stdint.h>\nvolatile uint8_t c;\nint main(void){ for(;;){ c++; *(volatile uint8_t*)0x0090=c; } return 0; }";

test("lynx RE primitives: setRegister + watchRange + logPCRange (65C02)", { timeout: 200000 }, async () => {
  const client = await startClient();
  const build = toJSON(await client.callTool({ name: "build", arguments: { output: "rom",  platform: "lynx", source: SRC } }, undefined, { timeout: 200000 }));
  assert.equal(build.ok, true, "lynx build failed:\n" + build.log);
  const load = toJSON(await client.callTool({ name: "loadMedia", arguments: { platform: "lynx", path: build.binaryPath } }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));
  toJSON(await client.callTool({ name: "frame", arguments: { op: "step",  frames: 30 } }));

  const sr = toJSON(await client.callTool({ name: "cpu", arguments: { op: "setReg",  regId: 0, value: 0x42 } }));
  assert.equal(sr.notSupported, undefined, "setRegister notSupported on lynx");
  assert.equal((sr.valueRaw & 0xFF), 0x42, "setRegister (A) didn't round-trip: " + JSON.stringify(sr));

  const wr = toJSON(await client.callTool({ name: "watch", arguments: { on: "range",  start: 144, end: 144, kind: "write", frames: 10, limit: 10 } }));
  assert.equal(wr.notSupported, undefined, "watchRange notSupported on lynx");
  assert.ok(wr.total > 0, "watchRange caught no writes: " + JSON.stringify(wr));
  assert.ok(wr.distinctPCs.length > 0, "watchRange returned no PCs");

  const cov = toJSON(await client.callTool({ name: "watch", arguments: { on: "pc",  start: 512, end: 16383, frames: 10 } }));
  assert.equal(cov.notSupported, undefined, "logPCRange notSupported on lynx");
  assert.ok(cov.distinct > 0, "logPCRange found no PCs: " + JSON.stringify(cov));
});
