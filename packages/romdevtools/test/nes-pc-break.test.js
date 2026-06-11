// NES (fceumm / 6502) execution breakpoint + read watch + single-step — e2e.
// Mirrors test/genesis-pc-break.test.js for the 6502 core.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "nes-pc-break", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nes-pc-break-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

const toJSON = (res) => {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
};

// A deterministic per-frame write to zero-page $10 (system_ram offset 0x10):
// an incrementing counter. The writing instruction PC is a stable bp target.
const SRC = `
volatile unsigned char counter;
void main(void) {
  while (1) {
    counter++;                 // a read-modify-write of $10 each loop
    *(volatile unsigned char*)0x10 = counter;
  }
}`;

test("NES PC breakpoint + read watch + single-step (fceumm 6502)", { timeout: 180000 }, async () => {
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

  // 1) findWriter on $10 → the EXACT 6502 instruction PC that writes the counter.
  const fw = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "write",  address: 0x10, maxFrames: 300 },
  }));
  assert.equal(fw.found, true, "findWriter didn't catch the $10 write: " + JSON.stringify(fw));
  const writerPC = fw.pcRaw;
  assert.ok(writerPC > 0, "findWriter returned no pc");

  // 2) runUntilPC → freeze the CPU at that exact instruction.
  const bp = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "pc",  address: writerPC, maxFrames: 300 },
  }));
  assert.equal(bp.notSupported, undefined, "PC breakpoint notSupported — core patch missing?");
  assert.equal(bp.hit, true, "runUntilPC did not hit: " + JSON.stringify(bp));
  assert.equal(bp.pcRaw, writerPC, "frozen PC != requested PC");

  // 2b) registersAtHit — the register file SNAPSHOT taken at the break instant.
  // fceumm drains the cycle budget on hit but retro_run still finishes the frame,
  // so a follow-up cpu({op:'read'}) returns end-of-frame regs, NOT the break
  // instant. The snapshot is the reliable break-instant register file — this is
  // the fix for the "break → read registers" RE workflow on NES.
  assert.ok(bp.registersAtHit, "breakpoint hit returned no registersAtHit snapshot (fceumm reg-snapshot patch missing?): " + JSON.stringify(bp));
  for (const r of ["A", "X", "Y", "P", "S"]) {
    assert.ok(Number.isInteger(bp.registersAtHit[r]) && bp.registersAtHit[r] >= 0 && bp.registersAtHit[r] <= 255,
      `registersAtHit.${r} out of range: ${bp.registersAtHit[r]}`);
  }

  // 2c) captureMemory — read named RAM AT the hit, inline, in the SAME call as
  // the register snapshot (collapses break→cpu→memory into one call). $10 is the
  // counter this ROM writes, so it must come back.
  const bp2 = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "pc", address: writerPC, maxFrames: 300,
      captureMemory: [{ region: "system_ram", offset: 0x10, length: 1, label: "counter" }] },
  }));
  assert.equal(bp2.hit, true, "2nd runUntilPC did not hit");
  assert.ok(bp2.registersAtHit, "2nd hit missing registersAtHit");
  assert.ok(bp2.capturedMemory && bp2.capturedMemory.counter, "captureMemory not returned inline: " + JSON.stringify(bp2));
  assert.match(bp2.capturedMemory.counter.hex, /^[0-9a-f]{2}$/, "captured $10 byte not a hex byte: " + JSON.stringify(bp2.capturedMemory));

  // 3) the LIVE register file (a follow-up cpu read) is end-of-frame state on
  // fceumm — it is NOT expected to match registersAtHit. We just confirm cpu read
  // still works and that the internal fields are now under coreInternal, not regs.
  const regs = toJSON(await client.callTool({
    name: "cpu", arguments: { op: "read",  platform: "nes" },
  }));
  assert.ok((regs.pc ?? regs.PC ?? regs.registers?.PC) !== undefined,
    "getCPUState returned no PC: " + JSON.stringify(regs).slice(0, 160));
  // item 3: fceumm-internal fields are labeled, not mixed into 6502 `registers`.
  assert.equal(regs.registers.DB, undefined, "DB should be under coreInternal, not registers");
  assert.ok(regs.coreInternal && regs.coreInternal.DB !== undefined, "coreInternal.DB missing");

  // 4) stepInstruction must ADVANCE the PC (not re-stop on the same instruction).
  const stepRes = toJSON(await client.callTool({ name: "frame", arguments: { op: "stepInstruction" } }));
  assert.equal(stepRes.notSupported, undefined, "stepInstruction notSupported");
  assert.equal(stepRes.stepped, true, "single-step failed: " + JSON.stringify(stepRes));
  assert.notEqual(stepRes.pcRaw, writerPC, "single-step did not advance PC: " + JSON.stringify(stepRes));

  // 5) runUntilRead is wired and returns a clean shape.
  const rd = toJSON(await client.callTool({
    name: "breakpoint", arguments: { on: "read",  address: 0x10, maxFrames: 60 },
  }));
  assert.equal(rd.notSupported, undefined, "runUntilRead notSupported — read-watch patch missing?");
  assert.ok(typeof rd.hit === "boolean", "runUntilRead returned no hit field: " + JSON.stringify(rd));
});
