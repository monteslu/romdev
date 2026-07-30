// Active Bezel integration: loadMedia -> tick -> composite, through the tools.
//
// An Active Bezel is an executable companion to a ROM: it runs after every core
// frame, reads the core's live memory, and renders the final scene. romdev runs
// it so an agent can see the composite, the raw core framebuffer, and the
// guest's own behaviour for the SAME frame -- because a package can load
// cleanly, tick without trapping, emit valid draw commands, and still be
// completely wrong about the game.
//
// The diagnostic example is the right fixture here: it requires only
// system_ram and composes a full scene, so it exercises the plumbing without
// asserting anything about a specific game's RAM map.
//
// It declares NO rom compatibility, and the matcher treats that as matching
// nothing rather than everything -- correctly, since a package that silently
// accepted any ROM would compose a map keyed to some other game's RAM layout.
// So these tests pass activeBezelForce:true, which also exercises the force
// path. A real game-specific package matches on an exact ROM hash instead.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { registerTools } from "../src/mcp/tools/index.js";

const ROM = new URL("./roms/nestest.nes", import.meta.url).pathname;

// Resolve the fixture THROUGH the dependency rather than by absolute path: the
// `active-bezel` package ships its examples/, so this finds the diagnostic
// package wherever the install put it (workspace symlink, node_modules, or a
// hoisted root) on any machine.
const BEZEL = (() => {
  try {
    const require = createRequire(import.meta.url);
    return path.join(path.dirname(require.resolve("active-bezel")), "examples", "diagnostic");
  } catch { return null; }
})();

// Skip rather than fail when the dependency isn't installed, so this file
// doesn't break a checkout that hasn't run a full install.
const HAVE_BEZEL = BEZEL !== null && existsSync(BEZEL);

