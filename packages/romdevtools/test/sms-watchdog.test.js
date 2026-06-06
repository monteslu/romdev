// SMS/GG (Genesis Plus GX / Z80) callSubroutine instruction WATCHDOG.
//
// This is the v0.6.0 cross-system gap: the watchdog counter was wired ONLY into
// m68k_run, so on SMS/GG — where the Z80 is the active CPU — a wrong-entry
// free-run reported watchdog:false and fell to the per-frame cap, exactly the
// hang/ambiguity the watchdog exists to kill, just relocated to the Z80
// platforms. The gpgx patch now mirrors the counter into z80_run.
//
// We drive cpu({op:'call'}) into the SMS main loop (which never RTSes back to the
// sentinel) and confirm the run terminates via the watchdog — with the DEFAULT
// budget (the property that was broken) AND an explicit small budget.
//
// Run timeout-guarded (a watchdog bug could hang): `timeout 240 node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { tmpdir } from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "sms-wd", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "sms-wd-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}
const toJSON = (res) => { assert.equal(res.isError, undefined, "isError: " + JSON.stringify(res)); return JSON.parse(res.content[0].text); };

// SMS main: a deterministic per-iteration write to $C000 gives findWriter a real
// PC inside an infinite Z80 loop — driving callSubroutine there never returns.
const MAIN = `
void main(void) {
    __asm
        xor a
loop$:
        ld   (#0xC000), a
        inc  a
        jr   loop$
    __endasm;
    for (;;) { }
}
`;
const RAM = 0xC000;

test("SMS watchdog: a non-returning Z80 routine trips the watchdog (gpgx z80_run)", { timeout: 240000 }, async () => {
  const client = await startClient();

  // .sms extension so gpgx dispatches the Z80 (a generic .bin would misdetect).
  const outputPath = path.join(tmpdir(), `romdev-sms-wd-${process.pid}.sms`);
  const build = toJSON(await client.callTool({
    name: "build", arguments: { output: "rom", platform: "sms", language: "c", source: MAIN, outputPath },
  }, undefined, { timeout: 240000 }));
  assert.equal(build.ok, true, "sms build failed:\n" + build.log);

  const load = toJSON(await client.callTool({ name: "loadMedia", arguments: { platform: "sms", path: outputPath } }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));
  toJSON(await client.callTool({ name: "frame", arguments: { op: "step", frames: 120 } }));

  // A live PC inside the loop, via the per-iteration write.
  const fw = toJSON(await client.callTool({ name: "breakpoint", arguments: { on: "write", address: RAM, maxFrames: 300 } }));
  assert.equal(fw.found, true, "findWriter didn't catch the RAM write: " + JSON.stringify(fw));
  const loopPC = fw.pcRaw;
  assert.ok(loopPC > 0, "no writer PC");

  // EXPLICIT small budget → must trip fast (proves the Z80 counter increments).
  const wd = toJSON(await client.callTool({
    name: "cpu", arguments: { op: "call", pc: loopPC, maxFrames: 60, maxInstructions: 200000, sandbox: true },
  }));
  assert.equal(wd.notSupported, undefined, "callSubroutine notSupported on sms");
  assert.equal(wd.returned, false, "infinite loop should not 'return': " + JSON.stringify(wd));
  assert.equal(wd.watchdog, true, "Z80 watchdog must trip (was inert before the z80_run wiring): " + JSON.stringify(wd));
  assert.ok(wd.finalPC, "watchdog must report finalPC: " + JSON.stringify(wd));

  // DEFAULT budget (no maxInstructions) → must STILL trip before maxFrames. On
  // the Z80 (~7k instr/frame) the per-CPU default (~0.8*600*7000 ≈ 3.36M) trips
  // around frame ~480, before the 600-frame cap.
  const wdDefault = toJSON(await client.callTool({
    name: "cpu", arguments: { op: "call", pc: loopPC, maxFrames: 600, sandbox: true },
  }));
  assert.equal(wdDefault.watchdog, true,
    "DEFAULT Z80 budget must trip the watchdog, not fall to maxFrames: " + JSON.stringify(wdDefault));
  assert.ok(wdDefault.framesRun < 600,
    "watchdog should trip before maxFrames=600 on the default budget: " + JSON.stringify(wdDefault));
});
