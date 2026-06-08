// C64 keyboard + joyport: the host-side primitives that back input({op:'pressKey'
// /'typeText'/'joyport'}). The patched VICE WASM core exposes romdev_key_matrix /
// romdev_kbdbuf_feed / romdev_joyport_get/set. Many C64 games need KEYBOARD input
// (F1 = 1 player, RUN/STOP, RETURN at setup screens) before joystick gameplay —
// joystick alone can't pass them. Requires the patched core + a test PRG.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "../src/host/LibretroHost.js";
import { prgToD64 } from "../src/platforms/c64/d64.js";

const PRG = "<ROMDEV_TEST_ROM>";
const have = existsSync(PRG);

async function boot() {
  const prg = new Uint8Array(readFileSync(PRG));
  const core = resolveCore("c64");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "c64", bytes: prgToD64(prg, { name: "GAME" }), virtualName: "/g.d64" });
  for (let i = 0; i < 200; i++) host.stepFrames(1);
  return host;
}

test("core exposes the C64 keyboard/joyport exports", { skip: !have, timeout: 60000 }, async () => {
  const host = await boot();
  assert.equal(host.keyboardSupported(), true, "patched VICE core should expose romdev_key_matrix");
});

test("joyport defaults to 2 (most C64 games) and is settable", { skip: !have, timeout: 60000 }, async () => {
  const host = await boot();
  assert.equal(host.getC64JoyPort(), 2, "default C64 joystick port is 2");
  assert.equal(host.setC64JoyPort(1), 1);
  assert.equal(host.getC64JoyPort(), 1, "port switched to 1");
  host.setC64JoyPort(2);
  assert.equal(host.getC64JoyPort(), 2, "port switched back to 2");
  assert.throws(() => host.setC64JoyPort(3), /must be 1 or 2/);
});

test("typeText reaches the C64 kernal keyboard buffer (NDX + $0277)", { skip: !have, timeout: 60000 }, async () => {
  const host = await boot();
  // Feed two chars; the kernal keyboard buffer is at $0277.. with the count in
  // $00C6 (NDX). Reading them proves the keystrokes reached the emulated machine.
  host.typeC64Text("AB");
  const ndx = host.readMemory("system_ram", 0x00C6, 1)[0];
  const buf = host.readMemory("system_ram", 0x0277, 2);
  // The chars LANDING in the kernal buffer is the proof the keystrokes reached
  // the emulated machine. (Whether they then get DRAINED depends on what's
  // running — the BASIC editor drains them; an autostarted game may not run the
  // editor, so we don't assert drain here — that would be testing the test ROM.)
  assert.equal(ndx, 2, "two chars queued in the keyboard buffer");
  assert.equal(buf[0], 0x41, "buffer[0] = 'A' (PETSCII $41)");
  assert.equal(buf[1], 0x42, "buffer[1] = 'B' (PETSCII $42)");
});

test("pressC64Key resolves the matrix position + auto-releases", { skip: !have, timeout: 60000 }, async () => {
  const host = await boot();
  const r = host.pressC64Key("f1", 4);
  assert.deepEqual([r.row, r.col], [0, 4], "F1 is matrix (0,4)");
  assert.equal(r.frames, 4);
  assert.throws(() => host.pressC64Key("nope"), /unknown C64 key/);
});