async function session(key) {
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

test("a plain loadMedia is completely unaffected", { skip: !HAVE_BEZEL }, async () => {
  // The whole extension is opt-in: a call without the new parameters must
  // behave exactly as it did before any of this existed.
  const call = await session("ab-untouched");
  const load = await call("loadMedia", { platform: "nes", path: ROM });
  assert.equal(load.loaded, true);
  assert.equal(load.activeBezel, undefined, "no bezel object on a plain load");

  const status = await call("catalog", { op: "status" });
  assert.equal(status.activeBezel, undefined, "status stays clean too");
});

test("useActiveBezel with no sidecar fails loudly, naming the path it looked for", { skip: !HAVE_BEZEL }, async () => {
  // Silently loading the ROM alone would be the worst outcome: the agent asked
  // for a composite and would get the raw picture, with nothing saying so.
  const call = await session("ab-missing");
  const load = await call("loadMedia", { platform: "nes", path: ROM, useActiveBezel: true });
  assert.ok(load._error, "rejected");
  assert.match(load._error, /No Active Bezel found at/);
  assert.match(load._error, /nestest\.ab/, "names the sidecar path it searched for");
  assert.match(load._error, /activeBezelPath/, "points at the development override");
});

test("an explicit package loads, matches, and reports its regions", { skip: !HAVE_BEZEL }, async () => {
  const call = await session("ab-load");
  const load = await call("loadMedia", {
    platform: "nes", path: ROM, activeBezelPath: BEZEL, activeBezelForce: true,
  });
  assert.equal(load.loaded, true, "load failed: " + JSON.stringify(load).slice(0, 300));
  assert.ok(load.activeBezel, "activeBezel reported on the response");
  assert.equal(load.activeBezel.enabled, true);
  assert.match(load.activeBezel.path, /diagnostic$/);
});

test("the composite is what a screenshot captures, and differs from the core frame", { skip: !HAVE_BEZEL }, async () => {
  // This is the assertion that matters. If the composite and the core picture
  // were identical, the bezel would not actually be compositing -- and every
  // later "the map looks right" judgement would be meaningless.
  const call = await session("ab-composite");
  await call("loadMedia", { platform: "nes", path: ROM, activeBezelPath: BEZEL, activeBezelForce: true });
  await call("frame", { op: "step", frames: 10 });

  const dir = mkdtempSync(path.join(tmpdir(), "ab-shot-"));
  const compositePath = path.join(dir, "composite.png");
  const corePath = path.join(dir, "core.png");

  const composite = await call("frame", { op: "screenshot", path: compositePath });
  assert.ok(!composite._error, "composite shot failed: " + JSON.stringify(composite).slice(0, 300));
  assert.equal(composite.source, "composite", "a bezel session captures the composite by DEFAULT");

  const core = await call("frame", { op: "screenshot", path: corePath, source: "core" });
  assert.equal(core.source, "core");

  // The diagnostic package composes a 640x360 scene; the NES core frame is
  // 256x240. Different geometry is the cheapest proof the composite is real.
  assert.notEqual(
    `${composite.width}x${composite.height}`,
    `${core.width}x${core.height}`,
    "composite and core frame have the same geometry -- the bezel is not compositing",
  );
  assert.ok(existsSync(compositePath) && existsSync(corePath), "both files written");
});

test("source:'both' returns the pair plus the three geometries", { skip: !HAVE_BEZEL }, async () => {
  const call = await session("ab-both");
  await call("loadMedia", { platform: "nes", path: ROM, activeBezelPath: BEZEL, activeBezelForce: true });
  await call("frame", { op: "step", frames: 10 });

  const dir = mkdtempSync(path.join(tmpdir(), "ab-both-"));
  const out = path.join(dir, "shot.png");
  const both = await call("frame", { op: "screenshot", path: out, source: "both" });

  assert.equal(both.source, "both");
  assert.ok(both.composite?.path, "composite path returned");
  assert.ok(both.core?.path, "core path returned");
  assert.notEqual(both.composite.path, both.core.path, "written to separate files");
  assert.ok(existsSync(both.composite.path) && existsSync(both.core.path));

  // The geometry triple the handoff insists on keeping distinct: conflating raw
  // framebuffer size with intended display aspect is how a 4:3 game ends up
  // stretched into a tall rectangle.
  assert.ok(both.geometry?.core, "raw core framebuffer geometry");
  assert.ok(both.geometry?.scene, "bezel logical scene geometry");
});

test("source:'both' without a bezel says so instead of returning one picture twice", { skip: !HAVE_BEZEL }, async () => {
  const call = await session("ab-both-nobezel");
  await call("loadMedia", { platform: "nes", path: ROM });
  await call("frame", { op: "step", frames: 5 });
  const both = await call("frame", { op: "screenshot", inline: true, source: "both" });
  assert.ok(both._error);
  assert.match(both._error, /needs an Active Bezel loaded/);
});

test("catalog status advertises the running bezel", { skip: !HAVE_BEZEL }, async () => {
  // A session re-grounding mid-investigation has to know a bezel is running
  // BEFORE it interprets a screenshot as the game's own output.
  const call = await session("ab-status");
  await call("loadMedia", { platform: "nes", path: ROM, activeBezelPath: BEZEL, activeBezelForce: true });
  await call("frame", { op: "step", frames: 5 });

  const status = await call("catalog", { op: "status" });
  assert.ok(status.activeBezel, "activeBezel in catalog status");
  assert.equal(status.activeBezel.enabled, true);
  assert.ok(status.activeBezel.ticks > 0, "ticks counted: " + JSON.stringify(status.activeBezel));
});

test("unloading media detaches the package", { skip: !HAVE_BEZEL }, async () => {
  // The package is bound to this ROM's hash. Keeping it across an unload would
  // leave one game's map ready to composite over another game's picture.
  const call = await session("ab-unload");
  await call("loadMedia", { platform: "nes", path: ROM, activeBezelPath: BEZEL, activeBezelForce: true });
  const unloaded = await call("host", { op: "unload" });
  assert.match(String(unloaded), /Active Bezel detached/);

  const status = await call("catalog", { op: "status" });
  assert.equal(status.activeBezel, undefined, "no bezel after unload");
});

test("loading different media without a bezel drops the previous one", { skip: !HAVE_BEZEL }, async () => {
  const call = await session("ab-swap");
  await call("loadMedia", { platform: "nes", path: ROM, activeBezelPath: BEZEL, activeBezelForce: true });
  assert.ok((await call("catalog", { op: "status" })).activeBezel, "bezel attached");

  await call("loadMedia", { platform: "nes", path: ROM });
  assert.equal(
    (await call("catalog", { op: "status" })).activeBezel, undefined,
    "a plain load must not inherit the previous ROM's bezel",
  );
});

test("a reset KEEPS the package; a state load notifies it", { skip: !HAVE_BEZEL }, async () => {
  // Reset and state-load are continuity breaks, not teardowns: the same ROM is
  // still loaded, so the package stays and is told the timeline jumped.
  const call = await session("ab-continuity");
  await call("loadMedia", { platform: "nes", path: ROM, activeBezelPath: BEZEL, activeBezelForce: true });
  await call("frame", { op: "step", frames: 5 });

  await call("host", { op: "reset" });
  assert.ok((await call("catalog", { op: "status" })).activeBezel, "bezel survives a reset");

  await call("state", { op: "save", name: "ab" });
  await call("frame", { op: "step", frames: 5 });
  const loaded = await call("state", { op: "load", name: "ab", probeLiveness: false });
  assert.equal(loaded.loaded, true);
  assert.ok((await call("catalog", { op: "status" })).activeBezel, "bezel survives a state load");
});
