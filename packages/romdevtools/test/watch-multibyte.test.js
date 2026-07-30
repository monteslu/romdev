// watch({on:'mem'}) and multi-byte variables.
//
// The bug this covers: a 2-byte range was diffed BYTE-WISE, and every resulting
// event carried the RANGE's label. A 16-bit map distance living at $A2/$A3 with
// a steady high byte therefore produced exactly one series -- the low byte --
// labelled `dist`, with values 240..249. The real value was 1520..1529. Nothing
// in the response said the series was a fragment, and the byte that would have
// revealed it (the constant high byte) emitted no events at all, so it was
// absent entirely. A field report read 1520 as 240 for exactly this reason.
//
// Two fixes, tested here:
//   as:'u16le' etc -> ONE combined series under the range's label.
//   un-annotated multi-byte ranges -> byteIndex/byteLabel on the split series,
//   plus constantBytes[] for the bytes that never moved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerWatchMemoryTools } from "../src/mcp/tools/watch-memory.js";
import { _setHostForTest } from "../src/mcp/state.js";

function getWatchHandler(sessionKey) {
  let handler;
  registerWatchMemoryTools({ tool(name, _d, _s, h) { if (name === "watch") handler = h; } }, z, sessionKey);
  return handler;
}

function parseResult(res) {
  assert.equal(res.isError, undefined, "unexpected isError: " + JSON.stringify(res));
  return JSON.parse(res.content.find((c) => c.type === "text").text);
}

function expectRejected(res) {
  assert.equal(res.isError, true, "expected isError, got: " + JSON.stringify(res));
  return res.content.find((c) => c.type === "text").text;
}

/**
 * A host whose RAM is driven by a per-frame mutator, so a test can model a real
 * 16-bit variable (low byte rolling, high byte stepping only on carry).
 */
function fakeHost(ram, onFrame) {
  let frame = 0;
  return {
    status: { platform: "nes", loaded: true, paused: false },
    stepFrames(n = 1) { for (let i = 0; i < n; i++) { frame++; onFrame(ram, frame); } return frame; },
    readMemory(_region, offset, length) { return ram.slice(offset, offset + length); },
    getCPUState() { return { pc: 0xC000 }; },
    setInput() {},
    renderOneFrame() {},
  };
}

// A 16-bit LE counter at offset 162 ($A2/$A3) starting at 1520, incrementing
// once per frame -- the exact shape from the field report.
function makeCounterHost(start = 1520) {
  const ram = new Uint8Array(256);
  const write16 = (v) => { ram[162] = v & 0xff; ram[163] = (v >> 8) & 0xff; };
  write16(start);
  return fakeHost(ram, (_r, frame) => write16(start + frame));
}

test("as:'u16le' returns ONE series of combined values, not per-byte fragments", async () => {
  const key = "watch-u16le";
  _setHostForTest(key, makeCounterHost(1520));
  const handler = getWatchHandler(key);
  const res = parseResult(await handler({
    on: "mem", format: "series", frames: 8,
    ranges: [{ region: "system_ram", offset: 162, length: 2, label: "dist", as: "u16le" }],
  }));

  assert.equal(res.series.length, 1, "one series for one variable");
  const s = res.series[0];
  assert.equal(s.label, "dist");
  assert.equal(s.as, "u16le");
  assert.equal(s.width, 2);
  // The whole point: real values, not low-byte fragments.
  assert.deepEqual(s.values, [1521, 1522, 1523, 1524, 1525, 1526, 1527, 1528]);
  assert.ok(s.values.every((v) => v > 255), "combined values exceed one byte");
});

test("as:'u16be' reads the same bytes with the other endianness", async () => {
  const key = "watch-u16be";
  _setHostForTest(key, makeCounterHost(1520));
  const handler = getWatchHandler(key);
  const res = parseResult(await handler({
    on: "mem", format: "series", frames: 4,
    ranges: [{ region: "system_ram", offset: 162, length: 2, label: "dist", as: "u16be" }],
  }));
  // 1521 = 0x05F1 stored LE as F1 05, read BE as 0xF105.
  assert.equal(res.series[0].values[0], 0xF105);
});

test("a carry that changes BOTH bytes is one event, not two", async () => {
  const key = "watch-carry";
  // 255 -> 256 moves the low byte 255->0 AND the high byte 0->1.
  _setHostForTest(key, makeCounterHost(255));
  const handler = getWatchHandler(key);
  const res = parseResult(await handler({
    on: "mem", format: "series", frames: 2,
    ranges: [{ region: "system_ram", offset: 162, length: 2, label: "n", as: "u16le" }],
  }));
  assert.equal(res.series.length, 1);
  assert.deepEqual(res.series[0].values, [256, 257]);
  assert.equal(res.eventCount, 2, "two frames, two combined changes -- not four byte changes");
});

