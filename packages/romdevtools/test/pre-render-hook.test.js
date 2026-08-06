// The ABI-2 pre_render chain: beforeFrame at the host's per-frame choke
// point, one-frame input overrides applied where the CORE polls, and the
// end-to-end path through loadMedia -> Lua-runtime bezel -> live RAM.
//
// Three tiers, cheapest proof first:
//   1. effectiveJoypadMask semantics (pure — no core).
//   2. LibretroHost contract on the REAL fceumm core: beforeFrame fires once
//      per frame with the same number the bezel tick will observe, overrides
//      clear at the top of every frame, the physical mask is never touched,
//      and a game-visible behavior check with a control that must fail:
//      nestest leaves its menu when Start is held — unless a beforeFrame
//      override masks Start away, in which case the menu must NOT change.
//   3. MCP end-to-end: a Lua-script bezel whose pre_render writes RAM and
//      swaps left/right; the write must be visible through memory({op:'read'})
//      and the per-frame call count through catalog status.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { LibretroHost } from "romdev-core-host";
import { effectiveJoypadMask } from "romdev-core-host/callbacks.js";
import { resolveCore } from "../src/cores/registry.js";
import { registerTools } from "../src/mcp/tools/index.js";
import { requireTestRom } from "./helpers/test-rom.js";

const TEST_ROM = requireTestRom(import.meta.url);

/* The Lua interpreter runtime doubles as a zero-toolchain test guest: a
 * script IS the fixture, so nothing binary is committed here and the test
 * always runs against the CURRENT active-bezel dependency. */
const LUA_RUNTIME_WASM = (() => {
  try {
    const entry = createRequire(import.meta.url).resolve("active-bezel");
    const candidate = path.join(path.dirname(entry), "runtimes", "lua", "main.wasm");
    return existsSync(candidate) ? candidate : null;
  } catch { return null; }
})();

test("effectiveJoypadMask: full replaces, set/clear edit on top of live state", () => {
  const state = { inputPorts: [new Uint16Array([0b1000_0000])], inputOverrides: [null] };
  assert.equal(effectiveJoypadMask(state, 0), 0b1000_0000, "no override = physical");
  assert.equal(effectiveJoypadMask(state, 1), 0, "unknown port reads 0");

  state.inputOverrides[0] = { full: null, set: 1 << 6, clear: 1 << 7 };
  assert.equal(effectiveJoypadMask(state, 0), 1 << 6, "right cleared, left set (the swap)");
  // The per-bit form must track LIVE physical changes on untouched bits.
  state.inputPorts[0][0] = (1 << 7) | (1 << 3);
  assert.equal(effectiveJoypadMask(state, 0), (1 << 6) | (1 << 3), "start passes through live");

  state.inputOverrides[0] = { full: 0b0000_0100, set: 0, clear: 0 };
  assert.equal(effectiveJoypadMask(state, 0), 0b0000_0100, "full mask replaces everything");
  assert.equal(state.inputPorts[0][0], (1 << 7) | (1 << 3), "physical is NEVER touched");
});

test("setInputOverride semantics + per-frame clearing on the real core", { skip: TEST_ROM.skip, timeout: 120000 }, async () => {
  const host = new LibretroHost();
  const core = resolveCore("nes");
  await host.loadCore(core.jsPath, core.wasmPath);
  host.loadMedia({ platform: "nes", bytes: new Uint8Array(await readFile(TEST_ROM.path)), virtualName: "/rom.nes" });
  try {
    // joypad-only, valid ports/ids only
    assert.equal(host.setInputOverride(0, 5, 0, 0, 1), false, "analog override is a follow-up, refused");
    assert.equal(host.setInputOverride(7, 1, 0, 0, 1), false, "bogus port refused");
    assert.equal(host.setInputOverride(0, 1, 0, 99, 1), false, "bogus id refused");

    const seen = [];
    host.beforeFrame = (n) => {
      // Overrides from the previous frame must ALREADY be gone here.
      assert.equal(host.state.inputOverrides[0], null, `frame ${n}: stale override survived the clear`);
      seen.push(n);
      assert.equal(host.setInputOverride(0, 1, 0, 256, 0x40), true);
    };
    const base = host.status.frameCount;
    host.stepFrames(3);
    // frameCount+1 so pre_render(N) names the same frame the post-step bezel
    // tick observes (tick reads frameCount AFTER the increment).
    assert.deepEqual(seen, [base + 1, base + 2, base + 3], "once per frame, tick-aligned numbering");
    assert.deepEqual(host.state.inputOverrides[0], { full: 0x40, set: 0, clear: 0 },
      "the LAST frame's override is still staged (cleared at the top of the NEXT frame)");
    host.beforeFrame = null;
    host.stepFrames(1);
    assert.equal(host.state.inputOverrides[0], null, "cleared even with no hook installed");
    assert.equal(host.beforeFrameError, undefined, "no hook error recorded");
  } finally {
    host.shutdown?.();
  }
});

