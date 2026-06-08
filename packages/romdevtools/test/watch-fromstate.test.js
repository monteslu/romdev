// watch({on:'range'/'pc', fromState|fromStatePath}) — replay a savestate BEFORE
// tracing so the log runs from a known, repeatable moment. Tests the restore
// (in-memory slot + disk file), the determinism (same state → same trace), and
// the both-given guard. Driven through the registered MCP tool via an in-process
// server so the closure (wRange/maybeRestoreState) is exercised as shipped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveCore } from "../src/cores/registry.js";
import { resetHost, clearHost } from "../src/mcp/state.js";
import { prgToD64 } from "../src/platforms/c64/d64.js";
import { C64_HOMEBREW_PRG } from "./rom-fixtures.js";

const PRG = C64_HOMEBREW_PRG;
const have = !!PRG;

// Build a tiny in-process MCP-ish server that just records registered tools, so
// we can call the real `watch` handler (incl. fromState) without HTTP.
async function makeWatchHandler(key) {
  const { registerWatchMemoryTools } = await import("../src/mcp/tools/watch-memory.js");
  const tools = {};
  const fakeServer = { tool: (name, _desc, _schema, handler) => { tools[name] = handler; } };
  // minimal zod stand-in is not needed — registerWatchMemoryTools imports its own z? check:
  const { z } = await import("zod");
  registerWatchMemoryTools(fakeServer, z, key);
  return tools.watch;
}

const parse = (r) => JSON.parse(r.content[0].text);

test("watch fromState: in-memory slot restore reruns the trace from that moment", { skip: !have, timeout: 120000 }, async () => {
  const key = "watch-fromstate-slot";
  try {
    const core = resolveCore("c64");
    const host = resetHost(key);
    await host.loadCore(core.jsPath, core.wasmPath);
    const { readFileSync } = await import("node:fs");
    const prg = new Uint8Array(readFileSync(PRG));
    await host.loadMedia({ platform: "c64", bytes: prgToD64(prg, { name: "X" }), virtualName: "/g.d64" });
    for (let i = 0; i < 400; i++) host.stepFrames(1);
    host.saveState("chk");
    const atSave = host.status.frameCount;

    // advance PAST the save so we can prove fromState rewinds
    for (let i = 0; i < 300; i++) host.stepFrames(1);
    assert.ok(host.status.frameCount > atSave);

    const watch = await makeWatchHandler(key);
    const r = parse(await watch({ on: "range", start: 0x0000, end: 0x00ff, frames: 30, fromState: "chk" }));
    assert.deepEqual(r.restoredFrom, { slot: "chk" }, "should echo restoredFrom slot");
    assert.ok(Array.isArray(r.distinctPCs), "range trace ran after restore");
    // NOTE: host.status.frameCount is romdev's MONOTONIC bookkeeping counter and
    // is intentionally NOT rewound by a savestate restore (documented in state).
    // The emulator's actual state IS rewound — proven by the determinism test
    // (same slot → identical PC set). So here we just confirm the restore + trace
    // happened, not the monotonic counter.
    assert.ok(r.total >= 0 && r.range, "range result well-formed after restore");
  } finally {
    clearHost(key);
  }
});

test("watch fromState: determinism — same state slot gives the same distinctPCs", { skip: !have, timeout: 120000 }, async () => {
  const key = "watch-fromstate-det";
  try {
    const core = resolveCore("c64");
    const host = resetHost(key);
    await host.loadCore(core.jsPath, core.wasmPath);
    const { readFileSync } = await import("node:fs");
    const prg = new Uint8Array(readFileSync(PRG));
    await host.loadMedia({ platform: "c64", bytes: prgToD64(prg, { name: "X" }), virtualName: "/g.d64" });
    for (let i = 0; i < 300; i++) host.stepFrames(1);
    host.saveState("chk");
    const watch = await makeWatchHandler(key);
    const a = parse(await watch({ on: "range", start: 0x0000, end: 0x01ff, frames: 20, fromState: "chk" }));
    const b = parse(await watch({ on: "range", start: 0x0000, end: 0x01ff, frames: 20, fromState: "chk" }));
    assert.deepEqual(a.distinctPCs, b.distinctPCs, "same restored state + same window → identical PC set");
  } finally {
    clearHost(key);
  }
});

test("watch fromStatePath: restore from a savestate FILE", { skip: !have, timeout: 120000 }, async () => {
  const key = "watch-fromstate-file";
  const dir = await mkdtemp(path.join(tmpdir(), "wfs-"));
  try {
    const core = resolveCore("c64");
    const host = resetHost(key);
    await host.loadCore(core.jsPath, core.wasmPath);
    const { readFileSync, writeFileSync } = await import("node:fs");
    const prg = new Uint8Array(readFileSync(PRG));
    await host.loadMedia({ platform: "c64", bytes: prgToD64(prg, { name: "X" }), virtualName: "/g.d64" });
    for (let i = 0; i < 300; i++) host.stepFrames(1);
    const statePath = path.join(dir, "snap.state");
    writeFileSync(statePath, Buffer.from(host.serializeState()));

    const watch = await makeWatchHandler(key);
    const r = parse(await watch({ on: "pc", start: 0x0000, end: 0xffff, frames: 10, fromStatePath: statePath }));
    assert.equal(r.restoredFrom.path, statePath, "should echo restoredFrom path");
    assert.ok(Array.isArray(r.pcs) && r.pcs.length > 0, "pc trace ran after file restore");
  } finally {
    clearHost(key);
    await rm(dir, { recursive: true, force: true });
  }
});

test("watch fromState + fromStatePath together is rejected", { skip: !have, timeout: 120000 }, async () => {
  const key = "watch-fromstate-both";
  try {
    const core = resolveCore("c64");
    const host = resetHost(key);
    await host.loadCore(core.jsPath, core.wasmPath);
    const { readFileSync } = await import("node:fs");
    const prg = new Uint8Array(readFileSync(PRG));
    await host.loadMedia({ platform: "c64", bytes: prgToD64(prg, { name: "X" }), virtualName: "/g.d64" });
    for (let i = 0; i < 60; i++) host.stepFrames(1);
    host.saveState("chk");
    const watch = await makeWatchHandler(key);
    // safeTool wraps errors into a result; assert the error surfaces
    const r = await watch({ on: "range", start: 0, end: 0xff, frames: 5, fromState: "chk", fromStatePath: "/tmp/x.state" });
    const text = r.content[0].text;
    assert.match(text, /not both/i, `expected a 'not both' error, got: ${text}`);
  } finally {
    clearHost(key);
  }
});
