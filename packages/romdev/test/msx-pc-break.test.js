// MSX (blueMSX / Z80) PC breakpoint + read watchpoint + single-step — end to end.
//
// Exercises the romdev_pcbreak_* / romdev_readwatch_* / romdev_watchpoint_* core
// patch (blueMSX R800/Z80) through the MCP tool surface: findWriter discovers the
// exact instruction PC that writes a known RAM byte, runUntilPC freezes the CPU
// there, getCPUState reads the live regs, stepInstruction single-steps (must
// ADVANCE the PC), runUntilRead catches the reader. The breakpoint PC is
// discovered self-referentially via findWriter (no symbol-map dependency).

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "msx-pc-break", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "msx-pc-break-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}

const toJSON = (res) => {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
};

// MSX cartridge INIT (must not return). Each loop iteration writes an
// incrementing counter byte to a fixed page-3 RAM address (0xE000) and reads it
// back, so we have BOTH a deterministic write (for findWriter / runUntilPC) and
// a deterministic read (for runUntilRead). Single-byte `ld (nn),a` /
// `ld a,(nn)` avoid any work-RAM-mirror byte-swap ambiguity.
const MAIN = `
void main(void) {
    __asm
        xor a
loop$:
        ld   (#0xE000), a       ; WRITE the counter to RAM each iteration
        ld   b, a
        ld   a, (#0xE000)       ; READ it back each iteration
        inc  a
        ; small delay so the per-frame host stepping sees the loop running
        ld   c, #0
delay$:
        dec  c
        jr   nz, delay$
        jr   loop$
    __endasm;
    for (;;) { }
}
`;

const CRT0 = await (await import("node:fs/promises")).readFile(
  new URL("../src/platforms/msx/lib/c/msx_crt0.s", import.meta.url), "utf8",
);

const RAM = 0xE000;

test("MSX PC breakpoint + read watch + single-step (blueMSX Z80)", { timeout: 240000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "build",
    arguments: { output: "rom", 
      platform: "msx",
      language: "c",
      sources: { "main.c": MAIN, "msx_crt0.s": CRT0 },
      crt0: ".module empty\n",
    },
  }, undefined, { timeout: 240000 }));
  assert.equal(build.ok, true, "msx build failed:\n" + build.log);

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "msx", path: build.binaryPath },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));

  // C-BIOS shows its logo ~150 frames before it CALLs the cart INIT; step well
  // past that so the loop is live.
  toJSON(await client.callTool({ name: "frame", arguments: { op: "step",  frames: 260 } }));

  // 1) findWriter on RAM → the EXACT instruction PC that writes the counter.
  const fw = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "write",  address: RAM, maxFrames: 300 },
  }));
  assert.equal(fw.found, true, "findWriter didn't catch the RAM write: " + JSON.stringify(fw));
  assert.ok(fw.pcRaw > 0, "findWriter returned no pc");
  const writerPC = fw.pcRaw;

  // 2) runUntilPC on that PC → must freeze the CPU exactly there.
  const bp = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "pc",  address: writerPC, maxFrames: 300 },
  }));
  assert.equal(bp.notSupported, undefined, "PC breakpoint reported notSupported — core patch missing?");
  assert.equal(bp.hit, true, "runUntilPC did not hit the writer PC: " + JSON.stringify(bp));
  assert.equal(bp.pcRaw, writerPC, "frozen PC != requested PC");

  // 3) With the CPU frozen at that instruction, getCPUState reads the live regs.
  const regs = toJSON(await client.callTool({
    name: "cpu", arguments: { op: "read",  platform: "msx" },
  }));
  const pcField = regs.pc ?? regs.PC ?? regs.regs?.pc;
  assert.ok(pcField !== undefined, "getCPUState returned no PC field: " + JSON.stringify(regs).slice(0, 200));

  // 4) stepInstruction must ADVANCE the PC past the breakpoint — not re-stop on
  //    the same (un-executed) instruction. (The countdown-arm fix.)
  const stepRes = toJSON(await client.callTool({ name: "frame", arguments: { op: "stepInstruction" } }));
  assert.equal(stepRes.notSupported, undefined, "stepInstruction reported notSupported");
  assert.equal(stepRes.stepped, true, "single-step failed: " + JSON.stringify(stepRes));
  assert.ok(stepRes.pcRaw >= 0, "single-step returned no pc");
  assert.notEqual(stepRes.pcRaw, writerPC, "single-step did not advance PC: " + JSON.stringify(stepRes));

  // 5) runUntilRead on RAM — the program reads it back each iteration, so this
  //    is a positive-hit read test.
  const rd = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "read",  address: RAM, maxFrames: 300 },
  }));
  assert.equal(rd.notSupported, undefined, "runUntilRead reported notSupported — read-watch patch missing?");
  assert.equal(rd.hit, true, "runUntilRead did not catch the RAM read: " + JSON.stringify(rd));
});
