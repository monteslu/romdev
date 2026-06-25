// breakpoint settleFrames (v0.41.0 feedback 213831 #1): a back-to-back driven run
// can inherit the PRIOR run's held-button shadow on frame 0 (the game latches the
// pad into its own RAM each frame), false-positiving a negative control. settleFrames
// releases the pad to neutral and steps N frames BEFORE the run so it starts clean.
// Deterministic assertions: settleFrames advances the frame count by its amount when
// pressDuring is given, and is a no-op without pressDuring.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { registerWatchMemoryTools } from "../src/mcp/tools/watch-memory.js";
import { resetHost, clearHost } from "../src/mcp/state.js";
import { resolveCore } from "../src/cores/registry.js";

function tool(key) {
  const map = {};
  registerWatchMemoryTools({ tool: (n, _d, _s, h) => { map[n] = h; } }, z, key);
  return map.breakpoint;
}

async function loadNes(key) {
  let romPath = null;
  for (const c of [process.env.HOME + "/code/cliemu/space_invaders_nes/space_invaders_nes.nes"]) {
    try { await readFile(c); romPath = c; break; } catch { /* next */ }
  }
  if (!romPath) return null;
  const host = resetHost(key);
  const core = resolveCore("nes");
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "nes", bytes: new Uint8Array(await readFile(romPath)), virtualName: "/rom.nes" });
  host.stepFrames(120);
  return host;
}

test("settleFrames steps N neutral frames before a pressDuring run", { timeout: 60000 }, async () => {
  const key = "bp-settle";
  const host = await loadNes(key);
  if (!host) { console.log("no NES fixture; skipping"); return; }
  if (!host.pcBreakSupported()) { clearHost(key); return; }
  try {
    const bp = tool(key);
    const before = host.status.frameCount;
    // address $0000 is unlikely to be a PC, so the run goes the full maxFrames.
    await bp({ on: "pc", address: 0x0000, maxFrames: 20, pressDuring: [{ frame: 0, button: "right", holdFrames: 15 }], settleFrames: 12 });
    const advanced = host.status.frameCount - before;
    assert.ok(advanced >= 12 + 20, `settle(12) + run(20) advanced the frame count: got ${advanced}`);
  } finally {
    clearHost(key);
  }
});

test("settleFrames is a NO-OP without pressDuring (inherits the pad, doesn't pre-step)", { timeout: 60000 }, async () => {
  const key = "bp-settle-noop";
  const host = await loadNes(key);
  if (!host) { console.log("no NES fixture; skipping"); return; }
  if (!host.pcBreakSupported()) { clearHost(key); return; }
  try {
    const bp = tool(key);
    const before = host.status.frameCount;
    // no pressDuring → settleFrames must not add settle steps (only the run's frames).
    await bp({ on: "pc", address: 0x0000, maxFrames: 10, settleFrames: 30 });
    const advanced = host.status.frameCount - before;
    assert.ok(advanced <= 10, `no pressDuring → no settle pre-step: advanced ${advanced} (≤ maxFrames 10)`);
  } finally {
    clearHost(key);
  }
});
