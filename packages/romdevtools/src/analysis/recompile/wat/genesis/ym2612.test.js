// Genesis sound output checked against genesis_plus_gx itself: a tiny
// synthetic cart programs the YM2612 from the 68000 (four-operator voices on
// both register parts, every algorithm family, feedback, detune/multiple,
// key scaling, SSG-EG, LFO AM/PM, panning, channel 3 special mode with CSM
// key-on from timer A, key on/off per operator every frame, the DAC with a
// stream of samples, a YM reset through the Z80 reset line) and the PSG, and
// every frame's int16 samples must equal the ones gpgx hands its libretro
// audio callback (findDiverge audio, see ../sms/gpgx-parity.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gpgxParity, divergenceText } from "../sms/gpgx-parity.js";
import { mdSoundLayout, FM_RATIO } from "./ym2612.js";

const T = { timeout: 300000 };

/** 68000 words -> bytes (big-endian). */
const W = (...ws) => ws.flatMap((w) => [(w >> 8) & 0xff, w & 0xff]);
const L = (v) => W((v >>> 16) & 0xffff, v & 0xffff);

/** A Genesis image: SSP $FFFE00, reset $200, `code` at $200, `data` at $1000, an rte for every other vector. */
function mdImage(code, data) {
  const rom = new Uint8Array(0x10000);
  rom.set(L(0x00fffe00), 0);
  rom.set(L(0x200), 4);
  const rte = rom.length - 0x10;
  for (let v = 2; v < 64; v++) rom.set(L(rte), v * 4);
  rom.set(W(0x4e73), rte);
  const text = (off, s) => { for (let i = 0; i < s.length; i++) rom[off + i] = s.charCodeAt(i); };
  text(0x100, "SEGA MEGA DRIVE ");
  text(0x150, "SYNTHETIC TEST CART");
  text(0x190, "J               ");
  text(0x1f0, "JUE             ");
  rom.set(code, 0x200);
  rom.set(data, 0x1000);
  return rom;
}

/** A few-line 68000 assembler: bytes, "label:" strings, ["bcc"|"bccw", opcodeByte, "label"], ["dbf", reg, "label"]. */
function asm(items, org = 0x200) {
  const out = [], labels = {}, fix = [];
  for (const it of items) {
    if (typeof it === "number") { out.push(it); continue; }
    if (typeof it === "string") { labels[it.replace(/:$/, "")] = org + out.length; continue; }
    if (it[0] === "bcc") { fix.push([out.length, it[2], "b"]); out.push(it[1], 0); continue; }
    if (it[0] === "bccw") { out.push(it[1], 0); fix.push([out.length, it[2], "w"]); out.push(0, 0); continue; }
    if (it[0] === "dbf") { out.push(...W(0x51c8 | it[1])); fix.push([out.length, it[2], "w"]); out.push(0, 0); continue; }
    out.push(...it);
  }
  for (const [at, l, k] of fix) {
    const d = labels[l] - (org + (k === "b" ? at + 2 : at));
    if (k === "b") { if (d < -128 || d > 127 || d === 0) throw new Error(`bra.s ${l} out of range`); out[at + 1] = d & 0xff; }
    else { out[at] = (d >> 8) & 0xff; out[at + 1] = d & 0xff; }
  }
  return out;
}

const moveBImm = (v, a) => [...W(0x13fc, v & 0xff), ...L(a)];
const moveWImm = (v, a) => [...W(0x33fc, v & 0xffff), ...L(a)];
const YM0 = 0xa04000, PSG = 0xc00011;

