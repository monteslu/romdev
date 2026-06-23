// frame({op:'compareRender'}) — the presentation oracle. Compares the DECODED
// rendering state (BG/sprite enable, palette, tilemap, forced-blank) of slot A
// vs slot B — what an agent building/tuning the graphics shim needs. Two real
// hosts; same-platform → line diff, cross-platform → both summaries + verdicts.

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

test("compareRender: same ROM/platform → rendering matches; cross-platform → both summaries + verdicts", { timeout: 300000 }, async () => {
  const key = "comparerender-e2e";
  const root = await mkdtemp(path.join(tmpdir(), "comparerender-"));
  const tools = {};
  const fakeServer = { tool: (name, _d, _s, handler) => { tools[name] = handler; } };
  registerLifecycleTools(fakeServer, z, key);
  registerFrameTools(fakeServer, z, key);

  try {
    // Same NES ROM in both slots → decoded rendering state must match.
    const nesProj = path.join(root, "nes-default");
    await createProjectImpl({ platform: "nes", name: "nes-default", path: nesProj, template: "default", overwrite: true });
    const nesRom = path.join(root, "a.nes");
    assert.equal(parse(await buildProjectCore({ path: nesProj, platform: "nes", outputPath: nesRom })).ok, true, "NES build");

    await tools.loadMedia({ platform: "nes", path: nesRom });
    await tools.loadMedia({ platform: "nes", path: nesRom, slot: "b" });

    const same = parse(await tools.frame({ op: "compareRender", frames: 60 }));
    assert.equal(same.op, "compareRender");
    assert.equal(same.samePlatform, true);
    assert.ok(same.diff, "same-platform gives a line diff");
    assert.deepEqual(same.diff.onlyInOriginal, [], "no rendering aspect the original has that the port lacks");
    assert.deepEqual(same.diff.onlyInPort, [], "and none extra on the port");
    assert.match(same.note, /MATCH/i);
    assert.ok(Array.isArray(same.a.summary) && same.a.summary.length > 0, "decoded summary present");

    // Cross-platform: GB in slot B → both summaries + per-side renderEnabled.
    const gbProj = path.join(root, "gb-default");
    await createProjectImpl({ platform: "gb", name: "gb-default", path: gbProj, template: "default", overwrite: true });
    const gbRom = path.join(root, "b.gb");
    assert.equal(parse(await buildProjectCore({ path: gbProj, platform: "gb", outputPath: gbRom })).ok, true, "GB build");
    await tools.loadMedia({ platform: "gb", path: gbRom, slot: "b" });

    const cross = parse(await tools.frame({ op: "compareRender", frames: 60 }));
    assert.equal(cross.samePlatform, false);
    assert.equal(cross.a.platform, "nes");
    assert.equal(cross.b.platform, "gb");
    assert.ok("renderEnabled" in cross.a && "renderEnabled" in cross.b, "per-side render-enable verdict");
    assert.ok(!cross.diff, "no literal line diff across platforms");
    assert.match(cross.note, /[Cc]ross-platform/);
  } finally {
    clearHost(key);
    clearHostB(key);
    await rm(root, { recursive: true, force: true });
  }
});

test("compareRender: errors clearly when slot B is empty", { timeout: 180000 }, async () => {
  const key = "comparerender-nob";
  const root = await mkdtemp(path.join(tmpdir(), "comparerender-nob-"));
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
    const res = await tools.frame({ op: "compareRender" });
    assert.equal(res.isError, true, "error result when slot B empty");
    assert.match(res.content[0].text, /slot B/i);
  } finally {
    clearHost(key);
    clearHostB(key);
    await rm(root, { recursive: true, force: true });
  }
});
