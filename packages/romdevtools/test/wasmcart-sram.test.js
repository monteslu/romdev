// wasmcart SRAM: persistence across loadMedia (same cart path, same session)
// + the state({op:'exportSram'/'importSram'}) tool wired to getSaveData/
// setSaveData instead of the libretro-only save_ram region API (which
// wasmcart doesn't implement).
//
// Filed as internal-romdev/feedback/2026-08-19_wasmcart-sram-invisible-to-state-tool-and-lost-on-reload.md:
// three bugs — exportSram/importSram reported "no battery save RAM" on a cart
// with live SRAM (regionSize doesn't exist on WasmcartHost, and the catch
// swallowed that into a false "size 0"); state({op:'save'}) threw a raw
// "host.saveState is not a function"; and SRAM never survived a reload
// because nothing persisted it across loadMedia, so "quit and come back"
// (the whole point of a save file) could never be exercised through romdev.
//
// Persistence is an in-process cache keyed by resolved cart path, NOT a
// `<path>.sav` written to disk — that was the first implementation, and it
// broke every OTHER wasmcart test in this suite: every loadMedia of the
// tracked hello.wasc fixture left an untracked .sav next to it in the repo.
// Explicit disk persistence is exportSram/importSram, unaffected by this.
//
// Uses the vendored hello.wasc fixture (test/fixtures/dbghello.c), which
// declares 64 bytes of real SRAM: byte[4] is a has_save flag load_state()
// checks before restoring bytes[5..16] (game state); bytes[0..3] are a play
// counter wc_init() ALWAYS increments regardless of what SRAM held, so tests
// here assert on the has_save-gated bytes, not the counter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { WasmcartHost } from "../src/host/WasmcartHost.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELLO_SRC = path.join(HERE, "fixtures", "hello.wasc");

async function freshCartCopy() {
  const dir = await mkdtemp(path.join(tmpdir(), "wasmcart-sram-"));
  const dest = path.join(dir, "hello.wasc");
  await copyFile(HELLO_SRC, dest);
  return { dir, dest };
}

test("wasmcart: getSaveData reports the cart's real SRAM (not size 0)", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: HELLO_SRC });
  assert.equal(host.saveDataSize(), 64);
  const sram = host.getSaveData();
  assert.ok(sram, "getSaveData should return bytes, not null, for a cart that declares SRAM");
  assert.equal(sram.length, 64);
  host.destroy();
});

test("wasmcart: setSaveData writes through to the cart's live heap", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: HELLO_SRC });
  const poked = new Uint8Array(64).fill(0xAB);
  const written = host.setSaveData(poked);
  assert.equal(written, 64);
  assert.deepEqual(Array.from(host.getSaveData()), Array.from(poked));
  host.destroy();
});

test("wasmcart: SRAM survives destroy() + loadMedia on the same path (persistence)", { timeout: 30000 }, async () => {
  const { dir, dest } = await freshCartCopy();
  try {
    const host1 = new WasmcartHost();
    await host1.loadMedia({ platform: "wasmcart", path: dest });
    // has_save=1 + a distinctive rect_x/rect_y/red_x/red_y/red_color payload —
    // this is what load_state() actually restores, unlike bytes[0..3] (the
    // play counter, which wc_init bumps every boot regardless of SRAM content).
    const marker = new Uint8Array(64);
    marker[4] = 1;
    for (let i = 5; i < 17; i++) marker[i] = 0xAA;
    host1.setSaveData(marker);
    assert.deepEqual(Array.from(host1.getSaveData()).slice(4, 17), Array.from(marker).slice(4, 17));
    host1.destroy(); // the only moment this host loses the live bytes — must cache here

    // Fresh host, same cart path — the exact "quit and come back" the report
    // says was previously impossible to exercise through romdev.
    const host2 = new WasmcartHost();
    await host2.loadMedia({ platform: "wasmcart", path: dest });
    assert.deepEqual(Array.from(host2.getSaveData()).slice(4, 17), Array.from(marker).slice(4, 17),
      "SRAM's has_save-gated bytes should have been restored from the previous session's destroy()");
    host2.destroy();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wasmcart: a cart with no prior session in the cache still boots clean (first run)", async () => {
  const { dir, dest } = await freshCartCopy();
  try {
    const host = new WasmcartHost();
    await host.loadMedia({ platform: "wasmcart", path: dest });
    assert.equal(host.saveDataSize(), 64, "still boots and reports its declared SRAM size");
    assert.equal(host.getSaveData()[4], 0, "has_save should be unset on a cart never seen before");
    host.destroy();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wasmcart: persistence never writes a file next to the cart", { timeout: 30000 }, async () => {
  // The first implementation of this fix wrote `<path>.sav` on every destroy(),
  // which polluted every OTHER test that loads a tracked fixture directly
  // (hello.wasc among them) with an untracked file. Persistence is an
  // in-process cache instead — assert that invariant directly so a regression
  // back to disk-writes is caught here rather than as stray git-status noise.
  const { dir, dest } = await freshCartCopy();
  try {
    const host = new WasmcartHost();
    await host.loadMedia({ platform: "wasmcart", path: dest });
    host.setSaveData(new Uint8Array(64).fill(0x5A));
    host.destroy();
    const fs = await import("node:fs");
    assert.ok(!fs.existsSync(dest + ".sav"), "destroy() must not write a .sav file next to the cart");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
