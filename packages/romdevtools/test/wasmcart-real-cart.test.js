// wasmcart REAL-cart coverage: input + named debug state + regression goldens
// against a compiled cart (fixtures/dbghello.wasc), not mocks. Exists because
// the mock-host suite stayed green while _padFromInput emitted named 0/1
// fields instead of the {connected, buttons: bitmask} pad CartHost._writePads
// expects — every pad read as disconnected and input never reached a cart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { WasmcartHost } from "../src/host/WasmcartHost.js";
import { registerWasmInspectTools } from "../src/mcp/tools/wasm-inspect.js";
import { registerRegressionTools } from "../src/mcp/tools/regression.js";
import { _setHostForTest } from "../src/mcp/state.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DBG = path.join(HERE, "fixtures", "dbghello.wasc");

function getHandler(toolName, register, key) {
  let handler;
  const fakeServer = { tool(name, _d, _s, h) { if (name === toolName) handler = h; } };
  register(fakeServer, z, key);
  return (args) => handler(args);
}
const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

async function loadDbg() {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: DBG });
  return host;
}

// ── input actually reaches the cart ──────────────────────────────────────────

test("real cart: flat setInput({right}) moves the cart's own state", async () => {
  const host = await loadDbg();
  assert.equal(host.readDebugValue("player_x").value, 140, "initial x");
  host.setInput({ right: true });
  host.stepFrames(5);
  assert.equal(host.readDebugValue("player_x").value, 150, "x advanced 2px/frame x5");
});

test("real cart: ports-form setInput and release both work", async () => {
  const host = await loadDbg();
  host.setInput({ ports: [{ left: true }] });
  host.stepFrames(5);
  assert.equal(host.readDebugValue("player_x").value, 130, "ports form moves too");
  host.setInput({}); // release — connected idle pad, not a disconnect
  host.stepFrames(5);
  assert.equal(host.readDebugValue("player_x").value, 130, "released pad stops movement");
});

test("real cart: capabilities report hasDebugState=true", async () => {
  const host = await loadDbg();
  assert.equal(host.getCapabilities().hasDebugState, true);
});

// ── the wasm tool over the real debug ABI ────────────────────────────────────

test("real cart: wasm op:debugState lists the cart's fields with values", async () => {
  const host = await loadDbg();
  _setHostForTest("real-dbg", host);
  const wasm = getHandler("wasm", registerWasmInspectTools, "real-dbg");
  const r = parse(await wasm({ op: "debugState" }));
  const byName = Object.fromEntries(r.fields.map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(byName).sort(), ["player_x", "player_y", "red_color"]);
  assert.equal(byName.player_x.value, 140);
  assert.equal(byName.player_y.value, 100);
});

test("real cart: wasm op:write/read by NAME round-trips and survives frames", async () => {
  const host = await loadDbg();
  _setHostForTest("real-rw", host);
  const wasm = getHandler("wasm", registerWasmInspectTools, "real-rw");
  await wasm({ op: "write", name: "player_x", value: 77 });
  assert.equal(parse(await wasm({ op: "read", name: "player_x" })).value, 77);
  host.stepFrames(3); // no input held — cart clamps but doesn't move it
  assert.equal(parse(await wasm({ op: "read", name: "player_x" })).value, 77);
});

// ── regression goldens over a real cart (frameHash + debug, input-driven) ────

test("real cart: regression capture→check passes across fresh loads", async () => {
  const golden = path.join(os.tmpdir(), `dbghello-golden-${process.pid}.json`);
  try {
    const capHost = await loadDbg();
    _setHostForTest("real-cap", capHost);
    const capture = getHandler("regression", registerRegressionTools, "real-cap");
    const script = [
      { atFrame: 0, ports: [{ right: true }] },
      { atFrame: 10, ports: [{}] },
    ];
    const checkpoints = [
      { frame: 10, observe: ["frameHash", "debug"], debugFields: ["player_x", "player_y"] },
      { frame: 20, observe: ["frameHash", "debug"], debugFields: ["player_x", "player_y"] },
    ];
    const cap = parse(await capture({ op: "capture", goldenPath: golden, inputScript: script, checkpoints }));
    assert.equal(cap.captured, true);
    assert.equal(cap.checkpoints, 2, "golden recorded both checkpoints");

    const chkHost = await loadDbg();
    _setHostForTest("real-chk", chkHost);
    const check = getHandler("regression", registerRegressionTools, "real-chk");
    const chk = parse(await check({ op: "check", goldenPath: golden }));
    assert.equal(chk.passed, true, `fresh load replays clean: ${JSON.stringify(chk.diffs ?? [])}`);

    // The golden observed real movement, not a static scene.
    const { readFile } = await import("node:fs/promises");
    const written = JSON.parse(await readFile(golden, "utf8"));
    const f10 = written.observations.find((o) => o.frame === 10);
    assert.ok(f10.obs.debug.player_x > 140, "input moved the cart during capture");
  } finally {
    await rm(golden, { force: true });
  }
});

test("real cart: regression check FAILS against a divergent run", async () => {
  const golden = path.join(os.tmpdir(), `dbghello-golden-div-${process.pid}.json`);
  try {
    const capHost = await loadDbg();
    _setHostForTest("div-cap", capHost);
    const capture = getHandler("regression", registerRegressionTools, "div-cap");
    await capture({
      op: "capture", goldenPath: golden,
      inputScript: [{ atFrame: 0, ports: [{ right: true }] }],
      checkpoints: [{ frame: 10, observe: ["debug"], debugFields: ["player_x"] }],
    });

    const chkHost = await loadDbg();
    chkHost.writeDebugValue("player_x", 0); // diverge the fresh run
    _setHostForTest("div-chk", chkHost);
    const check = getHandler("regression", registerRegressionTools, "div-chk");
    const chk = parse(await check({ op: "check", goldenPath: golden }));
    assert.equal(chk.passed, false, "divergence is caught");
    assert.ok(chk.diffs.some((d) => d.key === "player_x"), "the diff names the field");
  } finally {
    await rm(golden, { force: true });
  }
});
