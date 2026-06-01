// Tests for watchMemory's edge filter, multi-range, and file-output features.
//
// watchMemory is a server.tool() closure, so we drive it through a minimal
// fake MCP server that captures the registered handler, and a fake host whose
// memory advances on each stepFrames() call via a scripted byte timeline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { registerWatchMemoryTools } from "../src/mcp/tools/watch-memory.js";

// ── Fake host ──────────────────────────────────────────────────────
// Memory is a map of region -> Uint8Array. A per-frame mutator advances
// it each stepFrames(1). status.frameCount tracks absolute frames.
function makeHost(regions, perFrame) {
  const mem = {};
  for (const [r, arr] of Object.entries(regions)) mem[r] = Uint8Array.from(arr);
  const host = {
    status: { frameCount: 0, platform: "nes" },
    readMemory(region, offset, length) {
      const a = mem[region];
      if (!a) throw new Error(`fake host: unknown region ${region}`);
      return a.slice(offset, offset + length);
    },
    stepFrames(n) {
      for (let i = 0; i < n; i++) {
        host.status.frameCount++;
        perFrame(host.status.frameCount, mem);
      }
      return n;
    },
    pressButton() {},
  };
  return host;
}

// Pre-seed the shared host registry so getHost("test-session") returns ours.
import { _setHostForTest } from "../src/mcp/state.js";

const setHost = (key, host) => _setHostForTest(key, host);

// Capture the watchMemory handler out of registerWatchMemoryTools.
function getWatchHandler() {
  let handler;
  const fakeServer = {
    tool(name, _desc, _schema, h) {
      if (name === "watchMemory") handler = h;
    },
  };
  registerWatchMemoryTools(fakeServer, z, "test-session");
  return handler;
}

function parseResult(res) {
  // safeTool wraps the return in { content:[{type:'text', text: json}] }.
  const text = res.content.find((c) => c.type === "text").text;
  return JSON.parse(text);
}

test("onChange:'reset' keeps only counter reloads (jumps up)", async () => {
  // A countdown counter: 5,4,3,2,1, then resets to 8, counts down again...
  const seq = [5, 4, 3, 2, 1, 8, 7, 6, 5, 4];
  const host = makeHost({ system_ram: [seq[0]] }, (f, mem) => {
    if (f < seq.length) mem.system_ram[0] = seq[f];
  });
  setHost("test-session", host);
  const handler = getWatchHandler();

  const res = parseResult(await handler({
    region: "system_ram", offset: 0, length: 1,
    frames: 9, onChange: "reset", maxEvents: 100,
  }));
  // Only the 1->8 reload should match (one reset in this window).
  assert.equal(res.eventCount, 1);
  assert.equal(res.events[0].before, 1);
  assert.equal(res.events[0].after, 8);
});

test("onChange:'any' reports every change", async () => {
  const seq = [5, 4, 3, 2, 1, 8];
  const host = makeHost({ system_ram: [seq[0]] }, (f, mem) => {
    if (f < seq.length) mem.system_ram[0] = seq[f];
  });
  setHost("test-session", host);
  const handler = getWatchHandler();
  const res = parseResult(await handler({
    region: "system_ram", offset: 0, length: 1, frames: 5, onChange: "any",
  }));
  assert.equal(res.eventCount, 5); // 5→4→3→2→1→8 = 5 transitions
});

test("valueFilter keeps only changes whose new value is in range", async () => {
  const seq = [10, 200, 5, 250, 1];
  const host = makeHost({ system_ram: [seq[0]] }, (f, mem) => {
    if (f < seq.length) mem.system_ram[0] = seq[f];
  });
  setHost("test-session", host);
  const handler = getWatchHandler();
  const res = parseResult(await handler({
    region: "system_ram", offset: 0, length: 1, frames: 4,
    onChange: "any", valueFilter: { min: 100 },
  }));
  // Only transitions landing >=100: ->200 and ->250.
  assert.equal(res.eventCount, 2);
  for (const e of res.events) assert.ok(e.after >= 100);
});

test("multi-range watches disjoint regions on identical frames with labels", async () => {
  // pitch byte at sys[0], rhythm byte at sys[50]; both change frame 2.
  const host = makeHost({ system_ram: new Array(64).fill(0) }, (f, mem) => {
    if (f === 2) { mem.system_ram[0] = 0x42; mem.system_ram[50] = 0x99; }
  });
  setHost("test-session", host);
  const handler = getWatchHandler();
  const res = parseResult(await handler({
    ranges: [
      { region: "system_ram", offset: 0, length: 1, label: "pitch" },
      { region: "system_ram", offset: 50, length: 1, label: "rhythm" },
    ],
    frames: 3, onChange: "any",
  }));
  assert.equal(res.eventCount, 2);
  const labels = res.events.map((e) => e.label).sort();
  assert.deepEqual(labels, ["pitch", "rhythm"]);
  // Both fired on the same absolute frame.
  assert.equal(res.events[0].frame, res.events[1].frame);
});

test("outputPath streams full log to NDJSON + returns capped preview", async () => {
  const host = makeHost({ system_ram: [0] }, (f, mem) => {
    mem.system_ram[0] = f & 0xFF; // changes every frame
  });
  setHost("test-session", host);
  const handler = getWatchHandler();
  const out = path.join(os.tmpdir(), `wm-test-${process.pid}.ndjson`);
  try {
    const res = parseResult(await handler({
      region: "system_ram", offset: 0, length: 1,
      frames: 20, onChange: "any", maxEvents: 5, outputPath: out,
    }));
    assert.equal(res.path, out);
    assert.equal(res.format, "ndjson");
    assert.equal(res.eventCount, 20);       // full count
    assert.equal(res.preview.length, 5);    // inline preview capped
    assert.equal(res.truncated, true);
    const lines = (await readFile(out, "utf8")).trim().split("\n");
    assert.equal(lines.length, 20);         // every event on disk
    assert.ok(JSON.parse(lines[0]).after !== undefined);
  } finally {
    await rm(out, { force: true });
  }
});

test("stopOnFirst stops at first filter-passing change", async () => {
  const seq = [0, 0, 0, 7];
  const host = makeHost({ system_ram: [0] }, (f, mem) => {
    if (f < seq.length) mem.system_ram[0] = seq[f];
  });
  setHost("test-session", host);
  const handler = getWatchHandler();
  const res = parseResult(await handler({
    region: "system_ram", offset: 0, length: 1, frames: 100,
    onChange: "increase", stopOnFirst: true,
  }));
  assert.equal(res.stoppedEarly, true);
  assert.equal(res.eventCount, 1);
  assert.equal(res.events[0].after, 7);
});

test("missing region without ranges returns a clear error result", async () => {
  const host = makeHost({ system_ram: [0] }, () => {});
  setHost("test-session", host);
  const handler = getWatchHandler();
  // safeTool catches the throw and returns { isError:true, content:[text] }.
  const res = await handler({ frames: 1, offset: 0, length: 1, onChange: "any" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /pass `region`.*or `ranges`/);
});