// [part (0 or 2), register, value], $FF ends the table
const VOICES = [
  [0, 0x22, 0x0b], [0, 0x27, 0x00], [0, 0x28, 0x00], [0, 0x28, 0x01], [0, 0x28, 0x02], [0, 0x28, 0x04], [0, 0x28, 0x05], [0, 0x28, 0x06],
  // channel 1: algorithm 2, feedback 6, LFO PM 3, both speakers
  [0, 0x30, 0x71], [0, 0x34, 0x0d], [0, 0x38, 0x33], [0, 0x3c, 0x01],
  [0, 0x40, 0x23], [0, 0x44, 0x2d], [0, 0x48, 0x26], [0, 0x4c, 0x00],
  [0, 0x50, 0x5f], [0, 0x54, 0x99], [0, 0x58, 0x5f], [0, 0x5c, 0x94],
  [0, 0x60, 0x85], [0, 0x64, 0x05], [0, 0x68, 0x05], [0, 0x6c, 0x87],
  [0, 0x70, 0x02], [0, 0x74, 0x02], [0, 0x78, 0x02], [0, 0x7c, 0x02],
  [0, 0x80, 0x11], [0, 0x84, 0x11], [0, 0x88, 0x11], [0, 0x8c, 0xa6],
  [0, 0xb0, 0x32], [0, 0xb4, 0xf3], [0, 0xa4, 0x22], [0, 0xa0, 0x69], [0, 0x28, 0xf0],
  // channel 2: algorithm 7, SSG-EG on every operator, left only
  [0, 0x31, 0x01], [0, 0x35, 0x02], [0, 0x39, 0x03], [0, 0x3d, 0x04],
  [0, 0x41, 0x10], [0, 0x45, 0x18], [0, 0x49, 0x14], [0, 0x4d, 0x1c],
  [0, 0x51, 0x1f], [0, 0x55, 0x1f], [0, 0x59, 0x1f], [0, 0x5d, 0x1f],
  [0, 0x61, 0x0a], [0, 0x65, 0x0c], [0, 0x69, 0x0e], [0, 0x6d, 0x08],
  [0, 0x71, 0x05], [0, 0x75, 0x05], [0, 0x79, 0x05], [0, 0x7d, 0x05],
  [0, 0x81, 0x2f], [0, 0x85, 0x2f], [0, 0x89, 0x2f], [0, 0x8d, 0x2f],
  [0, 0x91, 0x0a], [0, 0x95, 0x0c], [0, 0x99, 0x0e], [0, 0x9d, 0x08],
  [0, 0xb1, 0x3f], [0, 0xb5, 0xa1], [0, 0xa5, 0x1a], [0, 0xa1, 0x20], [0, 0x28, 0xf1],
  // channel 3: special (3-slot) mode frequencies, algorithm 4, CSM key-on from timer A
  [0, 0x32, 0x02], [0, 0x36, 0x03], [0, 0x3a, 0x04], [0, 0x3e, 0x05],
  [0, 0x42, 0x08], [0, 0x46, 0x10], [0, 0x4a, 0x08], [0, 0x4e, 0x10],
  [0, 0x52, 0x1f], [0, 0x56, 0x1f], [0, 0x5a, 0x1f], [0, 0x5e, 0x1f],
  [0, 0x62, 0x10], [0, 0x66, 0x10], [0, 0x6a, 0x10], [0, 0x6e, 0x10],
  [0, 0x82, 0xff], [0, 0x86, 0xff], [0, 0x8a, 0xff], [0, 0x8e, 0xff],
  [0, 0xb2, 0x2c], [0, 0xb6, 0xd2], [0, 0xad, 0x23], [0, 0xa9, 0x10], [0, 0xae, 0x1b], [0, 0xaa, 0x40],
  [0, 0xac, 0x2a], [0, 0xa8, 0x80], [0, 0xa6, 0x12], [0, 0xa2, 0x33],
  [0, 0x24, 0xf0], [0, 0x25, 0x02], [0, 0x27, 0x85],
  // channel 4 (part II): algorithm 4, right only, key scaling and detune
  [2, 0x30, 0x42], [2, 0x34, 0x13], [2, 0x38, 0x61], [2, 0x3c, 0x22],
  [2, 0x40, 0x20], [2, 0x44, 0x08], [2, 0x48, 0x20], [2, 0x4c, 0x08],
  [2, 0x50, 0xdf], [2, 0x54, 0x5f], [2, 0x58, 0x9f], [2, 0x5c, 0x1f],
  [2, 0x60, 0x03], [2, 0x64, 0x04], [2, 0x68, 0x05], [2, 0x6c, 0x06],
  [2, 0x80, 0x0f], [2, 0x84, 0x1f], [2, 0x88, 0x2f], [2, 0x8c, 0x3f],
  [2, 0xb0, 0x04], [2, 0xb4, 0x57], [2, 0xa4, 0x14], [2, 0xa0, 0x44], [0, 0x28, 0xf4],
  // the DAC replaces channel 6
  [0, 0x2b, 0x80],
];

