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
    // Records every setInput payload keyed by the frame it was set on, so tests
    // can assert pressDuring actually drove input (the real bug: it never did).
    inputLog: [],
    readMemory(region, offset, length) {
      const a = mem[region];
      if (!a) throw new Error(`fake host: unknown region ${region}`);
      return a.slice(offset, offset + length);
    },
    stepFrames(n) {
      for (let i = 0; i < n; i++) {
        host.status.frameCount++;
        perFrame(host.status.frameCount, mem, host);
      }
      return n;
    },
    setInput(input) {
      host.inputLog.push({ frame: host.status.frameCount, input });
    },
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

// v18-feedback: per-range filters so one noisy free-running counter doesn't bury
// the rare signal in a multi-range watch.
test("per-range sampleEvery thins a noisy range while a slow range stays full", async () => {
  // sys[0] = a noisy counter changing EVERY frame; sys[10] = a slow state byte
  // that changes only on frames 5 and 12.
  const host = makeHost({ system_ram: new Array(32).fill(0) }, (f, mem) => {
    mem.system_ram[0] = f & 0xFF;                 // noisy: changes every frame
    if (f === 5) mem.system_ram[10] = 1;          // slow: 2 transitions total
    if (f === 12) mem.system_ram[10] = 2;
  });
  setHost("test-session", host);
  const handler = getWatchHandler();
  const res = parseResult(await handler({
    ranges: [
      { region: "system_ram", offset: 0, length: 1, label: "noisy", sampleEvery: 5 },
      { region: "system_ram", offset: 10, length: 1, label: "state" },
    ],
    frames: 15, onChange: "any", maxEvents: 1000,
  }));
  const noisy = res.events.filter((e) => e.label === "noisy");
  const state = res.events.filter((e) => e.label === "state");
  // The slow range keeps BOTH its transitions...
  assert.equal(state.length, 2, "slow state byte fully reported");
  // ...while the noisy range (15 changes) is thinned ~5× (kept 1st, 6th, 11th...).
  assert.ok(noisy.length <= 4 && noisy.length >= 2, `noisy range thinned to ${noisy.length} (was 15)`);
});

