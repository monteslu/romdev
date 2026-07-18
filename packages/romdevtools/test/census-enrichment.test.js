// Census enrichment (0.101.0): phantom-read flagging + routine grouping on
// watch({on:'range'}) results. Pure JS — fake host, synthetic cart bytes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerWatchMemoryTools } from "../src/mcp/tools/watch-memory.js";
import { _setHostForTest } from "../src/mcp/state.js";

function makeRangeHost({ events, platform = "nes", cartRaw = null }) {
  return {
    status: { frameCount: 0, platform },
    rangeWatchSupported: () => true,
    watchRange: (_s, _e, _k, _f) => ({ events, total: events.length, truncated: false }),
    getCartRom: () => ({ raw: cartRaw }),
    readMemory: () => { throw new Error("not needed"); },
    stepFrames: () => 0,
    setInput: () => {},
  };
}

function getWatchHandler() {
  let handler;
  const fakeServer = { tool(name, _d, _s, h) { if (name === "watch") handler = h; } };
  registerWatchMemoryTools(fakeServer, z, "census-test");
  return (args) => handler(args);
}

function parseResult(res) {
  return JSON.parse(res.content.find((c) => c.type === "text").text);
}

/** iNES cart: 16KB PRG mapped $C000-$FFFF; place opcode bytes at CPU addrs. */
function makeCart(bytesAt) {
  const raw = new Uint8Array(16 + 16384);
  raw[0] = 0x4e; raw[1] = 0x45; raw[2] = 0x53; raw[3] = 0x1a; raw[4] = 1;
  for (const [cpuAddr, bytes] of Object.entries(bytesAt)) {
    const off = 16 + (Number(cpuAddr) - 0xC000);
    raw.set(Uint8Array.from(bytes), off);
  }
  return raw;
}

test("read census flags a dummy-read indexed store as phantomRead", async () => {
  const cart = makeCart({
    0xC100: [0x9D, 0xF8, 0x05], // sta $05F8,x — base OUTSIDE 04B0..0527 → phantom
    0xC200: [0xAD, 0xB4, 0x04], // lda $04B4  — legit reader
  });
  _setHostForTest("census-test", makeRangeHost({
    cartRaw: cart,
    events: [
      { pc: 0xC100, address: 0x04F8, value: 0 },
      { pc: 0xC100, address: 0x04F9, value: 0 },
      { pc: 0xC200, address: 0x04B4, value: 7 },
    ],
  }));
  const res = parseResult(await getWatchHandler()({
    on: "range", start: 0x04B0, end: 0x0527, kind: "read", frames: 1, distinctPCsOnly: true,
  }));
  const by = Object.fromEntries(res.byPC.map((r) => [r.pc, r]));
  assert.equal(by.$C100.phantomRead, true);
  assert.equal(by.$C100.storeBase, "$5F8");
  assert.equal(by.$C200.phantomRead, undefined);
  assert.match(res.note, /phantomRead/);
  assert.match(res.note, /dummy-read/);
});

test("write census never flags phantoms; RMW abs,X flagged only on read", async () => {
  const cart = makeCart({ 0xC100: [0xFE, 0x00, 0x06] }); // inc $0600,x — base outside range
  const events = [{ pc: 0xC100, address: 0x04F0, value: 1 }];
  _setHostForTest("census-test", makeRangeHost({ cartRaw: cart, events }));
  const handler = getWatchHandler();

  const w = parseResult(await handler({ on: "range", start: 0x04B0, end: 0x0527, kind: "write", frames: 1, distinctPCsOnly: true }));
  assert.equal(w.byPC[0].phantomRead, undefined);

  const r = parseResult(await handler({ on: "range", start: 0x04B0, end: 0x0527, kind: "read", frames: 1, distinctPCsOnly: true }));
  assert.equal(r.byPC[0].phantomRead, true);
});

test("dbg/map symbol text groups PCs into routines with a byRoutine rollup", async () => {
  _setHostForTest("census-test", makeRangeHost({
    events: [
      { pc: 0xC100, address: 0x0040, value: 1 },
      { pc: 0xC110, address: 0x0040, value: 2 },
      { pc: 0xC310, address: 0x0040, value: 3 },
    ],
  }));
  const map = [
    "0000C0F0  _DrawHud   main",
    "0000C300  _UpdateObjs   main",
  ].join("\n");
  const res = parseResult(await getWatchHandler()({
    on: "range", start: 0x0040, end: 0x0040, kind: "write", frames: 1, distinctPCsOnly: true, map,
  }));
  const by = Object.fromEntries(res.byPC.map((r) => [r.pc, r]));
  assert.equal(by.$C100.routine, "DrawHud+16");
  assert.equal(by.$C110.routine, "DrawHud+32");
  assert.equal(by.$C310.routine, "UpdateObjs+16");
  assert.equal(res.byRoutine.length, 2);
  assert.deepEqual(res.byRoutine[0], { routine: "DrawHud", pcs: 2, count: 2 });
  assert.match(res.note, /ROUTINE units/);
});

test("no symbols + non-read kind → result shape unchanged", async () => {
  _setHostForTest("census-test", makeRangeHost({
    events: [{ pc: 0xC100, address: 0x0040, value: 1 }],
  }));
  const res = parseResult(await getWatchHandler()({
    on: "range", start: 0x0040, end: 0x0040, kind: "write", frames: 1, distinctPCsOnly: true,
  }));
  assert.equal(res.byRoutine, undefined);
  assert.equal(res.byPC[0].phantomRead, undefined);
  assert.equal(res.byPC[0].routine, undefined);
});
