// C64 keyboard + joyport: the host-side primitives that back input({op:'pressKey'
// /'typeText'/'joyport'}). The patched VICE WASM core exposes romdev_key_matrix /
// romdev_kbdbuf_feed / romdev_joyport_get/set. Many C64 games need KEYBOARD input
// (F1 = 1 player, RUN/STOP, RETURN at setup screens) before joystick gameplay —
// joystick alone can't pass them. Requires the patched core + a test PRG.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "../src/host/LibretroHost.js";
import { prgToD64 } from "../src/platforms/c64/d64.js";
import { C64_HOMEBREW_PRG } from "./rom-fixtures.js";

const PRG = C64_HOMEBREW_PRG;
const have = !!PRG;

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

test("controller buttons map to C64 keys via setInput (Batocera/RetroDeck model)", { skip: !have, timeout: 60000 }, async () => {
  const host = await boot();
  // Instrument the matrix call so we can see press/release without depending on
  // a kernal var an autostarted game might clobber.
  const orig = host.mod._romdev_key_matrix.bind(host.mod);
  const calls = [];
  host.mod._romdev_key_matrix = (r, c, p) => { calls.push([r, c, p]); return orig(r, c, p); };

  // A keyboard-mapped button (west = Space, matrix (7,4)) presses the key...
  host.setInput({ ports: [{ west: true }, {}] });
  assert.deepEqual(calls.at(-1), [7, 4, 1], "west → Space pressed");
  // ...and releasing it releases the key (edge-tracked).
  calls.length = 0;
  host.setInput({ ports: [{}, {}] });
  assert.deepEqual(calls.at(-1), [7, 4, 0], "west released → Space released");

  // The right-stick virtual button c64_f1 → F1 (0,4) — the 1-player selector.
  calls.length = 0;
  host.setInput({ ports: [{ c64_f1: true }, {}] });
  assert.deepEqual(calls.at(-1), [0, 4, 1], "c64_f1 → F1 pressed");

  // The JOYSTICK (d-pad + Fire) does NOT press any key — it stays a joypad.
  host.setInput({ ports: [{}, {}] });   // release everything first
  calls.length = 0;
  host.setInput({ ports: [{ up: true, b: true }, {}] });
  assert.equal(calls.length, 0, "joystick up+Fire presses no C64 key");
  assert.notEqual(host.state.inputPorts[0][0], 0, "joystick reaches the joypad mask");
});
