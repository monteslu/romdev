// Unit tests for the C64 SID and GBA visual-debug decoders. We synthesize the
// raw register / OAM / palette regions with known values and assert the
// decoded musical + visual state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeC64Sid, freqToNote } from "../src/host/c64-sid-state.js";
import {
  decodeGbaSprites,
  decodeGbaPalette,
  decodeGbaRenderingContext,
} from "../src/host/gba-video-state.js";

// ── helpers ────────────────────────────────────────────────────────────

/** Build a 29-byte SID snapshot from a sparse {offset:value} map. */
function sidRegs(map) {
  const r = new Uint8Array(29);
  for (const [k, v] of Object.entries(map)) r[Number(k)] = v;
  return r;
}

// SID: pick the 16-bit freq register value that yields ~440 Hz on PAL.
// freqHz = reg16 * (985248 / 2^24)  =>  reg16 = 440 / (985248 / 16777216)
const SID_REG_FOR_A4 = Math.round(440 / (985248 / 16777216)); // ≈ 7493

// ── TASK A: C64 SID ──────────────────────────────────────────────────────

test("freqToNote: A4 = 440 Hz, C4 = 261.63 Hz, invalid → null", () => {
  assert.equal(freqToNote(440), "A4");
  assert.equal(freqToNote(261.63), "C4");
  assert.equal(freqToNote(277.18), "C#4");
  assert.equal(freqToNote(0), null);
  assert.equal(freqToNote(-5), null);
});

test("decodeC64Sid: voice 0 known freq → A4, waveform + gate + ADSR decode", () => {
  const regs = sidRegs({
    0x00: SID_REG_FOR_A4 & 0xff,        // freq lo
    0x01: (SID_REG_FOR_A4 >> 8) & 0xff, // freq hi
    0x02: 0x00,                         // PW lo
    0x03: 0x08,                         // PW hi (12-bit PW = 0x800)
    0x04: 0x40 | 0x01,                  // control: pulse waveform + gate
    0x05: 0x29,                         // attack=2, decay=9
    0x06: 0xA5,                         // sustain=10, release=5
  });
  const d = decodeC64Sid(regs);
  const v0 = d.voices[0];
  assert.equal(v0.note, "A4");
  assert.ok(Math.abs(v0.freqHz - 440) < 1);
  assert.deepEqual(v0.waveform, ["pulse"]);
  assert.equal(v0.gate, true);
  assert.equal(v0.sync, false);
  assert.equal(v0.pulseWidth, 0x800);
  assert.deepEqual(v0.adsr, { attack: 2, decay: 9, sustain: 10, release: 5 });
});

test("decodeC64Sid: voices are independent + globals (filter/volume/v3off)", () => {
  const regs = sidRegs({
    // voice 1 base = 7, control = base+4 = 0x0B: noise + ring + test, no gate
    0x0b: 0x80 | 0x04 | 0x08,
    // voice 2 base = 14, control = base+4 = 0x12: triangle + sawtooth combined
    0x12: 0x10 | 0x20,
    0x15: 0x05,        // cutoff lo (low 3 bits = 5)
    0x16: 0x10,        // cutoff hi
    0x17: 0xA3,        // resonance=0xA, route voices 1 & 2 (bits 0,1)
    0x18: 0x0F | 0x20 | 0x80, // master volume 0xF, bandpass (bit5), voice3 off (bit7)
  });
  const d = decodeC64Sid(regs);
  assert.deepEqual(d.voices[1].waveform, ["noise"]);
  assert.equal(d.voices[1].ringMod, true);
  assert.equal(d.voices[1].test, true);
  assert.deepEqual(d.voices[2].waveform, ["triangle", "sawtooth"]);
  assert.equal(d.masterVolume, 0xf);
  assert.equal(d.voice3Off, true);
  assert.deepEqual(d.filter.mode, ["bandpass"]);
  assert.equal(d.filter.cutoff, (0x10 << 3) | 0x05);
  assert.equal(d.filter.resonance, 0xa);
  assert.deepEqual(d.filter.routedVoices, [true, true, false]);
});

// ── TASK B: GBA sprites ──────────────────────────────────────────────────

/** Build a 0x400-byte OAM with one sprite at slot `i` from attr0/1/2. */
function oamWith(i, attr0, attr1, attr2) {
  const oam = new Uint8Array(0x400);
  const o = i * 8;
  oam[o + 0] = attr0 & 0xff;
  oam[o + 1] = (attr0 >> 8) & 0xff;
  oam[o + 2] = attr1 & 0xff;
  oam[o + 3] = (attr1 >> 8) & 0xff;
  oam[o + 4] = attr2 & 0xff;
  oam[o + 5] = (attr2 >> 8) & 0xff;
  return oam;
}

test("decodeGbaSprites: known attrs → x/y/size/tile/palette/priority/flip", () => {
  // attr0: Y=50, shape=1 (wide). attr1: X=100, size=2 → 32x16, Hflip set.
  // attr2: tile=0x040, priority=2, palette=5.
  const attr0 = 50 | (1 << 14);
  const attr1 = 100 | (2 << 14) | 0x1000; // size 2, Hflip
  const attr2 = 0x040 | (2 << 10) | (5 << 12);
  const oam = oamWith(0, attr0, attr1, attr2);
  const { sprites, count } = decodeGbaSprites(oam);
  assert.equal(count, 128);
  const s = sprites[0];
  assert.equal(s.y, 50);
  assert.equal(s.x, 100);
  assert.deepEqual(s.size, { w: 32, h: 16 });
  assert.equal(s.tile, 0x040);
  assert.equal(s.priority, 2);
  assert.equal(s.palette, 5);
  assert.equal(s.flipH, true);
  assert.equal(s.flipV, false);
  assert.equal(s.affine, false);
  assert.equal(s.visible, true);
});

