// Atari 2600 PC breakpoint / read watchpoint / single-step — end to end.
//
// Exercises the stella2014 core patch (6502 / M6502::execute PC-break hook +
// M6502::peek read-watch; the hit sets StopExecutionBit so TIA::update's
// endFrame() runs and retro_run returns — no hang) through the MCP tool surface:
// runUntilPC freezes the CPU at an exact instruction, runUntilRead catches a
// reader of an address, stepInstruction single-steps and must ADVANCE the PC.
// The breakpoint PC is discovered self-referentially via findWriter (no
// symbol-map dependency), so the test is deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "a26-pc-break", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "a26-pc-break-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}

const toJSON = (res) => {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
};

// Minimal 2600 cart: increment a counter in RIOT RAM ($80) every frame AND read
// it back, so both the write watch and the read watch have a deterministic
// target. The writing/reading instruction PCs are stable breakpoint targets we
// discover via findWriter. (6507 asm via dasm — the 2600 has no C path.)
const COUNTER = 0x80;
const SRC = `
  processor 6502
  org $F000

VSYNC   = $00
VBLANK  = $01
WSYNC   = $02
COLUBK  = $09
COUNT   = $80      ; RIOT RAM counter

START:
  SEI
  CLD
  LDX #$FF
  TXS
  LDA #0
.clr:
  STA $00,X
  DEX
  BNE .clr
  STA COUNT
  LDA #$80
  STA COLUBK

MAIN:
  ; ── increment + read-back the counter (the watched accesses) ──
  LDA COUNT          ; a READ of $80 each frame
  CLC
  ADC #1
  STA COUNT          ; a WRITE to $80 each frame

  ; ── VSYNC (3 lines) ──
  LDA #2
  STA VSYNC
  STA WSYNC
  STA WSYNC
  STA WSYNC
  LDA #0
  STA VSYNC

  ; ── VBLANK (37 lines) ──
  LDA #2
  STA VBLANK
  LDX #37
.vb:
  STA WSYNC
  DEX
  BNE .vb
  LDA #0
  STA VBLANK

  ; ── Visible (192 lines) ──
  LDX #192
.draw:
  STA WSYNC
  DEX
  BNE .draw

  ; ── Overscan (30 lines) ──
  LDA #2
  STA VBLANK
  LDX #30
.os:
  STA WSYNC
  DEX
  BNE .os

  JMP MAIN

  org $FFFA
  .word START
  .word START
  .word START
`;

test("Atari 2600 PC breakpoint + read watch + single-step (stella2014 6502)", { timeout: 150000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "build",
    arguments: { output: "rom",  platform: "atari2600", source: SRC },
  }, undefined, { timeout: 150000 }));
  assert.equal(build.ok, true, "atari2600 build failed:\n" + build.log);

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "atari2600", path: build.binaryPath },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));

  // Boot past reset into the main loop.
  toJSON(await client.callTool({ name: "frame", arguments: { op: "step",  frames: 30 } }));

  // 1) findWriter on the counter → the EXACT instruction PC that writes it.
  const fw = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "write",  address: COUNTER, maxFrames: 120 },
  }));
  assert.equal(fw.found, true, "findWriter didn't catch the $80 write: " + JSON.stringify(fw));
  assert.ok(fw.pcRaw > 0, "findWriter returned no pc");
  const writerPC = fw.pcRaw;

  // 2) runUntilPC on that PC → must freeze the CPU exactly there.
  const bp = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "pc",  address: writerPC, maxFrames: 120 },
  }));
  assert.equal(bp.notSupported, undefined, "PC breakpoint reported notSupported — core patch missing?");
  assert.equal(bp.hit, true, "runUntilPC did not hit the writer PC: " + JSON.stringify(bp));
  assert.equal(bp.pcRaw, writerPC, "frozen PC != requested PC");

  // 3) With the CPU frozen, getCPUState reads the live regs.
  const regs = toJSON(await client.callTool({
    name: "cpu", arguments: { op: "read",  platform: "atari2600" },
  }));
  const pcField = regs.pc ?? regs.PC ?? regs.regs?.pc;
  assert.ok(pcField !== undefined, "getCPUState returned no PC field: " + JSON.stringify(regs).slice(0, 200));

  // 4) Single-step must ADVANCE the PC past the breakpoint (the countdown fix).
  const stepRes = toJSON(await client.callTool({ name: "stepInstruction", arguments: {} }));
  assert.equal(stepRes.notSupported, undefined, "stepInstruction reported notSupported");
  assert.equal(stepRes.stepped, true, "single-step failed: " + JSON.stringify(stepRes));
  assert.ok(stepRes.pcRaw >= 0, "single-step returned no pc");
  assert.notEqual(stepRes.pcRaw, writerPC, "single-step did not advance PC: " + JSON.stringify(stepRes));

  // 5) runUntilRead on the counter — the program reads $80 each frame: positive hit.
  const rd = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "read",  address: COUNTER, maxFrames: 60 },
  }));
  assert.equal(rd.notSupported, undefined, "runUntilRead reported notSupported — read-watch patch missing?");
  assert.equal(rd.hit, true, "runUntilRead did not catch the $80 read: " + JSON.stringify(rd));
  assert.ok(rd.pcRaw > 0, "runUntilRead returned no reader pc");
});
