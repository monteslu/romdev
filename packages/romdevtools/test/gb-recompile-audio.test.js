// Game Boy recompile audio vs gambatte, sample for sample from power-on.
//
// A synthetic ROM programs all four channels (sweep, envelopes, length,
// wave RAM, 7- and 15-bit noise, NR50/NR51 panning, NR52 off and on again,
// wave RAM and NR52 reads) and keeps retriggering them on a timer. The cart
// (src/analysis/recompile/wat/gb, apu.js) runs in node's WebAssembly; its
// wasmcart ring is compared per frame against what romdev's gambatte hands
// audio_batch_cb (blipper, 32768 Hz). Then the must-fail control: the same
// ROM built with one channel muted through the mixer must NOT match.
//
// Skipped when gambatte is not staged or the gbz80 objdump (IR decode) is
// missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LibretroHost } from "romdev-core-host/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { emitWat, describe } from "../src/analysis/recompile/wat/gb/index.js";
import { assembleWatSync } from "../src/analysis/recompile/wat/assemble.js";
import { objdumpAvailable } from "../src/toolchains/objdump.js";
import { APU_SAMPLE_RATE } from "../src/analysis/recompile/wat/gb/apu.js";

const core = (() => { try { return resolveCore("gb"); } catch { return null; } })();
const skip = !core ? "gambatte not staged" : !objdumpAvailable("gbz80") ? "gbz80 objdump missing" : false;

/** ld a,v ; ldh (reg),a */
const w = (reg, v) => [0x3E, v, 0xE0, reg];

/**
 * A 32KB ROM (CGB-flagged when `cgb`): the sound program at $0150, then a
 * loop that waits on DIV and retriggers channels with changing settings.
 * @param {boolean} cgb
 */
function soundRom(cgb) {
  const r = new Uint8Array(0x8000);
  r.set([0x00, 0xC3, 0x50, 0x01], 0x100);
  r.set([...Buffer.from("APUTEST")], 0x134);
  if (cgb) r[0x143] = 0x80;
  let s = 0;
  for (let i = 0x134; i <= 0x14C; i++) s = (s - r[i] - 1) & 0xFF;
  r[0x14D] = s;
  const wave = [0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF, 0xFE, 0xDC, 0xBA, 0x98, 0x76, 0x54, 0x32, 0x10];
  const main = [
    0xF3, 0x31, 0xF0, 0xDF,            // di ; ld sp,$DFF0
    ...w(0x26, 0x00), ...w(0x26, 0x80),  // NR52 off, on
    ...w(0x24, 0x77), ...w(0x25, 0xF3),  // NR50, NR51
    ...w(0x1A, 0x00),                   // wave DAC off to write wave RAM
    ...wave.flatMap((b, i) => w(0x30 + i, b)),
    ...w(0x10, 0x16), ...w(0x11, 0x80), ...w(0x12, 0xF3), ...w(0x13, 0x40), ...w(0x14, 0x87), // ch1 sweep up
    ...w(0x16, 0x40), ...w(0x17, 0xA1), ...w(0x18, 0x10), ...w(0x19, 0xC6),                   // ch2 length on
    ...w(0x1A, 0x80), ...w(0x1B, 0x20), ...w(0x1C, 0x20), ...w(0x1D, 0x00), ...w(0x1E, 0x87), // ch3
    ...w(0x21, 0xC2), ...w(0x22, 0x3B), ...w(0x23, 0x80),                                      // ch4 7-bit
    0x06, 0x00,                         // ld b,0 (counter)
  ];
  const loop = [
    // wait until DIV bit 7 flips twice, then vary and retrigger
    // L: ldh a,($04) ; and $80 ; jr z,L ; L2: ldh a,($04) ; and $80 ; jr nz,L2
    0xF0, 0x04, 0xE6, 0x80, 0x28, 0xFA, 0xF0, 0x04, 0xE6, 0x80, 0x20, 0xFA,
    0x04,                               // inc b
    0x78, 0xE6, 0x07, 0xF6, 0x40, 0xE0, 0x13,   // ld a,b ; and 7 ; or $40 ; NR13
    0x3E, 0x87, 0xE0, 0x14,             // NR14 trigger
    0x78, 0xE6, 0x30, 0xE0, 0x22,       // NR43 = b & $30 (15-bit noise, varying clock)
    0x3E, 0x80, 0xE0, 0x23,             // NR44 trigger
    0x78, 0x07, 0x07, 0xE6, 0xF0, 0xF6, 0x03, 0xE0, 0x25, // NR51 = (b << 2) & $F0 | 3 (panning)
    0xF0, 0x30, 0x57,                   // ld a,($FF30) (wave RAM while playing) ; ld d,a
    0xF0, 0x26, 0x5F,                   // ld a,($FF26) ; ld e,a
    0x78, 0xE6, 0x1F, 0x20, 0x08,       // every 32nd pass: NR52 off/on and ch3 back on
    ...w(0x26, 0x00), ...w(0x26, 0x80),
    0x18, 0x00,                         // jr +0 (keeps the jr nz target simple)
    ...w(0x24, 0x77), ...w(0x1A, 0x80), ...w(0x1C, 0x40), ...w(0x1E, 0x86), ...w(0x17, 0xF1), ...w(0x19, 0x86),
  ];
  const loopAt = 0x150 + main.length;
  r.set([...main, ...loop, 0xC3, loopAt & 0xFF, loopAt >> 8], 0x150); // jp loop
  return r;
}

