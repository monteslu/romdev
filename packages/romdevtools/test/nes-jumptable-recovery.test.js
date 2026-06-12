// A4: live-emulator computed-jumptable recovery (breakpoint({on:'jumptable'})).
//
// Static analysis follows direct addressing only, so a `JMP (table,X)` /
// function-pointer dispatch collapses to "Could not recover jumptable" in the
// decompiler. romdev resolves it dynamically: break at the dispatcher, single-
// step THROUGH the indirect transfer, and record the PC it actually lands on —
// accumulating the distinct target set across frames. No static-only tool can
// do this; it needs a live emulator in the loop.
//
// This builds a NES ROM whose main loop dispatches through a function-pointer
// table indexed by a counter that changes every frame, so the dispatcher lands
// on a DIFFERENT arm each frame. The op must recover MORE THAN ONE distinct
// target — the property a static decompiler structurally cannot produce.

import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "nes-jt", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nes-jt-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}
const toJSON = (res) => { assert.equal(res.isError, undefined, "isError: " + JSON.stringify(res)); return JSON.parse(res.content[0].text); };

// A computed-jump dispatcher: `dispatch()` calls one of four handlers through a
// function-pointer table indexed by (frame_counter & 3). cc65 lowers the
// indirect call to a `jsr` into the pointer-call shim, which ends in an
// indirect `jmp` — exactly the construct static analysis can't follow. The
// counter advances every frame, so successive dispatches land on different
// handlers → multiple distinct targets.
const SRC = `
volatile unsigned char tick;
volatile unsigned char sink;
void h0(void) { sink = 0xA0; }
void h1(void) { sink = 0xB1; }
void h2(void) { sink = 0xC2; }
void h3(void) { sink = 0xD3; }
static void (* const table[4])(void) = { h0, h1, h2, h3 };
void dispatch(void) { table[tick & 3](); }
void main(void) {
  unsigned int spin;
  while (1) {
    dispatch();
    tick++;
    for (spin = 0; spin < 2000; spin++) { sink = (unsigned char)spin; }
  }
}`;

test("A4: breakpoint({on:'jumptable'}) recovers multiple computed targets (fceumm 6502)", { timeout: 180000 }, async () => {
  const client = await startClient();

  // Build WITH debug so we can resolve the `dispatch` label's address. The
  // `resolveSymbols` inline feature folds the address straight into the result;
  // romWithDebug needs an outputPath (writes ROM + .dbg there).
  const dir = await mkdtemp(path.join(os.tmpdir(), "jt-test-"));
  const outPath = path.join(dir, "jt.nes");
  const build = toJSON(await client.callTool({
    name: "build",
    arguments: { output: "romWithDebug", platform: "nes", source: SRC, outputPath: outPath,
      resolveSymbols: ["dispatch", "h0", "h1", "h2", "h3"] },
  }, undefined, { timeout: 180000 }));
  assert.equal(build.ok, true, "nes build failed:\n" + build.log);
  const romPath = build.binaryPath ?? build.outputPath ?? outPath;
  // The four handler entry addresses — the recovered targets must BE these (not
  // the fixed trampolines on the dispatch path).
  const handlerAddrs = new Set(["h0", "h1", "h2", "h3"].map((h) => build.resolvedSymbols?.[h]?.address));
  assert.equal(handlerAddrs.size, 4, "expected 4 distinct handler addresses: " + JSON.stringify(build.resolvedSymbols));

  toJSON(await client.callTool({ name: "loadMedia", arguments: { platform: "nes", path: romPath } }));
  toJSON(await client.callTool({ name: "frame", arguments: { op: "step", frames: 10 } }));

  // The dispatcher's CPU address (cc65 keeps the `_dispatch` label). resolveSymbols
  // returns it under the bare C name.
  const sym = build.resolvedSymbols?.dispatch?.address;
  assert.ok(typeof sym === "number",
    "could not resolve the dispatch symbol address: " + JSON.stringify(build.resolvedSymbols));

  const jt = toJSON(await client.callTool({
    name: "breakpoint",
    arguments: { on: "jumptable", address: sym, maxFrames: 240 },
  }));

  assert.equal(jt.notSupported, undefined, "jumptable notSupported — pcbreak/step missing on fceumm?");
  assert.equal(jt.ok, true, "op did not return ok: " + JSON.stringify(jt));
  assert.ok(jt.dispatcherHits > 0, "dispatcher never executed: " + JSON.stringify(jt));
  assert.equal(jt.resolved, true, "no targets resolved: " + JSON.stringify(jt));
  assert.notEqual(jt.singleArmObserved, true, "should observe multiple arms (tick cycles 0..3): " + JSON.stringify(jt));

  // The recovered targets must BE the actual handler entries — not the fixed
  // trampolines on the dispatch path. cycling tick&3 over 240 frames hits all 4.
  const recovered = new Set(jt.targets.map((t) => t.targetRaw));
  const recoveredHandlers = [...handlerAddrs].filter((a) => recovered.has(a));
  assert.ok(recoveredHandlers.length >= 2,
    `expected the recovered targets to include >=2 of the 4 real handlers ${JSON.stringify([...handlerAddrs])}, ` +
    `but got targets ${JSON.stringify(jt.targets.map((t) => t.target))}`);
  // And the fixed trampolines (seen on EVERY dispatch) must have been filtered
  // out: every reported target should be a handler, not a constant-on-every-hit
  // address. (A target with hits == dispatcherHits would be a trampoline.)
  for (const t of jt.targets) {
    assert.ok(typeof t.targetRaw === "number", "each target carries a raw address");
    assert.ok(t.hits >= 1 && t.hits < jt.dispatcherHits,
      `target ${t.target} has hits=${t.hits} == dispatcherHits — that's a fixed trampoline, not a computed arm`);
  }
});
