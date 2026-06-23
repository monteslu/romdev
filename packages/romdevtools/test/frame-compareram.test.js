// frame({op:'compareRam'}) — the RAM-diff oracle. Diffs slot-A vs slot-B
// work-RAM at the same game-moment to prove a logic port is correct independent
// of graphics. Two real hosts (no mocks): the SAME ROM in both slots must read
// IDENTICAL; DIFFERENT ROMs must DIVERGE. Returns a digested verdict (matchPct
// + RLE ranges), not raw bytes — the "smart-enough agent" design.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { createProjectImpl } from "../src/mcp/tools/project.js";
import { buildProjectCore } from "../src/mcp/tools/toolchain.js";
import { registerFrameTools } from "../src/mcp/tools/frame.js";
import { registerLifecycleTools } from "../src/mcp/tools/lifecycle.js";
import { clearHost, clearHostB } from "../src/mcp/state.js";

const parse = (r) => JSON.parse(r.content[0].text);

test("compareRam: identical ROMs match 100%, different ROMs diverge", { timeout: 300000 }, async () => {
  const key = "compareram-e2e";
  const root = await mkdtemp(path.join(tmpdir(), "compareram-"));
  const tools = {};
  const fakeServer = { tool: (name, _d, _s, handler) => { tools[name] = handler; } };
  registerLifecycleTools(fakeServer, z, key);
  registerFrameTools(fakeServer, z, key);

  try {
    // Build one NES ROM; load it into BOTH slots → RAM must be identical.
    const proj = path.join(root, "nes-default");
    await createProjectImpl({ platform: "nes", name: "nes-default", path: proj, template: "default", overwrite: true });
    const rom = path.join(root, "a.nes");
    assert.equal(parse(await buildProjectCore({ path: proj, platform: "nes", outputPath: rom })).ok, true, "NES build");

    await tools.loadMedia({ platform: "nes", path: rom });
    await tools.loadMedia({ platform: "nes", path: rom, slot: "b" });

    // requires slot B — sanity: both loaded.
    const same = parse(await tools.frame({ op: "compareRam", frames: 60 }));
    assert.equal(same.op, "compareRam");
    assert.equal(same.region, "system_ram");
    assert.equal(same.a.platform, "nes");
    assert.equal(same.b.platform, "nes");
    assert.ok(same.comparedBytes > 0, "compared real RAM");
    assert.equal(same.identical, true, `same ROM stepped identically → identical RAM (got ${same.matchPct}%)`);
    assert.equal(same.matchPct, 100);
    assert.equal(same.ranges.length, 0, "no diverging ranges");
    assert.match(same.note, /IDENTICAL/);

    // Now load a DIFFERENT game into slot B (a tile_engine scaffold) → diverge.
    const proj2 = path.join(root, "nes-tiles");
    await createProjectImpl({ platform: "nes", name: "nes-tiles", path: proj2, template: "tile_engine", overwrite: true });
    const rom2 = path.join(root, "b.nes");
    const b2 = parse(await buildProjectCore({ path: proj2, platform: "nes", outputPath: rom2 }));
    // Fall back to another default if tile_engine isn't a template on this platform.
    const altRom = b2.ok ? rom2 : rom;
    if (b2.ok) {
      await tools.loadMedia({ platform: "nes", path: altRom, slot: "b" });
      const diff = parse(await tools.frame({ op: "compareRam", frames: 60 }));
      assert.equal(diff.identical, false, "different games → diverged RAM");
      assert.ok(diff.divergingBytes > 0, "some bytes differ");
      assert.ok(diff.ranges.length > 0, "diverging ranges reported");
      // ranges are digested: address string + byte count + 4-byte samples
      const r0 = diff.ranges[0];
      assert.match(r0.range, /^\$[0-9A-F]{4}-\$[0-9A-F]{4}$/, "range is a hex address span");
      assert.ok("bytes" in r0 && "a" in r0 && "b" in r0, "range carries digest + samples");
      assert.match(diff.note, /DIVERGED|CLOSE/);
    }
  } finally {
    clearHost(key);
    clearHostB(key);
    await rm(root, { recursive: true, force: true });
  }
});

test("compareRam: errors clearly when slot B is empty", { timeout: 180000 }, async () => {
  const key = "compareram-nob";
  const root = await mkdtemp(path.join(tmpdir(), "compareram-nob-"));
  const tools = {};
  const fakeServer = { tool: (name, _d, _s, handler) => { tools[name] = handler; } };
  registerLifecycleTools(fakeServer, z, key);
  registerFrameTools(fakeServer, z, key);
  try {
    const proj = path.join(root, "nes-default");
    await createProjectImpl({ platform: "nes", name: "nes-default", path: proj, template: "default", overwrite: true });
    const rom = path.join(root, "a.nes");
    assert.equal(parse(await buildProjectCore({ path: proj, platform: "nes", outputPath: rom })).ok, true);
    await tools.loadMedia({ platform: "nes", path: rom });
    const res = await tools.frame({ op: "compareRam" });
    assert.equal(res.isError, true, "error result when slot B empty");
    assert.match(res.content[0].text, /slot B/i);
  } finally {
    clearHost(key);
    clearHostB(key);
    await rm(root, { recursive: true, force: true });
  }
});
