// cpu({op:'call'}, sandbox:false) must leave the interrupted machine RESUMABLE.
//
// The reported failure: two calls at $D404 returned cleanly and left exactly the
// expected RAM side effects -- but the game never recovered. S was $F5 at the
// pc-break before the calls and $F3 after; on unpausing, the pause loop's exit
// `pla / pla / rts` popped garbage and the machine crashed into RAM (PC spinning
// at $0224, black screen, and the wild execution even cleared the flag under
// test).
//
// Mechanism, reproduced here on nestest/fceumm before fixing:
//
//   callSubroutine's SETUP permanently mutates the interrupted machine. It
//   pushes a sentinel return address onto the game's own stack, lowers SP by
//   that width (2 bytes on 6502 -- exactly the reported $F5 -> $F3), and
//   overwrites PC plus any caller-supplied regs.
//
//   When the callee reaches its rts, all of that unwinds and resuming is safe.
//   When the run is CUT SHORT -- stopAtPC, or a watchdog stop mid-routine --
//   nothing unwinds: the sentinel stays on the stack along with whatever the
//   callee had pushed, and SP is left far below where the interrupted code
//   expects it. A stopAtPC call measured here dropped S from $FD to $0A and it
//   STAYED there, because with sandbox:false there was no restore at all.
//
// So `returned:false` is exactly the unsafe case, and the reporter's reading was
// right: the lower S in finalRegs was accurate, not a capture-before-final-pop
// artifact.
//
// The fix restores the REGISTER FILE (not the whole state) when a call didn't
// return: the stack goes back, while the RAM the routine wrote -- the entire
// reason sandbox:false exists -- is deliberately left live.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

const ROM = new URL("./roms/nestest.nes", import.meta.url).pathname;

async function startClient(key) {
  const server = new McpServer({ name: key, version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z, key);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: key + "-c", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.find?.((c) => c.type === "text")?.text;
    if (r.isError) return { _error: text };
    try { return JSON.parse(text); } catch { return text; }
  };
}

async function bootedSession(key) {
  const call = await startClient(key);
  const load = await call("loadMedia", { platform: "nes", path: ROM });
  assert.equal(load.loaded, true, "ROM loaded");
  await call("frame", { op: "step", frames: 60 });
  return call;
}

const stackPointer = async (call) => (await call("cpu", { op: "read" }))?.registers?.S;

test("a call that RETURNS balances the stack on its own", async () => {
  const call = await bootedSession("cpu-call-balanced");
  const before = await stackPointer(call);
  const r = await call("cpu", { op: "call", pc: 0xC000, maxFrames: 2, sandbox: false });
  const after = await stackPointer(call);

  assert.equal(r.returned, true);
  assert.equal(after, before, "the callee's rts popped the sentinel");
  // Nothing to repair, so no repair is claimed.
  assert.equal(r.cpuContextRestored, undefined);
});

test("a call CUT SHORT restores the stack instead of stranding the sentinel", async () => {
  const call = await bootedSession("cpu-call-cutshort");
  const before = await stackPointer(call);
  // stopAtPC ends the run mid-routine, so the callee never executes its rts.
  const r = await call("cpu", {
    op: "call", pc: 0xC000, stopAtPC: 0xC004, maxFrames: 2, sandbox: false,
  });
  const after = await stackPointer(call);

  assert.equal(r.returned, false, "this is the unsafe shape");
  assert.equal(r.cpuContextRestored, true, "the repair happened and says so");
  // Without the fix this was 253 -> 10 and stayed there.
  assert.equal(after, before, "SP is back where the interrupted code expects it");
  assert.match(r.cpuContextNote, /did NOT reach its return/i);
  assert.match(r.cpuContextNote, /RAM written by the routine is deliberately NOT rolled back/i);
});

test("the RAM the routine wrote survives the restore", async () => {
  // The point of sandbox:false is reading what the routine produced. Repairing
  // the stack must not throw that away -- otherwise the fix breaks the feature.
  const call = await bootedSession("cpu-call-ram-survives");
  await call("memory", { op: "write", region: "system_ram", offset: 0x40, hex: "5a5a" });

  const r = await call("cpu", {
    op: "call", pc: 0xC000, stopAtPC: 0xC004, maxFrames: 2, sandbox: false,
    presetMemory: [{ addr: 0x0042, hex: "77" }],
  });
  assert.equal(r.cpuContextRestored, true);

  const ram = await call("memory", { op: "read", region: "system_ram", offset: 0x40, length: 3 });
  const hex = JSON.stringify(ram).match(/"hex":"([0-9a-f]+)"/i)?.[1];
  assert.equal(hex, "5a5a77", "pre-call marker AND the presetMemory byte both still live");
});

test("finalRegs still reports the state AT the stop, not the restored state", async () => {
  // The repair must not hide what the routine actually did -- finalRegs is the
  // evidence the caller came for.
  const call = await bootedSession("cpu-call-finalregs");
  const before = await stackPointer(call);
  const r = await call("cpu", {
    op: "call", pc: 0xC000, stopAtPC: 0xC004, maxFrames: 2, sandbox: false,
  });
  assert.equal(r.cpuContextRestored, true);
  assert.notEqual(r.finalRegs.S, before, "finalRegs shows the mid-call stack, not the restored one");
  assert.equal(await stackPointer(call), before, "the LIVE machine is the restored one");
});

test("sandbox:true is unaffected — it still restores everything", async () => {
  const call = await bootedSession("cpu-call-sandbox-true");
  await call("memory", { op: "write", region: "system_ram", offset: 0x40, hex: "1234" });
  const before = await stackPointer(call);
  const r = await call("cpu", {
    op: "call", pc: 0xC000, stopAtPC: 0xC004, maxFrames: 2, sandbox: true,
  });
  assert.equal(await stackPointer(call), before);
  // A full state restore already covers this, so the register-level repair is
  // neither needed nor claimed.
  assert.equal(r.cpuContextRestored, undefined);
});

test("after a cut-short call the machine behaves like one never called into", async () => {
  // The reported symptom was the game crashing into RAM on resume. Compare
  // against a CONTROL session that was never called into: nestest idles on a
  // static screen, so "RAM stopped changing" alone proves nothing -- the two
  // sessions have to agree.
  const controlCall = await bootedSession("cpu-call-control");
  const testCall = await bootedSession("cpu-call-resumed");

  const r = await testCall("cpu", {
    op: "call", pc: 0xC000, stopAtPC: 0xC004, maxFrames: 2, sandbox: false,
  });
  assert.equal(r.cpuContextRestored, true);

  const churn = async (call) => {
    const snap = async () => JSON.stringify(await call("memory", { op: "read", region: "system_ram", offset: 0, length: 128 }));
    const a = await snap();
    await call("frame", { op: "step", frames: 120 });
    return a !== (await snap());
  };
  assert.equal(await churn(testCall), await churn(controlCall), "same RAM behaviour as an untouched machine");

  // And it is still rendering, not sitting on a black screen.
  const v = await testCall("frame", { op: "verify" });
  assert.equal(v.verified, true, "renderHealth: still alive after resuming");
});
