// SRAM (cartridge battery save) support, folded into existing tools — no new
// top-level tool. Live read/write is memory({region:'save_ram'}); persistence is
// state({op:'exportSram'/'importSram'}); presence is cart({op:'identify'}).saveRam.
// Cores already expose RETRO_MEMORY_SAVE_RAM (verified by source) — these tests
// cover the JS fold + the honest "no battery save" path.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "romdev-core-host/LibretroHost.js";
import { identifyFile } from "../src/rom-id/identifier.js";
import { buildExampleRom } from "./build-fixture-rom.js";

// A battery-SRAM NES cart built from our OWN example: the example already sets
// the iNES battery bit (flags6 bit 1), so the core exposes a real 8KB SAVE_RAM
// region. No external/commercial ROM needed — these run unconditionally.
let DW;
before(async () => {
  const base = await readFile(await buildExampleRom("nes"));
  const rom = Buffer.from(base);
  rom[6] |= 0x02; // ensure the battery bit is set
  DW = path.join(tmpdir(), `sram-battery-${process.pid}.nes`);
  await writeFile(DW, rom);
});

test("cart identify reports saveRam.hasBattery + bytes (battery NES cart)", async () => {
  const id = await identifyFile(DW);
  assert.ok(id.saveRam, "no saveRam field");
  assert.equal(id.saveRam.hasBattery, true);
  assert.equal(id.saveRam.bytes, 8192);
});

test("identify: a non-battery NES (password) cart reports saveRam.hasBattery=false", async () => {
  // synthetic iNES header: flags6 with the battery bit CLEAR (a non-battery cart)
  const b = Buffer.alloc(16 + 16384 + 8192);
  b[0]=0x4e;b[1]=0x45;b[2]=0x53;b[3]=0x1a;b[4]=1;b[5]=1;b[6]=0x10; // mapper1, no battery
  const { identifyBytes } = await import("../src/rom-id/identifier.js");
  const id = identifyBytes(b, ".nes");
  assert.equal(id.platform, "nes");
  assert.equal(id.saveRam.hasBattery, false);
  assert.equal(id.saveRam.bytes, 0);
});

test("SAVE_RAM live read/write + exportSram→importSram round-trip (NES battery)", { timeout: 120000 }, async () => {
  const core = resolveCore("nes");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "nes", path: DW });
  for (let i = 0; i < 60; i++) host.stepFrames(1);

  const size = host.regionSize("save_ram");
  assert.equal(size, 8192, "battery cart SAVE_RAM should be 8192");

  // live write/read
  const before = host.readMemory("save_ram", 0, 1)[0];
  host.writeMemory("save_ram", 0, new Uint8Array([before ^ 0x5A]));
  assert.equal(host.readMemory("save_ram", 0, 1)[0], before ^ 0x5A, "live SRAM write didn't stick");

  // export the whole blob, mutate live, import it back, confirm restore
  const blob = host.readMemory("save_ram", 0, size);
  const sav = path.join(tmpdir(), "sram-test.sav");
  await import("node:fs/promises").then(fs => fs.writeFile(sav, Buffer.from(blob)));
  try {
    host.writeMemory("save_ram", 0, new Uint8Array([0xAB]));         // corrupt live
    const loaded = new Uint8Array(await readFile(sav));
    host.writeMemory("save_ram", 0, loaded);                          // import
    assert.equal(host.readMemory("save_ram", 0, 1)[0], blob[0], "importSram didn't restore byte 0");
    assert.equal(loaded.length, size, "exported .sav size mismatch");
  } finally {
    await rm(sav, { force: true });
  }
});

test("empty save_ram gives an HONEST message on a no-battery system (atari7800)", { timeout: 60000 }, async () => {
  const a78 = await buildExampleRom("atari7800");
  const core = resolveCore("atari7800");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "atari7800", path: a78 });
  for (let i = 0; i < 30; i++) host.stepFrames(1);
  assert.equal(host.regionSize("save_ram"), 0);
  assert.throws(() => host.readMemory("save_ram", 0, 1), /no cartridge battery saves/i,
    "atari7800 empty-SRAM error should say the hardware has no battery saves");
});