/**
 * Run cart and gambatte from power-on; per-frame audio of both.
 * @param {Uint8Array} rom
 * @param {number} frames
 * @param {object} [opts] emitWat options
 */
async function runBoth(rom, frames, opts = {}) {
  const chunks = [];
  for await (const c of emitWat(rom, opts)) chunks.push(c);
  const { instance } = await WebAssembly.instantiate(assembleWatSync(chunks.join("")), {});
  const x = instance.exports;
  const info = x.wc_get_info();
  x.wc_init();
  const u32 = () => new Uint32Array(x.memory.buffer);
  const ring = u32()[(info + 16) >> 2], cap = u32()[(info + 20) >> 2], wp = u32()[(info + 24) >> 2];
  assert.equal(u32()[(info + 52) >> 2], APU_SAMPLE_RATE, "the cart declares gambatte-libretro's rate");
  let rd = 0;
  const cart = [];
  const cartFrame = () => {
    x.wc_render();
    const i16 = new Int16Array(x.memory.buffer), end = u32()[wp >> 2], out = [];
    while (rd !== end) { out.push(i16[(ring >> 1) + rd * 2], i16[(ring >> 1) + rd * 2 + 1]); rd = (rd + 1) % cap; }
    cart.push(out);
  };
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-gbaudio-"));
  const ref = new LibretroHost();
  const refOut = [];
  try {
    const romPath = path.join(dir, "t.gb");
    writeFileSync(romPath, rom);
    await ref.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender, noderawfs: core.noderawfs });
    const run = ref._runCore.bind(ref);
    ref._runCore = function () {
      const before = this.state.audioRing.length;
      const r = run();
      refOut.push(this.state.audioRing.slice(before).flatMap((a) => Array.from(a)));
      this.state.audioRing.length = 0;
      return r;
    };
    await ref.loadMedia({ platform: (rom[0x143] & 0x80) ? "gbc" : "gb", path: romPath });
    const settle = refOut.length;
    for (let k = 0; k < settle; k++) cartFrame();
    for (let k = settle; k < frames; k++) { ref.stepFrames(1); cartFrame(); }
  } finally {
    ref.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
  return { cart, ref: refOut };
}

/** First frame whose audio differs (count or any sample), or -1. */
function firstDiff(a, b) {
  for (let k = 0; k < b.length; k++) {
    if (a[k].length !== b[k].length) return k;
    for (let i = 0; i < b[k].length; i++) if (a[k][i] !== b[k][i]) return k;
  }
  return -1;
}

test("the section declares the audio stream and a four-channel muteMask", () => {
  const a = describe(soundRom(false)).layout.audio;
  assert.equal(a.sampleRate, 32768);
  assert.equal(a.format, "s16");
  assert.deepEqual(a.muteMask.channels, ["ch1", "ch2", "ch3", "ch4"]);
});

for (const cgb of [false, true]) {
  test(`${cgb ? "CGB" : "DMG"}: every sample equals gambatte's for 240 frames, and a muted channel does not`, { skip, timeout: 300000 }, async () => {
    const rom = soundRom(cgb);
    const { cart, ref } = await runBoth(rom, 240);
    let total = 0, loud = 0;
    for (const f of ref) { total += f.length / 2; for (const v of f) if (Math.abs(v) > 256) loud++; }
    assert.ok(total > 240 * 540, `reference produced ${total} sample frames`);
    assert.ok(loud > 10000, `the program is audible (${loud} samples over 256)`);
    const d = firstDiff(cart, ref);
    assert.equal(d, -1, d < 0 ? "" : `frame ${d}: cart ${cart[d].length / 2} samples vs gambatte ${ref[d].length / 2}`);
    for (const ch of ["ch1", "ch3", "ch4"]) {
      const muted = await runBoth(rom, 120, { muteChannels: [ch] });
      assert.notEqual(firstDiff(muted.cart, muted.ref), -1, `muting ${ch} must change the audio`);
    }
  });
}