test("the CORE sees the override: masking Start keeps nestest on its menu", { skip: TEST_ROM.skip, timeout: 120000 }, async () => {
  // Control first, and it MUST fail-to-match: holding Start unmasked has to
  // change the screen (nestest starts its tests), or "the mask held the menu"
  // would be indistinguishable from "input is broken entirely".
  const menuHash = (host) => {
    const { rgba } = host.screenshotRgba();
    let h = 0n;
    for (let i = 0; i < rgba.length; i += 7) h = (h * 131n + BigInt(rgba[i])) & 0xffffffffffffn;
    return h;
  };
  const boot = async () => {
    const host = new LibretroHost();
    const core = resolveCore("nes");
    await host.loadCore(core.jsPath, core.wasmPath);
    host.loadMedia({ platform: "nes", bytes: new Uint8Array(await readFile(TEST_ROM.path)), virtualName: "/rom.nes" });
    host.stepFrames(60); // menu settled
    return host;
  };

  const control = await boot();
  const menuBefore = menuHash(control);
  control.setInput({ ports: [{ start: true }, {}] });
  control.stepFrames(30);
  const controlAfter = menuHash(control);
  control.shutdown?.();
  assert.notEqual(controlAfter, menuBefore,
    "CONTROL failed: Start did not change the screen, so the masking assertion below would be vacuous");

  const masked = await boot();
  const maskedMenu = menuHash(masked);
  masked.beforeFrame = () => { masked.setInputOverride(0, 1, 0, 3, 0); }; // clear START (id 3)
  masked.setInput({ ports: [{ start: true }, {}] });
  masked.stepFrames(30);
  const maskedAfter = menuHash(masked);
  assert.equal(masked.state.inputPorts[0][0] & (1 << 3), 1 << 3,
    "physical Start is STILL held — only the core's view was masked");
  masked.shutdown?.();
  assert.equal(maskedAfter, maskedMenu,
    "with Start masked in beforeFrame, the game must never see it — the menu must not change");
});

async function mcpSession(key) {
  const server = new McpServer({ name: key, version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z, key);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: key + "-c", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.find?.((c) => c.type === "text")?.text;
    if (r.isError) return { _error: text };
    try { return JSON.parse(text); } catch { return text; }
  };
}

/* A Lua bezel whose pre_render (a) swaps left/right on port 0 and (b) stamps
 * the frame number into RAM $06F0 — an address nestest never touches, so the
 * value read back through memory({op:'read'}) is exactly what pre_render
 * wrote for the LAST frame. */
const SWAP_BEZEL_LUA = `
local ram
function init() ram = ab.region('system_ram') end
function pre_render(frame)
  ab.write_u8(ram, 0x6F0, frame % 256)
  local mask = ab.input(0, ab.DEVICE.JOYPAD, 0, ab.BTN.MASK)
  local left = (mask >> ab.BTN.LEFT) % 2
  local right = (mask >> ab.BTN.RIGHT) % 2
  ab.input_override(0, ab.DEVICE.JOYPAD, 0, ab.BTN.LEFT, right)
  ab.input_override(0, ab.DEVICE.JOYPAD, 0, ab.BTN.RIGHT, left)
end
function tick(frame)
  ab.clear(ab.rgb(10, 10, 20))
  ab.draw_game_fit(ab.FIT.CONTAIN, 0.5, 0.5, ab.SAMPLE.NEAREST)
end
`;