test("decodeGbaSprites: 9-bit X sign-extends; bit9 hides non-affine sprite", () => {
  // X = -8 → 9-bit two's complement = 0x1F8. Non-affine + bit9 (disable).
  const attr0 = 20 | 0x200; // bit9 set, bit8 clear → disabled
  const attr1 = 0x1f8;      // X = -8
  const oam = oamWith(3, attr0, attr1, 0x000);
  const { sprites } = decodeGbaSprites(oam);
  const s = sprites[3];
  assert.equal(s.x, -8);
  assert.equal(s.visible, false);
  assert.equal(s.affine, false);
});

test("decodeGbaSprites: affine bit9 is double-size, NOT hidden; slots/maxSlots honored", () => {
  // Affine sprite (bit8) with bit9 set → double-size, still visible.
  const attr0 = 40 | 0x100 | 0x200;
  const oam = oamWith(2, attr0, 0, 0);
  // also put a sprite at slot 0 so maxSlots/slots filtering is observable
  oam[0] = 10;
  const affineOnly = decodeGbaSprites(oam, { slots: [2] });
  assert.equal(affineOnly.count, 1);
  assert.equal(affineOnly.sprites[0].slot, 2);
  assert.equal(affineOnly.sprites[0].affine, true);
  assert.equal(affineOnly.sprites[0].visible, true);

  const firstTwo = decodeGbaSprites(oam, { maxSlots: 2 });
  assert.equal(firstTwo.count, 2);
  assert.deepEqual(firstTwo.sprites.map((s) => s.slot), [0, 1]);
});

// ── TASK B: GBA palette ──────────────────────────────────────────────────

test("decodeGbaPalette: BGR555 → 8-bit rgb + hex; bg/obj/all ranges", () => {
  const pal = new Uint8Array(0x400);
  // entry 1 = pure red (R=31): 0b0000000000011111 = 0x001F
  pal[2] = 0x1f;
  pal[3] = 0x00;
  // entry 257 (OBJ) = pure blue (B=31): 0b0111110000000000 = 0x7C00
  pal[257 * 2] = 0x00;
  pal[257 * 2 + 1] = 0x7c;

  const bg = decodeGbaPalette(pal, "bg");
  assert.equal(bg.entries.length, 256);
  const red = bg.entries[1];
  assert.deepEqual({ r: red.r, g: red.g, b: red.b }, { r: 255, g: 0, b: 0 });
  assert.equal(red.hex, "#ff0000");

  const obj = decodeGbaPalette(pal, "obj");
  assert.equal(obj.entries.length, 256);
  assert.equal(obj.entries[0].index, 256);
  const blue = obj.entries.find((e) => e.index === 257);
  assert.deepEqual({ r: blue.r, g: blue.g, b: blue.b }, { r: 0, g: 0, b: 255 });
  assert.equal(blue.hex, "#0000ff");

  const all = decodeGbaPalette(pal, "all");
  assert.equal(all.entries.length, 512);
  assert.equal(all.entries[1].set, "bg");
  assert.equal(all.entries.find((e) => e.index === 257).set, "obj");
});

// ── TASK B: GBA rendering context ────────────────────────────────────────

/** Build a 0x400-byte IO page with u16 writes from a sparse {offset:value}. */
function ioRegs(map) {
  const io = new Uint8Array(0x400);
  for (const [k, v] of Object.entries(map)) {
    const o = Number(k);
    io[o] = v & 0xff;
    io[o + 1] = (v >> 8) & 0xff;
  }
  return io;
}

test("decodeGbaRenderingContext: mode 0 + BG0 enabled + OBJ on", () => {
  const io = ioRegs({
    0x00: 0x0000 | (0 /*mode*/) | 0x100 /*BG0*/ | 0x1000 /*OBJ*/,
    0x06: 96, // VCOUNT
    0x08: 0x0002 | (1 << 8) | 0x80, // BG0CNT: priority2, mapBase=1, 256-color
  });
  const ctx = decodeGbaRenderingContext(io);
  assert.equal(ctx.bgMode, 0);
  assert.deepEqual(ctx.displayBg, [true, false, false, false]);
  assert.equal(ctx.displayObj, true);
  assert.equal(ctx.forcedBlank, false);
  assert.equal(ctx.vcount, 96);
  assert.equal(ctx.dispcnt, "0x1100");
  const bg0 = ctx.bgLayers[0];
  assert.equal(bg0.enabled, true);
  assert.equal(bg0.priority, 2);
  assert.equal(bg0.mapBase, 1);
  assert.equal(bg0.colorMode, "256/1");
});

test("decodeGbaRenderingContext: forced blank + mode 4 detected", () => {
  const io = ioRegs({ 0x00: 0x4 /*mode4*/ | 0x80 /*forced blank*/ });
  const ctx = decodeGbaRenderingContext(io);
  assert.equal(ctx.bgMode, 4);
  assert.equal(ctx.forcedBlank, true);
  assert.deepEqual(ctx.displayBg, [false, false, false, false]);
});
