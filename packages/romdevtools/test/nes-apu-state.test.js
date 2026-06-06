// Unit tests for the NES 2A03 APU register decoder. We synthesize the
// 24-byte `nes_apu_regs` snapshot (layout per the fceumm patch) with known
// register values and assert the decoded musical state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeNesApu, hzToMidi } from "../src/host/nes-apu-state.js";

/** Build a 24-byte APU snapshot from a sparse {offset:value} map. */
function apuRegs(map) {
  const r = new Uint8Array(24);
  for (const [k, v] of Object.entries(map)) r[Number(k)] = v;
  return r;
}

test("hzToMidi: A4 = 440 Hz = MIDI 69", () => {
  const m = hzToMidi(440);
  assert.equal(m.midi, 69);
  assert.equal(m.name, "A4");
  assert.equal(m.cents, 0);
});

test("hzToMidi: sub-audible / zero returns null", () => {
  assert.equal(hzToMidi(0), null);
  assert.equal(hzToMidi(10), null);
});

test("pulse1: timer 254 + duty 50% decodes to ~A4, enabled & playing", () => {
  const regs = apuRegs({
    0x00: 0x80 | 0x10 | 0x0A, // duty=2 (50%), constant volume, vol=10
    0x02: 254 & 0xFF,         // timer low
    0x03: (254 >> 8) & 0x07,  // timer high (=0)
    0x15: 0x01,               // pulse1 enabled
  });
  const a = decodeNesApu(regs);
  assert.equal(a.pulse1.timer, 254);
  assert.equal(a.pulse1.duty, 2);
  assert.equal(a.pulse1.dutyLabel, "50%");
  assert.equal(a.pulse1.constantVolume, true);
  assert.equal(a.pulse1.volume, 10);
  assert.equal(a.pulse1.note, "A4");
  assert.equal(a.pulse1.midi, 69);
  assert.equal(a.pulse1.enabled, true);
  assert.equal(a.pulse1.playing, true);
  assert.ok(Math.abs(a.pulse1.freq - 438.67) < 0.5);
});

test("pulse2 reads from $4004-$4007 independently of pulse1", () => {
  const regs = apuRegs({
    0x04: 0x00,        // duty=0 (12.5%), envelope mode, vol period 0
    0x06: 0x00,
    0x07: 0x02,        // timer = 0x200 = 512
    0x15: 0x02,        // pulse2 enabled (pulse1 NOT)
  });
  const a = decodeNesApu(regs);
  assert.equal(a.pulse1.enabled, false);
  assert.equal(a.pulse2.enabled, true);
  assert.equal(a.pulse2.timer, 512);
  assert.equal(a.pulse2.duty, 0);
  assert.equal(a.pulse2.dutyLabel, "12.5%");
});

test("pulse timer < 8 is silenced (freq null, not playing)", () => {
  const regs = apuRegs({ 0x02: 0x05, 0x03: 0x00, 0x15: 0x01 });
  const a = decodeNesApu(regs);
  assert.equal(a.pulse1.timer, 5);
  assert.equal(a.pulse1.freq, null);
  assert.equal(a.pulse1.note, null);
  assert.equal(a.pulse1.playing, false);
});

test("triangle: same timer plays one octave below a pulse", () => {
  const regs = apuRegs({
    0x08: 0x7F,        // control=0, linearReload=0x7F (loaded)
    0x0A: 254 & 0xFF,
    0x0B: 0x00,
    0x15: 0x04,        // triangle enabled
  });
  const a = decodeNesApu(regs);
  assert.equal(a.triangle.timer, 254);
  assert.equal(a.triangle.note, "A3"); // one octave below the pulse A4
  assert.equal(a.triangle.enabled, true);
  assert.equal(a.triangle.playing, true);
  assert.equal(a.triangle.linearReload, 0x7F);
});

test("noise: period index + mode flag decode", () => {
  const regs = apuRegs({
    0x0C: 0x10 | 0x08, // constant volume, vol=8
    0x0E: 0x80 | 0x05, // mode=periodic (bit7), period index 5
    0x15: 0x08,        // noise enabled
  });
  const a = decodeNesApu(regs);
  assert.equal(a.noise.enabled, true);
  assert.equal(a.noise.period, 5);
  assert.equal(a.noise.mode, "periodic");
  assert.equal(a.noise.volume, 8);
  assert.equal(a.noise.constantVolume, true);
  assert.equal(a.noise.playing, true);
});

test("dmc: rate / address / length / flags decode", () => {
  const regs = apuRegs({
    0x10: 0x80 | 0x40 | 0x0F, // IRQ enabled, loop, rate index 15
    0x11: 0x40,               // direct load 64
    0x12: 0x10,               // sample address = $C000 + 0x10*64 = $C400
    0x13: 0x02,               // sample length = 2*16 + 1 = 33
    0x15: 0x10,               // dmc enabled
  });
  const a = decodeNesApu(regs);
  assert.equal(a.dmc.enabled, true);
  assert.equal(a.dmc.irqEnabled, true);
  assert.equal(a.dmc.loop, true);
  assert.equal(a.dmc.rateIndex, 15);
  assert.equal(a.dmc.directLoad, 64);
  assert.equal(a.dmc.sampleAddress, 0xC400);
  assert.equal(a.dmc.sampleLength, 33);
});

test("status + frame counter bits", () => {
  const regs = apuRegs({ 0x15: 0x1F, 0x17: 0x80 | 0x40 });
  const a = decodeNesApu(regs);
  assert.deepEqual(a.status, {
    pulse1: true, pulse2: true, triangle: true, noise: true, dmc: true,
  });
  assert.equal(a.frameCounter.mode, 5);
  assert.equal(a.frameCounter.irqInhibit, true);
});

test("disabled channels report enabled:false and playing:false", () => {
  const regs = apuRegs({
    0x00: 0x9A, 0x02: 0xFD, 0x03: 0x00, // pulse1 has a valid note...
    0x15: 0x00,                          // ...but $4015 disables everything
  });
  const a = decodeNesApu(regs);
  assert.equal(a.pulse1.enabled, false);
  assert.equal(a.pulse1.playing, false);
  // freq/note still decode from the register (useful for "what WOULD it play")
  assert.equal(a.pulse1.note, "A4");
});

test("regsHex round-trips the snapshot", () => {
  const regs = apuRegs({ 0x00: 0xDE, 0x17: 0xAD });
  const a = decodeNesApu(regs);
  assert.equal(a.regsHex.length, 48); // 24 bytes × 2 hex chars
  assert.ok(a.regsHex.startsWith("de"));
  assert.ok(a.regsHex.endsWith("ad"));
});