test("end-to-end: a Lua bezel's pre_render runs per frame and its RAM writes land", { skip: TEST_ROM.skip || (LUA_RUNTIME_WASM ? false : "active-bezel lua runtime not found"), timeout: 120000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ab-prerender-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(LUA_RUNTIME_WASM, path.join(dir, "main.wasm"));
  await writeFile(path.join(dir, "main.lua"), SWAP_BEZEL_LUA);
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({
    format: "active-bezel",
    formatVersion: 1,
    id: "local.romdev.pre-render-test",
    name: "pre_render test bezel",
    version: "0.1.0",
    author: "romdev tests",
    description: "swaps left/right and stamps the frame number into RAM",
    license: "MIT",
    entry: "main.wasm",
    runtime: { abi: "active-bezel-1", renderer: "cpu-rgba-v1", internalResolution: [320, 180], extensions: [] },
    games: [],
    compatible: [],
    settings: [],
  }));

  const call = await mcpSession("ab-prerender");
  const load = await call("loadMedia", {
    platform: "nes", path: TEST_ROM.path, activeBezelPath: dir, activeBezelForce: true,
  });
  assert.equal(load.loaded, true, "load failed: " + JSON.stringify(load).slice(0, 400));
  assert.equal(load.activeBezel?.preRender?.defined, true,
    "loadMedia must advertise that this bezel shapes the game: " + JSON.stringify(load.activeBezel).slice(0, 400));

  const before = (await call("catalog", { op: "status" })).activeBezel.preRender.calls;
  await call("input", { op: "set", ports: [{ right: true }] });
  const step = await call("frame", { op: "step", frames: 10 });
  assert.ok(!step._error, String(step._error));

  const status = await call("catalog", { op: "status" });
  assert.equal(status.activeBezel.preRender.calls - before, 10,
    "pre_render must run once per FRAME, not once per step call");
  assert.equal(status.activeBezel.preRenderHookError, undefined, "no hook errors");

  // The last pre_render stamped its frame number; after the step, frameCount
  // IS that number (frameCount+1 alignment). Read it back through the same
  // memory tool an agent would use — core RAM as ground truth.
  const mem = await call("memory", { op: "read", region: "system_ram", offset: 0x6F0, length: 1 });
  assert.ok(!mem._error, String(mem._error));
  const byte = parseInt(String(mem.hex ?? mem.bytes ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 2), 16);
  assert.equal(byte, status.frameCount % 256,
    `pre_render's RAM stamp must equal the last frame number (got ${byte}, frameCount ${status.frameCount})`);

  // ---- suspend/resume WITHOUT re-init (playtest op:'bezel' / the B hotkey) ----
  const ticksBefore = status.activeBezel.stats?.ticks ?? status.activeBezel.ticks;
  const suspended = await call("playtest", { op: "bezel", show: false });
  assert.equal(suspended.bezel, "suspended", JSON.stringify(suspended).slice(0, 200));
  await call("frame", { op: "step", frames: 5 });
  const during = await call("catalog", { op: "status" });
  assert.equal(during.activeBezel.bypassed, true, "status must SAY it is suspended");
  assert.equal(during.activeBezel.preRender.calls, status.activeBezel.preRender.calls,
    "pre_render must NOT run while suspended");
  const shotDir = await mkdtemp(path.join(tmpdir(), "ab-bypass-"));
  t.after(() => rm(shotDir, { recursive: true, force: true }));
  const shot = await call("frame", { op: "screenshot", path: path.join(shotDir, "s.png") });
  assert.equal(shot.source, "core", "captures show the raw core frame while suspended: " + JSON.stringify(shot).slice(0, 200));

  const resumed = await call("playtest", { op: "bezel" });   // omit show = toggle back
  assert.equal(resumed.bezel, "active");
  await call("frame", { op: "step", frames: 5 });
  const after = await call("catalog", { op: "status" });
  assert.equal(after.activeBezel.preRender.calls - status.activeBezel.preRender.calls, 5,
    "pre_render resumes counting from where it left off");
  const ticksAfter = after.activeBezel.stats?.ticks ?? after.activeBezel.ticks;
  assert.ok(ticksAfter >= ticksBefore,
    "the SAME guest instance resumed — tick stats continue, nothing was re-initialized");
});
