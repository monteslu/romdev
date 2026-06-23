// frame({op:'portStatus'}) — the capstone. ONE call fusing logic (RAM),
// presentation (render state), and pixels into a single 'state of your port'
// verdict + next action. Two real hosts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { createProjectImpl } from "../src/mcp/tools/project.js";
import { buildProjectCore } from "../src/mcp/tools/toolchain.js";
import { registerFrameTools } from "../src/mcp/tools/frame.js";
import { registerLifecycleTools } from "../src/mcp/tools/lifecycle.js";
import { clearHost, clearHostB } from "../src/mcp/state.js";

const parse = (r) => JSON.parse(r.content[0].text);

test("portStatus: identical same-platform ROM → logic matches; cross-platform → cross verdict", { timeout: 300000 }, async () => {
  const key = "portstatus-e2e";
  const root = await mkdtemp(path.join(tmpdir(), "portstatus-"));
  const tools = {};
  const fakeServer = { tool: (name, _d, _s, handler) => { tools[name] = handler; } };
  registerLifecycleTools(fakeServer, z, key);
  registerFrameTools(fakeServer, z, key);

  try {
    const nesProj = path.join(root, "nes-default");
    await createProjectImpl({ platform: "nes", name: "nes-default", path: nesProj, template: "default", overwrite: true });
    const nesRom = path.join(root, "a.nes");
    assert.equal(parse(await buildProjectCore({ path: nesProj, platform: "nes", outputPath: nesRom })).ok, true, "NES build");

    await tools.loadMedia({ platform: "nes", path: nesRom });
    await tools.loadMedia({ platform: "nes", path: nesRom, slot: "b" });

    // Same ROM both slots → logic identical. The NES default scaffold renders a
    // real screen, so the verdict should be the "looks complete" branch.
    const same = parse(await tools.frame({ op: "portStatus", frames: 60 }));
    assert.equal(same.op, "portStatus");
    assert.equal(same.samePlatform, true);
    assert.ok(same.logic, "logic verdict present for same-platform");
    assert.equal(same.logic.identical, true, "same ROM → identical RAM");
    assert.equal(same.logic.matchPct, 100);
    assert.ok(typeof same.verdict === "string" && same.verdict.length > 0, "has a verdict");
    assert.ok(typeof same.nextAction === "string" && same.nextAction.length > 0, "has a next action");
    assert.ok("renderEnabled" in same.a && "pixelsAlive" in same.a, "per-side render + pixel signals");

    // Cross-platform: GB in slot B → cross-platform verdict, no logic byte-compare.
    const gbProj = path.join(root, "gb-default");
    await createProjectImpl({ platform: "gb", name: "gb-default", path: gbProj, template: "default", overwrite: true });
    const gbRom = path.join(root, "b.gb");
    assert.equal(parse(await buildProjectCore({ path: gbProj, platform: "gb", outputPath: gbRom })).ok, true, "GB build");
    await tools.loadMedia({ platform: "gb", path: gbRom, slot: "b" });

    const cross = parse(await tools.frame({ op: "portStatus", frames: 60 }));
    assert.equal(cross.samePlatform, false);
    assert.ok(!cross.logic, "no RAM byte-compare across platforms");
    assert.match(cross.verdict, /CROSS-PLATFORM/);
    assert.equal(cross.a.platform, "nes");
    assert.equal(cross.b.platform, "gb");
  } finally {
    clearHost(key);
    clearHostB(key);
    await rm(root, { recursive: true, force: true });
  }
});

test("portStatus: errors clearly when slot B is empty", { timeout: 180000 }, async () => {
  const key = "portstatus-nob";
  const root = await mkdtemp(path.join(tmpdir(), "portstatus-nob-"));
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
    const res = await tools.frame({ op: "portStatus" });
    assert.equal(res.isError, true, "error result when slot B empty");
    assert.match(res.content[0].text, /slot B/i);
  } finally {
    clearHost(key);
    clearHostB(key);
    await rm(root, { recursive: true, force: true });
  }
});