function program(voices) {
  const table = [...voices.flat(), 0xff];
  const code = asm([
    ...moveWImm(0x100, 0xa11100), ...moveWImm(0x100, 0xa11200), // Z80 bus request, then reset released: 68000 owns the YM
    ...moveBImm(0x90, PSG), ...moveBImm(0xa4, PSG), ...moveBImm(0x03, PSG), ...moveBImm(0xb6, PSG), ...moveBImm(0xe5, PSG), ...moveBImm(0xf2, PSG),
    ...W(0x41f9), ...L(0x1000), // lea table,a0
    "wl:",
    ...W(0x1018), ...W(0x0c00, 0x00ff), ["bcc", 0x67, "done"], // move.b (a0)+,d0; cmpi.b #$FF,d0; beq done
    ...W(0x43f9), ...L(YM0), ...W(0x0240, 0x00ff), ...W(0xd2c0), // lea $A04000,a1; andi.w #$FF,d0; adda.w d0,a1
    ...W(0x1298), ...W(0x1358, 0x0001), ["bcc", 0x60, "wl"], // move.b (a0)+,(a1); move.b (a0)+,1(a1); bra wl
    "done:",
    "loop:",
    ...W(0x5207), // addq.b #1,d7
    ...moveBImm(0xa0, YM0), ...W(0x13c7), ...L(YM0 + 1), // ch1 fnum low from the counter
    ...moveBImm(0x28, YM0), ...W(0x1207), ...W(0x0201, 0x00f0), ...W(0x0001, 0x0001), ...W(0x13c1), ...L(YM0 + 1), // ch2 operator keys
    ...moveBImm(0x22, YM0), ...W(0x1207), ...W(0x0201, 0x000f), ...W(0x13c1), ...L(YM0 + 1), // LFO on/off and rate
    ...W(0x1207), ...W(0x0201, 0x000f), ...W(0x0001, 0x0080), ...W(0x13c1), ...L(PSG), // tone 0 low bits
    ...W(0x1207), ...W(0xe609), ...W(0x0001, 0x00e0), ...W(0x13c1), ...L(PSG), // noise control (lsr.b #3,d1)
    ...moveBImm(0x2a, YM0), ...W(0x7a3f), // DAC: 64 samples a frame
    "dac:", ...W(0x13c6), ...L(YM0 + 1), ...W(0x0606, 0x000b), ["dbf", 5, "dac"],
    ...W(0x3039), ...L(0xc00004), ...W(0x0800, 3, 0x66f4), // wait until out of vblank
    ...W(0x3039), ...L(0xc00004), ...W(0x0800, 3, 0x67f4), // wait until vblank
    ...W(0x0c07, 0x0080), ["bccw", 0x66, "loop"], // cmpi.b #$80,d7; bne loop
    // frame 128: reset the Z80 (and so the YM2612), release it, reprogram
    ...moveWImm(0x000, 0xa11200), ...moveWImm(0x100, 0xa11200), ...W(0x41f9), ...L(0x1000), ["bccw", 0x60, "wl"],
  ]);
  return mdImage(code, table);
}

test("the sound state fits between the ABI block and the Z80 tables; one YM sample is 1008 master cycles", () => {
  const lay = mdSoundLayout(0xed000);
  assert.ok(lay.end <= 0x100000, `sound state ends at 0x${lay.end.toString(16)}`);
  assert.equal(FM_RATIO, 1008);
});

test("YM2612 + PSG from the 68000 are sample-exact with genesis_plus_gx", T, async () => {
  const r = await gpgxParity({ platform: "genesis", rom: program(VOICES), maxFrames: 200, audio: true });
  assert.equal(r.diverged, false, divergenceText(r));
  assert.equal(r.audio?.compared, true, "audio was compared");
  assert.equal(r.audio?.referenceSilent, false, "the reference produced sound");
});

test("control: one operator's total level different in the reference must fail", T, async () => {
  const other = VOICES.map(([p, r, v]) => (p === 0 && r === 0x44 ? [p, r, v + 1] : [p, r, v]));
  const r = await gpgxParity({ platform: "genesis", rom: program(VOICES), refRom: program(other), maxFrames: 30, audio: true });
  assert.equal(r.diverged, true, "a one-step TL difference must diverge");
  assert.ok(r.audio?.refFrame != null, `the divergence is in the audio: ${divergenceText(r)}`);
});
