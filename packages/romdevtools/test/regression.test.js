// regression — checkpoint-based golden harness. Host-kind-agnostic: a real NES
// core (frameHash + memory checkpoints) and a fake wasmcart-style host (debug
// named-state checkpoints — the size-independent path).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { registerRegressionTools } from "../src/mcp/tools/regression.js";
import { _setHostForTest } from "../src/mcp/state.js";

function getHandler(key) {
  let handler;
  const fakeServer = { tool(name, _d, _s, h) { if (name === "regression") handler = h; } };
  registerRegressionTools(fakeServer, z, key);
  return (args) => handler(args);
}
const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

// ── fake wasmcart-style host driven by an input script (deterministic) ───────
// hp counts down each frame while `b` (fire) is held; a scripted press at
// frame 2 changes the trajectory, so a golden captures a real behavior.
function makeScriptHost() {
  let hp = 10;
  let held = {};
  let fbSeed = 0;
  return {
    status: { loaded: true, platform: "wasmcart", frameCount: 0 },
    getCapabilities: () => ({ kind: "wasmcart", hasWasmIntrospection: true, hasDebugState: true }),
    setInput(input) { held = input.ports?.[0] ?? {}; },
    stepFrames(n) {
      for (let i = 0; i < n; i++) {
        if (held.b) hp = Math.max(0, hp - 2); else hp = Math.max(0, hp - 1);
        fbSeed = (fbSeed * 31 + hp + (held.b ? 1 : 0)) >>> 0;
        this.status.frameCount++;
      }
      return n;
    },
    framebufferHash() { return fbSeed >>> 0; },
    readDebugValue(name) {
      if (name === "hp") return { name, type: "u8", value: hp };
      throw new Error(`debug field '${name}' not found`);
    },
  };
}

const SCRIPT = [{ atFrame: 0, ports: [{}] }, { atFrame: 2, ports: [{ b: true }] }];
const CPS = [
  { frame: 3, label: "early", observe: ["frameHash", "debug"], debugFields: ["hp"] },
  { frame: 6, label: "late", observe: ["debug"], debugFields: ["hp"] },
];

test("capture writes a golden; check passes on an identical re-run", async () => {
  const golden = path.join(os.tmpdir(), `romdev-reg-${process.pid}.json`);
  try {
    _setHostForTest("reg1", makeScriptHost());
    const cap = parse(await getHandler("reg1")({ op: "capture", goldenPath: golden, inputScript: SCRIPT, checkpoints: CPS }));
    assert.equal(cap.captured, true);
    assert.equal(cap.checkpoints, 2);

    // fresh identical host → check passes
    _setHostForTest("reg1", makeScriptHost());
    const chk = parse(await getHandler("reg1")({ op: "check", goldenPath: golden }));
    assert.equal(chk.passed, true);
    assert.deepEqual(chk.diffs, []);

    // the golden records the actual observed values
    const g = JSON.parse(await readFile(golden, "utf8"));
    const early = g.observations.find((o) => o.label === "early");
    // hp=10; f1 step (no b) →9; f2 press b then step →7; f3 step →5.
    assert.equal(early.obs.debug.hp, 5);
  } finally {
    await rm(golden, { force: true });
  }
});

test("check FAILS with a named diff when behavior drifts (a regression)", async () => {
  const golden = path.join(os.tmpdir(), `romdev-reg2-${process.pid}.json`);
  try {
    _setHostForTest("reg2", makeScriptHost());
    await getHandler("reg2")({ op: "capture", goldenPath: golden, inputScript: SCRIPT, checkpoints: CPS });

    // a "broken" host: hp drains twice as fast — the debug checkpoint must catch it
    const broken = makeScriptHost();
    const origStep = broken.stepFrames.bind(broken);
    broken.stepFrames = (n) => origStep(n); // same
    // mutate: make readDebugValue report a wrong hp to simulate a logic regression
    broken.readDebugValue = (name) => name === "hp" ? { name, type: "u8", value: 999 } : (() => { throw new Error("nf"); })();
    _setHostForTest("reg2", broken);
    const chk = parse(await getHandler("reg2")({ op: "check", goldenPath: golden }));
    assert.equal(chk.passed, false);
    const hpDiff = chk.diffs.find((d) => d.kind === "debug" && d.key === "hp");
    assert.ok(hpDiff, "a debug hp diff is reported");
    assert.equal(hpDiff.actual, 999);
    assert.match(chk.note, /REGRESSION/);
  } finally {
    await rm(golden, { force: true });
  }
});

test("check reuses the golden's stored script/checkpoints when omitted", async () => {
  const golden = path.join(os.tmpdir(), `romdev-reg3-${process.pid}.json`);
  try {
    _setHostForTest("reg3", makeScriptHost());
    await getHandler("reg3")({ op: "capture", goldenPath: golden, inputScript: SCRIPT, checkpoints: CPS });
    _setHostForTest("reg3", makeScriptHost());
    // no inputScript / checkpoints passed → pulled from the golden
    const chk = parse(await getHandler("reg3")({ op: "check", goldenPath: golden }));
    assert.equal(chk.passed, true);
    assert.equal(chk.checkpoints, 2);
  } finally {
    await rm(golden, { force: true });
  }
});

test("refuses when no media is loaded", async () => {
  _setHostForTest("reg4", { status: { loaded: false } });
  const res = await getHandler("reg4")({ op: "capture", goldenPath: "/tmp/x.json", checkpoints: CPS });
  assert.equal(res.isError, true);
  assert.match(res.content.find((c) => c.type === "text").text, /no media loaded/);
});
