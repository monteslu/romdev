// state({op:'exportSram'/'importSram'/'save'}) against a REAL WasmcartHost —
// the tool-level half of the fix in wasmcart-sram.test.js (which covers
// WasmcartHost's own getSaveData/setSaveData/persistence directly).
//
// Filed as internal-romdev/feedback/2026-08-19_wasmcart-sram-invisible-to-state-tool-and-lost-on-reload.md.
// Before this fix: exportSram/importSram routed every platform through the
// libretro save_ram REGION api (regionSize/readMemory(region,...)), which
// WasmcartHost doesn't implement — the resulting TypeError was swallowed by
// a `catch { return 0 }` into a confidently wrong "the loaded ROM has no
// battery save RAM" even though the cart held live SRAM. And
// state({op:'save'}) called host.saveState(), which doesn't exist on
// wasmcart either, and threw a raw uncaught TypeError.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerStateTools } from "../src/mcp/tools/state.js";
import { _setHostForTest } from "../src/mcp/state.js";
import { WasmcartHost } from "../src/host/WasmcartHost.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELLO_SRC = path.join(HERE, "fixtures", "hello.wasc");

function getStateHandler(sessionKey) {
  let handler;
  registerStateTools({ tool(name, _d, _s, h) { if (name === "state") handler = h; } }, z, sessionKey);
  return handler;
}

function parseResult(res) {
  assert.equal(res.isError, undefined, "unexpected isError: " + JSON.stringify(res));
  return JSON.parse(res.content.find((c) => c.type === "text").text);
}

async function freshWasmcartSession(sessionKey) {
  const dir = await mkdtemp(path.join(tmpdir(), "state-wasmcart-sram-"));
  const cartPath = path.join(dir, "hello.wasc");
  await import("node:fs/promises").then((fs) => fs.copyFile(HELLO_SRC, cartPath));
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: cartPath });
  _setHostForTest(sessionKey, host);
  return { dir, cartPath, host };
}

test("exportSram on a wasmcart cart reports the REAL 64-byte SRAM, not size 0", { timeout: 30000 }, async () => {
  const sessionKey = "test-wasmcart-sram-export";
  const { dir, host } = await freshWasmcartSession(sessionKey);
  try {
    const handle = getStateHandler(sessionKey);
    const outPath = path.join(dir, "out.sav");
    const res = parseResult(await handle({ op: "exportSram", path: outPath }));
    assert.equal(res.exportedSram, true);
    assert.equal(res.bytes, 64, "hello.wasc declares 64 bytes of SRAM — must not report 0");
    const written = await readFile(outPath);
    assert.equal(written.length, 64);
  } finally {
    host.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("importSram on a wasmcart cart writes through setSaveData (round-trip)", { timeout: 30000 }, async () => {
  const sessionKey = "test-wasmcart-sram-import";
  const { dir, host } = await freshWasmcartSession(sessionKey);
  try {
    const handle = getStateHandler(sessionKey);
    const savPath = path.join(dir, "custom.sav");
    const blob = new Uint8Array(64);
    blob[4] = 1; // has_save
    for (let i = 5; i < 17; i++) blob[i] = 0xCC;
    await import("node:fs/promises").then((fs) => fs.writeFile(savPath, blob));

    const res = parseResult(await handle({ op: "importSram", path: savPath }));
    assert.equal(res.importedSram, true);
    assert.equal(res.bytes, 64);

    const live = host.getSaveData();
    assert.deepEqual(Array.from(live).slice(4, 17), Array.from(blob).slice(4, 17),
      "importSram should have written the .sav bytes into the cart's live SRAM");
  } finally {
    host.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("state({op:'save'}) fails CLEANLY on wasmcart instead of a raw TypeError", { timeout: 30000 }, async () => {
  const sessionKey = "test-wasmcart-save-clean-error";
  const { dir, host } = await freshWasmcartSession(sessionKey);
  try {
    const handle = getStateHandler(sessionKey);
    const res = await handle({ op: "save", name: "s1" });
    assert.equal(res.isError, true, "op:'save' on wasmcart should be a reported tool error, not a thrown TypeError");
    const msg = res.content.find((c) => c.type === "text").text;
    assert.match(msg, /not supported on 'wasmcart'/);
    assert.doesNotMatch(msg, /host\.saveState is not a function/,
      "should surface the real explanation, not the raw missing-method TypeError");
    assert.match(msg, /exportSram/, "should point at the actual alternative wasmcart supports");
  } finally {
    host.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("state({op:'load'}) also fails cleanly on wasmcart", { timeout: 30000 }, async () => {
  const sessionKey = "test-wasmcart-load-clean-error";
  const { dir, host } = await freshWasmcartSession(sessionKey);
  try {
    const handle = getStateHandler(sessionKey);
    const res = await handle({ op: "load", name: "s1" });
    assert.equal(res.isError, true);
    const msg = res.content.find((c) => c.type === "text").text;
    assert.match(msg, /not supported on 'wasmcart'/);
  } finally {
    host.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});
