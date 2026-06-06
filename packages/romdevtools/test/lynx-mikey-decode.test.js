// Unit tests for the Atari Lynx (Mikey chip) register decoders. We synthesize
// the raw 512-byte `lynx_hw_regs` window ($FC00-$FDFF) with known values and
// assert the decoded audio (freqHz/note/volume/shift register), palette (4-bit
// -> 8-bit RGB), and display-controller (DISPCTL flags) state.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeLynxMikey,
  decodeLynxPalette,
  decodeLynxRenderingContext,
} from "../src/host/lynx-mikey-state.js";

/** Build a 512-byte lynx_hw_regs window from a sparse {offset:value} map. */
function hwRegs(map) {
  const r = new Uint8Array(512);
  for (const [k, v] of Object.entries(map)) r[Number(k)] = v & 0xff;
  return r;
}

// Audio channel base offsets: ch0=0x120, ch1=0x128, ch2=0x130, ch3=0x138.
const CH = [0x120, 0x128, 0x130, 0x138];

test("Lynx audio ch0: BACKUP 141 + clockSelect 3 (8us) -> ~A4, enabled", () => {
  // freqHz = 1e6 / ((141+1) * 8 * 2) = 440.14 Hz = A4.
  const hw = hwRegs({
    [CH[0] + 0]: 0xf0, // VOLUME = -16 (signed)
    [CH[0] + 3]: 0x34, // SHIFT (low 8 bits of LFSR)
    [CH[0] + 4]: 141, // BACKUP
    [CH[0] + 5]: 0x03 | 0x10 | 0x20, // CONTROL: clockSelect 3, enable-count, integrate
    [CH[0] + 7]: 0x50, // OTHER: hi nibble of LFSR = 0x5
    0x150: 0x0f, // MSTEREO
    0x144: 0xa5, // MPAN
  });
  const a = decodeLynxMikey(hw);
  const c0 = a.channels[0];
  assert.equal(c0.note, "A4");
  assert.ok(Math.abs(c0.freqHz - 440.14) < 0.5);
  assert.equal(c0.enabled, true);
  assert.equal(c0.clockSelect, 3);
  assert.equal(c0.backup, 141);
  assert.equal(c0.integrate, true);
  assert.equal(c0.volume, -16); // signed decode of 0xF0
  assert.equal(c0.shiftRegister, 0x534); // SHIFT 0x34 | ((0x50 & 0xF0) << 4)
  assert.equal(a.stereo, "0x0f");
  assert.equal(a.pan, "0xa5");
});

test("Lynx audio: clockSelect 7 (link) -> freqHz/note null; disabled channel", () => {
  const hw = hwRegs({
    [CH[1] + 4]: 100, // BACKUP
    [CH[1] + 5]: 0x07, // CONTROL: clockSelect 7 (link), enable-count clear
  });
  const a = decodeLynxMikey(hw);
  const c1 = a.channels[1];
  assert.equal(c1.clockSelect, 7);
  assert.equal(c1.freqHz, null);
  assert.equal(c1.note, null);
  assert.equal(c1.enabled, false);
  // Untouched channels default to silence/zero.
  assert.equal(a.channels[2].backup, 0);
  assert.equal(a.channels[3].volume, 0);
});

test("Lynx audio: all four channels are 8 bytes apart and decode independently", () => {
  const hw = hwRegs({
    [CH[0] + 4]: 10,
    [CH[1] + 4]: 20,
    [CH[2] + 4]: 30,
    [CH[3] + 4]: 40,
    [CH[3] + 0]: 0x7f, // VOLUME +127 (max positive signed)
    [CH[3] + 5]: 0x10, // enable-count only
  });
  const a = decodeLynxMikey(hw);
  assert.deepEqual(
    a.channels.map((c) => c.backup),
    [10, 20, 30, 40],
  );
  assert.equal(a.channels[3].volume, 127);
  assert.equal(a.channels[3].enabled, true);
});

test("Lynx palette: 4-bit components expand to 8-bit RGB with hex string", () => {
  // entry 0: green nibble F, blue nibble F, red nibble F -> #ffffff (white)
  // entry 1: green 0, blue 0, red F                       -> #ff0000 (red)
  // entry 2: green F, blue 0, red 0                       -> #00ff00 (green)
  // entry 3: green 8, blue 8, red 8 (mid grey)            -> #888888
  const hw = hwRegs({
    0x1a0: 0x0f, // entry 0 green = F
    0x1b0: 0xff, // entry 0 blue=F red=F
    0x1a1: 0x00, // entry 1 green = 0
    0x1b1: 0x0f, // entry 1 blue=0 red=F
    0x1a2: 0x0f, // entry 2 green = F
    0x1b2: 0x00, // entry 2 blue=0 red=0
    0x1a3: 0x08, // entry 3 green = 8
    0x1b3: 0x88, // entry 3 blue=8 red=8
  });
  const p = decodeLynxPalette(hw);
  assert.equal(p.entries.length, 16);
  assert.deepEqual(p.entries[0], {
    index: 0, r: 255, g: 255, b: 255, hex: "#ffffff", green4: 15, red4: 15, blue4: 15,
  });
  assert.equal(p.entries[1].hex, "#ff0000");
  assert.equal(p.entries[2].hex, "#00ff00");
  // 0x8 expands to (8<<4)|8 = 0x88 = 136.
  assert.deepEqual(p.entries[3], {
    index: 3, r: 136, g: 136, b: 136, hex: "#888888", green4: 8, red4: 8, blue4: 8,
  });
});

test("Lynx rendering context: DISPCTL flags + 16-bit LE display address", () => {
  const hw = hwRegs({
    0x192: 0x01 | 0x02 | 0x08, // DISPCTL: DMA enable + flip + 4-colour
    0x194: 0x00, // DISPADR lo
    0x195: 0x20, // DISPADR hi -> $2000
  });
  const ctx = decodeLynxRenderingContext(hw);
  assert.equal(ctx.dispctl, "0x0b");
  assert.equal(ctx.displayDmaEnable, true);
  assert.equal(ctx.flip, true);
  assert.equal(ctx.fourColour, true);
  assert.equal(ctx.displayAddress, "0x2000");

  // All flags clear when DISPCTL is 0.
  const blank = decodeLynxRenderingContext(hwRegs({ 0x194: 0x34, 0x195: 0x12 }));
  assert.equal(blank.displayDmaEnable, false);
  assert.equal(blank.flip, false);
  assert.equal(blank.fourColour, false);
  assert.equal(blank.displayAddress, "0x1234");
});
