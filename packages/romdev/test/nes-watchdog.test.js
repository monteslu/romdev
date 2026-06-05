// NES (fceumm / 6502) callSubroutine instruction WATCHDOG — the fix for the
// "callSubroutine hung" black box. A routine that loops FOREVER (e.g. a codec
// fed a wrong pointer) spins inside one retro_run frame, so the host's per-frame
// cap can't catch it. The core's instruction watchdog force-stops at the budget
// and returns { returned:false, watchdog:true, finalPC } instead of hanging.
//
// Run timeout-guarded (a watchdog bug could hang): `timeout 120 node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "nes-wd", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nes-wd-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}
const toJSON = (res) => { assert.equal(res.isError, undefined, "isError: " + JSON.stringify(res)); return JSON.parse(res.content[0].text); };

// main writes an incrementing counter each frame; spin_forever is a separate
// asm TU with a `jmp self` infinite loop (referenced by main so it links, but
// never reached at runtime — counter starts at 0, never 123).
const MAIN_C = [
  "void spin_forever(void);",
  "volatile unsigned char counter;",
  "void main(void){ if(counter==123){spin_forever();} while(1){ counter++; *(volatile unsigned char*)0x20 = counter; } }",
].join("\n");
const SPIN_S = [
  ".export _spin_forever",
  ".segment \"CODE\"",
  "_spin_forever:",
  "  jmp _spin_forever",
  "  rts",
].join("\n");

test("NES watchdog: infinite-loop routine returns {watchdog:true} (fceumm 6502)", { timeout: 180000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "buildSourceWithDebug",
    arguments: { platform: "nes", sources: { "main.c": MAIN_C, "spin.s": SPIN_S }, inline: true },
  }, undefined, { timeout: 180000 }));
  assert.equal(build.ok, true, "nes build failed:\n" + build.log);

  const spin = toJSON(await client.callTool({ name: "resolveSymbol", arguments: { dbg: build.dbg, name: "_spin_forever" } }));
  const spinAddr = spin.address;
  assert.ok(spinAddr, "couldn't resolve _spin_forever: " + JSON.stringify(spin));

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "nes", base64: build.binaryBase64 },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));
  toJSON(await client.callTool({ name: "stepFrames", arguments: { frames: 30 } }));

  // The WATCHDOG: drive the infinite-loop routine. It must NOT hang — it returns
  // { returned:false, watchdog:true, finalPC=spinAddr }.
  const wd = toJSON(await client.callTool({
    name: "callSubroutine",
    arguments: { pc: spinAddr, maxFrames: 30, maxInstructions: 200000, sandbox: false },
  }));
  assert.equal(wd.notSupported, undefined, "callSubroutine notSupported (watchdog export missing?)");
  assert.equal(wd.returned, false, "spin should not 'return': " + JSON.stringify(wd));
  assert.equal(wd.watchdog, true, "watchdog must trip on an infinite loop (no hang): " + JSON.stringify(wd));
  assert.ok(wd.finalPC, "watchdog must report finalPC (where it's stuck): " + JSON.stringify(wd));
  // finalPC should be the spin address (the jmp-self never moves the PC).
  // finalPC comes back as a "$XXXX" / "0xXXXX" hex string — strip the prefix.
  const finalPCnum = typeof wd.finalPC === "string"
    ? parseInt(String(wd.finalPC).replace(/^\$|^0x/i, ""), 16)
    : wd.finalPC;
  assert.equal(finalPCnum & 0xFFFF, spinAddr & 0xFFFF, "watchdog finalPC should be the spin addr: " + JSON.stringify(wd) + " spin=" + spinAddr.toString(16));

  // No-regression: a NORMAL routine (one that RTSes immediately) still returns.
  // _spin_forever's second instruction is an `rts` at spinAddr+3 — call THAT to
  // get a clean immediate return, proving the watchdog doesn't false-trip.
  const ret = toJSON(await client.callTool({
    name: "callSubroutine",
    arguments: { pc: (spinAddr + 3), maxFrames: 30, maxInstructions: 200000, sandbox: true },
  }));
  assert.equal(ret.returned, true, "rts routine should return: " + JSON.stringify(ret));
  assert.notEqual(ret.watchdog, true, "normal routine should NOT trip the watchdog: " + JSON.stringify(ret));

  console.log("NES watchdog OK:", JSON.stringify({ returned: wd.returned, watchdog: wd.watchdog, finalPC: wd.finalPC }));
});
