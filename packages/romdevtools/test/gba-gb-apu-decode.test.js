// Unit tests for the Game Boy (DMG/CGB) and Game Boy Advance APU register
// decoders. We synthesize the raw register pages (`gb_io` 128 bytes, and the
// `gba_io_regs` 0x400-byte IO page) with known values and assert the decoded
// per-channel musical state — freqHz, note, duty, volume, panning, etc.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeGbApu, decodeGbaApu, freqToNote } from "romdev-core-host/gb-apu-state.js";

/** Build a 128-byte gb_io page from a sparse {offset:value} map. */
function gbIo(map) {
  const r = new Uint8Array(128);
  for (const [k, v] of Object.entries(map)) r[Number(k)] = v;
  return r;
}

/** Build a 0x400-byte gba_io_regs page from a sparse {byteOffset:value} map. */
function gbaIo(map) {
  const r = new Uint8Array(0x400);
  for (const [k, v] of Object.entries(map)) r[Number(k)] = v;
  return r;
}

/** Write a 16-bit little-endian value into a byte array at offset. */
function w16(arr, off, val) {
  arr[off] = val & 0xff;
  arr[off + 1] = (val >> 8) & 0xff;
}

// freq11 = 1750 -> 131072/(2048-1750) = ~439.8 Hz = A4 on a pulse channel.
const A4_F11 = 1750;

test("freqToNote: A4 = 440 Hz, and zero/non-finite -> null", () => {
  assert.equal(freqToNote(440), "A4");
  assert.equal(freqToNote(523.25), "C5");
  assert.equal(freqToNote(0), null);
  assert.equal(freqToNote(Infinity), null);
});

test("GB pulse1: freq11 1750 + duty 50% -> ~A4, enabled, with sweep + master vol", () => {
  const io = gbIo({
    0x10: (0x05 << 4) | 0x08 | 0x03, // NR10: sweep period 5, negate, shift 3
    0x11: 0x80,                      // NR11: duty=2 (50%)
    0x12: 0xF0,                      // NR12: initial volume 15
    0x13: A4_F11 & 0xFF,             // NR13: freq lo
    0x14: 0x40 | ((A4_F11 >> 8) & 0x07), // NR14: length-enable + freq hi
    0x24: (0x05 << 4) | 0x03,        // NR50: left vol 5, right vol 3
    0x25: 0xF3,                      // NR51: panning
    0x26: 0x80 | 0x01,               // NR52: APU on, channel 1 status
  });
  const a = decodeGbApu(io);
  assert.equal(a.enabled, true);
  const p1 = a.channels.pulse1;
  assert.equal(p1.enabled, true);
  assert.equal(p1.note, "A4");
  assert.ok(Math.abs(p1.freqHz - 439.84) < 0.5);
  assert.equal(p1.duty, 2);
  assert.equal(p1.dutyLabel, "50%");
  assert.equal(p1.volume, 15);
  assert.equal(p1.lengthEnable, true);
  assert.deepEqual(p1.sweep, { period: 5, shift: 3, negate: true });
  assert.deepEqual(a.masterVolume, { left: 5, right: 3 });
  assert.equal(a.panning, "0xf3");
  assert.equal(a.nr52, "0x81");
});

test("GB pulse2: duty 25%, volume 10, status bit, no sweep field", () => {
  const io = gbIo({
    0x16: 0x40,        // NR21: duty=1 (25%)
    0x17: 0xA0,        // NR22: initial volume 10
    0x18: 0x00,        // NR23
    0x19: 0x04,        // NR24: freq hi -> freq11 = 0x400 = 1024
    0x26: 0x80 | 0x02, // NR52: APU on, channel 2 status
  });
  const a = decodeGbApu(io);
  const p2 = a.channels.pulse2;
  assert.equal(p2.enabled, true);
  assert.equal(p2.duty, 1);
  assert.equal(p2.dutyLabel, "25%");
  assert.equal(p2.volume, 10);
  assert.equal(p2.note, "C3"); // 131072/(2048-1024) = 128 Hz = C3
  assert.equal(a.channels.pulse1.enabled, false);
  assert.equal(p2.sweep, undefined); // pulse2 has no sweep
});

test("GB wave: 65536-based freq formula + volume-shift code", () => {
  // freq11 1899 -> 65536/(2048-1899) = ~439.8 Hz = A4 on the wave channel.
  const f11 = 1899;
  const io = gbIo({
    0x1A: 0x80,         // NR30: DAC on
    0x1C: (0x02 << 5),  // NR32: volume shift 2 (50%)
    0x1D: f11 & 0xFF,   // NR33
    0x1E: 0x40 | ((f11 >> 8) & 0x07), // NR34: length-enable + freq hi
    0x26: 0x80 | 0x04,  // NR52: APU on, channel 3 status
  });
  const a = decodeGbApu(io);
  const w = a.channels.wave;
  assert.equal(w.enabled, true);
  assert.equal(w.dacOn, true);
  assert.equal(w.note, "A4");
  assert.ok(Math.abs(w.freqHz - 439.84) < 0.5);
  assert.equal(w.volumeShift, 2);
  assert.equal(w.volumeLabel, "50%");
  assert.equal(w.lengthEnable, true);
});

