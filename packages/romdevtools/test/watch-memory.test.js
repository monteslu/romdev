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

// Capture the consolidated `watch` handler out of registerWatchMemoryTools.
// watchMemory is now watch({on:'mem'}); inject `on:'mem'` so these (frozen)
// assertions call it with the same watchMemory-style args.
function getWatchHandler() {
  let handler;
  const fakeServer = {
    tool(name, _desc, _schema, h) {
      if (name === "watch") handler = h;
    },
  };
  registerWatchMemoryTools(fakeServer, z, "test-session");
  return (args) => handler({ on: "mem", ...args });
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

test("pressDuring honors platform button aliases (Genesis c -> a)", async () => {
  // genesis_plus_gx maps Genesis A/B/C onto libretro y/b/a — so the Genesis-native
  // 'c' alias resolves to libretro 'a' (NOT 'y'; 'y' is Genesis A). Verified
  // empirically against the running core 2026-06-05.
  const host = makeHost({ system_ram: [0] }, () => {});
  host.status.platform = "genesis";
  setHost("test-session", host);
  const handler = getWatchHandler();
  await handler({
    region: "system_ram", offset: 0, length: 1, frames: 5, onChange: "any",
    pressDuring: [{ frame: 1, button: "c", holdFrames: 2 }],
  });
  const sawA = host.inputLog.some((e) => e.input?.ports?.[0]?.a === true);
  assert.ok(sawA, "Genesis 'c' resolved to libretro 'a' before setInput");
});

// v0.16.0-feedback (more): the input-inheritance bug. A watch with NO
// pressDuring schedule used to push an empty [{},{}] setInput on frame 0,
// silently neutralizing a pad held via input({op:'set'}). It must now leave
// input ENTIRELY untouched so the held state carries through (like frame:step).
test("watch WITHOUT pressDuring never touches setInput (inherits held input)", async () => {
  // Simulate the user having held Right via input({op:'set'}): the host's input
  // is "already held". The fake host's byte advances every frame regardless;
  // the point is purely that the watch makes ZERO setInput calls.
  const host = makeHost({ system_ram: [0] }, (f, mem) => { mem.system_ram[0] = f & 0xFF; });
  setHost("test-session", host);
  const handler = getWatchHandler();
  const res = parseResult(await handler({
    region: "system_ram", offset: 0, length: 1, frames: 20, onChange: "any",
    // no pressDuring
  }));
  assert.ok(res.eventCount >= 1, "watch still ran and saw changes");
  assert.equal(host.inputLog.length, 0,
    "watch with no pressDuring made ZERO setInput calls — the held pad is inherited, not reset");
});

// And the converse: a pressDuring schedule STILL owns the pad (drives + releases),
// so deterministic capture is unchanged by the inheritance fix.
test("watch WITH pressDuring still drives and releases input", async () => {
  const host = makeHost({ system_ram: [0] }, () => {});
  setHost("test-session", host);
  const handler = getWatchHandler();
  await handler({
    region: "system_ram", offset: 0, length: 1, frames: 10, onChange: "any",
    pressDuring: [{ frame: 2, button: "right", holdFrames: 3 }],
  });
  const sawRight = host.inputLog.some((e) => e.input?.ports?.[0]?.right === true);
  assert.ok(sawRight, "scheduled right press reached setInput");
  const lastInput = host.inputLog[host.inputLog.length - 1];
  assert.equal(lastInput.input.ports[0].right, undefined, "released after the hold window");
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

// ── stepInstructions (bulk single-step) — v0.89.0 field feedback ─────────────
// Jay's ActRaiser session: proving a ~26-instruction routine cost ~26 round
// trips. stepInstructions returns the whole ordered trace in one call, with
// `width` = PC[k+1]-PC[k] (the 65816 immediate-width signal) and the note ONCE.
import { stepInstructionsCore } from "../src/mcp/tools/watch-memory.js";

test("stepInstructions: one call → ordered trace, widths from PC deltas, note once", async () => {
  // Scripted PC walk: 2-byte, 3-byte, 2-byte, then a branch back (non-linear).
  const pcs = [0x8000, 0x8002, 0x8005, 0x8007, 0x8000];
  let i = 0;
  const host = {
    status: { frameCount: 0, platform: "nes" },
    pcBreakSupported: () => true,
    stepInstruction() { return { pc: pcs[Math.min(i++, pcs.length - 1)], hit: true }; },
  };
  _setHostForTest("bulk-session", host);

  const res = await stepInstructionsCore("bulk-session", { count: 4 });
  const p = JSON.parse(res.content.find((c) => c.type === "text").text);
  assert.equal(p.stepped, true);
  assert.equal(p.count, 4, "returns one entry per stepped instruction");
  assert.equal(p.trace[0].pc, "$8000");
  assert.equal(p.trace[0].width, 2, "8002-8000 = 2-byte instruction");
  assert.equal(p.trace[1].width, 3, "8005-8002 = 3-byte (e.g. a 65816 imm16)");
  assert.equal(p.trace[2].width, 2, "8007-8005 = 2-byte");
  assert.equal(p.trace[3].width, undefined, "the branch back has no linear width (PC moved)");
  assert.ok(p.note && p.note.length > 20, "the boilerplate note is emitted ONCE for the trace");
  // note must NOT be duplicated onto every entry
  assert.ok(p.trace.every((t) => t.note === undefined), "no per-entry note repetition");
});

test("stepInstructions: wide (m68k-style) instruction widths are not clamped to 4", async () => {
  // Genesis m68k reaches 10-byte instructions; a 6502-sized cap would drop them.
  const pcs = [0x200, 0x206, 0x210, 0x212]; // widths 6, 10, 2 (need 4 stops → count 4)
  let i = 0;
  const host = {
    status: { frameCount: 0, platform: "genesis" },
    pcBreakSupported: () => true,
    stepInstruction() { return { pc: pcs[Math.min(i++, pcs.length - 1)], hit: true }; },
  };
  _setHostForTest("bulk-m68k", host);
  const res = await stepInstructionsCore("bulk-m68k", { count: 4 });
  const p = JSON.parse(res.content.find((c) => c.type === "text").text);
  assert.equal(p.trace[0].width, 6, "6-byte width kept (not dropped by a 4-byte cap)");
  assert.equal(p.trace[1].width, 10, "10-byte m68k width kept");
  assert.equal(p.trace[2].width, 2, "2-byte width kept");
});

test("stepInstructions: notSupported cores fail cleanly", async () => {
  _setHostForTest("nostep-session", { status: { platform: "nes" }, pcBreakSupported: () => false });
  const res = await stepInstructionsCore("nostep-session", { count: 4 });
  const p = JSON.parse(res.content.find((c) => c.type === "text").text);
  assert.equal(p.stepped, false);
  assert.equal(p.notSupported, true);
});

// ── stepInstructions flow classification (v0.91.1 field report) ──────────────
// `width` was the raw PC delta, so a TAKEN forward branch (2-byte beq to +3)
// looked exactly like a 3-byte instruction. Now `flow` classifies from the
// opcode and `width` is present only on flow:'seq' steps.
test("stepInstructions: flow classification omits width on control transfers", async () => {
  // Scripted PCs + a getCartRom whose bytes at each PC give a known opcode.
  // Two seq (lda #imm 2B, nop 1B) then a taken branch (beq) then its target.
  const pcs = [0x8000, 0x8002, 0x8003, 0x8010];
  const opcodes = { 0x8000: 0xA9 /*lda#*/, 0x8002: 0xEA /*nop*/, 0x8003: 0xF0 /*beq*/, 0x8010: 0xA9 };
  let i = 0;
  const host = {
    status: { frameCount: 0, platform: "nes" },
    pcBreakSupported: () => true,
    stepInstruction() { return { pc: pcs[Math.min(i++, pcs.length - 1)], hit: true }; },
    getCartRom() {
      // a fake ROM where readMemory-by-cpu-addr returns the scripted opcode.
      // mapNesAddress on a flat 32KB NROM: cpuAddr $8000 -> file 0x10 (after
      // header). Build a 32KB PRG with the opcodes at their mapped offsets.
      const raw = new Uint8Array(16 + 0x8000);
      raw.set([0x4e, 0x45, 0x53, 0x1a, 1, 0]); // iNES header, 1 PRG bank
      for (const [pc, op] of Object.entries(opcodes)) raw[16 + (Number(pc) - 0x8000)] = op;
      return { raw, platform: "nes" };
    },
  };
  _setHostForTest("flow-session", host);
  const res = await stepInstructionsCore("flow-session", { count: 4 });
  const p = JSON.parse(res.content.find((c) => c.type === "text").text);
  const [s0, s1, s2] = p.trace;
  assert.equal(s0.flow, "seq", "lda # is sequential");
  assert.equal(s0.width, 2, "lda # is 2 bytes (delta = size on seq)");
  assert.equal(s1.flow, "seq", "nop is sequential");
  assert.equal(s1.width, 1, "nop is 1 byte");
  assert.equal(s2.flow, "branch", "beq is a branch");
  assert.equal(s2.width, undefined, "a TAKEN branch must NOT report a width (the bug)");
  assert.ok(s2.nextPc, "the branch carries nextPc instead of width");
});