test("per-range onChange overrides the call-wide edge filter", async () => {
  const host = makeHost({ system_ram: new Array(16).fill(0) }, (f, mem) => {
    // sys[0] ramps up then resets (a counter); sys[5] just toggles.
    mem.system_ram[0] = [0, 5, 3, 8, 1][f] ?? 1;
    if (f === 2) mem.system_ram[5] = 0x99;
  });
  setHost("test-session", host);
  const handler = getWatchHandler();
  const res = parseResult(await handler({
    ranges: [
      // Only count UP-jumps (resets) on the counter, but ANY change on the toggle.
      { region: "system_ram", offset: 0, length: 1, label: "counter", onChange: "reset" },
      { region: "system_ram", offset: 5, length: 1, label: "toggle" },
    ],
    frames: 4, onChange: "any", maxEvents: 1000,
  }));
  const counter = res.events.filter((e) => e.label === "counter");
  // counter seq 0→5→3→8→1: "reset" (jump UP vs prev) = 0→5 and 3→8 = 2.
  assert.equal(counter.length, 2, "per-range onChange:reset applied to counter only");
  assert.ok(res.events.some((e) => e.label === "toggle"), "toggle still uses call-wide any");
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

test("groupByPC collapses many events into per-PC rows with hit counts", async () => {
  // Byte changes every frame for 20 frames → 20 raw events. Grouped by PC
  // (all under one PC on the fake host) → a single row with hits:20.
  const host = makeHost({ system_ram: [0] }, (f, mem) => { mem.system_ram[0] = f & 0xFF; });
  setHost("test-session", host);
  const handler = getWatchHandler();
  const res = parseResult(await handler({
    region: "system_ram", offset: 0, length: 1, frames: 20, onChange: "any", groupByPC: true,
  }));
  assert.equal(res.eventCount, 20, "all 20 changes still counted");
  assert.ok(Array.isArray(res.byPC), "byPC summary present");
  assert.equal(res.distinctPCs, res.byPC.length);
  const totalHits = res.byPC.reduce((s, g) => s + g.hits, 0);
  assert.equal(totalHits, 20, "grouped hits sum to the event count");
  // Each group carries frame span + the offsets it touched.
  assert.ok(res.byPC[0].firstFrame <= res.byPC[0].lastFrame);
  assert.ok(Array.isArray(res.byPC[0].offsets));
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

// Regression for the real v0.1.15 bug: pressDuring called host.pressButton
// (which LibretroHost doesn't have) inside a swallow-all try/catch, so input
// was a silent no-op (eventCount:0, indistinguishable from "byte didn't move").
// Now it drives host.setInput and reports what landed.
test("pressDuring actually delivers input via setInput and reports it", async () => {
  // The watched byte only changes on a frame where `start` is held — proving
  // the press reached the (fake) ROM rather than being dropped.
  const host = makeHost({ system_ram: [0] }, (f, mem, h) => {
    const last = h.inputLog[h.inputLog.length - 1];
    const startHeld = last?.input?.ports?.[0]?.start === true;
    if (startHeld) mem.system_ram[0] = 0xAA;
  });
  setHost("test-session", host);
  const handler = getWatchHandler();
  const res = parseResult(await handler({
    region: "system_ram", offset: 0, length: 1, frames: 30, onChange: "any",
    pressDuring: [{ frame: 10, button: "start", holdFrames: 5 }],
  }));
  assert.equal(res.pressesScheduled, 1, "scheduled press reported");
  assert.equal(res.pressesApplied, 1, "press actually applied (was 0 in the bug)");
  assert.ok(res.eventCount >= 1, "the held button drove a byte change");
  // The host saw start=true set on at least one frame.
  const sawStart = host.inputLog.some((e) => e.input?.ports?.[0]?.start === true);
  assert.ok(sawStart, "host.setInput received start=true");
  // And it was released afterward (input cleared once the hold window passed).
  const lastInput = host.inputLog[host.inputLog.length - 1];
  assert.equal(lastInput.input.ports[0].start, undefined, "button released after hold");
});

test("pressDuring honors platform button aliases (Genesis c -> y)", async () => {
  const host = makeHost({ system_ram: [0] }, () => {});
  host.status.platform = "genesis";
  setHost("test-session", host);
  const handler = getWatchHandler();
  await handler({
    region: "system_ram", offset: 0, length: 1, frames: 5, onChange: "any",
    pressDuring: [{ frame: 1, button: "c", holdFrames: 2 }],
  });
  const sawY = host.inputLog.some((e) => e.input?.ports?.[0]?.y === true);
  assert.ok(sawY, "Genesis 'c' resolved to libretro 'y' before setInput");
});

// v15-feedback (more): compact value-vs-frame timeline for a per-frame ramp.
test("format:'series' returns a compact value-vs-frame curve per offset", async () => {
  // A monotonic ramp: byte = frame, changing every single frame.
  const host = makeHost({ system_ram: [0] }, (f, mem) => { mem.system_ram[0] = f & 0xFF; });
  setHost("test-session", host);
  const handler = getWatchHandler();
  const res = parseResult(await handler({
    region: "system_ram", offset: 0, length: 1, frames: 20, onChange: "any",
    format: "series",
  }));
  assert.equal(res.format, "series");
  assert.equal(res.series.length, 1, "one series per watched offset");
  const s = res.series[0];
  assert.equal(s.offsetHex, "0x0000");
  assert.equal(s.frames.length, 20, "every frame's change captured");
  assert.equal(s.values.length, s.frames.length, "parallel arrays");
  // The series is the actual trajectory: values track the frame numbers.
  assert.deepEqual(s.values.slice(0, 3), [1, 2, 3]);
  // No per-row pc/label boilerplate — it's columnar.
  assert.equal(s.pc, undefined);
});

test("format:'series' downsamples to maxEvents (keeps first+last, spans window)", async () => {
  const host = makeHost({ system_ram: [0] }, (f, mem) => { mem.system_ram[0] = f & 0xFF; });
  setHost("test-session", host);
  const handler = getWatchHandler();
  const res = parseResult(await handler({
    region: "system_ram", offset: 0, length: 1, frames: 100, onChange: "any",
    format: "series", maxEvents: 10,
  }));
  const s = res.series[0];
  assert.equal(s.points, 10, "downsampled to maxEvents");
  assert.equal(s.downsampledFrom, 100, "reports the original count");
  assert.equal(s.frames[0], 1, "first point kept");
  assert.equal(s.frames[s.frames.length - 1], 100, "last point kept — series spans the whole window");
  assert.ok(res.seriesNote, "downsample is surfaced, not silent");
});

test("sampleEvery keeps every Nth change", async () => {
  const host = makeHost({ system_ram: [0] }, (f, mem) => { mem.system_ram[0] = f & 0xFF; });
  setHost("test-session", host);
  const handler = getWatchHandler();
  const res = parseResult(await handler({
    region: "system_ram", offset: 0, length: 1, frames: 20, onChange: "any",
    format: "series", sampleEvery: 4,
  }));
  const s = res.series[0];
  assert.equal(res.sampleEvery, 4);
  // 20 changes, keep every 4th (indices 0,4,8,12,16) → 5 points.
  assert.equal(s.points, 5);
  assert.deepEqual(s.frames, [1, 5, 9, 13, 17]);
});