test("an un-annotated multi-byte range marks its split series with byteIndex", async () => {
  const key = "watch-split-labels";
  _setHostForTest(key, makeCounterHost(1520));
  const handler = getWatchHandler(key);
  const res = parseResult(await handler({
    on: "mem", format: "series", frames: 8,
    ranges: [{ region: "system_ram", offset: 162, length: 2, label: "dist" }],
  }));

  // Only the low byte changes in this window, so only it gets a series -- but
  // it must no longer claim to BE `dist`.
  const s = res.series.find((x) => x.offset === 162);
  assert.ok(s, "low-byte series present");
  assert.equal(s.label, "dist");
  assert.equal(s.byteIndex, 0);
  assert.equal(s.byteLabel, "dist[0]");
});

test("a byte that never changed is reported in constantBytes with its value", async () => {
  const key = "watch-constants";
  _setHostForTest(key, makeCounterHost(1520));
  const handler = getWatchHandler(key);
  const res = parseResult(await handler({
    on: "mem", format: "series", frames: 8,
    ranges: [{ region: "system_ram", offset: 162, length: 2, label: "dist" }],
  }));

  // This is the information whose ABSENCE made 1520 read as 240.
  assert.ok(res.constantBytes, "constantBytes present");
  const hi = res.constantBytes.find((c) => c.offset === 163);
  assert.ok(hi, "the steady high byte is reported");
  assert.equal(hi.value, 5, "1520..1528 all have high byte 0x05");
  assert.equal(hi.byteIndex, 1);
  assert.equal(hi.byteLabel, "dist[1]");
  assert.equal(hi.changed, false);
  assert.match(res.constantBytesNote, /as:'u16le'/);
});

test("a 1-byte range gains no byte annotations (nothing to disambiguate)", async () => {
  const key = "watch-single-byte";
  _setHostForTest(key, makeCounterHost(1520));
  const handler = getWatchHandler(key);
  const res = parseResult(await handler({
    on: "mem", format: "series", frames: 4,
    ranges: [{ region: "system_ram", offset: 162, length: 1, label: "lo" }],
  }));
  const s = res.series[0];
  assert.equal(s.label, "lo");
  assert.equal(s.byteIndex, undefined, "no byteIndex on a single-byte range");
  assert.equal(res.constantBytes, undefined, "no constantBytes for a 1-byte range");
});

test("length that isn't a multiple of the as width is rejected", async () => {
  const key = "watch-bad-width";
  _setHostForTest(key, makeCounterHost());
  const handler = getWatchHandler(key);
  const msg = expectRejected(await handler({
    on: "mem", format: "series", frames: 2,
    ranges: [{ region: "system_ram", offset: 162, length: 3, label: "dist", as: "u16le" }],
  }));
  assert.match(msg, /as:'u16le' \(2 bytes\) but length:3/);
  assert.match(msg, /multiple of 2/);
});

test("as over an ARRAY of same-width values yields one series per element", async () => {
  const key = "watch-array";
  const ram = new Uint8Array(256);
  // Two 16-bit LE values; only the second one moves.
  ram[10] = 0x10; ram[11] = 0x00;
  ram[12] = 0x20; ram[13] = 0x00;
  _setHostForTest(key, fakeHost(ram, (r, frame) => { r[12] = 0x20 + frame; }));
  const handler = getWatchHandler(key);
  const res = parseResult(await handler({
    on: "mem", format: "series", frames: 3,
    ranges: [{ region: "system_ram", offset: 10, length: 4, label: "ptrs", as: "u16le" }],
  }));
  assert.equal(res.series.length, 1, "only the element that moved has a series");
  assert.equal(res.series[0].offset, 12);
  assert.deepEqual(res.series[0].values, [0x21, 0x22, 0x23]);
});

test("format:'events' also combines under as, carrying as/width per event", async () => {
  const key = "watch-events-as";
  _setHostForTest(key, makeCounterHost(1520));
  const handler = getWatchHandler(key);
  const res = parseResult(await handler({
    on: "mem", frames: 3,
    ranges: [{ region: "system_ram", offset: 162, length: 2, label: "dist", as: "u16le" }],
  }));
  assert.equal(res.events.length, 3);
  assert.equal(res.events[0].after, 1521);
  assert.equal(res.events[0].as, "u16le");
  assert.equal(res.events[0].width, 2);
});
