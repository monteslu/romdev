// watch({on:'range'}) dedupe + distinctPCsOnly (v0.41.0 feedback 133737 N1): a
// range watch over a churny ZP window floods with per-frame writes — ~95% wasted
// tokens for a "which PCs write here?" query. dedupe collapses identical
// (pc,address,value) rows to one with `occurrences`; distinctPCsOnly returns just
// the per-PC digest and suppresses the raw event list.

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
  return map.watch;
}
const parse = (r) => JSON.parse(r.content.find((c) => c.type === "text").text);

test("on:'range' dedupe collapses churn; distinctPCsOnly returns only the digest", { timeout: 60000 }, async () => {
  const key = "range-digest";
  let romPath = null;
  for (const c of [process.env.HOME + "/code/cliemu/space_invaders_nes/space_invaders_nes.nes"]) {
    try { await readFile(c); romPath = c; break; } catch { /* next */ }
  }
  if (!romPath) { console.log("no NES fixture; skipping"); return; }

  const watch = tool(key);
  const host = resetHost(key);
  const core = resolveCore("nes");
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "nes", bytes: new Uint8Array(await readFile(romPath)), virtualName: "/rom.nes" });
  host.stepFrames(200);
  if (!host.rangeWatchSupported()) { clearHost(key); return; }
  try {
    // default — a flood (many events, capped by limit)
    const def = parse(await watch({ on: "range", start: 0x00, end: 0x40, kind: "write", frames: 120, limit: 400 }));
    assert.ok(def.total > 1000, `the ZP write window genuinely floods: total=${def.total}`);
    assert.ok(Array.isArray(def.events) && def.events.length > 0, "default returns raw events");
    assert.ok(Array.isArray(def.byPC) && def.byPC.length > 0, "default also carries the per-PC digest");

    // dedupe — unique (pc,address,value) rows with occurrences, far fewer than total
    const dd = parse(await watch({ on: "range", start: 0x00, end: 0x40, kind: "write", frames: 120, dedupe: true, limit: 400 }));
    assert.equal(dd.deduped, true);
    assert.ok(dd.events.every((e) => typeof e.occurrences === "number"), "deduped rows carry occurrences");
    assert.ok(dd.events.some((e) => e.occurrences > 1), "at least one row collapsed multiple identical writes");
    // a sane dedupe is sorted by frequency (most-churned first)
    assert.ok(dd.events[0].occurrences >= dd.events[dd.events.length - 1].occurrences, "sorted by occurrences");

    // distinctPCsOnly — digest only, NO raw event list
    const dp = parse(await watch({ on: "range", start: 0x00, end: 0x40, kind: "write", frames: 120, distinctPCsOnly: true }));
    assert.equal("events" in dp, false, "distinctPCsOnly suppresses the raw events array");
    assert.ok(Array.isArray(dp.distinctPCs) && dp.distinctPCs.length > 0, "still returns the distinct PCs");
    assert.ok(dp.byPC.every((g) => typeof g.count === "number" && g.pc && g.sampleAddress), "byPC has pc/count/sample");
  } finally {
    clearHost(key);
  }
});
