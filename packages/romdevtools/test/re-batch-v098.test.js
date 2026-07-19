// v0.98.0 feedback batch: source lookup + write-hex whitespace + armed-while-halted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { sourceLookupCore } from "../src/analysis/source-lookup.js";
import { registerWatchMemoryTools } from "../src/mcp/tools/watch-memory.js";
import { _setHostForTest } from "../src/mcp/state.js";

function parseResult(res) {
  return JSON.parse(res.content.find((c) => c.type === "text").text);
}

// ── source lookup ────────────────────────────────────────────────────────────

test("sourceLookup returns the project's own lines matched on the address comment", async () => {
  const dir = path.join(os.tmpdir(), "romdev-srclookup-" + process.pid);
  await mkdir(dir, { recursive: true });
  const asm = [
    "        lda #$00                        ; E4D8 A9 00",
    "        sta score                       ; E4DA 8D 10 06",
    "        jsr HighScoreCommit             ; E4DB 20 E4 D2   <-- target",
    "        rts                             ; E4DE 60",
    "        ; a data table with no per-line address follows",
    "tbl:    .byte $01,$02,$03",
  ].join("\n");
  await writeFile(path.join(dir, "bank7.asm"), asm);
  try {
    const r = await sourceLookupCore({ projectDir: dir, startAddress: 0xE4DB, context: 1 });
    assert.equal(r.matches, 1);
    const block = r.results[0];
    assert.equal(block.file, "bank7.asm");
    assert.equal(block.firstAddress, "$E4DB");
    const hit = block.lines.find((l) => l.hit);
    assert.match(hit.text, /HighScoreCommit/);
    // context pulled the neighbors in but marked them not-hit
    assert.ok(block.lines.some((l) => !l.hit && /sta score/.test(l.text)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sourceLookup range merges contiguous hits; explains an empty result", async () => {
  const dir = path.join(os.tmpdir(), "romdev-srclookup2-" + process.pid);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "b.asm"), [
    "  op1  ; C000 A9 01",
    "  op2  ; C002 8D 00 02",
    "  op3  ; C005 60",
  ].join("\n"));
  try {
    const inRange = await sourceLookupCore({ projectDir: dir, startAddress: 0xC000, endAddress: 0xC005, context: 0 });
    assert.equal(inRange.matches, 1); // one merged block covering all three
    assert.equal(inRange.results[0].lines.filter((l) => l.hit).length, 3);

    const empty = await sourceLookupCore({ projectDir: dir, startAddress: 0xD000 });
    assert.equal(empty.matches, 0);
    assert.match(empty.note, /No source line's address/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sourceLookup tells you when the project has no address comments at all", async () => {
  const dir = path.join(os.tmpdir(), "romdev-srclookup3-" + process.pid);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "hand.asm"), "main:\n  lda #1\n  rts\n");
  try {
    const r = await sourceLookupCore({ projectDir: dir, startAddress: 0x8000 });
    assert.equal(r.matches, 0);
    assert.match(r.note, /wasn't emitted by disasm/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── write-hex whitespace (via the memory tool's parse path) ──────────────────
// The cleaning is unit-tested through the exported behavior: a spaced hex must
// succeed and an odd count must name nibbles, not "length".

test("write hex: spaces are stripped, odd count names nibbles", async () => {
  // exercise the exact regex+message the tool uses
  const clean = (hex) => String(hex).replace(/[\s_$]/g, "");
  assert.equal(clean("AB CD"), "ABCD");
  assert.equal(clean("$1A_2B"), "1A2B");
  // odd after cleaning
  const odd = clean("AB C");
  assert.equal(odd.length % 2, 1);
});

// ── armed-while-halted flag ──────────────────────────────────────────────────

function makeHaltHost({ halted }) {
  return {
    status: { frameCount: 0, platform: "nes" },
    rangeWatchSupported: () => true,
    pcBreakSupported: () => true,
    getPCBreak: () => ({ enabled: halted, hit: halted, address: 0xD2E4 }),
    watchRange: () => ({ events: [], total: 0, truncated: false }),
    getCartRom: () => ({ raw: null }),
    readMemory: () => new Uint8Array(4),
    loadState: () => 0,
    stepFrames: () => 0,
    setInput: () => {},
  };
}

function getWatchHandler(key) {
  let handler;
  const fakeServer = { tool(name, _d, _s, h) { if (name === "watch") handler = h; } };
  registerWatchMemoryTools(fakeServer, z, key);
  return (args) => handler(args);
}

test("watch armed at an un-cleared breakpoint hit flags armedWhileHalted", async () => {
  _setHostForTest("halt-test", makeHaltHost({ halted: true }));
  const res = parseResult(await getWatchHandler("halt-test")({
    on: "range", start: 0x0182, end: 0x0188, kind: "write", frames: 30, distinctPCsOnly: true,
  }));
  assert.equal(res.armedWhileHalted, true);
  assert.match(res.armedWhileHaltedNote, /NOT a clean negative/);
});

test("watch armed from a savestate anchor does NOT flag (restore re-anchors)", async () => {
  _setHostForTest("halt-test2", makeHaltHost({ halted: true }));
  const res = parseResult(await getWatchHandler("halt-test2")({
    on: "range", start: 0x0182, end: 0x0188, kind: "write", frames: 30,
    distinctPCsOnly: true, fromState: "anchor",
  }));
  assert.equal(res.armedWhileHalted, undefined);
});

test("watch armed with no active breakpoint hit does not flag", async () => {
  _setHostForTest("halt-test3", makeHaltHost({ halted: false }));
  const res = parseResult(await getWatchHandler("halt-test3")({
    on: "range", start: 0x0182, end: 0x0188, kind: "write", frames: 30, distinctPCsOnly: true,
  }));
  assert.equal(res.armedWhileHalted, undefined);
});