test("GB noise: divisor / shift-clock / width-mode decode + power off", () => {
  const io = gbIo({
    0x21: 0xC0,               // NR42: initial volume 12
    0x22: (0x07 << 4) | 0x08 | 0x05, // NR43: shiftClock 7, width 1, divisor 5
    0x23: 0x40,               // NR44: length-enable
    0x26: 0x00,               // NR52: APU powered off (no status bits)
  });
  const a = decodeGbApu(io);
  assert.equal(a.enabled, false);
  const n = a.channels.noise;
  assert.equal(n.enabled, false); // status bit 3 clear
  assert.equal(n.volume, 12);
  assert.equal(n.divisorCode, 5);
  assert.equal(n.shiftClock, 7);
  assert.equal(n.widthMode, 1);
  assert.equal(n.lengthEnable, true);
});

test("GBA: PSG pulse1 reuses the GB formula at the GBA offsets", () => {
  const io = gbaIo({});
  // SOUND1CNT_L = sweep ($60); SOUND1CNT_H low=duty/len, high=vol/env ($62);
  // SOUND1CNT_X low=freq lo, high=freq hi+trigger ($64).
  io[0x60] = (0x04 << 4) | 0x02; // sweep period 4, shift 2, positive
  w16(io, 0x62, 0x80 | (0x0F << 12)); // duty=2 (bit7 of low byte) + vol 15 (high byte bits 4-7)
  w16(io, 0x64, 0x4000 | A4_F11);     // freq hi byte bit6 = length enable, freq11 in low 11 bits
  w16(io, 0x84, 0x80 | 0x01);         // SOUNDCNT_X: master enable + channel 1 status
  const a = decodeGbaApu(io);
  assert.equal(a.enabled, true);
  const p1 = a.psg.pulse1;
  assert.equal(p1.enabled, true);
  assert.equal(p1.note, "A4");
  assert.ok(Math.abs(p1.freqHz - 439.84) < 0.5);
  assert.equal(p1.duty, 2);
  assert.equal(p1.volume, 15);
  assert.equal(p1.lengthEnable, true);
  assert.deepEqual(p1.sweep, { period: 4, shift: 2, negate: false });
});

test("GBA: wave channel uses 65536 formula at SOUND3CNT offsets", () => {
  const io = gbaIo({});
  const f11 = 1750; // 65536/(2048-1750) = ~219.9 Hz = A3 on the wave channel
  w16(io, 0x70, 0x0080);            // SOUND3CNT_L: DAC on (bit7 of low byte = NR30)
  w16(io, 0x72, (0x02 << 5) << 8);  // SOUND3CNT_H high byte = NR32, vol-shift 2
  w16(io, 0x74, 0x4000 | f11);      // SOUND3CNT_X: length-enable + freq11
  w16(io, 0x84, 0x80 | 0x04);       // SOUNDCNT_X: master enable + channel 3 status
  const a = decodeGbaApu(io);
  const w = a.psg.wave;
  assert.equal(w.enabled, true);
  assert.equal(w.dacOn, true);
  assert.equal(w.note, "A3");
  assert.ok(Math.abs(w.freqHz - 219.92) < 0.5);
  assert.equal(w.volumeShift, 2);
  assert.equal(w.volumeLabel, "50%");
});

test("GBA: Direct Sound A/B + PSG volume + bias decode from SOUNDCNT", () => {
  const io = gbaIo({});
  // SOUNDCNT_L: right PSG vol 4 (bits 0-2), left PSG vol 6 (bits 4-6).
  w16(io, 0x80, 0x04 | (0x06 << 4));
  // SOUNDCNT_H: DS-A nibble at bits 8-11, DS-B at bits 12-15.
  //  A: right(1) + left(2) enabled, timer 0, reset 0 -> nibble 0b0011 = 0x3
  //     plus DMA volume bit2 set => A volume 100%.
  //  B: left(2) enabled, timer 1 (bit2 of nibble), reset 1 -> 0b1110 = 0xE
  //     DMA volume bit3 clear => B volume 50%.
  w16(io, 0x82, 0x0004 | (0x3 << 8) | (0xE << 12));
  w16(io, 0x84, 0x80);   // SOUNDCNT_X: master enable
  w16(io, 0x88, 0x0200); // SOUNDBIAS
  const a = decodeGbaApu(io);
  assert.deepEqual(a.psgVolume, { right: 4, left: 6 });
  assert.deepEqual(a.directSound.a, {
    enable: { right: true, left: true }, timer: 0, reset: false, volume: "100%",
  });
  assert.deepEqual(a.directSound.b, {
    enable: { right: false, left: true }, timer: 1, reset: true, volume: "50%",
  });
  assert.equal(a.soundBias, "0x0200");
  assert.equal(a.soundcntX, "0x0080");
});
