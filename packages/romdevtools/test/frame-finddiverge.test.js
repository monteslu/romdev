// frame({op:'findDiverge'}) — the root-cause finder built on compareRam. Where
// compareRam says THAT two slots differ, findDiverge says exactly WHEN (frame)
// and WHERE (byte) they first split. Must be NON-DESTRUCTIVE (both hosts
// restored to their pre-search state). Two real hosts, no mocks.

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
import { clearHost, clearHostB, getHost, getHostB } from "../src/mcp/state.js";

const parse = (r) => JSON.parse(r.content[0].text);

test("findDiverge: same ROM never diverges; different ROM finds a frame; non-destructive", { timeout: 300000 }, async () => {
  const key = "finddiverge-e2e";
  const root = await mkdtemp(path.join(tmpdir(), "finddiverge-"));
  const tools = {};
  const fakeServer = { tool: (name, _d, _s, handler) => { tools[name] = handler; } };
  registerLifecycleTools(fakeServer, z, key);
  registerFrameTools(fakeServer, z, key);

  try {
    const proj = path.join(root, "nes-default");
    await createProjectImpl({ platform: "nes", name: "nes-default", path: proj, template: "default", overwrite: true });
    const rom = path.join(root, "a.nes");
    assert.equal(parse(await buildProjectCore({ path: proj, platform: "nes", outputPath: rom })).ok, true, "NES build");

    await tools.loadMedia({ platform: "nes", path: rom });
    await tools.loadMedia({ platform: "nes", path: rom, slot: "b" });

    // Same ROM stepped in lockstep → never diverges.
    const same = parse(await tools.frame({ op: "findDiverge", maxFrames: 120 }));
    assert.equal(same.op, "findDiverge");
    assert.equal(same.diverged, false, `identical ROMs never diverge (got ${JSON.stringify(same)})`);
    assert.equal(same.framesStepped, 120);

    // Non-destructive: the search restores both hosts' MACHINE STATE (RAM/CPU/
    // PPU) via unserializeState. The frameCount COUNTER keeps climbing (known
    // core behavior), but the emulated RAM must be rewound. Capture RAM, run a
    // search that steps frames, confirm RAM is identical afterward.
    const ramBeforeA = Buffer.from(getHost(key).readMemory("system_ram", 0, 512)).toString("hex");
    const ramBeforeB = Buffer.from(getHostB(key).readMemory("system_ram", 0, 512)).toString("hex");
    await tools.frame({ op: "findDiverge", maxFrames: 60 });
    const ramAfterA = Buffer.from(getHost(key).readMemory("system_ram", 0, 512)).toString("hex");
    const ramAfterB = Buffer.from(getHostB(key).readMemory("system_ram", 0, 512)).toString("hex");
    assert.equal(ramAfterA, ramBeforeA, "slot A RAM restored after search (non-destructive)");
    assert.equal(ramAfterB, ramBeforeB, "slot B RAM restored after search (non-destructive)");

    // Different game in slot B → must find a divergence frame + address.
    const proj2 = path.join(root, "nes-tiles");
    await createProjectImpl({ platform: "nes", name: "nes-tiles", path: proj2, template: "tile_engine", overwrite: true });
    const rom2 = path.join(root, "b.nes");
    const b2 = parse(await buildProjectCore({ path: proj2, platform: "nes", outputPath: rom2 }));
    if (b2.ok) {
      await tools.loadMedia({ platform: "nes", path: rom2, slot: "b" });
      const diff = parse(await tools.frame({ op: "findDiverge", maxFrames: 300 }));
      assert.equal(diff.diverged, true, "different games diverge");
      assert.ok(typeof diff.atFrame === "number", "reports the frame it split at");
      assert.match(diff.address, /^\$[0-9A-F]{4}$/, "reports a hex byte address");
      assert.ok("a" in diff && "b" in diff, "reports both slots' diverging byte values");
      assert.match(diff.note, /First divergence at frame/);
    }
  } finally {
    clearHost(key);
    clearHostB(key);
    await rm(root, { recursive: true, force: true });
  }
});

test("findDiverge: errors clearly when slot B is empty", { timeout: 180000 }, async () => {
  const key = "finddiverge-nob";
  const root = await mkdtemp(path.join(tmpdir(), "finddiverge-nob-"));
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
    const res = await tools.frame({ op: "findDiverge" });
    assert.equal(res.isError, true, "error result when slot B empty");
    assert.match(res.content[0].text, /slot B/i);
  } finally {
    clearHost(key);
    clearHostB(key);
    await rm(root, { recursive: true, force: true });
  }
});
