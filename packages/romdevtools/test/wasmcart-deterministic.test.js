// Deterministic replay + debug events through the romdev consumer surface
// (WS3 Parts B and C), against the REAL detrng.wasc fixture (RNG-noise render,
// WC_DETERMINISTIC_RNG, WC_DEBUG_FIELDS, wc_debug_mark).
//
// Skip-guarded on the installed wasmcart: a clean clone pinned to wasmcart
// 0.4.0 has no wc_set_seed/drainDebugEvents — these tests skip there and run
// fully once the 0.5.0 repin lands. The guard mirrors the host's own
// feature-detection, so a skip here means the tools refuse loudly too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CartHost } from "wasmcart";
import { WasmcartHost } from "../src/host/WasmcartHost.js";
import { registerWasmInspectTools } from "../src/mcp/tools/wasm-inspect.js";
import { registerRegressionTools } from "../src/mcp/tools/regression.js";
import { _setHostForTest } from "../src/mcp/state.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DETRNG = path.join(HERE, "fixtures", "detrng.wasc");

const HAS_050 = new CartHost().deterministicSeed !== undefined;
const skip = HAS_050 ? false : "wasmcart >= 0.5.0 not installed (repin pending publish)";

function getHandler(toolName, register, key) {
  let handler;
  const fakeServer = { tool(name, _d, _s, h) { if (name === toolName) handler = h; } };
  register(fakeServer, z, key);
  return (args) => handler(args);
}
const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

async function loadDet(seed) {
  const host = new WasmcartHost();
  await host.loadMedia({
    platform: "wasmcart", path: DETRNG,
    ...(seed !== undefined ? { deterministic: { seed } } : {}),
  });
  return host;
}

// ── Part B through the host ──────────────────────────────────────────────────

test("same seed → identical framebufferHash across fresh loads", { skip }, async () => {
  const a = await loadDet(1234); a.stepFrames(10);
  const b = await loadDet(1234); b.stepFrames(10);
  assert.equal(a.framebufferHash(), b.framebufferHash(), "seeded replay is bit-stable");
  const c = await loadDet(9999); c.stepFrames(10);
  assert.notEqual(a.framebufferHash(), c.framebufferHash(), "different seed diverges");
});

test("capabilities + status surface the deterministic facts", { skip }, async () => {
  const host = await loadDet(42);
  const caps = host.getCapabilities();
  assert.equal(caps.hasDeterministic, true, "cart declares FLAG_DETERMINISTIC");
  assert.equal(caps.hasDebugEvents, true);
  assert.equal(host.status.deterministicSeed, 42);
  const plain = await loadDet(undefined);
  assert.equal(plain.status.deterministicSeed, null, "unseeded load stamps null");
});

// ── Part C through the wasm tool ─────────────────────────────────────────────

test("wasm op:events drains frame-stamped marks + log, then empties", { skip }, async () => {
  const host = await loadDet(7);
  host.stepFrames(9); // + the settle frame = 10 rendered frames
  _setHostForTest("det-ev", host);
  const wasm = getHandler("wasm", registerWasmInspectTools, "det-ev");
  const r = parse(await wasm({ op: "events" }));
  assert.equal(r.hasDebugEvents, true);
  assert.deepEqual(r.marks.map((m) => m.id), [1, 2], "init mark + frame-5 milestone");
  assert.match(r.log[0].text, /detrng init/);
  const again = parse(await wasm({ op: "events" }));
  assert.equal(again.marks.length, 0, "drain cleared the rings");
});

test("wasm op:conformance passes detrng and would flag a broken deterministic cart", { skip }, async () => {
  const host = await loadDet(1);
  _setHostForTest("det-conf", host);
  const wasm = getHandler("wasm", registerWasmInspectTools, "det-conf");
  const r = parse(await wasm({ op: "conformance" }));
  assert.equal(r.conforms, true, `detrng conforms: ${JSON.stringify(r.issues)}`);
  assert.ok(!r.issues.some((i) => i.code?.startsWith("deterministic")), "no determinism issues on a correct cart");
});

// ── The airtight golden: seed + script + fixed step ─────────────────────────

test("regression frameHash golden is airtight under a seed (capture→check across loads)", { skip }, async () => {
  const golden = path.join(os.tmpdir(), `detrng-golden-${process.pid}.json`);
  try {
    const capHost = await loadDet(555);
    _setHostForTest("det-cap", capHost);
    const capture = getHandler("regression", registerRegressionTools, "det-cap");
    const cap = parse(await capture({
      op: "capture", goldenPath: golden,
      inputScript: [{ atFrame: 0, ports: [{ right: true }] }, { atFrame: 8, ports: [{}] }],
      checkpoints: [
        { frame: 5, observe: ["frameHash", "debug"], debugFields: ["player_x", "noise_x"] },
        { frame: 15, observe: ["frameHash", "debug"], debugFields: ["player_x", "noise_x"] },
      ],
    }));
    assert.equal(cap.captured, true);

    const chkHost = await loadDet(555);
    _setHostForTest("det-chk", chkHost);
    const check = getHandler("regression", registerRegressionTools, "det-chk");
    const chk = parse(await check({ op: "check", goldenPath: golden }));
    assert.equal(chk.passed, true, `same-seed replay reproduces every hash: ${JSON.stringify(chk.diffs ?? [])}`);
  } finally {
    await rm(golden, { force: true });
  }
});

test("audioDebug record: a cart declaring sampleRate 0 gets a 48000 Hz WAV header", { skip }, async () => {
  // `?? 48000` let the declared-0 ("host decides") rate through as a 0 Hz WAV
  // header — caught live by the starfall dogfood run. Must be `|| 48000`.
  const { registerAudioTools } = await import("../src/mcp/tools/audio.js");
  const { readFile } = await import("node:fs/promises");
  const host = await loadDet(3);
  assert.equal(host.status.audioSampleRate, 0, "detrng declares 0 = host decides");
  host.stepFrames(5);
  _setHostForTest("wav-rate", host);
  let audio;
  registerAudioTools({ tool: (n, _d, _s, h) => { if (n === "audioDebug") audio = h; } }, z, "wav-rate");
  const wavPath = path.join(os.tmpdir(), `detrng-rate-${process.pid}.wav`);
  try {
    const r = parse(await audio({ op: "record", frames: 5, path: wavPath }));
    assert.equal(r.sampleRate, 48000, "response reports the fallback rate");
    const bytes = await readFile(wavPath);
    assert.equal(bytes.readUInt32LE(24), 48000, "WAV header carries a real rate, not 0");
  } finally {
    await rm(wavPath, { force: true });
  }
});

test("regression check refuses a seed mismatch up front (not as hash noise)", { skip }, async () => {
  const golden = path.join(os.tmpdir(), `detrng-golden-seed-${process.pid}.json`);
  try {
    const capHost = await loadDet(111);
    _setHostForTest("seed-cap", capHost);
    const capture = getHandler("regression", registerRegressionTools, "seed-cap");
    await capture({
      op: "capture", goldenPath: golden,
      checkpoints: [{ frame: 3, observe: ["frameHash"] }],
    });

    const wrongHost = await loadDet(222);
    _setHostForTest("seed-chk", wrongHost);
    const check = getHandler("regression", registerRegressionTools, "seed-chk");
    const res = await check({ op: "check", goldenPath: golden });
    const body = res.content.find((c) => c.type === "text").text;
    assert.match(body, /deterministicSeed=111/, "the refusal names the golden's seed");
    assert.match(body, /deterministicSeed: 111/, "and tells the caller how to reload");
  } finally {
    await rm(golden, { force: true });
  }
});
