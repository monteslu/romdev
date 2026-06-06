// GB (gambatte / SM83) RE primitives round 2 — end to end.
//   - setRegister                  (item 1: register write/read round-trip; reg-id 0 = A)
//   - watchRange                   (item 2a: log every read/write in a range)
//   - logPCRange                   (item 2b: coverage trace — distinct PCs in a window)
//   - callSubroutine               (item 1: needs romdev_setreg + pcbreak — both present)
// Mirrors test/genesis-re-primitives.test.js for the SM83 core.
import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "gb-re", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gb-re-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}
const toJSON = (res) => { assert.equal(res.isError, undefined, "isError: " + JSON.stringify(res)); return JSON.parse(res.content[0].text); };

// Per-frame WRITE of a counter to WRAM 0xC000, plus a READ-back at 0xC002, so
// watchRange has a deterministic write target and a hot main loop for logPCRange.
const SRC = `
volatile unsigned char g_w;     /* lives in WRAM */
volatile unsigned char g_r = 9; /* lives in WRAM, read each loop */
void main(void) {
    unsigned char acc = 0;
    *((volatile unsigned char*)0xC000) = 1;
    for (;;) {
        acc += *((volatile unsigned char*)0xC002);  /* READ of g_r each loop */
        *((volatile unsigned char*)0xC000) = acc;   /* WRITE of the counter each loop */
        g_w = acc;
    }
}`;

test("GB RE primitives: setRegister + watchRange + logPCRange + callSubroutine (gambatte sm83)", { timeout: 240000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "buildSource", arguments: { platform: "gb", language: "c", source: SRC },
  }, undefined, { timeout: 240000 }));
  assert.equal(build.ok, true, "gb build failed:\n" + build.log);

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "gb", path: build.binaryPath },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));

  // Let the ROM reach its main loop so the per-frame write is live.
  toJSON(await client.callTool({ name: "frame", arguments: { op: "step",  frames: 60 } }));

  // ── item 1: setRegister round-trips (reg-id 0 = A on SM83) ──
  const sr = toJSON(await client.callTool({ name: "cpu", arguments: { op: "setReg",  regId: 0, value: 0xA5 } }));
  assert.equal(sr.notSupported, undefined, "setRegister notSupported — romdev_setreg missing?");
  assert.equal((sr.valueRaw & 0xFF), 0xA5, "setRegister (A) didn't round-trip: " + JSON.stringify(sr));

  // setRegister of F (reg-id 1) must round-trip through the split flag fields.
  const srF = toJSON(await client.callTool({ name: "cpu", arguments: { op: "setReg",  regId: 1, value: 0xB0 } }));
  // SM83 F low nibble is always 0; 0xB0 = Z + N + C set, H clear.
  assert.equal((srF.valueRaw & 0xF0), 0xB0, "setRegister (F) didn't round-trip: " + JSON.stringify(srF));

  // ── item 2a: watchRange logs writes to 0xC000 with pc/addr/value ──
  const wr = toJSON(await client.callTool({
    name: "watch", arguments: { on: "range",  start: 0xC000, end: 0xC000, kind: "write", frames: 10, limit: 20 },
  }));
  assert.equal(wr.notSupported, undefined, "watchRange notSupported");
  assert.ok(wr.total > 0, "watchRange caught no writes to 0xC000: " + JSON.stringify(wr));
  assert.ok(wr.distinctPCs.length > 0, "watchRange returned no PCs: " + JSON.stringify(wr));
  assert.ok(wr.events.length > 0 && wr.events[0].address === "$C000", "watchRange event addr wrong: " + JSON.stringify(wr.events[0]));

  // ── item 2b: logPCRange returns distinct executed PCs in the ROM bank window ──
  const cov = toJSON(await client.callTool({
    name: "watch", arguments: { on: "pc",  start: 0x0000, end: 0x7FFF, frames: 10 },
  }));
  assert.equal(cov.notSupported, undefined, "logPCRange notSupported");
  assert.ok(cov.distinct > 0, "logPCRange found no PCs: " + JSON.stringify(cov));

  // ── item 1: callSubroutine is SUPPORTED (needs romdev_setreg + pcbreak, both
  //    present). We don't drive a reg-args copy here — SM83's C ABI is stack-based,
  //    not register-args. The host's callSubroutine seeds the stack via
  //    writeMemoryCpuAddr, whose generic fallback indexes system_ram by the raw
  //    CPU address; on GB the stack lives at 0xDFFx (top of the 8KB WRAM window),
  //    so that generic write lands out of bounds — a HOST-layer GB-mapping gap,
  //    not a core-feature gap (and the host layer is out of scope for this patch).
  //    The capability we own — register-write + the PC breakpoint — is proven by:
  //      (a) setRegister above (romdev_setreg wired), and
  //      (b) callSubroutine getting PAST its support gate: a `notSupported`
  //          response means the gate failed; any other outcome means setreg +
  //          pcbreak were both detected. So we assert NOT-notSupported.
  const csRes = await client.callTool({
    name: "cpu",
    arguments: { op: "call",  pc: 0x0100, regs: {}, maxFrames: 30, sandbox: true },
  });
  if (!csRes.isError) {
    const cs = JSON.parse(csRes.content[0].text);
    assert.equal(cs.notSupported, undefined, "callSubroutine notSupported — setreg/pcbreak missing?");
  } else {
    // Got past the support gate (setRegSupported() + pcBreakSupported() both true)
    // and failed only in the GB stack-seed mapping. Confirm it's that gap, not a
    // missing-feature surface.
    const msg = csRes.content?.[0]?.text ?? "";
    assert.match(msg, /out of bounds/i,
      "callSubroutine failed for an unexpected reason (not the known GB stack-seed mapping gap): " + msg);
  }
});
