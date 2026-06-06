// SMS (Genesis Plus GX / Z80) PC breakpoint + read watchpoint + single-step —
// end to end.
//
// Exercises the romdev_pcbreak_* / romdev_readwatch_* / romdev_watchpoint_* core
// patch through the gpgx Z80 path (SMS/GG run the Z80, not the m68k) via the same
// shared globals the Genesis m68k path uses. findWriter discovers the exact
// instruction PC that writes a known SMS work-RAM byte ($C000-$DFFF); runUntilPC
// freezes the CPU there, getCPUState reads the live regs, stepInstruction must
// ADVANCE the PC, runUntilRead catches the reader. A single-byte write is used so
// the gpgx work-RAM-mirror byte-swap can't confuse the watched address.

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
  const server = new McpServer({ name: "sms-pc-break", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "sms-pc-break-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

const toJSON = (res) => {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
};

// SMS main: each loop iteration writes an incrementing counter byte to a fixed
// work-RAM address ($C000) and reads it back, giving BOTH a deterministic write
// (for findWriter / runUntilPC) and a deterministic read (for runUntilRead).
// Single-byte `ld (nn),a` / `ld a,(nn)`. The SMS crt0 is auto-injected.
const MAIN = `
void main(void) {
    __asm
        xor a
loop$:
        ld   (#0xC000), a       ; WRITE the counter to SMS work RAM each iteration
        ld   b, a
        ld   a, (#0xC000)       ; READ it back each iteration
        inc  a
        ld   c, #0
delay$:
        dec  c
        jr   nz, delay$
        jr   loop$
    __endasm;
    for (;;) { }
}
`;

const RAM = 0xC000;

test("SMS PC breakpoint + read watch + single-step (gpgx Z80)", { timeout: 240000 }, async () => {
  const client = await startClient();

  // Write the ROM to a .sms-extensioned path: gpgx dispatches SMS vs GG vs
  // Genesis off the file extension, so a generic .bin would be misdetected and
  // the Z80 would never run.
  const outputPath = path.join(tmpdir(), `romdev-sms-pcbreak-${process.pid}.sms`);
  const build = toJSON(await client.callTool({
    name: "build",
    arguments: { output: "rom",  platform: "sms", language: "c", source: MAIN, outputPath },
  }, undefined, { timeout: 240000 }));
  assert.equal(build.ok, true, "sms build failed:\n" + build.log);

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "sms", path: outputPath },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));

  // Boot into the main loop.
  toJSON(await client.callTool({ name: "frame", arguments: { op: "step",  frames: 120 } }));

  // 1) findWriter on RAM → the EXACT Z80 instruction PC that writes the counter.
  //    (Confirms the Z80 write watch works AND gives a real bp target.)
  const fw = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "write",  address: RAM, maxFrames: 300 },
  }));
  assert.equal(fw.found, true, "findWriter didn't catch the RAM write: " + JSON.stringify(fw));
  assert.ok(fw.pcRaw > 0, "findWriter returned no pc");
  const writerPC = fw.pcRaw;

  // 2) runUntilPC on that PC → must freeze the Z80 exactly there.
  const bp = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "pc",  address: writerPC, maxFrames: 300 },
  }));
  assert.equal(bp.notSupported, undefined, "PC breakpoint reported notSupported — core patch missing?");
  assert.equal(bp.hit, true, "runUntilPC did not hit the writer PC: " + JSON.stringify(bp));
  assert.equal(bp.pcRaw, writerPC, "frozen PC != requested PC");

  // 3) With the CPU frozen, getCPUState reads the live Z80 regs.
  const regs = toJSON(await client.callTool({
    name: "cpu", arguments: { op: "read",  platform: "sms" },
  }));
  const pcField = regs.pc ?? regs.PC ?? regs.regs?.pc;
  assert.ok(pcField !== undefined, "getCPUState returned no PC field: " + JSON.stringify(regs).slice(0, 200));

  // 4) stepInstruction must ADVANCE the PC past the breakpoint. (Countdown fix.)
  const stepRes = toJSON(await client.callTool({ name: "frame", arguments: { op: "stepInstruction" } }));
  assert.equal(stepRes.notSupported, undefined, "stepInstruction reported notSupported");
  assert.equal(stepRes.stepped, true, "single-step failed: " + JSON.stringify(stepRes));
  assert.ok(stepRes.pcRaw >= 0, "single-step returned no pc");
  assert.notEqual(stepRes.pcRaw, writerPC, "single-step did not advance PC: " + JSON.stringify(stepRes));

  // 5) runUntilRead on RAM — the program reads it back each iteration.
  const rd = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "read",  address: RAM, maxFrames: 300 },
  }));
  assert.equal(rd.notSupported, undefined, "runUntilRead reported notSupported — read-watch patch missing?");
  assert.equal(rd.hit, true, "runUntilRead did not catch the RAM read: " + JSON.stringify(rd));
});
